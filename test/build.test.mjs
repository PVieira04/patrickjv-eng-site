// Tests for build.mjs: the section-aware page check, the inline-code (CSP) guards, safe JSON
// embedding, security.txt validation, content-hash dates and validate-before-write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, cpSync, mkdtempSync, writeFileSync, rmSync, readdirSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as buildModule from "../build.mjs";
import { build, checkPage, inlineCode, safeJson, checkSecurityTxt, checkHeaders, writeStaged, parsePost } from "../build.mjs";

const { employerMention } = buildModule; // F-004 (D8)

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const content = JSON.parse(readFileSync(join(ROOT, "content.json"), "utf8"));
const page = readFileSync(join(ROOT, "public/index.html"), "utf8");

// Replace exactly one occurrence, so a fixture can never silently fail to apply.
function mutate(html, from, to) {
  const n = html.split(from).length - 1;
  assert.equal(n, 1, `fixture: expected exactly one "${from}", found ${n}`);
  return html.replace(from, to);
}
const fails = (html, pattern) => {
  const errors = checkPage(html, content);
  assert.ok(errors.length > 0, "expected the page check to fail");
  assert.ok(errors.some((e) => pattern.test(e)), `no error matched ${pattern}:\n${errors.join("\n")}`);
};

test("the real page passes the section-aware check", () => {
  assert.deepEqual(checkPage(page, content), []);
});

test("a hidden Skills section fails", () => {
  fails(mutate(page, '<section id="skills"', '<section hidden id="skills"'), /section #skills is missing or hidden/);
});

test("an aria-hidden About section fails", () => {
  fails(mutate(page, '<section id="about"', '<section aria-hidden="true" id="about"'), /section #about/);
});

test("a changed mailto target fails even when the visible text is unchanged", () => {
  fails(mutate(page, '<dd><a href="mailto:hello@patrickjv.com">', '<dd><a href="mailto:someone@example.com">'), /mailto/);
});

test("a changed LinkedIn target fails", () => {
  fails(mutate(page, '<li><a href="https://www.linkedin.com/in/patrickvieira/" rel="me">LinkedIn</a></li>', '<li><a href="https://www.linkedin.com/in/someone-else/" rel="me">LinkedIn</a></li>'), /LinkedIn/);
});

test("removing one skill fails", () => {
  fails(mutate(page, '<li><span aria-hidden="true">06</span>Python</li>', ""), /Skills/);
});

test("a skill commented out fails", () => {
  fails(mutate(page, '<li><span aria-hidden="true">06</span>Python</li>', '<!-- <li><span aria-hidden="true">06</span>Python</li> -->'), /Skills/);
});

test("changing the stat 40 to 4 fails (no substring match inside 1,400+)", () => {
  fails(mutate(page, '<span class="value">40</span>', '<span class="value">4</span>'), /In figures values/);
});

test("a skill moved into another section fails", () => {
  let html = mutate(page, '<li><span aria-hidden="true">06</span>Python</li>', "");
  html = mutate(html, "<p>Two years in a classroom left me judging tooling", "<p>Python</p><p>Two years in a classroom left me judging tooling");
  fails(html, /Skills|Background/);
});

test("removing the privacy note fails", () => {
  fails(mutate(page, '<p class="privacy">', '<p class="privacy" hidden>'), /privacy/);
});

test("a content.json string with no check fails", () => {
  const errors = checkPage(page, { ...content, extra: "A new field nobody checks" });
  assert.ok(errors.some((e) => /not checked against the page/.test(e)));
});

test("a new field is unchecked even when its value duplicates a checked one (coverage is by path)", () => {
  const top = checkPage(page, { ...content, new_field: content.person.name });
  assert.ok(top.some((e) => /not checked against the page/.test(e) && /new_field/.test(e)), top.join("\n"));
  const nested = checkPage(page, { ...content, person: { ...content.person, nickname: content.person.name } });
  assert.ok(nested.some((e) => /person\.nickname/.test(e)), nested.join("\n"));
  const inList = checkPage(page, { ...content, work: content.work.map((w, k) => (k ? w : { ...w, subtitle: w.title })) });
  assert.ok(inList.some((e) => /work\.0\.subtitle/.test(e)), inList.join("\n"));
});

test("_headers guard: CSP on /*, detach lines, a wildcard CSP rule or a duplicate CSP path all fail", () => {
  const csp = "  Content-Security-Policy: default-src 'none'";
  const ok = `# comment\n/*\n  X-Frame-Options: DENY\n\n/\n${csp}\n\n/fonts/a.woff2\n  Cache-Control: public, max-age=2592000\n${csp}\n`;
  assert.deepEqual(checkHeaders(ok), []);
  assert.match(checkHeaders(ok.replace("  X-Frame-Options: DENY", `  X-Frame-Options: DENY\n${csp}`)).join(), /on \/\*/);
  assert.match(checkHeaders(ok + "\n/index.md\n  ! Content-Security-Policy\n").join(), /detach/);
  assert.match(checkHeaders(ok + `\n/fonts/*\n${csp}\n`).join(), /wildcard/);
  assert.match(checkHeaders(ok + `\n/blog/:slug\n${csp}\n`).join(), /wildcard/);
  assert.match(checkHeaders(ok + `\n/\n${csp}\n`).join(), /twice/);
});

test("generated _headers: one exact rule per font file, no /fonts/* (a missing font gets only the 404 page's policy)", () => {
  const headers = readFileSync(join(ROOT, "public/_headers"), "utf8");
  assert.deepEqual(checkHeaders(headers), []);
  assert.doesNotMatch(headers, /^\/fonts\/\*/m);
  for (const f of readdirSync(join(ROOT, "public/fonts"))) {
    const rule = headers.split("\n\n").map((b) => b.replace(/^(#.*\n)+/, "")).find((b) => b.startsWith(`/fonts/${f}\n`));
    assert.ok(rule, `no rule for /fonts/${f}`);
    assert.match(rule, /Cache-Control: public, max-age=2592000/);
    assert.match(rule, /Content-Security-Policy: default-src 'none'/);
  }
});

test("the page's WebMCP request_intro fetch sends the MCP protocol version and Streamable HTTP Accept", async () => {
  const { PROTOCOL_VERSIONS } = await import("../mcp/handler.js");
  const script = inlineCode(page, { styles: 1, scripts: 1 }).scripts[0];
  const call = script.slice(script.indexOf('fetch("/mcp"'), script.indexOf("signal: signal", script.indexOf('fetch("/mcp"')));
  assert.match(call, new RegExp(`"mcp-protocol-version": "${PROTOCOL_VERSIONS[0]}"`));
  assert.match(call, /accept: "application\/json, text\/event-stream"/);
  assert.equal(script.split('fetch("/mcp"').length - 1, 1, "one request, no initialize round-trip");
});

test("inline-code guards: attributes, case and quoting cannot hide inline code", () => {
  const base = '<script type="application/ld+json">{}</script><style>a{}</style><script>1</script>';
  assert.deepEqual(inlineCode(base, { styles: 1, scripts: 1 }).errors, [], "JSON-LD is a data block, not a script");
  assert.equal(inlineCode(base, { styles: 1, scripts: 1 }).scripts[0], "1");
  assert.match(inlineCode(base + '<STYLE media="all">b{}</STYLE>', { styles: 1, scripts: 1 }).errors.join(), /found 2 and 1/);
  assert.match(inlineCode(base + '<script type="module">2</script>', { styles: 1, scripts: 1 }).errors.join(), /found 1 and 2/);
  for (const a of [`style="color:red"`, `style='color:red'`, "style=color:red", 'STYLE="x"', 'Style = "x"'])
    assert.match(inlineCode(base + `<p ${a}>x</p>`, { styles: 1, scripts: 1 }).errors.join(), /inline style attribute/, a);
  assert.match(inlineCode(base + '<a ONCLICK="x()">x</a>', { styles: 1, scripts: 1 }).errors.join(), /onclick/);
  assert.match(inlineCode(base + '<script src="/x.js"></script>', { styles: 1, scripts: 1 }).errors.join(), /external scripts/);
});

test("JSON spliced into a script cannot close it", () => {
  const s = safeJson({ a: "</script><script>alert(1)</script>", b: "line\u2028sep\u2029" });
  assert.ok(!s.includes("<"));
  assert.ok(!/[\u2028\u2029]/.test(s));
  assert.deepEqual(JSON.parse(s), { a: "</script><script>alert(1)</script>", b: "line\u2028sep\u2029" });
});

test("security.txt Expires: invalid, too soon and too far all fail with a clear message", () => {
  const now = Date.parse("2026-10-06T00:00:00Z");
  assert.match(checkSecurityTxt("Expires: next year\n", now).join(), /not a valid date/);
  assert.match(checkSecurityTxt("Contact: mailto:x@y\n", now).join(), /no Expires/);
  assert.match(checkSecurityTxt("Expires: 2026-10-20T00:00:00Z\n", now).join(), /bump Expires/);
  assert.match(checkSecurityTxt("Expires: 2029-01-01T00:00:00Z\n", now).join(), /more than a year/);
  assert.deepEqual(checkSecurityTxt("Expires: 2027-10-06T00:00:00.000Z\n", now), []);
});

// ---- whole-build tests, on a scratch copy of the inputs ----
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "site-build-"));
  cpSync(join(ROOT, "content.json"), join(dir, "content.json"));
  cpSync(join(ROOT, "cv.json"), join(dir, "cv.json"));
  cpSync(join(ROOT, "writing"), join(dir, "writing"), { recursive: true });
  cpSync(join(ROOT, "build-state.json"), join(dir, "build-state.json"));
  cpSync(join(ROOT, "public"), join(dir, "public"), { recursive: true });
  return dir;
}
const NOW = Date.parse("2026-10-06T12:00:00Z");

test("the committed tree is up to date, and --check does not depend on the date", () => {
  const dir = scratch();
  try {
    assert.deepEqual(build({ root: dir, check: true, today: "2099-01-01", now: NOW }).errors, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("building twice is a no-op, and the date moves only when the output changes", () => {
  const dir = scratch();
  try {
    const first = build({ root: dir, today: "2099-01-01", now: NOW });
    assert.deepEqual(first.errors, []);
    assert.deepEqual(first.stale, [], "a clean tree must not be rewritten (not even its date)");
    // Change the copy (content.json and the page together): the date becomes "today".
    const swap = (f, a, b) => { const p = join(dir, f); const t = readFileSync(p, "utf8"); assert.ok(t.includes(a)); writeFileSync(p, t.replace(a, b)); };
    swap("content.json", '"Python"', '"Python 3"');
    swap("public/index.html", "</span>Python</li>", "</span>Python 3</li>");
    const changed = build({ root: dir, today: "2099-01-02", now: NOW });
    assert.deepEqual(changed.errors, []);
    assert.equal(changed.date, "2099-01-02");
    assert.ok(changed.stale.includes("build-state.json"));
    // ...and a second run converges immediately, on any later day.
    const again = build({ root: dir, today: "2099-01-03", now: NOW });
    assert.deepEqual(again, { errors: [], stale: [], date: "2099-01-02" });
    assert.deepEqual(build({ root: dir, check: true, today: "2099-02-01", now: NOW }).errors, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failing build writes nothing", () => {
  const dir = scratch();
  try {
    // A skill changed in content.json only: index.md/llms.txt would change, but the page check fails.
    const p = join(dir, "content.json");
    writeFileSync(p, readFileSync(p, "utf8").replace('"Python"', '"Rust"'));
    const before = ["public/index.md", "public/llms.txt", "public/index.html", "build-state.json"].map((f) => readFileSync(join(dir, f), "utf8"));
    const r = build({ root: dir, today: "2099-01-01", now: NOW });
    assert.ok(r.errors.some((e) => /Skills/.test(e)));
    assert.ok(r.stale.length > 0, "there was something to write");
    const after = ["public/index.md", "public/llms.txt", "public/index.html", "build-state.json"].map((f) => readFileSync(join(dir, f), "utf8"));
    assert.deepEqual(after, before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("JSON-LD dateModified is a full ISO 8601 datetime (Search Console: a bare date is invalid)", () => {
  const ld = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const profile = ld["@graph"].find((n) => n["@type"] === "ProfilePage");
  assert.match(profile.dateModified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
  assert.ok(Number.isFinite(Date.parse(profile.dateModified)));
});

// dateModified hashes content-bearing outputs only: the page, index.md, llms.txt, sitemap.xml and
// robots.txt (rendered with a placeholder date) plus the images the page references (C3-F10).
test("changing a page-referenced image's bytes moves dateModified (portrait variants, share card, icons)", () => {
  for (const f of ["public/photo.webp", "public/photo-320.webp", "public/og-card.jpg", "public/favicon.ico", "public/apple-touch-icon.png"]) {
    const dir = scratch();
    try {
      // Converge the scratch tree first, so the check below can only fail because of the asset.
      assert.deepEqual(build({ root: dir, today: "2098-01-01", now: NOW }).errors, []);
      assert.deepEqual(build({ root: dir, check: true, now: NOW }).errors, [], "baseline");
      const p = join(dir, f);
      writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from([0])]));
      assert.ok(build({ root: dir, check: true, now: NOW }).errors.some((e) => /build-state\.json does not match/.test(e)), `${f}: --check did not notice`);
      const r = build({ root: dir, today: "2099-01-01", now: NOW });
      assert.deepEqual(r.errors, [], f);
      assert.equal(r.date, "2099-01-01", f);
      assert.deepEqual(build({ root: dir, check: true, now: NOW }).errors, [], `${f}: does not converge`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("non-content changes leave dateModified alone (_headers inputs, 404 page, fonts, security.txt, mcp-registry-auth, unreferenced image)", () => {
  for (const [f, change] of [
    ["public/404.html", (b) => Buffer.from(b.toString().replace(/<h1([^>]*)>([^<]*)</, "<h1$1>$2 (moved)<"))],
    ["public/fonts/ibm-plex-mono-latin-400.woff2", (b) => Buffer.concat([b, Buffer.from([0])])],
    ["public/.well-known/security.txt", (b) => Buffer.from(b.toString().replace(/^Expires:.*$/m, "Expires: 2027-06-01T00:00:00.000Z"))],
    ["public/.well-known/mcp-registry-auth", (b) => Buffer.concat([b, Buffer.from("\n")])],
    ["public/unreferenced-test.png", () => Buffer.from([1, 2, 3])],
  ]) {
    const dir = scratch();
    try {
      assert.deepEqual(build({ root: dir, today: "2098-01-01", now: NOW }).errors, []);
      const before = build({ root: dir, check: true, now: NOW });
      assert.deepEqual(before.errors, [], "baseline");
      const p = join(dir, f);
      const old = existsSync(p) ? readFileSync(p) : Buffer.alloc(0);
      const changed = change(old);
      assert.notDeepEqual(changed, old, `${f}: fixture did not change the file`);
      writeFileSync(p, changed);
      const r = build({ root: dir, today: "2099-01-01", now: NOW });
      assert.deepEqual(r.errors, [], f);
      assert.equal(r.date, before.date, `${f}: dateModified moved`);
      assert.ok(!r.stale.includes("build-state.json"), `${f}: build-state.json rewritten`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("writeStaged: a failed rename rolls back the files already replaced and leaves no temp files", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-write-"));
  try {
    for (const f of ["a", "b", "c"]) writeFileSync(join(dir, f), `old ${f}`);
    const previous = { a: "old a", b: "old b", c: "old c", d: null };
    let renames = 0;
    const io = { writeFileSync, unlinkSync, renameSync: (x, y) => { if (++renames === 3) throw new Error("disk full"); renameSync(x, y); } };
    assert.throws(() => writeStaged(dir, { a: "new a", b: "new b", c: "new c", d: "new d" }, previous, io), (e) => e.writePhase && e.rolledBack === true);
    assert.deepEqual(["a", "b", "c"].map((f) => readFileSync(join(dir, f), "utf8")), ["old a", "old b", "old c"]);
    assert.deepEqual(readdirSync(dir).sort(), ["a", "b", "c"], "no temp files and no new file left behind");
    // A rollback that cannot complete says so.
    renames = 0;
    const stuck = { ...io, writeFileSync: (f, t) => { if (!f.endsWith(".tmp")) throw new Error("read-only"); writeFileSync(f, t); } };
    assert.throws(() => writeStaged(dir, { a: "new a", b: "new b", c: "new c" }, previous, stuck), (e) => e.writePhase && e.rolledBack === false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a build whose write fails throws a write-phase error after restoring the tree", () => {
  const dir = scratch();
  try {
    const p = join(dir, "content.json");
    writeFileSync(p, readFileSync(p, "utf8").replace('"Python"', '"Python 3"'));
    const h = join(dir, "public/index.html");
    writeFileSync(h, readFileSync(h, "utf8").replace("</span>Python</li>", "</span>Python 3</li>"));
    const outs = ["public/index.md", "public/llms.txt", "public/index.html", "build-state.json"];
    const before = outs.map((f) => readFileSync(join(dir, f), "utf8"));
    let renames = 0;
    const io = { writeFileSync, unlinkSync, renameSync: (x, y) => { if (++renames === 2) throw new Error("EIO"); renameSync(x, y); } };
    assert.throws(() => build({ root: dir, today: "2099-01-01", now: NOW, io }), (e) => e.writePhase && e.rolledBack);
    assert.deepEqual(outs.map((f) => readFileSync(join(dir, f), "utf8")), before);
    assert.ok(!outs.some((f) => existsSync(join(dir, f) + ".tmp")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("head metadata is generated from content.json", () => {
  const dir = scratch();
  try {
    const p = join(dir, "public/index.html");
    writeFileSync(p, readFileSync(p, "utf8").replace(/(<meta property="og:description" content=")[^"]*/, "$1Obsolete description"));
    assert.ok(build({ root: dir, check: true, now: NOW }).errors.some((e) => /out of date.*index\.html/.test(e)));
    assert.deepEqual(build({ root: dir, now: NOW }).errors, []);
    assert.ok(readFileSync(p, "utf8").includes(`<meta property="og:description" content="${content.person.tagline}">`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Writing: posts are parsed strictly, published as HTML and Markdown with their own CSP rules, and
// covered by the employer guard like the page.
test("writing: front matter is required and checked", () => {
  assert.throws(() => parsePost("x", "# no front matter"), /missing front matter/);
  assert.throws(() => parsePost("x", "---\ntitle: T\ndescription: D\n---\nbody"), /needs date/);
  assert.throws(() => parsePost("x", "---\ntitle: T\ndescription: D\ndate: 8 Oct\n---\nbody"), /YYYY-MM-DD/);
  assert.throws(() => parsePost("Bad_Slug", "---\ntitle: T\ndescription: D\ndate: 2026-10-08\n---\nbody"), /slug/);
  assert.equal(parsePost("ok", "---\ntitle: T\ndescription: D\ndate: 2026-10-08\n---\n\n# T\n").title, "T");
});

test("writing: every post is published as HTML and Markdown, listed, mapped and given one CSP rule per path", () => {
  const headers = readFileSync(join(ROOT, "public/_headers"), "utf8");
  const sitemap = readFileSync(join(ROOT, "public/sitemap.xml"), "utf8");
  const llms = readFileSync(join(ROOT, "public/llms.txt"), "utf8");
  const index = readFileSync(join(ROOT, "public/writing/index.html"), "utf8");
  const slugs = readdirSync(join(ROOT, "writing")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  assert.ok(slugs.length >= 1);
  for (const s of slugs) {
    assert.ok(existsSync(join(ROOT, `public/writing/${s}.html`)) && existsSync(join(ROOT, `public/writing/${s}.md`)), s);
    assert.match(index, new RegExp(`href="/writing/${s}"`));
    assert.match(sitemap, new RegExp(`/writing/${s}</loc>`));
    assert.match(llms, new RegExp(`/writing/${s}\\.md\\)`));
    for (const path of [`/writing/${s}`, `/writing/${s}.html`]) assert.equal(headers.split("\n").filter((l) => l === path).length, 1, `one rule for ${path}`);
  }
  assert.deepEqual(checkHeaders(headers), []);
});

test("writing: a post naming an employer fails the build", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "writing/zz-test.md"), "---\ntitle: T\ndescription: D\ndate: 2026-10-08\n---\n\n# T\n\nAt Altimist we do this.\n");
    const r = build({ root: dir, check: true, today: "2026-10-08" });
    assert.ok(r.errors.some((e) => /writing\/zz-test\.(html|md) names an employer/.test(e)), r.errors.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- F-004: the employer guard's one exception (D8), the Microsoft secret's expiry (D6), and
// booking.json's sign-in settings checked by the build (D7) ----------------------------------------

// A scratch tree with booking.json, its signin settings replaced by `signin` (if given).
function scratchWith(signin) {
  const dir = scratch();
  const cfg = JSON.parse(readFileSync(join(ROOT, "booking.json"), "utf8"));
  if (signin !== undefined) cfg.signin = signin;
  writeFileSync(join(dir, "booking.json"), JSON.stringify(cfg, null, 2));
  return dir;
}

test("F-004 (D8): employerMention allows exactly 'Altimist ID', altimist.id and URLs on it, the altimist sign-in paths, \"altimist\" quoted and try=altimist (raw or encoded); anything else naming Altimist is caught", () => {
  for (const ok of [
    "Sign in with Altimist ID to book", "No Altimist ID? Create one", "Google, Microsoft or Altimist ID.",
    "https://altimist.id", "https://altimist.id/signup/self-service?app_id=patrickjv-com&return_to=x", "form-action 'self' https://altimist.id;", "see altimist.id.",
    '<form method="post" action="/book/confirm/altimist">', "https://patrickjv.com/book/callback/altimist", 'var n = { "altimist": "Altimist ID" };', 'p === "altimist"',
    "/book/confirm?t=abc&try=altimist", "return_to=https%3A%2F%2Fpatrickjv.com%2Fbook%2Fconfirm%3Ft%3Dabc%26try%3Daltimist", "&amp;try=altimist\"",
    "plain text with nothing to see",
  ]) assert.equal(employerMention(ok), null, ok);
  for (const [bad, found] of [
    ["Altimist", "Altimist"], ["altimist id", "altimist"], ["Altimist IDs", "Altimist"], ["altimist.com", "altimist"], ["ALTIMIST ID", "ALTIMIST"],
    ["Altimist IDx", "Altimist"], ["altimist.identity", "altimist"], ["altimist.id.evil.example", "altimist"], ["'altimist'", "altimist"],
    ["/book/confirm/altimistx", "altimist"], ["try=altimists", "altimist"], ["the company", "the company"], ["a fintech", "fintech"],
    ["Altimist ID and Altimist", "Altimist"],
  ]) assert.equal(employerMention(bad), found, bad);
});

test("F-004 (D8): the build applies that one function to every page: an allowed form passes in a post, anything else fails", () => {
  const post = (body) => `---\ntitle: T\ndescription: D\ndate: 2026-10-08\n---\n\n# T\n\n${body}\n`;
  const dir = scratchWith();
  try {
    writeFileSync(join(dir, "writing/zz-test.md"), post("I sign in with Altimist ID at https://altimist.id/signup."));
    assert.deepEqual(build({ root: dir, today: "2026-10-08", now: NOW }).errors, []);
    for (const bad of ["Altimist IDs are nice.", "See altimist.com.", "altimist id"]) {
      writeFileSync(join(dir, "writing/zz-test.md"), post(bad));
      const r = build({ root: dir, today: "2026-10-08", now: NOW });
      assert.ok(r.errors.some((e) => /writing\/zz-test\.(html|md) names an employer/.test(e)), `${bad}: ${r.errors.join("\n")}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F-004 (D8): the full build with all three providers launched passes", () => {
  const dir = scratchWith({ providers: ["google", "microsoft", "altimist"], trial: [], microsoftSecretExpires: "2028-10-01" });
  try {
    assert.deepEqual(build({ root: dir, today: "2026-10-12", now: NOW }).errors, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F-004 (D6): with microsoft launched, the build fails when signin.microsoftSecretExpires is missing, malformed, or 30 days away or less, naming the runbook entry; with Microsoft not launched it is ignored", () => {
  const launch = (expires) => ({ providers: ["google", "microsoft"], trial: [], ...(expires === undefined ? {} : { microsoftSecretExpires: expires }) });
  const errorsFor = (signin) => { const dir = scratchWith(signin); try { return build({ root: dir, today: "2026-10-12", now: NOW }).errors; } finally { rmSync(dir, { recursive: true, force: true }); } };
  // NOW is 6 Oct 2026, 12:00 UTC: 30 days on is 5 Nov 2026.
  for (const bad of [undefined, "", "2027-13-01", "2027-02-30", "1 Nov 2027", "20271101", 20271101, "2027-11-01T00:00:00Z"]) {
    const e = errorsFor(launch(bad));
    assert.ok(e.some((x) => /signin\.microsoftSecretExpires/.test(x) && /Rotate the Microsoft sign-in secret/.test(x)), `${JSON.stringify(bad)}: ${e.join("\n")}`);
  }
  for (const near of ["2026-10-06", "2026-11-05", "2026-10-01"]) {
    const e = errorsFor(launch(near));
    assert.ok(e.some((x) => /Microsoft sign-in secret expires/.test(x) && /Rotate the Microsoft sign-in secret/.test(x)), `${near}: ${e.join("\n")}`);
  }
  assert.deepEqual(errorsFor(launch("2026-11-07")), [], "more than 30 days ahead");
  assert.deepEqual(errorsFor({ providers: ["google"], trial: ["microsoft"], microsoftSecretExpires: "garbage" }), [], "on trial, not launched: ignored");
  assert.deepEqual(errorsFor({ providers: ["google"], trial: [] }), [], "not launched, no date: fine");
});

test("F-004 (D7): the build fails on bad sign-in settings in booking.json, for each case", () => {
  for (const signin of [
    { providers: [] }, { providers: ["microsoft"] }, { providers: ["google", "google"] }, { providers: ["google", "github"] }, { providers: "google" },
    { providers: ["google"], trial: ["google"] }, { providers: ["google"], trial: ["microsoft", "microsoft"] }, { providers: ["google", "altimist"], trial: ["altimist"] }, { providers: ["google"], trial: "altimist" },
    ["google"],
  ]) {
    const dir = scratchWith(signin);
    try {
      const r = build({ root: dir, today: "2026-10-12", now: NOW });
      assert.ok(r.errors.some((e) => /booking\.json: signin/.test(e)), `${JSON.stringify(signin)}: ${r.errors.join("\n")}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
