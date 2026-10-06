# 02 — Content and build

## One source of truth

`content.json` holds every piece of approved copy: person (name, headline, tagline, location, links), about, stats, work, side projects, background, skills, the Quick answers (`faq`) and the footer privacy note (`privacy`). It was drafted from Patrick's LinkedIn source files, then reframed to be **employer-agnostic** at his request: the site describes what he is good at and has done, never who employs him.

The visible page body (`public/index.html`) is **hand-written** — it is the chosen design and its markup is specific to it. Everything else that carries the copy is **generated** from `content.json` by `build.mjs`, and the build parses the hand-written page to verify that it still shows every item.

## What the build generates

| Output | Contents |
|---|---|
| Head metadata inside `index.html` | `<title>`, meta description, canonical link, Open Graph (`og:title`, `og:description`, `og:url`, `og:site_name`, `og:image:alt`) and Twitter title/description — all from `content.json`, so they cannot drift from the copy |
| JSON-LD `@graph` inside `index.html` | `ProfilePage`, `WebSite`, `Person` (with `identifier: did:web:patrickjv.com`, `alternateName`, `disambiguatingDescription`, `hasOccupation`, `address` with `addressCountry: "GB"`, `email`, `sameAs`, `knowsAbout`), `FAQPage` |
| WebMCP data (`var d = …`) inside `index.html` | Profile, work, skills, FAQ (from `lib/agent-data.mjs`) and the tool list — names, titles, descriptions, input schemas and `readOnlyHint` annotations taken from the MCP server's own `tools()` in `mcp/handler.js` (the page adds one sentence to `request_intro`'s description about the in-browser confirmation). The build fails if the server gains a tool the page has no counterpart for, or if a data tool is not read-only. |
| `public/index.md` | The whole page as clean Markdown, ending with the privacy note |
| `public/llms.txt` | LLM briefing: summary, disambiguation line, work, side projects, background, Quick answers, links, privacy note, machine-readable endpoints (Markdown, sitemap, MCP) |
| `public/sitemap.xml` | One URL with `lastmod` |
| `public/robots.txt` | `Allow: /`, `Content-Signal: search=yes, ai-input=yes, ai-train=yes`, sitemap link |
| `public/_headers` | Security headers on `/*`; one CSP rule per path — the page policy (sha256 hashes of the page's one inline `<style>` and one inline `<script>`) on `/` and `/index.html`, a baseline policy on each known non-HTML path; explicit UTF-8 content types; `Vary: Accept`; cache lifetimes for fonts and images (see [05](05-quality-and-audits.md#security-headers)) |
| CSP `<meta>` in `public/404.html` | The 404 page's own policy (hash of its inline `<style>`), kept in sync by the build — the 404 page is served at arbitrary paths, which no per-path `_headers` rule can name |
| `build-state.json` | `{ hash, date }`: the sha256 of every generated output (rendered with a placeholder date) and the date that output was first built |

**`dateModified` / `lastmod` are content-addressed.** The build renders everything with a placeholder date and hashes it. If the hash matches `build-state.json`, the recorded date is kept; otherwise today's date is used and recorded. The date therefore moves only when the generated output changes, a rebuild converges in one run, and `--check` depends on neither git nor the clock.

JSON spliced into a `<script>` is escaped (`<` as `\u003c`, plus U+2028/U+2029), so copy containing `</script>` can never close the element.

## Safety checks (the build fails if any is violated)

All checks run **before anything is written**. If every check passes, changed files are written to temporary names and then renamed into place, so a failed build leaves no half-written tree (`BUILD FAILED (nothing written)`).

1. **Section-aware copy check.** A small HTML parser walks the page. Each `content.json` item must be the **whole visible text of its own element in its own section** — masthead name/headline/tagline, contact strip, About, In figures (value and label separately), Work (title, summary, tags), Side projects, Background, Skills, Quick answers and the footer privacy note — in order and with the right count. Hidden content (`hidden`, `aria-hidden="true"`, comments) does not count, and a value cannot match as a substring of another (e.g. `40` inside `1,400+`). Any `content.json` string that no check covers is itself an error, so a new field cannot go unchecked.
2. **Link targets.** The hero buttons, contact strip and footer must link to exactly the approved LinkedIn, GitHub and `mailto:` targets, and *any* `mailto:`, LinkedIn or GitHub link anywhere on the page must use the approved target — a changed address fails even if the visible text is unchanged.
3. The page, `404.html`, `index.md` or `llms.txt` contains a term from a short employer **denylist**. This catches the known names only — it is a tripwire, not a general detector; employer-agnostic copy still depends on review.
4. The page does not have exactly one `<h1>`.
5. `public/.well-known/did.json` no longer matches its frozen sha256.
6. **Inline-code guards** (attributes parsed in any case or quoting): the page must have exactly one inline `<style>` and one executable inline `<script>` (JSON-LD is a data block); the 404 page exactly one `<style>` and no script. Any `style="…"` attribute, `on…` handler attribute, external stylesheet, external script or non-JavaScript script type fails — the CSP would block it.
7. **`_headers` guards:** no `! Header` detach lines (production ignores them — see [06](06-operations.md#incidents)), no `Content-Security-Policy` on `/*`, and no path pattern given a CSP by two rules.
8. **404 page:** exactly one `<h1>`, `<meta name="robots" content="noindex">`, and a link to `/`.
9. **`security.txt` `Expires`** must exist, parse as a real date, and be more than 30 days and at most 366 days ahead (RFC 9116 recommends less than a year).
10. `--check` mode: any generated file (including `build-state.json`) is out of date.

`npm test` runs `node build.mjs --check` first, and `npm run deploy` runs `npm test` first — stale or broken copy cannot be deployed. `test/build.test.mjs` (18 tests) covers the checks above: a hidden or `aria-hidden` section, a changed `mailto:`/LinkedIn target, a removed, commented-out or moved skill, the `40` vs `1,400+` substring case, a removed privacy note, an unchecked `content.json` string, inline-code bypasses, JSON escaping, `security.txt` bounds, one-run convergence, nothing written on failure, and generated head metadata. Guards were proven by deliberately breaking them and watching the check fail ("revert-and-fail"). The `_headers` guard has no unit test; it was revert-and-fail verified by hand when added.

## Shared data module

`lib/agent-data.mjs` maps `content.json` to the public data offered to agents. Both the page's WebMCP tools (via the build) and the MCP server import it, so the two surfaces always expose identical facts.

## Design assets

| Asset | Source / generator |
|---|---|
| The page design | `designs/claude-b/index.html` — winner of a blind six-way comparison (see [07](07-history-and-decisions.md)) |
| Portrait | A professional studio shot from Feb 2026 chosen from Patrick's Immich library; cropped square, 960 px WebP with 320/640 px variants, EXIF stripped |
| Favicon set | `designs/favicon/chosen.svg` (Codex's "datum mark", dark variant) → `designs/favicon/make-icons.cjs` builds `favicon.svg`, `favicon.ico` (16/32/48), `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` |
| Share card | `designs/og/make-card.cjs` → `public/og-card.jpg` (1200×630, IBM Plex, photo as "Fig. 01"); used by `og:image` and `twitter:card summary_large_image` |
| Fonts | IBM Plex Sans (variable) and Mono 400/500, Latin subset WOFF2, self-hosted in `public/fonts/` with the OFL licence |

The icon and card generators need `sharp` (`npm i --no-save sharp`); the card also needs IBM Plex installed locally for fontconfig (`~/.local/share/fonts`). They are **not reproducible**: `sharp` is unpinned, the card depends on locally installed fonts, and the generated images are not drift-checked by the build (review R53, open). The six candidate designs in `designs/` are an archive only — not built or deployed, and they still contain obsolete copy and Google Fonts requests (see `designs/PROVENANCE.md`).
