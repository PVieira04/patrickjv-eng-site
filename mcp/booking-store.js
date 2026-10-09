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
  // F-002's sign-in path. A booking request reserves nothing; its booking row is made only when
  // a verified person signs in (confirmRequest), reusing the request's id.
  `CREATE TABLE IF NOT EXISTS booking_requests (
    id TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL UNIQUE, type TEXT NOT NULL, start_utc TEXT NOT NULL, end_utc TEXT NOT NULL,
    note TEXT, source TEXT NOT NULL, ip_key TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    state TEXT NOT NULL, reason TEXT, settled_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS identities (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL,
    email TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL, delete_after TEXT NOT NULL,
    UNIQUE (provider, subject))`,
  `CREATE TABLE IF NOT EXISTS signin_tx (
    state_hash TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL, cookie_hash TEXT NOT NULL,
    nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, purpose TEXT NOT NULL, expires_at TEXT NOT NULL)`,
];
// Columns F-002 adds to F-001's bookings table: nullable, so F-001 rows keep NULL (an email-form
// booking). ALTER TABLE has no IF NOT EXISTS, so each is added only if missing.
const BOOKING_COLUMNS = ["identity_id", "proof", "actor"];

export function migrate(sql) {
  for (const s of SCHEMA) sql.exec(s);
  const have = new Set(sql.exec("PRAGMA table_info(bookings)").toArray().map((c) => c.name));
  for (const c of BOOKING_COLUMNS) if (!have.has(c)) sql.exec(`ALTER TABLE bookings ADD COLUMN ${c} TEXT`);
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
  // A sign-in booking (F-002) ends only through the core: the "Booked" email's link is its proof.
  if (tok.action === "cancel" && b.proof) {
    return cancelMeeting(sql, b.id, null, { proof: "booked_email_link", actor: null, scope: "cancel", ticket_hash: tok.hash, expires_at: tok.expires_at }, { now, deps });
  }
  if (tok.action === "cancel" || tok.action === "confirm_cancel") return cancelByLink(sql, found, { now, deps });
  return { error: "unknown" };
}

// F-001's cancellation: claim cancelling and spend the link, delete the event, then cancelled; a
// failed deletion puts the booking back to confirmed and the link works again until it expires.
async function cancelByLink(sql, { tok, booking: b }, { now, deps }) {
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
// F-002: a sign-in booking (proof set) gets a sign-in cancel link instead (signinCancelLink).
export async function cancelByAgent(sql, { bookingId, now, cfg, ipKey, deps }) {
  const nowIso = now.toISOString();
  const link = await newToken();
  const b = typeof bookingId === "string" && sql.exec("SELECT * FROM bookings WHERE id = ?", bookingId).toArray()[0];
  if (!b) return withdrawRequest(sql, bookingId, now);
  // Decided on the internal state: a hold being confirmed must not be withdrawn under the confirm.
  const status = internalStatus(sql, b.id, now).status;
  if (status === "pending_confirmation") {
    settle(sql, b.id, "cancelled", "agent_withdrew", nowIso);
    return { status: "cancelled" };
  }
  if (status !== "confirmed" || b.start_utc <= nowIso) return { error: "not_cancellable", status: callerStatus(status) };
  if (b.proof) return signinCancelLink(sql, b, link, { now, cfg, ipKey, deps });
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
  // F-002: a sign-in booking (proof set) settles as its live path does, rather than being retried
  // forever: a meeting whose start has passed with no event, or an insert Google refuses, ends
  // declined (unavailable). F-001's email bookings keep their rules.
  if (b.proof && b.start_utc <= now.toISOString()) return declineUnavailable(sql, b.id, now.toISOString());
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
  let event;
  try {
    event = await deps.insertEvent(buildEvent(b, cfg, deps.ownerEmail)); // 409 = made meanwhile
  } catch (e) {
    if (b.proof && e?.status >= 400 && e.status < 500) return declineUnavailable(sql, b.id, now.toISOString());
    throw e;
  }
  return settleConfirmed(sql, b, { now, cfg, deps, meetLink: event?.meetLink ?? null });
}

// A booking's state for whoever holds its ID (a bearer secret): never the guest's details. With
// `now`, a hold that has lapsed but not yet been swept by the alarm reads as expired.
// The in-between states are the store's own: callers see the state they know.
export function getStatus(sql, bookingId, now) {
  const view = internalStatus(sql, bookingId, now);
  if (view) return { ...view, status: callerStatus(view.status) };
  return requestStatus(sql, bookingId, now);
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
  // F-002: sign-in transactions past their 10 minutes; booking requests 30 days after they were
  // used, withdrawn or declined, or after an unused one expired (a used request's booking carries
  // on under the retention above); identities once their delete_after has passed.
  const cutoff = new Date(now.getTime() - REQUEST_RETENTION_DAYS * DAY).toISOString();
  sql.exec("DELETE FROM signin_tx WHERE expires_at <= ?", nowIso);
  sql.exec("DELETE FROM booking_requests WHERE (state = 'open' AND expires_at <= ?) OR (state != 'open' AND settled_at <= ?)", cutoff, cutoff);
  sql.exec("DELETE FROM identities WHERE delete_after <= ?", nowIso);
}
// As the privacy notice says (and as retentionDays is for bookings).
const REQUEST_RETENTION_DAYS = 30;

// When the alarm should next run (ms): the earliest hold expiry, or the next UTC midnight for the
// daily prune, whichever is sooner. An overdue hold means now.
export function nextAlarmAt(sql, now) {
  const midnight = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`) + DAY;
  const next = sql.exec("SELECT min(hold_expires) AS t FROM bookings WHERE status = 'pending_confirmation'").one().t;
  if (!next) return midnight;
  return Math.max(now.getTime(), Math.min(Date.parse(next), midnight));
}

// ---------------------------------------------------------------------------------------------
// F-002: booking requests. A request reserves nothing and sends nothing: it records which slot a
// person may book by signing in on its link (the ticket) before it expires. The slot is claimed
// only at sign-in, by confirmRequest, under the same race rule as F-001's confirm.
// ---------------------------------------------------------------------------------------------

// Request counters (D7), taken when a request is stored and never refunded. Global first, as F-001
// checks a closed day first; a refusal writes nothing.
export function reserveRequestQuota(sql, { day, ipKey, caps }) {
  if (quotaCount(sql, day, "request_global", "") >= caps.requestsPerDay) return { ok: false, which: "global" };
  if (quotaCount(sql, day, "request_ip", ipKey) >= caps.requestsPerIpPerDay) return { ok: false, which: "ip" };
  quotaAdd(sql, day, "request_global", "");
  quotaAdd(sql, day, "request_ip", ipKey);
  return { ok: true };
}

// book_meeting (MCP, WebMCP) and /book's sign-in button. `busy` is the shared free/busy cache's
// answer (the one get_availability uses), so however many requests arrive, Google is asked at most
// once a minute. Order, as F-001's: the slot against local bookings, live holds, the day count and
// that cache; then the counters; then the row. So a refused request takes no allowance.
export async function createRequest(sql, { cfg, now, input, ipKey, busy, deps }) {
  const ticket = await newToken();
  const nowIso = now.toISOString();
  // ---- Synchronous from here to the insert. No await. ----
  const check = deps.checkSlot({ cfg, typeId: input.type, start: input.start, now, busy, bookings: liveBookings(sql, now) });
  if (!check.ok) return slotError(check.reason);
  const quota = reserveRequestQuota(sql, { day: deps.day(nowIso), ipKey, caps: cfg.caps });
  if (!quota.ok) return { error: "rate_limited", reason: quota.which };
  const type = cfg.meetingTypes.find((t) => t.id === input.type);
  const id = newId();
  const expires = plus(nowIso, cfg.requestMinutes * MINUTE);
  sql.exec(
    `INSERT INTO booking_requests (id, ticket_hash, type, start_utc, end_utc, note, source, ip_key, created_at, expires_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    id, ticket.hash, input.type, input.start, plus(input.start, type.minutes * MINUTE), input.note ?? null, input.source, ipKey, nowIso, expires,
  );
  // ---- End of the write. ----
  return { booking_id: id, status: "pending_confirmation", confirm_url: deps.confirmUrl(ticket.token), link_expires: expires };
}

const getRequest = (sql, id) => (typeof id === "string" && sql.exec("SELECT * FROM booking_requests WHERE id = ?", id).toArray()[0]) || null;
// An open request past its link's expiry reads as expired; expiry isn't stored, it's the clock.
const requestState = (r, now) => (r.state === "open" && r.expires_at <= now.toISOString() ? "expired" : r.state);

function settleRequestRow(sql, id, state, reason, nowIso) {
  sql.exec("UPDATE booking_requests SET state = ?, reason = ?, settled_at = ? WHERE id = ? AND state = 'open'", state, reason, nowIso, id);
}

// The first time the site finds an open request's slot no longer free (another booking or live
// F-001 hold overlaps it, `busy` shows it busy, or the day is full), the request is settled
// declined for good, so the link, the status and the guide agree and the old link can't book later.
// Notice isn't re-applied (D3). Synchronous; returns the request's state afterwards (null if none).
export function settleRequest(sql, id, { cfg, now, busy, deps }) {
  const r = getRequest(sql, id);
  if (!r) return null;
  const state = requestState(r, now);
  if (state !== "open") return state;
  const check = deps.checkSlot({ cfg, typeId: r.type, start: r.start_utc, now, busy, bookings: liveBookings(sql, now), ignoreNotice: true });
  if (check.ok || !TAKEN.has(check.reason)) return "open";
  settleRequestRow(sql, id, "declined", check.reason === "day_full" ? "day_full" : "slot_taken", now.toISOString());
  return "declined";
}

// A request's public status (Status for callers). A used request has its booking row, which
// getStatus reads first.
const REQUEST_STATUS = {
  open: ["pending_confirmation", null], expired: ["expired", "request_expired"], cancelled: ["cancelled", "agent_withdrew"],
};
function requestStatus(sql, id, now) {
  const r = getRequest(sql, id);
  if (!r || r.state === "used") return null;
  const state = now ? requestState(r, now) : r.state;
  const [status, reason] = state === "declined" ? ["declined", r.reason] : REQUEST_STATUS[state];
  return { status, status_reason: reason, start: r.start_utc, end: r.end_utc, type: r.type };
}

// cancel_booking on an ID that isn't a booking: an open request is withdrawn at once (its link
// stops working); any other request isn't cancellable.
function withdrawRequest(sql, id, now) {
  const view = requestStatus(sql, id, now);
  if (!view) return { error: "not_found" };
  if (view.status !== "pending_confirmation") return { error: "not_cancellable", status: view.status };
  settleRequestRow(sql, id, "cancelled", null, now.toISOString());
  return { status: "cancelled" };
}

// ---------------------------------------------------------------------------------------------
// F-002: the booking core (D6). confirmRequest is the only way a booking request becomes a
// meeting, and cancelMeeting the only way a sign-in booking ends. `person` is the guest
// ({provider, subject, email, display_name}; the name is asserted, not verified); `grant` is the
// authority to act ({proof, actor, scope, ticket_hash, expires_at}). Each proof's only job is to
// produce those two. The grant is checked once, in the claim; after that the booking carries its
// own authority, so the alarm's recovery finishes it with no grant and takes no cap again.
// ---------------------------------------------------------------------------------------------

// Which proofs may do what. Later proofs (P2, P4) add their checks here.
const PROOFS = { book: ["signin:google"], cancel: ["signin:google", "booked_email_link"] };
const grantAllows = (grant, scope, ticketHash, now) => grant?.scope === scope && PROOFS[scope].includes(grant.proof)
  && grant.ticket_hash === ticketHash && typeof grant.expires_at === "string" && grant.expires_at > now.toISOString();

// The person's row, keyed on (provider, subject); email and name follow their latest sign-in. Kept
// until 30 days after the later of their last sign-in and the end of their last meeting.
function upsertIdentity(sql, person, nowIso, deleteAfter) {
  return sql.exec(
    `INSERT INTO identities (id, provider, subject, email, display_name, created_at, delete_after) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email, display_name = excluded.display_name, delete_after = max(delete_after, excluded.delete_after)
     RETURNING id`,
    newId(), person.provider, person.subject, person.email, person.display_name, nowIso, deleteAfter,
  ).one().id;
}

// The person caps (D7): confirmations a UTC day (counted at the claim, never refunded), and
// meetings still to come, counted from current bookings so they free up when one ends or is
// cancelled. Returns which is reached, or null.
function personCap(sql, identityId, { day, now, caps }) {
  if (quotaCount(sql, day, "person_day", identityId) >= caps.confirmationsPerPersonPerDay) return "daily";
  const upcoming = sql.exec(
    "SELECT count(*) AS c FROM bookings WHERE identity_id = ? AND status IN ('confirming', 'confirmed', 'cancelling') AND end_utc > ?",
    identityId, now.toISOString(),
  ).one().c;
  return upcoming >= caps.upcomingPerPerson ? "upcoming" : null;
}

export async function confirmRequest(sql, requestId, person, grant, { cfg, now, deps }) {
  const nowIso = now.toISOString();
  // F-001's email key, from the verified address: computed before the claim (it awaits).
  const emailKey = await deps.emailKey(person.email);

  // ---- Claim: synchronous from here to the inserts. No await. ----
  const r = getRequest(sql, requestId);
  if (!r) return { error: "unknown" };
  if (!grantAllows(grant, "book", r.ticket_hash, now)) return { error: "forbidden" };
  const state = requestState(r, now);
  // A start already passed is refused too: config forbids it, this is the backstop.
  if (state === "expired" || r.start_utc <= nowIso) return { error: "expired" };
  if (state !== "open") return { error: "used" };
  const retention = cfg.retentionDays * DAY;
  const identityId = upsertIdentity(sql, person, nowIso, plus(nowIso, retention));
  // Caps reached: nothing is booked and the request stays open (another account may use it).
  const cap = personCap(sql, identityId, { day: deps.day(nowIso), now, caps: cfg.caps });
  if (cap) return { error: "person_cap", which: cap };
  // Notice isn't re-applied (D3): it was checked when the request was made.
  const claim = deps.checkSlot({ cfg, typeId: r.type, start: r.start_utc, now, busy: [], bookings: liveBookings(sql, now), ignoreNotice: true });
  if (!claim.ok) {
    const why = claim.reason === "day_full" ? "day_full" : "slot_taken";
    settleRequestRow(sql, r.id, "declined", why, nowIso);
    return { result: "declined", reason: why };
  }
  quotaAdd(sql, deps.day(nowIso), "person_day", identityId);
  // Everything the alarm's recovery needs, in case this instance is evicted from here on.
  sql.exec(
    `INSERT INTO bookings (id, type, start_utc, end_utc, status, source, guest_name, guest_email, ip_key, email_key, note, created_at, delete_after, identity_id, proof, actor)
     VALUES (?, ?, ?, ?, 'confirming', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.id, r.type, r.start_utc, r.end_utc, r.source, person.display_name, person.email, r.ip_key, emailKey, r.note, nowIso,
    plus(r.end_utc, retention), identityId, grant.proof, grant.actor ?? null,
  );
  sql.exec("UPDATE identities SET delete_after = max(delete_after, ?) WHERE id = ?", plus(r.end_utc, retention), identityId);
  settleRequestRow(sql, r.id, "used", null, nowIso);
  // ---- End of claim. ----

  return finishSigninConfirm(sql, sql.exec("SELECT * FROM bookings WHERE id = ?", r.id).one(), { now, cfg, deps });
}

// A sign-in booking that Google can't make ends declined (unavailable), freeing its slot and the
// person's upcoming place. Only while it is still confirming.
function declineUnavailable(sql, id, nowIso) {
  if (sql.exec("SELECT status FROM bookings WHERE id = ?", id).one().status !== "confirming") return outcome(sql, id);
  settle(sql, id, "declined", "unavailable", nowIso);
  return { result: "declined", reason: "unavailable" };
}

// After the claim: nothing is rolled back or refunded. Recovery either completes the booking or
// settles it declined, so an unclear answer from Google leaves it confirming for the alarm.
async function finishSigninConfirm(sql, b, { now, cfg, deps }) {
  const nowIso = now.toISOString();
  let busy;
  try {
    ({ busy } = await slotFreeBusy(b, cfg, deps));
  } catch {
    logFailure("google_freebusy");
    return { result: "confirming" };
  }
  if (sql.exec("SELECT status FROM bookings WHERE id = ?", b.id).one().status !== "confirming") return outcome(sql, b.id);
  const check = deps.checkSlot({ ...confirmSlot(b, cfg, now), busy, bookings: meetings(sql) });
  if (!check.ok) return declineConfirm(sql, b.id, check.reason, nowIso);
  let event;
  try {
    event = await deps.insertEvent(buildEvent(b, cfg, deps.ownerEmail));
  } catch (e) {
    if (e?.status >= 400 && e.status < 500) { logFailure("google_insert"); return declineUnavailable(sql, b.id, nowIso); }
    logFailure("google_insert_unknown");
    return { result: "confirming" };
  }
  return settleConfirmed(sql, b, { now, cfg, deps, meetLink: event?.meetLink ?? null });
}

// cancel_booking on a confirmed sign-in booking, before its start: a single-use sign-in link
// lasting requestMinutes or until the start, whichever is sooner. It takes the request counters
// (D7) and revokes the booking's previous sign-in cancel link (not the "Booked" email's link), so
// a booking has at most one live sign-in cancel link. Synchronous after the token is made.
function signinCancelLink(sql, b, link, { now, cfg, ipKey, deps }) {
  const nowIso = now.toISOString();
  const quota = reserveRequestQuota(sql, { day: deps.day(nowIso), ipKey, caps: cfg.caps });
  if (!quota.ok) return { error: "rate_limited", reason: quota.which };
  const lapse = plus(nowIso, cfg.requestMinutes * MINUTE);
  const expires = lapse < b.start_utc ? lapse : b.start_utc;
  sql.exec("UPDATE tokens SET used_at = ? WHERE booking_id = ? AND action = 'cancel_signin' AND used_at IS NULL", nowIso, b.id);
  sql.exec("INSERT INTO tokens (hash, booking_id, action, expires_at) VALUES (?, ?, 'cancel_signin', ?)", link.hash, b.id, expires);
  return { status: "confirmed", confirm_url: deps.confirmUrl(link.token), link_expires: expires };
}

// The only way a sign-in booking is cancelled, on either proof: a sign-in by the guest
// (signin:google, on a cancel_signin ticket) or the "Booked" email's cancel link
// (booked_email_link, on that F-001 token: holding it proves the verified mailbox). Caps and
// availability never stop a cancellation. Once authorised it runs F-001's cancellation unchanged.
const CANCEL_TICKET = { "signin:google": "cancel_signin", booked_email_link: "cancel" };
export async function cancelMeeting(sql, bookingId, person, grant, { now, deps }) {
  const nowIso = now.toISOString();
  // ---- Synchronous from here to cancelByLink's claim. No await. ----
  const b = typeof bookingId === "string" && sql.exec("SELECT * FROM bookings WHERE id = ?", bookingId).toArray()[0];
  if (!b?.proof) return { error: "unknown" };
  const tok = typeof grant?.ticket_hash === "string" && sql.exec("SELECT * FROM tokens WHERE hash = ? AND booking_id = ?", grant.ticket_hash, b.id).toArray()[0];
  if (!tok || tok.action !== CANCEL_TICKET[grant.proof] || !grantAllows(grant, "cancel", tok.hash, now)) return { error: "forbidden" };
  if (tok.used_at || b.status !== "confirmed") return { error: "used" };
  if (tok.expires_at <= nowIso || b.start_utc <= nowIso) return { error: "expired" };
  if (grant.proof === "signin:google") {
    const guest = sql.exec("SELECT provider, subject FROM identities WHERE id = ?", b.identity_id).toArray()[0];
    if (!guest || guest.provider !== person?.provider || guest.subject !== person?.subject) return { error: "not_guest" };
  }
  return cancelByLink(sql, { tok, booking: b }, { now, deps });
}

// ---------------------------------------------------------------------------------------------
// F-002: sign-in transactions. A ticket (a request's, or a sign-in cancel link's) starts a Google
// sign-in; the transaction binds it to the browser's cookie, the OIDC nonce and the PKCE verifier,
// and is consumed by the callback before any outside call.
// ---------------------------------------------------------------------------------------------
const SIGNIN_TX_MS = 10 * MINUTE;

// What a ticket's hash refers to: a booking request (purpose book) or a sign-in cancel link
// (purpose cancel). Synchronous.
export function findTicket(sql, hash) {
  const request = sql.exec("SELECT * FROM booking_requests WHERE ticket_hash = ?", hash).toArray()[0];
  if (request) return { purpose: "book", request };
  const tok = sql.exec("SELECT * FROM tokens WHERE hash = ? AND action = 'cancel_signin'", hash).toArray()[0];
  const booking = tok && sql.exec("SELECT * FROM bookings WHERE id = ?", tok.booking_id).toArray()[0];
  return booking ? { purpose: "cancel", tok, booking } : null;
}
// Sign-ins a ticket has started, counted under its expiry day so the count outlives the ticket.
const attemptsKey = (hash, expiresAt) => [expiresAt.slice(0, 10), "signin", hash];
const attempts = (sql, hash, expiresAt) => quotaCount(sql, ...attemptsKey(hash, expiresAt));

// POST /book/confirm/google. A request ticket is first checked against the slot (settling it
// declined if it's gone, as the confirm page does); `busy` is the shared cache's answer, or [] if
// that can't be refreshed. Each ticket starts at most signinAttemptsPerTicket sign-ins, counted
// here and never refunded. `tx` holds the hashed state and cookie, the nonce and the verifier.
export async function startSignin(sql, { token, now, cfg, busy, tx, deps }) {
  if (typeof token !== "string" || token === "") return { error: "unknown" };
  const hash = await hashToken(token);
  const nowIso = now.toISOString();
  // ---- Synchronous from here to the insert. No await. ----
  const found = findTicket(sql, hash);
  if (!found) return { error: "unknown" };
  let expiresAt;
  if (found.purpose === "book") {
    const state = settleRequest(sql, found.request.id, { cfg, now, busy, deps });
    if (state !== "open") return { error: state };
    expiresAt = found.request.expires_at;
  } else {
    const { tok, booking: b } = found;
    if (tok.used_at || b.status !== "confirmed") return { error: "used" };
    if (tok.expires_at <= nowIso || b.start_utc <= nowIso) return { error: "expired" };
    expiresAt = tok.expires_at;
  }
  if (attempts(sql, hash, expiresAt) >= cfg.caps.signinAttemptsPerTicket) return { error: "too_many" };
  quotaAdd(sql, ...attemptsKey(hash, expiresAt));
  sql.exec(
    "INSERT INTO signin_tx (state_hash, ticket_hash, cookie_hash, nonce, code_verifier, purpose, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    tx.stateHash, hash, tx.cookieHash, tx.nonce, tx.codeVerifier, found.purpose, plus(nowIso, SIGNIN_TX_MS),
  );
  return { purpose: found.purpose };
}

// GET /book/callback/google, before any outside call: the transaction is deleted whatever happens
// next, so `state` is single-use even if the code exchange fails. It must come with this
// transaction's cookie and within its 10 minutes (whether or not the alarm has pruned it yet).
export function consumeSignin(sql, { stateHash, cookieHash, now }) {
  const tx = typeof stateHash === "string" && sql.exec("DELETE FROM signin_tx WHERE state_hash = ? RETURNING *", stateHash).toArray()[0];
  if (!tx) return { error: "state" };
  if (typeof cookieHash !== "string" || tx.cookie_hash !== cookieHash) return { error: "cookie" };
  if (tx.expires_at <= now.toISOString()) return { error: "expired" };
  return { tx };
}

// What the confirm page shows for a ticket (GET: changes nothing; the caller settles a request
// whose slot has gone first). No guest details.
const BOOKING_PAGE_STATE = { confirming: "confirming", confirmed: "confirmed", cancelling: "confirmed", declined: "declined", cancelled: "cancelled" };
// `hash` instead of a token: the callback knows only its transaction's ticket hash.
export async function peekTicket(sql, token, { now, cfg, hash: known }) {
  if (!known && (typeof token !== "string" || token === "")) return { state: "unknown" };
  const hash = known ?? (await hashToken(token));
  const nowIso = now.toISOString();
  const found = findTicket(sql, hash);
  if (!found) return { state: "unknown" };
  const view = (state, row, expiresAt, extra = {}) => ({ purpose: found.purpose, state, type: row.type, start: row.start_utc, end: row.end_utc, expires_at: expiresAt, ...extra });
  if (found.purpose === "book") {
    const r = found.request;
    const state = requestState(r, now);
    if (state === "declined") return view("declined", r, r.expires_at, { reason: r.reason });
    if (state === "used") {
      const b = sql.exec("SELECT status, status_reason FROM bookings WHERE id = ?", r.id).toArray()[0];
      const shown = BOOKING_PAGE_STATE[b?.status] ?? "unknown";
      return view(shown, r, r.expires_at, shown === "declined" ? { reason: b.status_reason } : {});
    }
    if (state === "open" && attempts(sql, hash, r.expires_at) >= cfg.caps.signinAttemptsPerTicket) return view("too_many", r, r.expires_at);
    return view(state, r, r.expires_at, state === "cancelled" ? { reason: "agent_withdrew" } : {});
  }
  const { tok, booking: b } = found;
  if (b.status === "cancelled" || b.status === "cancelling") return view(b.status, b, tok.expires_at);
  if (b.status !== "confirmed") return view("unknown", b, tok.expires_at);
  if (b.start_utc <= nowIso) return view("started", b, tok.expires_at);
  if (tok.used_at || tok.expires_at <= nowIso) return view("still_booked", b, tok.expires_at);
  if (attempts(sql, hash, tok.expires_at) >= cfg.caps.signinAttemptsPerTicket) return view("too_many", b, tok.expires_at);
  return view("open", b, tok.expires_at);
}
