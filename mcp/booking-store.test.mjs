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
  caps: { perIpPerDay: 4, perEmailPerDay: 2, globalPerDay: 10, liveHoldsPerKey: 1 },
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
    insertEvent: async (ev) => {
      await tick();
      if (insertFails) throw new Error("google down");
      calls.inserted.push(ev);
      return { created: true, meetLink: "https://meet.google.com/abc-defg-hij" };
    },
    deleteEvent: async (id) => { await tick(); if (deleteFails) throw new Error("google down"); calls.deleted.push(id); return { deleted: true }; },
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
  assert.deepEqual(tables, ["bookings", "quota", "tokens"]);
});

// ---- Caps -----------------------------------------------------------------------------------

const DAY = "2026-10-19";
const reserve = (sql, ipKey, emailKey, day = DAY) => store.reserveQuota(sql, { day, ipKey, emailKey, caps: cfg.caps });

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

// Captures console output, to check what is (and is not) logged.
async function capturingLogs(fn) {
  const lines = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.join(" "));
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines;
}

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
  assert.ok(ev.attendees.some((a) => a.email === "jane@example.com"));
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

test("confirm: a 409 from Google (event already exists) still counts as created", async () => {
  const t = setup();
  t.deps.insertEvent = async () => { await tick(); return { created: false, meetLink: null }; };
  const h = await hold(t);
  assert.deepEqual(await act(t, h.confirm), { result: "confirmed" });
  assert.equal(row(t, h.id).status, "confirmed");
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

// ---- Races: exactly one winner --------------------------------------------------------------

// Caps high enough that only the slot rules decide.
const OPEN = { ...cfg, caps: { perIpPerDay: 1000, perEmailPerDay: 1000, globalPerDay: 1000, liveHoldsPerKey: 1 } };
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

// ---- One live hold per IP and per email -----------------------------------------------------

const hourly = (i) => later(48 * HOUR + i * HOUR).toISOString(); // separate, non-overlapping slots

test("one live hold per IP: a second request from the same IP while one is pending is hold_pending", async () => {
  const t = setup();
  assert.equal((await request(t, { start: hourly(1) }, { ipKey: "ipA", emailKey: "a" })).status, "pending_confirmation");
  const fb = t.calls.freeBusy;
  assert.deepEqual(await request(t, { start: hourly(3) }, { ipKey: "ipA", emailKey: "b" }), { error: "hold_pending" });
  assert.equal(t.calls.freeBusy, fb, "refused before any Google call");
  assert.equal(t.calls.emails.length, 1);
  assert.equal(sqlCount(t, "SELECT count(*) c FROM quota WHERE kind = 'email' AND key = 'b'"), 1, "the refused request still used its quota");
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
