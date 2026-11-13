// F-005: the /projects pages — the index, the research-agent showcase and one page per published
// run — with their Markdown copies and the byte copies of each run's exported files. Model-written
// text is never trusted markup (D7): report.md goes through its own Marked instance with nothing
// live, and every other interpolated string is escaped plain text.
import { Marked, Renderer } from "marked";
import { ENUMS } from "./projects.mjs";

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------------------------------------
// D7a: report.md. A new Marked instance per report (never the shared `marked` the writing pages
// use): raw HTML escaped; no live link (a link renders as its text, then its target as plain text
// when that differs from the text); images dropped; task-list boxes as "[x] " text; every table and
// code block in a focusable, labelled scroll region; headings shifted so the shallowest level
// present is <h3>, capped at <h6>.
// ---------------------------------------------------------------------------------------------
const bare = (u) => u.replace(/^mailto:/i, "").replace(/^https?:\/\//i, "");
export function renderReportMd(md) {
  const m = new Marked({ gfm: true });
  let shallowest = 7;
  m.walkTokens(m.lexer(md), (t) => { if (t.type === "heading") shallowest = Math.min(shallowest, t.depth); });
  const n = { Table: 0, Code: 0 };
  const scroll = (kind, inner) => `<div class="scroll" role="region" aria-label="${kind} ${++n[kind]}" tabindex="0">\n${inner}</div>\n`;
  m.use({
    renderer: {
      html: ({ text }) => esc(text),
      // marked escapes text in the renderer, not the lexer: an ordinary text token holds the
      // unescaped text and the default renderer escapes it. But inside an inline <code>, <pre>,
      // <kbd> or <script> the lexer is "in a raw block", and its text tokens hold their raw source
      // with escaped: true, which the default renderer outputs unescaped (marked 18.1.0 and
      // 18.1.1). So: raw-block text is escaped here; everything else goes to the default renderer.
      text(t) { return t.tokens ? this.parser.parseInline(t.tokens) : t.escaped ? esc(t.text) : Renderer.prototype.text.call(this, t); },
      link({ href, tokens, text }) {
        const shown = this.parser.parseInline(tokens);
        return bare(href) === bare(text) ? shown : `${shown} (${esc(href)})`;
      },
      image: () => "",
      checkbox: ({ checked }) => (checked ? "[x] " : "[ ] "),
      heading({ tokens, depth }) {
        const h = Math.min(6, depth - shallowest + 3);
        return `<h${h}>${this.parser.parseInline(tokens)}</h${h}>\n`;
      },
      table(token) { return scroll("Table", Renderer.prototype.table.call(this, token)); },
      code(token) { return scroll("Code", Renderer.prototype.code.call(this, token)); },
    },
  });
  return m.parse(md);
}

// The backstop for any future marked bypass: the rendered report may hold only these elements, with
// only these attributes (the scroll wrappers, a code block's language class, table alignment and a
// list's start), and no "<" that isn't a tag. Returns the problems found, naming the element.
const REPORT_TAGS = new Set(["p", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "em", "strong", "del", "blockquote", "hr", "br", "span", "div"]);
const REPORT_ATTRS = {
  div: { class: (v) => v === "scroll", role: (v) => v === "region", "aria-label": (v) => /^(Table|Code) [0-9]+$/.test(v), tabindex: (v) => v === "0" },
  code: { class: (v) => /^language-[^\s"'<>&]*$/.test(v) },
  th: { align: (v) => ["left", "center", "right"].includes(v) },
  td: { align: (v) => ["left", "center", "right"].includes(v) },
  ol: { start: (v) => /^[0-9]+$/.test(v) },
};
export function reportHtmlErrors(html) {
  const errors = [];
  const rest = html.replace(/<(\/?)([A-Za-z][^\s>/]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g, (m, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!REPORT_TAGS.has(t)) { errors.push(`<${t}> is not allowed in a rendered report`); return ""; }
    for (const [, name, , dq, sq, bare] of attrs.matchAll(/([^\s"'>/=]+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const check = REPORT_ATTRS[t]?.[name.toLowerCase()];
      if (close || !check || !check(dq ?? sq ?? bare ?? "")) errors.push(`<${t} ${name}> is not allowed in a rendered report`);
    }
    return "";
  });
  if (/[<>]/.test(rest)) errors.push("a rendered report holds a < or > outside a tag (unescaped markup)");
  return errors;
}

// ---------------------------------------------------------------------------------------------
// D5: pages.projects. Templates are filled in one pass: each {name} in the template text is
// replaced once by its value, and values are never scanned for placeholders. The names each
// template may use are fixed here; the build refuses any other.
// ---------------------------------------------------------------------------------------------
export const TEMPLATE_VARS = {
  run_title: ["question"], rejected: [], no_plan: ["stop_reason"], stopped: ["stop_reason"], dataset: ["name"], window: ["start", "end"],
  run_models: ["planner", "analyst", "critic"], scorecard_models: ["analyst", "critic"], harness_count: ["harness", "count"], checked: ["date"],
  scorecard_runs: ["runs", "questions", "k"], scorecard_score: ["score", "se"], scorecard_trap_note: ["count"],
};
export const fill = (template, vars) => template.replace(/\{([a-z_]+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
// The template's own text between its placeholders: what must show on a page that uses it.
export const literals = (template) => template.split(/\{[a-z_]+\}/).map((s) => s.trim()).filter(Boolean);

// Truncation is by Unicode code point, before escaping. A title cuts at `max`; a description cuts
// at the last space at or before `max` (a hard cut if there is none). "…" is appended when cut.
export const truncate = (s, max) => { const cp = [...s]; return cp.length <= max ? s : cp.slice(0, max).join("") + "…"; };
export function truncateAtSpace(s, max) {
  const cp = [...s];
  if (cp.length <= max) return s;
  const space = cp.slice(0, max + 1).lastIndexOf(" ");
  return (space > 0 ? cp.slice(0, space).join("").trimEnd() : cp.slice(0, max).join("")) + "…";
}

// Two decimal places, rounded half away from zero from the number's shortest round-trip decimal
// form (String(x)), so 0.125 -> "0.13" and 0.135 -> "0.14" whatever the binary value.
export function fixed2(x) {
  const s = String(x);
  if (/e/i.test(s)) return x.toFixed(2); // |x| < 1e-6 or huge: no half-way case at two places
  const neg = s.startsWith("-"), [int, frac = ""] = s.replace("-", "").split(".");
  let n = BigInt(int + frac.slice(0, 2).padEnd(2, "0"));
  if ((frac[2] ?? "0") >= "5") n += 1n;
  const t = n.toString().padStart(3, "0");
  return `${neg && n ? "-" : ""}${t.slice(0, -2)}.${t.slice(-2)}`;
}

// Run cards: by role (trap_caught, rejected_plan, clean_pass, then none), then finished_at newest
// first, then run id.
const ROLE_ORDER = ["trap_caught", "rejected_plan", "clean_pass"];
const roleRank = (r) => (r.entry.role === undefined ? ROLE_ORDER.length : ROLE_ORDER.indexOf(r.entry.role));
// A checked UTC timestamp (YYYY-MM-DDTHH:MM:SS[.ffffff]Z) as microseconds since the epoch, so
// fractional seconds compare as instants ("…00.5Z" is later than "…00Z", though it sorts first).
const instant = (t) => { const [, whole, frac = ""] = t.match(/^(.*?:\d\d)(?:\.(\d+))?Z$/); return BigInt(Date.parse(whole + "Z")) * 1000n + BigInt(frac.padEnd(6, "0").slice(0, 6)); };
const newest = (a, b) => { const x = instant(a), y = instant(b); return x < y ? 1 : x > y ? -1 : 0; };
export const orderRuns = (runs) => [...runs].sort((a, b) => roleRank(a) - roleRank(b) || newest(a.doc.finished_at, b.doc.finished_at) || (a.id < b.id ? -1 : 1));

// Markdown copies hold the values as plain text: line breaks (\n, \r\n and a lone \r, each of which
// ends a Markdown line) become one space, and the characters that would end a link's text or a
// table cell are backslash-escaped. Used for every model-written value in a Markdown copy.
export const mdInline = (s) => String(s).replace(/\s*[\r\n]+\s*/g, " ").replace(/[\\[\]|]/g, "\\$&");

export const PROJECT_STYLE = `
:root { --line-strong: #b9b6ab; }
@media (prefers-color-scheme: dark) { :root { --line-strong: #3a414c; } }
.bar { flex-wrap: wrap; }
main { overflow-wrap: anywhere; }
:focus-visible { outline: 3px solid var(--signal); outline-offset: 2px; }
h3 { font-size: 1.0625rem; margin: 1.5em 0 0.4em; font-weight: 600; }
h4, h5 { font-size: 1rem; margin: 1.25em 0 0.4em; font-weight: 600; }
.lead { font-size: 1.125rem; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; margin: 0 0 16px; }
.facts dt { font-family: var(--mono); font-size: 0.875rem; color: var(--muted); padding-top: 0.15em; }
.facts dd { margin: 0; }
@media (max-width: 480px) { .facts { grid-template-columns: minmax(0, 1fr); gap: 0; } .facts dd { margin-bottom: 8px; } }
.scroll { max-width: 100%; overflow-x: auto; margin: 0 0 16px; }
.scroll pre { margin: 0; overflow: visible; }
.scroll table { overflow-wrap: normal; }
.scorecard-id > span { white-space: nowrap; }
.local-models code > span { white-space: nowrap; }
.scorecard-note { font-size: 0.9375rem; color: var(--muted); }
@media (max-width: 560px) { .scorecard-stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); } .scorecard-stack, .scorecard-stack tbody, .scorecard-stack tr, .scorecard-stack th, .scorecard-stack td { display: block; } .scorecard-stack tr { padding: 8px 0; border-bottom: 1px solid var(--line); } .scorecard-stack th, .scorecard-stack td { border: 0; padding: 2px 0; } .scorecard-stack td { display: flex; gap: 12px; } }
.scorecard-stack td::before { content: attr(data-label) / ""; display: none; }
@media (max-width: 560px) { .scorecard-stack td::before { display: block; flex: 0 0 9.5rem; font-family: var(--mono); font-size: 0.8125rem; color: var(--muted); } }
table { border-collapse: collapse; font-size: 0.9375rem; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 12px 6px 0; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
thead th { font-family: var(--mono); font-size: 0.8125rem; font-weight: 400; color: var(--muted); }
.cards { list-style: none; padding: 0; }
.cards > li { margin: 0; padding: 16px 0; border-top: 1px solid var(--line); }
.cards h5 { margin: 0 0 8px; }
.issues li { margin: 0.5em 0; }
.tag { font-weight: 600; }
figure { margin: 0 0 24px; }
img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); }
.arch { display: block; width: 100%; max-width: 30rem; height: auto; margin: 8px auto 24px; }
.arch .box { fill: var(--code); stroke: var(--line-strong); }
.arch .out { stroke-dasharray: 5 4; }
.arch .layer { fill: none; stroke: var(--line-strong); stroke-width: 1.5; }
.arch .hl { fill: none; stroke: var(--signal); stroke-width: 2; }
.arch .edge { fill: none; stroke: var(--muted); stroke-width: 1.5; }
.arch .head { fill: var(--muted); }
.arch text { fill: var(--ink); font-family: var(--mono); font-size: 14px; }
.arch .small { fill: var(--muted); font-size: 12.5px; }
.arch .note { fill: none; stroke: var(--muted); stroke-dasharray: 1 3; stroke-linecap: round; stroke-width: 1.5; }
`;

const RUNS = "projects/research-agent/runs/";

// Everything under public/projects/, from the copy and the published runs and scorecard.
//   p: content.json pages.projects; runs: [{ id, entry (manifest), doc (report.json), md
//   (report.md), files (path -> Buffer), figures: [{ path, width, height, alt }] }]; scorecard:
//   { entry, doc } or null; diagrams: [{ file, after, svg }], each SVG's text and where it goes
//   ("intro", or the index of an architecture subsection); kit: { site, style, safeJson, footer }.
// Returns { files (output path -> text or Buffer), html (the HTML pages), uses (the named strings
// each page shows: { file, path, literals }), reports (each run page's rendered report.md), listing (for the sitemap, llms.txt and index.md) }.
export function renderProjects({ p, runs, scorecard, diagrams, kit }) {
  const { site, safeJson } = kit;
  const files = {}, html = {}, uses = [], reports = {};
  let page = null;
  const at = (path) => path.split(".").reduce((o, k) => o?.[k], p);
  const use = (path, lits) => { if (page) uses.push({ file: page, path, literals: lits }); };
  const L = (path) => { const v = at(path); use(path, [v]); return v; };
  const T = (name, vars) => { const t = p.templates[name]; use(`templates.${name}`, literals(t)); return fill(t, vars); };
  const copy = p.copy, e = esc;
  const ordered = orderRuns(runs);
  const showcaseUrl = `${site}projects/research-agent`;
  const runUrl = (id) => `${site}${RUNS}${id}/`;
  const scroll = (label, inner) => `<div class="scroll" role="region" aria-label="${e(label)}" tabindex="0">\n${inner}\n</div>`;
  const facts = (rows) => `<dl class="facts">\n${rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${typeof v === "string" ? e(v) : v.html}</dd>`).join("\n")}\n</dl>`;
  const person = { "@id": site + "#person" };

  const shell = ({ title, description, canonical, alternate, ogType = "website", jsonld, main }) => `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
${p.launched ? "" : '<meta name="robots" content="noindex">\n'}<link rel="canonical" href="${e(canonical)}">
<link rel="alternate" type="text/markdown" href="${e(alternate)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:url" content="${e(canonical)}">
<meta property="og:image" content="${site}og-card.jpg">
<script type="application/ld+json">
${safeJson(jsonld, 2)}
</script>
<style>${kit.style}${PROJECT_STYLE}</style>
</head>
<body>
<div class="wrap">
<nav class="bar" aria-label="Site"><a href="/">← patrickjv.com</a><a href="/projects/">Projects</a></nav>
<main>
${main}
</main>
${kit.footer}
</div>
</body>
</html>
`;

  // ---- the scorecard (D5 labels; "Scorecard -> What the page shows") ----
  let scoreHtml = "", scoreMd = [];
  if (scorecard) {
    const d = scorecard.doc, cfg = d.fingerprint.config, s = "labels.scorecard";
    const counts = ENUMS.harness.map((h) => [h, d.runs.filter((r) => r && r.run_id !== null && r.models?.harness === h).length]).filter(([, n]) => n > 0);
    const harness = counts.map(([h, n]) => T("harness_count", { harness: L(`labels.harness.${h}`), count: n })).join(", ");
    // An undefined ratio gives its reason; a question with no planted trap says just that.
    const ratio = (q, r, none) => (r.n !== 0 ? `${r.x} / ${r.n}` : L(`${s}.${q.trap_handled === null ? "no_trap" : none}`));
    const score = d.aggregate.se === null ? `${fixed2(d.aggregate.score)} ${L(`${s}.se_na`)}` : T("scorecard_score", { score: fixed2(d.aggregate.score), se: fixed2(d.aggregate.se) });
    // "50 runs: 10 questions × 5" only when it is the sum; otherwise the count alone.
    const total = d.runs.length, runsShown = d.questions.every((q) => q.n_repeats === d.k) ? T("scorecard_runs", { runs: total, questions: d.questions.length, k: d.k }) : String(total);
    // Model ids are plain text that may break only after a colon: the template's words are escaped,
    // and each id is split after each ":" into no-wrap parts joined by <wbr>. The Markdown copy
    // holds the filled template.
    const modelVars = { analyst: cfg.models.analyst, critic: cfg.models.critic };
    const modelsMd = T("scorecard_models", modelVars);
    const modelsHtml = p.templates.scorecard_models.split(/(\{[a-z_]+\})/).map((x) => (/^\{[a-z_]+\}$/.test(x) ? `<span class="scorecard-id">${modelVars[x.slice(1, -1)].split(/(?<=:)/).map((part) => `<span>${e(part)}</span>`).join("<wbr>")}</span>` : e(x))).join("");
    const head = [
      [L(`${s}.date`), d.created_at.slice(0, 10)], [L(`${s}.runs`), runsShown], [L(`${s}.harness`), harness],
      [L(`${s}.models`), { html: modelsHtml, md: modelsMd }], [L(`${s}.seed`), String(cfg.seed)], [L(`${s}.aggregate`), score],
    ];
    const keys = ["question", "correct", "trap_handled", "trap_recall", "critic_precision"], cols = keys.map((k) => L(`${s}.columns.${k}`));
    const rows = d.questions.map((q) => [q.id, `${q.correct} / ${q.n_repeats}`, q.trap_handled === null ? L(`${s}.no_trap`) : `${q.trap_handled} / ${q.n_repeats}`, ratio(q, q.trap_recall, "no_trap_reached"), ratio(q, q.critic_precision, "no_trap_flagged")]);
    // The note: no eval run fell into a trap (every trap question handled on every repeat, no
    // trapped pass reviewed or not, nothing unscored, no null repeat) and the critic raised no issue,
    // trap or other. With no null repeat its count is the Runs row's: every runs[] entry.
    const clean = d.runs.every((r) => r.run_id !== null) && d.questions.some((q) => q.trap_handled !== null) && d.questions.every((q) => q.trap_recall.n === 0 && q.critic_precision.n === 0 && q.unreviewed_trap_passes === 0 && q.unscored_passes === 0 && Object.keys(q.other_issues).length === 0 && (q.trap_handled === null || q.trap_handled === q.n_repeats));
    const note = clean ? T("scorecard_trap_note", { count: total }) : null;
    // Explicit roles: the narrow-screen layout sets display: block, which drops the implicit ones.
    const table = `<table class="scorecard-stack" role="table">\n<thead role="rowgroup"><tr role="row">${cols.map((c) => `<th scope="col" role="columnheader">${e(c)}</th>`).join("")}</tr></thead>\n<tbody role="rowgroup">\n${rows.map(([q, ...r]) => `<tr role="row"><th scope="row" role="rowheader"><code>${e(q)}</code></th>${r.map((x, i) => `<td role="cell" data-label="${e(cols[i + 1])}">${e(x)}</td>`).join("")}</tr>`).join("\n")}\n</tbody>\n</table>`;
    scoreHtml = `<section aria-labelledby="scorecard-h">\n<h4 id="scorecard-h">${e(L(`${s}.heading`))}</h4>\n${facts(head)}\n${scroll(L(`${s}.heading`), table)}\n${note ? `<p class="scorecard-note">${e(note)}</p>\n` : ""}</section>`;
    scoreMd = [`#### ${p.labels.scorecard.heading}`, "", ...head.map(([k, v]) => `- ${k}: ${mdInline(typeof v === "string" ? v : v.md)}`), "",
      `| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map(([q, ...r]) => `| \`${q}\` | ${r.map(mdInline).join(" | ")} |`), "", ...(note ? [note, ""] : [])];
  }

  // ---- the run pages ----
  const listing = [];
  for (const r of ordered) {
    const d = r.doc, id = r.id, base = `public/${RUNS}${id}/`;
    page = `${base}index.html`;
    const status = L(`labels.status.${d.status}`), outcome = L(`labels.outcome.${d.review.outcome}`), harness = L(`labels.harness.${d.models.harness}`);
    // reportErrors: a null plan, and the stopped sentence, only on a failed or capped run, which has a stop_reason.
    const stop = d.status === "failed" || d.status === "capped" ? L(`labels.stop_reason.${d.stop_reason}`) : null;
    const sec = (k) => e(L(`labels.section.${k}`));
    const parts = [
      `<h1>${e(d.question)}</h1>`,
      facts([
        [L("labels.run.finished"), d.finished_at.slice(0, 10)], [L("labels.run.harness"), harness],
        [L("labels.run.models"), T("run_models", { planner: d.models.planner, analyst: d.models.analyst, critic: d.models.critic })],
        [L("labels.run.status"), status], [L("labels.run.outcome"), outcome], [L("labels.run.dataset"), T("dataset", { name: d.dataset.name })],
      ]),
      `<p>${e(L("copy.synthetic"))}</p>`,
      `<h2>${sec("plan")}</h2>`,
      d.plan === null && stop !== null ? `<p>${e(T("no_plan", { stop_reason: stop }))}</p>` : facts([
        [L("labels.plan.hypothesis"), d.plan.hypothesis], [L("labels.plan.dataset"), d.plan.dataset], [L("labels.plan.window"), T("window", { start: d.plan.start, end: d.plan.end })],
        [L("labels.plan.method"), d.plan.method], [L("labels.plan.statistic"), d.plan.statistic], [L("labels.plan.significance"), d.plan.significance],
      ]),
    ];
    if (d.status === "rejected") parts.push(`<p><strong>${e(T("rejected", {}))}</strong></p>`, `<p>${e(d.rejection.reason)}</p>`);
    if ((d.status === "capped" || d.status === "failed") && d.plan !== null) parts.push(`<p>${e(T("stopped", { stop_reason: stop }))}</p>`);
    const issues = d.review.open_issues;
    parts.push(`<h2>${sec("critic")}</h2>`, `<p>${e(L("labels.run.outcome"))}: ${e(outcome)}</p>`,
      issues.length ? `<ul class="issues">\n${issues.map((x) => `<li><span class="tag">${e(L(`labels.tag.${x.tag}`))}</span>: ${e(x.explanation)}</li>`).join("\n")}\n</ul>` : `<p>${e(L("empty.issues"))}</p>`);
    reports[page] = renderReportMd(r.md).trimEnd();
    parts.push(`<h2>${sec("report")}</h2>`, reports[page]);
    if (r.figures.length && d.status !== "rejected") {
      parts.push(`<h2>${sec("figures")}</h2>`, ...r.figures.map((f, i) => `<figure><img src="${e(f.path)}" width="${f.width}" height="${f.height}" alt="${e(f.alt)}"${i ? ' loading="lazy"' : ""}></figure>`));
    }
    const mdHref = `/${RUNS}${id}/report.md`;
    parts.push(`<h2>${sec("links")}</h2>`, `<ul>\n<li><a href="${mdHref}">${e(L("labels.links.markdown"))}</a></li>\n<li><a href="/${RUNS}${id}/report.json">${e(L("labels.links.json"))}</a></li>\n<li><a href="/projects/research-agent">${e(L("labels.links.back"))}</a></li>\n</ul>`,
      `<p class="meta">${e(T("checked", { date: r.entry.checked }))}</p>`);
    html[page] = files[page] = shell({
      title: T("run_title", { question: truncate(d.question, 60) }), description: truncateAtSpace(d.summary.text, 160), canonical: runUrl(id), alternate: mdHref, ogType: "article",
      jsonld: { "@context": "https://schema.org", "@type": "Report", url: runUrl(id), headline: d.question, about: { "@id": `${showcaseUrl}#software` }, datePublished: r.entry.checked, inLanguage: "en-GB", author: person },
      main: parts.join("\n"),
    });
    files[`${base}report.md`] = r.files.get("report.md");
    files[`${base}report.json`] = r.files.get("report.json");
    for (const f of r.figures) files[base + f.path] = r.files.get(f.path);
    listing.push({ id, question: d.question, checked: r.entry.checked, page: runUrl(id), md: `${runUrl(id)}report.md` });
  }

  // ---- the showcase ----
  page = "public/projects/research-agent.html";
  const sc = "copy.showcase";
  const card = (r) => {
    const d = r.doc, rows = [[L("labels.card.harness"), L(`labels.harness.${d.models.harness}`)], [L("labels.card.status"), L(`labels.status.${d.status}`)], [L("labels.card.outcome"), L(`labels.outcome.${d.review.outcome}`)]];
    if (r.entry.role !== undefined) rows.push([L("labels.card.role"), L(`labels.role.${r.entry.role}`)]);
    const link = L("labels.card.link");
    return `<li>\n<h5>${e(d.question)}</h5>\n${facts(rows)}\n<a href="/${RUNS}${r.id}/" aria-label="${e(`${link}: ${d.question}`)}">${e(link)}</a>\n</li>`;
  };
  const codeLine = e(L(`${sc}.code`)).replace(e(L(`${sc}.code_link`)), `<a href="/book">${e(at(`${sc}.code_link`))}</a>`);
  const figs = (at) => diagrams.filter((d) => d.after === at).map((d) => d.svg);
  const paras = (path, list) => list.map((_, i) => `<p>${e(L(`${path}.${i}`))}</p>`);
  const arch = [
    ...paras(`${sc}.architecture_intro`, copy.showcase.architecture_intro), ...figs("intro"),
    ...copy.showcase.architecture.flatMap((a, i) => [`<h3>${e(L(`${sc}.architecture.${i}.heading`))}</h3>`, ...paras(`${sc}.architecture.${i}.text`, a.text), ...figs(i)]),
  ].join("\n");
  const next = copy.showcase.next.map((_, i) => `<h3>${e(L(`${sc}.next.${i}.heading`))}</h3>\n<p>${e(L(`${sc}.next.${i}.text`))}</p>`).join("\n");
  // The phases' hand-written tables use the scorecard's stacking layout. In a model table
  // (SHOWCASE_TABLES) the first cell is code-styled whole, or, when it has backticks (a hybrid row),
  // only its backticked ids are; like the scorecard's ids, each breaks only after a colon.
  const idHtml = (x) => `<code>${x.split(/(?<=:)/).map((part) => `<span>${e(part)}</span>`).join("<wbr>")}</code>`;
  const modelCell = (path) => { const s = at(path); use(path, [s.replaceAll("`", "")]); return s.includes("`") ? s.split("`").map((x, i) => (i % 2 ? idHtml(x) : e(x))).join("") : idHtml(s); };
  const table = (path, label, model) => {
    const t = at(path), cols = t.columns.map((_, i) => L(`${path}.columns.${i}`));
    const html = `<table class="scorecard-stack${model ? " local-models" : ""}" role="table">\n<thead role="rowgroup"><tr role="row">${cols.map((c) => `<th scope="col" role="columnheader">${e(c)}</th>`).join("")}</tr></thead>\n<tbody role="rowgroup">\n${t.rows.map((r, j) => `<tr role="row"><th scope="row" role="rowheader">${model ? modelCell(`${path}.rows.${j}.0`) : e(L(`${path}.rows.${j}.0`))}</th>${r.slice(1).map((_, i) => `<td role="cell" data-label="${e(cols[i + 1])}">${e(L(`${path}.rows.${j}.${i + 1}`))}</td>`).join("")}</tr>`).join("\n")}\n</tbody>\n</table>`;
    return scroll(label, html);
  };
  const tableMd = (t, model) => [`| ${t.columns.join(" | ")} |`, `|${t.columns.map(() => "---").join("|")}|`,
    ...t.rows.map(([m, ...r]) => `| ${model ? mdInline(m.includes("`") ? m : `\`${m}\``) : mdInline(m)} | ${r.map(mdInline).join(" | ")} |`), ""];
  const h = (n, path) => `<h${n}>${e(L(path))}</h${n}>`;
  // A subsection with a table: <h4> heading, intro, the table, then its paragraphs.
  const tableSection = (path, model) => [h(4, `${path}.heading`), `<p>${e(L(`${path}.intro`))}</p>`, table(path, at(`${path}.heading`), model), ...paras(`${path}.text`, at(path).text)].join("\n");
  const tableSectionMd = (t, model) => [`#### ${t.heading}`, "", t.intro, "", ...tableMd(t, model), ...t.text.flatMap((x) => [x, ""])];
  const p1 = copy.showcase.phase1, p1p = `${sc}.phase1`, p2 = copy.showcase.phase2, p2p = `${sc}.phase2`;
  const runsHtml = `<section aria-labelledby="runs-h">\n<h4 id="runs-h">${e(L(`${p1p}.runs_heading`))}</h4>\n${ordered.length ? `<ul class="cards">\n${ordered.map(card).join("\n")}\n</ul>` : `<p>${e(L("empty.runs"))}</p>`}\n</section>`;
  const phase1 = [
    `<h2 id="phase1-h">${e(L(`${p1p}.heading`))}</h2>`, ...paras(`${p1p}.intro`, p1.intro),
    h(3, `${p1p}.question_heading`), ...paras(`${p1p}.question`, p1.question),
    h(3, `${p1p}.built_heading`), ...paras(`${p1p}.built`, p1.built),
    h(3, `${p1p}.measured_heading`), ...paras(`${p1p}.measured`, p1.measured),
    h(3, `${p1p}.results_heading`), ...paras(`${p1p}.results`, p1.results), scoreHtml, runsHtml, tableSection(`${p1p}.local_models`, true),
    h(3, `${p1p}.showed_heading`), ...paras(`${p1p}.showed`, p1.showed),
  ].filter(Boolean).join("\n");
  const phase2 = [
    `<h2 id="phase2-h">${e(L(`${p2p}.heading`))}</h2>`, ...paras(`${p2p}.intro`, p2.intro),
    h(3, `${p2p}.question_heading`), ...paras(`${p2p}.question`, p2.question),
    h(3, `${p2p}.diagnosis_heading`), tableSection(`${p2p}.hybrid`, true), tableSection(`${p2p}.harness`, false),
    h(3, `${p2p}.scope_heading`), `<p>${e(L(`${p2p}.scope.intro`))}</p>`, `<ul>\n${p2.scope.items.map((_, i) => `<li>${e(L(`${p2p}.scope.items.${i}`))}</li>`).join("\n")}\n</ul>`, ...paras(`${p2p}.scope.text`, p2.scope.text),
    h(3, `${p2p}.guard_heading`), ...paras(`${p2p}.guard`, p2.guard),
    h(3, `${p2p}.results_heading`), `<p>${e(L(`${p2p}.results.intro`))}</p>`, table(`${p2p}.results`, at(`${p2p}.results_heading`), false),
  ].join("\n");
  html[page] = files[page] = shell({
    title: p.head.showcase.title, description: p.head.showcase.description, canonical: showcaseUrl, alternate: "/projects/research-agent.md",
    jsonld: { "@context": "https://schema.org", "@type": "WebPage", url: showcaseUrl, name: p.head.showcase.title, inLanguage: "en-GB",
      mainEntity: { "@type": "SoftwareSourceCode", "@id": `${showcaseUrl}#software`, name: copy.showcase.heading, description: p.head.showcase.description, programmingLanguage: "Python", keywords: ["LangGraph", "LangChain", "MCP", "AI agent", "evaluation"], author: person } },
    main: [
      `<h1>${e(L(`${sc}.heading`))}</h1>`, `<p class="lead">${e(L(`${sc}.lead`))}</p>`, `<p>${codeLine}</p>`,
      `<section aria-labelledby="what-h">\n<h2 id="what-h">${e(L(`${sc}.what_heading`))}</h2>\n${copy.showcase.what.map((_, i) => `<p>${e(L(`${sc}.what.${i}`))}</p>`).join("\n")}\n<p>${e(L("copy.synthetic"))}</p>\n</section>`,
      `<section aria-labelledby="arch-h">\n<h2 id="arch-h">${e(L(`${sc}.architecture_heading`))}</h2>\n${arch}\n</section>`,
      `<section aria-labelledby="phase1-h">\n${phase1}\n</section>`,
      `<section aria-labelledby="phase2-h">\n${phase2}\n</section>`,
      `<section aria-labelledby="next-h">\n<h2 id="next-h">${e(L(`${sc}.next_heading`))}</h2>\n<p>${e(L(`${sc}.next_intro`))}</p>\n${next}\n</section>`,
    ].filter(Boolean).join("\n"),
  });
  // Each diagram's text alternative in the Markdown copy: its <title> and <desc>, as plain text.
  const unesc = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const alt = (svg, tag) => unesc(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(svg)?.[1] ?? "");
  const figsMd = (at) => diagrams.filter((d) => d.after === at).flatMap((d) => [`Diagram: ${alt(d.svg, "title")}`, "", alt(d.svg, "desc"), ""]);
  const lb = p.labels;
  files["public/projects/research-agent.md"] = [
    `# ${copy.showcase.heading}`, "", copy.showcase.lead, "", copy.showcase.code.replace(copy.showcase.code_link, `[${copy.showcase.code_link}](${site}book)`), "",
    `## ${copy.showcase.what_heading}`, "", ...copy.showcase.what.flatMap((t) => [t, ""]), copy.synthetic, "",
    `## ${copy.showcase.architecture_heading}`, "", ...copy.showcase.architecture_intro.flatMap((t) => [t, ""]), ...figsMd("intro"),
    ...copy.showcase.architecture.flatMap((a, i) => [`### ${a.heading}`, "", ...a.text.flatMap((t) => [t, ""]), ...figsMd(i)]),
    `## ${p1.heading}`, "", ...p1.intro.flatMap((t) => [t, ""]),
    `### ${p1.question_heading}`, "", ...p1.question.flatMap((t) => [t, ""]),
    `### ${p1.built_heading}`, "", ...p1.built.flatMap((t) => [t, ""]),
    `### ${p1.measured_heading}`, "", ...p1.measured.flatMap((t) => [t, ""]),
    `### ${p1.results_heading}`, "", ...p1.results.flatMap((t) => [t, ""]),
    ...scoreMd,
    `#### ${p1.runs_heading}`, "",
    ...(ordered.length ? ordered.flatMap((r) => [
      `##### ${mdInline(r.doc.question)}`, "",
      `- ${lb.card.harness}: ${lb.harness[r.doc.models.harness]}`, `- ${lb.card.status}: ${lb.status[r.doc.status]}`, `- ${lb.card.outcome}: ${lb.outcome[r.doc.review.outcome]}`,
      ...(r.entry.role !== undefined ? [`- ${lb.card.role}: ${lb.role[r.entry.role]}`] : []),
      `- ${lb.links.markdown}: ${runUrl(r.id)}report.md`, `- ${lb.card.link}: ${runUrl(r.id)}`, `- ${fill(p.templates.checked, { date: r.entry.checked })}`, "",
    ]) : [p.empty.runs, ""]),
    ...tableSectionMd(p1.local_models, true),
    `### ${p1.showed_heading}`, "", ...p1.showed.flatMap((t) => [t, ""]),
    `## ${p2.heading}`, "", ...p2.intro.flatMap((t) => [t, ""]),
    `### ${p2.question_heading}`, "", ...p2.question.flatMap((t) => [t, ""]),
    `### ${p2.diagnosis_heading}`, "", ...tableSectionMd(p2.hybrid, true), ...tableSectionMd(p2.harness, false),
    `### ${p2.scope_heading}`, "", p2.scope.intro, "", ...p2.scope.items.map((t) => `- ${t}`), "", ...p2.scope.text.flatMap((t) => [t, ""]),
    `### ${p2.guard_heading}`, "", ...p2.guard.flatMap((t) => [t, ""]),
    `### ${p2.results_heading}`, "", p2.results.intro, "", ...tableMd(p2.results, false),
    `## ${copy.showcase.next_heading}`, "", copy.showcase.next_intro, "", ...copy.showcase.next.flatMap((n) => [`### ${n.heading}`, "", n.text, ""]),
    "---", "", `Canonical: ${showcaseUrl}`, "",
  ].join("\n");

  // ---- the index ----
  page = "public/projects/index.html";
  const ix = "copy.index", entry = copy.index.entry;
  html[page] = files[page] = shell({
    title: p.head.index.title, description: p.head.index.description, canonical: `${site}projects/`, alternate: "/projects/index.md",
    jsonld: { "@context": "https://schema.org", "@type": "CollectionPage", url: `${site}projects/`, name: p.head.index.title, inLanguage: "en-GB",
      mainEntity: { "@type": "ItemList", itemListElement: [{ "@type": "ListItem", position: 1, url: showcaseUrl, name: entry.title }] } },
    main: `<h1>${e(L(`${ix}.heading`))}</h1>\n<p>${e(L(`${ix}.intro`))}</p>\n<ul class="posts">\n<li><a href="/projects/research-agent">${e(L(`${ix}.entry.title`))}</a><p>${e(L(`${ix}.entry.summary`))}</p><p>${e(L(`${ix}.entry.stack`))}</p></li>\n</ul>`,
  });
  files["public/projects/index.md"] = [`# ${copy.index.heading}`, "", copy.index.intro, "", `## [${entry.title}](${showcaseUrl}.md)`, "", entry.summary, "", entry.stack, "", "---", "", `Canonical: ${site}projects/`, ""].join("\n");
  page = null;
  return { files, html, uses, reports, listing: { showcase: { url: showcaseUrl, md: `${showcaseUrl}.md`, title: entry.title, description: p.head.showcase.description }, runs: listing } };
}
