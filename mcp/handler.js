// Remote MCP server for patrickjv.com (Streamable HTTP transport, stateless, JSON responses only).
// Read-only profile tools plus request_intro, which emails Patrick under conservative limits.
//
// Cost control: requests are rejected in the cheapest order — path, method, Origin, media type,
// declared size, per-IP rate limits — before the body is read. The body is read with a byte cap.
// request_intro reserves its daily quota atomically (Durable Object) BEFORE sending, and fails
// closed: a reservation is never refunded, so errors can only ever reduce what gets sent.
import { agentData } from "../lib/agent-data.mjs";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];
export const ALLOWED_ORIGIN = "https://patrickjv.com";
export const LIMITS = {
  maxBodyBytes: 16 * 1024,
  introPerIpPerDay: 2,
  introPerSenderPerDay: 2,
  introGlobalPerDay: 10,
};
const REASONS = ["recruiting", "collaboration", "speaking", "other"];

const corsFor = (origin) => (origin === ALLOWED_ORIGIN ? {
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
  vary: "Origin",
} : {});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function tools() {
  const empty = { type: "object", properties: {}, additionalProperties: false };
  return [
    { name: "get_profile", title: "Profile", description: "Patrick Vieira's public profile (platform engineer, London — not the footballer): name, headline, tagline, location and links.", inputSchema: empty, annotations: READ_ONLY },
    { name: "list_work", title: "Selected work", description: "Selected work: title, summary and tags for each item.", inputSchema: empty, annotations: READ_ONLY },
    { name: "list_skills", title: "Skills", description: "Patrick Vieira's listed skills.", inputSchema: empty, annotations: READ_ONLY },
    { name: "list_faq", title: "Quick answers", description: "Quick answers about Patrick Vieira: each question (q) with its answer (a).", inputSchema: empty, annotations: READ_ONLY },
    {
      name: "request_intro",
      title: "Request an introduction",
      description:
        "Send Patrick Vieira a short introduction by email on behalf of a person. Only use this when the person has asked you to contact him and has approved the message. Strictly rate-limited; at most a couple per sender per day. Do not retry on error.",
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
    },
  ];
}

// Single-line text: no control characters (prevents header injection; also tidies the body).
const oneLine = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
// ASCII-only, conservative address syntax: no quotes, spaces, brackets or commas, so it can never
// form a second mailbox or escape the angle brackets in Reply-To.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function validateIntro(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { error: "arguments must be an object" };
  const allowed = new Set(["from_name", "from_email", "organisation", "reason", "message", "agent"]);
  const extra = Object.keys(args).filter((k) => !allowed.has(k));
  if (extra.length) return { error: `unknown field(s): ${extra.join(", ")}` };
  for (const k of Object.keys(args)) if (typeof args[k] !== "string") return { error: `${k} must be a string` };
  const v = {
    from_name: oneLine(args.from_name ?? ""),
    from_email: (args.from_email ?? "").trim().toLowerCase(),
    organisation: oneLine(args.organisation ?? ""),
    reason: (args.reason ?? "").trim(),
    message: (args.message ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim(),
    agent: oneLine(args.agent ?? ""),
  };
  if (!v.from_name || v.from_name.length > 100) return { error: "from_name is required (max 100 characters)" };
  if (v.from_email.length > 254 || !EMAIL_RE.test(v.from_email)) return { error: "from_email must be a valid ASCII email address" };
  if (v.organisation.length > 100) return { error: "organisation is too long (max 100 characters)" };
  if (!REASONS.includes(v.reason)) return { error: `reason must be one of: ${REASONS.join(", ")}` };
  if (v.message.length < 20 || v.message.length > 2000) return { error: "message must be 20–2000 characters" };
  if (v.agent.length > 100) return { error: "agent is too long (max 100 characters)" };
  return { value: v };
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
  ].filter((l) => l !== null).join("\n");
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

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Pure quota logic, run inside the IntroQuota Durable Object (which serialises calls). `state`
// is the stored counters for the current day; returns the next state and whether it's allowed.
// Days only move forward: a late request for an older day counts against the newer day.
export function reserveQuota(state, day, ipKey, senderKey) {
  const s = !state || day > state.day ? { day, g: 0, ip: {}, from: {} } : state;
  const ipN = s.ip[ipKey] || 0, fromN = s.from[senderKey] || 0;
  if (s.g >= LIMITS.introGlobalPerDay) return { ok: false, which: "global", state: s };
  if (ipN >= LIMITS.introPerIpPerDay) return { ok: false, which: "ip", state: s };
  if (fromN >= LIMITS.introPerSenderPerDay) return { ok: false, which: "sender", state: s };
  return { ok: true, state: { day: s.day, g: s.g + 1, ip: { ...s.ip, [ipKey]: ipN + 1 }, from: { ...s.from, [senderKey]: fromN + 1 } } };
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
const validId = (id) => typeof id === "string" || Number.isInteger(id);

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
      const { success } = await ctx.env.RL_INTRO.limit({ key: ctx.ipKey });
      if (!success) return toolError("Rate limited: one introduction per minute. Please do not retry automatically.");
      // The quota Durable Object decides the day itself (one clock, monotonic).
      const reservation = await ctx.reserve(ctx.ipKey, await sha256(v.from_email));
      if (!reservation.ok) return toolError(`Daily limit reached (${reservation.which}). Please try again tomorrow, or email ${d.profile.links.email}.`);
      const raw = buildMime(v, ctx.meta, { from: ctx.env.INTRO_FROM, to: ctx.env.INTRO_TO, messageId: `${crypto.randomUUID()}@patrickjv.com`, date: ctx.now });
      try {
        await ctx.sendEmail(ctx.env.INTRO_FROM, ctx.env.INTRO_TO, raw);
      } catch {
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
  if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

  // Browsers always send Origin on cross-origin requests; server-side MCP clients send none.
  const origin = request.headers.get("origin");
  if (origin && origin !== ALLOWED_ORIGIN) return new Response("Forbidden origin", { status: 403 });
  const cors = corsFor(origin);
  const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors, ...extra } });
  const rpcError = (id, code, message, status = 200, extra = {}) => json({ jsonrpc: "2.0", id: validId(id) ? id : null, error: { code, message } }, status, extra);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return new Response("Method not allowed. This MCP server accepts POST (Streamable HTTP, JSON responses).", { status: 405, headers: { allow: "POST, OPTIONS", ...cors } });
  if ((request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== "application/json") return rpcError(null, -32600, "Content-Type must be application/json", 415);
  if (Number(request.headers.get("content-length") || 0) > LIMITS.maxBodyBytes) return rpcError(null, -32600, "Request too large", 413);

  const ipKey = clientKey(request.headers.get("cf-connecting-ip"));
  try {
    const [burst, minute] = await Promise.all([env.RL_BURST.limit({ key: ipKey }), env.RL_MCP.limit({ key: ipKey })]);
    if (!burst.success || !minute.success) return rpcError(null, -32000, "Rate limited: too many requests. Slow down and retry in a minute.", 429, { "retry-after": "60" });
  } catch {
    return rpcError(null, -32603, "Temporarily unavailable", 503);
  }

  const pv = request.headers.get("mcp-protocol-version");
  if (pv && !PROTOCOL_VERSIONS.includes(pv)) return rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${pv}`, 400);

  let text;
  try { text = await readCapped(request, LIMITS.maxBodyBytes); } catch { return rpcError(null, -32700, "Parse error", 400); }
  if (text === null) return rpcError(null, -32600, "Request too large", 413);
  let msg;
  try { msg = JSON.parse(text); } catch { return rpcError(null, -32700, "Parse error", 400); }
  if (!isPlainObject(msg) || msg.jsonrpc !== "2.0") return rpcError(null, -32600, "Invalid request", 400);

  // A JSON-RPC response from the client (we never send requests, but accept per spec).
  if (!("method" in msg)) {
    const isResponse = validId(msg.id) && (("result" in msg) !== ("error" in msg));
    return isResponse ? new Response(null, { status: 202, headers: cors }) : rpcError(null, -32600, "Invalid request", 400);
  }
  if (typeof msg.method !== "string") return rpcError(null, -32600, "Invalid request", 400);
  if ("params" in msg && !isPlainObject(msg.params)) return rpcError(validId(msg.id) ? msg.id : null, -32602, "params must be an object", 400);
  if (!("id" in msg)) return new Response(null, { status: 202, headers: cors }); // notification
  if (!validId(msg.id)) return rpcError(null, -32600, "id must be a string or integer", 400);

  const ok = (result) => json({ jsonrpc: "2.0", id: msg.id, result });
  const params = msg.params || {};
  try {
    switch (msg.method) {
      case "initialize": {
        if (typeof params.protocolVersion !== "string") return rpcError(msg.id, -32602, "initialize requires params.protocolVersion");
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "patrickjv.com", title: "Patrick Vieira — platform engineer", version: "1.0.0" },
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
  } catch {
    return rpcError(msg.id, -32603, "Internal error. Please do not retry automatically.");
  }
}
