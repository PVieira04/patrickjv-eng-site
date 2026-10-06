# patrickjv.com

Source for **https://patrickjv.com** — Patrick Vieira's professional site (platform engineer, London): a single static page built to be read equally well by people, search engines, AI answer engines and AI agents.

| | |
|---|---|
| **Live** | https://patrickjv.com (also `www.patrickjv.com`, `pvieira.co.uk`, `www.pvieira.co.uk` → 301 to it; 308 for non-GET/HEAD) |
| **Hosting** | Cloudflare Workers, Free plan — static assets (unmetered) + two small Workers |
| **Agents** | MCP server at `https://patrickjv.com/mcp` · listed on the MCP Registry as `com.patrickjv/profile` · WebMCP tools on the page |
| **Quality** | Lighthouse 100 / 100 / 100 / 100 (mobile and desktop) · axe: 0 violations · strict per-path CSP, no third-party requests |
| **Monitoring** | GitHub Actions smoke check every 6 hours (23 checks, each PASS / WARN / FAIL); a failed run notifies according to GitHub's notification settings |

The whole site was designed, built and launched on 6 October 2026, then adversarially reviewed and hardened the same evening. [`docs/`](docs/) records everything: what was built, why, how it was verified, and how to run it.

## Quick start

Requires Node 24 or later (`engines: >=24`). `npm ci` once (Wrangler is a pinned dev dependency; the lockfile is authoritative).

```bash
npm run build    # regenerate every machine-readable copy from content.json
npm test         # build drift check + 68 unit tests (build, MCP Worker, redirect Worker)
npm run deploy   # npm test, then deploy all three Workers
npm run smoke -- https://patrickjv.com --aliases --mcp --registry   # check the live site
```

`smoke.mjs` flags: `--aliases` (redirect hosts), `--mcp` (read-only MCP lifecycle), `--registry` (MCP Registry listing), `--strict-https` (turn the HTTP→HTTPS WARN into a FAIL). Every check prints **PASS**, **WARN** or **FAIL**; the run exits 1 only on a FAIL. Base checks: 14; with all three listing flags: 23.

### Changing the wording

1. Edit `content.json` **and** the matching visible text in `public/index.html` (the page body is hand-written; it is the design).
2. `npm run build` — regenerates the head metadata (title, description, Open Graph, Twitter), JSON-LD, WebMCP data, `index.md`, `llms.txt`, `sitemap.xml`, `robots.txt`, `_headers` (with the CSP hashes), the 404 page's CSP `<meta>` and `build-state.json`. It **fails, writing nothing,** if any `content.json` item is not the whole visible text of its element in its own section, if a contact link points anywhere else, if an employer denylist term appears, if `did.json` changed, or if `security.txt` expires within 30 days (or more than a year ahead).
3. `npm run deploy`, then `npm run smoke -- https://patrickjv.com --aliases --mcp --registry`.

## Repository layout

```
content.json              Source of truth for all copy (approved text)
build.mjs                 Generates machine-readable copies + _headers; drift and safety checks
build-state.json          Content hash of the generated output + the date it was first built (dateModified)
lib/agent-data.mjs        Public profile data shared by the page's WebMCP tools and the MCP server
public/                   Static site (served by the patrickjv-eng-site Worker, assets only)
  index.html              The page (hand-written body; head metadata, JSON-LD and WebMCP data spliced in by the build)
  404.html                Not-found page (served with status 404; carries its own CSP <meta>)
  index.md, llms.txt      Markdown version and LLM briefing (generated)
  _headers                Security headers, per-path CSP, content types, caching (generated)
  .well-known/            did.json (DID document — never edit), security.txt, mcp-registry-auth
  fonts/                  Self-hosted IBM Plex (OFL)
redirect/                 patrickjv-redirect Worker: alias domains → 301 (308 for non-GET) to patrickjv.com
mcp/                      patrickjv-mcp Worker: remote MCP server on the route patrickjv.com/mcp*
  server.json             MCP Registry entry (com.patrickjv/profile); also the server's version
test/build.test.mjs       Build regression tests
smoke.mjs                 Live checks (did.json, pages, headers/CSP, redirects, MCP lifecycle, Registry)
designs/                  Archived design round (PROVENANCE.md), favicon candidates, share-card generator
.github/workflows/        test.yml (every push/PR), deploy.yml (deploy on push; gated), monitor.yml (every 6 h)
docs/                     Full documentation (start below)
```

## Documentation

| Doc | Covers |
|---|---|
| [01 — Architecture](docs/01-architecture.md) | Cloudflare Workers, domains, routes, DNS, email, edge rules, why it is shaped this way |
| [02 — Content and build](docs/02-content-and-build.md) | `content.json`, the build, generated files, safety checks, design assets |
| [03 — SEO, AEO and machine-readability](docs/03-seo-aeo-machine-readability.md) | Structured data, llms.txt, Markdown negotiation, AI crawlers, Content Signals, search registration, the agent-readiness layer map, research findings |
| [04 — MCP and WebMCP](docs/04-mcp-and-webmcp.md) | The MCP server, `request_intro`, rate limits, security hardening, the registry listing, WebMCP |
| [05 — Quality and audits](docs/05-quality-and-audits.md) | Lighthouse, accessibility, security headers, CSP, caching, privacy, responsive and print checks, how to re-run audits |
| [06 — Operations](docs/06-operations.md) | Deploying, CI, monitoring, rollback, keys and secrets, incidents, renewals, open follow-ups |
| [07 — History and decisions](docs/07-history-and-decisions.md) | How the site was made on 6 Oct 2026: design competition, reviews, decisions and lessons |
| [Review (6 Oct 2026)](docs/reviews/2026-10-06-merged-review.md) | Merged adversarial review findings, with the status of each |

## Rules that must not be broken

- **`public/.well-known/did.json` is byte-for-byte frozen** (sha256 `c713c3b1…a25c`). It backs `did:web:patrickjv.com` federated sign-in. The build and the monitor both fail if it changes.
- **The site is employer-agnostic.** It describes skills and work, never who employs (or employed) Patrick — in the page, metadata, JSON-LD and `llms.txt`.
- **No third-party requests and no inline styles** — the page's CSP allows only its own inline `<style>` and `<script>`, by hash.
- **One CSP rule per path; no detach.** Cloudflare's production asset server ignores `! Header` detach lines, so a CSP on `/*` would combine with the page's own and block it (this happened — see [06](docs/06-operations.md#incidents)). The build refuses detach lines, a CSP on `/*`, and duplicate CSP rules.
- **British English** in all copy.

The page footer carries a one-line privacy note: introductions sent through the MCP or browser-agent tools are forwarded by email and not stored.
