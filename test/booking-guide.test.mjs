// F-002 (US-7): one booking guide, written once in content.json (booking_guide) with its timings
// and meeting types filled in from booking.json, published everywhere an agent might start, and
// readable with no sign-in. Tool descriptions name their step; results and errors say what to do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { build, inlineCode } from "../build.mjs";
import { bookingGuide } from "../lib/booking-guide.mjs";
import { harness } from "../mcp/booking-harness.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const content = JSON.parse(read("content.json"));
const cfg = JSON.parse(read("booking.json"));
const GUIDE = bookingGuide(content, cfg);

test("F-002 guide: one source, content.json booking_guide, with the request time and meeting types filled in from booking.json", () => {
  assert.ok(content.booking_guide, "content.json has booking_guide");
  assert.match(GUIDE, /^# How to book a call with Patrick Vieira\n/);
  assert.match(GUIDE, /Call `list_meeting_types` to see the options \(Consultation, 30 minutes; Recruiter intro, 15 minutes\)\./);
  assert.match(GUIDE, /within 60 minutes/);
  assert.match(GUIDE, /pending_confirmation/);
  assert.match(GUIDE, /https:\/\/patrickjv\.com\/book/);
  assert.doesNotMatch(GUIDE, /\{[a-z_]+\}/, "no placeholder left unfilled");
  // The five public statuses, exactly (Status for callers).
  for (const s of ["pending_confirmation", "confirmed", "declined", "expired", "cancelled"]) assert.match(GUIDE, new RegExp(s));
});

test("F-002 guide: published, identical, in the MCP initialize instructions, get_booking_guide (MCP and WebMCP, read-only), llms.txt, index.md and /book.md", async () => {
  const h = harness();
  const init = await h.mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.ok(init.result.instructions.includes(GUIDE), "initialize instructions");
  const { result } = await h.mcp("tools/list");
  const tool = result.tools.find((t) => t.name === "get_booking_guide");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema, { type: "object", properties: {}, additionalProperties: false });
  const viaMcp = await h.tool("get_booking_guide");
  assert.equal(viaMcp.content[0].text, GUIDE);
  assert.equal(h.storeCalls(), 0, "no sign-in, no store, no new HTTP read endpoint");

  const page = read("public/index.html");
  const script = inlineCode(page, { styles: 1, scripts: 1 }).scripts[0];
  const tools = [];
  vm.runInNewContext(script, {
    document: { modelContext: { registerTool: (t) => { tools.push(t); return Promise.resolve(); } } }, navigator: {}, window: {},
    fetch: async () => ({ status: 200, json: async () => ({ enabled: true, types: [] }) }), encodeURIComponent, JSON, Promise, Object,
  });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const web = tools.find((t) => t.name === "get_booking_guide");
  assert.equal(web.annotations.readOnlyHint, true);
  assert.equal((await web.execute({}, {})).content[0].text, GUIDE, "WebMCP reads the guide embedded in the page");

  assert.ok(read("public/llms.txt").includes(GUIDE), "llms.txt");
  assert.ok(read("public/index.md").includes(GUIDE), "index.md");
  assert.equal(read("public/book.md"), GUIDE, "/book.md is the guide");
  const bookPage = read("public/book.html");
  const agents = bookPage.match(/<section id="for-agents"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(agents, /<h2[^>]*>For AI agents<\/h2>/);
  const pre = agents.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "";
  assert.equal(pre.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"), GUIDE, "the /book page's 'For AI agents' note");
  assert.match(agents, /href="\/book\.md"/);
  assert.match(read("public/_headers"), /\/book\.md\n  Content-Type: text\/markdown; charset=utf-8/);
});

test("F-002 guide: an agent given only https://patrickjv.com/ reaches the full guide in one hop", () => {
  const page = read("public/index.html");
  assert.match(page, /<a href="\/book">/, "the homepage links to /book");
  assert.match(page, /<link rel="alternate" type="text\/markdown" href="\/book\.md"/, "and to /book.md");
  for (const f of ["public/llms.txt", "public/index.md"]) assert.match(read(f), /\(https:\/\/patrickjv\.com\/book\.md\)/, f);
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "site-guide-"));
  for (const f of ["content.json", "cv.json", "booking.json", "build-state.json"]) cpSync(join(ROOT, f), join(dir, f));
  for (const d of ["writing", "public"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
  return dir;
}

test("F-002 guide: the build fails if a published copy drifts from the source", () => {
  const dir = scratch();
  try {
    assert.deepEqual(build({ root: dir, check: true }).errors, []);
    for (const f of ["public/book.md", "public/llms.txt", "public/index.md"]) {
      const p = join(dir, f), was = readFileSync(p, "utf8");
      writeFileSync(p, was.replace("within 60 minutes", "within 90 minutes"));
      const r = build({ root: dir, check: true });
      assert.ok(r.errors.length || r.stale.includes(f), `${f} drift is caught`);
      writeFileSync(p, was);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F-002 guide: change requestMinutes and the meeting types in a copy of booking.json, and the guide, the next_step text and the confirm page follow", async () => {
  const changed = structuredClone(cfg);
  changed.requestMinutes = 45;
  changed.meetingTypes = [{ id: "chat", title: "Chat", minutes: 45, description: "A chat." }];
  const guide = bookingGuide(content, changed);
  assert.match(guide, /within 45 minutes/);
  assert.match(guide, /\(Chat, 45 minutes\)/);
  assert.doesNotMatch(guide, /Consultation/);
  // The build publishes from booking.json too.
  const dir = scratch();
  try {
    const c2 = structuredClone(cfg);
    c2.requestMinutes = 45;
    writeFileSync(join(dir, "booking.json"), JSON.stringify(c2));
    build({ root: dir });
    assert.match(readFileSync(join(dir, "public/book.md"), "utf8"), /within 45 minutes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // next_step and the confirm page take the link's expiry from the configured requestMinutes.
  const h = harness();
  h.cfg.requestMinutes = 45;
  const r = (await h.tool("book_meeting", { type: "consultation", start: "2026-10-21T10:00:00+01:00" })).structuredContent;
  assert.equal(r.link_expires, "2026-10-19T10:45:00+01:00");
  assert.match(r.next_step, /before 2026-10-19T10:45:00\+01:00/);
  const html = await (await h.call(`/book/confirm?t=${h.ticketOf(r.confirm_url)}`)).text();
  assert.match(html, /This link works until Mon 19 Oct 2026, 10:45 BST\./);
});

// ---- Each tool says what to do next (US-7) ---------------------------------------------------------

test("F-002: every booking tool's description names its step in the guide", async () => {
  const { result } = await harness().mcp("tools/list");
  const d = Object.fromEntries(result.tools.map((t) => [t.name, t.description]));
  assert.match(d.get_booking_guide, /booking guide/);
  assert.match(d.list_meeting_types, /Step 1 of the booking guide/);
  assert.match(d.get_availability, /Step 2 of the booking guide/);
  assert.match(d.book_meeting, /Step 4 of the booking guide/);
  assert.match(d.get_booking_status, /Step 6 of the booking guide/);
  assert.match(d.cancel_booking, /Cancelling, in the booking guide/);
  // The status tool lists exactly the five public statuses.
  assert.match(d.get_booking_status, /pending_confirmation, confirmed, declined, expired or cancelled/);
});

test("F-002: get_booking_status has a next_step for each public status", async () => {
  const h = harness();
  const seen = {};
  const status = async (id) => { const s = (await h.tool("get_booking_status", { booking_id: id })).structuredContent; seen[s.status] = s.next_step; };
  const open = (await h.tool("book_meeting", { type: "consultation", start: "2026-10-21T10:00:00+01:00" })).structuredContent;
  await status(open.booking_id);
  const done = (await h.tool("book_meeting", { type: "consultation", start: "2026-10-22T10:00:00+01:00" })).structuredContent;
  await h.signInOn(done.confirm_url);
  await status(done.booking_id);
  const lost = (await h.tool("book_meeting", { type: "consultation", start: "2026-10-23T10:00:00+01:00" })).structuredContent;
  const winner = (await h.tool("book_meeting", { type: "consultation", start: "2026-10-23T10:00:00+01:00" })).structuredContent;
  await h.signInOn(winner.confirm_url, { sub: "other" });
  await status(lost.booking_id);
  const withdrawn = (await h.tool("book_meeting", { type: "consultation", start: "2026-10-26T10:00:00+00:00" })).structuredContent;
  await h.tool("cancel_booking", { booking_id: withdrawn.booking_id });
  await status(withdrawn.booking_id);
  h.clock.now = new Date(h.clock.now.getTime() + 3600e3);
  await status(open.booking_id);
  assert.deepEqual(Object.keys(seen).sort(), ["cancelled", "confirmed", "declined", "expired", "pending_confirmation"]);
  for (const [s, step] of Object.entries(seen)) assert.ok(typeof step === "string" && step.length > 10, s);
  assert.match(seen.pending_confirmation, /don't book again/);
  assert.match(seen.declined, /Start again from get_availability/);
  assert.match(seen.expired, /Start again from get_availability/);
});

test("F-002: every booking error includes a sentence saying what to do", async () => {
  const h = harness();
  const errors = {};
  const grab = (r) => { if (r.structuredContent?.error) errors[r.structuredContent.error] = r.structuredContent.message; };
  grab(await h.tool("book_meeting", { type: "consultation", start: "2026-10-21T10:00:00+01:00", email: "x@example.com" })); // invalid_input
  grab(await h.tool("book_meeting", { type: "consultation", start: "2026-10-21T10:05:00+01:00" })); // invalid_slot
  const ok = (await h.tool("book_meeting", { type: "consultation", start: "2026-10-21T10:00:00+01:00" })).structuredContent;
  await h.signInOn(ok.confirm_url);
  grab(await h.tool("book_meeting", { type: "consultation", start: "2026-10-21T10:00:00+01:00" })); // slot_taken
  grab(await h.tool("get_booking_status", { booking_id: "0".repeat(32) })); // not_found
  h.clock.now = new Date("2026-10-21T09:05:00Z");
  grab(await h.tool("cancel_booking", { booking_id: ok.booking_id })); // not_cancellable
  h.cfg.caps.requestsPerDay = 0;
  grab(await h.tool("book_meeting", { type: "consultation", start: "2026-10-28T10:00:00+00:00" })); // rate_limited
  const off = harness({ enabled: false });
  grab(await off.tool("book_meeting", { type: "consultation", start: "2026-10-21T10:00:00+01:00" })); // booking_disabled
  const down = harness({ fetchOpts: { fail: { freebusy: true } } });
  const save = console.error; console.error = () => {};
  try { grab(await down.tool("book_meeting", { type: "consultation", start: "2026-10-21T10:00:00+01:00" })); } finally { console.error = save; } // unavailable
  assert.deepEqual(Object.keys(errors).sort(), ["booking_disabled", "invalid_input", "invalid_slot", "not_cancellable", "not_found", "rate_limited", "slot_taken", "unavailable"]);
  const ACTION = /\b(Please|please|try again|choose another|Choose|Use |use |Check|Send only|Start again|email hello@)/;
  for (const [code, message] of Object.entries(errors)) assert.match(message, ACTION, `${code}: ${message}`);
});
