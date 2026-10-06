# patrickjv.com

Source for **https://patrickjv.com** — Patrick Vieira's professional site (platform engineer, London): a single static page built to be read equally well by people, search engines, AI answer engines and AI agents.

| | |
|---|---|
| **Live** | https://patrickjv.com (also `www.patrickjv.com`, `pvieira.co.uk`, `www.pvieira.co.uk` → 301 to it) |
| **Hosting** | Cloudflare Workers, Free plan — static assets (unmetered) + two small Workers |
| **Agents** | MCP server at `https://patrickjv.com/mcp` · listed on the MCP Registry as `com.patrickjv/profile` · WebMCP tools on the page |
| **Quality** | Lighthouse 100 / 100 / 100 / 100 (mobile and desktop) · axe: 0 violations · strict CSP, no third-party requests |
| **Monitoring** | Daily GitHub Actions smoke check (17 checks) — a failure emails the repo owner |

The whole site was designed, built and launched on 6 October 2026. [`docs/`](docs/) records everything: what was built, why, how it was verified, and how to run it.

## Quick start

Requires Node 24. `npm install` once (Wrangler is a pinned dev dependency).

```bash
npm run build    # regenerate every machine-readable copy from content.json
npm test         # build drift check + redirect and MCP unit tests (27)
npm run deploy   # npm test, then deploy all three Workers
npm run smoke -- https://patrickjv.com --aliases --mcp   # check the live site (17 checks)
```

### Changing the wording

1. Edit `content.json` **and** the matching visible text in `public/index.html` (the page layout is hand-written; it is the design).
2. `npm run build` — regenerates the JSON-LD, WebMCP data, `index.md`, `llms.txt`, `sitemap.xml`, `robots.txt` and the CSP hashes in `_headers`. It **fails** if any `content.json` string is missing from the page, if an employer is named, if `did.json` changed, or if `security.txt` is about to expire.
3. `npm run deploy`, then `npm run smoke -- https://patrickjv.com --aliases --mcp`.

## Repository layout

```
content.json              Source of truth for all copy (approved text)
build.mjs                 Generates machine-readable copies + _headers; drift and safety checks
lib/agent-data.mjs        Public profile data shared by the page's WebMCP tools and the MCP server
public/                   Static site (served by the patrickjv-eng-site Worker, assets only)
  index.html              The page (hand-written design; JSON-LD and WebMCP data spliced in by the build)
  index.md, llms.txt      Markdown version and LLM briefing (generated)
  _headers                Security headers + CSP (generated)
  .well-known/            did.json (DID document — never edit), security.txt, mcp-registry-auth
  fonts/                  Self-hosted IBM Plex (OFL)
redirect/                 patrickjv-redirect Worker: alias domains → 301 to patrickjv.com
mcp/                      patrickjv-mcp Worker: remote MCP server on the route patrickjv.com/mcp*
  server.json             MCP Registry entry (com.patrickjv/profile)
smoke.mjs                 Live checks (did.json bytes + MIME, pages, redirects, MCP handshake)
designs/                  The six candidate designs, favicon candidates, share-card generator
.github/workflows/        monitor.yml (daily smoke), deploy.yml (deploy on push; needs a token)
docs/                     Full documentation (start below)
```

## Documentation

| Doc | Covers |
|---|---|
| [01 — Architecture](docs/01-architecture.md) | Cloudflare Workers, domains, routes, DNS, email, edge rules, why it is shaped this way |
| [02 — Content and build](docs/02-content-and-build.md) | `content.json`, the build, generated files, safety checks, design assets |
| [03 — SEO, AEO and machine-readability](docs/03-seo-aeo-machine-readability.md) | Structured data, llms.txt, Markdown negotiation, AI crawlers, Content Signals, search registration, the agent-readiness layer map, research findings |
| [04 — MCP and WebMCP](docs/04-mcp-and-webmcp.md) | The MCP server, `request_intro`, rate limits, security hardening, the registry listing, WebMCP |
| [05 — Quality and audits](docs/05-quality-and-audits.md) | Lighthouse, accessibility, security headers, CSP, fonts, responsive and print checks, how to re-run audits |
| [06 — Operations](docs/06-operations.md) | Deploying, CI, monitoring, rollback, keys and secrets, renewals, open follow-ups |
| [07 — History and decisions](docs/07-history-and-decisions.md) | How the site was made on 6 Oct 2026: design competition, reviews, decisions and lessons |

## Rules that must not be broken

- **`public/.well-known/did.json` is byte-for-byte frozen** (sha256 `c713c3b1…a25c`). It backs `did:web:patrickjv.com` federated sign-in. The build and the daily monitor both fail if it changes.
- **The site is employer-agnostic.** It describes skills and work, never who employs (or employed) Patrick — in the page, metadata, JSON-LD and `llms.txt`.
- **No third-party requests and no inline styles** — the CSP allows only the page's own inline `<style>` and `<script>`, by hash.
- **British English** in all copy.
