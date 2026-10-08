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

export async function requestBooking(sql, { cfg, now, input, ipKey, emailKey, deps }) {
  const nowIso = now.toISOString();
  const quota = reserveQuota(sql, { day: deps.day(nowIso), ipKey, emailKey, caps: cfg.caps });
  if (!quota.ok) return { error: "rate_limited", reason: quota.which };
  const flag = quota.globalJustExhausted ? { globalJustExhausted: true } : {};
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
  await deps.sendEmail("hold", forEmail(booking), { confirmUrl: deps.actUrl(confirm.token), declineUrl: deps.actUrl(decline.token) });
  return { booking_id: id, status: "pending_confirmation", hold_expires: holdExpires, ...flag };
}

// A booking's state for whoever holds its ID (a bearer secret): never the guest's details.
export function getStatus(sql, bookingId) {
  return sql.exec(
    `SELECT status, status_reason, start_utc AS start, end_utc AS "end", type FROM bookings WHERE id = ?`, bookingId,
  ).toArray()[0] ?? null;
}
