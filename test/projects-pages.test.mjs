// F-005 PR 3: the /projects pages — D7a rendering of report.md, D7b escaping, the pages.projects
// copy and its checks, the scorecard, run cards and run pages, the machine-readable copies, the
// launch switch, the SVG guard, the gzip cap and the page-level checks in --record. Every fixture
// is hand-made synthetic data (test/fixtures/projects/ and the edits below), never a real export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { renderReportMd } from "../lib/project-pages.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---- D7a: report.md is rendered by its own Marked instance, with nothing live ----
const NOTHING_LIVE = (html) => {
  assert.doesNotMatch(html, /<a[\s>]/i, "no link element");
  assert.doesNotMatch(html, /<(script|iframe|svg|img|input|form|button|textarea|select|object|embed)[\s>/]/i, "no raw HTML, image or form control");
  assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+=/i, "no event handler attribute");
  assert.doesNotMatch(html, /<[a-z][^>]*\s(href|src)=/i, "no href or src");
};

test("F-005 (D7): raw HTML in report.md is escaped, never passed through", () => {
  for (const raw of ["<script>alert(1)</script>", '<img src=x onerror="alert(1)">', '<iframe src="https://example.com"></iframe>', "<svg onload=alert(1)>", "text <b>inline</b> and <script>x</script> inline"]) {
    const html = renderReportMd(raw + "\n");
    NOTHING_LIVE(html);
    assert.match(html, /&lt;/, raw);
  }
});

test("F-005 (D7): links render as their text followed by the target as plain text; no <a>", () => {
  for (const [md, text] of [
    ["[x](https://example.com)", "x (https://example.com)"],
    ["[x](javascript:alert(1))", "x (javascript:alert(1))"],
    ["[x](jav&#x61;script:alert(1))", "x (jav&#x61;script:alert(1))"],
    ["[x](//host/p)", "x (//host/p)"],
    ["[x](../x)", "x (../x)"],
  ]) {
    const html = renderReportMd(md + "\n");
    NOTHING_LIVE(html);
    assert.equal(html.replace(/<[^>]+>/g, "").trim(), text.replace(/&/g, "&amp;"), md);
  }
});

test("F-005 (D7): URL, www and email autolinks render as text only, with no mailto:", () => {
  for (const [md, text] of [
    ["<https://example.com>", "https://example.com"], ["www.example.com", "www.example.com"], ["https://example.com", "https://example.com"],
    ["<someone@example.com>", "someone@example.com"], ["someone@example.com", "someone@example.com"],
  ]) {
    const html = renderReportMd(`see ${md} here\n`);
    NOTHING_LIVE(html);
    assert.doesNotMatch(html, /mailto:/i);
    assert.equal(html.replace(/<[^>]+>/g, "").trim(), `see ${text} here`, md);
  }
});

test("F-005 (D7): images are dropped, inline and reference-style (backstop; F-001e refuses ![)", () => {
  for (const md of ["before ![a](calls/1/out/x.png) after\n", "before ![a][r] after\n\n[r]: calls/1/out/x.png\n"]) {
    const html = renderReportMd(md);
    NOTHING_LIVE(html);
    assert.equal(html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(), "before after");
  }
});

test("F-005 (D7): a GFM task list renders as text with no <input>", () => {
  const html = renderReportMd("- [x] done\n- [ ] to do\n");
  NOTHING_LIVE(html);
  assert.match(html, /<li>\[x\] done<\/li>/);
  assert.match(html, /<li>\[ \] to do<\/li>/);
});

test("F-005 (D7): every table and fenced code block is wrapped in a focusable, labelled scroll region", () => {
  const html = renderReportMd("| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\nprint(1)\n```\n\n| c |\n|---|\n| 3 |\n\n    indented code\n");
  assert.deepEqual([...html.matchAll(/<div class="scroll" role="region" aria-label="([^"]+)" tabindex="0">\s*<(table|pre)/g)].map((m) => [m[1], m[2]]),
    [["Table 1", "table"], ["Code 1", "pre"], ["Table 2", "table"], ["Code 2", "pre"]]);
  assert.equal(renderReportMd("| a |\n|---|\n| 1 |\n").match(/Table 1/g).length, 1, "numbering restarts per report");
});

test("F-005 (D7): headings shift so the shallowest level present is <h3>, deeper levels follow, capped at <h6>", () => {
  const levels = (md) => [...renderReportMd(md).matchAll(/<h([1-6])>/g)].map((m) => +m[1]);
  assert.deepEqual(levels("## A\n\n### B\n\n#### C\n"), [3, 4, 5]);
  assert.deepEqual(levels("# A\n\n## B\n"), [3, 4]);
  assert.deepEqual(levels("# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F\n"), [3, 4, 5, 6, 6, 6]);
  assert.deepEqual(levels("Setext\n======\n\nNext\n----\n"), [3, 4]);
  assert.deepEqual(levels("no headings\n"), []);
});

test("F-005 (D7): the writing pages still use the shared marked instance, unchanged by the report renderer", () => {
  const post = readFileSync(join(ROOT, "writing", readFileSync(join(ROOT, "public/sitemap.xml"), "utf8").match(/writing\/([a-z0-9-]+)</)[1] + ".md"), "utf8");
  const before = marked.parse(post);
  renderReportMd("<b>x</b> [a](https://example.com) ![i](x.png)\n\n# H\n\n| a |\n|---|\n| 1 |\n");
  assert.equal(marked.parse(post), before);
  assert.match(marked.parse("[a](https://example.com) <b>x</b>"), /<a href="https:\/\/example.com">a<\/a> <b>x<\/b>/, "the shared instance still renders links and raw HTML for the owner's own posts");
});

// ---- A scratch site with runs and a scorecard published straight into projects/ ----
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { build, decodeEntities } from "../build.mjs";
import { report, scorecard, dump, sha, png, RUN_ID, runFiles, writeExport } from "./projects-helpers.mjs";
import { record } from "../build.mjs";
import { deflateSync } from "node:zlib";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const TODAY = "2026-11-12";
const MANIFEST = "projects/research-agent/published.json";
const SITE = "https://patrickjv.com/";
const content = () => JSON.parse(readFileSync(join(ROOT, "content.json"), "utf8"));
const P = content().pages.projects;
const edit = (doc, fn) => { const d = structuredClone(doc); fn?.(d); return d; };

// Report edits for each status, as test/projects.test.mjs uses them.
const rejected = (d) => { d.status = "rejected"; d.rejection = { reason: "The window is too short for the claim." }; d.review = { outcome: "not_reviewed", critic_calls: 0, open_issues: [] }; d.answer = null; d.passes = []; d.final_call = null; d.summary.author = "system"; };
const capped = (stop = "run_tokens") => (d) => { d.status = "capped"; d.stop_reason = stop; };
const failedNoPlan = (stop = "model_error") => (d) => { d.status = "failed"; d.stop_reason = stop; d.plan = null; d.review = { outcome: "not_reviewed", critic_calls: 0, open_issues: [] }; };
const issues = (...tags) => (d) => { d.review.open_issues = tags.map((tag) => ({ tag, explanation: `Explanation for ${tag}.` })); };

export const runId = (n) => `20261111T14${String(n).padStart(2, "0")}00Z-0000${n.toString(16).padStart(2, "0")}`;
const FIG = "calls/1/out/vol_by_minute.png";
// A run: report.json from the fixture with `edit` applied, report.md, its figures (path -> PNG) and
// the manifest entry's alt text, role and checked date.
function run(n, { edit: fn, md = "# Report\n\nSynthetic result.\n", figures = { [FIG]: png({ width: 40, height: 30 }) }, alt, role, checked = TODAY } = {}) {
  const id = runId(n);
  const doc = edit(report(), (d) => { d.run_id = id; d.figures = Object.keys(figures); fn?.(d); });
  const figs = Object.fromEntries(doc.figures.map((f) => [f, figures[f]]));
  return { id, doc, md, figures: figs, alt: alt ?? Object.fromEntries(Object.keys(figs).map((f, i) => [f, `Synthetic chart ${i + 1}.`])), role, checked };
}

function site() {
  const base = mkdtempSync(join(tmpdir(), "site-pages-"));
  const root = join(base, "site");
  mkdirSync(root);
  for (const f of ["content.json", "cv.json", "build-state.json", "writing", "public", "projects"]) cpSync(join(ROOT, f), join(root, f), { recursive: true });
  return { base, root, done: () => rmSync(base, { recursive: true, force: true }) };
}
const write = (root, f, b) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), b); };
// Publish `runs` and `card` (a scorecard document, or null) as --record leaves them with alt text
// written, apply `copy` to content.json, then build. Returns the build result.
function publish(s, runs, { card = null, copy, html } = {}) {
  const m = { manifest_version: "1.0.0", runs: {} };
  rmSync(join(s.root, "projects/research-agent/runs"), { recursive: true, force: true });
  rmSync(join(s.root, "projects/research-agent/scorecard"), { recursive: true, force: true });
  for (const r of runs) {
    const files = { "report.json": Buffer.from(dump(r.doc)), "report.md": Buffer.from(r.md), ...r.figures };
    for (const [f, b] of Object.entries(files)) write(s.root, `projects/research-agent/runs/${r.id}/${f}`, b);
    m.runs[r.id] = { checked: r.checked, export_digest: "a".repeat(64), tool_version: "0.1.0", exported_at: "2026-11-11T15:04:05Z", ...(r.role ? { role: r.role } : {}), files: Object.fromEntries(Object.entries(files).sort().map(([f, b]) => [f, sha(b)])), alt: r.alt };
  }
  if (card) {
    const b = Buffer.from(dump(card));
    write(s.root, "projects/research-agent/scorecard/scorecard.json", b);
    m.scorecard = { eval_id: card.eval_id, checked: TODAY, export_digest: "b".repeat(64), tool_version: "0.1.0", exported_at: "2026-11-11T16:00:00Z", files: { "scorecard.json": sha(b) } };
  }
  write(s.root, MANIFEST, JSON.stringify(m, null, 2) + "\n");
  if (copy) { const c = content(); copy(c); writeFileSync(join(s.root, "content.json"), JSON.stringify(c, null, 2) + "\n"); }
  if (html) writeFileSync(join(s.root, "public/index.html"), html(readFileSync(join(ROOT, "public/index.html"), "utf8")));
  return build({ root: s.root, today: TODAY, now: NOW });
}
const out = (s, f) => readFileSync(join(s.root, "public", f), "utf8");
const runPage = (s, id) => out(s, `projects/research-agent/runs/${id}/index.html`);
const SHOWCASE = "projects/research-agent.html";
// The visible text of a page: tags removed (style, script and the SVG title dropped), entities decoded.
const visible = (html) => decodeEntities(html.replace(/<(style|script|title)[^>]*>[\s\S]*?<\/\1>/g, " ").replace(/<\/?(a|strong|span|em|code)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const body = (html) => html.slice(html.indexOf("<body>"));
const headings = (html) => [...body(html).matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => `h${m[1]} ${visible(m[2])}`);
const title = (html) => decodeEntities(html.match(/<title>([\s\S]*?)<\/title>/)[1]);
const meta = (html, attr, key) => decodeEntities(html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`))[1]);
const jsonld = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const ok = (r) => assert.deepEqual(r.errors, []);

test("F-005 (US-1, US-2): /projects/ and /projects/research-agent have the sections of 'Page content', in order", () => {
  const s = site();
  try {
    ok(publish(s, [run(1)], { card: scorecard() }));
    const sh = P.copy.showcase;
    assert.deepEqual(headings(out(s, SHOWCASE)), [
      `h1 ${sh.heading}`, `h2 ${sh.what_heading}`, `h2 ${sh.architecture_heading}`, ...sh.architecture.map((a) => `h3 ${a.heading}`),
      `h2 ${P.labels.scorecard.heading}`, `h2 ${sh.runs_heading}`, `h3 ${report().question}`, `h2 ${sh.built_heading}`,
    ]);
    const lead = visible(body(out(s, SHOWCASE)).match(/<p class="lead">[\s\S]*?<\/p>\s*<p>([\s\S]*?)<\/p>/)[1]);
    assert.equal(lead, sh.code, "the lead, then 'Code available on request'");
    assert.match(body(out(s, SHOWCASE)), /<a href="\/book">book a call<\/a>/);
    assert.match(body(out(s, SHOWCASE)), /<footer>Patrick Vieira · <a href="\/">patrickjv.com<\/a>/);
    assert.deepEqual(headings(out(s, "projects/index.html")), [`h1 ${P.copy.index.heading}`]);
    const ix = body(out(s, "projects/index.html"));
    assert.match(ix, new RegExp(`<a href="/projects/research-agent">${P.copy.index.entry.title}</a><p>${P.copy.index.entry.summary}</p><p>${P.copy.index.entry.stack}</p>`));
    ok(publish(s, []));
    assert.ok(!headings(out(s, SHOWCASE)).includes(`h2 ${P.labels.scorecard.heading}`), "no scorecard section without a scorecard");
    assert.ok(visible(out(s, SHOWCASE)).includes(P.empty.runs));
  } finally { s.done(); }
});

test("F-005 (US-1): the showcase's title, meta description and lead each name LangGraph and LangChain, or the build fails", () => {
  const s = site();
  try {
    ok(publish(s, []));
    const html = out(s, SHOWCASE);
    for (const w of ["LangGraph", "LangChain"]) {
      assert.ok(title(html).includes(w) && meta(html, "name", "description").includes(w) && visible(html.match(/<p class="lead">([\s\S]*?)<\/p>/)[1]).includes(w));
      for (const [what, f] of [["title", (c) => { c.pages.projects.head.showcase.title = c.pages.projects.head.showcase.title.replaceAll(w, "X"); }], ["meta description", (c) => { c.pages.projects.head.showcase.description = c.pages.projects.head.showcase.description.replaceAll(w, "X"); }], ["lead paragraph", (c) => { c.pages.projects.copy.showcase.lead = c.pages.projects.copy.showcase.lead.replaceAll(w, "X"); }]]) {
        const r = publish(s, [], { copy: f });
        assert.ok(r.errors.some((e) => e.includes(what) && e.includes(w)), `${w} removed from the ${what}: ${r.errors.join("\n")}`);
      }
    }
  } finally { s.done(); }
});

// ---- D5: pages.projects, its two kinds of string, and when each is checked ----
import { projectsOutput, projectPageErrors, checkProjectsCopy, employerMention } from "../build.mjs";
import { readProjectsTree } from "../lib/projects.mjs";
const rendered = (s) => projectsOutput(s.root, JSON.parse(readFileSync(join(s.root, "content.json"), "utf8")), readProjectsTree(s.root), { employerMention, denylist: [] });
const copyFails = (s, f, pattern) => { const r = publish(s, [], { copy: f }); assert.ok(r.errors.some((e) => pattern.test(e)), `expected ${pattern}:\n${r.errors.join("\n")}`); };

test("F-005 (D5): visible copy — every copy.* string must be the whole visible text of an element", () => {
  const s = site();
  try {
    ok(publish(s, [run(1)], { card: scorecard() }));
    const r = rendered(s);
    assert.deepEqual(r.errors, []);
    copyFails(s, (c) => { c.pages.projects.copy.showcase.what[0] = c.pages.projects.copy.showcase.what[0].replace(" ", "  "); }, /pages\.projects\.copy\.showcase\.what\.0 is not the whole visible text/);
    const o = r.out, f = "public/projects/research-agent.html";
    o.html[f] = o.html[f].replace(`<h2 id="built-h">`, `<h2 id="built-h" hidden>`);
    assert.ok(projectPageErrors(o, P, { employerMention, denylist: [] }).some((e) => /copy\.showcase\.built_heading is not the whole visible text/.test(e)));
  } finally { s.done(); }
});

test("F-005 (D5): named fields — head.* must be the page's <title>, meta description and og: tags", () => {
  const s = site();
  try {
    ok(publish(s, []));
    for (const [k, f] of [["showcase", "public/projects/research-agent.html"], ["index", "public/projects/index.html"]]) {
      for (const [tag, re] of [["description", /<meta name="description" content="[^"]*">/], ["title", /<meta property="og:title" content="[^"]*">/]]) {
        const o = rendered(s).out;
        o.html[f] = o.html[f].replace(re, (m) => m.replace(/content="[^"]*"/, 'content="Something else"'));
        assert.ok(projectPageErrors(o, P, { employerMention, denylist: [] }).some((e) => e.includes(`head.${k}.${tag}`)), `${k} ${tag}`);
      }
    }
  } finally { s.done(); }
});

test("F-005 (D5): named fields — templates use only their known placeholders and leave no { or } in the template text", () => {
  assert.deepEqual(checkProjectsCopy(P), []);
  const fails = (name, t, pattern) => { const p = edit(P, (x) => { x.templates[name] = t; }); assert.ok(checkProjectsCopy(p).some((e) => pattern.test(e)), `${name}: ${t}`); };
  fails("run_title", "{question} — {nope}", /templates\.run_title uses \{nope\}/);
  fails("rejected", "Rejected: {question}", /templates\.rejected uses \{question\}/);
  fails("no_plan", "No plan { here", /templates\.no_plan has a \{ or \} left/);
  fails("checked", "Checked on {date}}", /templates\.checked has a \{ or \} left/);
  fails("stopped", "Stopped: {Stop_Reason}", /templates\.stopped uses \{Stop_Reason\}/);
  fails("nope", "A template nobody renders", /templates\.nope is neither visible copy/);
});

test("F-005 (D5): named fields — each labels.* map covers every enumeration value and every section key, and no more", () => {
  const fails = (fn, pattern) => { const p = edit(P, fn); assert.ok(checkProjectsCopy(p).some((e) => pattern.test(e)), String(pattern)); };
  for (const [map, k] of [["status", "failed"], ["outcome", "not_passed"], ["tag", "contract_roll"], ["stop_reason", "missing_critique"], ["harness", "claude-code"], ["role", "clean_pass"], ["section", "figures"], ["scorecard", "se_na"], ["card", "link"], ["run", "dataset"], ["plan", "window"], ["links", "json"]]) {
    fails((p) => { delete p.labels[map][k]; }, new RegExp(`labels\\.${map}\\.${k} is missing`));
  }
  fails((p) => { delete p.labels.scorecard.columns.trap_recall; }, /labels\.scorecard\.columns\.trap_recall is missing/);
  fails((p) => { p.labels.status.paused = "Paused"; }, /labels\.status\.paused is neither visible copy/);
  fails((p) => { p.labels.status.failed = ""; }, /labels\.status\.failed must be a non-empty string/);
});

test("F-005 (D5): named fields — each empty.* message appears in its empty state", () => {
  const s = site();
  try {
    ok(publish(s, []));
    assert.ok(visible(out(s, SHOWCASE)).includes(P.empty.runs));
    const o = rendered(s).out, f = "public/projects/research-agent.html";
    o.html[f] = o.html[f].replace(`<p>${P.empty.runs}</p>`, `<p hidden>${P.empty.runs}</p>`);
    assert.ok(projectPageErrors(o, P, { employerMention, denylist: [] }).some((e) => /pages\.projects\.empty\.runs does not show on projects\/research-agent\.html/.test(e)));
    ok(publish(s, [run(1, { edit: issues() })]));
    assert.ok(visible(runPage(s, runId(1))).includes(P.empty.issues));
  } finally { s.done(); }
});

test("F-005 (D5): a string under pages.projects of neither kind fails the build", () => {
  const s = site();
  try {
    copyFails(s, (c) => { c.pages.projects.tagline = "A string nobody checks"; }, /pages\.projects\.tagline is neither visible copy/);
    copyFails(s, (c) => { c.pages.projects.copy.showcase.extra = "Unrendered copy"; }, /pages\.projects\.copy\.showcase\.extra is neither visible copy/);
    copyFails(s, (c) => { c.pages.projects.empty.scorecard = "No scorecard"; }, /pages\.projects\.empty\.scorecard is neither visible copy/);
    copyFails(s, (c) => { c.pages.projects.launched = "false"; }, /pages\.projects\.launched must be true or false/);
    ok(publish(s, [], { copy: (c) => { c.pages.projects._note = "Notes start with an underscore."; } }));
  } finally { s.done(); }
});

// Every string under pages.projects, by path (notes and `launched` aside).
const strings = (v, path = "", acc = []) => {
  if (typeof v === "string") acc.push([path, v]);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!k.startsWith("_")) strings(x, path ? `${path}.${k}` : k, acc);
  return acc;
};

test("F-005 (D5): the full fixture set — every status, outcome, tag, stop reason, harness and role, with and without figures, runs and the scorecard — renders every string under pages.projects", () => {
  const s = site();
  const shown = [];
  const take = () => {
    for (const f of readdirSync(join(s.root, "public/projects"), { recursive: true }).filter((f) => f.endsWith(".html"))) {
      const h = out(s, `projects/${f}`);
      shown.push(visible(h), title(h), meta(h, "name", "description"), meta(h, "property", "og:title"));
    }
  };
  try {
    const stops = ["pass_tool_calls", "run_tool_calls", "run_tokens", "sandbox_unavailable", "dataset_unavailable", "access_denied", "run_not_owned", "invalid_model_output", "model_error", "internal_error", "abandoned", "unsanctioned_call", "run_mismatch", "missing_critique"];
    const harness = (h) => (d) => { d.models.harness = h; };
    const outcome = (o) => (d) => { d.review.outcome = o; };
    const all = (...fs) => (d) => fs.forEach((f) => f(d));
    ok(publish(s, [
      run(1, { role: "trap_caught", edit: all(issues("look_ahead", "overlap_autocorrelation")), figures: { [FIG]: png(), "calls/2/out/b.png": png({ width: 8, height: 6 }) } }),
      run(2, { role: "clean_pass", edit: all(harness("claude-code"), outcome("not_passed"), issues("sample_size", "return_definition", "contract_roll")), figures: {} }),
      run(3, { role: "rejected_plan", edit: rejected, figures: {} }),
      run(4, { edit: all(capped(stops[0]), issues("timezone_session", "multiple_comparisons")) }),
      ...stops.slice(1, 5).map((stop, i) => run(5 + i, { edit: failedNoPlan(stop), figures: {} })),
    ], { card: scorecard() }));
    take();
    ok(publish(s, stops.slice(5, 13).map((stop, i) => run(10 + i, { edit: i % 2 ? failedNoPlan(stop) : capped(stop), figures: {} }))));
    take();
    ok(publish(s, [run(20, { edit: capped(stops[13]) })]));
    take();
    ok(publish(s, [], { card: edit(scorecard(), (d) => { d.aggregate.se = null; }) }));
    take();
    const text = shown.join("\n");
    const missing = strings(P).filter(([path, v]) => !(path.startsWith("templates.") ? v.split(/\{[a-z_]+\}/).map((x) => x.trim()).filter(Boolean) : [v]).every((lit) => text.includes(lit)));
    assert.deepEqual(missing, [], "every string renders in at least one page");
  } finally { s.done(); }
});

test("F-005 (D5, D9): with no runs and no scorecard and launched false (main before the first export), the build and --check pass", () => {
  const s = site();
  try {
    rmSync(join(s.root, MANIFEST), { force: true });
    ok(build({ root: s.root, today: TODAY, now: NOW }));
    ok(build({ root: s.root, check: true, now: NOW }));
    assert.equal(P.launched, false, "the committed copy is not launched");
    assert.ok(!existsSync(join(ROOT, MANIFEST)), "main has no published runs yet");
    ok(build({ root: ROOT, check: true, now: NOW }));
  } finally { s.done(); }
});

test("F-005 (D5, D7): templates fill in one pass — a question holding {question} or { renders literally and passes", () => {
  const s = site();
  try {
    const q = "Does {question} or { or {stop_reason} survive? {";
    ok(publish(s, [run(1, { edit: (d) => { d.question = q; } })]));
    const h = runPage(s, runId(1));
    assert.equal(title(h), `${q} — Research agent — Patrick Vieira`);
    assert.ok(visible(h).includes(q));
    assert.ok(visible(out(s, SHOWCASE)).includes(q));
  } finally { s.done(); }
});

// ---- The scorecard (US-2) ----
import { fixed2, truncate, truncateAtSpace } from "../lib/project-pages.mjs";
const scoreTable = (h) => [...body(h).match(/<section aria-labelledby="scorecard-h">[\s\S]*?<\/section>/)[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => decodeEntities(c[1])));
const scoreHead = (h) => Object.fromEntries([...body(h).match(/<section aria-labelledby="scorecard-h">[\s\S]*?<\/section>/)[0].matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => [decodeEntities(m[1]), decodeEntities(m[2])]));

test("F-005 (US-2): number formatting — two places, half away from zero from String(x): 0.125 -> 0.13, 0.135 -> 0.14", () => {
  for (const [x, s] of [[0.125, "0.13"], [0.135, "0.14"], [0.75, "0.75"], [0, "0.00"], [1, "1.00"], [0.005, "0.01"], [0.004999, "0.00"], [0.995, "1.00"], [1e-7, "0.00"], [0.1, "0.10"], [0.5, "0.50"], [0.0549, "0.05"]]) assert.equal(fixed2(x), s, String(x));
});

test("F-005 (US-2): the scorecard is one table, a row per question, with correct, trap recall and critic precision as x / n, n/a for n = 0, and the aggregate with its standard error", () => {
  const s = site();
  try {
    ok(publish(s, [], { card: scorecard() }));
    const h = out(s, SHOWCASE), c = P.labels.scorecard;
    assert.equal(body(h).match(/<table>/g).length, 1, "one table");
    assert.deepEqual(scoreTable(h), [
      [c.columns.question, c.columns.correct, c.columns.trap_recall, c.columns.critic_precision],
      ["open-vol", "2 / 2", c.na, "1 / 1"],
      ["roll-gap", "1 / 2", "1 / 2", "1 / 2"],
    ]);
    assert.equal(scoreHead(h)[c.aggregate], "0.75 ± 0.13", "0.125 rounds half away from zero");
    assert.match(body(h), /<div class="scroll" role="region" aria-label="Eval scorecard" tabindex="0">\s*<table>/, "in the same focusable scroll wrapper as report tables");
    ok(publish(s, [], { card: edit(scorecard(), (d) => { d.aggregate = { score: 0.135, se: null }; d.questions[1].critic_precision = { x: 0, n: 0 }; }) }));
    const h2 = out(s, SHOWCASE);
    assert.equal(scoreHead(h2)[c.aggregate], `0.14 ${c.se_na}`);
    assert.deepEqual(scoreTable(h2)[2], ["roll-gap", "1 / 2", "1 / 2", c.na]);
    const md = out(s, "projects/research-agent.md");
    assert.ok(md.includes(`| ${c.columns.question} | ${c.columns.correct} | ${c.columns.trap_recall} | ${c.columns.critic_precision} |`) && md.includes(`| roll-gap | 1 / 2 | 1 / 2 | ${c.na} |`) && md.includes(`- ${c.aggregate}: 0.14 ${c.se_na}`), "the Markdown copy has the scorecard as a table");
  } finally { s.done(); }
});

test("F-005 (US-2): the scorecard header — date, k, models, seed, and one entry per harness present with its count of non-null repeats, in the fixed order", () => {
  const s = site();
  try {
    const card = edit(scorecard(), (d) => { d.runs.reverse(); }); // claude-code listed first; a null repeat among them
    ok(publish(s, [], { card }));
    const c = P.labels.scorecard, H = P.labels.harness;
    assert.deepEqual(scoreHead(out(s, SHOWCASE)), {
      [c.date]: "2026-11-11", [c.repeats]: "2", [c.harness]: `${H.langgraph} (2), ${H["claude-code"]} (1)`,
      [c.models]: "analyst example:analyst-model, critic example:critic-model", [c.seed]: "42", [c.aggregate]: "0.75 ± 0.13",
    });
    ok(publish(s, [], { card: edit(scorecard(), (d) => { for (const r of d.runs) if (r.models) r.models.harness = "claude-code"; }) }));
    assert.equal(scoreHead(out(s, SHOWCASE))[c.harness], `${H["claude-code"]} (3)`, "only the harnesses present");
  } finally { s.done(); }
});

// ---- Run cards and run pages (US-2) ----
test("F-005 (US-2): run cards are ordered by role, then finished_at newest first, then run id", () => {
  const s = site();
  try {
    const at = (t) => (d) => { d.finished_at = t; };
    ok(publish(s, [
      run(1, { edit: at("2026-11-11T10:00:00Z") }),                          // no role
      run(2, { role: "clean_pass", edit: at("2026-11-11T09:00:00Z") }),
      run(3, { role: "trap_caught", edit: at("2026-11-11T08:00:00Z") }),
      run(4, { role: "trap_caught", edit: at("2026-11-11T12:00:00Z") }),     // newer than run 3
      run(5, { role: "rejected_plan", edit: (d) => { rejected(d); d.finished_at = "2026-11-11T08:00:00Z"; }, figures: {} }),
      run(6, { role: "trap_caught", edit: at("2026-11-11T12:00:00Z") }),     // ties run 4: by run id
    ]));
    const order = [...body(out(s, SHOWCASE)).matchAll(/<a href="\/projects\/research-agent\/runs\/([^/]+)\/"/g)].map((m) => m[1]);
    assert.deepEqual(order, [4, 6, 3, 5, 2, 1].map(runId));
    const card = body(out(s, SHOWCASE)).match(/<ul class="cards">\s*<li>([\s\S]*?)<\/li>/)[1];
    assert.ok(card.includes(`<h3>${report().question}</h3>`));
    for (const [k, v] of [["harness", P.labels.harness.langgraph], ["status", P.labels.status.completed], ["outcome", P.labels.outcome.passed], ["role", P.labels.role.trap_caught]]) assert.ok(card.includes(`<dt>${P.labels.card[k]}</dt><dd>${v}</dd>`), k);
    assert.ok(card.includes(`>${P.labels.card.link}</a>`));
  } finally { s.done(); }
});

test("F-005 (US-2): a completed run page shows the header, plan, critic, report and figures", () => {
  const s = site();
  try {
    ok(publish(s, [run(1)]));
    const h = runPage(s, runId(1)), d = report(), L = P.labels;
    assert.deepEqual(headings(h), [`h1 ${d.question}`, `h2 ${L.section.plan}`, `h2 ${L.section.critic}`, `h2 ${L.section.report}`, "h3 Report", `h2 ${L.section.figures}`, `h2 ${L.section.links}`]);
    const v = visible(h);
    for (const t of [`${L.run.finished} 2026-11-11`, `${L.run.harness} ${L.harness.langgraph}`, `${L.run.models} planner example:analyst-model, analyst example:analyst-model, critic example:critic-model`,
      `${L.run.status} ${L.status.completed}`, `${L.run.outcome} ${L.outcome.passed}`, `${L.run.dataset} synth-futures-1m (synthetic)`, P.copy.synthetic,
      `${L.plan.hypothesis} ${d.plan.hypothesis}`, `${L.plan.dataset} synth-futures-1m`, `${L.plan.window} 2025-01-02 to 2025-06-30`, `${L.plan.method} ${d.plan.method}`, `${L.plan.statistic} open_vol_ratio`, `${L.plan.significance} ${d.plan.significance}`,
      `${L.tag.sample_size}: ${d.review.open_issues[0].explanation}`, "Synthetic result.", `${L.links.markdown} ${L.links.json} ${L.links.back}`, `Read and published by Patrick Vieira on ${TODAY}.`]) assert.ok(v.includes(t), t);
    assert.match(body(h), /<a href="\/projects\/research-agent\/runs\/[^"]+\/report\.md">Markdown<\/a>/);
    assert.match(body(h), /<a href="\/projects\/research-agent">Back to the research agent<\/a>/);
    assert.ok(!v.includes(P.templates.rejected), "no rejection");
  } finally { s.done(); }
});

test("F-005 (US-2): a rejected run shows the plan, 'Plan rejected at approval' and the reason, and no analysis", () => {
  const s = site();
  try {
    ok(publish(s, [run(1, { edit: rejected, figures: {} })]));
    const h = runPage(s, runId(1)), v = visible(h);
    assert.ok(v.includes(`${P.labels.plan.hypothesis} ${report().plan.hypothesis}`), "the plan");
    assert.ok(v.includes(`${P.labels.plan.window} 2025-01-02 to 2025-06-30 ${P.labels.plan.method}`));
    assert.match(body(h), /<p><strong>Plan rejected at approval<\/strong><\/p>\s*<p>The window is too short for the claim\.<\/p>/);
    assert.ok(!headings(h).includes(`h2 ${P.labels.section.figures}`), "no figures");
    assert.ok(!v.includes(P.templates.stopped.split("{")[0].trim()), "not described as stopped");
  } finally { s.done(); }
});

test("F-005 (US-2): a failed run with no plan says so with its stop reason in words; a capped run names its stop reason", () => {
  const s = site();
  try {
    ok(publish(s, [run(1, { edit: failedNoPlan("sandbox_unavailable"), figures: {} }), run(2, { edit: capped("run_tool_calls") })]));
    const failed = visible(runPage(s, runId(1)));
    assert.ok(failed.includes(`${P.labels.section.plan} No plan was written: the run stopped before planning (${P.labels.stop_reason.sandbox_unavailable}).`));
    assert.ok(!failed.includes(P.labels.plan.hypothesis));
    assert.ok(visible(runPage(s, runId(2))).includes(`The run stopped before it finished: ${P.labels.stop_reason.run_tool_calls}.`));
  } finally { s.done(); }
});

test("F-005 (US-2): every open issue is shown with its tag in words and its explanation, including when the review did not pass", () => {
  const s = site();
  try {
    const tags = ["look_ahead", "contract_roll", "multiple_comparisons"];
    ok(publish(s, [run(1, { edit: (d) => { issues(...tags)(d); d.review.outcome = "not_passed"; } })]));
    const h = runPage(s, runId(1));
    assert.ok(visible(h).includes(`${P.labels.run.outcome}: ${P.labels.outcome.not_passed}`));
    const items = [...body(h).match(/<ul class="issues">([\s\S]*?)<\/ul>/)[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => visible(m[1]));
    assert.deepEqual(items, tags.map((t) => `${P.labels.tag[t]}: Explanation for ${t}.`));
  } finally { s.done(); }
});

test("F-005 (US-2, D8): figures in report.json order, with IHDR width and height, the manifest's alt text, lazy after the first; every src resolves to a written file; none without figures", () => {
  const s = site();
  try {
    const figures = { "calls/3/out/z.png": png({ width: 50, height: 20 }), "calls/1/out/a.png": png({ width: 7, height: 9 }), "calls/12/out/m.png": png({ width: 2000, height: 4 }) };
    ok(publish(s, [run(1, { figures, alt: { "calls/3/out/z.png": "Zed.", "calls/1/out/a.png": "Ay.", "calls/12/out/m.png": "Em." } }), run(2, { figures: {} })]));
    const h = runPage(s, runId(1));
    const imgs = [...body(h).matchAll(/<img ([^>]*)>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/([a-z]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? true])));
    assert.deepEqual(imgs, [
      { src: "calls/3/out/z.png", width: "50", height: "20", alt: "Zed." },
      { src: "calls/1/out/a.png", width: "7", height: "9", alt: "Ay.", loading: "lazy" },
      { src: "calls/12/out/m.png", width: "2000", height: "4", alt: "Em.", loading: "lazy" },
    ]);
    const page = new URL(`${SITE}projects/research-agent/runs/${runId(1)}/`);
    for (const i of imgs) {
      const path = new URL(i.src, page).pathname;
      assert.ok(readFileSync(join(s.root, "public", path)).equals(figures[i.src]), path);
    }
    assert.ok(body(h).indexOf(`<h2>${P.labels.section.figures}</h2>`) > 0);
    assert.ok(!headings(runPage(s, runId(2))).includes(`h2 ${P.labels.section.figures}`));
    assert.doesNotMatch(body(runPage(s, runId(2))), /<img/);
  } finally { s.done(); }
});

test("F-005 (US-1, US-3): truncation of the run title and meta description is by code point, before escaping", () => {
  assert.equal(truncate("a".repeat(61), 60), "a".repeat(60) + "…");
  assert.equal(truncate("a".repeat(60), 60), "a".repeat(60));
  assert.equal(truncate("a".repeat(59) + "😀b", 60), "a".repeat(59) + "😀…", "an astral character at the cut is kept whole");
  assert.equal(truncate("a".repeat(58) + "😀😀b", 60), "a".repeat(58) + "😀😀…");
  const words = ("word ".repeat(40)).trim(); // 199 code points
  assert.equal(truncateAtSpace(words, 160), "word ".repeat(32).trim() + "…", "cut at the last space at or before 160");
  assert.equal(truncateAtSpace("x".repeat(170), 160), "x".repeat(160) + "…", "a hard cut with no space");
  assert.equal(truncateAtSpace("a".repeat(150), 160), "a".repeat(150));
  const s = site();
  try {
    const q = "q".repeat(59) + "&b"; // 61 code points: the & is the 60th
    const summary = "s".repeat(155) + " a&b " + "t".repeat(20); // a space at 156: cut there, & kept whole after it
    ok(publish(s, [run(1, { edit: (d) => { d.question = q; d.summary.text = summary; } })]));
    const h = runPage(s, runId(1));
    assert.match(h, new RegExp(`<title>${"q".repeat(59)}&amp;… — Research agent — Patrick Vieira</title>`));
    assert.equal(meta(h, "name", "description"), "s".repeat(155) + " a&b…");
    assert.match(h, new RegExp(`<meta name="description" content="${"s".repeat(155)} a&amp;b…">`), "escaped after the cut, never a broken entity");
    ok(publish(s, [run(1, { edit: (d) => { d.question = "q".repeat(59) + "😀z"; } })]));
    assert.equal(title(runPage(s, runId(1))), "q".repeat(59) + "😀… — Research agent — Patrick Vieira");
  } finally { s.done(); }
});

test("F-005 (D7): on a run page the report's headings shift under the Report <h2>, and the page has exactly one <h1>", () => {
  const s = site();
  try {
    for (const [md, want] of [["## A\n\n### B\n", ["h3 A", "h4 B"]], ["# A\n\n## B\n", ["h3 A", "h4 B"]], ["# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n", ["h3 A", "h4 B", "h5 C", "h6 D", "h6 E"]]]) {
      ok(publish(s, [run(1, { md })]));
      const hs = headings(runPage(s, runId(1)));
      assert.deepEqual(hs.slice(hs.indexOf(`h2 ${P.labels.section.report}`) + 1, hs.indexOf(`h2 ${P.labels.section.figures}`)), want, md);
      assert.equal(hs.filter((x) => x.startsWith("h1 ")).length, 1);
    }
  } finally { s.done(); }
});

// ---- D7b: every interpolated string is escaped plain text ----
const PAYLOAD = `<a href="https://example.com">x</a> <script>alert(1)</script> "quoted" & **x**`;
// Every element in the page whose start tag the payload could have injected.
const injected = (h) => /<a href="https:\/\/example\.com"|<script>alert|<strong>x<\/strong>/.test(body(h));
const FIELDS = {
  question: [(d) => { d.question = PAYLOAD; }, {}],
  "plan.hypothesis": [(d) => { d.plan.hypothesis = PAYLOAD; }, {}],
  "plan.method": [(d) => { d.plan.method = PAYLOAD; }, {}],
  "plan.statistic": [(d) => { d.plan.statistic = PAYLOAD; }, {}],
  "plan.significance": [(d) => { d.plan.significance = PAYLOAD; }, {}],
  "review.open_issues[].explanation": [(d) => { d.review.open_issues[0].explanation = PAYLOAD; }, {}],
  "rejection.reason": [(d) => { rejected(d); d.rejection.reason = PAYLOAD; }, { figures: {} }],
  "summary.text": [(d) => { d.summary.text = PAYLOAD; }, {}],
};

test("F-005 (D7): each model-written report.json string shows escaped in the body: no <a> or <script>, and no Markdown (**x** stays literal)", () => {
  const s = site();
  try {
    for (const [field, [fn, opts]] of Object.entries(FIELDS)) {
      ok(publish(s, [run(1, { edit: fn, ...opts })]));
      for (const h of [runPage(s, runId(1)), out(s, SHOWCASE)]) {
        assert.ok(!injected(h), field);
        assert.equal(body(h).match(/<script/g), null, `${field}: no script element in the body`);
      }
      if (field !== "summary.text") assert.ok(visible(runPage(s, runId(1))).includes(PAYLOAD), `${field}: the text is intact, ** and all`);
      assert.ok(body(runPage(s, runId(1))).includes(PAYLOAD.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")) || field === "summary.text", field);
    }
  } finally { s.done(); }
});

test("F-005 (D7): <title>, the meta description and every og: value hold the escaped text and parse as one attribute", () => {
  const s = site();
  try {
    ok(publish(s, [run(1, { edit: (d) => { d.question = PAYLOAD; d.summary.text = PAYLOAD; } })]));
    const h = runPage(s, runId(1)), head = h.slice(0, h.indexOf("</head>"));
    const want = truncate(PAYLOAD, 60) + " — Research agent — Patrick Vieira";
    assert.equal(title(h), want);
    assert.equal(meta(h, "property", "og:title"), want);
    assert.equal(meta(h, "name", "description"), PAYLOAD);
    assert.equal(meta(h, "property", "og:description"), PAYLOAD);
    assert.equal((head.match(/<meta /g) ?? []).length, 9, "no meta element injected");
    assert.doesNotMatch(head.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ""), /<a |<script>|content="[^"]*"[^>\s]/);
  } finally { s.done(); }
});

test("F-005 (D7): the JSON-LD block parses, holds no literal <, and round-trips the question", () => {
  const s = site();
  try {
    ok(publish(s, [run(1, { edit: (d) => { d.question = PAYLOAD + " </script>  "; } })]));
    const h = runPage(s, runId(1));
    const raw = h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    assert.ok(!raw.includes("<"), "no literal <");
    assert.equal(JSON.parse(raw).headline, PAYLOAD + " </script>  ");
  } finally { s.done(); }
});

test("F-005 (D7): a manifest alt text with \", & and < is one well-formed alt attribute; a scorecard model id with &, \" and < is escaped in the header and unchanged in the Markdown copy", () => {
  const s = site();
  try {
    const alt = `A chart of "open" & <close> volatility`;
    const id = `vendor:model&"<b>`;
    ok(publish(s, [run(1, { alt: { [FIG]: alt } })], { card: edit(scorecard(), (d) => { d.fingerprint.config.models.analyst = id; }) }));
    const img = body(runPage(s, runId(1))).match(/<img [^>]*>/)[0];
    assert.equal(img, `<img src="${FIG}" width="40" height="30" alt="A chart of &quot;open&quot; &amp; &lt;close&gt; volatility">`);
    assert.equal(decodeEntities(img.match(/alt="([^"]*)"/)[1]), alt);
    const h = out(s, SHOWCASE);
    assert.ok(body(h).includes(`analyst vendor:model&amp;&quot;&lt;b&gt;, critic`));
    assert.doesNotMatch(body(h), /<b>/);
    assert.ok(out(s, "projects/research-agent.md").includes(`analyst ${id}, critic`), "the Markdown copy holds the id as written");
  } finally { s.done(); }
});

test("F-005 (D7): a run page from a report.md holding raw HTML, links, autolinks and a task list builds, passes the inline-code guards, and shows nothing live", () => {
  const s = site();
  try {
    const md = "# R\n\n<script>alert(1)</script>\n\n<iframe src=//e.com></iframe> <b onclick=alert(1)>b</b> <svg onload=alert(1)>\n\n[x](https://example.com) [y](javascript:alert(1)) <https://example.com> www.example.com someone@example.com\n\n- [x] done\n";
    ok(publish(s, [run(1, { md })]));
    const report = body(runPage(s, runId(1))).split(`<h2>${P.labels.section.report}</h2>`)[1].split(`<h2>${P.labels.section.figures}</h2>`)[0];
    assert.doesNotMatch(report, /<(a|script|img|iframe|svg|input)[\s>]/);
    assert.doesNotMatch(report, /mailto:/);
  } finally { s.done(); }
});

// ---- Machine-readable copies, the launch switch and the _headers rules (US-3, D9, D10) ----
import { checkHeaders } from "../build.mjs";
const SIDE = { title: "Research agent", summary: "An agent built with LangGraph that plans, runs sandboxed analysis and reports.", url: "/projects/research-agent" };
const CARD = `<li>
            <article aria-labelledby="s-03-h">
              <span class="label">S-03</span>
              <h3 id="s-03-h"><a href="/projects/research-agent">${SIDE.title}</a></h3>
              <p>${SIDE.summary}</p>
            </article>
          </li>
        </ul>`;
const sideCard = (h) => h.replace(/(<section id="side-projects"[\s\S]*?)<\/ul>/, (m, a) => a + CARD);
const launch = (on = true, side = true) => (c) => { c.pages.projects.launched = on; if (side) c.side_projects.push(SIDE); };
const launched = (s, runs, opts = {}) => publish(s, runs, { card: scorecard(), copy: launch(), html: sideCard, ...opts });

test("F-005 (US-3): each page links its Markdown copy; report.md, report.json and the figures are byte-identical to the published files", () => {
  const s = site();
  try {
    const r = run(1, { md: "# R\r\n\r\nCRLF kept, and a trailing space \n", figures: { [FIG]: png({ idat: deflateSync(Buffer.from([0xff, 0xfe, 0x0d, 0x0a, 0x00, 0x80]), { level: 0 }), width: 1, height: 1, colour: 0 }) } });
    ok(publish(s, [r]));
    for (const [f, md] of [["projects/index.html", "/projects/index.md"], [SHOWCASE, "/projects/research-agent.md"], [`projects/research-agent/runs/${r.id}/index.html`, `/projects/research-agent/runs/${r.id}/report.md`]]) {
      assert.ok(out(s, f).includes(`<link rel="alternate" type="text/markdown" href="${md}">`), f);
      assert.ok(existsSync(join(s.root, "public", md)), md);
    }
    const src = join(s.root, "projects/research-agent/runs", r.id), pub = join(s.root, "public/projects/research-agent/runs", r.id);
    for (const f of ["report.md", "report.json", FIG]) assert.ok(readFileSync(join(pub, f)).equals(readFileSync(join(src, f))), f);
    assert.ok(readFileSync(join(pub, "report.md")).equals(Buffer.from(r.md)), "no footer appended");
    const md = out(s, "projects/research-agent.md");
    assert.ok(md.includes(`${SITE}projects/research-agent/runs/${r.id}/report.md`) && md.includes(`Read and published by Patrick Vieira on ${TODAY}.`), "the showcase's Markdown links each run's report.md, with its checked date");
  } finally { s.done(); }
});

test("F-005 (D3): a figure with bytes that aren't UTF-8 and a \\r\\n round-trips byte-identical from the export through --record to projects/ and public/", () => {
  const s = site();
  try {
    const fig = png({ idat: deflateSync(Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x0d, 0x0a, 0x00, 0x80, 0x0d, 0x0a]), { level: 0 }) });
    assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(fig));
    const dir = join(s.base, "export");
    const files = { ...runFiles(), "calls/1/out/vol_by_minute.png": fig };
    ok(record({ root: s.root, dir, expect: writeExport(dir, { files }), today: TODAY }));
    const m = JSON.parse(readFileSync(join(s.root, MANIFEST), "utf8"));
    m.runs[RUN_ID].alt["calls/1/out/vol_by_minute.png"] = "A synthetic chart.";
    writeFileSync(join(s.root, MANIFEST), JSON.stringify(m, null, 2) + "\n");
    ok(build({ root: s.root, today: TODAY, now: NOW }));
    for (const where of [`projects/research-agent/runs/${RUN_ID}`, `public/projects/research-agent/runs/${RUN_ID}`]) {
      assert.ok(readFileSync(join(s.root, where, "calls/1/out/vol_by_minute.png")).equals(fig), where);
    }
    ok(build({ root: s.root, check: true, now: NOW }));
  } finally { s.done(); }
});

test("F-005 (US-3, D9): launched false — llms.txt, index.md and the sitemap don't list the pages, every page is noindex, and _headers has the /projects/* noindex rule", () => {
  const s = site();
  try {
    ok(publish(s, [run(1)], { card: scorecard() }));
    for (const f of ["llms.txt", "index.md", "sitemap.xml"]) assert.doesNotMatch(out(s, f), /patrickjv\.com\/projects|## Projects/, f);
    for (const f of ["projects/index.html", SHOWCASE, `projects/research-agent/runs/${runId(1)}/index.html`]) assert.ok(out(s, f).includes('<meta name="robots" content="noindex">'), f);
    assert.match(out(s, "_headers"), /\n\/projects\/\*\n {2}X-Robots-Tag: noindex\n/);
  } finally { s.done(); }
});

test("F-005 (US-3, D9): launched true — llms.txt, index.md and the sitemap list the pages and each run, and nothing is noindex", () => {
  const s = site();
  try {
    const r1 = run(1, { checked: "2026-11-10" }), r2 = run(2, { edit: (d) => { d.question = "A second [synthetic] question?"; } });
    ok(launched(s, [r1, r2]));
    const sitemap = out(s, "sitemap.xml");
    for (const [loc, lastmod] of [[`${SITE}projects/`, null], [`${SITE}projects/research-agent`, null], [`${SITE}projects/research-agent/runs/${r1.id}/`, "2026-11-10"], [`${SITE}projects/research-agent/runs/${r2.id}/`, TODAY]]) {
      assert.match(sitemap, new RegExp(`<url><loc>${loc.replace(/[.?]/g, "\\$&")}</loc><lastmod>${lastmod ?? "\\d{4}-\\d{2}-\\d{2}"}</lastmod></url>`), loc);
    }
    for (const f of ["llms.txt", "index.md"]) {
      const t = out(s, f);
      assert.ok(t.includes("## Projects"), f);
      assert.ok(t.includes(`[Research agent](${SITE}projects/research-agent.md)`), f);
      assert.ok(t.includes(`- [${report().question}](${SITE}projects/research-agent/runs/${r1.id}/report.md) (checked 2026-11-10)`), f);
      assert.ok(t.includes(`- [A second \\[synthetic\\] question?](${SITE}projects/research-agent/runs/${r2.id}/report.md) (checked ${TODAY})`), `${f}: the question as plain text in the link`);
    }
    for (const f of ["projects/index.html", SHOWCASE, `projects/research-agent/runs/${r1.id}/index.html`]) assert.doesNotMatch(out(s, f), /noindex/, f);
    assert.doesNotMatch(out(s, "_headers"), /X-Robots-Tag/);
  } finally { s.done(); }
});

test("F-005 (D9): launched true with no published run, or with no scorecard, fails the build", () => {
  const s = site();
  try {
    for (const [what, r] of [["no run", launched(s, [])], ["no scorecard", launched(s, [run(1)], { card: null })]]) {
      assert.ok(r.errors.some((e) => /launched is true, but launch needs at least one published run and the scorecard/.test(e)), `${what}: ${r.errors.join("\n")}`);
    }
  } finally { s.done(); }
});

test("F-005 (D9): the launch check — launched without the side-projects entry and its link, or the entry and link without launched, fails; a side project url that isn't a link in its card fails", () => {
  const s = site();
  try {
    ok(launched(s, [run(1)]));
    let r = publish(s, [run(1)], { card: scorecard(), copy: launch(true, false) });
    assert.ok(r.errors.some((e) => /launched is true.*side project/.test(e)), `launched, no entry: ${r.errors.join("\n")}`);
    r = publish(s, [run(1)], { card: scorecard(), copy: launch(false), html: sideCard });
    assert.ok(r.errors.some((e) => /launched is false.*side project/.test(e)), `entry and link, not launched: ${r.errors.join("\n")}`);
    r = publish(s, [run(1)], { card: scorecard(), copy: launch(), html: (h) => sideCard(h).replace('<a href="/projects/research-agent">Research agent</a>', "Research agent") });
    assert.ok(r.errors.some((e) => /side_projects\.2\.url.*\/projects\/research-agent/.test(e)), `entry without its link: ${r.errors.join("\n")}`);
    r = publish(s, [], { copy: (c) => { c.side_projects[0].url = "https://example.com/kaizen"; } });
    assert.ok(r.errors.some((e) => /side_projects\.0\.url/.test(e)), `another side project's url without its link: ${r.errors.join("\n")}`);
  } finally { s.done(); }
});

test("F-005 (US-4, D4): unpublishing a run leaves no file or directory for it, and no entry in the sitemap, llms.txt, index.md or the showcase", () => {
  const s = site();
  try {
    const keep = run(1), gone = run(2, { figures: { "calls/7/out/deep.png": png() } });
    ok(launched(s, [keep, gone]));
    assert.ok(existsSync(join(s.root, "public/projects/research-agent/runs", gone.id, "calls/7/out/deep.png")));
    const r = launched(s, [keep]); // its directory and manifest entry removed
    ok(r);
    assert.ok(!existsSync(join(s.root, "public/projects/research-agent/runs", gone.id)), "the run's whole directory, emptied calls/… included");
    assert.ok(r.removed.includes(`public/projects/research-agent/runs/${gone.id}/calls/7/out/deep.png`));
    for (const f of ["sitemap.xml", "llms.txt", "index.md", SHOWCASE, "projects/research-agent.md", "_headers"]) assert.ok(!out(s, f).includes(gone.id), f);
    ok(build({ root: s.root, check: true, now: NOW }));
  } finally { s.done(); }
});

test("F-005 (US-3): JSON-LD parses on each page, and every @id reference resolves to #person, the showcase's #software or the page itself", () => {
  const s = site();
  try {
    const r = run(1, { checked: "2026-11-09" });
    ok(publish(s, [r], { card: scorecard() }));
    const graph = JSON.parse(readFileSync(join(s.root, "public/index.html"), "utf8").match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])["@graph"];
    const sw = `${SITE}projects/research-agent#software`;
    const known = new Set([...graph.map((n) => n["@id"]), sw]);
    const ids = (v, acc = []) => { if (v && typeof v === "object") { if (v["@id"] && Object.keys(v).length === 1) acc.push(v["@id"]); Object.values(v).forEach((x) => ids(x, acc)); } return acc; };
    const ix = jsonld(out(s, "projects/index.html")), sc = jsonld(out(s, SHOWCASE)), rp = jsonld(runPage(s, r.id));
    for (const ld of [ix, sc, rp]) for (const id of ids(ld)) assert.ok(known.has(id) || id.startsWith(ld.url), id);
    assert.ok(known.has(`${SITE}#person`));
    assert.equal(ix["@type"], "CollectionPage");
    assert.equal(ix.mainEntity["@type"], "ItemList");
    assert.equal(ix.mainEntity.itemListElement[0].url, `${SITE}projects/research-agent`);
    assert.equal(sc["@type"], "WebPage");
    assert.deepEqual({ ...sc.mainEntity, keywords: undefined, description: undefined, name: undefined }, { "@type": "SoftwareSourceCode", "@id": sw, programmingLanguage: "Python", author: { "@id": `${SITE}#person` }, keywords: undefined, description: undefined, name: undefined });
    for (const k of ["LangGraph", "LangChain", "MCP"]) assert.ok(sc.mainEntity.keywords.includes(k), k);
    assert.ok(!("codeRepository" in sc.mainEntity));
    assert.equal(rp["@type"], "Report");
    assert.equal(rp.headline, report().question);
    assert.deepEqual(rp.about, { "@id": sw });
    assert.equal(rp.datePublished, "2026-11-09");
    assert.deepEqual(rp.author, { "@id": `${SITE}#person` });
  } finally { s.done(); }
});

test("F-005 (D1, D10): one exact CSP rule per new HTML, Markdown and JSON path, none with script-src, none for figures; the _headers guards pass", () => {
  const s = site();
  try {
    const r = run(1);
    ok(publish(s, [r], { card: scorecard() }));
    const headers = out(s, "_headers");
    assert.deepEqual(checkHeaders(headers), []);
    const rules = Object.fromEntries(headers.split(/\n(?=\S)/).filter((b) => !b.startsWith("#") && b.trim()).map((b) => { const [p, ...l] = b.trim().split("\n"); return [p.trim(), l.map((x) => x.trim())]; }));
    const base = `/projects/research-agent/runs/${r.id}/`;
    for (const p of ["/projects/", "/projects/index.html", "/projects/research-agent", "/projects/research-agent.html", base, `${base}index.html`]) {
      const csp = rules[p]?.find((l) => l.startsWith("Content-Security-Policy:"));
      assert.ok(csp, p);
      assert.match(csp, /^Content-Security-Policy: default-src 'none'; img-src 'self'; font-src 'self'; style-src 'sha256-[A-Za-z0-9+/=]+'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests$/, p);
    }
    for (const [p, type] of [["/projects/index.md", "text/markdown"], ["/projects/research-agent.md", "text/markdown"], [`${base}report.md`, "text/markdown"], [`${base}report.json`, "application/json"]]) {
      assert.ok(rules[p]?.includes(`Content-Type: ${type}; charset=utf-8`), p);
      assert.ok(rules[p]?.some((l) => l.startsWith("Content-Security-Policy: default-src 'none'")), p);
    }
    assert.ok(!Object.keys(rules).some((p) => p.endsWith(".png") && p.startsWith("/projects/")), "no rule for figures");
    assert.doesNotMatch(Object.entries(rules).filter(([p]) => p.startsWith("/projects")).flatMap(([, l]) => l).join("\n"), /script-src/);
    assert.equal(Object.keys(rules).filter((p) => p.startsWith("/projects")).length, 6 + 4 + 1, "6 fixed rules, 4 per run, 1 noindex wildcard");
  } finally { s.done(); }
});

test("F-005 (D4): --check reports the /projects outputs stale when a source changes", () => {
  const s = site();
  try {
    ok(publish(s, [run(1)], { card: scorecard() }));
    ok(build({ root: s.root, check: true, now: NOW }));
    const page = `public/projects/research-agent/runs/${runId(1)}/index.html`;
    const change = (f, fn) => { const p = join(s.root, f); writeFileSync(p, fn(readFileSync(p, "utf8"))); };
    for (const [what, fn, want] of [
      ["copy", () => change("content.json", (t) => t.replace(`"${P.copy.showcase.built_heading}"`, '"How I built it"')), "public/projects/research-agent.html"],
      ["a label", () => change("content.json", (t) => t.replace(`"${P.labels.run.finished}"`, '"Ended"')), page],
      ["the SVG", () => change("projects/research-agent/architecture.svg", (t) => t.replace(">Plan<", ">The plan<")), "public/projects/research-agent.html"],
      ["alt text", () => change(MANIFEST, (t) => t.replace("Synthetic chart 1.", "A changed alt text.")), page],
    ]) {
      fn();
      const checked = build({ root: s.root, check: true, now: NOW });
      assert.ok(checked.errors.some((e) => e.startsWith("out of date") && e.includes(want)), `${what}: ${checked.errors.join("\n")}`);
      ok(build({ root: s.root, today: TODAY, now: NOW }));
      ok(build({ root: s.root, check: true, now: NOW }));
    }
  } finally { s.done(); }
});
