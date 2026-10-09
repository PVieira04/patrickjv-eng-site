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

// opts.fail: { freeBusy, insert: true (Google refused, a 4xx) | "unknown" (a timeout or 5xx after
// Google made the event) | "unknown-before" (no event made), delete }. Set them on t.fail later to
// change Google's behaviour mid-test.
function setup({ busy = [], fail = {} } = {}) {
  const sql = openSql();
  store.migrate(sql);
  const calls = { freeBusy: 0, emails: [], inserted: [], deleted: [] };
  const t = { sql, calls, fail: { ...fail }, busy };
  t.deps = {
    checkSlot,
    freeBusy: async () => { calls.freeBusy++; await tick(); if (t.fail.freeBusy) throw new Error("google down"); return { busy: t.busy }; },
    sendEmail: async (kind, booking, links) => { await tick(); calls.emails.push({ kind, booking, links }); },
    actUrl: (tk) => `https://patrickjv.com/api/booking/act?t=${tk}`,
    confirmUrl: (tk) => CONFIRM + tk,
    day: (iso) => iso.slice(0, 10),
    emailKey: async (email) => `ek:${email}`,
    insertEvent: async (ev) => {
      await tick();
      if (t.fail.insert === "unknown-before") throw new Error("timed out");
      if (t.fail.insert === "unknown") { calls.inserted.push(ev); throw new Error("timed out"); }
      if (t.fail.insert) throw Object.assign(new Error("google said no"), { status: 403 });
      calls.inserted.push(ev);
      return { created: true, meetLink: null };
    },
    getEvent: async (id) => { await tick(); return calls.inserted.some((e) => e.id === id) && !calls.deleted.includes(id) ? { meetLink: null } : null; },
    deleteEvent: async (id) => { await tick(); if (t.fail.delete) throw new Error("google down"); calls.deleted.push(id); return { deleted: true }; },
    ownerEmail: "owner@example.net",
  };
  return t;
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

// ---- The booking core: confirmRequest(request, person, grant) (D6) ------------------------------

const JANE = { provider: "google", subject: "sub-jane", email: "jane@gmail.com", display_name: "Jane Smith" };
const OMAR = { provider: "google", subject: "sub-omar", email: "omar@example.org", display_name: "Omar" };
// The grant a Google sign-in on this request's ticket produces (P1's exact shape).
const grantFor = async (r, over = {}) => {
  const row = await r;
  return { proof: "signin:google", actor: null, scope: "book", ticket_hash: await store.hashToken(ticketOf(row.confirm_url)), expires_at: row.link_expires, ...over };
};
const confirm = async (t, r, person = JANE, { now = NOW, grant = {}, c = cfg } = {}) =>
  store.confirmRequest(t.sql, r.booking_id, person, await grantFor(r, grant), { cfg: c, now, deps: t.deps });
const bookingRow = (t, id) => t.sql.exec("SELECT * FROM bookings WHERE id = ?", id).toArray()[0];

test("F-002 confirmRequest: books the slot for the verified person: booking row (the request's id) with identity, proof and guest from the sign-in; event; 'Booked' email", async () => {
  const t = setup();
  const r = await ask(t, { note: "About platforms" }, { ipKey: "ipJ" });
  assert.deepEqual(await confirm(t, r), { result: "confirmed" });
  const b = bookingRow(t, r.booking_id);
  const identity = t.sql.exec("SELECT * FROM identities").one();
  assert.deepEqual([identity.provider, identity.subject, identity.email, identity.display_name], ["google", "sub-jane", "jane@gmail.com", "Jane Smith"]);
  assert.deepEqual(
    [b.status, b.type, b.start_utc, b.end_utc, b.guest_name, b.guest_email, b.email_key, b.source, b.ip_key, b.note, b.identity_id, b.proof, b.actor],
    ["confirmed", "consultation", SLOT, SLOT_END, "Jane Smith", "jane@gmail.com", "ek:jane@gmail.com", "mcp", "ipJ", "About platforms", identity.id, "signin:google", null],
  );
  assert.equal(requestRow(t, r.booking_id).state, "used");
  const [ev] = t.calls.inserted;
  assert.equal(ev.id, r.booking_id);
  assert.equal(ev.summary, "Consultation: Jane Smith");
  assert.deepEqual(ev.attendees, ["jane@gmail.com", "owner@example.net"]);
  assert.equal(t.calls.freeBusy, 1, "free/busy re-checked after the claim");
  assert.deepEqual(t.calls.emails.map((m) => [m.kind, m.booking.email]), [["booked", "jane@gmail.com"]]);
  assert.ok(t.calls.emails[0].links.cancelUrl, "the 'Booked' email carries a cancel link, as F-001's");
  assert.equal(store.getStatus(t.sql, r.booking_id, NOW).status, "confirmed");
  // Retention: the identity lasts 30 days after the later of its sign-in and its meeting's end.
  assert.equal(identity.delete_after, new Date(Date.parse(SLOT_END) + 30 * 24 * HOUR).toISOString());
});

test("F-002 confirmRequest: the grant is checked in the claim: wrong scope, another ticket, or an expired grant books nothing", async () => {
  const t = setup();
  const r = await ask(t);
  for (const grant of [{ scope: "cancel" }, { ticket_hash: "0".repeat(64) }, { expires_at: NOW.toISOString() }, { proof: "booked_email_link" }]) {
    assert.deepEqual(await confirm(t, r, JANE, { grant }), { error: "forbidden" }, JSON.stringify(grant));
  }
  assert.equal(bookingRow(t, r.booking_id), undefined);
  assert.equal(requestRow(t, r.booking_id).state, "open", "the request stays open");
  assert.equal((await confirm(t, r)).result, "confirmed", "the right grant still books");
});

test("F-002 confirmRequest: an expired, used, withdrawn or declined request starts nothing; nor does a start that has passed", async () => {
  const t = setup();
  const expired = await ask(t);
  assert.deepEqual(await confirm(t, expired, JANE, { now: later(HOUR), grant: { expires_at: later(2 * HOUR).toISOString() } }), { error: "expired" });
  const used = await ask(t);
  await confirm(t, used);
  assert.deepEqual(await confirm(t, used, OMAR), { error: "used" }, "a later attempt on a booked ticket");
  const withdrawn = await ask(t, { start: "2026-10-22T09:00:00.000Z" });
  await store.cancelByAgent(t.sql, { bookingId: withdrawn.booking_id, now: NOW, deps: t.deps });
  assert.deepEqual(await confirm(t, withdrawn), { error: "used" });
  const declined = await ask(t, { start: "2026-10-22T09:00:00.000Z" });
  t.sql.exec("UPDATE booking_requests SET state = 'declined', reason = 'slot_taken' WHERE id = ?", declined.booking_id);
  assert.deepEqual(await confirm(t, declined), { error: "used" });
  // Backstop: config forbids a request outliving its slot, but the claim refuses a past start anyway.
  const past = await ask(t, { start: "2026-10-23T09:00:00.000Z" });
  t.sql.exec("UPDATE booking_requests SET start_utc = ?, expires_at = ? WHERE id = ?", NOW.toISOString(), later(HOUR).toISOString(), past.booking_id);
  assert.deepEqual(await confirm(t, past, OMAR, { grant: { expires_at: later(HOUR).toISOString() } }), { error: "expired" });
  assert.equal(t.calls.inserted.length, 1);
});

test("F-002 confirmRequest: notice isn't re-applied: a request made with 24h05m notice and signed in on 10 minutes later still books", async () => {
  const t = setup();
  const made = new Date("2026-10-19T09:10:00.000Z"), start = "2026-10-20T09:15:00.000Z";
  const r = await ask(t, { start }, { now: made });
  assert.equal(r.status, "pending_confirmation");
  assert.deepEqual(await confirm(t, r, JANE, { now: later(10 * MINUTE, made) }), { result: "confirmed" });
});

test("F-002 confirmRequest race: 20 concurrent sign-ins on one ticket give exactly one meeting", async () => {
  const t = setup();
  const r = await ask(t);
  const people = Array.from({ length: 20 }, (_, i) => ({ ...JANE, subject: `s${i}`, email: `p${i}@gmail.com` }));
  const results = await Promise.all(people.map((p) => confirm(t, r, p)));
  assert.equal(results.filter((x) => x.result === "confirmed").length, 1, JSON.stringify(results.slice(0, 3)));
  assert.ok(results.filter((x) => x.result !== "confirmed").every((x) => x.error === "used"));
  assert.equal(t.calls.inserted.length, 1);
});

test("F-002 confirmRequest race: 20 sign-ins on different requests for overlapping slots give exactly one meeting; the rest are declined slot_taken", async () => {
  const t = setup();
  const starts = ["2026-10-21T08:45:00.000Z", SLOT, "2026-10-21T09:15:00.000Z", "2026-10-21T09:30:00.000Z"];
  const reqs = await Promise.all(Array.from({ length: 20 }, (_, i) => ask(t, { start: starts[i % 4] })));
  const results = await Promise.all(reqs.map((r, i) => confirm(t, r, { ...JANE, subject: `s${i}` })));
  assert.equal(results.filter((x) => x.result === "confirmed").length, 1);
  assert.ok(results.filter((x) => x.result !== "confirmed").every((x) => x.result === "declined" && x.reason === "slot_taken"), JSON.stringify(results));
  assert.equal(t.calls.inserted.length, 1);
  const loser = reqs.find((r, i) => results[i].result === "declined");
  assert.equal(store.getStatus(t.sql, loser.booking_id, NOW).status, "declined");
});

// ---- Person caps (D7) ------------------------------------------------------------------------

const DAYS = ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"].map((d) => `${d}T09:00:00.000Z`);

test("F-002 person caps: one person confirming 5 requests at once never exceeds confirmationsPerPersonPerDay; the refused requests stay open for another account", async () => {
  const t = setup();
  const reqs = await Promise.all(DAYS.map((start) => ask(t, { start })));
  const results = await Promise.all(reqs.map((r) => confirm(t, r)));
  assert.equal(results.filter((x) => x.result === "confirmed").length, 2, JSON.stringify(results));
  const refused = reqs.filter((r, i) => results[i].error);
  assert.ok(results.filter((x) => x.error).every((x) => x.error === "person_cap"));
  assert.ok(refused.every((r) => requestRow(t, r.booking_id).state === "open"), "nothing is booked; the request stays open");
  assert.equal((await confirm(t, refused[0], OMAR)).result, "confirmed", "another account may still use it");
});

test("F-002 person caps: with one meeting already upcoming, 5 at once add only one more (upcomingPerPerson 2); cancelling frees an upcoming place, not the day's count", async () => {
  const t = setup();
  const c = { ...cfg, caps: { ...cfg.caps, confirmationsPerPersonPerDay: 10 } };
  const first = await ask(t, { start: "2026-10-28T09:00:00.000Z" });
  assert.equal((await confirm(t, first, JANE, { c })).result, "confirmed");
  const reqs = await Promise.all(DAYS.map((start) => ask(t, { start })));
  const results = await Promise.all(reqs.map((r) => confirm(t, r, JANE, { c })));
  assert.equal(results.filter((x) => x.result === "confirmed").length, 1, JSON.stringify(results));
  assert.ok(results.filter((x) => x.error).every((x) => x.error === "person_cap" && x.which === "upcoming"));
  const open = reqs.filter((r, i) => results[i].error);
  assert.ok(open.every((r) => requestRow(t, r.booking_id).state === "open"));
  // A meeting that has ended no longer counts as upcoming.
  t.sql.exec("UPDATE bookings SET end_utc = ? WHERE id = ?", later(-MINUTE).toISOString(), first.booking_id);
  assert.equal((await confirm(t, open[0], JANE, { c })).result, "confirmed", "an ended meeting frees an upcoming place");
  assert.deepEqual(await confirm(t, open[1], JANE, { c }), { error: "person_cap", which: "upcoming" });
  const booked = reqs.find((r, i) => results[i].result === "confirmed");
  t.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE id = ?", booked.booking_id);
  assert.equal((await confirm(t, open[1], JANE, { c })).result, "confirmed", "a cancelled meeting frees an upcoming place");
});

test("F-002 person caps: the daily confirmation count is taken at the claim and never refunded", async () => {
  const t = setup();
  const [a, b, c3] = await Promise.all(DAYS.slice(0, 3).map((start) => ask(t, { start })));
  assert.equal((await confirm(t, a)).result, "confirmed");
  assert.equal((await confirm(t, b)).result, "confirmed");
  t.sql.exec("UPDATE bookings SET status = 'cancelled'");
  assert.deepEqual(await confirm(t, c3), { error: "person_cap", which: "daily" }, "cancelling refunds nothing");
  assert.deepEqual(t.sql.exec("SELECT kind, key, n FROM quota WHERE kind = 'person_day'").toArray().map((q) => q.n), [2]);
  // A new UTC day starts at zero.
  const tomorrow = new Date("2026-10-20T08:00:00.000Z");
  const d = await ask(t, { start: DAYS[3] }, { now: tomorrow });
  assert.equal((await confirm(t, d, JANE, { now: later(10 * MINUTE, tomorrow) })).result, "confirmed");
});

test("F-002 maxPerDay counts meetings from both paths: an F-001 email booking and sign-in bookings share the day's 3", async () => {
  const t = setup();
  const h = await holdFor(t, "2026-10-21T13:00:00.000Z");
  t.sql.exec("UPDATE bookings SET status = 'confirmed' WHERE id = ?", h.booking_id);
  const reqs = await Promise.all(["2026-10-21T09:00:00.000Z", "2026-10-21T10:00:00.000Z", "2026-10-21T11:00:00.000Z"].map((start) => ask(t, { start })));
  const results = [];
  for (const [i, r] of reqs.entries()) results.push(await confirm(t, r, { ...JANE, subject: `s${i}` }));
  assert.deepEqual(results.map((x) => x.result), ["confirmed", "confirmed", "declined"]);
  assert.equal(results[2].reason, "day_full");
});

// ---- Failures after a sign-in ------------------------------------------------------------------

test("F-002 failures: busy at the post-claim re-check → declined slot_taken; Google refusing the insert (4xx) → declined unavailable; request used either way", async () => {
  const t = setup();
  const a = await ask(t);
  t.busy = [{ start: SLOT, end: SLOT_END }];
  assert.deepEqual(await confirm(t, a), { result: "declined", reason: "slot_taken" });
  assert.deepEqual([bookingRow(t, a.booking_id).status, bookingRow(t, a.booking_id).status_reason], ["declined", "slot_taken"]);
  assert.equal(requestRow(t, a.booking_id).state, "used");
  t.busy = [];
  t.fail.insert = true;
  const b = await ask(t, { start: "2026-10-22T09:00:00.000Z" });
  assert.deepEqual(await confirm(t, b), { result: "declined", reason: "unavailable" });
  assert.equal(store.getStatus(t.sql, b.booking_id, NOW).status_reason, "unavailable");
  assert.deepEqual(store.liveBookings(t.sql, NOW), [], "declined bookings free the slot");
  assert.equal(t.calls.emails.length, 0);
});

test("F-002 failures: free/busy unreachable after the claim, or an insert with no clear answer, leaves the booking confirming for the alarm; nothing is rolled back", async () => {
  const t = setup({ fail: { freeBusy: true } });
  const a = await ask(t);
  assert.deepEqual(await confirm(t, a), { result: "confirming" });
  assert.equal(bookingRow(t, a.booking_id).status, "confirming");
  assert.equal(requestRow(t, a.booking_id).state, "used");
  assert.equal(store.getStatus(t.sql, a.booking_id, NOW).status, "pending_confirmation");
  t.fail = { insert: "unknown" };
  const b = await ask(t, { start: "2026-10-22T09:00:00.000Z" });
  assert.deepEqual(await confirm(t, b, OMAR), { result: "confirming" });
  assert.equal(bookingRow(t, b.booking_id).status, "confirming");
  assert.deepEqual(t.sql.exec("SELECT n FROM quota WHERE kind = 'person_day'").toArray().map((q) => q.n), [1, 1], "nothing refunded");
});

// ---- Recovery of sign-in bookings (the alarm) ---------------------------------------------------

const recover = (t, id, now = later(5 * MINUTE)) => store.recoverConfirm(t.sql, bookingRow(t, id), { cfg, now, deps: t.deps });

test("F-002 recovery: a sign-in booking cut off after the claim is completed with the stored guest (event exists → confirmed; none → re-checked and inserted)", async () => {
  const t = setup({ fail: { insert: "unknown" } });
  const a = await ask(t);
  await confirm(t, a); // the event was made, but the answer was lost
  t.fail = {};
  assert.deepEqual(await recover(t, a.booking_id), { result: "confirmed" });
  assert.equal(t.calls.inserted.length, 1, "asked Google first: no second insert");
  t.fail = { insert: "unknown-before" };
  const b = await ask(t, { start: "2026-10-22T09:00:00.000Z" });
  await confirm(t, b, OMAR);
  t.fail = {};
  assert.deepEqual(await recover(t, b.booking_id), { result: "confirmed" });
  assert.deepEqual(t.calls.inserted.at(-1).attendees, ["omar@example.org", "owner@example.net"]);
  assert.deepEqual(t.calls.emails.map((m) => [m.kind, m.booking.email]), [["booked", "jane@gmail.com"], ["booked", "omar@example.org"]]);
});

test("F-002 recovery: eviction after the claim, then Google refusing recovery's insert (4xx) → declined unavailable, freeing the slot and the person's upcoming place", async () => {
  const t = setup({ fail: { freeBusy: true } });
  const c = { ...cfg, caps: { ...cfg.caps, upcomingPerPerson: 1 } };
  const a = await ask(t);
  assert.equal((await confirm(t, a, JANE, { c })).result, "confirming");
  t.fail = { insert: true };
  assert.deepEqual(await recover(t, a.booking_id), { result: "declined", reason: "unavailable" });
  assert.equal(bookingRow(t, a.booking_id).status, "declined");
  t.fail = {};
  const b = await ask(t);
  assert.equal((await confirm(t, b, JANE, { c })).result, "confirmed", "the slot and the upcoming place are free again");
});

test("F-002 recovery: a meeting whose start has passed with no event in Google is settled declined (unavailable) without inserting", async () => {
  const t = setup({ fail: { freeBusy: true } });
  const a = await ask(t);
  await confirm(t, a);
  t.fail = {};
  assert.deepEqual(await recover(t, a.booking_id, new Date(Date.parse(SLOT) + MINUTE)), { result: "declined", reason: "unavailable" });
  assert.equal(t.calls.inserted.length, 0);
});

test("F-002 recovery: an F-001 email booking whose recovery insert is refused still throws for the next alarm, as before", async () => {
  const t = setup();
  const h = await holdFor(t, SLOT);
  t.sql.exec("UPDATE bookings SET status = 'confirming' WHERE id = ?", h.booking_id);
  t.fail = { insert: true };
  await assert.rejects(recover(t, h.booking_id));
  assert.equal(bookingRow(t, h.booking_id).status, "confirming");
});
