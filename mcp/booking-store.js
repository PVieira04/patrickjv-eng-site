// Booking store for F-001: the SQLite schema and the booking state machine, run inside the single
// BookingStore Durable Object. Google and email calls are injected (deps), so this file has no
// network code and is tested against node:sqlite with fakes.
//
// THE RACE RULE (spike S2): a Durable Object runs one request at a time only until it awaits
// something outside its own storage. So every decision about who gets a slot is made by reading
// and writing in ONE synchronous block, with no `await` between the read and the write, and only
// then does the code call Google or send email. Afterwards it settles or rolls back. `sql.exec` is
// synchronous, which is what makes this possible; keep it that way.

// Statements run one at a time: a Durable Object's exec accepts several, node:sqlite's prepare
// does not.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, start_utc TEXT NOT NULL, end_utc TEXT NOT NULL,
    status TEXT NOT NULL, status_reason TEXT, source TEXT NOT NULL,
    guest_name TEXT NOT NULL, guest_email TEXT NOT NULL, ip_key TEXT NOT NULL, email_key TEXT NOT NULL,
    note TEXT, event_id TEXT, hold_expires TEXT, created_at TEXT NOT NULL, delete_after TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tokens (
    hash TEXT PRIMARY KEY, booking_id TEXT NOT NULL, action TEXT NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT)`,
  "CREATE TABLE IF NOT EXISTS quota (day TEXT, kind TEXT, key TEXT, n INTEGER, PRIMARY KEY (day, kind, key))",
  // Counters the health check reads (email_failures: guest emails failed in a row).
  "CREATE TABLE IF NOT EXISTS health (key TEXT PRIMARY KEY, n INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS bookings_status ON bookings (status)",
  "CREATE INDEX IF NOT EXISTS tokens_booking ON tokens (booking_id)",
];

export function migrate(sql) {
  for (const s of SCHEMA) sql.exec(s);
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// 128 random bits as 32 lowercase hex: also valid as a Google event ID (base32hex a–v, 0–9).
export const newId = () => hex(crypto.getRandomValues(new Uint8Array(16)));

export async function hashToken(token) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

// A 128-bit link token (base64url, unpadded). Only its hash is ever stored.
export async function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { token, hash: await hashToken(token) };
}

// Daily caps, never refunded (fail closed), like request_intro's. Synchronous, so atomic inside
// the Durable Object. A request refused by a cap writes nothing, so refusals never eat into
// anyone's allowance. Per-IP and per-email counts are taken before any Google call
// (reserveBookingQuota); the global count only when a hold email is about to be sent
// (reserveGlobalQuota), so invalid or refused requests can't close booking for everyone.
const quotaCount = (sql, day, kind, key) => sql.exec("SELECT n FROM quota WHERE day = ? AND kind = ? AND key = ?", day, kind, key).toArray()[0]?.n ?? 0;
const quotaAdd = (sql, day, kind, key) => sql.exec("INSERT INTO quota (day, kind, key, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, kind, key) DO UPDATE SET n = n + 1", day, kind, key);

export function reserveBookingQuota(sql, { day, ipKey, emailKey, caps }) {
  // A closed day (global cap used up) is checked first, without counting.
  if (quotaCount(sql, day, "global", "") >= caps.globalPerDay) return { ok: false, which: "global" };
  if (quotaCount(sql, day, "ip", ipKey) >= caps.perIpPerDay) return { ok: false, which: "ip" };
  if (quotaCount(sql, day, "email", emailKey) >= caps.perEmailPerDay) return { ok: false, which: "email" };
  quotaAdd(sql, day, "ip", ipKey);
  quotaAdd(sql, day, "email", emailKey);
  return { ok: true };
}

// The request that uses up the global cap says so, once a day, so Patrick can be alerted.
export function reserveGlobalQuota(sql, { day, caps }) {
  const g = quotaCount(sql, day, "global", "");
  if (g >= caps.globalPerDay) return { ok: false, which: "global" };
  quotaAdd(sql, day, "global", "");
  return g + 1 === caps.globalPerDay ? { ok: true, globalJustExhausted: true } : { ok: true };
}

// Redacted failure log, as handler.js's logFailure: an event name and the subsystem only.
const logFailure = (subsystem) => console.error(JSON.stringify({ event: "booking_failure", subsystem }));

// Every guest email goes through here, so health can see email failing: failures in a row are
// counted, and one success resets the count. Throws as deps.sendEmail does.
async function sendGuestEmail(sql, deps, ...args) {
  try {
    await deps.sendEmail(...args);
  } catch (e) {
    sql.exec("INSERT INTO health (key, n) VALUES ('email_failures', 1) ON CONFLICT (key) DO UPDATE SET n = n + 1");
    throw e;
  }
  sql.exec("DELETE FROM health WHERE key = 'email_failures'");
}

// Guest emails failed in a row (0 after any success).
export const emailFailures = (sql) => sql.exec("SELECT n FROM health WHERE key = 'email_failures'").toArray()[0]?.n ?? 0;

const MINUTE = 60e3, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

// Bookings that occupy their slot: everything in progress or confirmed, and holds not yet lapsed
// (by the clock, whether or not the alarm has marked them expired yet).
export function liveBookings(sql, now) {
  return sql.exec(
    `SELECT id, start_utc AS start, end_utc AS "end", status FROM bookings
     WHERE status IN ('confirming', 'confirmed', 'cancelling')
        OR (status = 'pending_confirmation' AND hold_expires > ?)`,
    now.toISOString(),
  ).toArray();
}

// What the email templates need; the only place guest details leave the store.
const forEmail = (b) => ({
  id: b.id, type: b.type, start: b.start_utc, end: b.end_utc, name: b.guest_name, email: b.guest_email,
  note: b.note, source: b.source, holdExpires: b.hold_expires,
});

// Slot-check reasons that mean "someone or something else has it" rather than "not a valid slot".
const TAKEN = new Set(["busy", "taken", "day_full"]);
const slotError = (reason) => ({ error: TAKEN.has(reason) ? "slot_taken" : "invalid_slot", reason });

// Moves a booking to a final state and kills every link still outstanding for it.
function settle(sql, id, status, reason, nowIso) {
  sql.exec("UPDATE bookings SET status = ?, status_reason = ? WHERE id = ?", status, reason, id);
  sql.exec("UPDATE tokens SET used_at = ? WHERE booking_id = ? AND used_at IS NULL", nowIso, id);
}

// One live hold at a time per email, so a guest's inbox can't be flooded with holds. Not per IP:
// people share connections, and the per-IP daily cap already limits one source.
function holdPending(sql, { now, emailKey, cfg }) {
  return sql.exec(
    "SELECT count(*) AS c FROM bookings WHERE status = 'pending_confirmation' AND hold_expires > ? AND email_key = ?",
    now.toISOString(), emailKey,
  ).one().c >= (cfg.caps.liveHoldsPerEmail ?? 1);
}

export async function requestBooking(sql, { cfg, now, input, ipKey, emailKey, deps }) {
  const nowIso = now.toISOString();
  const day = deps.day(nowIso);
  // Refusals that cost nothing come first, and write no quota.
  if (holdPending(sql, { now, emailKey, cfg })) return { error: "hold_pending" };
  const type = cfg.meetingTypes.find((t) => t.id === input.type);
  const slot = { cfg, typeId: input.type, start: input.start, now };
  // Cheap pre-check, so an invalid or already-taken slot never reaches Google.
  const pre = deps.checkSlot({ ...slot, busy: [], bookings: liveBookings(sql, now) });
  if (!pre.ok) return slotError(pre.reason);
  const quota = reserveBookingQuota(sql, { day, ipKey, emailKey, caps: cfg.caps });
  if (!quota.ok) return { error: "rate_limited", reason: quota.which };

  const end = plus(input.start, type.minutes * MINUTE);
  const buffer = cfg.bufferMinutes * MINUTE;
  let busy;
  try {
    ({ busy } = await deps.freeBusy(plus(input.start, -buffer), plus(end, buffer)));
  } catch {
    logFailure("google_freebusy");
    return { error: "unavailable" };
  }
  const [confirm, decline] = await Promise.all([newToken(), newToken()]);
  const id = newId();
  const holdExpires = new Date(now.getTime() + cfg.holdHours * HOUR).toISOString();

  // ---- Claim: synchronous from here to the inserts. No await. ----
  // Both rules again: other requests ran while free/busy was awaited.
  if (holdPending(sql, { now, emailKey, cfg })) return { error: "hold_pending" };
  const check = deps.checkSlot({ ...slot, busy, bookings: liveBookings(sql, now) });
  if (!check.ok) return slotError(check.reason);
  // Counted here, just before the hold email, and never refunded even if the email fails.
  const global = reserveGlobalQuota(sql, { day, caps: cfg.caps });
  if (!global.ok) return { error: "rate_limited", reason: "global" };
  const flag = global.globalJustExhausted ? { globalJustExhausted: true } : {};
  sql.exec(
    `INSERT INTO bookings (id, type, start_utc, end_utc, status, source, guest_name, guest_email, ip_key, email_key, note, hold_expires, created_at, delete_after)
     VALUES (?, ?, ?, ?, 'pending_confirmation', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, input.type, input.start, end, input.source, input.name, input.email, ipKey, emailKey, input.note ?? null,
    holdExpires, nowIso, plus(holdExpires, cfg.retentionDays * DAY),
  );
  for (const [t, action] of [[confirm, "confirm"], [decline, "decline"]]) {
    sql.exec("INSERT INTO tokens (hash, booking_id, action, expires_at) VALUES (?, ?, ?, ?)", t.hash, id, action, holdExpires);
  }
  // ---- End of claim. ----

  const booking = sql.exec("SELECT * FROM bookings WHERE id = ?", id).one();
  try {
    await sendGuestEmail(sql, deps, "hold", forEmail(booking), { confirmUrl: deps.actUrl(confirm.token), declineUrl: deps.actUrl(decline.token) });
  } catch {
    // Nobody can confirm a hold they never heard about: release it now rather than in 2 hours.
    logFailure("email");
    settle(sql, id, "cancelled", "email_failed", nowIso);
    return { error: "email_failed", ...flag };
  }
  return { booking_id: id, status: "pending_confirmation", hold_expires: holdExpires, ...flag };
}

// Meetings that exist or are being made: what a confirm must not collide with. Pending holds are
// left out, so a hold can never stop a guest who confirms (two live holds can't overlap anyway).
const meetings = (sql) => sql.exec(
  `SELECT id, start_utc AS start, end_utc AS "end", status FROM bookings WHERE status IN ('confirming', 'confirmed', 'cancelling')`,
).toArray();

// A link token's row and its booking, or why it can't be used. Synchronous.
function lookupToken(sql, hash, now) {
  const tok = sql.exec("SELECT * FROM tokens WHERE hash = ?", hash).toArray()[0];
  const booking = tok && sql.exec("SELECT * FROM bookings WHERE id = ?", tok.booking_id).toArray()[0];
  if (!booking) return { error: "unknown" };
  // A spent confirm link whose booking is still confirming: Google's answer was lost and the
  // alarm is finishing it, which the page says rather than "already used".
  if (tok.used_at) return booking.status === "confirming" ? { error: "used", confirming: true } : { error: "used" };
  if (tok.expires_at <= now.toISOString()) return { error: "expired" };
  return { tok, booking };
}

// Performs what an emailed link does (on POST; a GET only peeks).
export async function act(sql, { token, now, cfg, deps }) {
  if (typeof token !== "string" || token === "") return { error: "unknown" };
  const hash = await hashToken(token);
  const found = lookupToken(sql, hash, now);
  if (found.error) return found;
  const { tok, booking: b } = found;
  if (tok.action === "confirm") return confirmHold(sql, found, { now, cfg, deps });
  if (tok.action === "decline") {
    if (b.status !== "pending_confirmation" || b.hold_expires <= now.toISOString()) return { error: "used" };
    settle(sql, b.id, "declined", "guest_declined", now.toISOString());
    return { result: "declined" };
  }
  if (tok.action === "cancel" || tok.action === "confirm_cancel") return cancelMeeting(sql, found, { now, deps });
  return { error: "unknown" };
}

async function cancelMeeting(sql, { tok, booking: b }, { now, deps }) {
  const nowIso = now.toISOString();
  if (b.status !== "confirmed") return { error: "used" };
  // ---- Claim: synchronous, no await. ----
  sql.exec("UPDATE bookings SET status = 'cancelling' WHERE id = ?", b.id);
  sql.exec("UPDATE tokens SET used_at = ? WHERE hash = ?", nowIso, tok.hash);
  // ---- End of claim. ----
  try {
    // Google emails the attendees; an event already gone (404/410) is fine.
    await deps.deleteEvent(b.event_id ?? b.id);
  } catch {
    logFailure("google_delete");
    sql.exec("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'cancelling'", b.id);
    sql.exec("UPDATE tokens SET used_at = NULL WHERE hash = ?", tok.hash);
    return { error: "unavailable" };
  }
  settle(sql, b.id, "cancelled", "guest_cancelled", nowIso);
  return { result: "cancelled" };
}

// cancel_booking. Withdrawing a hold needs no consent (nothing exists yet); cancelling a meeting
// does, so the guest is emailed a link and only that link cancels it.
export async function cancelByAgent(sql, { bookingId, now, deps }) {
  const nowIso = now.toISOString();
  const link = await newToken();
  const b = typeof bookingId === "string" && sql.exec("SELECT * FROM bookings WHERE id = ?", bookingId).toArray()[0];
  if (!b) return { error: "not_found" };
  // Decided on the internal state: a hold being confirmed must not be withdrawn under the confirm.
  const status = internalStatus(sql, b.id, now).status;
  if (status === "pending_confirmation") {
    settle(sql, b.id, "cancelled", "agent_withdrew", nowIso);
    return { status: "cancelled" };
  }
  if (status !== "confirmed" || b.start_utc <= nowIso) return { error: "not_cancellable", status: callerStatus(status) };
  const requested = { status: "confirmed", cancellation: "requested" };
  // One outstanding request at a time, so a booking ID can't be used to flood the guest's inbox.
  const outstanding = sql.exec(
    "SELECT count(*) AS c FROM tokens WHERE booking_id = ? AND action = 'confirm_cancel' AND used_at IS NULL AND expires_at > ?", b.id, nowIso,
  ).one().c;
  if (outstanding) return requested;
  sql.exec("INSERT INTO tokens (hash, booking_id, action, expires_at) VALUES (?, ?, 'confirm_cancel', ?)", link.hash, b.id, b.start_utc);
  try {
    await sendGuestEmail(sql, deps, "cancel_request", forEmail(b), { confirmCancelUrl: deps.actUrl(link.token) });
  } catch {
    logFailure("email");
    sql.exec("UPDATE tokens SET used_at = ? WHERE hash = ?", nowIso, link.hash);
    return { error: "email_failed" };
  }
  return requested;
}

// What a link would do, for the GET page (which must never change state). Async only because
// hashing is. No guest details.
export async function peekToken(sql, token, now) {
  if (typeof token !== "string" || token === "") return { state: "unknown" };
  const hash = await hashToken(token);
  const tok = sql.exec("SELECT * FROM tokens WHERE hash = ?", hash).toArray()[0];
  const b = tok && sql.exec("SELECT type, start_utc, end_utc, status FROM bookings WHERE id = ?", tok.booking_id).toArray()[0];
  if (!b) return { state: "unknown" };
  const state = tok.used_at ? "used" : tok.expires_at <= now.toISOString() ? "expired" : "valid";
  return { state, action: tok.action, booking: { type: b.type, start: b.start_utc, end: b.end_utc, status: b.status } };
}

// What a confirm checks the slot against: the rules without notice (it was given when held), and
// live free/busy around the meeting with its buffer.
const confirmSlot = (b, cfg, now) => ({ cfg, typeId: b.type, start: b.start_utc, now, ignoreNotice: true, excludeId: b.id });
const slotFreeBusy = (b, cfg, deps) => {
  const buffer = cfg.bufferMinutes * MINUTE;
  return deps.freeBusy(plus(b.start_utc, -buffer), plus(b.end_utc, buffer));
};
function declineConfirm(sql, id, reason, nowIso) {
  const why = reason === "day_full" ? "day_full" : "slot_taken";
  settle(sql, id, "declined", why, nowIso);
  return { result: "declined", reason: why };
}

async function confirmHold(sql, { tok, booking: b }, { now, cfg, deps }) {
  const nowIso = now.toISOString();
  // A hold that already left pending has spent its links; this is a backstop.
  if (b.status !== "pending_confirmation" || b.hold_expires <= nowIso) return { error: "used" };
  const slot = confirmSlot(b, cfg, now);
  const decline = (reason) => declineConfirm(sql, b.id, reason, nowIso);

  // ---- Claim: synchronous, no await. A double click finds the token used. ----
  const claim = deps.checkSlot({ ...slot, busy: [], bookings: meetings(sql) });
  if (!claim.ok) return decline(claim.reason);
  sql.exec("UPDATE bookings SET status = 'confirming' WHERE id = ?", b.id);
  sql.exec("UPDATE tokens SET used_at = ? WHERE hash = ?", nowIso, tok.hash);
  // ---- End of claim. ----

  // Google failed: back to a hold whose link still works, so the guest can try again.
  const rollback = (subsystem) => {
    logFailure(subsystem);
    sql.exec("UPDATE bookings SET status = 'pending_confirmation' WHERE id = ? AND status = 'confirming'", b.id);
    sql.exec("UPDATE tokens SET used_at = NULL WHERE hash = ?", tok.hash);
    return { error: "unavailable" };
  };
  let busy;
  try {
    ({ busy } = await slotFreeBusy(b, cfg, deps));
  } catch {
    return rollback("google_freebusy");
  }
  const check = deps.checkSlot({ ...slot, busy, bookings: meetings(sql) });
  if (!check.ok) return decline(check.reason);

  let event;
  try {
    // 409 (already created by an earlier attempt) comes back as created:false: still a success.
    event = await deps.insertEvent(buildEvent(b, cfg, deps.ownerEmail));
  } catch (e) {
    // Google refused (a 4xx, the token refresh included): nothing was made.
    if (e?.status >= 400 && e.status < 500) return rollback("google_insert");
    // A timeout, network error or 5xx may have come after Google made the event. Rolling back
    // could orphan a meeting, so the row stays confirming, its slot held and its link spent, and
    // the alarm's recovery settles it once it can see whether the event exists.
    logFailure("google_insert_unknown");
    return { result: "confirming" };
  }
  return settleConfirmed(sql, b, { now, cfg, deps, meetLink: event?.meetLink ?? null });
}

// Google shows an event description as HTML (the summary is plain text).
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The Google event for a booking, the same for a live confirm and the alarm's recovery. Attendees
// are plain addresses: the guest's and Patrick's.
export function buildEvent(b, cfg, ownerEmail) {
  const title = cfg.meetingTypes.find((t) => t.id === b.type)?.title ?? b.type;
  return {
    id: b.id, summary: `${title}: ${b.guest_name}`,
    description: [`${escapeHtml(title)}, booked on patrickjv.com.`, b.note ? `\nNote from the guest:\n${escapeHtml(b.note)}` : ""].join(""),
    start: b.start_utc, end: b.end_utc, timeZone: cfg.timezone, attendees: [b.guest_email, ownerEmail].filter(Boolean),
  };
}

// A confirm that ended some other way meanwhile: what the caller is told.
function outcome(sql, id) {
  const r = sql.exec("SELECT status, status_reason FROM bookings WHERE id = ?", id).toArray()[0];
  if (r?.status === "confirmed") return { result: "confirmed" };
  if (r?.status === "declined") return { result: "declined", reason: r.status_reason };
  return { error: "used" };
}

// The event exists: the booking is confirmed, its links are spent, and the guest gets a cancel
// link. The live confirm and the alarm's recovery both end here, and the write only happens while
// the row is still confirming, so whichever finishes first settles it and sends "Booked"; the
// other does nothing.
async function settleConfirmed(sql, b, { now, cfg, deps, meetLink }) {
  const nowIso = now.toISOString();
  const cancel = await newToken();
  // ---- Synchronous from here to the inserts. No await. ----
  const won = sql.exec(
    "UPDATE bookings SET status = 'confirmed', status_reason = NULL, event_id = ?, hold_expires = NULL, delete_after = ? WHERE id = ? AND status = 'confirming' RETURNING id",
    b.id, plus(b.end_utc, cfg.retentionDays * DAY), b.id,
  ).toArray().length;
  if (!won) return outcome(sql, b.id);
  sql.exec("UPDATE tokens SET used_at = ? WHERE booking_id = ? AND used_at IS NULL", nowIso, b.id);
  sql.exec("INSERT INTO tokens (hash, booking_id, action, expires_at) VALUES (?, ?, 'cancel', ?)", cancel.hash, b.id, b.start_utc);
  // ---- End of the write. ----
  try {
    await sendGuestEmail(sql, deps, "booked", forEmail(b), { cancelUrl: deps.actUrl(cancel.token), meetLink });
  } catch {
    logFailure("email"); // Google's invite still reaches the guest.
  }
  return { result: "confirmed" };
}

// Alarm work: finishes a confirm that was cut off, or whose insert had no clear answer (row left
// in confirming). First asks Google whether the event exists: if it does, the booking is
// confirmed. Throws if Google fails, leaving the row for the next alarm.
export async function recoverConfirm(sql, b, { now, cfg, deps }) {
  const existing = await deps.getEvent(b.id);
  if (existing) return settleConfirmed(sql, b, { now, cfg, deps, meetLink: existing.meetLink ?? null });
  // Nothing was made, and time has passed: check the slot again, as a live confirm does.
  const { busy } = await slotFreeBusy(b, cfg, deps);
  if (sql.exec("SELECT status FROM bookings WHERE id = ?", b.id).one().status !== "confirming") return outcome(sql, b.id);
  const check = deps.checkSlot({ ...confirmSlot(b, cfg, now), busy, bookings: meetings(sql) });
  if (!check.ok) {
    // The clash may be this booking's own meeting: a slow live insert can land between the first
    // look and free/busy. Ask once more before declining.
    const late = await deps.getEvent(b.id);
    if (late) return settleConfirmed(sql, b, { now, cfg, deps, meetLink: late.meetLink ?? null });
    if (sql.exec("SELECT status FROM bookings WHERE id = ?", b.id).one().status !== "confirming") return outcome(sql, b.id);
    // The guest may have been told their booking was being finished. Nothing new is sent to them:
    // no meeting, no "Booked" email, and get_booking_status shows declined.
    return declineConfirm(sql, b.id, check.reason, now.toISOString());
  }
  const event = await deps.insertEvent(buildEvent(b, cfg, deps.ownerEmail)); // 409 = made meanwhile
  return settleConfirmed(sql, b, { now, cfg, deps, meetLink: event?.meetLink ?? null });
}

// A booking's state for whoever holds its ID (a bearer secret): never the guest's details. With
// `now`, a hold that has lapsed but not yet been swept by the alarm reads as expired.
// The in-between states are the store's own: callers see the state they know.
export function getStatus(sql, bookingId, now) {
  const view = internalStatus(sql, bookingId, now);
  return view && { ...view, status: callerStatus(view.status) };
}

// confirming is still a hold to the guest until it settles; cancelling is still a meeting.
const CALLER_STATUS = { confirming: "pending_confirmation", cancelling: "confirmed" };
const callerStatus = (status) => CALLER_STATUS[status] ?? status;

function internalStatus(sql, bookingId, now) {
  const b = sql.exec(
    `SELECT status, status_reason, start_utc AS start, end_utc AS "end", type, hold_expires FROM bookings WHERE id = ?`, bookingId,
  ).toArray()[0];
  if (!b) return null;
  const { hold_expires: exp, ...view } = b;
  if (now && view.status === "pending_confirmation" && exp <= now.toISOString()) return { ...view, status: "expired", status_reason: "hold_expired" };
  return view;
}

// Alarm work: holds past their 2 hours become expired. Returns how many.
export function expireHolds(sql, now) {
  const nowIso = now.toISOString();
  return sql.exec(
    "UPDATE bookings SET status = 'expired', status_reason = 'hold_expired' WHERE status = 'pending_confirmation' AND hold_expires <= ? RETURNING id",
    nowIso,
  ).toArray().length;
}

// Alarm work: delete records past their retention (with their links), and quota counters more
// than two days old.
export function prune(sql, now) {
  const nowIso = now.toISOString();
  sql.exec("DELETE FROM tokens WHERE booking_id IN (SELECT id FROM bookings WHERE delete_after <= ?)", nowIso);
  sql.exec("DELETE FROM bookings WHERE delete_after <= ?", nowIso);
  sql.exec("DELETE FROM quota WHERE day < ?", new Date(now.getTime() - 2 * DAY).toISOString().slice(0, 10));
}

// When the alarm should next run (ms): the earliest hold expiry, or the next UTC midnight for the
// daily prune, whichever is sooner. An overdue hold means now.
export function nextAlarmAt(sql, now) {
  const midnight = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`) + DAY;
  const next = sql.exec("SELECT min(hold_expires) AS t FROM bookings WHERE status = 'pending_confirmation'").one().t;
  if (!next) return midnight;
  return Math.max(now.getTime(), Math.min(Date.parse(next), midnight));
}
