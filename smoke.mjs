// Checks a DEPLOYED site against the real files: node smoke.mjs [base-url] [--aliases] [--mcp]
// did.json must be served byte-identical, as application/json, with no redirect.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const base = process.argv[2] ?? "https://patrickjv.com";
const sha = (b) => createHash("sha256").update(b).digest("hex");
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failed++; };

const did = await fetch(`${base}/.well-known/did.json`, { redirect: "manual" });
const body = Buffer.from(await did.arrayBuffer());
check(did.status === 200, `did.json status ${did.status}`);
check(did.headers.get("content-type") === "application/json", `did.json content-type ${did.headers.get("content-type")}`);
check(sha(body) === sha(readFileSync("public/.well-known/did.json")), "did.json bytes identical to public/.well-known/did.json");

for (const p of ["/", "/index.md", "/photo.webp", "/robots.txt", "/sitemap.xml", "/llms.txt"]) {
  const r = await fetch(base + p, { redirect: "manual" });
  check(r.status === 200, `${p} status ${r.status}`);
}

if (process.argv.includes("--aliases")) {
  for (const host of ["www.patrickjv.com", "pvieira.co.uk", "www.pvieira.co.uk"]) {
    const r = await fetch(`https://${host}/a/b?x=1`, { redirect: "manual" });
    check(r.status === 301 && r.headers.get("location") === "https://patrickjv.com/a/b?x=1", `${host} -> ${r.status} ${r.headers.get("location")}`);
  }
}
if (process.argv.includes("--mcp")) {
  // Read-only MCP handshake: initialize → tools/list → list_faq. Never calls request_intro.
  const mcp = async (body) => {
    const r = await fetch(new URL("/mcp", base), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: r.status === 202 ? null : await r.json().catch(() => null) };
  };
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  check(init.status === 200 && init.json?.result?.serverInfo?.name === "patrickjv.com", `mcp initialize ${init.status}`);
  check((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status === 202, "mcp notifications/initialized 202");
  const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.json?.result?.tools?.map((t) => t.name) ?? [];
  check(names.length === 5 && names.includes("request_intro"), `mcp tools/list: ${names.join(", ")}`);
  check(list.json?.result?.tools?.every((t) => t.icons?.length), "mcp tools carry icons");
  const faq = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_faq", arguments: {} } });
  check(faq.json?.result?.structuredContent?.items?.length > 0, "mcp list_faq returns items");
}
process.exit(failed ? 1 : 0);
