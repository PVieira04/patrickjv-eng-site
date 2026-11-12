// Tests for smoke.mjs: its pure helpers, and whole runs against a local mock of the site that is
// correct by default and can be broken one way at a time (each break must turn into a FAIL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { harness } from "../mcp/booking-harness.mjs";
import { mediaType, cspCount, expectedCsp, parseMcpBody, redirectVerdict, healthVerdict, nelVerdict, dnssecVerdict, caaVerdict, dmarcVerdict, projectPages, firstFigure, robotsVerdict } from "../lib/smoke-lib.mjs";
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

// F-005: the CSP for any exact path, as Cloudflare applies every matching rule (exact paths and
// "/prefix/*" wildcards); "/" stays the default.
test("F-005 (US-3, D9): expectedCsp gives each /projects path its own exact rule, and wildcard rules match by prefix", () => {
  const h = "/*\n  X-Content-Type-Options: nosniff\n\n/\n  Content-Security-Policy: root\n\n/projects/research-agent\n  Content-Security-Policy: showcase\n\n/projects/*\n  X-Robots-Tag: noindex\n";
  assert.equal(expectedCsp(h), "root");
  assert.equal(expectedCsp(h, "/"), "root");
  assert.equal(expectedCsp(h, "/projects/research-agent"), "showcase");
  assert.equal(expectedCsp(h, "/projects/research-agent.md"), null, "no rule, no CSP");
  assert.equal(expectedCsp(h + "\n/projects/*\n  Content-Security-Policy: wild\n", "/projects/research-agent"), "showcase, wild", "a matching wildcard's CSP joins the exact one");
  assert.equal(expectedCsp(file("public/_headers").toString(), "/projects/research-agent"), expectedCsp(file("public/_headers").toString(), "/projects/research-agent.html"));
});

test("F-005 (US-3): projectPages lists the four fixed paths, then each run's page, report.md, report.json and figures from published.json; firstFigure is the first figure listed", () => {
  const fixed = [
    ["/projects/", ["text/html"], "public/projects/index.html"],
    ["/projects/index.md", ["text/markdown"], "public/projects/index.md"],
    ["/projects/research-agent", ["text/html"], "public/projects/research-agent.html"],
    ["/projects/research-agent.md", ["text/markdown"], "public/projects/research-agent.md"],
  ];
  assert.deepEqual(projectPages(undefined), fixed, "no manifest yet (main before the first export)");
  assert.deepEqual(projectPages({ manifest_version: "1.0.0", runs: {} }), fixed);
  assert.equal(firstFigure({ runs: {} }), null);
  const a = "20261111T140200Z-000002", b = "20261111T140100Z-000001";
  const m = { runs: {
    [a]: { files: { "calls/2/out/b.png": "x", "calls/1/out/a.png": "x", "report.json": "x", "report.md": "x" } },
    [b]: { files: { "report.json": "x", "report.md": "x" } },
  } };
  const r = (id) => `/projects/research-agent/runs/${id}/`;
  assert.deepEqual(projectPages(m).slice(4), [
    [r(b), ["text/html"], `public${r(b)}index.html`],
    [r(b) + "report.json", ["application/json"], `public${r(b)}report.json`],
    [r(b) + "report.md", ["text/markdown"], `public${r(b)}report.md`],
    [r(a), ["text/html"], `public${r(a)}index.html`],
    [r(a) + "calls/1/out/a.png", ["image/png"], `public${r(a)}calls/1/out/a.png`],
    [r(a) + "calls/2/out/b.png", ["image/png"], `public${r(a)}calls/2/out/b.png`],
    [r(a) + "report.json", ["application/json"], `public${r(a)}report.json`],
    [r(a) + "report.md", ["text/markdown"], `public${r(a)}report.md`],
  ], "runs by id, files by path");
  assert.equal(firstFigure(m), r(a) + "calls/1/out/a.png");
});

test("F-005 (D9): robotsVerdict — noindex required while not launched, X-Robots-Tag absent after launch", () => {
  assert.equal(robotsVerdict("noindex", false).ok, true);
  assert.equal(robotsVerdict(" NoIndex ", false).ok, true);
  for (const v of [null, "", "nofollow", "noindex, nofollow", "none"]) assert.equal(robotsVerdict(v, false).ok, false, String(v));
  assert.equal(robotsVerdict(null, true).ok, true);
  for (const v of ["noindex", "all", ""]) assert.equal(robotsVerdict(v, true).ok, false, v);
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

test("healthVerdict: exactly eight booleans; introReady, and bookingReady and signinReady (F-002) when booking is enabled; anything else fails", () => {
  // F-004: plus providers (see the F-004 test below).
  const ready = { introReady: true, salt: true, email: true, quota: true, rateLimits: true, bookingEnabled: false, bookingReady: false, signinReady: false,
    providers: { google: { ready: true, reachable: true }, microsoft: "off", altimist: "off" } };
  assert.equal(healthVerdict(ready).ok, true, "booking off: its readiness doesn't matter");
  assert.equal(healthVerdict({ ...ready, bookingReady: true }).ok, true);
  assert.equal(healthVerdict({ ...ready, bookingEnabled: true, bookingReady: true, signinReady: true }).ok, true);
  const notReady = healthVerdict({ ...ready, bookingEnabled: true, signinReady: true });
  assert.equal(notReady.ok, false, "booking on but not ready");
  assert.match(notReady.detail, /bookingReady false/);
  // Sign-in is required whenever booking is: without it no agent can book (F-002 Observability).
  const noSignin = healthVerdict({ ...ready, bookingEnabled: true, bookingReady: true });
  assert.equal(noSignin.ok, false, "booking on, sign-in not ready");
  assert.match(noSignin.detail, /signinReady false/);
  assert.equal(healthVerdict({ ...ready, introReady: false, salt: false, bookingEnabled: true, bookingReady: true, signinReady: true }).ok, false);
  const { signinReady, ...seven } = ready;
  assert.equal(healthVerdict(seven).ok, false, "the old seven-key shape");
  assert.equal(healthVerdict({ ...ready, introReady: false, salt: false }).ok, false);
  assert.match(healthVerdict({ ...ready, introReady: false, salt: false }).detail, /not configured: salt/);
  for (const bad of [undefined, null, {}, [], { ...ready, saltLength: 40 }, { ...ready, email: "yes" }, { ...ready, signinReady: "yes" }, { introReady: true }])
    assert.equal(healthVerdict(bad).ok, false, JSON.stringify(bad));
});

test("F-004 healthVerdict: providers is google, microsoft and altimist, each \"off\" or {ready, reachable}; with booking on, every launched provider must be ready and reachable; others are ignored", () => {
  const on = { introReady: true, salt: true, email: true, quota: true, rateLimits: true, bookingEnabled: true, bookingReady: true, signinReady: true };
  const up = { ready: true, reachable: true };
  const v = (providers, launched) => healthVerdict({ ...on, providers }, launched);
  assert.equal(v({ google: up, microsoft: "off", altimist: "off" }).ok, true, "default: Google launched");
  assert.equal(v({ google: up, microsoft: up, altimist: "off" }, ["google", "microsoft"]).ok, true);
  for (const [providers, launched, why] of [
    [{ google: up, microsoft: { ready: false, reachable: true }, altimist: "off" }, ["google", "microsoft"], /microsoft not ready/],
    [{ google: up, microsoft: { ready: true, reachable: false }, altimist: "off" }, ["google", "microsoft"], /microsoft not reachable/],
    [{ google: up, microsoft: "off", altimist: "off" }, ["google", "microsoft"], /microsoft off/],
    [{ google: { ready: true, reachable: false }, microsoft: "off", altimist: "off" }, ["google"], /google not reachable/],
  ]) {
    const r = v(providers, launched);
    assert.equal(r.ok, false, JSON.stringify(providers));
    assert.match(r.detail, why);
  }
  // Not launched (on trial, or with secrets set): ignored whatever its state.
  assert.equal(v({ google: up, microsoft: { ready: false, reachable: false }, altimist: { ready: true, reachable: false } }, ["google"]).ok, true);
  // Booking off: passes as in F-002.
  assert.equal(healthVerdict({ ...on, bookingEnabled: false, providers: { google: { ready: false, reachable: false }, microsoft: "off", altimist: "off" } }, ["google", "microsoft"]).ok, true);
  for (const bad of [undefined, null, [], { google: up }, { google: up, microsoft: "off", altimist: "off", github: "off" }, { google: "on", microsoft: "off", altimist: "off" },
    { google: { ready: "yes", reachable: true }, microsoft: "off", altimist: "off" }, { google: { ready: true }, microsoft: "off", altimist: "off" }]) {
    assert.equal(healthVerdict({ ...on, providers: bad }).ok, false, JSON.stringify(bad));
  }
});

test("nelVerdict: NEL or Report-To present fails", () => {
  assert.deepEqual(nelVerdict(new Headers({ "content-type": "text/html" })), { ok: true, present: [] });
  assert.deepEqual(nelVerdict(new Headers({ nel: '{"max_age":604800}', "report-to": "{}" })), { ok: false, present: ["nel", "report-to"] });
  assert.equal(nelVerdict(new Headers({ "Report-To": "{}" })).ok, false);
});

test("DNS verdicts: DS + AD, CAA issue, exactly one DMARC record", () => {
  const ds = { Status: 0, AD: true, Answer: [{ name: "patrickjv.com", type: 43, data: "2371 13 2 ABCD" }] };
  const noDs = { Status: 0, AD: true, Authority: [{ name: "com", type: 6, data: "a.gtld-servers.net. ..." }] };
  const caa = (AD) => ({ Status: 0, AD, Answer: [{ type: 257, data: '0 issue "letsencrypt.org"' }, { type: 257, data: '0 iodef "mailto:x@y"' }] });
  assert.deepEqual(dnssecVerdict(ds, caa(true)), { ok: true, ds: true, ad: true });
  assert.equal(dnssecVerdict(noDs, caa(true)).ok, false, "DS absent");
  assert.equal(dnssecVerdict(ds, caa(false)).ok, false, "not authenticated");
  assert.deepEqual(caaVerdict(caa(false)), { ok: true, count: 2 });
  assert.equal(caaVerdict({ Status: 0, Answer: [{ type: 257, data: '0 iodef "mailto:x@y"' }] }).ok, false, "iodef only");
  assert.equal(caaVerdict({ Status: 3 }).ok, false, "NXDOMAIN");
  const txt = (...data) => ({ Status: 0, Answer: data.map((d) => ({ type: 16, data: d })) });
  assert.deepEqual(dmarcVerdict(txt('"v=DMARC1; p=none; rua=mailto:hello@patrickjv.com; fo=1"')), { ok: true, count: 1, policy: "none" });
  assert.equal(dmarcVerdict(txt('"v=DMARC1; p=quar" "antine"')).policy, "quarantine", "split strings are joined");
  assert.equal(dmarcVerdict(txt('"v=DMARC1; p=none"', '"v=DMARC1; p=reject"')).ok, false, "two records");
  assert.equal(dmarcVerdict(txt('"v=spf1 -all"')).ok, false, "not DMARC");
  assert.equal(dmarcVerdict({ Status: 0 }).ok, false, "absent");
});

// ---- whole runs against a local mock ----
const TYPES = { ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".html": "text/html; charset=utf-8", ".pdf": "application/pdf", ".png": "image/png" };
const ext = (p) => p.slice(p.lastIndexOf("."));

// `root` is the site the mock serves (this checkout, or a scratch site with published runs). Under
// /projects/ it applies public/_headers as Cloudflare does: each matching rule's CSP, and the
// /projects/* X-Robots-Tag while that rule exists. `faults.projects` breaks one /projects response.
function mockSite(faults = {}, root = ROOT) {
  const file = (f) => readFileSync(join(root, f));
  const headersText = file("public/_headers").toString();
  const csp = expectedCsp(headersText);
  const robots = /^\/projects\/\*\n {2}X-Robots-Tag: noindex$/m.test(headersText);
  const pf = faults.projects ?? {};
  const base = { "strict-transport-security": "max-age=31536000; includeSubDomains", "x-content-type-options": "nosniff" };
  const allow = { limit: async () => ({ success: true }) };
  const env = {
    RL_MCP: allow, RL_BURST: allow, RL_INTRO: allow, INTRO_FROM: "intro@patrickjv.com", INTRO_TO_ADDRESS: "owner@example.com",
    EMAIL: { send: async () => { throw new Error("never"); } }, QUOTA: { idFromName: () => ({}), get: () => ({}) },
    ...(faults.noSalt ? {} : { QUOTA_SALT: "mock-salt-0123456789abcdef0123456789" }),
    // Booking switched on with none of its secrets set: enabled but not ready.
    ...(faults.bookingNotReady ? { BOOKING_ENABLED: "true" } : {}),
  };
  const h = faults.booking ? harness(faults.booking) : null;
  if (h && faults.bookingCaps) Object.assign(h.cfg.caps, faults.bookingCaps);
  const faq = faults.faq ? content.faq.map((f, k) => (k ? f : { ...f, a: f.a + " (changed)" })) : content.faq;
  const deps = { content: { ...content, faq }, now: () => new Date(), reserve: async () => { throw new Error("never"); }, sendEmail: async () => { throw new Error("never"); } };
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, headers, body = "") => { res.writeHead(status, { ...base, ...headers }); res.end(body); };
    if (url.pathname === "/mcp") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      // F-002: booking switched on and fully configured (the real BookingStore body, fake Google).
      if (h) {
        const r = await h.call(req.url, { method: req.method, headers: { "content-type": req.headers["content-type"], accept: req.headers.accept, "mcp-protocol-version": req.headers["mcp-protocol-version"] }, body: req.method === "POST" ? Buffer.concat(chunks).toString() : undefined });
        res.writeHead(r.status, Object.fromEntries(r.headers));
        return res.end(await r.text());
      }
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
    // F-005: the headers Cloudflare's _headers rules add under /projects/, then the faults.
    const p = url.pathname;
    const projectHeaders = (status) => {
      if (!p.startsWith("/projects/")) return {};
      const out = {};
      const own = status === 200 ? expectedCsp(headersText, p) : null;
      const policies = pf.csp && p === pf.csp.path ? pf.csp.value : own;
      if (policies) out["content-security-policy"] = policies;
      if ((robots && p !== pf.noRobots) || pf.robots) out["x-robots-tag"] = "noindex";
      return out;
    };
    if (pf.notFound404 === "ok" && p.startsWith("/projects/research-agent/runs/20000101T000000Z-000000/"))
      return send(200, { "content-type": "text/html; charset=utf-8" }, file("public/projects/index.html"));
    if (pf.notFound404 === "csp" && p.startsWith("/projects/research-agent/runs/20000101T000000Z-000000/"))
      return send(404, { "content-type": "text/html", "content-security-policy": "default-src 'none', default-src 'none'" }, file("public/404.html"));
    try {
      // Like the asset server's html_handling: /cv serves cv.html.
      if (faults.noPrivacy && url.pathname === "/privacy") throw new Error("missing");
      if (pf.missing === p) throw new Error("missing");
      const path = url.pathname === "/cv" ? "/cv.html" : url.pathname === "/privacy" ? "/privacy.html"
        : url.pathname.endsWith("/") ? url.pathname + "index.html"
        : /^\/(writing|projects)\//.test(url.pathname) && !url.pathname.includes(".") ? url.pathname + ".html" : url.pathname;
      let body = file("public" + path);
      if (faults.emptyImages && /\.(webp|jpg|ico)$/.test(url.pathname)) body = Buffer.alloc(0);
      if (pf.bytes === p) body = Buffer.concat([body, Buffer.from(" ")]);
      const type = pf.type?.path === p ? pf.type.value : TYPES[ext(path)] ?? "application/octet-stream";
      return send(200, { "content-type": type, ...projectHeaders(200) }, body);
    } catch {
      return send(404, { "content-type": "text/html", ...projectHeaders(404) }, file("public/404.html"));
    }
  });
}

// `root` is the checkout smoke.mjs compares against: this one, or a scratch site holding its own copy
// of smoke.mjs (which reads the files next to it).
async function runSmoke(faults, args = [], root = ROOT) {
  const server = mockSite(faults, root);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address();
    return await new Promise((resolve) => execFile(process.execPath, [join(root, "smoke.mjs"), `http://127.0.0.1:${port}`, ...args], { timeout: 60_000 }, (err, stdout) =>
      resolve({ code: err ? err.code : 0, lines: stdout.split("\n"), fails: stdout.split("\n").filter((l) => l.startsWith("FAIL")) })));
  } finally { server.close(); }
}

test("smoke against a correct mock: no FAIL, exit 0", async () => {
  const r = await runSmoke({}, ["--mcp"]);
  assert.deepEqual(r.fails, []);
  assert.equal(r.code, 0, r.lines.join("\n"));
});

// F-002 Observability: with booking on, the smoke makes one booking request for the first free slot,
// checks its shape, withdraws it with cancel_booking (reading cancelled), and checks that an email
// argument is refused. No free slot, the allowance used up (429) or the slot gone (409) is
// reported as skipped, and passes.
test("smoke with booking on: one booking request made and withdrawn, and an email argument refused", async () => {
  const r = await runSmoke({ booking: {} }, ["--mcp"]);
  assert.deepEqual(r.fails, [], r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^PASS .*book_meeting.*cancel_booking/.test(l) && /cancelled/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^PASS .*email argument.*refused/.test(l)), r.lines.join("\n"));
});

test("smoke with booking on: no free slot, or the request allowance used up, is skipped and passes", async () => {
  const busy = await runSmoke({ booking: { fetchOpts: { busy: [{ start: "2026-01-01T00:00:00Z", end: "2027-12-31T00:00:00Z" }] } } }, ["--mcp"]);
  assert.deepEqual(busy.fails, [], busy.lines.join("\n"));
  assert.ok(busy.lines.some((l) => /^PASS .*book_meeting.*skipped: no free slot/.test(l)), busy.lines.join("\n"));
  const spent = await runSmoke({ booking: {}, bookingCaps: { requestsPerDay: 0 } }, ["--mcp"]);
  assert.deepEqual(spent.fails, [], spent.lines.join("\n"));
  assert.ok(spent.lines.some((l) => /^PASS .*book_meeting.*skipped: .*rate_limited/.test(l)), spent.lines.join("\n"));
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
    [{ noSalt: true }, /patrickjv\/health/],
    [{ bookingNotReady: true }, /patrickjv\/health/],
    [{ noPrivacy: true }, /\/privacy/],
    // F-002: booking on and "ready", but get_availability failing, is not "no free slot".
    [{ booking: { fetchOpts: { fail: { freebusy: true } } } }, /book_meeting/],
  ];
  const results = await Promise.all(cases.map(([f]) => runSmoke(f, f.serverName || f.faq || f.noSalt || f.bookingNotReady || f.booking ? ["--mcp"] : [])));
  results.forEach((r, k) => {
    const [f, pattern] = cases[k];
    assert.equal(r.code, 1, `${JSON.stringify(f)}: exit ${r.code}\n${r.lines.join("\n")}`);
    assert.ok(r.fails.some((l) => pattern.test(l)), `${JSON.stringify(f)}: no FAIL matching ${pattern}\n${r.fails.join("\n")}`);
  });
});

// ---- F-005: /projects against a scratch site with synthetic runs published ----
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { build } from "../build.mjs";
import { report, scorecard, dump, sha, png, clearRecorded } from "./projects-helpers.mjs";

const TODAY = "2026-11-12";
const RUN_A = "20261111T140100Z-000001", RUN_B = "20261111T140200Z-000002";
const FIG_1 = "calls/1/out/vol_by_minute.png", FIG_2 = "calls/2/out/spread.png";
const SIDE = { title: "Research agent", summary: "A synthetic side-project entry.", url: "/projects/research-agent" };
const SIDE_CARD = `<li>
            <article aria-labelledby="s-03-h">
              <span class="label">S-03</span>
              <h3 id="s-03-h"><a href="/projects/research-agent">${SIDE.title}</a></h3>
              <p>${SIDE.summary}</p>
            </article>
          </li>
        </ul>`;

// A scratch copy of this site with two synthetic runs (A with no figures, B with two) and the
// fixture scorecard recorded in published.json, built, and with its own smoke.mjs. `launched`
// also makes the launch PR's content.json and index.html edits. Hand-made fixtures only.
function projectsSite({ launched = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "smoke-projects-"));
  const root = join(base, "site");
  mkdirSync(root);
  for (const f of ["content.json", "cv.json", "build-state.json", "writing", "public", "projects", "smoke.mjs", "lib"]) cpSync(join(ROOT, f), join(root, f), { recursive: true });
  clearRecorded(root);
  const put = (f, b) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), b); };
  const m = { manifest_version: "1.0.0", runs: {} };
  for (const [id, figures] of [[RUN_A, {}], [RUN_B, { [FIG_1]: png({ width: 40, height: 30 }), [FIG_2]: png({ width: 20, height: 10 }) }]]) {
    const doc = report();
    doc.run_id = id;
    doc.figures = Object.keys(figures);
    const files = { "report.json": Buffer.from(dump(doc)), "report.md": Buffer.from("# Report\n\nSynthetic result.\n"), ...figures };
    for (const [f, b] of Object.entries(files)) put(`projects/research-agent/runs/${id}/${f}`, b);
    m.runs[id] = { checked: TODAY, export_digest: "a".repeat(64), tool_version: "0.1.0", exported_at: "2026-11-11T15:04:05Z",
      files: Object.fromEntries(Object.entries(files).sort().map(([f, b]) => [f, sha(b)])), alt: Object.fromEntries(Object.keys(figures).map((f) => [f, "A synthetic chart."])) };
  }
  const card = Buffer.from(dump(scorecard()));
  put("projects/research-agent/scorecard/scorecard.json", card);
  m.scorecard = { eval_id: scorecard().eval_id, checked: TODAY, export_digest: "b".repeat(64), tool_version: "0.1.0", exported_at: "2026-11-11T16:00:00Z", files: { "scorecard.json": sha(card) } };
  put("projects/research-agent/published.json", JSON.stringify(m, null, 2) + "\n");
  if (launched) {
    const c = JSON.parse(readFileSync(join(root, "content.json"), "utf8"));
    c.pages.projects.launched = true;
    delete c.pages.projects._status;
    c.side_projects.push(SIDE);
    writeFileSync(join(root, "content.json"), JSON.stringify(c, null, 2) + "\n");
    const html = readFileSync(join(root, "public/index.html"), "utf8");
    writeFileSync(join(root, "public/index.html"), html.replace(/(<section id="side-projects"[\s\S]*?)<\/ul>/, (x, a) => a + SIDE_CARD));
  }
  const r = build({ root, today: TODAY, now: Date.parse("2026-11-12T12:00:00Z") });
  assert.deepEqual(r.errors, []);
  return { root, done: () => rmSync(base, { recursive: true, force: true }) };
}

const runPath = (id, f = "") => `/projects/research-agent/runs/${id}/${f}`;
const PROJECT_PATHS = ["/projects/", "/projects/index.md", "/projects/research-agent", "/projects/research-agent.md",
  runPath(RUN_A), runPath(RUN_A, "report.json"), runPath(RUN_A, "report.md"),
  runPath(RUN_B), runPath(RUN_B, FIG_1), runPath(RUN_B, FIG_2), runPath(RUN_B, "report.json"), runPath(RUN_B, "report.md")];
const ROBOTS_PATHS = ["/projects/research-agent", "/projects/research-agent.md", runPath(RUN_B, FIG_1)];
const passes = (r, pattern) => r.lines.some((l) => l.startsWith("PASS ") && pattern.test(l));
const re = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

// What a correct run must PASS for the checkout at `root`, read from its own published.json and
// launch switch, so the assertions hold in any state: before the first export, with runs, launched.
function assertProjectsSmoke(r, root) {
  assert.deepEqual(r.fails, [], r.lines.join("\n"));
  const mf = join(root, "projects/research-agent/published.json");
  const manifest = existsSync(mf) ? JSON.parse(readFileSync(mf, "utf8")) : undefined;
  const isLaunched = JSON.parse(readFileSync(join(root, "content.json"), "utf8")).pages.projects.launched === true;
  for (const [p] of projectPages(manifest)) assert.ok(r.lines.some((l) => l.startsWith(`PASS ${p}: 200 `) && /deployed = repo/.test(l)), `${p}\n${r.lines.join("\n")}`);
  assert.ok(passes(r, /\/projects\/research-agent: exactly one CSP, = public\/_headers/), r.lines.join("\n"));
  assert.ok(passes(r, /runs\/20000101T000000Z-000000\/: 404, at most one CSP/), r.lines.join("\n"));
  const fig = firstFigure(manifest);
  const robots = ["/projects/research-agent", "/projects/research-agent.md", ...(fig ? [fig] : [])];
  const label = isLaunched ? "no X-Robots-Tag (launched)" : "X-Robots-Tag: noindex (not launched)";
  for (const p of robots) assert.ok(passes(r, re(`${p}: ${label}`)), `${p}\n${r.lines.join("\n")}`);
  assert.equal(r.lines.filter((l) => /X-Robots-Tag/.test(l)).length, robots.length, "one X-Robots-Tag check per listed response, and no figure checked when none is published");
}

test("F-005 (US-3, D9): smoke on the repository as it is checks the /projects paths its published.json lists, the showcase CSP, the 404 and X-Robots-Tag for its launch state", async () => {
  assertProjectsSmoke(await runSmoke({}), ROOT);
});

test("F-005 (US-3, D9): the repository-state assertions hold in other states too: runs published, and launched", async () => {
  for (const launched of [false, true]) {
    const s = projectsSite({ launched });
    try { assertProjectsSmoke(await runSmoke({}, [], s.root), s.root); } finally { s.done(); }
  }
});

test("F-005 (US-3, D9): smoke against a correct dark deploy with runs: every page, run file and figure 200 and deployed = repo, noindex on the first figure, no FAIL", async () => {
  const s = projectsSite();
  try {
    const r = await runSmoke({}, [], s.root);
    assert.deepEqual(r.fails, [], r.lines.join("\n"));
    assert.equal(r.code, 0);
    for (const p of PROJECT_PATHS) assert.ok(passes(r, re(`${p}: 200 `)) && r.lines.some((l) => l.startsWith(`PASS ${p}: 200 `) && /deployed = repo/.test(l)), `${p}\n${r.lines.join("\n")}`);
    for (const p of ROBOTS_PATHS) assert.ok(passes(r, re(`${p}: X-Robots-Tag: noindex`)), `${p}\n${r.lines.join("\n")}`);
    assert.ok(!r.lines.some((l) => l.includes(FIG_2) && /X-Robots-Tag/.test(l)), "only the first figure is checked for noindex");
  } finally { s.done(); }
});

test("F-005 (US-3, D9): smoke FAILs a dark deploy broken one way at a time", async () => {
  const s = projectsSite();
  try {
    const showcase = "/projects/research-agent";
    const cases = [
      [{ missing: "/projects/index.md" }, /\/projects\/index\.md: 200/],
      [{ bytes: showcase }, re(`${showcase}: 200`)],
      [{ type: { path: "/projects/research-agent.md", value: "text/plain" } }, /\/projects\/research-agent\.md: 200/],
      [{ missing: runPath(RUN_A) }, re(`${runPath(RUN_A)}: 200`)],
      [{ type: { path: runPath(RUN_A, "report.json"), value: "text/plain" } }, re(`${runPath(RUN_A, "report.json")}: 200`)],
      [{ bytes: runPath(RUN_A, "report.md") }, re(`${runPath(RUN_A, "report.md")}: 200`)],
      [{ bytes: runPath(RUN_B, FIG_2) }, re(`${runPath(RUN_B, FIG_2)}: 200`)],
      [{ type: { path: runPath(RUN_B, FIG_1), value: "application/octet-stream" } }, re(`${runPath(RUN_B, FIG_1)}: 200`)],
      [{ csp: { path: showcase, value: null } }, /research-agent: exactly one CSP/],
      [{ csp: { path: showcase, value: "default-src 'none'" } }, /research-agent: exactly one CSP/],
      [{ csp: { path: showcase, value: "default-src 'none', default-src 'none'" } }, /research-agent: exactly one CSP/],
      [{ notFound404: "ok" }, /20000101T000000Z-000000\/: 404/],
      [{ notFound404: "csp" }, /20000101T000000Z-000000\/: 404/],
      ...ROBOTS_PATHS.map((p) => [{ noRobots: p }, re(`${p}: X-Robots-Tag: noindex`)]),
    ];
    const results = await Promise.all(cases.map(([f]) => runSmoke({ projects: f }, [], s.root)));
    results.forEach((r, k) => {
      const [f, pattern] = cases[k];
      assert.equal(r.code, 1, `${JSON.stringify(f)}: exit ${r.code}\n${r.lines.join("\n")}`);
      assert.ok(r.fails.some((l) => pattern.test(l)), `${JSON.stringify(f)}: no FAIL matching ${pattern}\n${r.fails.join("\n")}`);
      assert.equal(r.fails.length, 1, `${JSON.stringify(f)}: only its own check fails\n${r.fails.join("\n")}`);
    });
  } finally { s.done(); }
});

test("F-005 (D9): after launch, smoke requires X-Robots-Tag absent on the showcase, its Markdown and the first figure, and FAILs when it is there", async () => {
  const s = projectsSite({ launched: true });
  try {
    assert.doesNotMatch(readFileSync(join(s.root, "public/_headers"), "utf8"), /X-Robots-Tag/);
    const ok = await runSmoke({}, [], s.root);
    assert.deepEqual(ok.fails, [], ok.lines.join("\n"));
    for (const p of ROBOTS_PATHS) assert.ok(passes(ok, re(`${p}: no X-Robots-Tag (launched)`)), `${p}\n${ok.lines.join("\n")}`);
    const bad = await runSmoke({ projects: { robots: true } }, [], s.root);
    assert.equal(bad.code, 1);
    for (const p of ROBOTS_PATHS) assert.ok(bad.fails.some((l) => re(`${p}: no X-Robots-Tag (launched)`).test(l)), `${p}\n${bad.fails.join("\n")}`);
    assert.equal(bad.fails.length, ROBOTS_PATHS.length, bad.fails.join("\n"));
  } finally { s.done(); }
});
