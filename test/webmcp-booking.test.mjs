// The page's WebMCP booking tools, run in a VM whose fetch goes to the real Worker handler (with
// the real BookingStore body on node:sqlite and a fake Google/Resend): the browser surface and the
// MCP server give the same results for the same calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { inlineCode } from "../build.mjs";
import { harness } from "../mcp/booking-harness.mjs";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = inlineCode(page, { styles: 1, scripts: 1 }).scripts[0];
const SLOT = "2026-10-21T10:00:00+01:00";
const READ_AND_INTRO = ["get_profile", "list_work", "list_skills", "list_faq", "request_intro"];
const BOOKING_TOOLS = ["list_meeting_types", "get_availability", "book_meeting", "get_booking_status", "cancel_booking"];

// Lets the page's same-origin GET /api/booking/types (and so booking registration) finish.
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// `respond` answers every request except the page's own GET /api/booking/types, which always
// reaches the handler. `mc` replaces document.modelContext's methods.
async function runPage(h, { respond, mc } = {}) {
  const tools = [], requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (respond && url !== "/api/booking/types") return respond(url, init);
    // Same-origin: the browser sends Origin on POST.
    const headers = { ...(init.headers || {}), ...(init.method === "POST" ? { origin: "https://patrickjv.com" } : {}) };
    return h.call(url, { method: init.method || "GET", headers, body: init.body });
  };
  vm.runInNewContext(script, {
    document: { modelContext: mc ?? { registerTool: (t) => { tools.push(t); return Promise.resolve(); } } },
    navigator: {}, window: { confirm: () => true }, fetch, encodeURIComponent, JSON, Promise, Object,
  });
  const before = tools.map((t) => t.name);
  await settle();
  return { byName: Object.fromEntries(tools.map((t) => [t.name, t])), names: tools.map((t) => t.name), before, requests };
}
const data = (r) => JSON.parse(r.content[0].text);

test("WebMCP: read tools register at once; booking tools only after GET /api/booking/types reports enabled", async () => {
  const on = await runPage(harness());
  assert.deepEqual(on.before, READ_AND_INTRO, "nothing about booking is registered before the API answers");
  assert.deepEqual(on.names, [...READ_AND_INTRO, ...BOOKING_TOOLS]);
  assert.deepEqual(on.requests.map((r) => [r.url, r.init.method]), [["/api/booking/types", undefined]], "one same-origin GET");

  for (const value of ["false", undefined]) {
    const off = await runPage(harness({ env: { BOOKING_ENABLED: value } }));
    assert.deepEqual(off.names, READ_AND_INTRO, String(value));
  }
});

test("WebMCP: booking stays hidden when GET /api/booking/types fails or is unreadable", async () => {
  for (const respond of [
    () => { throw new TypeError("offline"); },
    () => ({ status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
    () => ({ status: 200, json: async () => ({ enabled: "true", types: [] }) }),
  ]) {
    const tools = [];
    vm.runInNewContext(script, {
      document: { modelContext: { registerTool: (t) => { tools.push(t.name); return Promise.resolve(); } } },
      navigator: {}, window: { confirm: () => true }, fetch: async () => respond(), encodeURIComponent, JSON, Promise, Object,
    });
    await settle();
    assert.deepEqual(tools, READ_AND_INTRO);
  }
});

test("WebMCP: older drafts' provideContext gets the read tools, then all ten once booking is open", async () => {
  const provided = [];
  await runPage(harness(), { mc: { provideContext: (c) => { provided.push(Array.from(c.tools, (t) => t.name)); /* an array of this realm, not the VM's */ return Promise.resolve(); } } });
  assert.deepEqual(provided, [READ_AND_INTRO, [...READ_AND_INTRO, ...BOOKING_TOOLS]]);
});

test("WebMCP booking tools call the same-origin booking API and return what the MCP tools return", async () => {
  const h = harness();
  const { byName, requests } = await runPage(h);
  const types = await byName.list_meeting_types.execute({}, {});
  assert.deepEqual(data(types).map((t) => t.id), ["consultation", "recruiter-intro"]);
  const av = await byName.get_availability.execute({ type: "consultation", from: "2026-10-21", to: "2026-10-21" }, {});
  assert.equal(data(av).slots[0].start, SLOT);
  assert.equal(requests.at(-1).url, "/api/booking/availability?type=consultation&from=2026-10-21&to=2026-10-21");

  const booked = await byName.book_meeting.execute({ type: "consultation", start: SLOT, name: "Jane", email: "jane@example.com", source: "page", extra: 1 }, {});
  assert.equal(booked.isError, undefined, JSON.stringify(booked));
  const sent = JSON.parse(requests.at(-1).init.body);
  assert.equal(requests.at(-1).url, "/api/booking");
  assert.deepEqual(sent, { type: "consultation", start: SLOT, name: "Jane", email: "jane@example.com", source: "webmcp" }, "only known fields, source always webmcp");
  assert.match(h.f.mails()[0].text, /An AI agent asked to book/);

  const { booking_id } = data(booked);
  const st = await byName.get_booking_status.execute({ booking_id }, {});
  assert.equal(data(st).status, "pending_confirmation");
  const c = await byName.cancel_booking.execute({ booking_id }, {});
  assert.deepEqual(data(c), { status: "cancelled" });
});

test("WebMCP booking tools: a server error is passed on as the server's message", async () => {
  const h = harness();
  const { byName } = await runPage(h);
  h.env.BOOKING_ENABLED = "false"; // switched off after the page loaded
  const r = await byName.book_meeting.execute({ type: "consultation", start: SLOT, name: "Jane", email: "jane@example.com" }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Booking isn't open yet\./);
  assert.match(r.content[0].text, /booking_disabled/);
});

test("WebMCP book_meeting: no readable answer after sending is reported as uncertain, never 'not booked'", async () => {
  const { byName } = await runPage(harness(), { respond: () => ({ status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } }) });
  const r = await byName.book_meeting.execute({ type: "consultation", start: SLOT, name: "Jane", email: "jane@example.com" }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /may or may not have been held\. Do not retry/);
});
