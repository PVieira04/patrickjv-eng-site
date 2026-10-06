// Generates every machine-readable copy of the site from content.json, then checks the result.
//   node build.mjs          write public/ files
//   node build.mjs --check  write nothing; exit 1 if anything is out of date or a check fails
//
// Generated: the JSON-LD @graph and WebMCP data inside public/index.html, public/index.md,
// public/llms.txt, public/sitemap.xml and public/robots.txt. The visible HTML is hand-written
// (it is the design); the build fails if any content.json string is missing from it.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { agentData } from "./lib/agent-data.mjs";
import { tools as mcpTools } from "./mcp/handler.js";

const SITE = "https://patrickjv.com/";
const DID_SHA256 = "c713c3b182128838452fdf1cf9f9b9bde71969933573a46a4341b4b42046a25c";
const DISAMBIGUATION = "Patrick Vieira, platform engineer based in London — not the footballer of the same name.";
const BANNED = /altimist|the company|fintech|\bceo\b|wimbledon/i;
const CHECK = process.argv.includes("--check");

const c = JSON.parse(readFileSync("content.json", "utf8"));
const read = (f) => readFileSync(f, "utf8");
const errors = [];

// dateModified / lastmod: today if the page or its content has uncommitted changes, else the
// date already recorded (so rebuilding an unchanged tree changes nothing).
const html0 = read("public/index.html");
const recorded = html0.match(/"dateModified": "(\d{4}-\d{2}-\d{2})"/)?.[1];
const dirty = execSync("git status --porcelain -- content.json public/index.html", { encoding: "utf8" }).trim() !== "";
const date = dirty || !recorded ? new Date().toISOString().slice(0, 10) : recorded;

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
      hasOccupation: { "@type": "Occupation", name: c.person.headline, occupationLocation: { "@type": "City", name: "London" } },
      description: c.person.tagline, url: SITE, image: SITE + "photo.webp",
      address: { "@type": "PostalAddress", addressLocality: "London", addressCountry: "United Kingdom" },
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

// ---- WebMCP data ----
// The page's WebMCP request_intro uses the MCP server's own input schema, so they cannot drift.
const webmcp = { ...agentData(c), introSchema: mcpTools().find((t) => t.name === "request_intro").inputSchema };

// Splice both into the hand-written HTML. Each regex must match exactly once.
function splice(html, re, replacement, what) {
  const n = (html.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || []).length;
  if (n !== 1) throw new Error(`${what}: expected 1 match in index.html, found ${n}`);
  return html.replace(re, replacement);
}
const ldIndent = html0.match(/^([ \t]*)<script type="application\/ld\+json">/m)?.[1] ?? "";
let html = splice(html0, /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
  () => `<script type="application/ld+json">\n${JSON.stringify(jsonld, null, 2)}\n${ldIndent}</script>`, "JSON-LD block");
html = splice(html, /var d = \{.*\};/, () => `var d = ${JSON.stringify(webmcp)};`, "WebMCP data");

// ---- index.md ----
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
  "## Links", "", `- [Email](mailto:${c.person.links.email}): ${c.person.links.email}`, `- [LinkedIn](${c.person.links.linkedin})`, `- [GitHub](${c.person.links.github})`, "",
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
  "## Links", "", `- [Email](mailto:${c.person.links.email}): ${c.person.links.email}`, `- [LinkedIn](${c.person.links.linkedin})`, `- [GitHub](${c.person.links.github})`, "",
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

// ---- _headers ---- Security headers for the static site. The CSP allows exactly the page's one
// inline <style> and one inline (WebMCP) <script> by hash, so they are recomputed on every build.
// The JSON-LD block is a data block (never executed), so script-src does not apply to it.
const cspHash = (s) => "'sha256-" + createHash("sha256").update(s, "utf8").digest("base64") + "'";
const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (styles.length !== 1 || scripts.length !== 1) errors.push(`expected 1 inline <style> and 1 inline <script>, found ${styles.length} and ${scripts.length}`);
if (/\sstyle="/.test(html)) errors.push("inline style attributes are blocked by the CSP; use a class");
const csp = [
  "default-src 'none'", "img-src 'self'", "font-src 'self'", `style-src ${styles.map(cspHash).join(" ")}`,
  `script-src ${scripts.map(cspHash).join(" ")}`, "connect-src 'self'", "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'none'", "upgrade-insecure-requests",
].join("; ");
const headers = `# Generated by build.mjs — do not edit by hand.
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
  X-Frame-Options: DENY

/
  Content-Security-Policy: ${csp}

/index.html
  Content-Security-Policy: ${csp}

/fonts/*
  Cache-Control: public, max-age=31536000, immutable
`;

// ---- checks ----
const decode = (s) => s.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;|&rsquo;|’/g, "'").replace(/&amp;/g, "&")
  .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&times;/g, "×").replace(/&nbsp;|&#160;| /g, " ").replace(/\s+/g, " ");
const strings = [];
(function walk(o, k) { if (k === "_status") return; if (typeof o === "string") strings.push(o); else if (o && typeof o === "object") for (const [kk, v] of Object.entries(o)) walk(v, kk); })(c);
const visible = decode(html.replace(/<script[\s\S]*?<\/script>/g, ""));
// URLs live in href attributes, so look for them in the raw markup rather than the visible text.
const missing = strings.filter((s) => (/^https?:\/\//.test(s) ? !html.includes(`href="${s}"`) : !visible.includes(decode(s))));
if (missing.length) errors.push(`visible HTML is missing ${missing.length} content.json string(s):\n  - ` + missing.map((s) => s.slice(0, 80)).join("\n  - "));
for (const [f, t] of [["index.html", html], ["index.md", md], ["llms.txt", llms]]) if (BANNED.test(t)) errors.push(`${f} names an employer: ${t.match(BANNED)[0]}`);
if ((html.match(/<h1[\s>]/g) || []).length !== 1) errors.push("index.html must have exactly one <h1>");
const did = createHash("sha256").update(readFileSync("public/.well-known/did.json")).digest("hex");
if (did !== DID_SHA256) errors.push(`public/.well-known/did.json changed (sha256 ${did}); it backs did:web sign-in`);

// security.txt (RFC 9116) must not expire: fail the build 30 days ahead.
const secExpires = new Date(read("public/.well-known/security.txt").match(/^Expires: (.+)$/m)?.[1] ?? 0);
if (!(secExpires - Date.now() > 30 * 864e5)) errors.push(`public/.well-known/security.txt expires ${secExpires.toISOString?.() ?? "?"}: bump Expires (max 1 year ahead)`);

// ---- write or compare ----
const outputs = { "public/_headers": headers, "public/index.html": html, "public/index.md": md, "public/llms.txt": llms, "public/sitemap.xml": sitemap, "public/robots.txt": robots };
const readOr = (f) => { try { return read(f); } catch { return null; } };
const stale = Object.entries(outputs).filter(([f, t]) => readOr(f) !== t).map(([f]) => f);
if (CHECK) { if (stale.length) errors.push(`out of date (run npm run build): ${stale.join(", ")}`); }
else for (const f of stale) writeFileSync(f, outputs[f]);

if (errors.length) { console.error("BUILD FAILED\n" + errors.join("\n")); process.exit(1); }
console.log(CHECK ? "build check passed" : `built (dateModified ${date}); ${stale.length ? "updated: " + stale.join(", ") : "no changes"}`);
