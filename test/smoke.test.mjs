// Tests for smoke.mjs: its pure helpers, and whole runs against a local mock of the site that is
// correct by default and can be broken one way at a time (each break must turn into a FAIL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mediaType, cspCount, expectedCsp, parseMcpBody, redirectVerdict } from "../lib/smoke-lib.mjs";
import { handle } from "../mcp/handler.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const file = (f) => readFileSync(join(ROOT, f));
const content = JSON.parse(file("content.json"));

test("mediaType: exact type/subtype, parameters and case ignored", () => {
  assert.equal(mediaType("Text/Markdown; charset=utf-8"), "text/markdown");
  assert.equal(mediaType("text/markdown-bogus"), "text/markdown-bogus");
  assert.notEqual(mediaType("text/markdown-bogus"), "text/markdown");
  assert.equal(mediaType(null), "");
});

test("cspCount counts joined policies", () => {
  assert.equal(cspCount(null), 0);
  assert.equal(cspCount("default-src 'none'; base-uri 'none'"), 1);
  assert.equal(cspCount("default-src 'none', default-src 'self'"), 2);
});

test("expectedCsp reads the policy for / from the generated _headers", () => {
  const csp = expectedCsp(file("public/_headers").toString());
  assert.match(csp, /^default-src 'none'; img-src 'self';/);
  assert.equal(cspCount(csp), 1);
});

test("parseMcpBody: JSON, the last SSE event, and nothing for other types", () => {
  assert.deepEqual(parseMcpBody("application/json; charset=utf-8", '{"a":1}'), { a: 1 });
  assert.deepEqual(parseMcpBody("text/event-stream", 'event: message\ndata: {"a":1}\n\ndata: {"a":2}\n'), { a: 2 });
  assert.equal(parseMcpBody("text/plain", '{"a":1}'), null);
  assert.equal(parseMcpBody("application/json", "not json"), null);
});

test("redirectVerdict: GET/HEAD 301, everything else 308, exact location", () => {
  const t = "https://patrickjv.com/a/b?x=1";
  assert.equal(redirectVerdict("GET", 301, t, t).ok, true);
  assert.equal(redirectVerdict("POST", 308, t, t).ok, true);
  assert.equal(redirectVerdict("POST", 301, t, t).ok, false, "a 301 for POST is a FAIL, not a WARN");
  assert.equal(redirectVerdict("GET", 308, t, t).ok, false);
  assert.equal(redirectVerdict("GET", 301, t + "&y", t).ok, false);
});

// ---- whole runs against a local mock ----
const TYPES = { ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".html": "text/html; charset=utf-8" };
const ext = (p) => p.slice(p.lastIndexOf("."));

function mockSite(faults = {}) {
  const csp = expectedCsp(file("public/_headers").toString());
  const base = { "strict-transport-security": "max-age=31536000; includeSubDomains", "x-content-type-options": "nosniff" };
  const env = { RL_MCP: { limit: async () => ({ success: true }) }, RL_BURST: { limit: async () => ({ success: true }) }, RL_INTRO: { limit: async () => ({ success: true }) } };
  const faq = faults.faq ? content.faq.map((f, k) => (k ? f : { ...f, a: f.a + " (changed)" })) : content.faq;
  const deps = { content: { ...content, faq }, now: () => new Date(), reserve: async () => { throw new Error("never"); }, sendEmail: async () => { throw new Error("never"); } };
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, headers, body = "") => { res.writeHead(status, { ...base, ...headers }); res.end(body); };
    if (url.pathname === "/mcp") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await handle(new Request(`https://patrickjv.com${req.url}`, { method: req.method, headers: req.headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }), env, deps);
      let body = await r.text();
      if (faults.serverName) body = body.replace('"name":"patrickjv.com"', '"name":"someone-else"');
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(body);
    }
    if (url.pathname === "/") {
      if (/text\/markdown/.test(req.headers.accept ?? ""))
        return send(200, { "content-type": faults.mdType ?? "text/markdown; charset=utf-8" }, faults.mdBody ?? file("public/index.md"));
      return send(faults.rootStatus ?? 200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }, file("public/index.html"));
    }
    if (url.pathname.startsWith("/fonts/does-not-exist"))
      return send(404, { "content-type": "text/html", ...(faults.fontCsp ? { "content-security-policy": "default-src 'none', default-src 'none'" } : {}) }, file("public/404.html"));
    try {
      let body = file("public" + url.pathname);
      if (faults.emptyImages && /\.(webp|jpg|ico)$/.test(url.pathname)) body = Buffer.alloc(0);
      return send(200, { "content-type": TYPES[ext(url.pathname)] ?? "application/octet-stream" }, body);
    } catch {
      return send(404, { "content-type": "text/html" }, file("public/404.html"));
    }
  });
}

async function runSmoke(faults, args = []) {
  const server = mockSite(faults);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address();
    return await new Promise((resolve) => execFile(process.execPath, [join(ROOT, "smoke.mjs"), `http://127.0.0.1:${port}`, ...args], { timeout: 60_000 }, (err, stdout) =>
      resolve({ code: err ? err.code : 0, lines: stdout.split("\n"), fails: stdout.split("\n").filter((l) => l.startsWith("FAIL")) })));
  } finally { server.close(); }
}

test("smoke against a correct mock: no FAIL, exit 0", async () => {
  const r = await runSmoke({}, ["--mcp"]);
  assert.deepEqual(r.fails, []);
  assert.equal(r.code, 0, r.lines.join("\n"));
});

test("smoke FAILs each false-PASS case from the round-2 review", async () => {
  const cases = [
    [{ mdType: "text/markdown-bogus" }, /Accept: text\/markdown/],
    [{ mdBody: "# Someone else\n" }, /Accept: text\/markdown/],
    [{ rootStatus: 500 }, /security headers/],
    [{ emptyImages: true }, /photo\.webp/],
    [{ fontCsp: true }, /does-not-exist/],
    [{ serverName: true }, /mcp initialize/],
    [{ faq: true }, /list_faq/],
  ];
  const results = await Promise.all(cases.map(([f]) => runSmoke(f, f.serverName || f.faq ? ["--mcp"] : [])));
  results.forEach((r, k) => {
    const [f, pattern] = cases[k];
    assert.equal(r.code, 1, `${JSON.stringify(f)}: exit ${r.code}\n${r.lines.join("\n")}`);
    assert.ok(r.fails.some((l) => pattern.test(l)), `${JSON.stringify(f)}: no FAIL matching ${pattern}\n${r.fails.join("\n")}`);
  });
});
