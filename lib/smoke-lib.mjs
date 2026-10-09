// Pure helpers for smoke.mjs, kept separate so they can be unit-tested without a network.

// The media type of a Content-Type header: "type/subtype", lower-cased, parameters dropped.
// Exact comparison on this (not a prefix match) — "text/markdown-bogus" is not "text/markdown".
export const mediaType = (contentType) => (contentType ?? "").split(";")[0].trim().toLowerCase();

// How many Content-Security-Policy headers a response carried. fetch() joins repeated headers with
// ", ", and a comma never appears inside one policy (it is the CSP list separator), so the count
// of comma-separated parts is the number of policies the browser enforces.
export const cspCount = (value) => (value == null ? 0 : value.split(",").filter((s) => s.trim()).length);

// The CSP that public/_headers gives the path "/": Cloudflare applies every rule whose path
// matches ("/*" and "/"), joining repeated headers with ", ". (The build forbids a CSP on "/*".)
export function expectedCsp(headersText) {
  const blocks = [];
  for (const line of headersText.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) blocks.push({ path: line.trim(), lines: [] });
    else blocks.at(-1)?.lines.push(line.trim());
  }
  let values = [];
  for (const b of blocks.filter((b) => b.path === "/*" || b.path === "/")) {
    for (const l of b.lines) {
      if (/^!\s*Content-Security-Policy\s*$/i.test(l)) values = [];
      const m = l.match(/^Content-Security-Policy:\s*(.+)$/i);
      if (m) values.push(m[1].trim());
    }
  }
  return values.length ? values.join(", ") : null;
}

// A Streamable HTTP response body as one JSON-RPC message: JSON, or the last SSE "data:" event.
// Anything else (or an unparseable body) is null.
export function parseMcpBody(contentType, text) {
  try {
    const t = mediaType(contentType);
    if (t === "text/event-stream") {
      const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).at(-1);
      return data ? JSON.parse(data) : null;
    }
    if (t === "application/json" && text) return JSON.parse(text);
  } catch { /* fall through */ }
  return null;
}

// Verdict for an alias-host redirect: GET/HEAD must be 301 and every other method 308 (method and
// body kept), always to exactly `target`. Anything else is a FAIL.
export function redirectVerdict(method, status, location, target) {
  const want = method === "GET" || method === "HEAD" ? 301 : 308;
  return { ok: status === want && location === target, want };
}

// Readiness from the MCP server's patrickjv/health result: exactly the eight boolean keys,
// introReady true, and bookingReady and signinReady true when booking is switched on
// (bookingEnabled): F-002's agent booking needs the sign-in. Booking that ships dark (off) passes
// whatever its readiness. Anything else (missing method, extra or non-boolean keys) fails.
export const HEALTH_KEYS = ["introReady", "salt", "email", "quota", "rateLimits", "bookingEnabled", "bookingReady", "signinReady"];
const INTRO_PARTS = ["salt", "email", "quota", "rateLimits"];
export function healthVerdict(result) {
  const shape = result !== null && typeof result === "object" && !Array.isArray(result)
    && Object.keys(result).length === HEALTH_KEYS.length && HEALTH_KEYS.every((k) => typeof result[k] === "boolean");
  if (!shape) return { ok: false, detail: `unexpected result ${JSON.stringify(result ?? null).slice(0, 120)}` };
  const off = INTRO_PARTS.filter((k) => !result[k]);
  const intro = result.introReady ? "introReady" : `introReady false${off.length ? ` (not configured: ${off.join(", ")})` : ""}`;
  const ready = (k) => (result[k] ? k : `${k} false`);
  const booking = !result.bookingEnabled ? `booking off (bookingReady ${result.bookingReady}, signinReady ${result.signinReady})` : `booking on: ${ready("bookingReady")}, ${ready("signinReady")}`;
  return { ok: result.introReady === true && (!result.bookingEnabled || (result.bookingReady === true && result.signinReady === true)), detail: `${intro}; ${booking}` };
}

// Network Error Logging: a response must carry neither NEL nor Report-To (they make browsers send
// failure reports to a third-party endpoint). `headers` is a fetch Headers object.
export function nelVerdict(headers) {
  const present = ["nel", "report-to"].filter((h) => headers.get(h) != null);
  return { ok: present.length === 0, present };
}

// DNS-over-HTTPS JSON (application/dns-json) answers of one RR type: 43 DS, 257 CAA, 16 TXT.
export const dnsAnswers = (json, type) =>
  (json?.Status === 0 && Array.isArray(json.Answer) ? json.Answer.filter((a) => a.type === type).map((a) => String(a.data)) : []);
// DNSSEC is complete when the parent publishes a DS record AND a validating resolver marks an
// answer from inside the zone as authenticated (AD). DS absent = registrar publication pending.
export function dnssecVerdict(dsJson, inZoneJson) {
  const ds = dnsAnswers(dsJson, 43).length > 0, ad = inZoneJson?.AD === true;
  return { ok: ds && ad, ds, ad };
}
export function caaVerdict(json) {
  const records = dnsAnswers(json, 257);
  return { ok: records.some((r) => /^\d+ issue "/.test(r)), count: records.length };
}
// Exactly one TXT record starting v=DMARC1 (two make DMARC ignore both). TXT data arrives quoted,
// possibly split into several quoted strings.
export function dmarcVerdict(json) {
  const records = dnsAnswers(json, 16).map((t) => t.replace(/"\s*"/g, "").replace(/^"|"$/g, "").trim()).filter((t) => /^v=DMARC1\s*(;|$)/i.test(t));
  return { ok: records.length === 1, count: records.length, policy: records[0]?.match(/(?:^|;)\s*p=(\w+)/i)?.[1] ?? null };
}
