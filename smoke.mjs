// Checks a DEPLOYED site against the repo:
//   node smoke.mjs [base-url] [--aliases] [--mcp] [--registry] [--strict-https]
// Every check prints PASS / WARN / FAIL; the run exits 1 if any check FAILs (WARN is non-fatal).
// No redirects are followed anywhere. Each request has a 10 s deadline. Never calls request_intro.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// The frozen did.json (also enforced by build.mjs). Production AND the repo copy must match it.
const DID_SHA256 = "c713c3b182128838452fdf1cf9f9b9bde71969933573a46a4341b4b42046a25c";
const ALIASES = ["www.patrickjv.com", "pvieira.co.uk", "www.pvieira.co.uk"];
const TOOLS = ["get_profile", "list_work", "list_skills", "list_faq", "request_intro"];

// ---- arguments ----
const FLAGS = new Set(["--aliases", "--mcp", "--registry", "--strict-https"]);
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
async function req(url, { read: readBody = false, ...init } = {}) {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), ...init });
  let buf = null;
  if (readBody) buf = Buffer.from(await r.arrayBuffer());
  else await r.body?.cancel();
  return { status: r.status, headers: r.headers, buf, type: r.headers.get("content-type") ?? "" };
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

// ---- pages: exact status + content-type prefix ----
const PAGES = {
  "/": ["text/html"],
  "/index.md": ["text/markdown"],
  "/llms.txt": ["text/plain"],
  "/robots.txt": ["text/plain"],
  "/sitemap.xml": ["application/xml", "text/xml"],
  "/photo.webp": ["image/webp"],
  "/favicon.ico": ["image/x-icon", "image/vnd.microsoft.icon"],
  "/og-card.jpg": ["image/jpeg"],
};
for (const [p, types] of Object.entries(PAGES)) {
  await check(`${p}: 200 ${types.join("|")}`, async () => {
    const r = await req(at(p), { headers: { accept: p === "/" ? "text/html" : "*/*" } });
    return expect(r.status === 200 && types.some((t) => r.type.startsWith(t)), `${r.status} ${r.type}`);
  });
}

// Deployed-vs-repo: fails when commits are not deployed yet (or production drifted).
await check("deployed / matches repo public/index.html (undeployed commits?)", async () => {
  const r = await req(at("/"), { read: true, headers: { accept: "text/html" } });
  const live = sha(r.buf), local = sha(read("public/index.html"));
  return expect(r.status === 200 && live === local, `status ${r.status}, live ${live.slice(0, 12)} vs repo ${local.slice(0, 12)}`);
});

// ---- security headers on / ----
// Expected CSP for "/" from the generated public/_headers. Cloudflare applies every block whose
// path matches ("/*" and "/"), joining repeated headers with ", "; "! Header" detaches it.
function expectedCsp() {
  const blocks = [];
  for (const line of read("public/_headers").toString().split("\n")) {
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
await check("/ security headers: HSTS, nosniff, CSP = public/_headers", async () => {
  const r = await req(at("/"), { headers: { accept: "text/html" } });
  const h = (n) => r.headers.get(n);
  const want = expectedCsp();
  const problems = [];
  if (!h("strict-transport-security")) problems.push("no HSTS");
  if (h("x-content-type-options") !== "nosniff") problems.push(`x-content-type-options ${h("x-content-type-options")}`);
  if (!want) problems.push("no CSP for / in public/_headers");
  else if (!h("content-security-policy")) problems.push("no CSP");
  else if (h("content-security-policy") !== want) problems.push("CSP differs from public/_headers");
  return expect(!problems.length, problems.join("; "));
});

await check("Accept: text/markdown on / -> text/markdown", async () => {
  const r = await req(at("/"), { headers: { accept: "text/markdown" } });
  return expect(r.status === 200 && r.type.startsWith("text/markdown"), `${r.status} ${r.type}`);
});

await check("security.txt: 200, Expires > 30 days ahead", async () => {
  const r = await req(at("/.well-known/security.txt"), { read: true });
  const exp = new Date(r.buf.toString().match(/^Expires:\s*(.+)$/m)?.[1] ?? NaN);
  const days = Math.floor((exp - Date.now()) / 864e5);
  return expect(r.status === 200 && days > 30, `status ${r.status}, expires in ${Number.isFinite(days) ? days : "?"} days`);
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
  for (const host of ALIASES) {
    await check(`${host} GET -> 301 ${target}`, async () => {
      const r = await req(`https://${host}/a/b?x=1`);
      return expect(r.status === 301 && r.headers.get("location") === target, `${r.status} ${r.headers.get("location")}`);
    });
  }
  // Non-GET must be 308 so the method/body survive. Until the 308 change is deployed a 301 is a WARN.
  await check(`${ALIASES[0]} POST -> 308 ${target}`, async () => {
    const r = await req(`https://${ALIASES[0]}/a/b?x=1`, { method: "POST" });
    const loc = r.headers.get("location");
    if (r.status === 308 && loc === target) return PASS(`${r.status} ${loc}`);
    if (r.status === 301 && loc === target) return WARN(`${r.status} ${loc} (308 not deployed yet)`);
    return FAIL(`${r.status} ${loc}`);
  });
}

// ---- MCP lifecycle (read-only) ----
if (flags.has("--mcp")) {
  const serverJson = JSON.parse(read("mcp/server.json"));
  const faqCount = JSON.parse(read("content.json")).faq.length;
  let protocol = null;
  let first = true;
  // The edge allows 6 req / 10 s on /mcp: keep requests ~1.2 s apart.
  const mcp = async (msg) => {
    if (!first) await sleep(1200);
    first = false;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (protocol) headers["mcp-protocol-version"] = protocol;
    const r = await req(at("/mcp"), { method: "POST", headers, body: JSON.stringify(msg), read: true });
    let json = null;
    const text = r.buf.toString();
    if (r.type.startsWith("text/event-stream")) {
      const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).at(-1);
      json = data ? JSON.parse(data) : null;
    } else if (text) json = JSON.parse(text);
    return { status: r.status, json };
  };
  const envelope = (res, id) => res.status === 200 && res.json?.jsonrpc === "2.0" && res.json?.id === id && !res.json?.error;

  await check(`mcp initialize (2025-11-25, serverInfo.version = ${serverJson.version})`, async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "patrickjv-smoke", version: "1.0.0" } } });
    const result = res.json?.result;
    if (!envelope(res, 1)) return FAIL(`status ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    protocol = result?.protocolVersion ?? null;
    return expect(
      protocol === "2025-11-25" && result?.serverInfo?.version === serverJson.version,
      `protocol ${protocol}, server ${result?.serverInfo?.name} ${result?.serverInfo?.version}`,
    );
  });
  await check("mcp notifications/initialized -> 202", async () => {
    const res = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    return expect(res.status === 202, `status ${res.status}`);
  });
  await check(`mcp tools/list = {${TOOLS.join(", ")}}, each with icons`, async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    if (!envelope(res, 2)) return FAIL(`status ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    const tools = res.json.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    const exact = names.length === TOOLS.length && new Set(names).size === names.length && TOOLS.every((n) => names.includes(n));
    const icons = tools.every((t) => Array.isArray(t.icons) && t.icons.length > 0);
    return expect(exact && icons, `${names.join(", ")}${icons ? "" : " (missing icons)"}`);
  });
  await check(`mcp tools/call list_faq -> ${faqCount} items (= content.json)`, async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_faq", arguments: {} } });
    if (!envelope(res, 3)) return FAIL(`status ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    const result = res.json.result;
    const n = result?.structuredContent?.items?.length;
    return expect(result?.isError !== true && n === faqCount, `${n} items${result?.isError ? ", isError" : ""}`);
  });
}

// ---- MCP Registry ----
if (flags.has("--registry")) {
  const serverJson = JSON.parse(read("mcp/server.json"));
  await check(`registry: ${serverJson.name} active, ${serverJson.version}, remote https://patrickjv.com/mcp`, async () => {
    const r = await req("https://registry.modelcontextprotocol.io/v0/servers?search=com.patrickjv", { read: true });
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

// ---- summary ----
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count("PASS")} passed, ${count("WARN")} warned, ${count("FAIL")} failed (${base})`);
process.exit(count("FAIL") ? 1 : 0);
