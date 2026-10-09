// Booking through the Worker (F-001): the HTTP API on /api/booking*, and the MCP tools, run
// against the real handler and the real BookingStore body (node:sqlite, fake Google and Resend).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SECURITY_HEADERS, BOOKING_SECRETS, SIGNIN_SECRETS } from "./handler.js";
import { tokenIn } from "./booking-fakes.mjs";
import { harness, quiet, NOW, ORIGIN } from "./booking-harness.mjs";

const cfg = JSON.parse(readFileSync(new URL("../booking.json", import.meta.url), "utf8"));
const SLOT = "2026-10-21T10:00:00+01:00"; // Wed 10:00 London = 09:00 UTC

const booking = (over = {}) => ({ type: "consultation", start: SLOT, name: "Jane Smith", email: "jane@example.com", note: "About platforms", ...over });
// Separate free slots (GMT weeks, 10:00 to 16:00), for using up the global cap with real holds.
const freeSlot = (i) => `2026-10-${26 + Math.floor(i / 7)}T${10 + (i % 7)}:00:00+00:00`;
const confirmToken = (h, i = 0) => tokenIn(h.f.mails()[i].text, "confirm");

// ---- HTTP API ----

test("GET /api/booking/types: whether booking is open, and the meeting types from booking.json", async () => {
  const types = cfg.meetingTypes.map(({ id, title, minutes, description }) => ({ id, title, minutes, description }));
  const res = await harness().call("/api/booking/types");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { enabled: true, types });
  // The page and the WebMCP script read `enabled` to stay hidden until launch.
  for (const value of ["false", undefined, "TRUE"]) {
    assert.deepEqual(await (await harness({ env: { BOOKING_ENABLED: value } }).call("/api/booking/types")).json(), { enabled: false, types }, String(value));
  }
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
  // Use up the global cap with holds from many addresses (only a hold email counts towards it).
  for (let i = 0; i < 10; i++) await h.post(booking({ email: `g${i}@example.com`, start: freeSlot(i) }), { ip: `192.0.2.${i}` });
  const closed = await h.post(booking({ email: "late@example.com", start: freeSlot(10) }), { ip: "192.0.2.99" });
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
  assert.match(await unknown.text(), /<h1>This link isn(&#39;|')t valid<\/h1>/);
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

test("act: a confirm Google may have half-done says it's being finished (POST, a second POST and GET), not 'already used'", async () => {
  const h = harness({ fetchOpts: { fail: { afterCreate: true } } });
  await h.post(booking());
  const t = confirmToken(h);
  for (const res of [await quiet(() => h.actPost(t)), await h.actPost(t), await h.call(`/api/booking/act?t=${t}`)]) {
    assert.equal(res.status, 202);
    const page = await res.text();
    assert.match(page, /being finished/);
    assert.match(page, /check your email/i);
    assert.doesNotMatch(page, /already been used|<form/);
  }
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

const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const mcp = async (h, msg) => (await (await h.call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: msg })).json());
const tool = (h, name, args = {}) => mcp(h, rpc("tools/call", { name, arguments: args })).then((r) => r.result);

// ---- HTTP: status and cancel (used by the page's WebMCP tools) ----

test("GET /api/booking/status and POST /api/booking/cancel: the same results as the MCP tools", async () => {
  const h = harness();
  const { booking_id } = await (await h.post(booking())).json();
  const s = await h.call(`/api/booking/status?booking_id=${booking_id}`);
  assert.equal(s.status, 200);
  // F-002 adds next_step (US-7).
  const { next_step, ...view } = await s.json();
  assert.deepEqual(view, { status: "pending_confirmation", start: SLOT, end: "2026-10-21T10:30:00+01:00", type: "consultation" });
  assert.match(next_step, /Wait and check again/);
  assert.equal((await h.call("/api/booking/status?booking_id=nope")).status, 400);
  assert.equal((await h.call(`/api/booking/status?booking_id=${"0".repeat(32)}`)).status, 404);
  const c = await h.call("/api/booking/cancel", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: { booking_id } });
  assert.equal(c.status, 200);
  assert.equal((await c.json()).status, "cancelled");
  assert.equal((await h.call("/api/booking/cancel")).status, 405);
});

test("POST /api/booking: optional source is exactly \"page\" (the default) or \"webmcp\"; anything else is 400", async () => {
  const h = harness();
  assert.equal((await h.post(booking({ source: "webmcp" }))).status, 202);
  assert.match(h.f.mails()[0].text, /An AI agent asked to book/);
  const page = harness();
  assert.equal((await page.post(booking({ source: "page" }))).status, 202);
  assert.match(page.f.mails()[0].text, /Someone used this email address on patrickjv\.com/);
  for (const source of ["mcp", "PAGE", "", "agent"]) {
    const res = await harness().post(booking({ source }));
    assert.equal(res.status, 400, source);
    assert.equal((await res.json()).error, "invalid_input", source);
  }
});

test("book_meeting over MCP is always source mcp: a source argument is refused, nothing is held", async () => {
  const h = harness();
  const r = await mcp(h, rpc("tools/call", { name: "book_meeting", arguments: { type: "consultation", start: SLOT, source: "page" } }));
  assert.equal(r.result.isError, true);
  assert.equal(h.storeCalls(), 0);
  // F-002: MCP's book_meeting makes a sign-in request (stored as mcp; see signin-flow.test.mjs).
  assert.equal((await tool(h, "book_meeting", { type: "consultation", start: SLOT })).structuredContent.status, "pending_confirmation");
  assert.deepEqual(h.rows("SELECT source FROM booking_requests"), [{ source: "mcp" }]);
});

// ---- MCP tools ----

const BOOKING_TOOLS = ["list_meeting_types", "get_availability", "book_meeting", "get_booking_status", "cancel_booking"];

test("tools/list: the five booking tools, with schemas, limits, annotations and icons", async () => {
  const { result } = await mcp(harness(), rpc("tools/list"));
  const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
  assert.deepEqual(result.tools.map((t) => t.name).slice(-5), BOOKING_TOOLS);
  for (const n of ["list_meeting_types", "get_availability", "get_booking_status"]) assert.equal(byName[n].annotations.readOnlyHint, true, n);
  assert.deepEqual(byName.book_meeting.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(byName.cancel_booking.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  for (const n of BOOKING_TOOLS) {
    assert.equal(byName[n].icons[0].src, "https://patrickjv.com/icon-192.png", n);
    assert.equal(byName[n].inputSchema.additionalProperties, false, n);
    assert.ok(byName[n].title && byName[n].description, n);
  }
  const b = byName.book_meeting;
  // F-002 (D5): no name or email; they come from the person's sign-in.
  assert.deepEqual(b.inputSchema.required, ["type", "start"]);
  assert.deepEqual(b.inputSchema.properties.type.enum, ["consultation", "recruiter-intro"]);
  assert.equal(b.inputSchema.properties.note.maxLength, 500);
  assert.match(b.description, /Only use this when the person has asked/);
  assert.match(b.description, /Do not retry on error/);
  assert.match(b.description, /Privacy:/);
  assert.match(byName.cancel_booking.description, /Do not retry on error/);
  assert.equal(byName.get_booking_status.inputSchema.properties.booking_id.pattern, "^[0-9a-f]{32}$");
  assert.equal(byName.get_availability.inputSchema.properties.from.pattern, "^\\d{4}-\\d{2}-\\d{2}$");
});

test("list_meeting_types and get_availability over MCP", async () => {
  const h = harness();
  const types = await tool(h, "list_meeting_types");
  assert.deepEqual(types.structuredContent, { items: cfg.meetingTypes.map(({ id, title, minutes, description }) => ({ id, title, minutes, description })) });
  const av = await tool(h, "get_availability", { type: "consultation", from: "2026-10-21", to: "2026-10-21" });
  assert.equal(av.structuredContent.timezone, "Europe/London");
  assert.deepEqual(av.structuredContent.slots[0], { start: SLOT, end: "2026-10-21T10:30:00+01:00" });
  assert.deepEqual(JSON.parse(av.content[0].text), av.structuredContent);
});

test("get_booking_status over MCP shows an email-form hold without guest details", async () => {
  const h = harness();
  // F-002: holds come only from the email form now (MCP's book_meeting makes sign-in requests).
  const { booking_id } = await (await h.post(booking())).json();
  const s = await tool(h, "get_booking_status", { booking_id });
  const { next_step, ...view } = s.structuredContent;
  assert.deepEqual(view, { status: "pending_confirmation", start: SLOT, end: "2026-10-21T10:30:00+01:00", type: "consultation" });
  assert.ok(next_step);
  assert.ok(!s.content[0].text.includes("jane"));
});

test("cancel_booking: withdraws a hold; on a confirmed meeting only emails a confirm-cancellation link", async () => {
  const h = harness();
  // Email-form holds (F-002 moved MCP's book_meeting to sign-in requests); results carry next_step.
  const { booking_id } = await (await h.post(booking())).json();
  assert.equal((await tool(h, "cancel_booking", { booking_id })).structuredContent.status, "cancelled");
  assert.deepEqual((await tool(h, "get_booking_status", { booking_id })).structuredContent.status_reason, "agent_withdrew");

  const { booking_id: id2 } = await (await h.post(booking(), { ip: "198.51.100.2" })).json();
  await h.actPost(tokenIn(h.f.mails().at(-1).text, "confirm"));
  const c = await tool(h, "cancel_booking", { booking_id: id2 });
  const { next_step, ...cancel } = c.structuredContent;
  assert.deepEqual(cancel, { status: "confirmed", cancellation: "requested" });
  assert.match(next_step, /cancellation email was sent/);
  assert.match(h.f.mails().at(-1).subject, /^Confirm cancellation/);
  assert.equal((await tool(h, "get_booking_status", { booking_id: id2 })).structuredContent.status, "confirmed");
});

test("booking tools: failures are tool errors naming the error and asking agents not to retry; bad arguments reach nothing", async () => {
  const h = harness();
  const taken = await tool(h, "book_meeting", { type: "consultation", start: "2026-10-19T15:00:00+01:00" });
  assert.equal(taken.isError, true);
  assert.equal(taken.structuredContent.error, "invalid_slot", "inside the notice window");
  assert.match(taken.content[0].text, /Do not retry/);
  const missing = await tool(h, "get_booking_status", { booking_id: "f".repeat(32) });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error, "not_found");
  const fresh = harness();
  for (const [name, args] of [["book_meeting", { type: "consultation" }], ["get_availability", {}], ["get_booking_status", { booking_id: 1 }], ["cancel_booking", { booking_id: "x" }], ["list_meeting_types", { x: 1 }]]) {
    const r = await mcp(fresh, rpc("tools/call", { name, arguments: args }));
    assert.ok(r.error?.code === -32602 || r.result?.isError === true, `${name}: ${JSON.stringify(r)}`);
  }
  assert.equal(fresh.storeCalls(), 0);
});

// ---- Kill switch: BOOKING_ENABLED ----

test("BOOKING_ENABLED not \"true\": every write path is 503 booking_disabled; types and status still work", async () => {
  for (const value of ["false", undefined, "TRUE", "1"]) {
    const h = harness({ env: { BOOKING_ENABLED: value } });
    const res = await h.post(booking());
    assert.equal(res.status, 503, String(value));
    assert.deepEqual(await res.json(), { error: "booking_disabled", message: "Booking isn't open yet. Please try again later, or email hello@patrickjv.com." }); // F-002: says what to do
    const viaTool = await tool(h, "book_meeting", { type: "consultation", start: SLOT, name: "Jane", email: "jane@example.com" });
    assert.equal(viaTool.isError, true);
    assert.equal(viaTool.structuredContent.error, "booking_disabled");
    assert.equal((await tool(h, "cancel_booking", { booking_id: "a".repeat(32) })).structuredContent.error, "booking_disabled");
    const cancel = await h.call("/api/booking/cancel", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: { booking_id: "a".repeat(32) } });
    assert.equal(cancel.status, 503);
    assert.equal((await h.call("/api/booking/types")).status, 200);
    assert.equal(h.f.mails().length, 0);
  }
});

// F-002 (F-001 US-8 as F-002 restates it): with booking off, new requests and cancel links are
// refused, but the read tools still work, so an agent holding a link can still check its status.
test("BOOKING_ENABLED not \"true\": MCP lists and answers the read tools; book_meeting and cancel_booking say booking isn't open; instructions don't mention booking", async () => {
  for (const value of ["false", undefined, "TRUE", "1"]) {
    const h = harness({ env: { BOOKING_ENABLED: value } });
    const { result } = await mcp(h, rpc("tools/list"));
    assert.deepEqual(result.tools.map((t) => t.name), ["get_profile", "list_work", "list_skills", "list_faq", "request_intro", "get_booking_guide", "list_meeting_types", "get_availability", "get_booking_status"], String(value));
    const init = await mcp(h, rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    assert.doesNotMatch(init.result.instructions, /book|meeting/i, String(value));
    assert.match(init.result.instructions, /request_intro/);
    for (const [name, args] of [["book_meeting", { type: "consultation", start: SLOT }], ["cancel_booking", { booking_id: "a".repeat(32) }]]) {
      const r = await tool(h, name, args);
      assert.equal(r.isError, true, name);
      assert.equal(r.structuredContent.error, "booking_disabled", name);
      assert.match(r.content[0].text, /^Booking isn't open yet\./, name);
    }
    assert.equal(h.storeCalls(), 0, "no write reaches the BookingStore");
    for (const [name, args] of [["get_booking_guide", {}], ["list_meeting_types", {}], ["get_availability", { type: "consultation" }]]) {
      assert.equal((await tool(h, name, args)).isError, undefined, name);
    }
    assert.equal((await tool(h, "get_booking_status", { booking_id: "a".repeat(32) })).structuredContent.error, "not_found", "status is looked up, not refused");
  }
  // Switched on, all eleven are listed (F-002 adds get_booking_guide).
  assert.equal((await mcp(harness(), rpc("tools/list"))).result.tools.length, 11);
});

test("kill switch: availability works while configured, and is 503 when not configured", async () => {
  const off = harness({ enabled: false });
  assert.equal((await off.call("/api/booking/availability?type=consultation")).status, 200);
  const unconfigured = harness({ enabled: false, env: { GOOGLE_REFRESH_TOKEN: undefined } });
  const res = await unconfigured.call("/api/booking/availability?type=consultation");
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "unavailable");
  const onButUnconfigured = harness({ env: { GOOGLE_REFRESH_TOKEN: undefined } });
  assert.equal((await tool(onButUnconfigured, "get_availability", { type: "consultation" })).structuredContent.error, "unavailable");
});

test("kill switch: links for holds made before it was turned off still work", async () => {
  const h = harness();
  const { booking_id } = await (await h.post(booking())).json();
  h.env.BOOKING_ENABLED = "false";
  assert.equal((await h.call(`/api/booking/act?t=${confirmToken(h)}`)).status, 200);
  assert.equal((await h.actPost(confirmToken(h))).status, 200);
  assert.equal(h.svc.status(booking_id).status, "confirmed");
  assert.equal((await h.post(booking({ email: "new@example.com", start: "2026-10-22T10:00:00+01:00" }), { ip: "198.51.100.9" })).status, 503);
});

// ---- Health ----

const healthOf = async (h) => (await mcp(h, rpc("patrickjv/health"))).result;

test("patrickjv/health: bookingEnabled is the flag; bookingReady means secrets set, Google token refresh works and the store answers", async () => {
  const on = await healthOf(harness());
  assert.equal(on.bookingEnabled, true);
  assert.equal(on.bookingReady, true);
  assert.equal(on.introReady, true);
  // Readiness is independent of the flag, so it can be checked before launch.
  assert.deepEqual([(await healthOf(harness({ enabled: false }))).bookingEnabled, (await healthOf(harness({ enabled: false }))).bookingReady], [false, true]);
  assert.equal((await healthOf(harness({ fetchOpts: { fail: { token: true } } }))).bookingReady, false, "revoked refresh token");
  assert.equal((await quiet(() => healthOf(harness({ storeDown: true })))).bookingReady, false, "Durable Object unreachable");
  for (const k of ["QUOTA_SALT", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "RESEND_API_KEY", "BOOKING_OWNER_EMAIL", "BOOKING_FROM", "CAL_PERSONAL_MAIN", "BOOKING"]) {
    const h = harness({ env: { [k]: undefined } });
    const r = await healthOf(h);
    assert.equal(r.bookingReady, false, k);
    assert.equal(h.storeCalls(), 0, `${k}: not configured, so no Google or store call`);
  }
});

test("patrickjv/health: bookingReady is false once 3 guest emails in a row have failed", async () => {
  const h = harness({ fetchOpts: { fail: { mail: true } } });
  for (let i = 0; i < 3; i++) await quiet(() => h.post(booking({ email: `m${i}@example.com`, start: freeSlot(i) }), { ip: `192.0.2.${i}` }));
  assert.equal((await healthOf(h)).bookingReady, false);
});

test("patrickjv/health: never reveals booking secrets, calendar IDs or the owner's address", async () => {
  const h = harness();
  const text = await (await h.call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: rpc("patrickjv/health") })).text();
  for (const k of ["GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "RESEND_API_KEY", "BOOKING_OWNER_EMAIL", "CAL_PERSONAL_MAIN"]) assert.ok(!text.includes(h.env[k]), k);
  assert.equal(h.f.mails().length, 0);
});

// ---- Global cap alert ----

const decodeWords = (h) => new TextDecoder().decode(new Uint8Array(
  [...h.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)].flatMap((m) => [...atob(m[1])].map((c) => c.charCodeAt(0)))));
const mimeBody = (raw) => new TextDecoder().decode(Uint8Array.from(atob(raw.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, "")), (c) => c.charCodeAt(0)));
async function exhaust(h) {
  const out = [];
  for (let i = 0; i < 12; i++) out.push(await h.post(booking({ email: `g${i}@example.com`, start: freeSlot(i) }), { ip: `192.0.2.${i}` }));
  return out;
}

test("global cap: Patrick gets one alert email that day, to INTRO_TO_ADDRESS through the send_email binding", async () => {
  const h = harness();
  const responses = await exhaust(h);
  assert.equal(responses.at(-1).status, 429);
  assert.equal(h.alerts.length, 1, "exactly one alert, however many requests are refused");
  const { from, to, raw } = h.alerts[0];
  assert.equal(from, "intro@patrickjv.com");
  assert.equal(to, "owner@example.com");
  const head = raw.split("\r\n\r\n")[0].replace(/\r\n /g, " ");
  assert.match(head, /^To: <owner@example\.com>$/m);
  assert.equal(decodeWords(head.match(/^Subject: (.*)$/m)[1]), "patrickjv.com booking closed for today: daily cap reached");
  assert.match(mimeBody(raw), /reached the daily cap on 2026-10-19/);
  assert.ok(!/g\d+@example\.com/.test(raw + mimeBody(raw)), "no guest address in the alert");
});

test("global cap: a failed alert is logged by subsystem only and doesn't change the answer", async () => {
  const h = harness();
  h.alerts.push = () => { throw new Error("send failed"); };
  const lines = [];
  const e = console.error, l = console.log;
  console.error = console.log = (...a) => lines.push(a.join(" "));
  let responses;
  try { responses = await exhaust(h); } finally { console.error = e; console.log = l; }
  assert.ok(responses.slice(0, 10).every((r) => r.status !== 503), "the request that hit the cap still gets its own answer");
  assert.ok(lines.some((x) => x.includes('"subsystem":"alert_email"')), lines.join("\n"));
  for (const x of lines) assert.ok(!x.includes("@example.com"), x);
});

// ---- mcp/wrangler.jsonc ----

test("mcp/wrangler.jsonc: booking route, BookingStore Durable Object (migration v2), ships dark, secrets documented", () => {
  const text = readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8");
  const w = JSON.parse(text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"));
  assert.deepEqual(w.routes.map((r) => r.pattern), ["patrickjv.com/mcp*", "patrickjv.com/api/booking*", "patrickjv.com/book/confirm*", "patrickjv.com/book/callback*"]); // F-002 adds the last two
  assert.ok(w.durable_objects.bindings.some((b) => b.name === "BOOKING" && b.class_name === "BookingStore"));
  assert.deepEqual(w.migrations, [{ tag: "v1", new_sqlite_classes: ["IntroQuota"] }, { tag: "v2", new_sqlite_classes: ["BookingStore"] }]);
  assert.equal(w.vars.BOOKING_ENABLED, "true", "switched on at launch (8 Oct 2026, docs/06 launch checklist)");
  assert.equal(w.vars.BOOKING_FROM, "Patrick Vieira <hello@patrickjv.com>");
  for (const k of [...BOOKING_SECRETS.filter((k) => k !== "BOOKING_FROM"), ...SIGNIN_SECRETS]) assert.match(text, new RegExp(`wrangler secret put ${k} -c mcp/wrangler\\.jsonc`), k);
  assert.doesNotMatch(text, /@gmail\.com|@googlemail\.com/, "calendar IDs are secrets");
});

// ---- Server metadata ----

// Launch (8 Oct 2026): 1.2.0 mentions booking, published to the Registry right after the deploy
// that sets BOOKING_ENABLED=true, because the monitor checks serverInfo.version against the Registry.
test("server.json: 1.2.0 at launch, mentions booking; description fits the Registry's 100 characters", async () => {
  const s = JSON.parse(readFileSync(new URL("./server.json", import.meta.url), "utf8"));
  assert.equal(s.version, "1.2.0");
  assert.ok(s.description.length <= 100, `${s.description.length}`);
  assert.match(s.description, /book/i);
  const init = await mcp(harness(), rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
  assert.equal(init.result.serverInfo.version, s.version);
  assert.match(init.result.instructions, /book_meeting only when a person has asked/);
});
