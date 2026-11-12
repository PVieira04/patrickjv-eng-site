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
import { report, scorecard, dump, sha, png, RUN_ID } from "./projects-helpers.mjs";

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
