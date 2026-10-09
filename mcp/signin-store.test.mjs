// Run with: npm test
// F-002's sign-in path in the booking store: booking requests (which reserve nothing), the sign-in
// transactions, and the one booking core (confirmRequest / cancelMeeting). Real SQLite
// (node:sqlite), the real slot rules (booking-config.js) and fake Google/email dependencies that
// genuinely yield, so interleavings like a Durable Object's happen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openSql } from "./booking-sqlite.mjs";
import { checkSlot, availableSlots } from "./booking-config.js";
// Namespace import: a function not written yet fails only the tests that call it.
import * as store from "./booking-store.js";

const cfg = JSON.parse(readFileSync(new URL("../booking.json", import.meta.url), "utf8"));
const NOW = new Date("2026-10-19T09:00:00.000Z"); // Monday, BST
const SLOT = "2026-10-21T09:00:00.000Z"; // Wed 10:00 London
const SLOT_END = "2026-10-21T09:30:00.000Z";
const MINUTE = 60e3, HOUR = 60 * MINUTE;
const later = (ms, from = NOW) => new Date(from.getTime() + ms);
const tick = () => new Promise((r) => setTimeout(r, Math.random() * 5));
const CONFIRM = "https://patrickjv.com/book/confirm?t=";
const ticketOf = (url) => url.slice(CONFIRM.length);

function setup({ busy = [] } = {}) {
  const sql = openSql();
  store.migrate(sql);
  const calls = { freeBusy: 0, emails: [], inserted: [], deleted: [] };
  const deps = {
    checkSlot,
    freeBusy: async () => { calls.freeBusy++; await tick(); return { busy }; },
    sendEmail: async (kind, booking, links) => { await tick(); calls.emails.push({ kind, booking, links }); },
    actUrl: (t) => `https://patrickjv.com/api/booking/act?t=${t}`,
    confirmUrl: (t) => CONFIRM + t,
    day: (iso) => iso.slice(0, 10),
    insertEvent: async (ev) => { await tick(); calls.inserted.push(ev); return { created: true, meetLink: null }; },
    getEvent: async (id) => { await tick(); return calls.inserted.some((e) => e.id === id) ? { meetLink: null } : null; },
    deleteEvent: async (id) => { await tick(); calls.deleted.push(id); return { deleted: true }; },
    ownerEmail: "owner@example.net",
  };
  return { sql, deps, calls };
}

let n = 0;
// A booking request from a distinct IP unless told otherwise. `busy` is what the shared free/busy
// cache says (the service passes it in).
const ask = (t, over = {}, { now = NOW, ipKey, busy = [], c = cfg } = {}) => {
  n++;
  return store.createRequest(t.sql, { cfg: c, now, input: { type: "consultation", start: SLOT, source: "mcp", ...over }, ipKey: ipKey ?? `ip${n}`, busy, deps: t.deps });
};
const requestRow = (t, id) => t.sql.exec("SELECT * FROM booking_requests WHERE id = ?", id).one();
const count = (t, q, ...b) => t.sql.exec(q, ...b).one().c;
const quotaRows = (t) => t.sql.exec("SELECT kind, key, n FROM quota ORDER BY kind, key").toArray();
const holdFor = (t, start, email = "hold@example.com") => store.requestBooking(t.sql, {
  cfg, now: NOW, input: { type: "consultation", start, name: "Holder", email, source: "page" }, ipKey: `hip${++n}`, emailKey: `hem${n}`, deps: t.deps,
});

// ---- Booking requests reserve nothing ---------------------------------------------------------

test("F-002 request: stores a booking request with a 128-bit ticket (only its hash kept), lasting requestMinutes; reserves nothing and sends nothing", async () => {
  const t = setup();
  const r = await ask(t, { note: "About platforms" });
  assert.match(r.booking_id, /^[0-9a-f]{32}$/);
  assert.equal(r.status, "pending_confirmation");
  assert.equal(r.link_expires, "2026-10-19T10:00:00.000Z", "60 minutes, from booking.json");
  assert.ok(r.confirm_url.startsWith(CONFIRM));
  const ticket = ticketOf(r.confirm_url);
  assert.match(ticket, /^[A-Za-z0-9_-]{22}$/, "16 random bytes, base64url");
  const row = requestRow(t, r.booking_id);
  assert.equal(row.ticket_hash, await store.hashToken(ticket));
  assert.ok(!JSON.stringify(t.sql.exec("SELECT * FROM booking_requests").toArray()).includes(ticket), "the ticket itself is stored nowhere");
  assert.deepEqual([row.type, row.start_utc, row.end_utc, row.note, row.source, row.state, row.expires_at], ["consultation", SLOT, SLOT_END, "About platforms", "mcp", "open", r.link_expires]);
  assert.equal(count(t, "SELECT count(*) c FROM bookings"), 0, "no booking row");
  assert.deepEqual(store.liveBookings(t.sql, NOW), [], "nothing blocks the slot");
  assert.ok(availableSlots({ cfg, typeId: "consultation", now: NOW, from: "2026-10-21", to: "2026-10-21", busy: [], bookings: store.liveBookings(t.sql, NOW) })
    .some((s) => s.start === SLOT), "the slot is still offered");
  assert.equal(t.calls.emails.length, 0);
  assert.equal(t.calls.freeBusy, 0, "free/busy comes from the shared cache the caller passes in");
  // Two requests for the same slot can both exist.
  assert.equal((await ask(t)).status, "pending_confirmation");
});

test("F-002 request: a start that isn't a free slot is refused as F-001 refuses it, and takes no allowance", async () => {
  const t = setup();
  await holdFor(t, "2026-10-22T09:00:00.000Z");
  for (const [over, opts, want] of [
    [{}, { busy: [{ start: "2026-10-21T09:30:00.000Z", end: "2026-10-21T10:00:00.000Z" }] }, { error: "slot_taken", reason: "busy" }],
    [{ start: "2026-10-22T09:00:00.000Z" }, {}, { error: "slot_taken", reason: "taken" }], // a live F-001 hold
    [{ start: "2026-10-19T15:00:00.000Z" }, {}, { error: "invalid_slot", reason: "notice" }],
    [{ start: "2026-12-21T10:00:00.000Z" }, {}, { error: "invalid_slot", reason: "horizon" }],
    [{ start: "2026-10-21T09:05:00.000Z" }, {}, { error: "invalid_slot", reason: "not_a_slot" }],
  ]) {
    assert.deepEqual(await ask(t, over, opts), want, JSON.stringify(over));
  }
  assert.equal(count(t, "SELECT count(*) c FROM booking_requests"), 0);
  assert.deepEqual(quotaRows(t).filter((q) => q.kind.startsWith("request")), [], "no request counter written");
});

test("F-002 request: a full day is refused as slot_taken (day_full) and takes no allowance", async () => {
  const t = setup();
  for (const [i, start] of ["2026-10-21T11:00:00.000Z", "2026-10-21T12:00:00.000Z", "2026-10-21T13:00:00.000Z"].entries()) {
    t.sql.exec(`INSERT INTO bookings (id, type, start_utc, end_utc, status, source, guest_name, guest_email, ip_key, email_key, created_at, delete_after)
      VALUES (?, 'consultation', ?, ?, 'confirmed', 'page', 'G', 'g@example.com', 'i', 'e', ?, ?)`, `m${i}`, start, new Date(Date.parse(start) + 30 * MINUTE).toISOString(), NOW.toISOString(), "2027-01-01T00:00:00.000Z");
  }
  assert.deepEqual(await ask(t), { error: "slot_taken", reason: "day_full" });
  assert.deepEqual(quotaRows(t), []);
});

// ---- Caps (D7) --------------------------------------------------------------------------------

test("F-002 request caps: requestsPerIpPerDay per IP, requestsPerDay in total; taken when stored, never refunded", async () => {
  const t = setup();
  const c = { ...cfg, caps: { ...cfg.caps, requestsPerIpPerDay: 3, requestsPerDay: 5 } };
  const mine = [];
  for (let i = 0; i < 3; i++) mine.push(await ask(t, {}, { ipKey: "ipA", c }));
  assert.ok(mine.every((r) => r.status === "pending_confirmation"));
  assert.deepEqual(await ask(t, {}, { ipKey: "ipA", c }), { error: "rate_limited", reason: "ip" });
  // Withdrawing gives nothing back.
  assert.equal((await store.cancelByAgent(t.sql, { bookingId: mine[0].booking_id, now: NOW, deps: t.deps })).status, "cancelled");
  assert.deepEqual(await ask(t, {}, { ipKey: "ipA", c }), { error: "rate_limited", reason: "ip" });
  assert.equal((await ask(t, {}, { ipKey: "ipB", c })).status, "pending_confirmation");
  assert.equal((await ask(t, {}, { ipKey: "ipC", c })).status, "pending_confirmation");
  assert.deepEqual(await ask(t, {}, { ipKey: "ipD", c }), { error: "rate_limited", reason: "global" });
  // A refused request changes no count.
  assert.deepEqual(quotaRows(t).map((q) => [q.kind, q.key, q.n]), [["request_global", "", 5], ["request_ip", "ipA", 3], ["request_ip", "ipB", 1], ["request_ip", "ipC", 1]]);
  // A new UTC day starts at zero.
  assert.equal((await ask(t, { start: "2026-10-22T09:00:00.000Z" }, { ipKey: "ipA", c, now: later(24 * HOUR) })).status, "pending_confirmation");
});

// ---- Status -----------------------------------------------------------------------------------

test("F-002 status: an open request reads pending_confirmation; past link_expires, expired (request_expired); withdrawn, cancelled (agent_withdrew)", async () => {
  const t = setup();
  const a = await ask(t), b = await ask(t);
  const view = (id, now = NOW) => store.getStatus(t.sql, id, now);
  assert.deepEqual(view(a.booking_id), { status: "pending_confirmation", status_reason: null, start: SLOT, end: SLOT_END, type: "consultation" });
  assert.deepEqual(view(a.booking_id, later(60 * MINUTE)), { status: "expired", status_reason: "request_expired", start: SLOT, end: SLOT_END, type: "consultation" });
  assert.deepEqual(await store.cancelByAgent(t.sql, { bookingId: b.booking_id, now: NOW, deps: t.deps }), { status: "cancelled" });
  assert.equal(view(b.booking_id).status, "cancelled");
  assert.equal(view(b.booking_id).status_reason, "agent_withdrew");
  assert.equal(view(store.newId()), null);
});

test("F-002 cancel_booking on requests: an open one is withdrawn at once; an expired, withdrawn or declined one is not cancellable", async () => {
  const t = setup();
  const a = await ask(t);
  assert.deepEqual(await store.cancelByAgent(t.sql, { bookingId: a.booking_id, now: NOW, deps: t.deps }), { status: "cancelled" });
  assert.equal(requestRow(t, a.booking_id).state, "cancelled");
  assert.equal(requestRow(t, a.booking_id).settled_at, NOW.toISOString());
  assert.deepEqual(await store.cancelByAgent(t.sql, { bookingId: a.booking_id, now: NOW, deps: t.deps }), { error: "not_cancellable", status: "cancelled" });
  const b = await ask(t);
  assert.deepEqual(await store.cancelByAgent(t.sql, { bookingId: b.booking_id, now: later(HOUR), deps: t.deps }), { error: "not_cancellable", status: "expired" });
});

// ---- A request whose slot is no longer free is settled declined, once (Functional) -------------

test("F-002 settle: an open request whose slot another booking or live F-001 hold now overlaps is settled declined (slot_taken) for good", async () => {
  const t = setup();
  const a = await ask(t);
  assert.equal(store.settleRequest(t.sql, a.booking_id, { cfg, now: NOW, busy: [], deps: t.deps }), "open", "still free: stays open");
  await holdFor(t, SLOT);
  assert.equal(store.settleRequest(t.sql, a.booking_id, { cfg, now: NOW, busy: [], deps: t.deps }), "declined");
  assert.deepEqual([requestRow(t, a.booking_id).state, requestRow(t, a.booking_id).reason], ["declined", "slot_taken"]);
  assert.equal(store.getStatus(t.sql, a.booking_id, NOW).status, "declined");
  assert.equal(store.getStatus(t.sql, a.booking_id, NOW).status_reason, "slot_taken");
  // For good: the hold going away doesn't reopen it.
  t.sql.exec("UPDATE bookings SET status = 'cancelled'");
  assert.equal(store.settleRequest(t.sql, a.booking_id, { cfg, now: NOW, busy: [], deps: t.deps }), "declined");
});

test("F-002 settle: busy in free/busy → slot_taken; a full day → day_full; notice is not re-applied; an expired request is left alone", async () => {
  const t = setup();
  const a = await ask(t);
  assert.equal(store.settleRequest(t.sql, a.booking_id, { cfg, now: NOW, busy: [{ start: SLOT, end: SLOT_END }], deps: t.deps }), "declined");
  assert.equal(requestRow(t, a.booking_id).reason, "slot_taken");

  const b = await ask(t);
  for (const [i, start] of ["2026-10-21T11:00:00.000Z", "2026-10-21T12:00:00.000Z", "2026-10-21T13:00:00.000Z"].entries()) {
    t.sql.exec(`INSERT INTO bookings (id, type, start_utc, end_utc, status, source, guest_name, guest_email, ip_key, email_key, created_at, delete_after)
      VALUES (?, 'consultation', ?, ?, 'confirmed', 'page', 'G', 'g@example.com', 'i', 'e', ?, ?)`, `m${i}`, start, new Date(Date.parse(start) + 30 * MINUTE).toISOString(), NOW.toISOString(), "2027-01-01T00:00:00.000Z");
  }
  assert.equal(store.settleRequest(t.sql, b.booking_id, { cfg, now: NOW, busy: [], deps: t.deps }), "declined");
  assert.equal(requestRow(t, b.booking_id).reason, "day_full");

  // Made with 24h05m notice; 10 minutes later the slot is inside the notice window, but still open.
  const t2 = setup();
  const start = "2026-10-20T09:15:00.000Z", now = new Date("2026-10-19T09:10:00.000Z");
  const c = await ask(t2, { start }, { now });
  assert.equal(c.status, "pending_confirmation");
  assert.equal(store.settleRequest(t2.sql, c.booking_id, { cfg, now: later(10 * MINUTE, now), busy: [], deps: t2.deps }), "open");

  const d = await ask(t2);
  await holdFor(t2, SLOT);
  assert.equal(store.settleRequest(t2.sql, d.booking_id, { cfg, now: later(HOUR), busy: [], deps: t2.deps }), "expired", "an expired request stays expired, not declined");
  assert.equal(store.getStatus(t2.sql, d.booking_id, later(HOUR)).status, "expired");
});
