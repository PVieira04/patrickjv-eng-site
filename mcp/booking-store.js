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

// Daily caps, reserved before any Google call or email and never refunded (fail closed), like
// request_intro's. Synchronous, so atomic inside the Durable Object. Global is checked first, and
// a refused request writes nothing, so refusals never eat into anyone's allowance. The request
// that uses up the global cap says so, once a day, so Patrick can be alerted.
export function reserveQuota(sql, { day, ipKey, emailKey, caps }) {
  const count = (kind, key) => sql.exec("SELECT n FROM quota WHERE day = ? AND kind = ? AND key = ?", day, kind, key).toArray()[0]?.n ?? 0;
  const g = count("global", "");
  if (g >= caps.globalPerDay) return { ok: false, which: "global" };
  if (count("ip", ipKey) >= caps.perIpPerDay) return { ok: false, which: "ip" };
  if (count("email", emailKey) >= caps.perEmailPerDay) return { ok: false, which: "email" };
  for (const [kind, key] of [["global", ""], ["ip", ipKey], ["email", emailKey]]) {
    sql.exec("INSERT INTO quota (day, kind, key, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, kind, key) DO UPDATE SET n = n + 1", day, kind, key);
  }
  return g + 1 === caps.globalPerDay ? { ok: true, globalJustExhausted: true } : { ok: true };
}

// Redacted failure log, as handler.js's logFailure: an event name and the subsystem only.
const logFailure = (subsystem) => console.error(JSON.stringify({ event: "booking_failure", subsystem }));

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

// One live hold at a time per IP and per email, so fake holds cost an attacker many of both.
function holdPending(sql, { now, ipKey, emailKey, cfg }) {
  const limit = cfg.caps.liveHoldsPerKey ?? 1;
  const live = (col, key) => sql.exec(
    `SELECT count(*) AS c FROM bookings WHERE status = 'pending_confirmation' AND hold_expires > ? AND ${col} = ?`,
    now.toISOString(), key,
  ).one().c;
  return live("ip_key", ipKey) >= limit || live("email_key", emailKey) >= limit;
}

export async function requestBooking(sql, { cfg, now, input, ipKey, emailKey, deps }) {
  const nowIso = now.toISOString();
  const quota = reserveQuota(sql, { day: deps.day(nowIso), ipKey, emailKey, caps: cfg.caps });
  if (!quota.ok) return { error: "rate_limited", reason: quota.which };
  const flag = quota.globalJustExhausted ? { globalJustExhausted: true } : {};
  if (holdPending(sql, { now, ipKey, emailKey, cfg })) return { error: "hold_pending", ...flag };
  const type = cfg.meetingTypes.find((t) => t.id === input.type);
  const slot = { cfg, typeId: input.type, start: input.start, now };
  // Cheap pre-check, so an invalid or already-taken slot never reaches Google.
  const pre = deps.checkSlot({ ...slot, busy: [], bookings: liveBookings(sql, now) });
  if (!pre.ok) return { ...slotError(pre.reason), ...flag };

  const end = plus(input.start, type.minutes * MINUTE);
  const buffer = cfg.bufferMinutes * MINUTE;
  let busy;
  try {
    ({ busy } = await deps.freeBusy(plus(input.start, -buffer), plus(end, buffer)));
  } catch {
    logFailure("google_freebusy");
    return { error: "unavailable", ...flag };
  }
  const [confirm, decline] = await Promise.all([newToken(), newToken()]);
  const id = newId();
  const holdExpires = new Date(now.getTime() + cfg.holdHours * HOUR).toISOString();

  // ---- Claim: synchronous from here to the inserts. No await. ----
  // Both rules again: other requests ran while free/busy was awaited.
  if (holdPending(sql, { now, ipKey, emailKey, cfg })) return { error: "hold_pending", ...flag };
  const check = deps.checkSlot({ ...slot, busy, bookings: liveBookings(sql, now) });
  if (!check.ok) return { ...slotError(check.reason), ...flag };
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
    await deps.sendEmail("hold", forEmail(booking), { confirmUrl: deps.actUrl(confirm.token), declineUrl: deps.actUrl(decline.token) });
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
  if (tok.used_at) return { error: "used" };
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
  return { error: "unknown" };
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

async function confirmHold(sql, { tok, booking: b }, { now, cfg, deps }) {
  const nowIso = now.toISOString();
  // A hold that already left pending has spent its links; this is a backstop.
  if (b.status !== "pending_confirmation" || b.hold_expires <= nowIso) return { error: "used" };
  const slot = { cfg, typeId: b.type, start: b.start_utc, now, ignoreNotice: true, excludeId: b.id };
  const decline = (reason) => {
    const why = reason === "day_full" ? "day_full" : "slot_taken";
    settle(sql, b.id, "declined", why, nowIso);
    return { result: "declined", reason: why };
  };

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
  const buffer = cfg.bufferMinutes * MINUTE;
  let busy;
  try {
    ({ busy } = await deps.freeBusy(plus(b.start_utc, -buffer), plus(b.end_utc, buffer)));
  } catch {
    return rollback("google_freebusy");
  }
  const check = deps.checkSlot({ ...slot, busy, bookings: meetings(sql) });
  if (!check.ok) return decline(check.reason);

  const type = cfg.meetingTypes.find((t) => t.id === b.type);
  const attendees = [{ email: b.guest_email, displayName: b.guest_name }];
  if (deps.ownerEmail) attendees.push({ email: deps.ownerEmail });
  const description = [`${type?.title ?? b.type}, booked on patrickjv.com.`, b.note ? `\nNote from the guest:\n${b.note}` : ""].join("");
  let event;
  try {
    // 409 (already created by an earlier attempt) comes back as created:false: still a success.
    event = await deps.insertEvent({ id: b.id, summary: `${type?.title ?? b.type}: ${b.guest_name}`, description, start: b.start_utc, end: b.end_utc, attendees });
  } catch {
    return rollback("google_insert");
  }

  const cancel = await newToken();
  sql.exec(
    "UPDATE bookings SET status = 'confirmed', status_reason = NULL, event_id = ?, hold_expires = NULL, delete_after = ? WHERE id = ?",
    b.id, plus(b.end_utc, cfg.retentionDays * DAY), b.id,
  );
  sql.exec("UPDATE tokens SET used_at = ? WHERE booking_id = ? AND used_at IS NULL", nowIso, b.id);
  sql.exec("INSERT INTO tokens (hash, booking_id, action, expires_at) VALUES (?, ?, 'cancel', ?)", cancel.hash, b.id, b.start_utc);
  try {
    await deps.sendEmail("booked", forEmail(b), { cancelUrl: deps.actUrl(cancel.token), meetLink: event?.meetLink ?? null });
  } catch {
    logFailure("email"); // Google's invite still reaches the guest.
  }
  return { result: "confirmed" };
}

// A booking's state for whoever holds its ID (a bearer secret): never the guest's details.
export function getStatus(sql, bookingId) {
  return sql.exec(
    `SELECT status, status_reason, start_utc AS start, end_utc AS "end", type FROM bookings WHERE id = ?`, bookingId,
  ).toArray()[0] ?? null;
}
