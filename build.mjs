// Generates every machine-readable copy of the site from content.json, then checks the result.
//   node build.mjs          validate everything, then write the public/ files that changed
//   node build.mjs --check  write nothing; exit 1 if anything is out of date or a check fails
//
// Generated: the head metadata (title, description, Open Graph, Twitter), the JSON-LD @graph and
// the WebMCP data inside public/index.html, public/index.md, public/llms.txt, public/sitemap.xml,
// public/robots.txt, public/_headers and build-state.json. The visible HTML is hand-written (it is
// the design); the build parses it and fails unless every content.json item appears, as a whole
// visible element, in its own section, and every contact link points at the approved target.
//
// Nothing is written unless every check passes. Writing itself is staged (temporary files, then
// renames) with a best-effort rollback; it is not transactional — see writeStaged().
import { readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { marked } from "marked";
import { agentData } from "./lib/agent-data.mjs";
import { tools as mcpTools } from "./mcp/handler.js";

export const SITE = "https://patrickjv.com/";
const DID_SHA256 = "c713c3b182128838452fdf1cf9f9b9bde71969933573a46a4341b4b42046a25c";
const DISAMBIGUATION = "Patrick Vieira, platform engineer based in London — not the footballer of the same name.";
// A denylist of names this site must never mention. It catches known slips; it cannot detect every
// possible employer, so new copy still needs a human read.
const BANNED = /altimist|the company|fintech|\bceo\b|wimbledon/i;
// The page's WebMCP read tools serve these agentData() keys; the MCP server's tools() supplies
// their names, descriptions and schemas, so the two surfaces cannot drift.
const TOOL_DATA = { get_profile: "profile", list_work: "work", list_skills: "skills", list_faq: "faq" };
const DAY = 864e5;

const sha256 = (s) => createHash("sha256").update(s).digest();

// ---------------------------------------------------------------------------------------------
// Minimal HTML parser: enough to find elements, attributes (any quoting or case), raw <script>/
// <style> text and visible text. Comments and the doctype are dropped.
// ---------------------------------------------------------------------------------------------
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "title", "textarea"]);
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", times: "×", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", middot: "·", copy: "©" };
export const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return NAMED[e.toLowerCase()] ?? m;
});

export function parseHtml(src) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root, i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) { const e = src.indexOf("-->", i + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src[i] === "<" && (src[i + 1] === "!" || src[i + 1] === "?")) { const e = src.indexOf(">", i); i = e < 0 ? src.length : e + 1; continue; }
    if (src[i] === "<" && src[i + 1] === "/" && /[a-z]/i.test(src[i + 2] ?? "")) {
      const m = /^<\/([^\s/>]+)[^>]*>/.exec(src.slice(i, i + 200));
      const tag = m[1].toLowerCase();
      for (let n = cur; n !== root; n = n.parent) if (n.tag === tag) { cur = n.parent; break; }
      i += m[0].length; continue;
    }
    if (src[i] === "<" && /[a-z]/i.test(src[i + 1] ?? "")) {
      let j = i + 1;
      while (j < src.length && !/[\s/>]/.test(src[j])) j++;
      const tag = src.slice(i + 1, j).toLowerCase();
      const attrs = {};
      let selfClosing = false;
      for (;;) {
        while (j < src.length && /[\s/]/.test(src[j])) { selfClosing = src[j] === "/"; j++; }
        if (j >= src.length || src[j] === ">") { j++; break; }
        selfClosing = false;
        const n = /^[^\s"'>\/=]+/.exec(src.slice(j))?.[0] ?? src[j];
        j += n.length;
        while (/\s/.test(src[j] ?? "")) j++;
        let v = "";
        if (src[j] === "=") {
          j++;
          while (/\s/.test(src[j] ?? "")) j++;
          if (src[j] === '"' || src[j] === "'") { const q = src[j], e = src.indexOf(q, j + 1); v = src.slice(j + 1, e < 0 ? src.length : e); j = e < 0 ? src.length : e + 1; }
          else { v = /^[^\s>]*/.exec(src.slice(j))[0]; j += v.length; }
        }
        const name = n.toLowerCase();
        if (!(name in attrs)) attrs[name] = decodeEntities(v); // first occurrence wins, as in browsers
      }
      if (tag === "li" && cur.tag === "li") cur = cur.parent; // optional </li>
      const el = { tag, attrs, children: [], parent: cur };
      cur.children.push(el);
      if (RAW.has(tag)) {
        const close = new RegExp(`</${tag}[\\s/>]`, "ig");
        close.lastIndex = j;
        const m = close.exec(src);
        const end = m ? m.index : src.length;
        el.raw = src.slice(j, end);
        el.children.push({ text: el.raw });
        const gt = src.indexOf(">", end);
        i = m ? (gt < 0 ? src.length : gt + 1) : src.length;
        continue;
      }
      if (!VOID.has(tag) && !selfClosing) cur = el;
      i = j; continue;
    }
    const e = src.indexOf("<", i + 1);
    const k = e < 0 ? src.length : e;
    cur.children.push({ text: src.slice(i, k) });
    i = k;
  }
  return root;
}

const INVISIBLE = new Set(["head", "script", "style", "template", "noscript", "title"]);
const isHidden = (el) => INVISIBLE.has(el.tag) || "hidden" in el.attrs || el.attrs["aria-hidden"] === "true";
const elements = (node, { visible = true } = {}) => {
  const out = [];
  (function walk(n) { for (const c of n.children ?? []) if (c.tag) { if (visible && isHidden(c)) continue; out.push(c); walk(c); } })(node);
  return out;
};
const hasClass = (el, c) => (el.attrs.class ?? "").split(/\s+/).includes(c);
const textOf = (node) => {
  let s = "";
  (function walk(n) { for (const c of n.children ?? []) { if (c.tag) { if (!isHidden(c)) walk(c); } else s += decodeEntities(c.text); } })(node);
  return s.replace(/[\s ]+/g, " ").trim();
};

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

// Inline-code guards for a page served under a hash-based CSP. Returns the inline <style> and
// executable inline <script> bodies (to be hashed) and any errors. JSON-LD is a data block.
export function inlineCode(html, { styles: wantStyles, scripts: wantScripts }) {
  const errors = [];
  const all = elements(parseHtml(html), { visible: false });
  const styles = [], scripts = [];
  for (const el of all) {
    for (const a of Object.keys(el.attrs)) {
      if (a === "style") errors.push(`<${el.tag}> has an inline style attribute; the CSP blocks it — use a class`);
      if (/^on/.test(a)) errors.push(`<${el.tag}> has an inline ${a} handler; the CSP blocks it`);
    }
    if (el.tag === "style") styles.push(el.raw);
    if (el.tag === "link" && /(^|\s)stylesheet(\s|$)/i.test(el.attrs.rel ?? "")) errors.push("external stylesheets are not allowed by the CSP");
    if (el.tag === "script") {
      const type = (el.attrs.type ?? "").trim().toLowerCase();
      if (type === "application/ld+json") continue;
      if (type && !/^(text\/javascript|application\/javascript|module)$/.test(type)) { errors.push(`<script type="${type}"> is neither JavaScript nor JSON-LD`); continue; }
      if ("src" in el.attrs) { errors.push("external scripts are not allowed by the CSP"); continue; }
      scripts.push(el.raw);
    }
  }
  if (styles.length !== wantStyles || scripts.length !== wantScripts)
    errors.push(`expected ${wantStyles} inline <style> and ${wantScripts} inline <script>, found ${styles.length} and ${scripts.length}`);
  return { errors, styles, scripts };
}

// Section-aware check of the hand-written page against content.json. Every item must be the whole
// visible text of its own element in its own section; contact links must hit the approved targets.
// Also fails if any content.json string is not covered by some check (so new fields get one).
// Coverage is tracked by field PATH (e.g. "work.2.tags.1"), not by value, so a new field is
// reported even when its value happens to equal one that is already checked.
export function checkPage(html, c) {
  const errors = [];
  const used = new Set(); // content.json paths that some check below compares with the page
  const doc = parseHtml(html);
  const visible = elements(doc);
  const L = c.person.links;
  const mailto = "mailto:" + L.email;
  const bare = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const LINK_PATHS = (k) => ["person.links.linkedin", "person.links.github", "person.links.email"][k];

  // `path` names the content.json field of each expected item: a base path (the index is appended)
  // or a function of the index.
  const list = (what, actual, expected, path) => {
    expected.forEach((e, k) => used.add(typeof path === "function" ? path(k) : `${path}.${k}`));
    if (actual.length !== expected.length) errors.push(`${what}: expected ${expected.length} item(s), found ${actual.length}`);
    expected.forEach((e, k) => { if (actual[k] !== e) errors.push(`${what}[${k}]: expected "${e}", found ${actual[k] === undefined ? "nothing" : `"${actual[k]}"`}`); });
  };
  const one = (what, actual, expected, path) => list(what, [actual].filter((x) => x !== undefined), [expected], () => path);
  const within = (el, pred) => (el ? elements(el).filter(pred) : []);
  const byTag = (t) => (el) => el.tag === t;
  const byClass = (k) => (el) => hasClass(el, k);
  const texts = (els) => els.map(textOf);
  const hrefs = (el) => within(el, byTag("a")).map((a) => a.attrs.href);
  const section = (id) => {
    const s = visible.find((el) => el.attrs.id === id);
    if (!s) errors.push(`section #${id} is missing or hidden`);
    return s;
  };

  if (elements(doc, { visible: false }).filter(byTag("h1")).length !== 1) errors.push("index.html must have exactly one <h1>");

  // Masthead: name, headline, tagline, location, and the contact buttons and spec links.
  const head = visible.find(byClass("masthead"));
  if (!head) errors.push("masthead is missing or hidden");
  one("h1", texts(within(head, byTag("h1")))[0], c.person.name, "person.name");
  one("headline (.role)", texts(within(head, byClass("role")))[0], c.person.headline, "person.headline");
  one("tagline", texts(within(head, byClass("tagline")))[0], c.person.tagline, "person.tagline");
  list("hero contact links", hrefs(within(head, byClass("actions"))[0]), [L.linkedin, L.github, mailto, CV_PDF], LINK_PATHS);
  const spec = within(head, byClass("spec"))[0];
  list("contact strip links", hrefs(spec), [L.linkedin, L.github, mailto], LINK_PATHS);
  const dd = Object.fromEntries(within(spec, byTag("dt")).map((dt) => {
    const sib = dt.parent.children.filter((n) => n.tag);
    return [textOf(dt), sib[sib.indexOf(dt) + 1]];
  }).filter(([, v]) => v && v.tag === "dd").map(([k, v]) => [k, textOf(v)]));
  one("contact strip Location", dd.Location, c.person.location, "person.location");
  one("contact strip LinkedIn", dd.LinkedIn, bare(L.linkedin), "person.links.linkedin");
  one("contact strip GitHub", dd.GitHub, bare(L.github), "person.links.github");
  one("contact strip Email", dd.Email, L.email, "person.links.email");

  list("About", texts(within(section("about"), byTag("p"))), c.about, "about");

  const readouts = within(section("figures"), byClass("readouts")).flatMap((ul) => within(ul, byTag("li")));
  list("In figures values", readouts.map((li) => texts(within(li, byClass("value")))[0]), c.stats.map((s) => s.value), (k) => `stats.${k}.value`);
  list("In figures labels", readouts.map((li) => texts(within(li, byClass("rlabel")))[0]), c.stats.map((s) => s.label), (k) => `stats.${k}.label`);

  const work = within(section("work"), byTag("article"));
  list("Work titles", work.map((a) => texts(within(a, byTag("h3")))[0]), c.work.map((w) => w.title), (k) => `work.${k}.title`);
  list("Work summaries", work.map((a) => texts(within(a, byTag("p")))[0]), c.work.map((w) => w.summary), (k) => `work.${k}.summary`);
  c.work.forEach((w, k) => list(`Work[${k}] tags`, texts(within(work[k], byClass("tags")).flatMap((ul) => within(ul, byTag("li")))), w.tags, `work.${k}.tags`));

  const side = within(section("side-projects"), byTag("article"));
  list("Side project titles", side.map((a) => texts(within(a, byTag("h3")))[0]), c.side_projects.map((p) => p.title), (k) => `side_projects.${k}.title`);
  list("Side project summaries", side.map((a) => texts(within(a, byTag("p")))[0]), c.side_projects.map((p) => p.summary), (k) => `side_projects.${k}.summary`);

  list("Background", texts(within(section("background"), byTag("p"))), c.background, "background");
  list("Skills", texts(within(section("skills"), byClass("skills")).flatMap((ul) => within(ul, byTag("li")))), c.skills, "skills");

  const faq = within(section("faq"), byClass("faq")).flatMap((f) => f.children.filter((n) => n.tag === "div" && !isHidden(n)));
  list("Quick answers questions", faq.map((q) => texts(within(q, byTag("h3")))[0]), c.faq.map((f) => f.q), (k) => `faq.${k}.q`);
  list("Quick answers answers", faq.map((q) => texts(within(q, byTag("p")))[0]), c.faq.map((f) => f.a), (k) => `faq.${k}.a`);

  const footer = visible.find(byTag("footer"));
  list("footer links", hrefs(footer), [L.linkedin, L.github, PRIVACY_PATH], (k) => (k < 2 ? LINK_PATHS(k) : "privacy_link"));
  const privacyLine = within(footer, byClass("privacy"))[0];
  one("footer privacy note", privacyLine && textOf(privacyLine), `${c.privacy} ${c.privacy_link}`, "privacy");
  list("footer privacy link", texts(within(privacyLine, (el) => el.tag === "a" && el.attrs.href === PRIVACY_PATH)), [c.privacy_link], () => "privacy_link");

  // Every link to a contact channel anywhere on the page must use the exact approved target.
  for (const a of elements(doc, { visible: false }).filter(byTag("a"))) {
    const h = a.attrs.href ?? "";
    if (/^mailto:/i.test(h) && h !== mailto) errors.push(`mailto link points at ${h}, expected ${mailto}`);
    if (/linkedin\.com/i.test(h) && h !== L.linkedin) errors.push(`LinkedIn link points at ${h}, expected ${L.linkedin}`);
    if (/github\.com/i.test(h) && h !== L.github) errors.push(`GitHub link points at ${h}, expected ${L.github}`);
  }

  const unchecked = [];
  (function walk(o, path) {
    if (path.split(".").at(-1) === "_status") return;
    if (path === "pages") return; // copy for pages the build generates (/privacy, /book), not the hand-written page
    if (typeof o === "string") { if (!used.has(path)) unchecked.push(`${path}: ${o.slice(0, 80)}`); }
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  })(c, "");
  if (unchecked.length) errors.push("content.json field(s) not checked against the page (add a check in checkPage):\n  - " + unchecked.join("\n  - "));
  return errors;
}

// security.txt (RFC 9116): Expires must be a real date, more than 30 days and at most ~1 year ahead.
export function checkSecurityTxt(text, now) {
  const raw = text.match(/^Expires:[ \t]*(.+?)[ \t]*$/m)?.[1];
  if (!raw) return ["public/.well-known/security.txt has no Expires field"];
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return [`public/.well-known/security.txt Expires "${raw}" is not a valid date`];
  const days = (t - now) / DAY;
  if (days <= 30) return [`public/.well-known/security.txt expires ${raw} (in ${Math.floor(days)} days): bump Expires to within one year from now`];
  if (days > 366) return [`public/.well-known/security.txt expires ${raw}, more than a year ahead (RFC 9116 recommends less than a year)`];
  return [];
}

// JSON for splicing into a <script> element: "<" is escaped so the data can never close the element
// (e.g. a literal "</script>" in the copy), and U+2028/U+2029 so the JS stays one valid line.
export const safeJson = (v, indent) => JSON.stringify(v, null, indent).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Replace exactly one match of re in html, or throw.
function splice(html, re, replacement, what, file = "index.html") {
  const n = (html.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || []).length;
  if (n !== 1) throw new Error(`${what}: expected 1 match in ${file}, found ${n}`);
  return html.replace(re, replacement);
}
const setMeta = (html, kind, key, value) =>
  splice(html, new RegExp(`<meta ${kind}="${escRe(key)}" content="[^"]*">`), () => `<meta ${kind}="${key}" content="${attr(value)}">`, `<meta ${kind}="${key}">`);

const cspHash = (s) => "'sha256-" + sha256(Buffer.from(s, "utf8")).toString("base64") + "'";

// The _headers guard. Workers static assets apply EVERY matching rule and do not honour "! Header"
// detach lines, so: no detach lines; no Content-Security-Policy on "/*"; and every CSP rule is an
// exact path (no "*" or ":placeholder"), set once — then no path, not even a missing one that
// falls through to 404.html, can receive a CSP from two rules or from a wildcard.
export function checkHeaders(headers) {
  const errors = [];
  const blocks = headers.split(/\n(?=\S)/).filter((blk) => !/^\s*#/.test(blk));
  const cspRules = blocks.filter((blk) => /^\s+Content-Security-Policy:/m.test(blk)).map((blk) => blk.split("\n")[0].trim());
  if (/^\s*!/m.test(headers)) errors.push("_headers must not use \"! Header\" detach lines (not honoured in production)");
  if (cspRules.includes("/*")) errors.push("_headers must not set Content-Security-Policy on /* (it would combine with per-path policies)");
  const wild = cspRules.filter((r) => r !== "/*" && /[*:]/.test(r));
  if (wild.length) errors.push(`_headers sets Content-Security-Policy on a wildcard rule (${wild.join(", ")}); use exact paths so a missing file gets only the 404 page's policy`);
  if (new Set(cspRules).size !== cspRules.length) errors.push("_headers sets Content-Security-Policy twice for one path pattern");
  return errors;
}

// ---------------------------------------------------------------------------------------------
// The CV (/cv, and cv.pdf printed from it by `npm run cv`): A4, at most two pages. Its content is
// cv.json; name, location and links come from content.json. The CV names employers, so it is the
// one output outside the BANNED employer guard — nothing on the page or agent surfaces repeats it.
// ---------------------------------------------------------------------------------------------
export const CV_PDF = "/cv.pdf";
export function renderCv(cv, c) {
  const e = attr;
  const L = c.person.links;
  const bare = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const city = c.person.location.split(",")[0].trim();
  const contact = [[`mailto:${L.email}`, L.email], [SITE, bare(SITE)], [L.linkedin, bare(L.linkedin)], [L.github, bare(L.github)]]
    .map(([h, t]) => `<a href="${e(h)}">${e(t)}</a>`).join(" · ");
  const role = (r) => `    <article>
      <div class="row"><h3>${e(r.title)}<span class="org">, ${e(r.org)}</span></h3><span class="dates">${e(r.dates)}</span></div>
      <ul>
${r.bullets.map((b) => `        <li>${e(b)}</li>`).join("\n")}
      </ul>
    </article>`;
  const style = `
@font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 400 600; font-display: swap; src: url(/fonts/ibm-plex-sans-latin-var.woff2) format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 400; font-display: swap; src: url(/fonts/ibm-plex-mono-latin-400.woff2) format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 500; font-display: swap; src: url(/fonts/ibm-plex-mono-latin-500.woff2) format("woff2"); }
:root { --ink: #14171c; --muted: #535b66; --line: #d9d7cf; --signal: #a64b00; --sans: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace; }
html { background: #e9e7e0; }
body { margin: 0; font-family: var(--sans); color: var(--ink); font-size: 10pt; line-height: 1.42; }
a { color: inherit; }
.bar { box-sizing: border-box; max-width: 210mm; margin: 16px auto 0; padding: 0 4px; display: flex; justify-content: space-between; gap: 16px; font-family: var(--mono); font-size: 13px; }
.bar a { color: var(--signal); }
.sheet { box-sizing: border-box; max-width: 210mm; margin: 12px auto 32px; padding: 15mm 16mm; background: #fff; box-shadow: 0 1px 3px rgba(20, 23, 28, 0.15); }
h1 { margin: 0; font-size: 24pt; font-weight: 600; line-height: 1.1; letter-spacing: -0.01em; }
.role { margin: 3px 0 0; font-family: var(--mono); font-size: 10.5pt; color: var(--signal); }
.contact { margin: 6px 0 0; font-family: var(--mono); font-size: 8.5pt; color: var(--muted); }
.contact a { text-decoration: none; }
h2 { margin: 13px 0 6px; padding-bottom: 3px; border-bottom: 1px solid var(--line); font-family: var(--mono); font-size: 8.5pt; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: var(--signal); break-after: avoid; }
h3 { margin: 0; font-size: 10.5pt; font-weight: 600; break-after: avoid; }
.org { font-weight: 400; }
.row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.dates { font-family: var(--mono); font-size: 8.5pt; color: var(--muted); white-space: nowrap; }
article { margin: 0 0 8px; }
ul { margin: 3px 0 0; padding-left: 1.1em; }
li { margin: 2px 0; break-inside: avoid; }
p { margin: 0; }
.earlier { margin-top: 4px; font-size: 9pt; color: var(--muted); }
dl { display: grid; grid-template-columns: 40mm 1fr; gap: 3px 10px; margin: 0; break-inside: avoid; }
dt { font-weight: 600; }
dd { margin: 0; }
.edu { display: flex; flex-direction: column; gap: 3px; }
@page { size: A4; margin: 14mm 15mm; }
@media print {
  html { background: #fff; }
  .bar { display: none; }
  .sheet { max-width: none; margin: 0; padding: 0; box-shadow: none; }
  a { text-decoration: none; }
}
@media (max-width: 640px) {
  .sheet { padding: 20px 16px; }
  .row { flex-direction: column; gap: 0; }
  dl { grid-template-columns: 1fr; }
}
`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(c.person.name)} — CV</title>
<meta name="description" content="${e(`CV of ${c.person.name}, ${cv.headline}, ${city}.`)}">
<link rel="canonical" href="${SITE}cv">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${style}</style>
</head>
<body>
<nav class="bar" aria-label="CV"><a href="/">← ${e(bare(SITE))}</a><a href="${CV_PDF}" download="Patrick-Vieira-CV.pdf">Download PDF</a></nav>
<main class="sheet">
  <header>
    <h1>${e(c.person.name)}</h1>
    <p class="role">${e(cv.headline)} · ${e(city)}</p>
    <p class="contact">${contact}</p>
  </header>
  <section>
    <h2>Profile</h2>
    <p>${e(cv.profile)}</p>
  </section>
  <section>
    <h2>Experience</h2>
${cv.experience.map(role).join("\n")}
    <p class="earlier">${e(cv.earlier)}</p>
  </section>
  <section>
    <h2>Selected personal projects</h2>
    <ul>
${cv.projects.map((x) => `      <li><b>${e(x.title)}</b>: ${e(x.text)}</li>`).join("\n")}
    </ul>
  </section>
  <section>
    <h2>Skills</h2>
    <dl>
${cv.skills.map((x) => `      <dt>${e(x.group)}</dt><dd>${e(x.items)}</dd>`).join("\n")}
    </dl>
  </section>
  <section>
    <h2>Education</h2>
    <div class="edu">
${cv.education.map((x) => `      <div class="row"><h3>${e(x.qual)}<span class="org">, ${e(x.org)}</span></h3><span class="dates">${e(x.dates)}</span></div>`).join("\n")}
    </div>
  </section>
  <section>
    <h2>Spoken languages</h2>
    <p>${e(cv.spoken)}</p>
  </section>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// Writing (/writing/): one Markdown file per post in writing/, with title, description and date in
// a front-matter block. Each post is served as HTML at /writing/<slug> and as its Markdown source at
// /writing/<slug>.md, listed on /writing/, in the sitemap, llms.txt and index.md. Posts are
// employer-agnostic like the page (the BANNED guard covers them).
// ---------------------------------------------------------------------------------------------
export function parsePost(slug, src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!m) throw new Error(`writing/${slug}.md: missing front matter`);
  const meta = Object.fromEntries(m[1].split("\n").map((l) => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.trim()]));
  for (const k of ["title", "description", "date"]) if (!meta[k]) throw new Error(`writing/${slug}.md: front matter needs ${k}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) throw new Error(`writing/${slug}.md: date must be YYYY-MM-DD`);
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`writing/${slug}.md: slug must be lower-case letters, digits and hyphens`);
  return { slug, ...meta, body: m[2] };
}

const WRITING_STYLE = `
@font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 400 600; font-display: swap; src: url(/fonts/ibm-plex-sans-latin-var.woff2) format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 400; font-display: swap; src: url(/fonts/ibm-plex-mono-latin-400.woff2) format("woff2"); }
:root { --bg: #f4f3ee; --ink: #14171c; --muted: #535b66; --line: #d9d7cf; --signal: #a64b00; --code: #e9e7e0; --sans: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace; }
@media (prefers-color-scheme: dark) { :root { --bg: #0c0e11; --ink: #e7e9ec; --muted: #9aa3ae; --line: #262b33; --signal: #ffb547; --code: #1a1e24; } }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 1.0625rem; line-height: 1.65; }
.wrap { box-sizing: border-box; max-width: 44rem; margin: 0 auto; padding: 24px 16px 64px; }
.bar { display: flex; justify-content: space-between; gap: 16px; font-family: var(--mono); font-size: 0.875rem; margin-bottom: 40px; }
a { color: var(--signal); }
h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 8px; font-weight: 600; letter-spacing: -0.01em; }
h2 { font-size: 1.25rem; margin: 2em 0 0.5em; font-weight: 600; }
.meta { font-family: var(--mono); font-size: 0.875rem; color: var(--muted); margin: 0 0 32px; }
code { font-family: var(--mono); font-size: 0.9em; background: var(--code); padding: 0.1em 0.3em; border-radius: 3px; }
pre { background: var(--code); padding: 12px 16px; overflow-x: auto; border-radius: 4px; }
pre code { padding: 0; background: none; }
li { margin: 0.35em 0; }
.posts { list-style: none; padding: 0; }
.posts li { margin: 0 0 28px; }
.posts a { font-size: 1.2rem; font-weight: 600; }
.posts p { margin: 4px 0 0; color: var(--muted); }
footer { margin-top: 56px; padding-top: 16px; border-top: 1px solid var(--line); font-family: var(--mono); font-size: 0.875rem; color: var(--muted); }
`;

function writingPage({ title, description, canonical, alternate, jsonld, main }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${attr(title)}</title>
<meta name="description" content="${attr(description)}">
<link rel="canonical" href="${canonical}">
${alternate ? `<link rel="alternate" type="text/markdown" href="${alternate}">\n` : ""}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="article">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}og-card.jpg">
<script type="application/ld+json">
${safeJson(jsonld, 2)}
</script>
<style>${WRITING_STYLE}</style>
</head>
<body>
<div class="wrap">
<nav class="bar" aria-label="Site"><a href="/">← patrickjv.com</a><a href="/writing/">Writing</a></nav>
<main>
${main}
</main>
<footer>Patrick Vieira · <a href="/">patrickjv.com</a> · <a href="/cv">CV</a> · <a href="${PRIVACY_PATH}">Privacy</a></footer>
</div>
</body>
</html>
`;
}

export function renderWriting(posts) {
  const sorted = [...posts].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug.localeCompare(b.slug)));
  const author = { "@id": SITE + "#person" };
  const files = {};
  for (const p of sorted) {
    const url = `${SITE}writing/${p.slug}`;
    const md = `${p.body.trimEnd()}\n\n---\n\nPatrick Vieira, ${p.date}. Canonical: ${url}\n`;
    files[`public/writing/${p.slug}.md`] = md;
    files[`public/writing/${p.slug}.html`] = writingPage({
      title: `${p.title} — Patrick Vieira`, description: p.description, canonical: url, alternate: `/writing/${p.slug}.md`,
      jsonld: { "@context": "https://schema.org", "@type": "BlogPosting", headline: p.title, description: p.description, datePublished: `${p.date}T00:00:00Z`, inLanguage: "en-GB", url, author: { "@type": "Person", ...author, name: "Patrick Vieira", url: SITE } },
      main: `<article>\n<p class="meta">${attr(p.date)}</p>\n${marked.parse(p.body)}</article>`,
    });
  }
  files["public/writing/index.html"] = writingPage({
    title: "Writing — Patrick Vieira", description: "Short engineering write-ups by Patrick Vieira on platform engineering, AI-assisted delivery and reliability.", canonical: `${SITE}writing/`,
    jsonld: { "@context": "https://schema.org", "@type": "Blog", name: "Writing — Patrick Vieira", url: `${SITE}writing/`, inLanguage: "en-GB", author: { "@type": "Person", ...author, name: "Patrick Vieira", url: SITE } },
    main: `<h1>Writing</h1>\n<ul class="posts">\n${sorted.map((p) => `<li><a href="/writing/${p.slug}">${attr(p.title)}</a><p>${attr(p.date)} · ${attr(p.description)}</p></li>`).join("\n")}\n</ul>`,
  });
  return { files, sorted };
}

// ---------------------------------------------------------------------------------------------
// Standalone pages (/privacy, /book): copy from content.json "pages", same look as /writing/.
// ---------------------------------------------------------------------------------------------
export const PRIVACY_PATH = "/privacy";

function sitePage({ title, description, path, noindex = false, style = WRITING_STYLE, main, script }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${attr(title)}</title>
<meta name="description" content="${attr(description)}">
${noindex ? '<meta name="robots" content="noindex">\n' : ""}<link rel="canonical" href="${SITE}${path.slice(1)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${style}</style>
</head>
<body>
<div class="wrap">
<nav class="bar" aria-label="Site"><a href="/">← patrickjv.com</a></nav>
<main>
${main}
</main>
<footer>Patrick Vieira · <a href="/">patrickjv.com</a> · <a href="/cv">CV</a> · <a href="${PRIVACY_PATH}">Privacy</a></footer>
</div>
${script ? `<script>${script}</script>\n` : ""}</body>
</html>
`;
}

// Plain text with the contact address made a mailto link.
const linkEmail = (text, email) => attr(text).split(attr(email)).join(`<a href="mailto:${attr(email)}">${attr(email)}</a>`);

export function renderPrivacy(c) {
  const p = c.pages.privacy, email = c.person.links.email;
  const para = (t) => `<p>${linkEmail(t, email)}</p>`;
  const sections = p.sections.map((s) => [
    `<h2>${attr(s.heading)}</h2>`,
    ...(s.paragraphs ?? []).map(para),
    ...(s.items ? [`<ul>\n${s.items.map((i) => `<li>${linkEmail(i, email)}</li>`).join("\n")}\n</ul>`] : []),
  ].join("\n")).join("\n");
  return sitePage({
    title: `${p.title} — ${c.person.name}`, description: p.description, path: PRIVACY_PATH,
    main: `<h1>${attr(p.title)}</h1>\n<p class="meta">Last updated ${attr(p.updated)}</p>\n${p.intro.map(para).join("\n")}\n${sections}`,
  });
}

// ---------------------------------------------------------------------------------------------
// Rendering: every generated file, as a function of the content and the dateModified value.
// ---------------------------------------------------------------------------------------------
function render(c, cv, posts, html0, html404, imageFiles, fontFiles, date) {
  const writing = renderWriting(posts);
  const city = c.person.location.split(",")[0].trim();
  const title = `${c.person.name} — ${c.person.headline}, ${city}`;

  // ---- JSON-LD ----
  const id = (frag) => ({ "@id": SITE + "#" + frag });
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ProfilePage", "@id": SITE + "#profilepage", url: SITE,
        // Google's ProfilePage wants a full ISO 8601 DateTime ("Invalid datetime value" for a bare date);
        // the build tracks the day the content changed, so that day at midnight UTC.
        name: `${c.person.name} — ${c.person.headline}`, inLanguage: "en-GB", dateModified: `${date}T00:00:00Z`,
        mainEntity: id("person"), isPartOf: id("website"), hasPart: id("faq"),
      },
      { "@type": "WebSite", "@id": SITE + "#website", url: SITE, name: c.person.name, inLanguage: "en-GB" },
      {
        "@type": "Person", "@id": SITE + "#person", name: c.person.name,
        identifier: "did:web:patrickjv.com",
        alternateName: ["patrickjv", "PatrickJV"],
        disambiguatingDescription: DISAMBIGUATION,
        jobTitle: c.person.headline,
        hasOccupation: { "@type": "Occupation", name: c.person.headline, occupationLocation: { "@type": "City", name: city } },
        description: c.person.tagline, url: SITE, image: SITE + "photo.webp",
        address: { "@type": "PostalAddress", addressLocality: city, addressCountry: "GB" },
        alumniOf: { "@type": "CollegeOrUniversity", name: "UCL" },
        sameAs: [c.person.links.linkedin, c.person.links.github],
        email: "mailto:" + c.person.links.email,
        knowsAbout: c.skills,
      },
      {
        "@type": "FAQPage", "@id": SITE + "#faq", url: SITE + "#faq", name: "Quick answers", inLanguage: "en-GB",
        isPartOf: id("website"), about: id("person"),
        mainEntity: c.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
      },
    ],
  };

  // ---- WebMCP data ---- Names, titles, descriptions and schemas come from the MCP server's own
  // tools(), so the page and the server describe the same tools in the same words.
  const data = agentData(c);
  const webTools = mcpTools().map((t) => {
    const out = { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !!t.annotations?.readOnlyHint } };
    if (TOOL_DATA[t.name]) out.data = TOOL_DATA[t.name];
    else if (t.name === "request_intro") out.description += " In this browser, the person is also asked to confirm the exact message before anything is sent.";
    else throw new Error(`MCP tool ${t.name} has no WebMCP counterpart: add it to TOOL_DATA or the page script`);
    if (out.data && !out.annotations.readOnlyHint) throw new Error(`MCP tool ${t.name} serves page data but is not readOnlyHint`);
    return out;
  });
  const webmcp = { ...data, tools: webTools };

  // ---- index.html: head metadata, JSON-LD and WebMCP data spliced into the hand-written page ----
  let html = html0;
  html = splice(html, /<title>[^<]*<\/title>/, () => `<title>${attr(title)}</title>`, "<title>");
  html = setMeta(html, "name", "description", c.person.tagline);
  html = splice(html, /<link rel="canonical" href="[^"]*">/, () => `<link rel="canonical" href="${SITE}">`, "canonical link");
  html = setMeta(html, "property", "og:title", title);
  html = setMeta(html, "property", "og:description", c.person.tagline);
  html = setMeta(html, "property", "og:url", SITE);
  html = setMeta(html, "property", "og:site_name", c.person.name);
  html = setMeta(html, "property", "og:image:alt", title);
  html = setMeta(html, "name", "twitter:title", title);
  html = setMeta(html, "name", "twitter:description", c.person.tagline);
  const ldIndent = html0.match(/^([ \t]*)<script type="application\/ld\+json">/m)?.[1] ?? "";
  html = splice(html, /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    () => `<script type="application/ld+json">\n${safeJson(jsonld, 2)}\n${ldIndent}</script>`, "JSON-LD block");
  html = splice(html, /var d = \{.*\};/, () => `var d = ${safeJson(webmcp)};`, "WebMCP data");

  // ---- index.md ----
  const links = [`- [Email](mailto:${c.person.links.email}): ${c.person.links.email}`, `- [LinkedIn](${c.person.links.linkedin})`, `- [GitHub](${c.person.links.github})`, `- [CV](${SITE}cv): two-page CV, also as [PDF](${SITE}${CV_PDF.slice(1)})`, `- [Privacy](${SITE}privacy): what this site stores about you, for how long, and who processes it`, "", c.privacy, ""];
  const md = [
    `# ${c.person.name}`, "",
    `Platform engineer in London (not the footballer of the same name). Canonical page: ${SITE}`, "",
    `**${c.person.headline}** · ${c.person.location}`, "",
    `> ${c.person.tagline}`, "",
    "## About", "", ...c.about.flatMap((p) => [p, ""]),
    "## In figures", "", ...c.stats.map((s) => `- **${s.value}** — ${s.label}`), "",
    "## Work", "", ...c.work.flatMap((w) => [`### ${w.title}`, "", w.summary, "", `Tags: ${w.tags.join(" · ")}`, ""]),
    "## Side projects", "", ...c.side_projects.flatMap((p) => [`### ${p.title}`, "", p.summary, ""]),
    "## Background", "", ...c.background.flatMap((p) => [p, ""]),
    "## Skills", "", ...c.skills.map((s) => `- ${s}`), "",
    "## Quick answers", "", ...c.faq.flatMap((f) => [`### ${f.q}`, "", f.a, ""]),
    "## Writing", "", ...writing.sorted.map((p) => `- [${p.title}](${SITE}writing/${p.slug}.md) (${p.date}): ${p.description}`), "",
    "## Links", "", ...links,
  ].join("\n");

  // ---- llms.txt ----
  const llms = [
    `# ${c.person.name}`, "",
    `> ${c.person.headline}, ${c.person.location}. ${c.person.tagline}`, "",
    `Platform engineer in London (not the footballer of the same name). Canonical page: ${SITE}`, "",
    ...c.about.flatMap((p) => [p, ""]),
    "## Selected work", "", ...c.work.map((w) => `- **${w.title}**: ${w.summary}`), "",
    "## Side projects", "", ...c.side_projects.map((p) => `- **${p.title}**: ${p.summary}`), "",
    "## Background", "", ...c.background.flatMap((p) => [p, ""]),
    "## Quick answers", "", ...c.faq.map((f) => `- **${f.q}**: ${f.a}`), "",
    "## Writing", "", ...writing.sorted.map((p) => `- [${p.title}](${SITE}writing/${p.slug}.md): ${p.description}`), "",
    "## Links", "", ...links,
    "## Machine-readable", "",
    `- [Markdown version of this page](${SITE}index.md): the full profile as clean Markdown`,
    `- [Sitemap](${SITE}sitemap.xml)`,
    `- [MCP server](${SITE}mcp): remote MCP (Streamable HTTP, POST, JSON responses, no auth). Read-only tools get_profile, list_work, list_skills, list_faq; request_intro emails Patrick (rate-limited, a couple per sender per day)`, "",
  ].join("\n");

  // ---- sitemap.xml ----
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}</loc><lastmod>${date}</lastmod></url>
  <url><loc>${SITE}cv</loc><lastmod>${date}</lastmod></url>
  <url><loc>${SITE}writing/</loc><lastmod>${date}</lastmod></url>
  <url><loc>${SITE}privacy</loc><lastmod>${date}</lastmod></url>
${writing.sorted.map((p) => `  <url><loc>${SITE}writing/${p.slug}</loc><lastmod>${p.date}</lastmod></url>`).join("\n")}
</urlset>
`;

  // ---- robots.txt ---- Content Signals: https://contentsignals.org/
  const robots = `# Content signals: search = building a search index and showing links/snippets;
# ai-input = using content as input to AI answers (retrieval, grounding);
# ai-train = training or fine-tuning AI models. All are permitted for this site.
User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=yes
Allow: /

Sitemap: ${SITE}sitemap.xml
`;

  // ---- _headers ----
  const page = inlineCode(html, { styles: 1, scripts: 1 });
  const cvHtml = renderCv(cv, c);
  const cvPage = inlineCode(cvHtml, { styles: 1, scripts: 0 });
  const writingPages = Object.entries(writing.files).filter(([f]) => f.endsWith(".html"));
  const writingCsp = Object.fromEntries(writingPages.map(([f, h]) => {
    const ic = inlineCode(h, { styles: 1, scripts: 0 });
    return [f, { errors: ic.errors.map((e) => `${f.slice(7)}: ${e}`), csp: ["default-src 'none'", "img-src 'self'", "font-src 'self'", `style-src ${ic.styles.map(cspHash).join(" ")}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "upgrade-insecure-requests"].join("; ") }];
  }));
  const writingRules = writingPages.map(([f]) => {
    const csp = writingCsp[f].csp, path = "/" + f.slice("public/".length);
    const clean = path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path.slice(0, -".html".length);
    return `${clean}\n  Content-Security-Policy: ${csp}\n\n${path}\n  Content-Security-Policy: ${csp}`;
  }).join("\n\n");
  const writingMd = () => writing.sorted.map((p) => `/writing/${p.slug}.md\n  Content-Type: text/markdown; charset=utf-8\n  Content-Security-Policy: ${baseCsp}`).join("\n\n");
  const cvCsp = [
    "default-src 'none'", "img-src 'self'", "font-src 'self'", `style-src ${cvPage.styles.map(cspHash).join(" ")}`,
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "upgrade-insecure-requests",
  ].join("; ");
  const privacyHtml = renderPrivacy(c);
  const privacyPage = inlineCode(privacyHtml, { styles: 1, scripts: 0 });
  const privacyCsp = [
    "default-src 'none'", "img-src 'self'", "font-src 'self'", `style-src ${privacyPage.styles.map(cspHash).join(" ")}`,
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "upgrade-insecure-requests",
  ].join("; ");
  const nf = inlineCode(html404, { styles: 1, scripts: 0 });
  const csp = [
    "default-src 'none'", "img-src 'self'", "font-src 'self'", `style-src ${page.styles.map(cspHash).join(" ")}`,
    `script-src ${page.scripts.map(cspHash).join(" ")}`, "connect-src 'self'", "base-uri 'none'", "form-action 'none'",
    "frame-ancestors 'none'", "upgrade-insecure-requests",
  ].join("; ");
  // Production lesson (6 Oct 2026): Workers static-asset _headers does NOT honour "! Header"
  // detach lines — a CSP set on "/*" and again on "/" reached browsers as TWO policies, and the
  // stricter one blocked the page's style and script. So no path ever gets a CSP from two rules:
  // "/*" carries no CSP; each known non-HTML path gets the baseline explicitly; the 404 page
  // (served at arbitrary paths) carries its own policy in a <meta http-equiv> tag instead.
  const baseCsp = ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");
  const notFoundCsp = [
    "default-src 'none'", "img-src 'self'", "font-src 'self'", `style-src ${nf.styles.map(cspHash).join(" ")}`,
    "base-uri 'none'", "form-action 'none'",
  ].join("; ");
  const types = [
    ["/index.md", "text/markdown; charset=utf-8"], ["/llms.txt", "text/plain; charset=utf-8"], ["/robots.txt", "text/plain; charset=utf-8"],
    ["/sitemap.xml", "application/xml; charset=utf-8"], ["/.well-known/security.txt", "text/plain; charset=utf-8"],
    ["/.well-known/mcp-registry-auth", "text/plain; charset=utf-8"],
  ];
  const headers = `# Generated by build.mjs — do not edit by hand.
# A header set by several matching rules is joined (or duplicated) — and "! Header" detach lines
# are NOT honoured in production — so each Content-Security-Policy is set by exactly one rule.
# Content-Type and Cache-Control set here replace the asset server's defaults.
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
  X-Frame-Options: DENY

# The page: "/" is negotiated (HTML, or Markdown for Accept: text/markdown), hence Vary.
/
  Content-Security-Policy: ${csp}
  Vary: Accept

/index.html
  Content-Security-Policy: ${csp}

# The CV: served at /cv (and /cv.html, which the asset server redirects to /cv). It names employers;
# the page and agent surfaces do not.
/cv
  Content-Security-Policy: ${cvCsp}

/cv.html
  Content-Security-Policy: ${cvCsp}

# Privacy: served at /privacy (and /privacy.html, which the asset server redirects to /privacy).
${PRIVACY_PATH}
  Content-Security-Policy: ${privacyCsp}

${PRIVACY_PATH}.html
  Content-Security-Policy: ${privacyCsp}

# Writing: each post as HTML (at /writing/<slug>, and its .html name) and as its Markdown source.
${writingRules}

${writingMd()}

${CV_PDF}
  Content-Type: application/pdf
  Cache-Control: public, max-age=3600
  Content-Security-Policy: ${baseCsp}

${types.map(([p, t]) => `${p}\n  Content-Type: ${t}\n  Content-Security-Policy: ${baseCsp}${p === "/index.md" ? "\n  Vary: Accept" : ""}`).join("\n\n")}

/.well-known/did.json
  Content-Security-Policy: ${baseCsp}

# Fonts keep their names (no fingerprint), so they are not "immutable": 30 days, then revalidated
# by ETag. A changed font should get a new file name. Images change rarely and are small: one day.
# One exact rule per file (no "/fonts/*"): a missing path must get only the 404 page's own policy.
${fontFiles.map((f) => `/fonts/${f}\n  Cache-Control: public, max-age=2592000\n  Content-Security-Policy: ${baseCsp}`).join("\n\n")}

${imageFiles.map((f) => `/${f}\n  Cache-Control: public, max-age=86400\n  Content-Security-Policy: ${baseCsp}`).join("\n\n")}
`;
  const headerErrors = checkHeaders(headers);
  // The 404 page's own policy, as a <meta> tag the build keeps in sync with its inline style.
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${notFoundCsp}">`;
  const html404Out = /<meta http-equiv="Content-Security-Policy"[^>]*>/.test(html404)
    ? html404.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, cspMeta)
    : html404.replace(/<meta charset="utf-8">/, `<meta charset="utf-8">\n${cspMeta}`);

  return {
    files: { "public/_headers": headers, "public/404.html": html404Out, "public/index.html": html, "public/index.md": md, "public/llms.txt": llms, "public/sitemap.xml": sitemap, "public/robots.txt": robots, "public/cv.html": cvHtml, "public/privacy.html": privacyHtml, ...writing.files },
    inlineErrors: [...page.errors, ...nf.errors.map((e) => "404.html: " + e), ...cvPage.errors.map((e) => "cv.html: " + e), ...privacyPage.errors.map((e) => "privacy.html: " + e), ...Object.values(writingCsp).flatMap((w) => w.errors), ...headerErrors],
    md, llms,
  };
}

// ---------------------------------------------------------------------------------------------
// The build. dateModified is content-addressed: build-state.json records the hash of the
// content-bearing outputs (rendered with a placeholder date) plus the sha256 of every image the page
// references, and the date that hash was first built. The date moves only when the content changes,
// so a rebuild converges in one run and --check never depends on git or the clock. Not content, so
// left out: _headers, the 404 page, fonts, security.txt, mcp-registry-auth and did.json (frozen,
// with its own hash check).
// ---------------------------------------------------------------------------------------------
const CONTENT_OUTPUTS = ["public/index.html", "public/index.md", "public/llms.txt", "public/sitemap.xml", "public/robots.txt", "public/cv.html", "public/privacy.html"];

// Write `files` (name -> text) under `root`: every file to "<name>.tmp" first, then rename each
// over the original. This is NOT transactional: a failure part-way through the renames leaves some
// outputs new and some old. On any failure it removes the temporary files and restores the files
// it had already replaced (from `previous`, name -> old text or null if absent), then rethrows with
// `rolledBack` (true if every restore succeeded). `io` exists so tests can inject failures.
export function writeStaged(root, files, previous, io = { writeFileSync, renameSync, unlinkSync }) {
  const p = (f) => join(root, f);
  const staged = [], replaced = [];
  try {
    for (const f of Object.keys(files)) { io.writeFileSync(p(f) + ".tmp", files[f]); staged.push(f); }
    for (const f of Object.keys(files)) { io.renameSync(p(f) + ".tmp", p(f)); replaced.push(f); }
  } catch (e) {
    let rolledBack = true;
    for (const f of staged.filter((f) => !replaced.includes(f))) { try { io.unlinkSync(p(f) + ".tmp"); } catch { rolledBack = false; } }
    for (const f of replaced) {
      try { if (previous[f] === null) io.unlinkSync(p(f)); else io.writeFileSync(p(f), previous[f]); } catch { rolledBack = false; }
    }
    throw Object.assign(e, { writePhase: true, rolledBack });
  }
}

export function build({ root = process.cwd(), check = false, today = new Date().toISOString().slice(0, 10), now = Date.now(), io } = {}) {
  const p = (f) => join(root, f);
  const read = (f) => readFileSync(p(f), "utf8");
  const readOr = (f) => { try { return read(f); } catch { return null; } };
  const errors = [];

  const c = JSON.parse(read("content.json"));
  const cv = JSON.parse(read("cv.json"));
  const posts = readdirSync(p("writing")).filter((f) => f.endsWith(".md")).sort().map((f) => parsePost(f.slice(0, -3), read(`writing/${f}`)));
  const html0 = read("public/index.html");
  const html404 = read("public/404.html");
  const imageFiles = readdirSync(p("public")).filter((f) => /\.(webp|jpe?g|png|ico|svg|avif|gif)$/i.test(f)).sort();
  const fontFiles = readdirSync(p("public/fonts")).filter((f) => !f.startsWith(".")).sort();
  const probe = render(c, cv, posts, html0, html404, imageFiles, fontFiles, "0000-00-00").files;
  // Images the page references by path (src, srcset, icons, og:image / twitter:image).
  const referenced = imageFiles.filter((f) => new RegExp(`["\\s,]/${escRe(f)}[\\s",]|patrickjv\\.com/${escRe(f)}"`).test(probe["public/index.html"]));
  const assetDigests = referenced.map((f) => [f, sha256(readFileSync(p(`public/${f}`))).toString("hex")]);
  const outputs = [...CONTENT_OUTPUTS, ...Object.keys(probe).filter((f) => f.startsWith("public/writing/")).sort()].map((f) => [f, probe[f]]);
  const hash = sha256(JSON.stringify({ outputs, assets: assetDigests })).toString("hex");
  let state = null;
  try { state = JSON.parse(readOr("build-state.json") ?? "null"); } catch { state = null; }
  let date;
  if (state?.hash === hash && /^\d{4}-\d{2}-\d{2}$/.test(state.date ?? "")) date = state.date;
  else if (check) { errors.push("build-state.json does not match the generated output (run npm run build)"); date = state?.date ?? today; }
  else date = today;

  const { files, inlineErrors, md, llms } = render(c, cv, posts, html0, html404, imageFiles, fontFiles, date);
  files["build-state.json"] = JSON.stringify({ hash, date }, null, 2) + "\n";

  // ---- checks (all before any write) ----
  errors.push(...inlineErrors);
  errors.push(...checkPage(files["public/index.html"], c).map((e) => "index.html: " + e));
  const writingOut = Object.entries(files).filter(([f]) => f.startsWith("public/writing/")).map(([f, t]) => [f.slice(7), t]);
  for (const [f, t] of [["index.html", files["public/index.html"]], ["404.html", html404], ["index.md", md], ["llms.txt", llms], ["privacy.html", files["public/privacy.html"]], ...writingOut]) if (BANNED.test(t)) errors.push(`${f} names an employer: ${t.match(BANNED)[0]}`);
  const nf = parseHtml(html404);
  if (elements(nf, { visible: false }).filter((e) => e.tag === "h1").length !== 1) errors.push("404.html must have exactly one <h1>");
  if (!elements(nf, { visible: false }).some((e) => e.tag === "meta" && e.attrs.name === "robots" && /noindex/.test(e.attrs.content ?? ""))) errors.push("404.html must carry <meta name=\"robots\" content=\"noindex\">");
  if (!elements(nf).some((e) => e.tag === "a" && e.attrs.href === "/")) errors.push("404.html must link to the home page");
  const did = sha256(readFileSync(p("public/.well-known/did.json"))).toString("hex");
  if (did !== DID_SHA256) errors.push(`public/.well-known/did.json changed (sha256 ${did}); it backs did:web sign-in`);
  errors.push(...checkSecurityTxt(read("public/.well-known/security.txt"), now));

  const stale = Object.entries(files).filter(([f, t]) => readOr(f) !== t).map(([f]) => f);
  if (check && stale.length) errors.push(`out of date (run npm run build): ${stale.join(", ")}`);
  // Validation failures return before anything is written. An I/O failure while writing throws
  // (see writeStaged: staged, with a best-effort rollback, but not transactional).
  if (!check && !errors.length) writeStaged(root, Object.fromEntries(stale.map((f) => [f, files[f]])), Object.fromEntries(stale.map((f) => [f, readOr(f)])), io);
  return { errors, stale, date };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const CHECK = process.argv.includes("--check");
  let r;
  try { r = build({ check: CHECK }); } catch (e) {
    if (e.writePhase) {
      console.error(e.rolledBack
        ? `BUILD FAILED while writing (${e.message}); the files already replaced were restored — fix the cause and rerun the build`
        : `BUILD FAILED while writing (${e.message}); rollback incomplete, so outputs may be partially written — rerun the build`);
      process.exit(1);
    }
    r = { errors: [e.message], stale: [] }; // raised before any write
  }
  if (r.errors.length) { console.error(`BUILD FAILED (${CHECK ? "check" : "validation failed — nothing written"})\n` + r.errors.join("\n")); process.exit(1); }
  console.log(CHECK ? "build check passed" : `built (dateModified ${r.date}); ${r.stale.length ? "updated: " + r.stale.join(", ") : "no changes"}`);
}
