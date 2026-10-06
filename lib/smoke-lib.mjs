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
