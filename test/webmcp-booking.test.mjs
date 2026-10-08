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

function runPage(h, { respond } = {}) {
  const tools = [], requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (respond) return respond(url, init);
    // Same-origin: the browser sends Origin on POST.
    const headers = { ...(init.headers || {}), ...(init.method === "POST" ? { origin: "https://patrickjv.com" } : {}) };
    return h.call(url, { method: init.method || "GET", headers, body: init.body });
  };
  vm.runInNewContext(script, {
    document: { modelContext: { registerTool: (t) => { tools.push(t); return Promise.resolve(); } } },
    navigator: {}, window: { confirm: () => true }, fetch, encodeURIComponent, JSON, Promise, Object,
  });
  return { byName: Object.fromEntries(tools.map((t) => [t.name, t])), requests };
}
const data = (r) => JSON.parse(r.content[0].text);

test("WebMCP booking tools call the same-origin booking API and return what the MCP tools return", async () => {
  const h = harness();
  const { byName, requests } = runPage(h);
  const types = await byName.list_meeting_types.execute({}, {});
  assert.deepEqual(data(types).map((t) => t.id), ["consultation", "recruiter-intro"]);
  const av = await byName.get_availability.execute({ type: "consultation", from: "2026-10-21", to: "2026-10-21" }, {});
  assert.equal(data(av).slots[0].start, SLOT);
  assert.equal(requests[1].url, "/api/booking/availability?type=consultation&from=2026-10-21&to=2026-10-21");

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
  const h = harness({ enabled: false });
  const { byName } = runPage(h);
  const r = await byName.book_meeting.execute({ type: "consultation", start: SLOT, name: "Jane", email: "jane@example.com" }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Booking isn't open yet\./);
  assert.match(r.content[0].text, /booking_disabled/);
});

test("WebMCP book_meeting: no readable answer after sending is reported as uncertain, never 'not booked'", async () => {
  const { byName } = runPage(harness(), { respond: () => ({ status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } }) });
  const r = await byName.book_meeting.execute({ type: "consultation", start: SLOT, name: "Jane", email: "jane@example.com" }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /may or may not have been held\. Do not retry/);
});
