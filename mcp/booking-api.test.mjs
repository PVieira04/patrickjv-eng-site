// Booking through the Worker (F-001): the HTTP API on /api/booking*, and the MCP tools, run
// against the real handler and the real BookingStore body (node:sqlite, fake Google and Resend).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { handle, SECURITY_HEADERS } from "./handler.js";
import { openSql } from "./booking-sqlite.mjs";
import { createBookingService } from "./booking-service.js";
import { ENV, fakeFetch, alarmStorage, tokenIn } from "./booking-fakes.mjs";

const cfg = JSON.parse(readFileSync(new URL("../booking.json", import.meta.url), "utf8"));
const content = JSON.parse(readFileSync(new URL("../content.json", import.meta.url), "utf8"));
const SALT = "test-salt-0123456789abcdef0123456789";
const NOW = new Date("2026-10-19T09:00:00.000Z"); // Monday, BST
const SLOT = "2026-10-21T10:00:00+01:00"; // Wed 10:00 London = 09:00 UTC
const ORIGIN = "https://patrickjv.com";

const limiter = (limit) => {
  const n = new Map();
  return { calls: () => [...n.values()].reduce((a, b) => a + b, 0), limit: async ({ key }) => { n.set(key, (n.get(key) || 0) + 1); return { success: n.get(key) <= limit }; } };
};
const quiet = async (fn) => { const saved = [console.error, console.log]; console.error = console.log = () => {}; try { return await fn(); } finally { [console.error, console.log] = saved; } };

export function harness({ enabled = true, fetchOpts = {}, minute = 1e9, burst = 1e9, env: over = {}, storeDown = false } = {}) {
  const f = fakeFetch(fetchOpts);
  const clock = { now: NOW };
  const svc = createBookingService({ sql: openSql(), storage: alarmStorage(), env: { ...ENV, ...over }, cfg, fetch: f.fetch, sleep: async () => {}, now: () => clock.now });
  let storeCalls = 0;
  // Like a Durable Object stub: every method is async and results are structured-cloned.
  const stub = new Proxy(svc, { get: (o, k) => async (...a) => { storeCalls++; if (storeDown) throw new Error("DO unreachable"); return structuredClone(await o[k](...a)); } });
  const alerts = [];
  const rl = { minute: limiter(minute), burst: limiter(burst) };
  const env = {
    INTRO_FROM: "intro@patrickjv.com", INTRO_TO_ADDRESS: "owner@example.com", QUOTA_SALT: SALT,
    RL_MCP: rl.minute, RL_BURST: rl.burst, RL_INTRO: limiter(1e9),
    EMAIL: { send: async () => {} }, QUOTA: { idFromName: () => ({}), get: () => ({}) }, BOOKING: { idFromName: () => ({}), get: () => stub },
    BOOKING_ENABLED: enabled ? "true" : "false", ...ENV, ...over,
  };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete env[k];
  const deps = {
    content, now: () => clock.now, reserve: async () => ({ ok: true }),
    sendEmail: async (from, to, raw) => { alerts.push({ from, to, raw }); },
    booking: () => stub,
  };
  const call = (path, { method = "GET", headers = {}, body, ip = "203.0.113.7" } = {}) => handle(new Request("https://patrickjv.com" + path, {
    method, duplex: "half", headers: Object.fromEntries(Object.entries({ "cf-connecting-ip": ip, ...headers }).filter(([, v]) => v !== undefined)),
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), env, deps);
  const post = (body, opts = {}) => call("/api/booking", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...opts.headers }, body, ip: opts.ip });
  const actPost = (t, { form = true, headers = {} } = {}) => call("/api/booking/act", { method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", origin: ORIGIN, ...headers },
    body: form ? `t=${encodeURIComponent(t)}` : { t } });
  return { call, post, actPost, f, svc, clock, env, alerts, rl, storeCalls: () => storeCalls };
}
const booking = (over = {}) => ({ type: "consultation", start: SLOT, name: "Jane Smith", email: "jane@example.com", note: "About platforms", ...over });
const confirmToken = (h, i = 0) => tokenIn(h.f.mails()[i].text, "confirm");

// ---- HTTP API ----

test("GET /api/booking/types: the meeting types from booking.json", async () => {
  const res = await harness().call("/api/booking/types");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { types: cfg.meetingTypes.map(({ id, title, minutes, description }) => ({ id, title, minutes, description })) });
});

test("GET /api/booking/availability: free slots as ISO 8601 with the London offset", async () => {
  const h = harness({ fetchOpts: { busy: [{ start: "2026-10-21T10:00:00Z", end: "2026-10-21T16:00:00Z" }] } });
  const res = await h.call("/api/booking/availability?type=consultation&from=2026-10-21&to=2026-10-21");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.timezone, "Europe/London");
  assert.deepEqual(body.slots[0], { start: "2026-10-21T10:00:00+01:00", end: "2026-10-21T10:30:00+01:00" });
  assert.ok(body.slots.every((s) => s.start < "2026-10-21T10:45" || s.start >= "2026-10-21T17:15"), "busy time and its buffers are skipped");
  // After the clocks go back, the offset is +00:00.
  const gmt = await (await h.call("/api/booking/availability?type=recruiter-intro&from=2026-10-27&to=2026-10-27")).json();
  assert.equal(gmt.slots[0].start, "2026-10-27T10:00:00+00:00");
});

test("availability: bad type or dates are 400 with a message; Google down is 503 (no guessed slots)", async () => {
  const h = harness();
  for (const q of ["", "?type=nope", "?type=consultation&from=2026-13-01", "?type=consultation&to=21-10-2026", "?type=consultation&from=2026-02-30"]) {
    const res = await h.call(`/api/booking/availability${q}`);
    assert.equal(res.status, 400, q);
    const body = await res.json();
    assert.equal(body.error, "invalid_input", q);
    assert.equal(typeof body.message, "string", q);
  }
  const down = harness({ fetchOpts: { fail: { freebusy: true } } });
  const res = await quiet(() => down.call("/api/booking/availability?type=consultation"));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "unavailable");
});

test("POST /api/booking: 202 with a hold; the guest is emailed as a page booking; nothing in Google yet", async () => {
  const h = harness();
  const res = await h.post(booking());
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.match(body.booking_id, /^[0-9a-f]{32}$/);
  assert.equal(body.status, "pending_confirmation");
  assert.equal(body.hold_expires, "2026-10-19T12:00:00+01:00");
  assert.match(h.f.mails()[0].text, /Someone used this email address on patrickjv\.com/);
  assert.ok(!h.f.calls.some((c) => c.url.includes("/events")), "no event before the guest confirms");
});

test("POST /api/booking: invalid input is 400 with a message, before any quota or Google call", async () => {
  const h = harness();
  for (const bad of [{ ...booking(), extra: 1 }, booking({ type: "nope" }), booking({ start: "2026-10-21 10:00" }), booking({ start: "2026-10-21T10:00:00" }),
    booking({ name: "" }), booking({ name: "x".repeat(101) }), booking({ email: "not-an-email" }), booking({ email: "jané@example.com" }),
    booking({ note: "x".repeat(501) }), booking({ name: 7 }), [booking()], "not json"]) {
    const res = await h.post(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    const body = await res.json();
    assert.equal(body.error, "invalid_input");
    assert.equal(typeof body.message, "string");
  }
  assert.equal(h.storeCalls(), 0);
  assert.equal(h.f.calls.length, 0);
});

test("POST /api/booking: slot taken is 409, a second live hold is 429 hold_pending, the daily cap is 429 'closed for today'", async () => {
  const h = harness();
  assert.equal((await h.post(booking())).status, 202);
  const taken = await h.post(booking({ email: "other@example.com" }), { ip: "198.51.100.1" });
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).error, "slot_taken");
  const pending = await h.post(booking({ start: "2026-10-22T10:00:00+01:00" }));
  assert.equal(pending.status, 429);
  const p = await pending.json();
  assert.equal(p.error, "hold_pending");
  assert.equal(typeof p.message, "string");
  // Use up the global cap from many addresses.
  for (let i = 0; i < 10; i++) await h.post(booking({ email: `g${i}@example.com`, start: "2026-10-23T10:00:00+01:00" }), { ip: `192.0.2.${i}` });
  const closed = await h.post(booking({ email: "late@example.com" }), { ip: "192.0.2.99" });
  assert.equal(closed.status, 429);
  assert.match((await closed.json()).message, /closed for today/i);
});

test("POST /api/booking: a slot inside the notice window is 409 (the page reloads slots), not a malformed request", async () => {
  const res = await harness().post(booking({ start: "2026-10-19T15:00:00+01:00" }));
  assert.equal(res.status, 409);
});

test("POST /api/booking: Origin, method, media type, size and rate limits are checked before the body is read", async () => {
  const h = harness();
  assert.equal((await h.post(booking(), { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await h.post(booking(), { headers: { origin: "" } })).status, 403);
  assert.equal((await h.post(booking(), { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await h.post(booking(), { headers: { "content-length": "999999" } })).status, 413);
  assert.equal((await h.call("/api/booking", { method: "PUT", headers: { "content-type": "application/json" }, body: booking() })).status, 405);
  assert.equal((await h.call("/api/booking")).status, 405);
  assert.equal((await harness({ minute: 0 }).post(booking())).status, 429);
  assert.equal((await harness({ burst: 0 }).post(booking())).status, 429, "writes count against the burst limit");
  assert.equal(h.storeCalls(), 0);
  // A server-side client without Origin is allowed.
  assert.equal((await h.post(booking(), { headers: { origin: undefined } })).status, 202);
});

test("API: unknown paths are 404; every response carries the security headers", async () => {
  const h = harness();
  for (const p of ["/api/booking/nope", "/api/bookingx", "/api/booking/types/x"]) assert.equal((await h.call(p)).status, 404, p);
  for (const res of [await h.call("/api/booking/types"), await h.call("/api/booking/nope"), await h.post("bad")])
    for (const k of ["x-content-type-options", "strict-transport-security", "x-frame-options"]) assert.equal(res.headers.get(k), SECURITY_HEADERS[k], k);
});

test("API: the store being unreachable is 503, logged by subsystem only", async () => {
  const h = harness({ storeDown: true });
  const lines = [];
  const e = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  let res;
  try { res = await h.post(booking()); } finally { console.error = e; }
  assert.equal(res.status, 503);
  assert.ok(lines.some((l) => l.includes('"subsystem":"booking_store"')), lines.join("\n"));
  for (const l of lines) assert.ok(!l.includes("jane") && !l.includes("203.0.113.7"), l);
});

// ---- act links ----

const cspOf = (res) => res.headers.get("content-security-policy");
const styleHash = (html) => "'sha256-" + createHash("sha256").update(html.match(/<style>([\s\S]*?)<\/style>/)[1]).digest("base64") + "'";

test("GET /api/booking/act: a page saying what the link will do, with a POST button; nothing changes", async () => {
  const h = harness();
  const { booking_id } = await (await h.post(booking())).json();
  const t = confirmToken(h);
  for (let i = 0; i < 3; i++) {
    const res = await h.call(`/api/booking/act?t=${t}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8$/);
    const html = await res.text();
    assert.match(html, /<form method="post" action="\/api\/booking\/act">/);
    assert.match(html, new RegExp(`<input type="hidden" name="t" value="${t}">`));
    assert.match(html, /<button[^>]*>Confirm booking<\/button>/);
    assert.match(html, /Consultation/);
    assert.match(html, /Wed 21 Oct 2026, 10:00–10:30 BST \(09:00–09:30 UTC\)/);
    assert.ok(!html.includes("Jane") && !html.includes("jane@"), "no guest details on a link page");
    assert.ok(!/<script/i.test(html), "works without JavaScript");
  }
  assert.equal(h.svc.status(booking_id).status, "pending_confirmation");
});

test("act pages: tight CSP (form posts to self, inline style by hash, fonts from self), no-store, same-origin referrer", async () => {
  const h = harness();
  await h.post(booking());
  const res = await h.call(`/api/booking/act?t=${confirmToken(h)}`);
  const html = await res.text();
  const csp = cspOf(res);
  assert.equal(csp, `default-src 'none'; style-src ${styleHash(html)}; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
  assert.equal(res.headers.get("cache-control"), "no-store");
  // same-origin, so the form's POST carries Origin: https://patrickjv.com (no-referrer would send "null").
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(html, /<meta name="robots" content="noindex">/);
});

test("GET act: unknown or used links are 404, expired links are 410, and the page says so", async () => {
  const h = harness();
  await h.post(booking());
  const t = confirmToken(h);
  const unknown = await h.call("/api/booking/act?t=nope");
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /isn't valid/);
  assert.equal((await h.call("/api/booking/act")).status, 404);
  assert.equal((await h.call(`/api/booking/act?t=${"x".repeat(500)}`)).status, 404);
  h.clock.now = new Date(NOW.getTime() + 3 * 3600e3);
  const expired = await h.call(`/api/booking/act?t=${t}`);
  assert.equal(expired.status, 410);
  assert.match(await expired.text(), /expired/);
});

test("POST act: confirm books it (form or JSON); the link then reads 'already been used'", async () => {
  const h = harness();
  const { booking_id } = await (await h.post(booking())).json();
  const t = confirmToken(h);
  const res = await h.actPost(t);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Booked/);
  assert.equal(h.svc.status(booking_id).status, "confirmed");
  const again = await h.actPost(t);
  assert.equal(again.status, 404);
  assert.match(await again.text(), /already been used/);
  // JSON {t} works too: cancel through the link in the "Booked" email.
  const cancel = tokenIn(h.f.mails()[1].text);
  const c = await h.actPost(cancel, { form: false });
  assert.equal(c.status, 200);
  assert.match(await c.text(), /Cancelled/);
  assert.equal(h.svc.status(booking_id).status, "cancelled");
});

test("POST act: decline; a taken slot is 409 'That slot was taken'; Google down is 503 and the link still works later", async () => {
  const d = harness();
  await d.post(booking());
  const dr = await d.actPost(tokenIn(d.f.mails()[0].text, "decline"));
  assert.equal(dr.status, 200);
  assert.match(await dr.text(), /Declined/);

  const taken = harness();
  await taken.post(booking());
  taken.f.opts.busy = [{ start: "2026-10-21T09:00:00Z", end: "2026-10-21T10:00:00Z" }];
  const tr = await taken.actPost(confirmToken(taken));
  assert.equal(tr.status, 409);
  const page = await tr.text();
  assert.match(page, /That slot was taken/);
  assert.match(page, /href="\/book"/);

  const down = harness({ fetchOpts: { fail: { insert: true } } });
  const { booking_id } = await (await down.post(booking())).json();
  const t = confirmToken(down);
  const r = await quiet(() => down.actPost(t));
  assert.equal(r.status, 503);
  delete down.f.opts.fail;
  assert.equal((await down.actPost(t)).status, 200, "the same link works once Google is back");
  assert.equal(down.svc.status(booking_id).status, "confirmed");
});

test("POST act: Origin from another site is 403; method, media type and size are checked; GET never acts", async () => {
  const h = harness();
  const { booking_id } = await (await h.post(booking())).json();
  const t = confirmToken(h);
  assert.equal((await h.actPost(t, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await h.actPost(t, { headers: { origin: "null" } })).status, 403);
  assert.equal((await h.call("/api/booking/act", { method: "POST", headers: { "content-type": "text/plain", origin: ORIGIN }, body: `t=${t}` })).status, 415);
  assert.equal((await h.call("/api/booking/act", { method: "DELETE" })).status, 405);
  assert.equal((await h.actPost(t, { headers: { "content-length": "999999" } })).status, 413);
  assert.equal(h.svc.status(booking_id).status, "pending_confirmation");
});

test("act pages escape everything they show", async () => {
  const h = harness();
  const res = await h.call(`/api/booking/act?t=${encodeURIComponent('"><script>alert(1)</script>')}`);
  const html = await res.text();
  assert.ok(!html.includes("<script>alert"), html);
});
