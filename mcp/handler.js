// Remote MCP server for patrickjv.com (Streamable HTTP transport, stateless, JSON responses only).
// Read-only profile tools plus request_intro, which emails Patrick under conservative limits.
//
// Cost control: requests are rejected in the cheapest order — path, Origin, method, media type,
// declared size, per-IP rate limit — before the body is read. The body is read with a byte cap.
// The burst limit is applied after the (capped) body is parsed, so that the MCP handshake can be
// exempted from it. request_intro reserves its daily quota atomically (Durable Object) BEFORE
// sending, and fails closed: a reservation is never refunded, so errors can only ever reduce what
// gets sent.
import { agentData } from "../lib/agent-data.mjs";
// Single source for the server version: the MCP Registry entry. Bump it there and both agree.
import serverJson from "./server.json" with { type: "json" };

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];
export const ALLOWED_ORIGIN = "https://patrickjv.com";
export const SERVER_VERSION = serverJson.version;
export const LIMITS = {
  maxBodyBytes: 16 * 1024,
  // Per IP (IPv4 address or IPv6 /64). Kept low, but not 2: hosted MCP clients (e.g. the Claude
  // connector) and corporate NAT put many people behind one egress address, and 2 a day would let
  // the first two users lock out everyone else there. The per-sender and global caps below are the
  // real bound on email volume, so raising this costs at most a few extra emails.
  introPerIpPerDay: 4,
  introPerSenderPerDay: 2,
  introGlobalPerDay: 10,
};
const REASONS = ["recruiting", "collaboration", "speaking", "other"];
// Cheap protocol plumbing that every MCP session sends; not counted against the burst limit (the
// per-minute limit still counts it). Notifications and client responses are exempt too.
const BURST_EXEMPT = new Set(["initialize", "ping", "tools/list"]);

// Sent on every response, including errors. The tight CSP suits JSON/text: nothing here is meant
// to render, load sub-resources or be framed.
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

const corsFor = (origin) => (origin === ALLOWED_ORIGIN ? {
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
  vary: "Origin",
} : {});

// Operational visibility (Workers Logs) without personal data: an event name and the failing
// subsystem only — never message bodies, addresses or IPs.
const logFailure = (subsystem) => console.error(JSON.stringify({ event: "mcp_failure", subsystem }));

// MCP 2025-11-25 icons: shown by clients (e.g. the Claude connector list) instead of a letter.
const ICONS = [
  { src: "https://patrickjv.com/icon-192.png", mimeType: "image/png", sizes: ["192x192"] },
  { src: "https://patrickjv.com/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
];
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function tools() {
  const empty = { type: "object", properties: {}, additionalProperties: false };
  return [
    { name: "get_profile", title: "Profile", description: "Patrick Vieira's public profile (platform engineer, London — not the footballer): name, headline, tagline, location and links.", inputSchema: empty, annotations: READ_ONLY, icons: ICONS },
    { name: "list_work", title: "Selected work", description: "Selected work: title, summary and tags for each item.", inputSchema: empty, annotations: READ_ONLY, icons: ICONS },
    { name: "list_skills", title: "Skills", description: "Patrick Vieira's listed skills.", inputSchema: empty, annotations: READ_ONLY, icons: ICONS },
    { name: "list_faq", title: "Quick answers", description: "Quick answers about Patrick Vieira: each question (q) with its answer (a).", inputSchema: empty, annotations: READ_ONLY, icons: ICONS },
    {
      name: "request_intro",
      title: "Request an introduction",
      description:
        "Send Patrick Vieira a short introduction by email on behalf of a person. Only use this when the person has asked you to contact him and has approved the message. Strictly rate-limited; at most a couple per sender per day. Do not retry on error. Privacy: the message is forwarded to Patrick's email and not stored by this site; rate-limit counters are hashed and kept for one day.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["from_name", "from_email", "reason", "message"],
        properties: {
          from_name: { type: "string", minLength: 1, maxLength: 100, description: "Full name of the person making the introduction." },
          from_email: { type: "string", maxLength: 254, description: "Email address Patrick should reply to (ASCII)." },
          organisation: { type: "string", maxLength: 100, description: "Optional organisation." },
          reason: { type: "string", enum: REASONS },
          message: { type: "string", minLength: 20, maxLength: 2000, description: "The introduction itself, in plain text." },
          agent: { type: "string", maxLength: 100, description: "Optional: name of the AI agent sending this on the person's behalf." },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      icons: ICONS,
    },
  ];
}

// Single-line text: no control characters (prevents header injection; also tidies the body), and
// no bidi or zero-width characters, which could make the Subject display differently from what it
// says (e.g. a right-to-left override hiding or reordering a name).
const oneLine = (s) => s
  .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
  .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
  .trim();
// Lengths in Unicode code points, as JSON Schema's minLength/maxLength count them.
const cpLength = (s) => [...s].length;
// ASCII-only, conservative address syntax: no quotes, spaces, brackets or commas, so it can never
// form a second mailbox or escape the angle brackets in Reply-To. The local part is a dot-atom
// (no leading, trailing or consecutive dots); its 64-octet limit is checked separately.
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const EMAIL_RE = new RegExp(`^(${ATEXT}(?:\\.${ATEXT})*)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$`);

export function validateIntro(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { error: "arguments must be an object" };
  const allowed = new Set(["from_name", "from_email", "organisation", "reason", "message", "agent"]);
  const extra = Object.keys(args).filter((k) => !allowed.has(k));
  if (extra.length) return { error: `unknown field(s): ${extra.join(", ")}` };
  for (const k of Object.keys(args)) if (typeof args[k] !== "string") return { error: `${k} must be a string` };
  const v = {
    from_name: oneLine(args.from_name ?? ""),
    from_email: (args.from_email ?? "").trim(),
    organisation: oneLine(args.organisation ?? ""),
    reason: (args.reason ?? "").trim(),
    message: (args.message ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim(),
    agent: oneLine(args.agent ?? ""),
  };
  if (!v.from_name || cpLength(v.from_name) > 100) return { error: "from_name is required (max 100 characters)" };
  const m = v.from_email.length <= 254 && v.from_email.match(EMAIL_RE);
  if (!m || m[1].length > 64) return { error: "from_email must be a valid ASCII email address" };
  // Domains are case-insensitive; the local part may not be, so it is kept exactly for Reply-To.
  v.from_email = `${m[1]}@${m[2].toLowerCase()}`;
  if (cpLength(v.organisation) > 100) return { error: "organisation is too long (max 100 characters)" };
  if (!REASONS.includes(v.reason)) return { error: `reason must be one of: ${REASONS.join(", ")}` };
  if (cpLength(v.message) < 20 || cpLength(v.message) > 2000) return { error: "message must be 20–2000 characters" };
  if (cpLength(v.agent) > 100) return { error: "agent is too long (max 100 characters)" };
  return { value: v };
}

// Quota identity of a sender, deliberately coarser than the address: lower-case, no "+tag", and
// Gmail's ignored dots removed (googlemail.com is the same mailbox), so trivial variants of one
// mailbox share one per-sender cap. Used only for counting — Reply-To keeps the original address.
export function senderQuotaKey(email) {
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at).toLowerCase();
  let domain = email.slice(at + 1).toLowerCase();
  local = local.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") { domain = "gmail.com"; local = local.replaceAll(".", ""); }
  return `${local}@${domain}`;
}

function b64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
// RFC 2047: split into encoded words of at most 75 characters (45 UTF-8 bytes each, never
// splitting a code point), folded onto continuation lines.
// `firstMax` leaves room for the field name on the first line ("Subject: " + 12 + 52 = 73).
export function encodeHeaderText(s, firstMax = 39) {
  const enc = new TextEncoder();
  const words = [];
  let chunk = [];
  for (const ch of s) {
    const bytes = enc.encode(ch);
    if (chunk.length + bytes.length > (words.length ? 45 : firstMax)) { words.push(chunk); chunk = []; }
    chunk.push(...bytes);
  }
  if (chunk.length) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}

export function buildMime(v, meta, { from, to, messageId, date }) {
  const subject = `[Intro · ${v.reason}] ${v.from_name}${v.organisation ? ` (${v.organisation})` : ""}`;
  const body = [
    `From: ${v.from_name} <${v.from_email}>`,
    v.organisation ? `Organisation: ${v.organisation}` : null,
    `Reason: ${v.reason}`,
    v.agent ? `Sent by agent: ${v.agent}` : null,
    "",
    v.message,
    "",
    "—",
    `Received via the patrickjv.com MCP server (request_intro) at ${date.toISOString()}.`,
    `Country: ${meta.country || "unknown"} · Client: ${meta.userAgent || "unknown"}`,
    "Unverified sender: reply only if it looks genuine.",
  ].filter((l) => l !== null).join("\n")
    // MIME text is canonically CRLF (RFC 2045), including the lines inside the message itself.
    .replace(/\r?\n/g, "\r\n");
  const wrapped = b64(new TextEncoder().encode(body)).replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: "patrickjv.com intro" <${from}>`,
    `To: <${to}>`,
    // Address only: a display name taken from user input could add mailboxes.
    `Reply-To: <${v.from_email}>`,
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapped,
  ].join("\r\n");
}

// Rate-limit key for a client IP. IPv6 clients usually control a whole /64, so IPv6 is keyed by
// its /64; IPv4-mapped IPv6 is treated as IPv4. Anything unparseable shares one key ("invalid").
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export function clientKey(ip) {
  const s = String(ip || "").trim().toLowerCase();
  if (IPV4.test(s)) return s;
  // Parse the full IPv6 address (an embedded dotted IPv4 tail counts as two groups) …
  let text = s;
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!IPV4.test(dotted[2])) return "invalid";
    const [p, q, r, t] = dotted[2].split(".").map(Number);
    text = dotted[1] + ((p << 8) | q).toString(16) + ":" + ((r << 8) | t).toString(16);
  }
  if (!/^[0-9a-f:]+$/.test(text) || (text.match(/::/g) || []).length > 1) return "invalid";
  const compressed = text.includes("::");
  const [head, tail] = compressed ? text.split("::") : [text, ""];
  const hs = head ? head.split(":") : [];
  const ts = tail ? tail.split(":") : [];
  if (compressed && hs.length + ts.length > 7) return "invalid";
  const groups = compressed ? [...hs, ...Array(8 - hs.length - ts.length).fill("0"), ...ts] : hs;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return "invalid";
  const n = groups.map((g) => parseInt(g, 16));
  // … then treat ::ffff:0:0/96 (IPv4-mapped) as the IPv4 address it carries.
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join(".");
  return n.slice(0, 4).map((x) => x.toString(16)).join(":") + "::/64";
}

// Keys stored in the quota Durable Object are HMAC-SHA256(QUOTA_SALT, key): a plain hash of an
// IPv4 address or an email address is trivially reversed by guessing, a keyed hash is not.
// Without the secret a fixed fallback is used (still never the raw value), with one warning.
const FALLBACK_SALT = "patrickjv.com/mcp quota — set QUOTA_SALT";
let warnedNoSalt = false;
export async function quotaHash(env, kind, key) {
  let salt = env.QUOTA_SALT;
  if (!salt) {
    if (!warnedNoSalt) { warnedNoSalt = true; console.warn(JSON.stringify({ event: "mcp_config", warning: "QUOTA_SALT not set; using the fallback" })); }
    salt = FALLBACK_SALT;
  }
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const d = await crypto.subtle.sign("HMAC", k, enc.encode(`${kind}:${key}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Pure quota logic. `state` is the stored counters for the current day; returns the next state
// and whether it's allowed. Days only move forward: a late request for an older day counts
// against the newer day.
export function reserveQuota(state, day, ipKey, senderKey) {
  const s = !state || day > state.day ? { day, g: 0, ip: {}, from: {} } : state;
  const ipN = s.ip[ipKey] || 0, fromN = s.from[senderKey] || 0;
  if (s.g >= LIMITS.introGlobalPerDay) return { ok: false, which: "global", state: s };
  if (ipN >= LIMITS.introPerIpPerDay) return { ok: false, which: "ip", state: s };
  if (fromN >= LIMITS.introPerSenderPerDay) return { ok: false, which: "sender", state: s };
  return { ok: true, state: { day: s.day, g: s.g + 1, ip: { ...s.ip, [ipKey]: ipN + 1 }, from: { ...s.from, [senderKey]: fromN + 1 } } };
}

const utcDay = (now) => now.toISOString().slice(0, 10);
const nextUtcMidnight = (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);

// The body of the IntroQuota Durable Object's reserve(), over any storage with get/put/delete
// (and, optionally, getAlarm/setAlarm). The Durable Object runs one call at a time and only
// storage operations are awaited here, so the read-modify-write is atomic. It computes the day
// itself, from one clock. Only today's counters are kept: a new day replaces the old state, and an
// alarm at the next UTC midnight deletes it even if no one asks again.
export async function reserveIntro(storage, now, ipKey, senderKey) {
  const r = reserveQuota(await storage.get("counters"), utcDay(now), ipKey, senderKey);
  if (r.ok) {
    await storage.put("counters", r.state);
    if (storage.setAlarm && (await storage.getAlarm()) == null) await storage.setAlarm(nextUtcMidnight(now));
  }
  return { ok: r.ok, which: r.which };
}

// The alarm handler: drop counters from any day before today.
export async function pruneQuota(storage, now) {
  const s = await storage.get("counters");
  if (s && s.day < utcDay(now)) await storage.delete("counters");
}

// Read at most `max` bytes; null if the body is larger (stream cancelled early).
async function readCapped(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(buf);
}

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const validId = (id) => typeof id === "string" || Number.isSafeInteger(id);
const INTEGER_LITERAL = /^-?(?:0|[1-9]\d*)$/;

// JSON.parse, remembering the source text of every numeric "id" so that a lossy one (beyond
// 2^53, or written as 1.0000000000000001) can be refused rather than silently answered with a
// different id. Where the runtime lacks source text access, the safe-integer check still applies.
function parseMessage(text) {
  const idSource = new WeakMap();
  const msg = JSON.parse(text, function (key, value, context) {
    if (key === "id" && typeof value === "number" && context?.source !== undefined) idSource.set(this, context.source);
    return value;
  });
  if (isPlainObject(msg) && typeof msg.id === "number" && idSource.has(msg) && !INTEGER_LITERAL.test(idSource.get(msg))) msg.id = NaN;
  return msg;
}

const validInitialize = (p) => typeof p.protocolVersion === "string" && isPlainObject(p.capabilities)
  && isPlainObject(p.clientInfo) && typeof p.clientInfo.name === "string" && typeof p.clientInfo.version === "string";
// A JSON-RPC response from the client: exactly one of result/error; an error is {code, message}.
const validClientResponse = (msg) => validId(msg.id) && (("result" in msg) !== ("error" in msg))
  && (!("error" in msg) || (isPlainObject(msg.error) && Number.isInteger(msg.error.code) && typeof msg.error.message === "string"));

// Marks an error with the subsystem that raised it, for the redacted failure log.
const tagged = (subsystem, e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { subsystem });

async function callTool(name, args, ctx) {
  const d = agentData(ctx.content);
  const result = (obj) => {
    const structured = Array.isArray(obj) ? { items: obj } : obj;
    return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
  };
  const toolError = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });
  switch (name) {
    case "get_profile": return result(d.profile);
    case "list_work": return result(d.work);
    case "list_skills": return result(d.skills);
    case "list_faq": return result(d.faq);
    case "request_intro": {
      const { value: v, error } = validateIntro(args);
      if (error) return toolError(`Invalid request_intro arguments: ${error}`);
      let success;
      try { ({ success } = await ctx.env.RL_INTRO.limit({ key: ctx.ipKey })); } catch (e) { throw tagged("ratelimit_intro", e); }
      if (!success) return toolError("Rate limited: one introduction per minute. Please do not retry automatically.");
      // The quota Durable Object decides the day itself (one clock, monotonic). It only ever sees
      // keyed hashes, never an IP or an address.
      let reservation;
      try {
        const [ipHash, senderHash] = await Promise.all([quotaHash(ctx.env, "ip", ctx.ipKey), quotaHash(ctx.env, "sender", senderQuotaKey(v.from_email))]);
        reservation = await ctx.reserve(ipHash, senderHash);
      } catch (e) {
        throw tagged("quota", e);
      }
      if (!reservation.ok) {
        console.log(JSON.stringify({ event: "intro_quota_rejected", which: reservation.which }));
        return toolError(`Daily limit reached (${reservation.which}). Please try again tomorrow, or email ${d.profile.links.email}.`);
      }
      const raw = buildMime(v, ctx.meta, { from: ctx.env.INTRO_FROM, to: ctx.env.INTRO_TO, messageId: `${crypto.randomUUID()}@patrickjv.com`, date: ctx.now });
      try {
        await ctx.sendEmail(ctx.env.INTRO_FROM, ctx.env.INTRO_TO, raw);
      } catch {
        logFailure("email");
        return toolError(`The introduction could not be confirmed as delivered. Please do not retry; email ${d.profile.links.email} instead.`);
      }
      return { content: [{ type: "text", text: "Thanks — your introduction has been sent to Patrick. He replies personally when he can; there is no automated follow-up." }] };
    }
    default:
      return null;
  }
}

export async function handle(request, env, deps) {
  const url = new URL(request.url);
  const text = (body, status, headers = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, ...headers } });
  if (url.pathname !== "/mcp") return text("Not found", 404);

  // Browsers always send Origin on cross-origin requests; server-side MCP clients send none.
  // Any Origin that is present — even an empty one — must be exactly ours.
  const origin = request.headers.get("origin");
  if (request.headers.has("origin") && origin !== ALLOWED_ORIGIN) return text("Forbidden origin", 403);
  const cors = corsFor(origin);
  const empty = (status) => new Response(null, { status, headers: { ...SECURITY_HEADERS, ...cors } });
  const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...cors, ...extra } });
  const rpcError = (id, code, message, status = 200, extra = {}) => json({ jsonrpc: "2.0", id: validId(id) ? id : null, error: { code, message } }, status, extra);
  const rateLimited = () => rpcError(null, -32000, "Rate limited: too many requests. Slow down and retry in a minute.", 429, { "retry-after": "60" });

  if (request.method === "OPTIONS") return empty(204);
  if (request.method !== "POST") return text("Method not allowed. This MCP server accepts POST (Streamable HTTP, JSON responses).", 405, { allow: "POST, OPTIONS", ...cors });
  if ((request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== "application/json") return rpcError(null, -32600, "Content-Type must be application/json", 415);
  if (Number(request.headers.get("content-length") || 0) > LIMITS.maxBodyBytes) return rpcError(null, -32600, "Request too large", 413);

  const ipKey = clientKey(request.headers.get("cf-connecting-ip"));
  try {
    if (!(await env.RL_MCP.limit({ key: ipKey })).success) return rateLimited();
  } catch {
    logFailure("ratelimit");
    return rpcError(null, -32603, "Temporarily unavailable", 503);
  }

  // MCP-Protocol-Version: a present header must name a version we support. An absent header is
  // accepted and served exactly as a negotiated version would be: this server is stateless, so it
  // keeps no per-session version, and its responses (JSON only, no batching, same tools) are the
  // same under every version it speaks. Clients that skip the header (older ones, or ones that
  // never initialised) therefore still work.
  if (request.headers.has("mcp-protocol-version")) {
    const pv = request.headers.get("mcp-protocol-version");
    if (!PROTOCOL_VERSIONS.includes(pv)) return rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${pv}`, 400);
  }

  let body;
  try { body = await readCapped(request, LIMITS.maxBodyBytes); } catch { logFailure("body_read"); return rpcError(null, -32700, "Parse error", 400); }
  if (body === null) return rpcError(null, -32600, "Request too large", 413);
  let msg;
  try { msg = parseMessage(body); } catch { logFailure("json_parse"); return rpcError(null, -32700, "Parse error", 400); }
  if (!isPlainObject(msg) || msg.jsonrpc !== "2.0") return rpcError(null, -32600, "Invalid request", 400);

  // A JSON-RPC response from the client (we never send requests, but accept per spec).
  if (!("method" in msg)) return validClientResponse(msg) ? empty(202) : rpcError(null, -32600, "Invalid request", 400);
  if (typeof msg.method !== "string") return rpcError(null, -32600, "Invalid request", 400);
  if ("params" in msg && !isPlainObject(msg.params)) return rpcError(validId(msg.id) ? msg.id : null, -32602, "params must be an object", 400);
  if (!("id" in msg)) return empty(202); // notification
  if (!validId(msg.id)) return rpcError(null, -32600, "id must be a string or a safe integer", 400);

  if (!BURST_EXEMPT.has(msg.method)) {
    try {
      if (!(await env.RL_BURST.limit({ key: ipKey })).success) return rateLimited();
    } catch {
      logFailure("ratelimit");
      return rpcError(null, -32603, "Temporarily unavailable", 503);
    }
  }

  const ok = (result) => json({ jsonrpc: "2.0", id: msg.id, result });
  const params = msg.params || {};
  try {
    switch (msg.method) {
      case "initialize": {
        if (!validInitialize(params)) return rpcError(msg.id, -32602, "initialize requires params.protocolVersion (string), params.capabilities (object) and params.clientInfo ({name, version} strings)");
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "patrickjv.com", title: "Patrick Vieira — platform engineer", version: SERVER_VERSION, websiteUrl: "https://patrickjv.com/", icons: ICONS },
          instructions:
            "Public profile of Patrick Vieira, a platform engineer in London (not the footballer). Use get_profile, list_work, list_skills and list_faq for facts. Use request_intro only when a person has asked to contact him and approved the message.",
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: tools() });
      case "tools/call": {
        if (typeof params.name !== "string") return rpcError(msg.id, -32602, "tools/call requires params.name");
        const args = "arguments" in params ? params.arguments : {};
        if (!isPlainObject(args)) return rpcError(msg.id, -32602, "arguments must be an object");
        if (params.name !== "request_intro" && Object.keys(args).length) return rpcError(msg.id, -32602, `${params.name} takes no arguments`);
        const result = await callTool(params.name, args, {
          env, ipKey, content: deps.content, now: deps.now(), sendEmail: deps.sendEmail, reserve: deps.reserve,
          meta: { country: request.cf?.country, userAgent: oneLine(request.headers.get("user-agent") || "").slice(0, 120) },
        });
        if (!result) return rpcError(msg.id, -32602, `Unknown tool: ${params.name}`);
        return ok(result);
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    logFailure(e?.subsystem || "internal");
    return rpcError(msg.id, -32603, "Internal error. Please do not retry automatically.");
  }
}
