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
