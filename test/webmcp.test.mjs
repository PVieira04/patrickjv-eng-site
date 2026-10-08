// The page's WebMCP script, run in a VM with a stubbed document.modelContext, window.confirm and
// fetch: request_intro shows and sends exactly what the server will use (its normalisation), and an
// unreadable response after sending reports uncertain delivery, never "not sent".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { inlineCode } from "../build.mjs";
import { validateIntro } from "../mcp/handler.js";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = inlineCode(page, { styles: 1, scripts: 1 }).scripts[0];

function runPage({ confirm = true, respond }) {
  const tools = [], prompts = [], requests = [];
  const ctx = {
    document: { modelContext: { registerTool: (t) => { tools.push(t); return Promise.resolve(); } } },
    navigator: {},
    window: { confirm: (text) => { prompts.push(text); return confirm; } },
    fetch: async (url, init) => { requests.push({ url, init, body: JSON.parse(init.body) }); return respond(); },
    JSON, Promise, Object,
  };
  vm.runInNewContext(script, ctx);
  const intro = tools.find((t) => t.name === "request_intro");
  return { tools, prompts, requests, intro };
}

const ok = () => ({ status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Thanks" }] } }) });
const hostile = {
  from_name: "  Jane‮ Smith​\u0007\r\nBcc: x@example.org ",
  from_email: "  jane@example.com ",
  organisation: "Acme⁦ Ltd⁩\u0000",
  reason: " collaboration ",
  agent: "Bot﻿ v2",
  message: "Hello Patrick,\r\nline two\rline three\u0001 and a long enough message.  ",
};

test("WebMCP registers all ten tools, in the MCP server's order", () => {
  const { tools } = runPage({ respond: ok });
  assert.deepEqual(tools.map((t) => t.name), ["get_profile", "list_work", "list_skills", "list_faq", "request_intro",
    "list_meeting_types", "get_availability", "book_meeting", "get_booking_status", "cancel_booking"]);
});

test("request_intro: normalised exactly as the server does, before the confirm dialog; sends what was shown", async () => {
  const { intro, prompts, requests } = runPage({ respond: ok });
  const r = await intro.execute(hostile, {});
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const sent = requests[0].body.params.arguments;
  const { value: server } = validateIntro(hostile);
  // The server's own validation of the raw input yields exactly what the page sent ...
  for (const k of ["from_name", "organisation", "reason", "message", "agent"]) assert.equal(sent[k], server[k], k);
  assert.equal(sent.from_email, hostile.from_email.trim());
  // ... and re-validating what was sent changes nothing.
  assert.deepEqual(validateIntro(sent).value, server);
  // The person was shown the normalised values, not the raw ones.
  const text = prompts[0];
  assert.ok(text.includes(`From: ${server.from_name}\n`), text);
  assert.ok(text.includes(`Organisation: ${server.organisation}\n`), text);
  assert.ok(text.includes(`Agent: ${server.agent}\n`), text);
  assert.ok(text.endsWith(`Message:\n${server.message}`), text);
  assert.doesNotMatch(text, /[‮​⁦⁩﻿\u0000\u0001\u0007\r]/);
});

test("request_intro: declining sends nothing", async () => {
  const { intro, requests } = runPage({ confirm: false, respond: ok });
  const r = await intro.execute(hostile, {});
  assert.equal(r.isError, true);
  assert.equal(requests.length, 0);
});

test("request_intro: an unreadable or unexpected response after sending is uncertain delivery, never 'not sent'", async () => {
  for (const [respond, why] of [
    [() => ({ status: 200, json: async () => { throw new TypeError("body stream aborted"); } }), /^No readable response \(HTTP 200\)/],
    [() => ({ status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } }), /^No readable response \(HTTP 502\)/],
    [() => ({ status: 200, json: async () => ({}) }), /^Unexpected response \(HTTP 200\)/],
  ]) {
    const { intro, requests } = runPage({ respond });
    const r = await intro.execute(hostile, {});
    assert.equal(requests.length, 1);
    assert.equal(r.isError, true);
    const text = r.content[0].text;
    assert.match(text, /may or may not have been delivered\. Do not retry; the person can email hello@patrickjv\.com instead\./, text);
    assert.match(text, why, text);
    assert.doesNotMatch(text, /not sent/i, text);
  }
});

test("request_intro: a JSON-RPC error from the server is passed on as the server's message", async () => {
  const { intro } = runPage({ respond: () => ({ status: 429, json: async () => ({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Rate limited: too many requests." } }) }) });
  const r = await intro.execute(hostile, {});
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "Rate limited: too many requests.");
});
