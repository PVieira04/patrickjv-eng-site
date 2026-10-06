// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle, LIMITS, reserveQuota, clientKey, encodeHeaderText } from "./handler.js";

const content = JSON.parse(readFileSync(new URL("../content.json", import.meta.url), "utf8"));

// A limiter fake that counts per key, like the real binding (minus locality).
const limiter = (limit) => {
  const n = new Map();
  return { limit: async ({ key }) => { n.set(key, (n.get(key) || 0) + 1); return { success: n.get(key) <= limit }; } };
};

function harness({ burst = 1e9, minute = 1e9, intro = 1e9, sendFails = false, reserveFails = false } = {}) {
  const sent = [];
  let state; // Durable Object storage
  let chain = Promise.resolve(); // Durable Objects process one call at a time
  const reserve = (ipKey, senderKey) => {
    const day = "2026-10-06";
    const p = chain.then(async () => {
      if (reserveFails) throw new Error("DO unavailable");
      await new Promise((r) => setTimeout(r, 1)); // a storage round trip
      const r = reserveQuota(state, day, ipKey, senderKey);
      if (r.ok) state = r.state;
      return { ok: r.ok, which: r.which };
    });
    chain = p.catch(() => {});
    return p;
  };
  const env = { INTRO_FROM: "intro@patrickjv.com", INTRO_TO: "owner@example.com", RL_BURST: limiter(burst), RL_MCP: limiter(minute), RL_INTRO: limiter(intro) };
  const deps = {
    content, reserve, now: () => new Date("2026-10-06T12:00:00Z"),
    sendEmail: async (f, t, raw) => { if (sendFails) throw new Error("send failed"); sent.push({ f, t, raw }); },
  };
  const call = (body, { ip = "203.0.113.7", method = "POST", path = "/mcp", headers = {}, rawBody } = {}) =>
    handle(new Request("https://patrickjv.com" + path, {
      method, duplex: "half",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
      body: method === "POST" ? rawBody ?? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    }), env, deps);
  return { call, sent, state: () => state };
}
const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const intro = (over = {}) => rpc("tools/call", { name: "request_intro", arguments: {
  from_name: "Jane Smith", from_email: "jane@example.com", reason: "collaboration",
  message: "Hello Patrick, I would like to talk about agent platforms.", ...over } });
const headersOf = (raw) => raw.split("\r\n\r\n")[0].replace(/\r\n /g, " ");
const decodeWords = (h) => new TextDecoder().decode(new Uint8Array(
  [...h.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)].flatMap((m) => [...atob(m[1])].map((c) => c.charCodeAt(0)))));

test("initialize: negotiates, defaults unknown versions, requires protocolVersion", async () => {
  const { call } = harness();
  assert.equal((await (await call(rpc("initialize", { protocolVersion: "2025-06-18" }))).json()).result.protocolVersion, "2025-06-18");
  assert.equal((await (await call(rpc("initialize", { protocolVersion: "2025-11-25" }))).json()).result.serverInfo.icons[0].mimeType, "image/png");
  assert.equal((await (await call(rpc("initialize", { protocolVersion: "2025-03-26" }))).json()).result.protocolVersion, "2025-11-25");
  assert.equal((await (await call(rpc("initialize", {}))).json()).error.code, -32602);
});

test("notifications get 202 with no body", async () => {
  const res = await harness().call({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("tools/list: four read-only tools and request_intro", async () => {
  const r = await (await harness().call(rpc("tools/list"))).json();
  assert.deepEqual(r.result.tools.map((t) => t.name), ["get_profile", "list_work", "list_skills", "list_faq", "request_intro"]);
  for (const t of r.result.tools.slice(0, 4)) assert.equal(t.annotations.readOnlyHint, true);
  for (const t of r.result.tools) assert.equal(t.icons[0].src, "https://patrickjv.com/icon-192.png");
});

test("read tools: text is the serialised structuredContent, matching content.json", async () => {
  const { call } = harness();
  const r = await (await call(rpc("tools/call", { name: "list_faq", arguments: {} }))).json();
  assert.deepEqual(r.result.structuredContent, { items: content.faq });
  assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent);
  const p = await (await call(rpc("tools/call", { name: "get_profile" }))).json();
  assert.equal(p.result.structuredContent.links.email, content.person.links.email);
});

test("request_intro: one email, Reply-To is exactly the validated address even with a hostile name", async () => {
  const { call, sent } = harness();
  const r = await (await call(intro({ from_name: "Attacker <victim@example.org>, Jane\r\nBcc: x@example.org", organisation: "Acme" }))).json();
  assert.equal(r.result.isError, undefined, JSON.stringify(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, "owner@example.com");
  const h = headersOf(sent[0].raw);
  const replyTo = h.match(/^Reply-To: (.*)$/m)[1];
  assert.equal(replyTo, "<jane@example.com>");
  assert.equal((replyTo.match(/@/g) || []).length, 1);
  assert.doesNotMatch(h, /^Bcc:/mi);
  assert.equal(h.match(/^To: (.*)$/m)[1], "<owner@example.com>");
});

test("subject: every physical header line fits in 76 characters", async () => {
  const { call, sent } = harness();
  await call(intro({ from_name: "Ålesund Ørsted Æbelø ".repeat(5).trim().slice(0, 100) }));
  const head = sent[0].raw.split("\r\n\r\n")[0];
  for (const line of head.split("\r\n")) if (/=\?UTF-8\?B\?/.test(line)) assert.ok(line.length <= 76, `${line.length}: ${line}`);
});

test("subject: encoded words of at most 75 characters that decode to the original", async () => {
  const name = "Zoë Ünïcödé-Ñame ".repeat(5).trim().slice(0, 100);
  const { call, sent } = harness();
  await call(intro({ from_name: name, organisation: "Ørganisation" }));
  const subjectLines = sent[0].raw.split("\r\n\r\n")[0].match(/^Subject: .*(?:\r\n .*)*/m)[0];
  for (const w of subjectLines.match(/=\?UTF-8\?B\?[^?]*\?=/g)) assert.ok(w.length <= 75, `${w.length}: ${w}`);
  assert.equal(decodeWords(subjectLines), `[Intro · collaboration] ${name} (Ørganisation)`);
  assert.equal(decodeWords(encodeHeaderText("€".repeat(40))), "€".repeat(40));
});

test("request_intro: invalid or mistyped input is rejected without sending", async () => {
  const { call, sent } = harness();
  for (const bad of [{ from_email: "not-an-email" }, { from_email: "jäne@exämple.com" }, { from_email: "a b@example.com" },
    { reason: "spam" }, { message: "too short" }, { extra_field: "x" }, { from_name: 12345 }, { from_name: { toString: null } }]) {
    const r = await (await call(intro(bad))).json();
    assert.equal(r.result?.isError, true, JSON.stringify(bad) + " → " + JSON.stringify(r));
  }
  assert.equal(sent.length, 0);
});

test("daily caps hold under 20 parallel requests: per sender", async () => {
  const { call, sent } = harness();
  await Promise.all(Array.from({ length: 20 }, (_, i) => call(intro(), { ip: `198.51.100.${i}` })));
  assert.equal(sent.length, LIMITS.introPerSenderPerDay);
});

test("daily caps hold under 20 parallel requests: global", async () => {
  const { call, sent } = harness();
  await Promise.all(Array.from({ length: 20 }, (_, i) => call(intro({ from_email: `p${i}@example.com` }), { ip: `192.0.2.${i}` })));
  assert.equal(sent.length, LIMITS.introGlobalPerDay);
});

test("daily caps: per IP, including one IPv6 /64", async () => {
  const { call, sent } = harness();
  for (let i = 0; i < 5; i++) await call(intro({ from_email: `v${i}@example.com` }), { ip: `2001:db8:1:2::${i + 1}` });
  assert.equal(sent.length, LIMITS.introPerIpPerDay);
});

test("per-minute intro limit is per client", async () => {
  const { call, sent } = harness({ intro: 1 });
  await call(intro({ from_email: "a@example.com" }));
  const r = await (await call(intro({ from_email: "b@example.com" }))).json();
  assert.equal(r.result.isError, true);
  await call(intro({ from_email: "c@example.com" }), { ip: "203.0.113.8" });
  assert.equal(sent.length, 2);
});

test("burst limit: the 6th request in a burst from one client is 429; others unaffected", async () => {
  const { call } = harness({ burst: 5 });
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(rpc("ping"))).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
  assert.equal((await call(rpc("ping"), { ip: "203.0.113.99" })).status, 200);
});

test("cheap rejections happen before the body is read", async () => {
  assert.equal((await harness({ minute: 0 }).call("this is not json")).status, 429, "rate limit must win over a parse error");
  const { call } = harness();
  assert.equal((await call(rpc("ping"), { headers: { "content-type": "text/plain" } })).status, 415);
  for (const ct of ["application/json-invalid", "application/json.foo", "application/jsonx"]) assert.equal((await call(rpc("ping"), { headers: { "content-type": ct } })).status, 415, ct);
  assert.equal((await call(rpc("ping"), { headers: { "content-type": "Application/JSON; charset=utf-8" } })).status, 200);
  assert.equal((await call(rpc("ping"), { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call(null, { method: "GET" })).status, 405);
  assert.equal((await call(rpc("ping"), { path: "/mcpx" })).status, 404);
});

test("CORS only for patrickjv.com; none for server-side clients", async () => {
  const { call } = harness();
  assert.equal((await call(rpc("ping"), { headers: { origin: "https://patrickjv.com" } })).headers.get("access-control-allow-origin"), "https://patrickjv.com");
  assert.equal((await call(rpc("ping"))).headers.get("access-control-allow-origin"), null);
});

test("body cap counts bytes and stops reading early, even without Content-Length", async () => {
  const { call } = harness();
  let pulls = 0;
  const chunk = new TextEncoder().encode("x".repeat(4096));
  const stream = new ReadableStream({ pull(c) { pulls++; if (pulls > 100) c.close(); else c.enqueue(chunk); } });
  assert.equal((await call(null, { rawBody: stream })).status, 413);
  assert.ok(pulls < 10, `read ${pulls} chunks before rejecting`);
  const multibyte = JSON.stringify(rpc("ping", { pad: "€".repeat(6000) })); // ~6k chars, ~18 KB
  assert.equal((await call(multibyte)).status, 413);
});

test("malformed JSON-RPC is rejected and never executes a tool", async () => {
  const { call, sent } = harness();
  for (const bad of [{ ...intro(), id: {} }, { ...intro(), id: null }, { ...intro(), id: 1.5 }, { ...intro(), params: [] }]) {
    const res = await call(bad);
    assert.ok(res.status === 400 || (await res.clone().json()).error, JSON.stringify(bad));
  }
  assert.equal((await call({ jsonrpc: "2.0" })).status, 400);
  assert.equal((await call("[1,2]")).status, 400);
  assert.equal(sent.length, 0);
});

test("failures are contained and fail closed", async () => {
  const s = harness({ sendFails: true });
  const r = await (await s.call(intro())).json();
  assert.equal(r.result.isError, true);
  assert.equal(s.state().g, 1, "the reservation is kept when sending fails");
  const d = await (await harness({ reserveFails: true }).call(intro())).json();
  assert.equal(d.error.code, -32603);
});

test("unknown method and unknown tool return JSON-RPC errors", async () => {
  const { call } = harness();
  assert.equal((await (await call(rpc("resources/list"))).json()).error.code, -32601);
  assert.equal((await (await call(rpc("tools/call", { name: "nope" }))).json()).error.code, -32602);
  assert.equal((await (await call(rpc("tools/call", { name: "list_faq", arguments: null }))).json()).error.code, -32602);
  assert.equal((await (await call(rpc("tools/call", { name: "list_faq", arguments: { unexpected: 42 } }))).json()).error.code, -32602);
  assert.equal((await call("{bad json")).status, 400);
});

test("clientKey groups IPv6 by /64 and leaves IPv4 alone", () => {
  assert.equal(clientKey("203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey("2001:db8:1:2::1"), clientKey("2001:DB8:1:2:ffff:0:0:9"));
  assert.notEqual(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"));
  assert.equal(clientKey("2001:0db8:0001:0002::1"), clientKey("2001:db8:1:2::1"), "leading zeros normalise");
  assert.equal(clientKey("::ffff:1.2.3.4"), "1.2.3.4");
  assert.notEqual(clientKey("::ffff:1.2.3.4"), clientKey("::ffff:5.6.7.8"));
  for (const form of ["::ffff:203.0.113.7", "::ffff:cb00:7107", "0::ffff:203.0.113.7", "0:0:0:0:0:ffff:203.0.113.7", "0:0:0:0:0:FFFF:CB00:7107"]) assert.equal(clientKey(form), "203.0.113.7", form);
  for (const bad of ["1::2::3", "1:2:3", "zz::1", "", null, "1.2.3.999", "1:2:3:4:5:6:7:8:9"]) assert.equal(clientKey(bad), "invalid", String(bad));
});

test("reserveQuota never rolls back to an older day", () => {
  let s;
  for (let i = 0; i < LIMITS.introGlobalPerDay; i++) s = reserveQuota(s, "2026-10-07", `ip${i}`, `f${i}`).state;
  const late = reserveQuota(s, "2026-10-06", "late", "late");
  assert.equal(late.ok, false, "a pre-midnight straggler must not reset the new day");
  assert.equal(late.state.day, "2026-10-07");
  assert.equal(reserveQuota(s, "2026-10-07", "another", "another").ok, false);
});

test("reserveQuota resets on a new day", () => {
  let s;
  for (let i = 0; i < LIMITS.introGlobalPerDay; i++) s = reserveQuota(s, "2026-10-06", `ip${i}`, `f${i}`).state;
  assert.equal(reserveQuota(s, "2026-10-06", "new", "new").ok, false);
  assert.equal(reserveQuota(s, "2026-10-07", "new", "new").ok, true);
});
