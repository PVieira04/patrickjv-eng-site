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
