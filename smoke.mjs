// Checks a DEPLOYED site against the repo:
//   node smoke.mjs [base-url] [--aliases] [--mcp] [--registry] [--strict-https] [--dns]
// Every check prints PASS / WARN / FAIL; the run exits 1 if any check FAILs (WARN is non-fatal).
// No redirects are followed anywhere. Each request has a 10 s deadline. Never calls request_intro.
// Every check requires its exact success status and exact media type (parameters ignored).
// "deployed = repo" checks compare the live bytes with this checkout, so they also FAIL when
// commits are not deployed yet.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mediaType, cspCount, expectedCsp, parseMcpBody, redirectVerdict, healthVerdict, nelVerdict, dnssecVerdict, caaVerdict, dmarcVerdict } from "./lib/smoke-lib.mjs";

// The frozen did.json (also enforced by build.mjs). Production AND the repo copy must match it.
const DID_SHA256 = "c713c3b182128838452fdf1cf9f9b9bde71969933573a46a4341b4b42046a25c";
const ALIASES = ["www.patrickjv.com", "pvieira.co.uk", "www.pvieira.co.uk"];
const TOOLS = ["get_profile", "list_work", "list_skills", "list_faq", "request_intro"];
// Listed only while booking is switched on (BOOKING_ENABLED, as patrickjv/health reports it).
const BOOKING_TOOLS = ["get_booking_guide", "list_meeting_types", "get_availability", "book_meeting", "get_booking_status", "cancel_booking"];

// ---- arguments ----
const FLAGS = new Set(["--aliases", "--mcp", "--registry", "--strict-https", "--dns"]);
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const unknown = [...flags].filter((f) => !FLAGS.has(f));
if (unknown.length || positional.length > 1) {
  console.error(`usage: node smoke.mjs [base-url] ${[...FLAGS].map((f) => `[${f}]`).join(" ")}`);
  process.exit(2);
}
const base = (positional[0] ?? "https://patrickjv.com").replace(/\/+$/, "");
const baseUrl = new URL(base); // throws on a malformed base
const read = (p) => readFileSync(new URL(p, import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- check runner ----
const results = [];
const PASS = (detail) => ({ status: "PASS", detail });
const FAIL = (detail) => ({ status: "FAIL", detail });
const WARN = (detail) => ({ status: "WARN", detail });
const expect = (ok, detail) => (ok ? PASS : FAIL)(detail);
async function check(name, fn) {
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = FAIL(`${e.name === "TimeoutError" ? "timeout" : "error"}: ${e.message}`);
  }
  results.push({ name, ...r });
  console.log(`${r.status} ${name}${r.detail ? ` — ${r.detail}` : ""}`);
}

// One request: no redirects, 10 s deadline (covers the body), body always drained or cancelled.
async function req(url, { read: readBody = false, timeout = 10_000, ...init } = {}) {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeout), ...init });
  let buf = null;
  if (readBody) buf = Buffer.from(await r.arrayBuffer());
  else await r.body?.cancel();
  return { status: r.status, headers: r.headers, buf, type: mediaType(r.headers.get("content-type")) };
}
const at = (p) => base + p;

// ---- did.json ----
await check("did.json: 200, application/json, no redirect, bytes = repo = frozen hash", async () => {
  const r = await req(at("/.well-known/did.json"), { read: true });
  if (r.status !== 200) return FAIL(`status ${r.status}${r.headers.get("location") ? ` -> ${r.headers.get("location")}` : ""}`);
  if (r.type !== "application/json") return FAIL(`content-type ${r.type}`);
  const live = sha(r.buf), local = sha(read("public/.well-known/did.json"));
  if (local !== DID_SHA256) return FAIL(`repo copy sha256 ${local} != frozen`);
  return expect(live === DID_SHA256, `live sha256 ${live}`);
});

// ---- pages: exact status + exact media type; deterministic files byte-compared with the repo ----
// [path, accepted media types, repo file whose bytes the live body must equal]
const PAGES = [
  ["/", ["text/html"], "public/index.html"],
  ["/index.md", ["text/markdown"], "public/index.md"],
  ["/llms.txt", ["text/plain"], "public/llms.txt"],
  ["/robots.txt", ["text/plain"], "public/robots.txt"],
  ["/sitemap.xml", ["application/xml", "text/xml"], "public/sitemap.xml"],
  ["/.well-known/security.txt", ["text/plain"], "public/.well-known/security.txt"],
  ["/photo.webp", ["image/webp"], "public/photo.webp"],
  ["/og-card.jpg", ["image/jpeg"], "public/og-card.jpg"],
  ["/favicon.ico", ["image/x-icon", "image/vnd.microsoft.icon"], "public/favicon.ico"],
  ["/cv", ["text/html"], "public/cv.html"],
  ["/cv.pdf", ["application/pdf"], "public/cv.pdf"],
  ["/privacy", ["text/html"], "public/privacy.html"],
  ["/writing/", ["text/html"], "public/writing/index.html"],
  // Every post, as HTML and as Markdown.
  ...readdirSync(new URL("writing/", import.meta.url)).filter((f) => f.endsWith(".md")).sort().flatMap((f) => {
    const s = f.slice(0, -3);
    return [[`/writing/${s}`, ["text/html"], `public/writing/${s}.html`], [`/writing/${s}.md`, ["text/markdown"], `public/writing/${s}.md`]];
  }),
];
for (const [p, types, file] of PAGES) {
  await check(`${p}: 200 ${types.join("|")}, deployed = repo ${file}`, async () => {
    const r = await req(at(p), { read: true, headers: { accept: p === "/" ? "text/html" : "*/*" } });
    if (r.status !== 200 || !types.includes(r.type)) return FAIL(`${r.status} ${r.type || "(no content-type)"}`);
    const live = sha(r.buf), local = sha(read(file));
    return expect(live === local, `live sha256 ${live.slice(0, 12)} vs repo ${local.slice(0, 12)}${live === local ? "" : " (undeployed commits, or production drifted)"}`);
  });
}

// ---- security headers on / ----
let rootHeaders = null; // reused by the --aliases NEL check (no extra request)
await check("/ security headers: 200, HSTS, nosniff, CSP = public/_headers", async () => {
  const r = await req(at("/"), { headers: { accept: "text/html" } });
  rootHeaders = r.headers;
  const h = (n) => r.headers.get(n);
  const want = expectedCsp(read("public/_headers").toString());
  const problems = [];
  if (r.status !== 200) problems.push(`status ${r.status}`);
  if (!h("strict-transport-security")) problems.push("no HSTS");
  if (h("x-content-type-options") !== "nosniff") problems.push(`x-content-type-options ${h("x-content-type-options")}`);
  if (!want) problems.push("no CSP for / in public/_headers");
  else if (!h("content-security-policy")) problems.push("no CSP");
  else if (h("content-security-policy") !== want) problems.push("CSP differs from public/_headers");
  return expect(!problems.length, problems.join("; "));
});

await check("Accept: text/markdown on / -> 200 text/markdown, deployed = repo public/index.md", async () => {
  const r = await req(at("/"), { read: true, headers: { accept: "text/markdown" } });
  if (r.status !== 200 || r.type !== "text/markdown") return FAIL(`${r.status} ${r.type || "(no content-type)"}`);
  const live = sha(r.buf), local = sha(read("public/index.md"));
  return expect(live === local, `live sha256 ${live.slice(0, 12)} vs repo ${local.slice(0, 12)}`);
});

await check("security.txt: 200 text/plain, Expires > 30 days ahead", async () => {
  const r = await req(at("/.well-known/security.txt"), { read: true });
  if (r.status !== 200 || r.type !== "text/plain") return FAIL(`${r.status} ${r.type || "(no content-type)"}`);
  const exp = new Date(r.buf.toString().match(/^Expires:\s*(.+)$/m)?.[1] ?? NaN);
  const days = Math.floor((exp - Date.now()) / 864e5);
  return expect(days > 30, `expires in ${Number.isFinite(days) ? days : "?"} days`);
});

// A missing file under a path that has real files next to it (fonts have exact per-file rules):
// the 404 page must arrive with at most one CSP header (its own policy is a <meta> tag) and
// without the fonts' 30-day cache policy.
await check("missing /fonts/does-not-exist.woff2: 404, at most one CSP, no 30-day cache", async () => {
  const r = await req(at("/fonts/does-not-exist.woff2"));
  const n = cspCount(r.headers.get("content-security-policy"));
  const cache = r.headers.get("cache-control") ?? "";
  const problems = [];
  if (r.status !== 404) problems.push(`status ${r.status}`);
  if (n > 1) problems.push(`${n} CSP headers`);
  if (/max-age=2592000/.test(cache)) problems.push(`cache-control ${cache}`);
  return expect(!problems.length, problems.join("; ") || `404, ${n} CSP header(s)`);
});

// HTTP -> HTTPS on the primary host. Not yet enabled by the owner (Cloudflare "Always Use HTTPS"
// is a dashboard setting outside this repo), so it reports WARN unless --strict-https is passed.
// Once enabled, add --strict-https to the workflows so a regression fails the run.
await check(`http://${baseUrl.host}/ -> 301/308 https://${baseUrl.host}/`, async () => {
  const r = await req(`http://${baseUrl.host}/`);
  const loc = r.headers.get("location");
  const ok = [301, 308].includes(r.status) && loc === `https://${baseUrl.host}/`;
  if (ok) return PASS(`${r.status} ${loc}`);
  return (flags.has("--strict-https") ? FAIL : WARN)(`${r.status} ${loc ?? "(no location)"}`);
});

// ---- alias hosts ----
if (flags.has("--aliases")) {
  const target = "https://patrickjv.com/a/b?x=1";
  const aliasHeaders = {};
  for (const host of ALIASES) {
    await check(`${host} GET -> 301 ${target}`, async () => {
      const r = await req(`https://${host}/a/b?x=1`);
      aliasHeaders[host] = r.headers;
      const loc = r.headers.get("location");
      return expect(redirectVerdict("GET", r.status, loc, target).ok, `${r.status} ${loc}`);
    });
  }
  // Non-GET must be 308 so the method and body survive (deployed since 6 Oct; a 301 is a FAIL).
  await check(`${ALIASES[0]} POST -> 308 ${target}`, async () => {
    const r = await req(`https://${ALIASES[0]}/a/b?x=1`, { method: "POST" });
    const loc = r.headers.get("location");
    return expect(redirectVerdict("POST", r.status, loc, target).ok, `${r.status} ${loc}`);
  });
  // Network Error Logging (third-party failure reports) must be off on every public host. The
  // headers come from responses already fetched above. NEL is a per-zone dashboard setting, off on
  // both zones since 7 Oct (review R5 / C3-F3).
  for (const [host, headers] of [[baseUrl.host, rootHeaders], ["pvieira.co.uk", aliasHeaders["pvieira.co.uk"]]]) {
    await check(`${host}: no NEL / Report-To headers`, async () => {
      if (!headers) return FAIL("no response to inspect (its request failed above)");
      const v = nelVerdict(headers);
      if (v.ok) return PASS("absent");
      return FAIL(`present: ${v.present.join(", ")} — disable Network Error Logging on the ${host} zone`);
    });
  }
  // The alias redirects are Single Redirect rules (R7), which add no headers of their own; HSTS on
  // pvieira.co.uk comes from that zone's HSTS setting. (www.patrickjv.com relies on the apex's
  // includeSubDomains.)
  await check("pvieira.co.uk redirect: HSTS max-age >= 1 year, includeSubDomains", async () => {
    const headers = aliasHeaders["pvieira.co.uk"];
    if (!headers) return FAIL("no response to inspect (its request failed above)");
    const hsts = headers.get("strict-transport-security") ?? "";
    const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
    return expect(maxAge >= 31536000 && /includesubdomains/i.test(hsts), hsts || "absent — turn on HSTS for the pvieira.co.uk zone");
  });
}

// ---- MCP lifecycle (read-only) ----
if (flags.has("--mcp")) {
  const serverJson = JSON.parse(read("mcp/server.json"));
  const faq = JSON.parse(read("content.json")).faq;
  let protocol = null;
  let first = true;
  // Rate limits on /mcp: the edge WAF rule allows 6 requests per 10 s per IP; the Worker allows
  // 30 per minute and 10 tools/call per 10 s. With booking on (F-002) this sequence is 10 requests,
  // so they are 1.8 s apart to keep any 10 s window to at most 6 — and the deploy workflow's
  // retries add another run per attempt (at least 20 s apart).
  const mcp = async (msg) => {
    if (!first) await sleep(1800);
    first = false;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (protocol) headers["mcp-protocol-version"] = protocol;
    const r = await req(at("/mcp"), { method: "POST", headers, body: JSON.stringify(msg), read: true });
    return { status: r.status, json: parseMcpBody(r.type, r.buf.toString()) };
  };
  const envelope = (res, id) => res.status === 200 && res.json?.jsonrpc === "2.0" && res.json?.id === id && !res.json?.error;

  await check(`mcp initialize (2025-11-25, serverInfo = patrickjv.com ${serverJson.version})`, async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "patrickjv-smoke", version: "1.0.0" } } });
    const result = res.json?.result;
    if (!envelope(res, 1)) return FAIL(`status ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    protocol = result?.protocolVersion ?? null;
    return expect(
      protocol === "2025-11-25" && result?.serverInfo?.name === "patrickjv.com" && result?.serverInfo?.version === serverJson.version,
      `protocol ${protocol}, server ${result?.serverInfo?.name} ${result?.serverInfo?.version}`,
    );
  });
  await check("mcp notifications/initialized -> 202", async () => {
    const res = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    return expect(res.status === 202, `status ${res.status}`);
  });
  // Readiness, not delivery: request_intro's secret, email binding, quota Durable Object and rate
  // limits are configured; and if booking is switched on, bookingReady (its secrets set, a Google
  // token refresh works, the BookingStore answers). Booking switched off passes. Read-only and
  // sends nothing; delivery itself is never exercised here. Runs before tools/list, which expects
  // the booking tools only when this reports bookingEnabled.
  let bookingOn = false;
  await check("mcp patrickjv/health -> introReady, and bookingReady and signinReady if booking is enabled", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 4, method: "patrickjv/health" });
    if (!envelope(res, 4)) return FAIL(`status ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    bookingOn = res.json.result?.bookingEnabled === true;
    const v = healthVerdict(res.json.result);
    return expect(v.ok, v.detail);
  });
  await check(`mcp tools/list = {${TOOLS.join(", ")}}, plus the booking tools if booking is enabled, each with icons`, async () => {
    // F-002: the booking read tools are listed whether or not booking is on.
    const want = bookingOn ? [...TOOLS, ...BOOKING_TOOLS] : [...TOOLS, ...BOOKING_TOOLS.filter((n) => n !== "book_meeting" && n !== "cancel_booking")];
    const res = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    if (!envelope(res, 2)) return FAIL(`status ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    const tools = res.json.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    const exact = names.length === want.length && new Set(names).size === names.length && want.every((n) => names.includes(n));
    const icons = tools.every((t) => Array.isArray(t.icons) && t.icons.length > 0);
    return expect(exact && icons, `${names.join(", ")}${icons ? "" : " (missing icons)"}`);
  });
  await check(`mcp tools/call list_faq -> items = content.json faq (${faq.length})`, async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_faq", arguments: {} } });
    if (!envelope(res, 3)) return FAIL(`status ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    const result = res.json.result;
    const items = result?.structuredContent?.items;
    const same = isDeepStrictEqual(items, faq);
    return expect(result?.isError !== true && same, `${items?.length ?? 0} items${same ? "" : ", differ from content.json"}${result?.isError ? ", isError" : ""}`);
  });
  // F-002: with booking on, one booking request for the first free slot (it reserves nothing and
  // emails nobody), withdrawn at once. No free slot in the horizon, the request allowance used up
  // (rate_limited, 429) or the slot gone between the two calls (409) is reported as skipped, and
  // passes. That a request reserves nothing is proved by the unit tests, not here.
  if (bookingOn) {
    const call = async (id, name, args) => {
      const res = await mcp({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      if (!envelope(res, id)) throw new Error(`${name}: status ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
      return res.json.result;
    };
    let type = null;
    await check("mcp book_meeting -> a booking request for the first free slot, shaped as F-002 says, then cancel_booking reads cancelled", async () => {
      type = JSON.parse(read("booking.json")).meetingTypes[0].id;
      const av = await call(5, "get_availability", { type });
      // An availability error is a failure, never "no free slot".
      if (av?.isError || !Array.isArray(av?.structuredContent?.slots)) return FAIL(`get_availability: ${JSON.stringify(av?.structuredContent ?? null).slice(0, 160)}`);
      const slot = av.structuredContent.slots[0];
      if (!slot) return PASS("skipped: no free slot in the horizon");
      const b = await call(6, "book_meeting", { type, start: slot.start });
      const e = b?.structuredContent;
      if (b?.isError) {
        const gone = e?.error === "slot_taken" || (e?.error === "invalid_slot" && ["notice", "horizon"].includes(e?.reason));
        if (e?.error === "rate_limited" || gone || e?.error === "booking_disabled") return PASS(`skipped: ${e.error}`);
        return FAIL(`refused: ${JSON.stringify(e).slice(0, 160)}`);
      }
      const shape = /^[0-9a-f]{32}$/.test(e?.booking_id ?? "") && e.status === "pending_confirmation" && /^https:\/\/patrickjv\.com\/book\/confirm\?t=[A-Za-z0-9_-]{22}$/.test(e.confirm_url ?? "")
        && typeof e.link_expires === "string" && typeof e.next_step === "string";
      if (!shape) return FAIL(`unexpected result ${JSON.stringify(e).slice(0, 160)}`);
      const c = await call(7, "cancel_booking", { booking_id: e.booking_id });
      const st = await call(8, "get_booking_status", { booking_id: e.booking_id });
      return expect(c?.structuredContent?.status === "cancelled" && st?.structuredContent?.status === "cancelled",
        `request made for ${slot.start}, withdrawn: ${c?.structuredContent?.status}, status ${st?.structuredContent?.status}`);
    });
    await check("mcp book_meeting with an email argument -> refused (invalid_input)", async () => {
      const b = await call(9, "book_meeting", { type: type ?? "consultation", start: "2030-01-07T10:00:00+00:00", email: "smoke@example.com" });
      return expect(b?.isError === true && b?.structuredContent?.error === "invalid_input", `refused: ${b?.structuredContent?.error ?? "no"}`);
    });
  }
}

// ---- MCP Registry ----
if (flags.has("--registry")) {
  const serverJson = JSON.parse(read("mcp/server.json"));
  await check(`registry: ${serverJson.name} active, ${serverJson.version}, remote https://patrickjv.com/mcp`, async () => {
    // The Registry is a third-party service and can be slow (12 s observed on 7 Oct 2026): allow
    // 30 s, and report an unreachable Registry as WARN — only a wrong or missing listing FAILs.
    let r;
    try {
      r = await req("https://registry.modelcontextprotocol.io/v0/servers?search=com.patrickjv", { read: true, timeout: 30_000 });
    } catch (e) {
      return WARN(`registry unreachable (${e.name === "TimeoutError" ? "timeout" : e.message}) — not a site fault`);
    }
    if (r.status >= 500) return WARN(`registry returned ${r.status} — not a site fault`);
    if (r.status !== 200) return FAIL(`status ${r.status}`);
    const entries = (JSON.parse(r.buf.toString()).servers ?? []).filter((e) => e.server?.name === serverJson.name);
    const latest = entries.find((e) => e._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest) ?? entries[0];
    if (!latest) return FAIL("not listed");
    const meta = latest._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
    const remote = latest.server.remotes?.some((x) => x.url === "https://patrickjv.com/mcp");
    return expect(
      meta.status === "active" && latest.server.version === serverJson.version && remote,
      `status ${meta.status}, version ${latest.server.version}, remote ${remote ? "ok" : "missing"}`,
    );
  });
}

// ---- DNS (DNS-over-HTTPS, Cloudflare's validating resolver) ----
if (flags.has("--dns")) {
  const DOH = "https://cloudflare-dns.com/dns-query";
  const zone = "patrickjv.com";
  const doh = async (name, type) => {
    const r = await req(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { read: true, headers: { accept: "application/dns-json" } });
    if (r.status !== 200) throw new Error(`DoH ${name} ${type}: status ${r.status}`);
    return JSON.parse(r.buf.toString());
  };
  let caa = null;
  await check(`${zone} CAA present`, async () => {
    caa = await doh(zone, "CAA");
    const v = caaVerdict(caa);
    return expect(v.ok, `${v.count} CAA record(s)`);
  });
  // The CAA answer above doubles as the in-zone answer whose AD bit shows the chain validates.
  await check(`${zone} DNSSEC: DS at the parent and answers authenticated (AD)`, async () => {
    const v = dnssecVerdict(await doh(zone, "DS"), caa);
    if (v.ok) return PASS("DS present, AD=true");
    return WARN(`DS ${v.ds ? "present" : "absent"}, AD=${v.ad} — DS publication at the registrar pending (follow up if this persists)`);
  });
  await check(`_dmarc.${zone}: exactly one DMARC record`, async () => {
    const v = dmarcVerdict(await doh(`_dmarc.${zone}`, "TXT"));
    return expect(v.ok, `${v.count} record(s)${v.policy ? `, p=${v.policy}` : ""}`);
  });
}

// ---- summary ----
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count("PASS")} passed, ${count("WARN")} warned, ${count("FAIL")} failed (${base})`);
process.exit(count("FAIL") ? 1 : 0);
