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
import bookingJson from "../booking.json" with { type: "json" };
import { validateConfig, withOffset } from "./booking-config.js";
import { capAlertEmail } from "./booking-email.js";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];
export const ALLOWED_ORIGIN = "https://patrickjv.com";
export const SERVER_VERSION = serverJson.version;
// Booking rules (F-001), validated once at load: a bad booking.json fails the build and the tests.
export const BOOKING_CONFIG = validateConfig(bookingJson);
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
        "Send Patrick Vieira a short introduction by email on behalf of a person. Only use this when the person has asked you to contact him and has approved the message. Strictly rate-limited; at most a couple per sender per day. Do not retry on error. Privacy: the message is forwarded to Patrick's email and not stored by this site; rate-limit counters are hashed and expire daily.",
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
    // Booking (F-001). The operations are bookingOps below, shared with the HTTP API.
    { name: "list_meeting_types", title: "Meeting types", description: "The kinds of meeting you can book with Patrick Vieira: id, title, length in minutes and what each is for.", inputSchema: empty, annotations: READ_ONLY, icons: ICONS },
    {
      name: "get_availability",
      title: "Free times",
      description: "Free start times for a meeting type, from Patrick's live calendar: weekdays 10:00–17:00 London time, at least 24 hours ahead and up to four weeks out. Times are ISO 8601 with the Europe/London offset. Optional from and to (YYYY-MM-DD, London days) narrow the range.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { type: "string", enum: BOOKING_TYPE_IDS, description: "A meeting type id from list_meeting_types." },
          from: { type: "string", pattern: DAY_PATTERN, description: "Optional first day, YYYY-MM-DD." },
          to: { type: "string", pattern: DAY_PATTERN, description: "Optional last day, YYYY-MM-DD." },
        },
      },
      annotations: READ_ONLY,
      icons: ICONS,
    },
    {
      name: "book_meeting",
      title: "Book a meeting",
      description:
        "Hold a time with Patrick Vieira for a person. Nothing is booked and no invite is sent until that person clicks the confirmation link this emails them; the hold lapses after 2 hours. Only use this when the person has asked for this meeting at this time and given you their name and email address. One pending hold per person at a time, and a few requests a day. Do not retry on error. Use get_booking_status to see whether they confirmed. Privacy: the site keeps the name, email address, time and note until 30 days after the meeting (or after an unconfirmed hold lapses); rate-limit counters are hashed. See https://patrickjv.com/privacy.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["type", "start", "name", "email"],
        properties: {
          type: { type: "string", enum: BOOKING_TYPE_IDS, description: "A meeting type id from list_meeting_types." },
          start: { type: "string", maxLength: 40, description: "Start time exactly as given by get_availability (ISO 8601 with offset)." },
          name: { type: "string", minLength: 1, maxLength: 100, description: "The person's full name." },
          email: { type: "string", maxLength: 254, description: "The person's email address (ASCII). The confirmation link goes here." },
          note: { type: "string", maxLength: 500, description: "Optional: what the meeting is about, in plain text." },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      icons: ICONS,
    },
    {
      name: "get_booking_status",
      title: "Booking status",
      description: "The state of a booking by its ID: pending_confirmation, confirmed, declined, expired or cancelled, with a reason where there is one, the time and the meeting type. Never returns the guest's details.",
      inputSchema: BOOKING_ID_SCHEMA,
      annotations: READ_ONLY,
      icons: ICONS,
    },
    {
      name: "cancel_booking",
      title: "Cancel a booking",
      description: "Withdraw a booking. A hold that hasn't been confirmed is withdrawn at once. A confirmed meeting is not cancelled by this call: the guest is emailed a link, and only that link cancels it. Only use this when the person has asked to cancel. Do not retry on error.",
      inputSchema: BOOKING_ID_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      icons: ICONS,
    },
  ];
}
const BOOKING_TYPE_IDS = BOOKING_CONFIG.meetingTypes.map((t) => t.id);
const DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const BOOKING_ID_SCHEMA = {
  type: "object", additionalProperties: false, required: ["booking_id"],
  properties: { booking_id: { type: "string", pattern: "^[0-9a-f]{32}$", description: "The booking_id book_meeting returned." } },
};

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

export function buildMime(v, { from, to, messageId, date }) {
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
// IPv4 address or an email address is trivially reversed by guessing, a keyed hash is not — but
// only while the key is secret. There is no fallback key (a key in public source protects
// nothing): without a QUOTA_SALT of at least 32 characters, request_intro is refused.
export const MIN_SALT_LENGTH = 32;
export const saltConfigured = (env) => typeof env.QUOTA_SALT === "string" && env.QUOTA_SALT.length >= MIN_SALT_LENGTH;
export async function quotaHash(env, kind, key) {
  if (!saltConfigured(env)) throw new Error("QUOTA_SALT is missing or too short");
  const salt = env.QUOTA_SALT;
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const d = await crypto.subtle.sign("HMAC", k, enc.encode(`${kind}:${key}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Readiness of request_intro, for monitoring (the patrickjv/health method): whether each piece it
// needs is configured. Booleans only — never a secret, its length, an address or a binding's state.
// It says the configuration is in place, not that an email would be delivered.
export function introReadiness(env) {
  const r = {
    salt: saltConfigured(env),
    email: typeof env.EMAIL?.send === "function" && typeof env.INTRO_FROM === "string" && env.INTRO_FROM !== ""
      && typeof env.INTRO_TO_ADDRESS === "string" && env.INTRO_TO_ADDRESS !== "",
    quota: typeof env.QUOTA?.idFromName === "function" && typeof env.QUOTA?.get === "function",
    rateLimits: ["RL_INTRO", "RL_MCP", "RL_BURST"].every((k) => typeof env[k]?.limit === "function"),
  };
  return { introReady: r.salt && r.email && r.quota && r.rateLimits, ...r };
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

// The body of the IntroQuota Durable Object's reserve(), over any storage with get/put/delete
// (and, optionally, getAlarm/setAlarm). The Durable Object runs one call at a time and only
// storage operations are awaited here, so the read-modify-write is atomic. It computes the day
// itself, from one clock. Only today's counters are kept: a new day replaces the old state, and an
// alarm at the end of the stored day deletes it even if no one asks again.
//
// Invariant: whenever counters are stored, an alarm is set no earlier than the end of their day.
// A Durable Object has ONE alarm, so a reservation just after midnight must move a still-pending
// alarm from the old day forward (otherwise that delayed alarm would fire, keep today's counters
// and leave nothing scheduled), and counters stored before alarms existed get one on the next call.
const endOfDay = (day) => Date.parse(`${day}T00:00:00Z`) + 864e5;
async function ensureAlarm(storage, day) {
  if (!storage.setAlarm) return;
  const end = endOfDay(day);
  const current = await storage.getAlarm();
  if (current == null || current < end) await storage.setAlarm(end);
}

export async function reserveIntro(storage, now, ipKey, senderKey) {
  const stored = await storage.get("counters");
  const r = reserveQuota(stored, utcDay(now), ipKey, senderKey);
  if (r.ok) await storage.put("counters", r.state);
  if (r.ok || stored) await ensureAlarm(storage, r.state.day);
  return { ok: r.ok, which: r.which };
}

// The alarm handler: drop counters from any day before today; if today's survive (the alarm ran
// late, or early), schedule the next one at the end of today.
export async function pruneQuota(storage, now) {
  const s = await storage.get("counters");
  if (!s) return;
  if (s.day < utcDay(now)) await storage.delete("counters");
  else await ensureAlarm(storage, s.day);
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
      // Fail closed on missing configuration: without a secret quota key the counters would be
      // keyed by a guessable value, so nothing is counted, reserved or sent.
      if (!saltConfigured(ctx.env)) {
        logFailure("config");
        return toolError(`request_intro is temporarily unavailable. Please do not retry; email ${d.profile.links.email} instead.`);
      }
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
      const raw = buildMime(v, { from: ctx.env.INTRO_FROM, to: ctx.env.INTRO_TO_ADDRESS, messageId: `${crypto.randomUUID()}@patrickjv.com`, date: ctx.now });
      try {
        await ctx.sendEmail(ctx.env.INTRO_FROM, ctx.env.INTRO_TO_ADDRESS, raw);
      } catch {
        logFailure("email");
        return toolError(`The introduction could not be confirmed as delivered. Please do not retry; email ${d.profile.links.email} instead.`);
      }
      return { content: [{ type: "text", text: "Thanks — your introduction has been sent to Patrick. He replies personally when he can; there is no automated follow-up." }] };
    }
    case "list_meeting_types": return result(meetingTypes());
    case "get_availability": return bookingResult(await bookingOps.availability(ctx, args));
    case "book_meeting": return bookingResult(await bookingOps.book(ctx, args, "mcp"));
    case "get_booking_status": return bookingResult(await bookingOps.status(ctx, args));
    case "cancel_booking": return bookingResult(await bookingOps.cancel(ctx, args));
    default:
      return null;
  }
}

// A booking operation's {status, body} as a tool result: the body as structuredContent, and on
// failure a tool error that names the error and asks agents not to retry.
function bookingResult(r) {
  if (r.status < 300) return { content: [{ type: "text", text: JSON.stringify(r.body) }], structuredContent: r.body };
  return { content: [{ type: "text", text: `${r.body.message} (${r.body.error}) Do not retry automatically.` }], structuredContent: r.body, isError: true };
}
// Booking is hidden from MCP clients until launch (BOOKING_ENABLED): not listed, not described in
// the instructions, and a call names the kill switch rather than "unknown tool".
const BOOKING_TOOL_NAMES = new Set(["list_meeting_types", "get_availability", "book_meeting", "get_booking_status", "cancel_booking"]);
const INSTRUCTIONS = "Public profile of Patrick Vieira, a platform engineer in London (not the footballer). Use get_profile, list_work, list_skills and list_faq for facts. Use request_intro only when a person has asked to contact him and approved the message.";
const BOOKING_INSTRUCTIONS = " To book a meeting, use list_meeting_types and get_availability, then book_meeting only when a person has asked for that meeting; they confirm it from their own inbox.";
// Tools that take no arguments: a non-empty arguments object is a protocol error.
const NO_ARGUMENTS = new Set(["get_profile", "list_work", "list_skills", "list_faq", "list_meeting_types"]);

// ---------------------------------------------------------------------------------------------
// Booking (F-001). Every booking operation runs in the BookingStore Durable Object (deps.booking()
// returns its stub); the Worker validates, applies the kill switch, keys the quota with HMACs and
// formats times. The MCP tools and the HTTP API call the same operations below, which return
// {status, body}: an HTTP status and either the result or {error, message}.
// ---------------------------------------------------------------------------------------------
export const bookingEnabled = (env) => env.BOOKING_ENABLED === "true";
// Secrets (and the BOOKING_FROM var) booking needs, plus each blocking calendar's ID secret.
export const BOOKING_SECRETS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "RESEND_API_KEY", "BOOKING_OWNER_EMAIL", "BOOKING_FROM",
  ...BOOKING_CONFIG.calendars.filter((c) => c.blocks && c.idSecret).map((c) => c.idSecret)];
export function bookingConfigured(env) {
  return saltConfigured(env) && BOOKING_SECRETS.every((k) => typeof env[k] === "string" && env[k] !== "")
    && typeof env.BOOKING?.idFromName === "function" && typeof env.BOOKING?.get === "function";
}

const TZ = BOOKING_CONFIG.timezone;
const TYPE_IDS = BOOKING_CONFIG.meetingTypes.map((t) => t.id);
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const validDay = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
  && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
export const BOOKING_ID = /^[0-9a-f]{32}$/;
// Link tokens are 128-bit base64url (22 characters); anything else is refused without a lookup.
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

// Plain-object arguments with only known fields, all strings.
function fieldsError(args, allowed) {
  if (!isPlainObject(args)) return "arguments must be an object";
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length) return `unknown field(s): ${extra.join(", ")}`;
  for (const k of Object.keys(args)) if (typeof args[k] !== "string") return `${k} must be a string`;
  return null;
}
// The same address rules as request_intro: ASCII dot-atom, domain lower-cased.
function normaliseEmail(s) {
  const e = s.trim();
  const m = e.length <= 254 && e.match(EMAIL_RE);
  return m && m[1].length <= 64 ? `${m[1]}@${m[2].toLowerCase()}` : null;
}

export function validateBooking(args) {
  const bad = fieldsError(args, ["type", "start", "name", "email", "note"]);
  if (bad) return { error: bad };
  if (!TYPE_IDS.includes(args.type)) return { error: `type must be one of: ${TYPE_IDS.join(", ")}` };
  if (typeof args.start !== "string" || !ISO_WITH_OFFSET.test(args.start) || Number.isNaN(Date.parse(args.start)))
    return { error: "start must be an ISO 8601 date-time with an offset, as given by get_availability" };
  const name = oneLine(args.name ?? "");
  if (!name || cpLength(name) > 100) return { error: "name is required (max 100 characters)" };
  const email = normaliseEmail(args.email ?? "");
  if (!email) return { error: "email must be a valid ASCII email address" };
  // Plain text: LF newlines, no control characters. Shown only as text, never as HTML.
  const note = (args.note ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (cpLength(note) > 500) return { error: "note is too long (max 500 characters)" };
  return { value: { type: args.type, start: new Date(Date.parse(args.start)).toISOString(), name, email, ...(note ? { note } : {}) } };
}

export function validateAvailability(args) {
  const bad = fieldsError(args, ["type", "from", "to"]);
  if (bad) return { error: bad };
  if (!TYPE_IDS.includes(args.type)) return { error: `type must be one of: ${TYPE_IDS.join(", ")}` };
  for (const k of ["from", "to"]) if (k in args && !validDay(args[k])) return { error: `${k} must be a date, YYYY-MM-DD` };
  return { value: { type: args.type, from: args.from, to: args.to } };
}

function validateBookingId(args) {
  const bad = fieldsError(args, ["booking_id"]);
  if (bad) return { error: bad };
  if (!BOOKING_ID.test(args.booking_id ?? "")) return { error: "booking_id must be the 32-character ID book_meeting returned" };
  return { value: args.booking_id };
}

const BOOKING_ERRORS = {
  booking_disabled: [503, "Booking isn't open yet."],
  unavailable: [503, "Booking is unavailable right now. Please try again later."],
  email_failed: [503, "The confirmation email couldn't be sent, so nothing was held. Please try again later."],
  slot_taken: [409, "That time is no longer free. Please choose another."],
  hold_pending: [429, "A booking for this email address or connection is already waiting to be confirmed. Confirm or decline it from the email first."],
  not_found: [404, "No booking has that ID."],
  not_cancellable: [409, "This booking can't be cancelled: it isn't a pending hold or a meeting still to come."],
};
function bookingFailure(r) {
  const out = (status, message) => ({ status, body: { error: r.error, message, ...(r.reason ? { reason: r.reason } : {}), ...(r.status ? { status: r.status } : {}) } });
  if (r.error === "invalid_input") return out(400, r.message);
  if (r.error === "rate_limited") {
    return out(429, r.reason === "global" ? "Booking is closed for today. Please try again tomorrow."
      : `Too many booking requests today from this ${r.reason === "ip" ? "connection" : "email address"}. Please try again tomorrow.`);
  }
  // A slot that has slipped inside the notice window or past the horizon is "gone" (409), so the
  // page reloads the slots; a start that was never a slot is a malformed request (400).
  if (r.error === "invalid_slot") {
    return ["notice", "horizon"].includes(r.reason) ? out(409, "That time can no longer be booked. Please choose another.")
      : out(400, "start isn't a bookable time for this meeting type. Use a start time from get_availability.");
  }
  const [status, message] = BOOKING_ERRORS[r.error] ?? [503, BOOKING_ERRORS.unavailable[1]];
  return out(status, message);
}
const invalid = (message) => bookingFailure({ error: "invalid_input", message });
const failed = (error) => bookingFailure({ error });

// Calls the BookingStore. A failure to reach it, or an exception inside it, is 503.
async function viaStore(ctx, subsystem, fn) {
  try {
    return await fn(ctx.booking());
  } catch {
    logFailure(subsystem);
    return failed("unavailable");
  }
}

const meetingTypes = () => BOOKING_CONFIG.meetingTypes.map(({ id, title, minutes, description }) => ({ id, title, minutes, description }));
const localSlot = (s) => ({ start: withOffset(s.start, TZ), end: withOffset(s.end, TZ) });

const bookingOps = {
  // `enabled` lets the /book page and the homepage's WebMCP script stay hidden until launch.
  types: (ctx) => ({ status: 200, body: { enabled: bookingEnabled(ctx.env), types: meetingTypes() } }),

  async availability(ctx, args) {
    const { value: v, error } = validateAvailability(args);
    if (error) return invalid(error);
    if (!bookingConfigured(ctx.env)) return failed("unavailable");
    return viaStore(ctx, "availability", async (store) => {
      const { slots } = await store.availability(v.type, v.from, v.to);
      return { status: 200, body: { timezone: TZ, slots: slots.map(localSlot) } };
    });
  },

  async book(ctx, args, source) {
    if (!bookingEnabled(ctx.env)) return failed("booking_disabled");
    const { value: v, error } = validateBooking(args);
    if (error) return invalid(error);
    if (!bookingConfigured(ctx.env)) { logFailure("config"); return failed("unavailable"); }
    return viaStore(ctx, "booking_store", async (store) => {
      // The store only ever sees keyed hashes, never an IP or an address.
      const [ipKey, emailKey] = await Promise.all([quotaHash(ctx.env, "booking-ip", ctx.ipKey), quotaHash(ctx.env, "booking-email", senderQuotaKey(v.email))]);
      const { globalJustExhausted, ...r } = await store.request({ ...v, source }, ipKey, emailKey);
      if (globalJustExhausted) await sendCapAlert(ctx);
      if (r.error) {
        if (r.error === "rate_limited") console.log(JSON.stringify({ event: "booking_quota_rejected", which: r.reason }));
        return bookingFailure(r);
      }
      return { status: 202, body: { booking_id: r.booking_id, status: r.status, hold_expires: withOffset(r.hold_expires, TZ) } };
    });
  },

  async status(ctx, args) {
    const { value: id, error } = validateBookingId(args);
    if (error) return invalid(error);
    return viaStore(ctx, "booking_store", async (store) => {
      const s = await store.status(id);
      if (!s) return failed("not_found");
      return { status: 200, body: { status: s.status, ...(s.status_reason ? { status_reason: s.status_reason } : {}), start: withOffset(s.start, TZ), end: withOffset(s.end, TZ), type: s.type } };
    });
  },

  async cancel(ctx, args) {
    if (!bookingEnabled(ctx.env)) return failed("booking_disabled");
    const { value: id, error } = validateBookingId(args);
    if (error) return invalid(error);
    if (!bookingConfigured(ctx.env)) { logFailure("config"); return failed("unavailable"); }
    return viaStore(ctx, "booking_store", async (store) => {
      const r = await store.cancel(id);
      return r.error ? bookingFailure(r) : { status: 200, body: r };
    });
  },
};

// Health for booking: bookingEnabled is the kill switch; bookingReady says booking would work if
// switched on: every secret set (QUOTA_SALT included), and, only then, the BookingStore answers
// and a fresh Google token refresh succeeds (cached in the store for a minute), and guest email
// hasn't failed 3 times in a row. Independent of the flag, so readiness can be checked before
// launch. Booleans only.
async function bookingReadiness(env, deps) {
  let ready = false;
  if (bookingConfigured(env)) {
    try {
      const h = await deps.booking().health();
      ready = h.google === true && h.email === true;
    } catch { logFailure("booking_store"); }
  }
  return { bookingEnabled: bookingEnabled(env), bookingReady: ready };
}

// Patrick's alert when the global cap is first reached (the store reports that once a day): to
// INTRO_TO_ADDRESS through the send_email binding, like introductions. Failure is logged, never
// passed on: the request that hit the cap still gets its own answer.
export function buildAlertMime({ subject, text }, { from, to, messageId, date }) {
  const wrapped = b64(new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"))).replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: "patrickjv.com booking" <${from}>`,
    `To: <${to}>`,
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
async function sendCapAlert(ctx) {
  try {
    const { INTRO_FROM: from, INTRO_TO_ADDRESS: to } = ctx.env;
    const raw = buildAlertMime(capAlertEmail({ day: ctx.now.toISOString().slice(0, 10) }), { from, to, messageId: `${crypto.randomUUID()}@patrickjv.com`, date: ctx.now });
    await ctx.sendEmail(from, to, raw);
  } catch {
    logFailure("alert_email");
  }
}

// ---- Act pages: what an emailed link does. GET shows it with a button; only POST acts. ----
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ACT_CSS = [
  '@font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 400 600; font-display: swap; src: url(/fonts/ibm-plex-sans-latin-var.woff2) format("woff2"); }',
  ':root { --bg: #f4f3ee; --ink: #14171c; --muted: #535b66; --signal: #a64b00; --sans: "IBM Plex Sans", system-ui, sans-serif; --mono: ui-monospace, monospace; }',
  "@media (prefers-color-scheme: dark) { :root { --bg: #0c0e11; --ink: #e7e9ec; --muted: #9aa3ae; --signal: #ffb547; } }",
  "body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 1.0625rem; line-height: 1.65; }",
  ".wrap { box-sizing: border-box; max-width: 44rem; margin: 0 auto; padding: 24px 16px 64px; }",
  ".bar { font-family: var(--mono); font-size: 0.875rem; margin: 0 0 40px; }",
  "a { color: var(--signal); }",
  "h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 16px; font-weight: 600; letter-spacing: -0.01em; }",
  ".muted { color: var(--muted); }",
  "button { font: inherit; font-weight: 600; padding: 10px 20px; border: 1px solid var(--ink); border-radius: 4px; background: var(--ink); color: var(--bg); cursor: pointer; }",
  "button:focus-visible { outline: 3px solid var(--signal); outline-offset: 2px; }",
].join("\n");
let actCsp = null;
async function actPolicy() {
  if (!actCsp) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ACT_CSS));
    actCsp = `default-src 'none'; style-src 'sha256-${b64(new Uint8Array(d))}'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
  }
  return actCsp;
}

// "Wed 21 Oct 2026, 10:00–10:30 BST (09:00–09:30 UTC)", as in the booking emails.
function when(start, end) {
  const parts = (iso, timeZone, opts) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, ...opts }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const clock = (iso, timeZone) => { const p = parts(iso, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }); return { time: `${p.hour}:${p.minute}`, zone: p.timeZoneName }; };
  const d = parts(start, TZ, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const s = clock(start, TZ);
  return `${d.weekday} ${d.day} ${d.month} ${d.year}, ${s.time}–${clock(end, TZ).time} ${s.zone} (${clock(start, "UTC").time}–${clock(end, "UTC").time} UTC)`;
}

async function actPage(status, title, paragraphs, form = "") {
  const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Patrick Vieira</title>
<style>${ACT_CSS}</style>
</head>
<body>
<main class="wrap">
<p class="bar"><a href="/">patrickjv.com</a></p>
<h1>${esc(title)}</h1>
${paragraphs.join("\n")}
${form}</main>
</body>
</html>
`;
  return new Response(html, { status, headers: {
    "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS,
    "content-security-policy": await actPolicy(),
    // The form's POST must carry Origin: https://patrickjv.com; no-referrer would make it "null".
    "referrer-policy": "same-origin",
    "cache-control": "no-store", // the URL carries a token
  } });
}
const para = (s) => `<p>${s}</p>`;
const bookAgain = '<a href="/book">Book another time</a>';
const LINK_ERRORS = {
  unknown: [404, "This link isn't valid", "Check that you copied the whole link from the email."],
  used: [404, "This link has already been used", "Nothing more will happen. If you need to change something, email hello@patrickjv.com."],
  expired: [410, "This link has expired", "Holds last two hours, and cancel links work until the meeting starts."],
};
// A confirm whose Google answer was lost: the alarm finishes it within minutes, by email.
const finishing = () => actPage(202, "Your booking is being finished", [
  para("Google Calendar took too long to answer, so I'm finishing your booking in the background. There's no need to use the link again."),
  para("Check your email in a few minutes for the invite. If nothing arrives within the hour, email hello@patrickjv.com."),
]);
const linkError = (state) => { const [s, t, m] = LINK_ERRORS[state] ?? LINK_ERRORS.unknown; return actPage(s, t, [para(esc(m))]); };
const ACTIONS = {
  confirm: ["Confirm your booking", "Confirm booking", "Nothing is booked unless you confirm. If you didn't ask for this, close this page."],
  decline: ["Decline this booking", "Decline", "Nothing has been booked. Declining frees the time now rather than when the hold lapses."],
  cancel: ["Cancel your meeting", "Cancel meeting", "Google Calendar will tell everyone invited."],
  confirm_cancel: ["Cancel your meeting", "Cancel meeting", "An AI agent asked to cancel this meeting for you. It stays booked unless you cancel it here."],
};

async function showLink(ctx, token) {
  if (!TOKEN.test(token ?? "")) return linkError("unknown");
  let peek;
  try { peek = await ctx.booking().peek(token); } catch { logFailure("booking_store"); return actPage(503, "Booking is unavailable right now", [para("Please try the link again in a few minutes.")]); }
  if (peek.state === "used" && peek.action === "confirm" && peek.booking?.status === "confirming") return finishing();
  if (peek.state !== "valid" || !ACTIONS[peek.action]) return linkError(peek.state);
  const [title, button, note] = ACTIONS[peek.action];
  const type = BOOKING_CONFIG.meetingTypes.find((t) => t.id === peek.booking.type)?.title ?? peek.booking.type;
  return actPage(200, title, [para(`${esc(type)} with Patrick Vieira, ${esc(when(peek.booking.start, peek.booking.end))}.`), `<p class="muted">${esc(note)}</p>`],
    `<form method="post" action="/api/booking/act">\n<input type="hidden" name="t" value="${esc(token)}">\n<button type="submit">${esc(button)}</button>\n</form>\n`);
}

async function doLink(ctx, token) {
  if (!TOKEN.test(token ?? "")) return linkError("unknown");
  let r;
  try { r = await ctx.booking().act(token); } catch { logFailure("booking_store"); r = { error: "unavailable" }; }
  if (r.result === "confirmed") return actPage(200, "Booked", [para("Google Calendar will send you an invite from hello@patrickjv.com with the Google Meet link. I've also emailed you a link to cancel if you need to.")]);
  if (r.result === "confirming" || r.confirming) return finishing();
  if (r.result === "cancelled") return actPage(200, "Cancelled", [para("The meeting is cancelled. Google Calendar will let everyone invited know.")]);
  if (r.result === "declined" && !r.reason) return actPage(200, "Declined", [para("Nothing was booked, and the time is free again.")]);
  if (r.result === "declined") {
    return actPage(409, "That slot was taken", [para(r.reason === "day_full" ? "That day filled up before you confirmed, so nothing was booked." : "That time was taken before you confirmed, so nothing was booked."), para(bookAgain)]);
  }
  if (r.error === "unavailable") return actPage(503, "Booking is unavailable right now", [para("Nothing has changed. Please try the same link again in a few minutes.")]);
  return linkError(r.error);
}

// The HTTP API. The same rejection order as /mcp: path, Origin, method, media type, declared size,
// rate limits, then the capped body read.
const BOOKING_ROUTES = {
  "/api/booking": ["POST"], "/api/booking/types": ["GET"], "/api/booking/availability": ["GET"], "/api/booking/act": ["GET", "POST"],
  // For the page's WebMCP tools (the MCP server has get_booking_status and cancel_booking).
  "/api/booking/status": ["GET"], "/api/booking/cancel": ["POST"],
};
// The channel a request arrived on, as the browser reports it: "page" (the /book form, the
// default) or "webmcp" (the page's WebMCP tools). Self-reported, so it only picks the hold email's
// wording; consent always comes from the emailed confirmation link.
const HTTP_SOURCES = ["page", "webmcp"];

async function handleBookingHttp(request, env, deps, url) {
  const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...extra } });
  const err = (status, error, message, extra) => json(status, { error, message }, extra);
  const methods = BOOKING_ROUTES[url.pathname];
  if (!methods) return err(404, "not_found", "Not found.");
  if (request.headers.has("origin") && request.headers.get("origin") !== ALLOWED_ORIGIN) return err(403, "forbidden_origin", "Requests from other sites aren't accepted.");
  if (!methods.includes(request.method)) return err(405, "method_not_allowed", `Use ${methods.join(" or ")}.`, { allow: methods.join(", ") });
  const post = request.method === "POST";
  const isAct = url.pathname === "/api/booking/act";
  const media = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (post && !(media === "application/json" || (isAct && media === "application/x-www-form-urlencoded"))) return err(415, "unsupported_media_type", "Send JSON.");
  if (Number(request.headers.get("content-length") || 0) > LIMITS.maxBodyBytes) return err(413, "too_large", "Request too large.");

  const ipKey = clientKey(request.headers.get("cf-connecting-ip"));
  try {
    if (!(await env.RL_MCP.limit({ key: ipKey })).success) return err(429, "rate_limited", "Too many requests. Slow down and retry in a minute.", { "retry-after": "60" });
    if (post && !(await env.RL_BURST.limit({ key: ipKey })).success) return err(429, "rate_limited", "Too many requests. Slow down and retry in a minute.", { "retry-after": "60" });
  } catch {
    logFailure("ratelimit");
    return err(503, "unavailable", "Temporarily unavailable.");
  }

  let body = null;
  if (post) {
    let raw;
    try { raw = await readCapped(request, LIMITS.maxBodyBytes); } catch { logFailure("body_read"); return err(400, "invalid_input", "The request body couldn't be read."); }
    if (raw === null) return err(413, "too_large", "Request too large.");
    try { body = media === "application/json" ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { return err(400, "invalid_input", "The request body isn't valid JSON."); }
  }

  const ctx = { env, ipKey, booking: deps.booking, sendEmail: deps.sendEmail, now: deps.now() };
  if (isAct) return post ? doLink(ctx, isPlainObject(body) ? body.t : null) : showLink(ctx, url.searchParams.get("t"));
  let r;
  if (url.pathname === "/api/booking/types") r = bookingOps.types(ctx);
  else if (url.pathname === "/api/booking/availability") {
    const args = { type: url.searchParams.get("type") ?? "" };
    for (const k of ["from", "to"]) if (url.searchParams.has(k)) args[k] = url.searchParams.get(k);
    r = await bookingOps.availability(ctx, args);
  } else if (url.pathname === "/api/booking/status") {
    r = await bookingOps.status(ctx, { booking_id: url.searchParams.get("booking_id") ?? "" });
  } else if (url.pathname === "/api/booking/cancel") {
    r = await bookingOps.cancel(ctx, body);
  } else {
    let args = body, source = "page";
    if (isPlainObject(body)) ({ source = "page", ...args } = body);
    r = HTTP_SOURCES.includes(source) ? await bookingOps.book(ctx, args, source) : invalid(`source must be one of: ${HTTP_SOURCES.join(", ")}`);
  }
  return json(r.status, r.body);
}

export async function handle(request, env, deps) {
  const url = new URL(request.url);
  const text = (body, status, headers = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, ...headers } });
  if (url.pathname === "/api/booking" || url.pathname.startsWith("/api/booking/")) return handleBookingHttp(request, env, deps, url);
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
          instructions: INSTRUCTIONS + (bookingEnabled(env) ? BOOKING_INSTRUCTIONS : ""),
        });
      }
      case "ping":
        return ok({});
      // A vendor-prefixed custom method, not a tool (clients would list a tool to users) and not an
      // extension of ping (whose result MUST be empty). Other servers answer it with -32601.
      case "patrickjv/health":
        return ok({ ...introReadiness(env), ...(await bookingReadiness(env, deps)) });
      case "tools/list":
        return ok({ tools: bookingEnabled(env) ? tools() : tools().filter((t) => !BOOKING_TOOL_NAMES.has(t.name)) });
      case "tools/call": {
        if (typeof params.name !== "string") return rpcError(msg.id, -32602, "tools/call requires params.name");
        const args = "arguments" in params ? params.arguments : {};
        if (!isPlainObject(args)) return rpcError(msg.id, -32602, "arguments must be an object");
        if (BOOKING_TOOL_NAMES.has(params.name) && !bookingEnabled(env)) return ok(bookingResult(failed("booking_disabled")));
        if (NO_ARGUMENTS.has(params.name) && Object.keys(args).length) return rpcError(msg.id, -32602, `${params.name} takes no arguments`);
        const result = await callTool(params.name, args, {
          env, ipKey, content: deps.content, now: deps.now(), sendEmail: deps.sendEmail, reserve: deps.reserve, booking: deps.booking,
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
