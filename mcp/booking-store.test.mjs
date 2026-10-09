// Run with: npm test
// The booking store's state machine, against real SQLite (node:sqlite) and fake Google/email
// dependencies that genuinely yield (setTimeout), so interleavings like a Durable Object's happen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openSql } from "./booking-sqlite.mjs";
// Namespace import: a function not written yet fails only the tests that call it.
import * as store from "./booking-store.js";

const cfg = {
  timezone: "Europe/London",
  hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "10:00", end: "17:00" },
  slotStepMinutes: 15, minNoticeHours: 24, horizonDays: 28, bufferMinutes: 15, maxPerDay: 3,
  holdHours: 2, retentionDays: 30,
  caps: { perIpPerDay: 4, perEmailPerDay: 2, globalPerDay: 10, liveHoldsPerEmail: 1 },
  meetingTypes: [
    { id: "consultation", title: "Consultation", minutes: 30, description: "A consultation." },
    { id: "recruiter-intro", title: "Recruiter intro", minutes: 15, description: "An intro." },
  ],
  calendars: [],
};

const NOW = new Date("2026-10-19T09:00:00.000Z"); // Monday
const SLOT = "2026-10-21T10:00:00.000Z"; // Wednesday, 49 hours ahead
const HOUR = 3600e3;
const later = (ms, from = NOW) => new Date(from.getTime() + ms);
const tick = () => new Promise((r) => setTimeout(r, Math.random() * 5));

// A stand-in for package A's checkSlot with the contract's rules that matter here: unknown type,
// notice, overlap (with buffer) against busy and other bookings, excludeId, and day_full (counted
// on the UTC day, which is the London day for these test times' purposes).
const LIVE = new Set(["pending_confirmation", "confirming", "confirmed", "cancelling"]);
const COUNTS = new Set(["confirming", "confirmed", "cancelling"]);
function fakeCheckSlot({ cfg, typeId, start, now, busy, bookings, ignoreNotice = false, excludeId }) {
  const type = cfg.meetingTypes.find((t) => t.id === typeId);
  if (!type) return { ok: false, reason: "unknown_type" };
  const s = Date.parse(start);
  if (Number.isNaN(s)) return { ok: false, reason: "not_a_slot" };
  if (!ignoreNotice && s < now.getTime() + cfg.minNoticeHours * HOUR) return { ok: false, reason: "notice" };
  const e = s + type.minutes * 60e3, buf = cfg.bufferMinutes * 60e3;
  const hits = (i) => Date.parse(i.start) < e + buf && Date.parse(i.end) > s - buf;
  if (busy.some(hits)) return { ok: false, reason: "busy" };
  const others = bookings.filter((b) => b.id !== excludeId && LIVE.has(b.status));
  if (others.some(hits)) return { ok: false, reason: "taken" };
  const day = start.slice(0, 10);
  if (others.filter((b) => COUNTS.has(b.status) && b.start.slice(0, 10) === day).length >= cfg.maxPerDay) return { ok: false, reason: "day_full" };
  return { ok: true };
}

const ACT = "https://patrickjv.com/api/booking/act?t=";
const tokenOf = (url) => url.slice(ACT.length);

// Fresh database plus recording fakes. Every fake awaits a real timer before answering.
function setup({ busy = [], emailFails = false, insertFails = false, deleteFails = false } = {}) {
  const sql = openSql();
  store.migrate(sql);
  const calls = { freeBusy: 0, emails: [], inserted: [], deleted: [] };
  const deps = {
    checkSlot: fakeCheckSlot,
    freeBusy: async () => { calls.freeBusy++; await tick(); return { busy }; },
    sendEmail: async (kind, booking, links) => {
      await tick();
      if (typeof emailFails === "function" ? emailFails(kind) : emailFails) throw new Error("mail down");
      calls.emails.push({ kind, booking, links });
    },
    actUrl: (t) => ACT + t,
    day: (iso) => iso.slice(0, 10),
    // insertFails: true → Google refused (a 4xx: nothing made); "unknown" → a timeout or 5xx after
    // Google made the event.
    insertEvent: async (ev) => {
      await tick();
      if (insertFails === "unknown") { calls.inserted.push(ev); throw new Error("timed out"); }
      if (insertFails) throw Object.assign(new Error("google said no"), { status: 403 });
      calls.inserted.push(ev);
      return { created: true, meetLink: "https://meet.google.com/abc-defg-hij" };
    },
    getEvent: async (id) => { await tick(); return calls.inserted.some((e) => e.id === id) ? { meetLink: "https://meet.google.com/abc-defg-hij" } : null; },
    deleteEvent: async (id) => { await tick(); if (deleteFails) throw new Error("google down"); calls.deleted.push(id); return { deleted: true }; },
    ownerEmail: "owner@example.net",
  };
  return { sql, deps, calls };
}

let n = 0;
const input = (over = {}) => ({ type: "consultation", start: SLOT, name: "Jane Smith", email: "jane@example.com", note: "Hello", source: "page", ...over });
// A request from a distinct IP and email unless told otherwise.
const request = (t, over = {}, keys = {}) => {
  n++;
  return store.requestBooking(t.sql, { cfg: keys.cfg ?? cfg, now: keys.now ?? NOW, input: input(over), ipKey: keys.ipKey ?? `ip${n}`, emailKey: keys.emailKey ?? `em${n}`, deps: t.deps });
};
const row = (t, id) => t.sql.exec("SELECT * FROM bookings WHERE id = ?", id).one();
const sqlCount = (t, q, ...b) => t.sql.exec(q, ...b).one().c;

test("booking IDs are 32 random lowercase hex characters (128 bits), never repeated", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => store.newId()));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test("tokens are 128-bit base64url; the hash is hex SHA-256 of the token", async () => {
  const { token, hash } = await store.newToken();
  assert.match(token, /^[A-Za-z0-9_-]{22}$/, "16 bytes, base64url, unpadded");
  const expect = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
  assert.equal(hash, expect);
  assert.notEqual((await store.newToken()).token, token);
});

test("migrate is idempotent", () => {
  const sql = openSql();
  store.migrate(sql);
  store.migrate(sql);
  const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((r) => r.name);
  assert.deepEqual(tables, ["booking_requests", "bookings", "health", "identities", "quota", "signin_tx", "tokens"]);
  // F-002's columns are added once, nullable, to a bookings table F-001 may already have filled.
  const cols = sql.exec("PRAGMA table_info(bookings)").toArray().filter((c) => ["identity_id", "proof", "actor"].includes(c.name));
  assert.deepEqual(cols.map((c) => [c.name, c.notnull]), [["identity_id", 0], ["proof", 0], ["actor", 0]]);
});

// ---- Caps -----------------------------------------------------------------------------------

const DAY = "2026-10-19";
// A request that got as far as sending its hold email: per-IP and per-email counts, then global.
const reserve = (sql, ipKey, emailKey, day = DAY) => {
  const r = store.reserveBookingQuota(sql, { day, ipKey, emailKey, caps: cfg.caps });
  return r.ok ? store.reserveGlobalQuota(sql, { day, caps: cfg.caps }) : r;
};
const quotaRows = (sql) => sql.exec("SELECT kind, key, n FROM quota ORDER BY kind, key").toArray();

test("caps: 4 requests per IP a day, then refused as ip", () => {
  const { sql } = setup();
  for (let i = 0; i < 4; i++) assert.equal(reserve(sql, "ipA", `e${i}`).ok, true);
  assert.deepEqual(reserve(sql, "ipA", "e9"), { ok: false, which: "ip" });
  assert.equal(reserve(sql, "ipB", "e9").ok, true, "another IP is unaffected");
});

test("caps: 2 requests per email a day, then refused as email", () => {
  const { sql } = setup();
  assert.equal(reserve(sql, "i1", "same").ok, true);
  assert.equal(reserve(sql, "i2", "same").ok, true);
  assert.deepEqual(reserve(sql, "i3", "same"), { ok: false, which: "email" });
});

test("caps: 10 in total a day; the 10th signals the global cap just ran out, exactly once", () => {
  const { sql } = setup();
  const results = Array.from({ length: 10 }, (_, i) => reserve(sql, `i${i}`, `e${i}`));
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(results.map((r) => !!r.globalJustExhausted), [...Array(9).fill(false), true]);
  // Global is checked first: a request that would also break the IP cap is reported as global,
  // and later refusals never signal again.
  for (let i = 0; i < 3; i++) assert.deepEqual(reserve(sql, "i0", `x${i}`), { ok: false, which: "global" });
});

test("caps: a refused request reserves nothing; reservations are never refunded; a new day starts at zero", () => {
  const { sql } = setup();
  for (let i = 0; i < 4; i++) reserve(sql, "ipA", `e${i}`);
  reserve(sql, "ipA", "e9"); // refused for ip: must not use up e9's or the global allowance
  assert.equal(sql.exec("SELECT n FROM quota WHERE day = ? AND kind = 'global'", DAY).one().n, 4);
  assert.equal(sql.exec("SELECT count(*) c FROM quota WHERE key = 'e9'").one().c, 0);
  assert.equal(reserve(sql, "ipA", "e0", "2026-10-20").ok, true);
});

test("caps: per-IP and per-email counts never touch the global count; a closed day refuses them without writing", () => {
  const { sql } = setup();
  assert.deepEqual(store.reserveBookingQuota(sql, { day: DAY, ipKey: "i", emailKey: "e", caps: cfg.caps }), { ok: true });
  assert.deepEqual(quotaRows(sql).map((r) => r.kind), ["email", "ip"]);
  for (let i = 0; i < 10; i++) store.reserveGlobalQuota(sql, { day: DAY, caps: cfg.caps });
  assert.deepEqual(store.reserveGlobalQuota(sql, { day: DAY, caps: cfg.caps }), { ok: false, which: "global" });
  assert.deepEqual(store.reserveBookingQuota(sql, { day: DAY, ipKey: "j", emailKey: "f", caps: cfg.caps }), { ok: false, which: "global" });
  assert.equal(sql.exec("SELECT count(*) c FROM quota WHERE key IN ('j', 'f')").one().c, 0);
});

// ---- Requests make holds --------------------------------------------------------------------

const HOLD_EXPIRES = "2026-10-19T11:00:00.000Z";

for (const source of ["page", "mcp", "webmcp"]) {
  test(`request (${source}): holds the slot for 2 hours, creates no event, emails confirm and decline links`, async () => {
    const t = setup();
    const r = await request(t, { source });
    assert.match(r.booking_id, /^[0-9a-f]{32}$/);
    assert.deepEqual(r, { booking_id: r.booking_id, status: "pending_confirmation", hold_expires: HOLD_EXPIRES });
    assert.equal(t.calls.inserted.length, 0, "no Google event");
    assert.equal(t.calls.freeBusy, 1, "checked live free/busy");
    const b = row(t, r.booking_id);
    assert.equal(b.status, "pending_confirmation");
    assert.equal(b.source, source);
    assert.equal(b.start_utc, SLOT);
    assert.equal(b.end_utc, "2026-10-21T10:30:00.000Z");
    assert.equal(b.hold_expires, HOLD_EXPIRES);
    assert.equal(b.event_id, null);
    const [mail] = t.calls.emails;
    assert.equal(t.calls.emails.length, 1);
    assert.equal(mail.kind, "hold");
    assert.equal(mail.booking.email, "jane@example.com");
    assert.equal(mail.booking.holdExpires, HOLD_EXPIRES);
    assert.ok(mail.links.confirmUrl.startsWith(ACT) && mail.links.declineUrl.startsWith(ACT));
    const tokens = t.sql.exec("SELECT * FROM tokens ORDER BY action").toArray();
    assert.deepEqual(tokens.map((k) => [k.action, k.expires_at, k.used_at]), [["confirm", HOLD_EXPIRES, null], ["decline", HOLD_EXPIRES, null]]);
    // Only hashes are stored: the hash of each emailed token is there, the token itself nowhere.
    const dump = JSON.stringify(t.sql.exec("SELECT * FROM tokens").toArray()) + JSON.stringify(t.sql.exec("SELECT * FROM bookings").toArray());
    for (const url of [mail.links.confirmUrl, mail.links.declineUrl]) {
      assert.ok(!dump.includes(tokenOf(url)));
      const h = await store.hashToken(tokenOf(url));
      assert.ok(tokens.some((k) => k.hash === h));
    }
  });
}

test("status: by booking ID, with no name, email or note", async () => {
  const t = setup();
  const { booking_id } = await request(t);
  assert.deepEqual(store.getStatus(t.sql, booking_id), { status: "pending_confirmation", status_reason: null, start: SLOT, end: "2026-10-21T10:30:00.000Z", type: "consultation" });
  assert.equal(store.getStatus(t.sql, store.newId()), null);
});

test("status: the internal in-between states read as what callers know (confirming → pending_confirmation, cancelling → confirmed)", async () => {
  const t = setup();
  const { booking_id: a } = await request(t);
  t.sql.exec("UPDATE bookings SET status = 'confirming' WHERE id = ?", a);
  assert.equal(store.getStatus(t.sql, a, later(3 * HOUR)).status, "pending_confirmation", "not expired: a confirm is being finished");
  const b = seed(t, { start: "2026-10-22T10:00:00.000Z", status: "cancelling" });
  assert.equal(store.getStatus(t.sql, b, NOW).status, "confirmed");
});

test("agent cancel: a booking being confirmed or cancelled is not cancellable, reported in the caller's terms, and left alone", async () => {
  const t = setup();
  const { booking_id: a } = await request(t);
  t.sql.exec("UPDATE bookings SET status = 'confirming' WHERE id = ?", a);
  assert.deepEqual(await store.cancelByAgent(t.sql, { bookingId: a, now: NOW, deps: t.deps }), { error: "not_cancellable", status: "pending_confirmation" });
  assert.equal(row(t, a).status, "confirming", "not withdrawn under the confirm");
  const b = seed(t, { start: "2026-10-22T10:00:00.000Z", status: "cancelling" });
  assert.deepEqual(await store.cancelByAgent(t.sql, { bookingId: b, now: NOW, deps: t.deps }), { error: "not_cancellable", status: "confirmed" });
});

test("request: a refused cap returns 429-style error before any Google call or email", async () => {
  const t = setup();
  for (let i = 0; i < 4; i++) reserve(t.sql, "busyIp", `x${i}`, DAY);
  const r = await request(t, {}, { ipKey: "busyIp" });
  assert.deepEqual(r, { error: "rate_limited", reason: "ip" });
  assert.equal(t.calls.freeBusy, 0);
  assert.equal(t.calls.emails.length, 0);
});

test("request: the one that uses up the global cap carries the alert signal", async () => {
  const t = setup();
  for (let i = 0; i < 9; i++) reserve(t.sql, `p${i}`, `q${i}`, DAY);
  const r = await request(t);
  assert.equal(r.status, "pending_confirmation");
  assert.equal(r.globalJustExhausted, true);
});

test("request: a slot that is busy in a calendar, or not bookable, is refused and nothing is held", async () => {
  const t = setup({ busy: [{ start: "2026-10-21T10:30:00.000Z", end: "2026-10-21T11:00:00.000Z" }] });
  assert.deepEqual(await request(t), { error: "slot_taken", reason: "busy" });
  assert.deepEqual(await request(t, { start: "2026-10-19T15:00:00.000Z" }), { error: "invalid_slot", reason: "notice" });
  assert.deepEqual(await request(t, { type: "nope" }), { error: "invalid_slot", reason: "unknown_type" });
  assert.equal(t.calls.freeBusy, 1, "invalid slots never reach Google");
  assert.equal(t.sql.exec("SELECT count(*) c FROM bookings").one().c, 0);
  assert.equal(t.calls.emails.length, 0);
});

test("request: free/busy failing returns unavailable and holds nothing", async () => {
  const t = setup();
  t.deps.freeBusy = async () => { await tick(); throw new Error("google down"); };
  assert.deepEqual(await request(t), { error: "unavailable" });
  assert.equal(t.sql.exec("SELECT count(*) c FROM bookings").one().c, 0);
});

test("request: 10 invalid-slot requests write no quota and don't close booking for the day", async () => {
  const t = setup();
  for (let i = 0; i < 10; i++) assert.equal((await request(t, { start: "2026-10-19T15:00:00.000Z" })).error, "invalid_slot");
  assert.deepEqual(quotaRows(t.sql), []);
  assert.equal((await request(t)).status, "pending_confirmation");
});

test("request: hold_pending is refused before any quota is written", async () => {
  const t = setup();
  await request(t, {}, { ipKey: "ipA", emailKey: "a" });
  const before = quotaRows(t.sql);
  assert.deepEqual(await request(t, { start: "2026-10-22T10:00:00.000Z" }, { ipKey: "ipB", emailKey: "a" }), { error: "hold_pending" });
  assert.deepEqual(quotaRows(t.sql), before);
});

test("request: a hold withdrawn by the agent can be re-requested at once", async () => {
  const t = setup();
  const first = await request(t, {}, { ipKey: "ipA", emailKey: "a" });
  assert.deepEqual(await store.cancelByAgent(t.sql, { bookingId: first.booking_id, now: NOW, deps: t.deps }), { status: "cancelled" });
  assert.equal((await request(t, {}, { ipKey: "ipA", emailKey: "a" })).status, "pending_confirmation");
});

test("request: a slot lost at the claim uses the person's IP and email counts but not the global one", async () => {
  const t = setup({ busy: [{ start: SLOT, end: "2026-10-21T11:00:00.000Z" }] });
  assert.equal((await request(t, {}, { ipKey: "ipA", emailKey: "a" })).error, "slot_taken");
  assert.deepEqual(quotaRows(t.sql), [{ kind: "email", key: "a", n: 1 }, { kind: "ip", key: "ipA", n: 1 }]);
});

test("request: the global count is taken just before the hold email, and a day that closed meanwhile holds nothing", async () => {
  const t = setup();
  const fb = t.deps.freeBusy;
  t.deps.freeBusy = async (...a) => {
    for (let i = 0; i < 10; i++) store.reserveGlobalQuota(t.sql, { day: DAY, caps: cfg.caps }); // others used up the day
    return fb(...a);
  };
  assert.deepEqual(await request(t), { error: "rate_limited", reason: "global" });
  assert.equal(t.sql.exec("SELECT count(*) c FROM bookings").one().c, 0);
  assert.equal(t.calls.emails.length, 0);
});

// Captures console output, to check what is (and is not) logged.
async function capturingLogs(fn) {
  const lines = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.join(" "));
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines;
}
const quietly = async (fn) => { let r; await capturingLogs(async () => { r = await fn(); }); return r; };

test("request: if the hold email fails, the hold is released at once and nothing personal is logged", async () => {
  const t = setup({ emailFails: true });
  let r;
  const logs = await capturingLogs(async () => { r = await request(t, {}, { ipKey: "ipA", emailKey: "a" }); });
  assert.deepEqual(r, { error: "email_failed" });
  const b = t.sql.exec("SELECT * FROM bookings").one();
  assert.equal(b.status, "cancelled");
  assert.equal(b.status_reason, "email_failed");
  assert.equal(sqlCount(t, "SELECT count(*) c FROM tokens WHERE used_at IS NULL"), 0, "its links are dead");
  assert.deepEqual(store.liveBookings(t.sql, NOW), [], "the slot is free");
  assert.equal(logs.length, 1);
  assert.ok(!/jane|example|Hello|ipA/i.test(logs.join("\n")));
  // The person isn't stuck behind the one-live-hold rule either.
  const again = setup();
  again.sql = t.sql;
  assert.equal((await request(again, {}, { ipKey: "ipA", emailKey: "a" })).status, "pending_confirmation");
});

test("email health: consecutive failed guest emails are counted (any kind), and one success resets the count", async () => {
  let down = true;
  const t = setup({ emailFails: () => down });
  assert.equal(store.emailFailures(t.sql), 0);
  for (let i = 0; i < 3; i++) await quietly(() => request(t, { start: `2026-10-2${2 + i}T10:00:00.000Z` }));
  assert.equal(store.emailFailures(t.sql), 3);
  down = false;
  assert.equal((await request(t, { start: "2026-10-26T10:00:00.000Z" })).status, "pending_confirmation");
  assert.equal(store.emailFailures(t.sql), 0);
});

// ---- Confirm ---------------------------------------------------------------------------------

const act = (t, token, now = later(HOUR)) => store.act(t.sql, { token, now, cfg, deps: t.deps });
const linkOf = (t, kind, link) => tokenOf(t.calls.emails.filter((e) => e.kind === kind).at(-1).links[link]);
// A hold made through the real path, with its emailed tokens.
async function hold(t, over = {}, keys = {}) {
  const r = await request(t, over, keys);
  return { id: r.booking_id, confirm: linkOf(t, "hold", "confirmUrl"), decline: linkOf(t, "hold", "declineUrl") };
}
// A row written directly, for states the test needs to start from.
function seed(t, { id = store.newId(), start = SLOT, minutes = 30, status = "confirmed", holdExpires = null } = {}) {
  t.sql.exec(
    `INSERT INTO bookings (id, type, start_utc, end_utc, status, source, guest_name, guest_email, ip_key, email_key, hold_expires, created_at, delete_after)
     VALUES (?, 'consultation', ?, ?, ?, 'page', 'Seed', 'seed@example.com', ?, ?, ?, ?, ?)`,
    id, start, later(minutes * 60e3, new Date(start)).toISOString(), status, `ip-${id}`, `em-${id}`, holdExpires, NOW.toISOString(), "2027-01-01T00:00:00.000Z",
  );
  return id;
}

test("confirm: re-checks, creates the event (Meet, guest invited, type in the title), then emails a cancel link", async () => {
  const t = setup();
  const h = await hold(t);
  assert.deepEqual(await act(t, h.confirm), { result: "confirmed" });
  const [ev] = t.calls.inserted;
  assert.equal(t.calls.inserted.length, 1);
  assert.equal(ev.id, h.id, "the booking ID is the event ID");
  assert.equal(ev.summary, "Consultation: Jane Smith");
  assert.equal(ev.start, SLOT);
  assert.equal(ev.end, "2026-10-21T10:30:00.000Z");
  assert.deepEqual(ev.attendees, ["jane@example.com", "owner@example.net"], "plain addresses, the guest and Patrick");
  assert.equal(t.calls.freeBusy, 2, "free/busy checked again at confirm");
  const b = row(t, h.id);
  assert.equal(b.status, "confirmed");
  assert.equal(b.event_id, h.id);
  const booked = t.calls.emails.find((e) => e.kind === "booked");
  assert.ok(booked.links.cancelUrl.startsWith(ACT));
  assert.equal(booked.links.meetLink, "https://meet.google.com/abc-defg-hij");
  const cancel = await store.hashToken(tokenOf(booked.links.cancelUrl));
  assert.deepEqual(t.sql.exec("SELECT action, expires_at, used_at FROM tokens WHERE hash = ?", cancel).one(), { action: "cancel", expires_at: SLOT, used_at: null }, "cancel link expires at the meeting start");
  assert.equal(sqlCount(t, "SELECT count(*) c FROM tokens WHERE action IN ('confirm', 'decline') AND used_at IS NULL"), 0, "confirm and decline links are spent");
});

test("event: Google renders the description as HTML, so the note and type title are escaped there (not in the title)", () => {
  const b = { id: "x", type: "t", start_utc: SLOT, end_utc: SLOT, guest_name: "Jane <b>", guest_email: "jane@example.com", note: `<a href="https://evil.example">click</a> & more` };
  const ev = store.buildEvent(b, { ...cfg, meetingTypes: [{ id: "t", title: "Q&A <1:1>" }] });
  assert.equal(ev.description, "Q&amp;A &lt;1:1&gt;, booked on patrickjv.com.\nNote from the guest:\n&lt;a href=\"https://evil.example\"&gt;click&lt;/a&gt; &amp; more");
  assert.equal(ev.summary, "Q&A <1:1>: Jane <b>", "the title is plain text in Google");
});

test("event: carries the booking time zone, so invites read in London time rather than UTC", () => {
  const b = { id: "x", type: "consultation", start_utc: SLOT, end_utc: SLOT, guest_name: "Jane", guest_email: "jane@example.com" };
  assert.equal(store.buildEvent(b, cfg, "patrick@example.org").timeZone, cfg.timezone);
});

test("confirm: a 409 from Google (event already exists) still counts as created", async () => {
  const t = setup();
  t.deps.insertEvent = async () => { await tick(); return { created: false, meetLink: null }; };
  const h = await hold(t);
  assert.deepEqual(await act(t, h.confirm), { result: "confirmed" });
  assert.equal(row(t, h.id).status, "confirmed");
});

test("confirm: if something else finished the booking meanwhile, the confirm writes nothing more and sends no 'Booked' email", async () => {
  const t = setup();
  const h = await hold(t);
  const insert = t.deps.insertEvent;
  t.deps.insertEvent = async (ev) => {
    const r = await insert(ev);
    t.sql.exec("UPDATE bookings SET status = 'confirmed', event_id = id WHERE id = ?", h.id); // e.g. the alarm's recovery
    return r;
  };
  assert.deepEqual(await act(t, h.confirm), { result: "confirmed" });
  assert.equal(t.calls.emails.filter((e) => e.kind === "booked").length, 0);
  assert.equal(sqlCount(t, "SELECT count(*) c FROM tokens WHERE action = 'cancel'"), 0, "no second cancel link");
});

test("confirm: the slot became busy in a calendar → declined, slot_taken, no event", async () => {
  const t = setup();
  const h = await hold(t);
  t.deps.freeBusy = async () => { await tick(); return { busy: [{ start: SLOT, end: "2026-10-21T11:00:00.000Z" }] }; };
  assert.deepEqual(await act(t, h.confirm), { result: "declined", reason: "slot_taken" });
  assert.equal(t.calls.inserted.length, 0);
  const b = row(t, h.id);
  assert.deepEqual([b.status, b.status_reason], ["declined", "slot_taken"]);
  assert.deepEqual(await act(t, h.confirm), { error: "used" });
});

test("confirm: a 4th meeting on a day → declined, day_full", async () => {
  const t = setup();
  const h = await hold(t);
  for (const hh of ["13", "14", "15"]) seed(t, { start: `2026-10-21T${hh}:00:00.000Z` });
  assert.deepEqual(await act(t, h.confirm), { result: "declined", reason: "day_full" });
  assert.equal(t.calls.inserted.length, 0);
  assert.equal(row(t, h.id).status_reason, "day_full");
});

test("confirm: notice is not re-applied (25 hours' notice when held, 23 when confirmed)", async () => {
  const t = setup();
  const start = later(25 * HOUR).toISOString();
  const h = await hold(t, { start });
  assert.deepEqual(await act(t, h.confirm, later(119 * 60e3)), { result: "confirmed" });
});

test("confirm: if Google fails to create the event, the hold is rolled back and the link still works", async () => {
  const t = setup({ insertFails: true });
  const h = await hold(t);
  assert.deepEqual(await act(t, h.confirm), { error: "unavailable" });
  const b = row(t, h.id);
  assert.equal(b.status, "pending_confirmation");
  assert.equal(b.event_id, null);
  assert.equal(sqlCount(t, "SELECT count(*) c FROM tokens WHERE action = 'confirm' AND used_at IS NULL"), 1);
  t.deps.insertEvent = async (ev) => { await tick(); t.calls.inserted.push(ev); return { created: true, meetLink: null }; };
  assert.deepEqual(await act(t, h.confirm), { result: "confirmed" }, "a retry of the same link succeeds");
});

test("confirm: an insert whose outcome is unknown (timeout, network, 5xx) is not rolled back: the row waits, confirming, for recovery", async () => {
  const t = setup({ insertFails: "unknown" });
  const h = await hold(t);
  assert.deepEqual(await quietly(() => act(t, h.confirm)), { result: "confirming" });
  assert.equal(row(t, h.id).status, "confirming", "still occupying its slot");
  assert.deepEqual(await act(t, h.confirm), { error: "used", confirming: true }, "the link is spent (a retry can't race recovery), and says why");
  assert.equal(t.calls.emails.filter((e) => e.kind === "booked").length, 0);
  // The alarm's recovery finds the event Google made and settles the booking, without a second insert.
  assert.deepEqual(await store.recoverConfirm(t.sql, row(t, h.id), { now: later(HOUR + 5 * 60e3), cfg, deps: t.deps }), { result: "confirmed" });
  assert.equal(t.calls.inserted.length, 1);
  assert.equal(row(t, h.id).status, "confirmed");
  assert.equal(t.calls.emails.filter((e) => e.kind === "booked").length, 1);
});

// A hold whose confirm was cut off before Google made anything.
async function cutOff(t) {
  const h = await hold(t);
  t.sql.exec("UPDATE bookings SET status = 'confirming' WHERE id = ?", h.id);
  return { ...h, row: row(t, h.id) };
}

test("recovery: no event yet → the slot is checked again (free/busy and the rules) before inserting", async () => {
  const t = setup();
  const h = await cutOff(t);
  const fb = t.calls.freeBusy;
  assert.deepEqual(await store.recoverConfirm(t.sql, h.row, { now: later(HOUR), cfg, deps: t.deps }), { result: "confirmed" });
  assert.equal(t.calls.freeBusy, fb + 1);
  assert.equal(t.calls.inserted.length, 1);
});

test("recovery: no event and the slot has since gone busy → declined slot_taken, nothing made, no email", async () => {
  const t = setup();
  const h = await cutOff(t);
  t.deps.freeBusy = async () => { await tick(); return { busy: [{ start: SLOT, end: "2026-10-21T11:00:00.000Z" }] }; };
  assert.deepEqual(await store.recoverConfirm(t.sql, h.row, { now: later(HOUR), cfg, deps: t.deps }), { result: "declined", reason: "slot_taken" });
  assert.equal(t.calls.inserted.length, 0);
  assert.deepEqual([row(t, h.id).status, row(t, h.id).status_reason], ["declined", "slot_taken"]);
  assert.equal(t.calls.emails.length, 1, "only the hold email: nothing new is sent");
});

test("recovery: the live insert lands while recovery checks free/busy → our own event isn't mistaken for a clash", async () => {
  const t = setup();
  const h = await cutOff(t);
  // First look: no event yet. By the time free/busy answers, the slow live insert has made it, so
  // the slot reads busy because of the booking's own meeting.
  let looks = 0;
  t.deps.getEvent = async () => { await tick(); return looks++ === 0 ? null : { meetLink: null }; };
  t.deps.freeBusy = async () => { await tick(); return { busy: [{ start: SLOT, end: "2026-10-21T11:00:00.000Z" }] }; };
  assert.deepEqual(await store.recoverConfirm(t.sql, h.row, { now: later(HOUR), cfg, deps: t.deps }), { result: "confirmed" });
  assert.equal(t.calls.inserted.length, 0, "nothing inserted: the event already exists");
  assert.equal(row(t, h.id).status, "confirmed");
});

test("confirm: if free/busy fails, the hold is rolled back", async () => {
  const t = setup();
  const h = await hold(t);
  t.deps.freeBusy = async () => { await tick(); throw new Error("google down"); };
  assert.deepEqual(await act(t, h.confirm), { error: "unavailable" });
  assert.equal(row(t, h.id).status, "pending_confirmation");
  assert.equal(t.calls.inserted.length, 0);
});

test("confirm: a failed 'booked' email is logged but the booking stands", async () => {
  const t = setup({ emailFails: (kind) => kind === "booked" });
  const h = await hold(t);
  let r;
  const logs = await capturingLogs(async () => { r = await act(t, h.confirm); });
  assert.deepEqual(r, { result: "confirmed" });
  assert.equal(row(t, h.id).status, "confirmed");
  assert.equal(logs.length, 1);
  assert.ok(!/jane|example/i.test(logs[0]));
});

// ---- Links: decline, single use, expiry, peeking -------------------------------------------

test("decline: the hold ends (guest_declined), both links are spent and the slot is free", async () => {
  const t = setup();
  const h = await hold(t);
  assert.deepEqual(await act(t, h.decline), { result: "declined" });
  const b = row(t, h.id);
  assert.deepEqual([b.status, b.status_reason], ["declined", "guest_declined"]);
  assert.deepEqual(await act(t, h.confirm), { error: "used" });
  assert.deepEqual(await act(t, h.decline), { error: "used" });
  assert.deepEqual(store.liveBookings(t.sql, later(HOUR)), []);
  assert.equal(t.calls.inserted.length, 0);
});

test("links expire with the hold: confirm and decline stop working at hold expiry", async () => {
  const t = setup();
  const h = await hold(t);
  const atExpiry = later(2 * HOUR);
  assert.deepEqual(await act(t, h.confirm, atExpiry), { error: "expired" });
  assert.deepEqual(await act(t, h.decline, atExpiry), { error: "expired" });
  assert.equal(t.calls.inserted.length, 0);
});

test("links: an unknown or malformed token does nothing", async () => {
  const t = setup();
  await hold(t);
  for (const token of ["x", "", undefined, (await store.newToken()).token]) assert.deepEqual(await act(t, token), { error: "unknown" });
  assert.equal(row(t, t.sql.exec("SELECT id FROM bookings").one().id).status, "pending_confirmation");
});

test("peek: says what a link would do and its state, without changing anything or showing PII", async () => {
  const t = setup();
  const h = await hold(t);
  const view = { type: "consultation", start: SLOT, end: "2026-10-21T10:30:00.000Z", status: "pending_confirmation" };
  assert.deepEqual(await store.peekToken(t.sql, h.confirm, later(HOUR)), { state: "valid", action: "confirm", booking: view });
  assert.deepEqual(await store.peekToken(t.sql, h.decline, later(HOUR)), { state: "valid", action: "decline", booking: view });
  assert.equal(row(t, h.id).status, "pending_confirmation", "peeking changes nothing");
  assert.equal((await store.peekToken(t.sql, h.confirm, later(2 * HOUR))).state, "expired");
  assert.deepEqual(await store.peekToken(t.sql, "nope", later(HOUR)), { state: "unknown" });
  await act(t, h.confirm);
  const used = await store.peekToken(t.sql, h.confirm, later(HOUR));
  assert.equal(used.state, "used");
  assert.equal(used.booking.status, "confirmed");
});

// ---- Holds expire after 2 hours --------------------------------------------------------------

test("expiry: a hold blocks its slot for 2 hours, then expires (hold_expired) and someone else can take it", async () => {
  const t = setup();
  const h = await hold(t);
  assert.equal(store.liveBookings(t.sql, later(2 * HOUR - 1)).length, 1);
  assert.equal(store.expireHolds(t.sql, later(2 * HOUR - 1)), 0);
  assert.equal(store.liveBookings(t.sql, later(2 * HOUR)).length, 0, "free by the clock even before the alarm runs");
  assert.equal(store.getStatus(t.sql, h.id, later(2 * HOUR)).status, "expired", "status says so before the alarm too");
  assert.equal(store.expireHolds(t.sql, later(2 * HOUR)), 1);
  const b = row(t, h.id);
  assert.deepEqual([b.status, b.status_reason], ["expired", "hold_expired"]);
  assert.deepEqual(store.getStatus(t.sql, h.id), { status: "expired", status_reason: "hold_expired", start: SLOT, end: "2026-10-21T10:30:00.000Z", type: "consultation" });
  assert.equal((await request(t, {}, { now: later(2 * HOUR) })).status, "pending_confirmation");
});

test("alarm: next at the earliest hold expiry, or the next UTC midnight (for pruning) if sooner or no holds", async () => {
  const t = setup();
  const midnight = Date.parse("2026-10-20T00:00:00.000Z");
  assert.equal(store.nextAlarmAt(t.sql, NOW), midnight);
  await hold(t);
  assert.equal(store.nextAlarmAt(t.sql, NOW), Date.parse(HOLD_EXPIRES));
  const lateNight = new Date("2026-10-19T23:00:00.000Z");
  await request(t, { start: "2026-10-22T10:00:00.000Z" }, { now: lateNight }); // expires 01:00 next day
  assert.equal(store.nextAlarmAt(t.sql, later(3 * HOUR)), later(3 * HOUR).getTime(), "an overdue hold: run now");
  store.expireHolds(t.sql, later(3 * HOUR));
  assert.equal(store.nextAlarmAt(t.sql, later(3 * HOUR)), midnight, "midnight comes before the 01:00 expiry");
  assert.equal(store.nextAlarmAt(t.sql, new Date("2026-10-20T00:00:00.000Z")), Date.parse("2026-10-20T01:00:00.000Z"));
});

// ---- Guest cancels ---------------------------------------------------------------------------

async function booked(t, over = {}) {
  const h = await hold(t, over);
  assert.deepEqual(await act(t, h.confirm), { result: "confirmed" });
  return { ...h, cancel: linkOf(t, "booked", "cancelUrl") };
}

test("guest cancel: deletes the event (attendees notified by Google), cancels the booking, frees the slot", async () => {
  const t = setup();
  const b = await booked(t);
  assert.deepEqual(await act(t, b.cancel), { result: "cancelled" });
  assert.deepEqual(t.calls.deleted, [b.id]);
  const r = row(t, b.id);
  assert.deepEqual([r.status, r.status_reason], ["cancelled", "guest_cancelled"]);
  assert.deepEqual(store.liveBookings(t.sql, later(HOUR)), []);
  assert.deepEqual(await act(t, b.cancel), { error: "used" });
});

test("guest cancel: an event already gone from Google (404) still cancels", async () => {
  const t = setup();
  t.deps.deleteEvent = async () => { await tick(); return { deleted: false }; };
  const b = await booked(t);
  assert.deepEqual(await act(t, b.cancel), { result: "cancelled" });
});

test("guest cancel: the link expires at the meeting start", async () => {
  const t = setup();
  const b = await booked(t);
  assert.deepEqual(await act(t, b.cancel, new Date(SLOT)), { error: "expired" });
  assert.equal(row(t, b.id).status, "confirmed");
});

test("guest cancel: if Google fails, the booking stays confirmed and the link still works", async () => {
  const t = setup({ deleteFails: true });
  const b = await booked(t);
  assert.deepEqual(await act(t, b.cancel), { error: "unavailable" });
  assert.equal(row(t, b.id).status, "confirmed");
  t.deps.deleteEvent = async (id) => { await tick(); t.calls.deleted.push(id); return { deleted: true }; };
  assert.deepEqual(await act(t, b.cancel), { result: "cancelled" });
});

test("race: a cancel link clicked 20 times at once deletes the event once", async () => {
  const t = setup();
  const b = await booked(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => act(t, b.cancel)));
  assert.equal(results.filter((r) => r.result === "cancelled").length, 1);
  assert.equal(t.calls.deleted.length, 1);
});

// ---- Agent cancels ---------------------------------------------------------------------------

const agentCancel = (t, bookingId, now = later(HOUR)) => store.cancelByAgent(t.sql, { bookingId, now, deps: t.deps });

test("agent cancel: a pending hold is withdrawn at once (agent_withdrew), freeing the slot and the person's hold", async () => {
  const t = setup();
  const h = await hold(t, {}, { ipKey: "ipA", emailKey: "a" });
  assert.deepEqual(await agentCancel(t, h.id), { status: "cancelled" });
  const b = row(t, h.id);
  assert.deepEqual([b.status, b.status_reason], ["cancelled", "agent_withdrew"]);
  assert.deepEqual(await act(t, h.confirm), { error: "used" });
  assert.deepEqual(store.liveBookings(t.sql, later(HOUR)), []);
  assert.equal((await request(t, {}, { ipKey: "ipA", emailKey: "a", now: later(HOUR) })).status, "pending_confirmation");
});

test("agent cancel: a confirmed booking only gets a confirm-cancellation email; the guest's click cancels it", async () => {
  const t = setup();
  const b = await booked(t);
  assert.deepEqual(await agentCancel(t, b.id), { status: "confirmed", cancellation: "requested" });
  assert.equal(row(t, b.id).status, "confirmed");
  assert.equal(t.calls.deleted.length, 0);
  const mail = t.calls.emails.at(-1);
  assert.equal(mail.kind, "cancel_request");
  const link = tokenOf(mail.links.confirmCancelUrl);
  const tok = t.sql.exec("SELECT action, expires_at FROM tokens WHERE hash = ?", await store.hashToken(link)).one();
  assert.deepEqual(tok, { action: "confirm_cancel", expires_at: SLOT });
  // Asking again while that link is outstanding sends nothing more.
  assert.deepEqual(await agentCancel(t, b.id), { status: "confirmed", cancellation: "requested" });
  assert.equal(t.calls.emails.filter((e) => e.kind === "cancel_request").length, 1);
  assert.deepEqual(await act(t, link), { result: "cancelled" });
  assert.deepEqual(t.calls.deleted, [b.id]);
  assert.equal(row(t, b.id).status_reason, "guest_cancelled");
  assert.deepEqual(await act(t, b.cancel), { error: "used" }, "the original cancel link is spent too");
});

test("agent cancel: if the cancellation email fails, nothing changes and the agent is told", async () => {
  const t = setup({ emailFails: (kind) => kind === "cancel_request" });
  const b = await booked(t);
  assert.deepEqual(await agentCancel(t, b.id), { error: "email_failed" });
  assert.equal(sqlCount(t, "SELECT count(*) c FROM tokens WHERE action = 'confirm_cancel' AND used_at IS NULL"), 0);
  assert.equal(row(t, b.id).status, "confirmed");
});

test("agent cancel: finished bookings are not cancellable; unknown IDs are not found", async () => {
  const t = setup();
  const h = await hold(t);
  await act(t, h.decline);
  assert.deepEqual(await agentCancel(t, h.id), { error: "not_cancellable", status: "declined" });
  const h2 = await hold(t, {}, {});
  assert.deepEqual(await agentCancel(t, h2.id, later(2 * HOUR)), { error: "not_cancellable", status: "expired" }, "a lapsed hold");
  assert.deepEqual(await agentCancel(t, store.newId()), { error: "not_found" });
});

// ---- Retention -------------------------------------------------------------------------------

const DAYS = 24 * HOUR;
const bookingCount = (t) => sqlCount(t, "SELECT count(*) c FROM bookings");

test("retention: a meeting's record and links are deleted 30 days after the meeting, even if cancelled", async () => {
  const t = setup();
  const kept = await booked(t);
  const gone = await booked(t, { start: "2026-10-22T10:00:00.000Z" });
  await act(t, gone.cancel);
  const end = new Date("2026-10-21T10:30:00.000Z");
  assert.equal(row(t, kept.id).delete_after, later(30 * DAYS, end).toISOString());
  store.prune(t.sql, later(30 * DAYS - 1, end));
  assert.equal(bookingCount(t), 2);
  store.prune(t.sql, later(30 * DAYS, end));
  assert.equal(bookingCount(t), 1, "the 21 Oct meeting is gone");
  assert.equal(sqlCount(t, "SELECT count(*) c FROM tokens WHERE booking_id = ?", kept.id), 0, "with its links");
  store.prune(t.sql, later(31 * DAYS, end));
  assert.equal(bookingCount(t), 0, "the cancelled 22 Oct meeting a day later");
  assert.equal(sqlCount(t, "SELECT count(*) c FROM tokens"), 0);
});

test("retention: a hold that never became a meeting is deleted 30 days after it lapsed", async () => {
  const t = setup();
  await hold(t); // left to expire
  const declined = await hold(t, { start: "2026-10-22T10:00:00.000Z" });
  await act(t, declined.decline);
  store.expireHolds(t.sql, later(2 * HOUR));
  store.prune(t.sql, later(30 * DAYS + 2 * HOUR - 1));
  assert.equal(bookingCount(t), 2);
  store.prune(t.sql, later(30 * DAYS + 2 * HOUR));
  assert.equal(bookingCount(t), 0);
  assert.equal(sqlCount(t, "SELECT count(*) c FROM tokens"), 0);
});

test("retention: quota counters older than two days are deleted", () => {
  const t = setup();
  for (const day of ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]) reserve(t.sql, "ip", "em", day);
  store.prune(t.sql, NOW);
  assert.deepEqual(t.sql.exec("SELECT DISTINCT day FROM quota ORDER BY day").toArray().map((r) => r.day), ["2026-10-17", "2026-10-18", "2026-10-19"]);
});

// ---- Races: exactly one winner --------------------------------------------------------------

// Caps high enough that only the slot rules decide.
const OPEN = { ...cfg, caps: { perIpPerDay: 1000, perEmailPerDay: 1000, globalPerDay: 1000, liveHoldsPerEmail: 1 } };
const PARALLEL = 25;

test("race: 25 parallel requests for one slot (and slots overlapping it) produce exactly one hold", async () => {
  const t = setup();
  const starts = ["2026-10-21T10:00:00.000Z", "2026-10-21T10:15:00.000Z", "2026-10-21T09:45:00.000Z"];
  const results = await Promise.all(Array.from({ length: PARALLEL }, (_, i) => request(t, { start: starts[i % 3] }, { cfg: OPEN })));
  const won = results.filter((r) => r.status === "pending_confirmation");
  assert.equal(won.length, 1, `winners: ${won.length}`);
  assert.ok(results.filter((r) => !r.status).every((r) => r.error === "slot_taken"));
  assert.equal(t.sql.exec("SELECT count(*) c FROM bookings").one().c, 1);
  assert.equal(t.calls.emails.length, 1);
});

// ---- One live hold per email (not per IP: people share connections) ------------------------

const hourly = (i) => later(48 * HOUR + i * HOUR).toISOString(); // separate, non-overlapping slots

test("one live hold is keyed on email only: another email from the same IP can still hold a slot", async () => {
  const t = setup();
  assert.equal((await request(t, { start: hourly(1) }, { ipKey: "ipA", emailKey: "a" })).status, "pending_confirmation");
  assert.equal((await request(t, { start: hourly(3) }, { ipKey: "ipA", emailKey: "b" })).status, "pending_confirmation");
});

test("one live hold per email: a second request for the same email while one is pending is hold_pending", async () => {
  const t = setup();
  await request(t, { start: hourly(1) }, { ipKey: "ip1", emailKey: "same" });
  assert.deepEqual(await request(t, { start: hourly(3) }, { ipKey: "ip2", emailKey: "same" }), { error: "hold_pending" });
});

test("one live hold: once the first hold has lapsed, the same person can request again", async () => {
  const t = setup();
  await request(t, { start: hourly(1) }, { ipKey: "ipA", emailKey: "a" });
  const r = await request(t, { start: hourly(3) }, { ipKey: "ipA", emailKey: "a", now: later(2 * HOUR) });
  assert.equal(r.status, "pending_confirmation");
});

test("race: 20 parallel requests from one email for different slots produce exactly one hold", async () => {
  const t = setup();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => request(t, { start: hourly(2 * i) }, { cfg: OPEN, emailKey: "same" })));
  assert.equal(results.filter((r) => r.status === "pending_confirmation").length, 1);
  assert.ok(results.filter((r) => !r.status).every((r) => r.error === "hold_pending"));
  assert.equal(t.calls.emails.length, 1);
});

// A pending hold with a working confirm link, written directly: requests can't make two
// overlapping holds, but a confirm must still be safe if they exist.
async function seedHold(t, start) {
  const id = seed(t, { start, status: "pending_confirmation", holdExpires: later(2 * HOUR).toISOString() });
  const { token, hash } = await store.newToken();
  t.sql.exec("INSERT INTO tokens (hash, booking_id, action, expires_at) VALUES (?, ?, 'confirm', ?)", hash, id, later(2 * HOUR).toISOString());
  return token;
}

test("race: a confirm link clicked 20 times at once confirms once and creates one event", async () => {
  const t = setup();
  const h = await hold(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => act(t, h.confirm)));
  assert.equal(results.filter((r) => r.result === "confirmed").length, 1);
  assert.ok(results.filter((r) => !r.result).every((r) => r.error === "used"));
  assert.equal(t.calls.inserted.length, 1);
  assert.equal(t.calls.emails.filter((e) => e.kind === "booked").length, 1);
});

test("race: 20 overlapping holds confirmed at once produce exactly one meeting", async () => {
  const t = setup();
  const tokens = [];
  for (let i = 0; i < 20; i++) tokens.push(await seedHold(t, later(48 * HOUR + (i % 3) * 15 * 60e3).toISOString()));
  const results = await Promise.all(tokens.map((tk) => act(t, tk)));
  assert.equal(results.filter((r) => r.result === "confirmed").length, 1);
  assert.equal(t.calls.inserted.length, 1);
  assert.equal(sqlCount(t, "SELECT count(*) c FROM bookings WHERE status = 'confirmed'"), 1);
  assert.ok(results.filter((r) => r.result !== "confirmed").every((r) => r.result === "declined" && r.reason === "slot_taken"));
});

test("race: confirms racing for a day's last place produce exactly one meeting; the rest are day_full", async () => {
  const t = setup();
  seed(t, { start: "2026-10-21T10:00:00.000Z" });
  seed(t, { start: "2026-10-21T11:00:00.000Z" });
  const tokens = [];
  for (const hh of ["12", "13", "14", "15", "16"]) tokens.push(await seedHold(t, `2026-10-21T${hh}:00:00.000Z`));
  const results = await Promise.all(tokens.map((tk) => act(t, tk)));
  assert.equal(results.filter((r) => r.result === "confirmed").length, 1);
  assert.equal(results.filter((r) => r.reason === "day_full").length, 4);
  assert.equal(t.calls.inserted.length, 1);
});
