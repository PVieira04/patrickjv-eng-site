// Checks a DEPLOYED site against the real files: node smoke.mjs [base-url] [--aliases]
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

for (const p of ["/", "/photo.webp", "/robots.txt", "/sitemap.xml", "/llms.txt"]) {
  const r = await fetch(base + p, { redirect: "manual" });
  check(r.status === 200, `${p} status ${r.status}`);
}

if (process.argv.includes("--aliases")) {
  for (const host of ["www.patrickjv.com", "pvieira.co.uk", "www.pvieira.co.uk"]) {
    const r = await fetch(`https://${host}/a/b?x=1`, { redirect: "manual" });
    check(r.status === 301 && r.headers.get("location") === "https://patrickjv.com/a/b?x=1", `${host} -> ${r.status} ${r.headers.get("location")}`);
  }
}
process.exit(failed ? 1 : 0);
