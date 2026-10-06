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
// Nothing is written unless every check passes.
import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
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
export function checkPage(html, c) {
  const errors = [];
  const used = new Set();
  const doc = parseHtml(html);
  const visible = elements(doc);
  const L = c.person.links;
  const mailto = "mailto:" + L.email;
  const bare = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

  const list = (what, actual, expected) => {
    expected.forEach((e) => used.add(e));
    if (actual.length !== expected.length) errors.push(`${what}: expected ${expected.length} item(s), found ${actual.length}`);
    expected.forEach((e, k) => { if (actual[k] !== e) errors.push(`${what}[${k}]: expected "${e}", found ${actual[k] === undefined ? "nothing" : `"${actual[k]}"`}`); });
  };
  const one = (what, actual, expected) => list(what, [actual].filter((x) => x !== undefined), [expected]);
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
  one("h1", texts(within(head, byTag("h1")))[0], c.person.name);
  one("headline (.role)", texts(within(head, byClass("role")))[0], c.person.headline);
  one("tagline", texts(within(head, byClass("tagline")))[0], c.person.tagline);
  list("hero contact links", hrefs(within(head, byClass("actions"))[0]), [L.linkedin, L.github, mailto]);
  const spec = within(head, byClass("spec"))[0];
  list("contact strip links", hrefs(spec), [L.linkedin, L.github, mailto]);
  const dd = Object.fromEntries(within(spec, byTag("dt")).map((dt) => {
    const sib = dt.parent.children.filter((n) => n.tag);
    return [textOf(dt), sib[sib.indexOf(dt) + 1]];
  }).filter(([, v]) => v && v.tag === "dd").map(([k, v]) => [k, textOf(v)]));
  one("contact strip Location", dd.Location, c.person.location);
  one("contact strip LinkedIn", dd.LinkedIn, bare(L.linkedin));
  one("contact strip GitHub", dd.GitHub, bare(L.github));
  one("contact strip Email", dd.Email, L.email);

  list("About", texts(within(section("about"), byTag("p"))), c.about);

  const readouts = within(section("figures"), byClass("readouts")).flatMap((ul) => within(ul, byTag("li")));
  list("In figures values", readouts.map((li) => texts(within(li, byClass("value")))[0]), c.stats.map((s) => s.value));
  list("In figures labels", readouts.map((li) => texts(within(li, byClass("rlabel")))[0]), c.stats.map((s) => s.label));

  const work = within(section("work"), byTag("article"));
  list("Work titles", work.map((a) => texts(within(a, byTag("h3")))[0]), c.work.map((w) => w.title));
  list("Work summaries", work.map((a) => texts(within(a, byTag("p")))[0]), c.work.map((w) => w.summary));
  c.work.forEach((w, k) => list(`Work[${k}] tags`, texts(within(work[k], byClass("tags")).flatMap((ul) => within(ul, byTag("li")))), w.tags));

  const side = within(section("side-projects"), byTag("article"));
  list("Side project titles", side.map((a) => texts(within(a, byTag("h3")))[0]), c.side_projects.map((p) => p.title));
  list("Side project summaries", side.map((a) => texts(within(a, byTag("p")))[0]), c.side_projects.map((p) => p.summary));

  list("Background", texts(within(section("background"), byTag("p"))), c.background);
  list("Skills", texts(within(section("skills"), byClass("skills")).flatMap((ul) => within(ul, byTag("li")))), c.skills);

  const faq = within(section("faq"), byClass("faq")).flatMap((f) => f.children.filter((n) => n.tag === "div" && !isHidden(n)));
  list("Quick answers questions", faq.map((q) => texts(within(q, byTag("h3")))[0]), c.faq.map((f) => f.q));
  list("Quick answers answers", faq.map((q) => texts(within(q, byTag("p")))[0]), c.faq.map((f) => f.a));

  const footer = visible.find(byTag("footer"));
  list("footer links", hrefs(footer), [L.linkedin, L.github]);
  one("footer privacy note", texts(within(footer, byClass("privacy")))[0], c.privacy);

  // Every link to a contact channel anywhere on the page must use the exact approved target.
  for (const a of elements(doc, { visible: false }).filter(byTag("a"))) {
    const h = a.attrs.href ?? "";
    if (/^mailto:/i.test(h) && h !== mailto) errors.push(`mailto link points at ${h}, expected ${mailto}`);
    if (/linkedin\.com/i.test(h) && h !== L.linkedin) errors.push(`LinkedIn link points at ${h}, expected ${L.linkedin}`);
    if (/github\.com/i.test(h) && h !== L.github) errors.push(`GitHub link points at ${h}, expected ${L.github}`);
  }
  [L.linkedin, L.github, L.email].forEach((s) => used.add(s));

  const unchecked = [];
  (function walk(o, k) { if (k === "_status") return; if (typeof o === "string") { if (!used.has(o)) unchecked.push(o); } else if (o && typeof o === "object") for (const [kk, v] of Object.entries(o)) walk(v, kk); })(c);
  if (unchecked.length) errors.push("content.json string(s) not checked against the page (add a check in checkPage):\n  - " + unchecked.map((s) => s.slice(0, 80)).join("\n  - "));
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

// ---------------------------------------------------------------------------------------------
// Rendering: every generated file, as a function of the content and the dateModified value.
// ---------------------------------------------------------------------------------------------
function render(c, html0, html404, imageFiles, date) {
  const city = c.person.location.split(",")[0].trim();
  const title = `${c.person.name} — ${c.person.headline}, ${city}`;

  // ---- JSON-LD ----
  const id = (frag) => ({ "@id": SITE + "#" + frag });
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ProfilePage", "@id": SITE + "#profilepage", url: SITE,
        name: `${c.person.name} — ${c.person.headline}`, inLanguage: "en-GB", dateModified: date,
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
  const links = [`- [Email](mailto:${c.person.links.email}): ${c.person.links.email}`, `- [LinkedIn](${c.person.links.linkedin})`, `- [GitHub](${c.person.links.github})`, "", c.privacy, ""];
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
  const nf = inlineCode(html404, { styles: 1, scripts: 0 });
  const csp = [
    "default-src 'none'", "img-src 'self'", "font-src 'self'", `style-src ${page.styles.map(cspHash).join(" ")}`,
    `script-src ${page.scripts.map(cspHash).join(" ")}`, "connect-src 'self'", "base-uri 'none'", "form-action 'none'",
    "frame-ancestors 'none'", "upgrade-insecure-requests",
  ].join("; ");
  // Baseline for every other path. Cloudflare serves the 404 page under the rules of the path that
  // was requested, so the baseline must also allow the 404 page's one inline <style> (by hash) and
  // the self-hosted fonts it uses; it permits nothing else (no scripts, no connections, no framing).
  const baseCsp = [
    "default-src 'none'", "img-src 'self'", "font-src 'self'", `style-src ${nf.styles.map(cspHash).join(" ")}`,
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join("; ");
  const types = [
    ["/index.md", "text/markdown; charset=utf-8"], ["/llms.txt", "text/plain; charset=utf-8"], ["/robots.txt", "text/plain; charset=utf-8"],
    ["/sitemap.xml", "application/xml; charset=utf-8"], ["/.well-known/security.txt", "text/plain; charset=utf-8"],
    ["/.well-known/mcp-registry-auth", "text/plain; charset=utf-8"],
  ];
  const headers = `# Generated by build.mjs — do not edit by hand.
# Cloudflare joins a header set by several matching rules into one comma-separated value, so a
# rule that replaces the baseline Content-Security-Policy first detaches it with "! ...".
# Content-Type and Cache-Control set here replace the asset server's defaults.
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
  X-Frame-Options: DENY
  Content-Security-Policy: ${baseCsp}

# The page: "/" is negotiated (HTML, or Markdown for Accept: text/markdown), hence Vary.
/
  ! Content-Security-Policy
  Content-Security-Policy: ${csp}
  Vary: Accept

/index.html
  ! Content-Security-Policy
  Content-Security-Policy: ${csp}

${types.map(([p, t]) => `${p}\n  Content-Type: ${t}${p === "/index.md" ? "\n  Vary: Accept" : ""}`).join("\n\n")}

# Fonts keep their names (no fingerprint), so they are not "immutable": 30 days, then revalidated
# by ETag. A changed font should get a new file name. Images change rarely and are small: one day.
/fonts/*
  Cache-Control: public, max-age=2592000

${imageFiles.map((f) => `/${f}\n  Cache-Control: public, max-age=86400`).join("\n\n")}
`;

  return {
    files: { "public/_headers": headers, "public/index.html": html, "public/index.md": md, "public/llms.txt": llms, "public/sitemap.xml": sitemap, "public/robots.txt": robots },
    inlineErrors: [...page.errors, ...nf.errors.map((e) => "404.html: " + e)],
    md, llms,
  };
}

// ---------------------------------------------------------------------------------------------
// The build. dateModified is content-addressed: build-state.json records the hash of every
// generated output (rendered with a placeholder date) and the date that hash was first built.
// The date moves only when the output changes, so a rebuild converges in one run and --check never
// depends on git or the clock.
// ---------------------------------------------------------------------------------------------
export function build({ root = process.cwd(), check = false, today = new Date().toISOString().slice(0, 10), now = Date.now() } = {}) {
  const p = (f) => join(root, f);
  const read = (f) => readFileSync(p(f), "utf8");
  const readOr = (f) => { try { return read(f); } catch { return null; } };
  const errors = [];

  const c = JSON.parse(read("content.json"));
  const html0 = read("public/index.html");
  const html404 = read("public/404.html");
  const imageFiles = readdirSync(p("public")).filter((f) => /\.(webp|jpe?g|png|ico|svg|avif|gif)$/i.test(f)).sort();

  const probe = render(c, html0, html404, imageFiles, "0000-00-00").files;
  const hash = sha256(JSON.stringify(Object.entries(probe).sort())).toString("hex");
  let state = null;
  try { state = JSON.parse(readOr("build-state.json") ?? "null"); } catch { state = null; }
  let date;
  if (state?.hash === hash && /^\d{4}-\d{2}-\d{2}$/.test(state.date ?? "")) date = state.date;
  else if (check) { errors.push("build-state.json does not match the generated output (run npm run build)"); date = state?.date ?? today; }
  else date = today;

  const { files, inlineErrors, md, llms } = render(c, html0, html404, imageFiles, date);
  files["build-state.json"] = JSON.stringify({ hash, date }, null, 2) + "\n";

  // ---- checks (all before any write) ----
  errors.push(...inlineErrors);
  errors.push(...checkPage(files["public/index.html"], c).map((e) => "index.html: " + e));
  for (const [f, t] of [["index.html", files["public/index.html"]], ["404.html", html404], ["index.md", md], ["llms.txt", llms]]) if (BANNED.test(t)) errors.push(`${f} names an employer: ${t.match(BANNED)[0]}`);
  const nf = parseHtml(html404);
  if (elements(nf, { visible: false }).filter((e) => e.tag === "h1").length !== 1) errors.push("404.html must have exactly one <h1>");
  if (!elements(nf, { visible: false }).some((e) => e.tag === "meta" && e.attrs.name === "robots" && /noindex/.test(e.attrs.content ?? ""))) errors.push("404.html must carry <meta name=\"robots\" content=\"noindex\">");
  if (!elements(nf).some((e) => e.tag === "a" && e.attrs.href === "/")) errors.push("404.html must link to the home page");
  const did = sha256(readFileSync(p("public/.well-known/did.json"))).toString("hex");
  if (did !== DID_SHA256) errors.push(`public/.well-known/did.json changed (sha256 ${did}); it backs did:web sign-in`);
  errors.push(...checkSecurityTxt(read("public/.well-known/security.txt"), now));

  const stale = Object.entries(files).filter(([f, t]) => readOr(f) !== t).map(([f]) => f);
  if (check && stale.length) errors.push(`out of date (run npm run build): ${stale.join(", ")}`);
  if (!check && !errors.length) {
    // Write every file to a temporary name first, then rename, so a failed write leaves no mix.
    for (const f of stale) writeFileSync(p(f) + ".tmp", files[f]);
    for (const f of stale) renameSync(p(f) + ".tmp", p(f));
  }
  return { errors, stale, date };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const CHECK = process.argv.includes("--check");
  let r;
  try { r = build({ check: CHECK }); } catch (e) { r = { errors: [e.message], stale: [] }; }
  if (r.errors.length) { console.error("BUILD FAILED (nothing written)\n" + r.errors.join("\n")); process.exit(1); }
  console.log(CHECK ? "build check passed" : `built (dateModified ${r.date}); ${r.stale.length ? "updated: " + r.stale.join(", ") : "no changes"}`);
}
