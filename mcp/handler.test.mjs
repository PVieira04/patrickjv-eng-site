// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle, LIMITS, reserveQuota, reserveIntro, pruneQuota, clientKey, encodeHeaderText, validateIntro, senderQuotaKey, quotaHash, SECURITY_HEADERS } from "./handler.js";

const SALT = "test-salt-0123456789abcdef0123456789"; // >= 32 characters, as production requires
const content = JSON.parse(readFileSync(new URL("../content.json", import.meta.url), "utf8"));
const serverJson = JSON.parse(readFileSync(new URL("./server.json", import.meta.url), "utf8"));

// A limiter fake that counts per key, like the real binding (minus locality).
const limiter = (limit) => {
  const n = new Map();
  return { calls: () => [...n.values()].reduce((a, b) => a + b, 0), limit: async ({ key }) => { n.set(key, (n.get(key) || 0) + 1); return { success: n.get(key) <= limit }; } };
};

// An in-memory stand-in for Durable Object storage (get/put/delete + alarms). Values are
// structured-cloned, as the real storage does, so the code under test cannot rely on aliasing.
function memoryStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    put: async (k, v) => { map.set(k, structuredClone(v)); },
    delete: async (k) => map.delete(k),
    getAlarm: async () => alarm,
    setAlarm: async (t) => { alarm = typeof t === "number" ? t : t.getTime(); },
    fireAlarm: () => { alarm = null; },
    alarm: () => alarm,
  };
}

// Captures console output so tests can check what is (and is not) logged.
async function capturingLogs(fn) {
  const lines = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.join(" "));
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines;
}

function harness({ burst = 1e9, minute = 1e9, intro = 1e9, sendFails = false, reserveFails = false, salt = SALT } = {}) {
  const sent = [];
  const storage = memoryStorage(); // the Durable Object's storage
  const reserved = []; // the keys the handler handed to the Durable Object
  let chain = Promise.resolve(); // Durable Objects process one call at a time
  // Runs the REAL reservation code (reserveIntro) against storage, one call at a time.
  const reserve = (ipKey, senderKey) => {
    reserved.push({ ipKey, senderKey });
    const p = chain.then(async () => {
      if (reserveFails) throw new Error("DO unavailable");
      await new Promise((r) => setTimeout(r, 1)); // a storage round trip
      return reserveIntro(storage, new Date("2026-10-06T12:00:00Z"), ipKey, senderKey);
    });
    chain = p.catch(() => {});
    return p;
  };
  const rl = { burst: limiter(burst), minute: limiter(minute) };
  const env = {
    INTRO_FROM: "intro@patrickjv.com", INTRO_TO_ADDRESS: "owner@example.com", RL_BURST: rl.burst, RL_MCP: rl.minute, RL_INTRO: limiter(intro), ...(salt ? { QUOTA_SALT: salt } : {}),
    // Binding stand-ins (the handler only checks that they are present, for patrickjv/health).
    EMAIL: { send: async () => {} }, QUOTA: { idFromName: () => ({}), get: () => ({}) },
  };
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
  return { call, sent, state: () => storage.map.get("counters"), storage, reserved, rl, env };
}
const init = (protocolVersion, over = {}) => ({ protocolVersion, capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" }, ...over });
const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const intro = (over = {}) => rpc("tools/call", { name: "request_intro", arguments: {
  from_name: "Jane Smith", from_email: "jane@example.com", reason: "collaboration",
  message: "Hello Patrick, I would like to talk about agent platforms.", ...over } });
const headersOf = (raw) => raw.split("\r\n\r\n")[0].replace(/\r\n /g, " ");
const decodeWords = (h) => new TextDecoder().decode(new Uint8Array(
  [...h.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)].flatMap((m) => [...atob(m[1])].map((c) => c.charCodeAt(0)))));
const decodeBody = (raw) => new TextDecoder().decode(Uint8Array.from(atob(raw.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, "")), (c) => c.charCodeAt(0)));

test("initialize: negotiates, defaults unknown versions, requires protocolVersion", async () => {
  const { call } = harness();
  assert.equal((await (await call(rpc("initialize", init("2025-06-18")))).json()).result.protocolVersion, "2025-06-18");
  assert.equal((await (await call(rpc("initialize", init("2025-11-25")))).json()).result.serverInfo.icons[0].mimeType, "image/png");
  assert.equal((await (await call(rpc("initialize", init("2025-03-26")))).json()).result.protocolVersion, "2025-11-25");
  assert.equal((await (await call(rpc("initialize", {}))).json()).error.code, -32602);
});

test("initialize: capabilities and clientInfo are validated", async () => {
  const { call } = harness();
  for (const bad of [
    init("2025-11-25", { capabilities: 42 }), init("2025-11-25", { capabilities: [] }), init("2025-11-25", { capabilities: undefined }),
    init("2025-11-25", { clientInfo: null }), init("2025-11-25", { clientInfo: { name: "x" } }), init("2025-11-25", { clientInfo: { name: 1, version: "1" } }),
    init(7)]) {
    const r = await (await call(rpc("initialize", bad))).json();
    assert.equal(r.error?.code, -32602, JSON.stringify(bad));
  }
});

test("serverInfo.version is the MCP Registry entry's version", async () => {
  const r = await (await harness().call(rpc("initialize", init("2025-11-25")))).json();
  assert.equal(r.result.serverInfo.version, serverJson.version);
});

test("notifications get 202 with no body", async () => {
  const res = await harness().call({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("client JSON-RPC responses: exactly one of result/error, and a well-formed error", async () => {
  const { call } = harness();
  for (const good of [{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: "a", error: { code: -1, message: "no" } }])
    assert.equal((await call(good)).status, 202, JSON.stringify(good));
  for (const bad of [{ jsonrpc: "2.0", id: 1, error: null }, { jsonrpc: "2.0", id: 1, error: { code: 1.5, message: "x" } },
    { jsonrpc: "2.0", id: 1, error: { code: 1 } }, { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } },
    { jsonrpc: "2.0", id: 1 }]) {
    const res = await call(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).error.code, -32600);
  }
});

test("tools/list: four read-only tools, request_intro, then the five booking tools", async () => {
  const r = await (await harness().call(rpc("tools/list"))).json();
  assert.deepEqual(r.result.tools.map((t) => t.name), ["get_profile", "list_work", "list_skills", "list_faq", "request_intro",
    "list_meeting_types", "get_availability", "book_meeting", "get_booking_status", "cancel_booking"]);
  for (const t of r.result.tools.slice(0, 4)) assert.equal(t.annotations.readOnlyHint, true);
  for (const t of r.result.tools) assert.equal(t.icons[0].src, "https://patrickjv.com/icon-192.png");
  assert.match(r.result.tools[4].description, /not stored by this site/);
  // Durable Object storage keeps 30 days of recovery history, so no exact retention is promised.
  assert.match(r.result.tools[4].description, /rate-limit counters are hashed and expire daily/);
  assert.doesNotMatch(r.result.tools[4].description, /kept for one day/);
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

test("intro email body: no country or client metadata; timestamp and unverified-sender note kept", async () => {
  const { call, sent } = harness();
  await call(intro(), { headers: { "user-agent": "SecretClient/9.9 (Probe)" } });
  const body = decodeBody(sent[0].raw);
  assert.doesNotMatch(body, /Country:|Client:|SecretClient/);
  assert.match(body, /Received via the patrickjv\.com MCP server \(request_intro\) at 2026-10-06T12:00:00\.000Z\./);
  assert.match(body, /Unverified sender: reply only if it looks genuine\./);
});

test("request_intro: Reply-To keeps the local part's case and +tag; only the domain is lower-cased", async () => {
  const { call, sent } = harness();
  await call(intro({ from_email: "  Jane.Smith+Intro@Example.COM " }));
  assert.equal(headersOf(sent[0].raw).match(/^Reply-To: (.*)$/m)[1], "<Jane.Smith+Intro@example.com>");
});

test("email: dot-atom local part — no leading, trailing or consecutive dots; 64-octet limit", () => {
  for (const bad of [".a@example.com", "a.@example.com", "a..b@example.com", ".@example.com", "@example.com", `${"a".repeat(65)}@example.com`, "a@b@example.com"])
    assert.ok(validateIntro({ from_name: "J", from_email: bad, reason: "other", message: "x".repeat(20) }).error, bad);
  for (const good of ["a.b@example.com", "a@example.co.uk", `${"a".repeat(64)}@example.com`, "o'neil+x@example.com"])
    assert.equal(validateIntro({ from_name: "J", from_email: good, reason: "other", message: "x".repeat(20) }).error, undefined, good);
});

test("lengths are counted in code points, matching the schema", () => {
  const base = { from_email: "a@example.com", reason: "other", message: "x".repeat(20) };
  assert.equal(validateIntro({ ...base, from_name: "😀".repeat(100) }).error, undefined, "100 emoji is 100 characters");
  assert.ok(validateIntro({ ...base, from_name: "😀".repeat(101) }).error);
  assert.ok(validateIntro({ ...base, from_name: "J", message: "😀".repeat(19) }).error, "19 emoji is under the 20 minimum");
  assert.equal(validateIntro({ ...base, from_name: "J", message: "😀".repeat(2000) }).error, undefined);
  assert.ok(validateIntro({ ...base, from_name: "J", message: "😀".repeat(2001) }).error);
  assert.equal(validateIntro({ ...base, from_name: "J", organisation: "😀".repeat(100), agent: "😀".repeat(100) }).error, undefined);
  assert.ok(validateIntro({ ...base, from_name: "J", agent: "😀".repeat(101) }).error);
});

test("single-line fields lose bidi and zero-width characters", () => {
  const sneaky = "Ja\u202ene\u200b \u2066Sm\u200fith\u2069\ufeff\u061c\u2060\u200d\u202a";
  const { value } = validateIntro({ from_name: sneaky, organisation: sneaky, agent: sneaky, from_email: "a@example.com", reason: "other", message: "x".repeat(20) });
  for (const k of ["from_name", "organisation", "agent"]) assert.equal(value[k], "Jane Smith", k);
});

test("MIME body is CRLF throughout, including the message's own lines", async () => {
  const { call, sent } = harness();
  await call(intro({ message: "Line one of the intro\nline two\r\nline three\rline four" }));
  const body = decodeBody(sent[0].raw);
  assert.ok(body.includes("Line one of the intro\r\nline two\r\nline three\r\nline four"), body);
  assert.doesNotMatch(body, /(?<!\r)\n/, "no bare LF");
  assert.doesNotMatch(body, /\r(?!\n)/, "no bare CR");
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
  for (const bad of [{ from_email: "not-an-email" }, { from_email: "jäne@exämple.com" }, { from_email: "a b@example.com" }, { from_email: "a..b@example.com" },
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

test("per-sender cap: +tag, case and Gmail-dot variants count as one sender", async () => {
  const { call, sent } = harness();
  for (const [i, e] of ["jane.smith@gmail.com", "Jane.Smith+a@gmail.com", "janesmith+b@googlemail.com", "j.a.n.e.s.m.i.t.h@GMAIL.com"].entries())
    await call(intro({ from_email: e }), { ip: `198.51.100.${i}` });
  assert.equal(sent.length, LIMITS.introPerSenderPerDay);
  assert.equal(senderQuotaKey("Jane.Smith+x@GoogleMail.com"), "janesmith@gmail.com");
  assert.equal(senderQuotaKey("Jane.Smith+x@example.com"), "jane.smith@example.com", "dots matter outside Gmail");
});

test("daily caps hold under 20 parallel requests: global", async () => {
  const { call, sent } = harness();
  await Promise.all(Array.from({ length: 20 }, (_, i) => call(intro({ from_email: `p${i}@example.com` }), { ip: `192.0.2.${i}` })));
  assert.equal(sent.length, LIMITS.introGlobalPerDay);
});

test("daily caps: per IP, including one IPv6 /64", async () => {
  const { call, sent } = harness();
  for (let i = 0; i < LIMITS.introPerIpPerDay + 3; i++) await call(intro({ from_email: `v${i}@example.com` }), { ip: `2001:db8:1:2::${i + 1}` });
  assert.equal(sent.length, LIMITS.introPerIpPerDay);
});

test("the quota Durable Object only ever sees keyed hashes, never an IP or an address", async () => {
  const { call, reserved, storage } = harness();
  await call(intro({ from_email: "jane@example.com" }));
  const stored = JSON.stringify(storage.map.get("counters"));
  for (const { ipKey, senderKey } of reserved) {
    assert.match(ipKey, /^[0-9a-f]{64}$/);
    assert.match(senderKey, /^[0-9a-f]{64}$/);
  }
  assert.doesNotMatch(stored, /203\.0\.113\.7|jane|example\.com/);
  // Keyed: the same input under a different secret gives a different key, and neither is a plain hash.
  const a = await quotaHash({ QUOTA_SALT: "one".repeat(11) }, "ip", "203.0.113.7");
  const b = await quotaHash({ QUOTA_SALT: "two".repeat(11) }, "ip", "203.0.113.7");
  assert.notEqual(a, b);
  const plain = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("203.0.113.7")))].map((x) => x.toString(16).padStart(2, "0")).join("");
  assert.notEqual(a, plain);
  assert.equal(reserved[0].ipKey, await quotaHash({ QUOTA_SALT: SALT }, "ip", "203.0.113.7"));
});

test("QUOTA_SALT missing or shorter than 32 characters: request_intro fails closed; read tools still work", async () => {
  for (const salt of [null, "", "x".repeat(31)]) {
    const s = harness({ salt });
    let r;
    const lines = await capturingLogs(async () => { r = await (await s.call(intro())).json(); });
    assert.equal(r.result?.isError, true, `salt ${JSON.stringify(salt)}: ${JSON.stringify(r)}`);
    assert.match(r.result.content[0].text, /unavailable/);
    assert.equal(s.sent.length, 0, "nothing sent");
    assert.equal(s.reserved.length, 0, "nothing reserved");
    assert.equal(s.rl.burst.calls(), 1, "only the burst limiter ran");
    assert.ok(lines.some((l) => l.includes('"subsystem":"config"')), lines.join("\n"));
    const faq = await (await s.call(rpc("tools/call", { name: "list_faq", arguments: {} }))).json();
    assert.deepEqual(faq.result.structuredContent, { items: content.faq });
  }
  // The hash itself also refuses a weak key rather than falling back to a public one.
  await assert.rejects(quotaHash({}, "ip", "203.0.113.7"));
  await assert.rejects(quotaHash({ QUOTA_SALT: "short" }, "ip", "203.0.113.7"));
});

test("reserveIntro: real storage path keeps only today, and an alarm prunes yesterday", async () => {
  const storage = memoryStorage();
  const day1 = new Date("2026-10-06T23:59:00Z");
  assert.deepEqual(await reserveIntro(storage, day1, "ip", "s"), { ok: true, which: undefined });
  assert.equal(storage.alarm(), Date.UTC(2026, 9, 7), "alarm at the next UTC midnight");
  assert.equal(storage.map.get("counters").day, "2026-10-06");
  await pruneQuota(storage, new Date("2026-10-06T23:59:30Z"));
  assert.ok(storage.map.has("counters"), "today's counters survive");
  storage.fireAlarm();
  await pruneQuota(storage, new Date("2026-10-07T00:00:01Z"));
  assert.equal(storage.map.has("counters"), false, "yesterday's counters are deleted");
  // A new day starts fresh and schedules the next prune.
  await reserveIntro(storage, new Date("2026-10-07T08:00:00Z"), "ip2", "s2");
  assert.deepEqual(storage.map.get("counters"), { day: "2026-10-07", g: 1, ip: { ip2: 1 }, from: { s2: 1 } });
  assert.equal(storage.alarm(), Date.UTC(2026, 9, 8));
});

test("quota alarm: a delayed midnight alarm cannot leave the new day's counters without one", async () => {
  // Codex's sequence: reserve before midnight; reserve after midnight before the old alarm fires;
  // then the delayed alarm fires.
  const storage = memoryStorage();
  await reserveIntro(storage, new Date("2026-10-06T23:59:00Z"), "ip", "s");
  assert.equal(storage.alarm(), Date.UTC(2026, 9, 7));
  await reserveIntro(storage, new Date("2026-10-07T00:00:30Z"), "ip", "s");
  assert.equal(storage.map.get("counters").day, "2026-10-07");
  assert.equal(storage.alarm(), Date.UTC(2026, 9, 8), "the stale alarm is moved to the end of the new day");
  storage.fireAlarm();
  await pruneQuota(storage, new Date("2026-10-07T00:01:00Z"));
  assert.equal(storage.map.get("counters").day, "2026-10-07", "today's counters survive");
  assert.equal(storage.alarm(), Date.UTC(2026, 9, 8), "and still have a cleanup alarm");
});

test("quota alarm: an alarm that finds today's counters schedules the next midnight", async () => {
  const storage = memoryStorage();
  await storage.put("counters", { day: "2026-10-07", g: 1, ip: { a: 1 }, from: { b: 1 } });
  await pruneQuota(storage, new Date("2026-10-07T00:00:05Z"));
  assert.ok(storage.map.has("counters"));
  assert.equal(storage.alarm(), Date.UTC(2026, 9, 8));
  // Once yesterday's counters are deleted nothing is left to clean up: no alarm needed.
  storage.fireAlarm();
  await pruneQuota(storage, new Date("2026-10-08T00:00:05Z"));
  assert.equal(storage.map.has("counters"), false);
  assert.equal(storage.alarm(), null);
});

test("quota alarm: legacy counters with no alarm get one on the next reservation, even a refused one", async () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const legacy = memoryStorage();
  await legacy.put("counters", { day: "2026-10-06", g: 1, ip: { old: 1 }, from: { old: 1 } });
  assert.equal((await reserveIntro(legacy, now, "ip", "s")).ok, true);
  assert.equal(legacy.alarm(), Date.UTC(2026, 9, 7));
  const full = memoryStorage();
  await full.put("counters", { day: "2026-10-06", g: LIMITS.introGlobalPerDay, ip: {}, from: {} });
  assert.deepEqual(await reserveIntro(full, now, "ip", "s"), { ok: false, which: "global" });
  assert.equal(full.alarm(), Date.UTC(2026, 9, 7));
});

test("reserveIntro: a refused reservation writes nothing", async () => {
  const storage = memoryStorage();
  const now = new Date("2026-10-06T12:00:00Z");
  for (let i = 0; i < LIMITS.introPerSenderPerDay; i++) assert.equal((await reserveIntro(storage, now, `ip${i}`, "same")).ok, true);
  const before = JSON.stringify(storage.map.get("counters"));
  assert.deepEqual(await reserveIntro(storage, now, "ipX", "same"), { ok: false, which: "sender" });
  assert.equal(JSON.stringify(storage.map.get("counters")), before);
});

test("per-minute intro limit is per client", async () => {
  const { call, sent } = harness({ intro: 1 });
  await call(intro({ from_email: "a@example.com" }));
  const r = await (await call(intro({ from_email: "b@example.com" }))).json();
  assert.equal(r.result.isError, true);
  await call(intro({ from_email: "c@example.com" }), { ip: "203.0.113.8" });
  assert.equal(sent.length, 2);
});

test("burst limit: the 6th tools/call in a burst from one client is 429; others unaffected", async () => {
  const { call } = harness({ burst: 5 });
  const faq = rpc("tools/call", { name: "list_faq" });
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(faq)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
  assert.equal((await call(faq, { ip: "203.0.113.99" })).status, 200);
});

test("burst limit: the handshake (initialize, notifications, ping, tools/list) is not counted; the minute limit still is", async () => {
  const { call, rl } = harness({ burst: 1 });
  for (let i = 0; i < 5; i++) {
    assert.equal((await call(rpc("initialize", init("2025-11-25")))).status, 200);
    assert.equal((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    assert.equal((await call(rpc("ping"))).status, 200);
    assert.equal((await call(rpc("tools/list"))).status, 200);
  }
  assert.equal(rl.burst.calls(), 0);
  assert.equal(rl.minute.calls(), 20);
  assert.equal((await call(rpc("tools/call", { name: "list_faq" }))).status, 200);
  assert.equal((await call(rpc("tools/call", { name: "list_faq" }))).status, 429);
  const m = harness({ minute: 2 });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await m.call(rpc("ping"))).status);
  assert.deepEqual(codes, [200, 200, 429]);
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

test("declared Content-Length over 16 KiB is 413 before anything else is spent", async () => {
  const { call, rl } = harness();
  const res = await call(rpc("ping"), { headers: { "content-length": String(LIMITS.maxBodyBytes + 1) } });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, -32600);
  assert.equal(rl.minute.calls(), 0, "no rate-limit call for a request rejected on its declared size");
});

test("Origin: absent is allowed; present and anything but patrickjv.com (even empty) is 403", async () => {
  const { call } = harness();
  assert.equal((await call(rpc("ping"))).status, 200);
  assert.equal((await call(rpc("ping"), { headers: { origin: "https://patrickjv.com" } })).status, 200);
  for (const o of ["", "null", "http://patrickjv.com", "https://patrickjv.com.evil.example", "https://www.patrickjv.com"])
    assert.equal((await call(rpc("ping"), { headers: { origin: o } })).status, 403, JSON.stringify(o));
});

test("CORS only for patrickjv.com; none for server-side clients", async () => {
  const { call } = harness();
  assert.equal((await call(rpc("ping"), { headers: { origin: "https://patrickjv.com" } })).headers.get("access-control-allow-origin"), "https://patrickjv.com");
  assert.equal((await call(rpc("ping"))).headers.get("access-control-allow-origin"), null);
});

test("OPTIONS preflight from patrickjv.com: 204 with CORS headers", async () => {
  const { call } = harness();
  const res = await call(null, { method: "OPTIONS", headers: { origin: "https://patrickjv.com", "access-control-request-method": "POST" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://patrickjv.com");
  assert.equal(res.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.match(res.headers.get("access-control-allow-headers"), /mcp-protocol-version/);
  assert.equal(res.headers.get("vary"), "Origin");
  assert.equal((await call(null, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status, 403);
});

test("MCP-Protocol-Version: unsupported (or empty) is 400; absent is accepted", async () => {
  const { call } = harness();
  for (const v of ["2024-11-05", "2025-03-26", "", "garbage"]) {
    const res = await call(rpc("tools/list"), { headers: { "mcp-protocol-version": v } });
    assert.equal(res.status, 400, JSON.stringify(v));
    assert.equal((await res.json()).error.code, -32600);
  }
  for (const v of ["2025-11-25", "2025-06-18"]) assert.equal((await call(rpc("tools/list"), { headers: { "mcp-protocol-version": v } })).status, 200, v);
  const absent = await call(rpc("tools/list"));
  assert.equal(absent.status, 200);
  assert.equal((await absent.json()).result.tools.length, 10);
});

test("security headers on every response branch", async () => {
  const { call } = harness();
  const cases = {
    "404": call(rpc("ping"), { path: "/nope" }),
    "403": call(rpc("ping"), { headers: { origin: "https://evil.example" } }),
    "204": call(null, { method: "OPTIONS", headers: { origin: "https://patrickjv.com" } }),
    "405": call(null, { method: "GET" }),
    "415": call(rpc("ping"), { headers: { "content-type": "text/plain" } }),
    "413": call(rpc("ping"), { headers: { "content-length": "999999" } }),
    "429": harness({ minute: 0 }).call(rpc("ping")),
    "400": capturingLogs(() => {}).then(() => call("[1]")),
    "202": call({ jsonrpc: "2.0", method: "notifications/initialized" }),
    "200": call(rpc("ping")),
  };
  // A limiter binding that throws gives the 503 branch.
  const broken = harness();
  broken.env.RL_MCP = { limit: async () => { throw new Error("binding down"); } };
  let unavailable;
  await capturingLogs(async () => { unavailable = await broken.call(rpc("ping")); });
  cases["503"] = unavailable;
  for (const [status, p] of Object.entries(cases)) {
    const res = await p;
    assert.equal(String(res.status), status);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(k), v, `${status} ${k}`);
  }
  assert.equal(SECURITY_HEADERS["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
  assert.equal(SECURITY_HEADERS["strict-transport-security"], "max-age=31536000; includeSubDomains");
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

test("malformed JSON-RPC is rejected with exact codes and never executes a tool", async () => {
  const { call, sent } = harness();
  for (const [bad, status, code, id] of [
    [{ ...intro(), id: {} }, 400, -32600, null], [{ ...intro(), id: null }, 400, -32600, null],
    [{ ...intro(), id: 1.5 }, 400, -32600, null], [{ ...intro(), params: [] }, 400, -32602, 1],
    [{ jsonrpc: "2.0" }, 400, -32600, null], [[1, 2], 400, -32600, null], [{ ...intro(), jsonrpc: "1.0" }, 400, -32600, null],
    [{ ...intro(), method: 7 }, 400, -32600, null], ["{bad json", 400, -32700, null]]) {
    const res = await call(bad);
    assert.equal(res.status, status, JSON.stringify(bad));
    const body = await res.json();
    assert.equal(body.error.code, code, JSON.stringify(bad));
    assert.equal(body.id, id, JSON.stringify(bad));
  }
  assert.equal(sent.length, 0);
});

test("numeric ids must be safe integers written as integers; precision loss is refused", async () => {
  const { call } = harness();
  for (const raw of ['{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}', '{"jsonrpc":"2.0","id":9007199254740992,"method":"ping"}',
    '{"jsonrpc":"2.0","id":-9007199254740993,"method":"ping"}', '{"jsonrpc":"2.0","id":1.0000000000000001,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1e3,"method":"ping"}']) {
    const res = await call(raw);
    assert.equal(res.status, 400, raw);
    const body = await res.json();
    assert.equal(body.error.code, -32600, raw);
    assert.equal(body.id, null, raw);
  }
  for (const [raw, id] of [['{"jsonrpc":"2.0","id":9007199254740991,"method":"ping"}', 9007199254740991], ['{"jsonrpc":"2.0","id":-7,"method":"ping"}', -7],
    ['{"jsonrpc":"2.0","id":"9007199254740993","method":"ping"}', "9007199254740993"], ['{"jsonrpc":"2.0","id":0,"method":"ping","params":{"id":1.5}}', 0]]) {
    const res = await call(raw);
    assert.equal(res.status, 200, raw);
    assert.equal((await res.json()).id, id, raw);
  }
});

test("failures are contained and fail closed", async () => {
  const s = harness({ sendFails: true });
  let r;
  await capturingLogs(async () => { r = await (await s.call(intro())).json(); });
  assert.equal(r.result.isError, true);
  assert.equal(s.state().g, 1, "the reservation is kept when sending fails");
  assert.equal(s.sent.length, 0);
  let d;
  await capturingLogs(async () => { d = await (await harness({ reserveFails: true }).call(intro())).json(); });
  assert.equal(d.error.code, -32603);
});

test("failures and quota refusals are logged as redacted events naming the subsystem", async () => {
  const secretish = ["jane", "example.com", "203.0.113.7", "agent platforms", "Jane Smith"];
  const check = (lines, subsystem) => {
    assert.ok(lines.some((l) => l.includes(`"subsystem":"${subsystem}"`)), `${subsystem}: ${lines.join("\n")}`);
    for (const l of lines) for (const s of secretish) assert.ok(!l.includes(s), `leaked ${s}: ${l}`);
  };
  check(await capturingLogs(() => harness({ sendFails: true }).call(intro())), "email");
  check(await capturingLogs(() => harness({ reserveFails: true }).call(intro())), "quota");
  const rlDown = harness();
  rlDown.env.RL_INTRO = { limit: async () => { throw new Error("down"); } };
  check(await capturingLogs(() => rlDown.call(intro())), "ratelimit_intro");
  const mcpDown = harness();
  mcpDown.env.RL_MCP = { limit: async () => { throw new Error("down"); } };
  check(await capturingLogs(() => mcpDown.call(rpc("ping"))), "ratelimit");
  const capped = harness();
  const lines = await capturingLogs(async () => { for (let i = 0; i < 3; i++) await capped.call(intro(), { ip: `198.51.100.${i}` }); });
  const refusal = lines.find((l) => l.includes("intro_quota_rejected"));
  assert.deepEqual(JSON.parse(refusal), { event: "intro_quota_rejected", which: "sender" });
  for (const l of lines) for (const s of secretish) assert.ok(!l.includes(s), `leaked ${s}: ${l}`);
});

// patrickjv/health: a read-only readiness signal for request_intro (smoke --mcp requires introReady).
const health = async (h, opts) => (await (await h.call(rpc("patrickjv/health"), opts)).json());
const HEALTH_KEYS = ["introReady", "salt", "email", "quota", "rateLimits"];

test("patrickjv/health: only booleans; introReady when salt, email, quota and rate limits are all configured", async () => {
  const r = await health(harness());
  assert.deepEqual(r.result, { introReady: true, salt: true, email: true, quota: true, rateLimits: true });
  const broken = [
    ["salt", (h) => { delete h.env.QUOTA_SALT; }], ["salt", (h) => { h.env.QUOTA_SALT = "x".repeat(31); }],
    ["email", (h) => { delete h.env.EMAIL; }], ["email", (h) => { delete h.env.INTRO_TO_ADDRESS; }], ["email", (h) => { h.env.INTRO_FROM = ""; }],
    ["quota", (h) => { delete h.env.QUOTA; }], ["rateLimits", (h) => { delete h.env.RL_INTRO; }],
  ];
  for (const [key, breakIt] of broken) {
    const h = harness();
    breakIt(h);
    const res = (await health(h)).result;
    assert.deepEqual(Object.keys(res), HEALTH_KEYS, key);
    for (const k of HEALTH_KEYS) assert.equal(typeof res[k], "boolean", `${key}: ${k}`);
    assert.equal(res[key], false, key);
    assert.equal(res.introReady, false, `${key}: introReady`);
  }
});

test("patrickjv/health: never reveals secret values or lengths, and sends or reserves nothing", async () => {
  const h = harness();
  const text = await (await h.call(rpc("patrickjv/health"))).text();
  assert.ok(!text.includes(h.env.QUOTA_SALT) && !text.includes(String(h.env.QUOTA_SALT.length)), text);
  assert.ok(!text.includes("owner@example.com") && !text.includes("intro@patrickjv.com"), text);
  assert.equal(h.sent.length, 0);
  assert.equal(h.reserved.length, 0);
});

test("patrickjv/health: goes through the same rejection chain (origin, method, media type, size, rate limits)", async () => {
  const h = harness();
  assert.equal((await h.call(rpc("patrickjv/health"), { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await h.call(rpc("patrickjv/health"), { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await h.call(rpc("patrickjv/health"), { headers: { "content-length": String(LIMITS.maxBodyBytes + 1) } })).status, 413);
  assert.equal((await h.call(null, { method: "GET" })).status, 405);
  assert.equal((await harness({ minute: 0 }).call(rpc("patrickjv/health"))).status, 429, "per-minute limit");
  const b = harness({ burst: 1 });
  assert.equal((await b.call(rpc("patrickjv/health"))).status, 200);
  assert.equal((await b.call(rpc("patrickjv/health"))).status, 429, "burst limit (not handshake-exempt)");
  assert.equal(b.rl.burst.calls(), 2);
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

test("mcp/wrangler.jsonc: Workers Logs keep only custom events — invocation logs off, query strings redacted", () => {
  const cfg = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"));
  assert.equal(cfg.observability.enabled, true);
  assert.equal(cfg.observability.redact_query_string, true);
  assert.equal(cfg.observability.logs.enabled, true);
  assert.equal(cfg.observability.logs.invocation_logs, false);
});
