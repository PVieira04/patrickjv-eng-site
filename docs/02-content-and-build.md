# 02 — Content and build

## One source of truth

`content.json` holds every piece of approved copy: person (name, headline, tagline, location, links), about, stats, work, side projects, background, skills and the Quick answers (`faq`). It was drafted from Patrick's LinkedIn source files, then reframed to be **employer-agnostic** at his request: the site describes what he is good at and has done, never who employs him.

The visible page (`public/index.html`) is **hand-written** — it is the chosen design and its markup is specific to it. Everything else that carries the copy is **generated** from `content.json` by `build.mjs`, and the build verifies that the hand-written page still contains every string.

## What the build generates

| Output | Contents |
|---|---|
| JSON-LD `@graph` inside `index.html` | `ProfilePage`, `WebSite`, `Person` (with `identifier: did:web:patrickjv.com`, `alternateName`, `disambiguatingDescription`, `hasOccupation`, `email`, `sameAs`, `knowsAbout`), `FAQPage` |
| WebMCP data (`var d = …`) inside `index.html` | Profile, work, skills, FAQ (from `lib/agent-data.mjs`) and the `request_intro` input schema (taken from the MCP server's own `tools()`) |
| `public/index.md` | The whole page as clean Markdown |
| `public/llms.txt` | LLM briefing: summary, disambiguation line, work, side projects, background, Quick answers, links, machine-readable endpoints (Markdown, sitemap, MCP) |
| `public/sitemap.xml` | One URL with `lastmod` |
| `public/robots.txt` | `Allow: /`, `Content-Signal: search=yes, ai-input=yes, ai-train=yes`, sitemap link |
| `public/_headers` | Security headers and a CSP whose `style-src`/`script-src` are the sha256 hashes of the page's one inline `<style>` and one inline `<script>` |

`dateModified` / `lastmod` become today's date when `content.json` or `index.html` has uncommitted changes; otherwise the recorded date is kept, so rebuilding an unchanged tree changes nothing. The first run of the build reproduced the then-live files **byte for byte**.

## Safety checks (the build fails if any is violated)

1. A `content.json` string is missing from the visible HTML (URLs are checked in `href`s).
2. The page, `index.md` or `llms.txt` names an employer.
3. The page does not have exactly one `<h1>`.
4. `public/.well-known/did.json` no longer matches its frozen sha256.
5. There is not exactly one inline `<style>` and one inline `<script>`, or an inline `style="…"` attribute exists (the CSP would block it).
6. `security.txt`'s `Expires` is less than 30 days away.
7. `--check` mode: any generated file is out of date.

`npm test` runs `node build.mjs --check` first, and `npm run deploy` runs `npm test` first — stale or broken copy cannot be deployed. Each guard was proven by deliberately breaking it and watching the check fail ("revert-and-fail").

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

The icon and card generators need `sharp` (`npm i --no-save sharp`); the card also needs IBM Plex installed locally for fontconfig (`~/.local/share/fonts`).
