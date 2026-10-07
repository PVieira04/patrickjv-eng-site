# 07 — History and decisions

The site was designed, built and launched in one session on **6 October 2026**, with Claude Code (Claude Opus) doing the build and **Codex (gpt-6.1-sol)** acting as a second, independent designer and as an adversarial reviewer.

## Starting point

- `patrickjv.com` served only `/.well-known/did.json` (from the `patrickjv-did` Worker); everything else was a 404.
- `pvieira.co.uk` and its `www` returned **525** (a proxied record pointing at a broken origin).
- `www.patrickjv.com` did not exist.

## Timeline

Times are London time (BST, UTC+1), as recorded in the commits.

| Time | Commit | What |
|---|---|---|
| 15:25 | `44782b8` | Six candidate designs (three by Claude, three by Codex) built from one brief and one `content.json`; compared **blind** (shuffled 1–6 on a preview Worker). Patrick chose **#5 = `claude-b`, the "systems / technical drawing" design**. Initial site with `did.json` byte-identical to the live one. |
| 15:51 | `2cf6173` | Copy reframed **employer-agnostic**; LinkedIn/GitHub buttons; portrait chosen from Immich via an API key (shortlist reviewed from 1,566 photos of Patrick; a Feb 2026 studio shot won). |
| 16:02 | `425b719` | First Codex review → split into an **assets-only site + redirect Worker** (quota risk to `did.json`). |
| 16:06 | — | **Switch-over**: `patrickjv.com` moved in place to the new site; `did.json` stayed 200 and identical throughout. Aliases attached after old DNS records were removed. |
| 16:17 | `936dd45` | `ProfilePage` graph with footballer disambiguation, `/index.md`, WebMCP read tools. AI training crawlers unblocked in Cloudflare; Google and Bing registration; Crawler Hints. |
| 16:34 | `271158e` | Quick answers section + `FAQPage`. |
| 17:30 | `4ee5a7f` | `build.mjs`: every machine copy generated from `content.json`, with drift checks; Content Signals in `robots.txt`. |
| 17:35 | `03b2170` | Person linked to `did:web:patrickjv.com`; Markdown negotiation rule. |
| 18:12 | `0c93d4f` | Email Routing; `hello@patrickjv.com` published. |
| 18:31 | `2ce4862` | Favicon: Claude vs Codex candidates; **Codex's "datum mark" (dark)** chosen. "London" added to the title. |
| 18:52 | `4b051ce` | **Remote MCP server** with `request_intro`, after three Codex review rounds. Edge WAF rate limit added after the binding proved too loose. |
| 21:22 | `4fa5753` | Security headers + CSP, self-hosted fonts, MCP icons, share card, print styles. Headless Chromium set up — first real visual verification. |
| 21:29 | `ed24391` | Responsive photo, WebMCP `request_intro`, daily monitor, deploy-on-push workflow. |
| 21:32 | `1a97fc2` | Published to the **MCP Registry** as `com.patrickjv/profile`. |
| 21:40 | `2c0a660` | `security.txt`. |
| 21:47 | `bf935bd` | Full documentation (`docs/`). |
| 23:08 | `694505e` | Whole-site **adversarial review** by two models with one prompt — Claude Opus 5.5 (with live network access) and Codex gpt-6.1-sol (offline, from a live snapshot); ~55 distinct findings, none Critical ([merged review](reviews/2026-10-06-merged-review.md)). |
| 23:10 | `9f63ab5` | Docs accuracy fixes from the review. |
| 23:15 | `3f42cff` | Fix branch 1 merged: strict smoke (PASS/WARN/FAIL), CI test gate, SHA-pinned actions, gated deploy, 6-hourly monitor, design-preview tooling retired. |
| 23:17 | `65a46ad` | Fix branch 2 merged: MCP and redirect hardening — handshake-exempt burst limit, HMAC-keyed quota with daily pruning, observability, strict validation, 308 redirects. |
| 23:22 | `2e49a17`, `b142785` | Fix branch 3 merged: section-aware build checks, generated head metadata, content-hash dates, per-path headers, 404 page, privacy note, WebMCP on `document.modelContext`. |
| 23:23 | — | Manual deploy. **Incident:** production ignored the `_headers` detach line, so `/` received two CSPs and the page's style and script were blocked. The strict smoke check failed at once; rolled back at 23:25 with `wrangler rollback`. |
| 23:27 | `8c90261` | Fix: each CSP set by exactly one rule, 404 page carries its own `<meta>` CSP, build guard against detach lines and duplicate CSPs. Deployed; smoke 22 PASS, 1 WARN (HTTP→HTTPS, an owner setting). See [06](06-operations.md#incidents). |
| 23:51 | `8bd29f8` | Codex round-2 fixes: strict smoke, CI token isolation, quota alarm and required salt, exact font rules. |
| 23:56 | `c616c58` | `pvieira.co.uk` mail DNS locked down (R2). |
| 00:33 (7 Oct) | `06a1af7` | `patrickjv.com` zone hardening (Always Use HTTPS, TLS 1.2, CAA, DNSSEC enabled, NEL off, SPF `-all`, DMARC monitoring); **deploy-on-push enabled** — this push was the first CI deploy. |
| 01:03 (7 Oct) | `1673080`, `ac61e8e` | Round-3 reviews (Codex and Claude): no Critical or High; findings mostly between components and outside the repo — see [§8 of the merged review](reviews/2026-10-06-merged-review.md#8-round-3-claude--codex). |
| 7 Oct | `25b16e8`, `bbf5caa` | **Deploys switched to Cloudflare Workers Builds** (decision D4): all three Workers connected to the repo, `.node-version` 24; `bbf5caa` was the first build — three `Workers Builds: …` check runs green, the GitHub deploy job skipped (`DEPLOY_ENABLED=false`), live smoke 28 passed, 2 warned, 0 failed. Then `deploy.yml` deleted and the monitor moved onto Workers Builds' check runs (post-deploy smoke, build-failure alert). |
| 7 Oct | `54f2ace`, this commit | Alias zone `pvieira.co.uk` hardened (NEL off, TLS 1.2, Always Use HTTPS, CAA, HSTS); `patrickjv.com` verified for GitHub Pages. **Redirect Worker replaced by Single Redirect rules** (R7) and `patrickjv-redirect` deleted; Markdown rule now needs `Accept` to start with `text/markdown` (R6). |

## The design competition

`designs/BRIEF.md` was given to both tools unchanged; `designs/mapping.json` holds the blind key.

| # | Folder | Maker | Direction |
|---|---|---|---|
| 1 | `codex-1` | Codex | Warm editorial journal |
| 2 | `claude-c` | Claude | Warm / human, paper and clay palette |
| 3 | `codex-3` | Codex | Bold cobalt typography |
| 4 | `codex-2` | Codex | Precise systems console |
| **5** | **`claude-b`** | **Claude** | **Systems / technical drawing — chosen** |
| 6 | `claude-a` | Claude | Editorial, print-magazine serif |

Working independently, Codex chose directions close to Claude's (editorial, systems), which made the blind comparison a fair test of execution.

## Key decisions

| Decision | Why |
|---|---|
| Plain static HTML, no framework | The chosen design was a single complete file; a framework would add a build step and nothing else |
| Assets-only site Worker | Static assets are unmetered; `did.json` cannot be knocked out by quota |
| Alias redirects as Single Redirect rules, fixed destination (redirect Worker until 7 Oct) | Unmetered, so an alias flood cannot use up the Worker quota (R7); the literal destination means no open redirect |
| Custom Domains, not DNS edits | Wrangler can attach them (and creates records); its OAuth cannot edit DNS |
| Employer-agnostic copy | A professional page about skills and work, not an employer |
| Allow all AI crawlers | Public professional profile; answer bots matter most and training helps disambiguation long-term |
| MCP server on its own route | Only `/mcp*` runs code; the edge rule caps the request rate before it (it bounds a flood, it does not stop one) |
| Limits-only for `request_intro` | Double opt-in needs Workers Paid or an external sender |
| No MCP server card / A2A card / `_agent` DNS | Nothing reads them yet; the MCP Registry does the discovery job |
| No analytics script | Keeps zero third-party requests (Cloudflare NEL also disabled on `patrickjv.com` and the alias zone `pvieira.co.uk`, 7 Oct — see [05](05-quality-and-audits.md#privacy)) |
| Codex favicon over Claude's | Bolder and clearer at 16 px, where favicons are judged |
| One CSP rule per path, none on `/*` | Production `_headers` ignores detach lines; two matching rules mean two policies (the 6 Oct incident) |
| Keep the JSON-LD `identifier` → `did:web:patrickjv.com` (review D1) | `did.json`'s `alsoKnownAs` lists DIDs on an employer's domain — a subtle link — but the file is already public and the choice is reversible |
| Dashboard config stays in prose for now (review D2) | A read-only export script into the repo is planned, later |
| Per-IP intro cap 4, not 2 | Hosted MCP clients and NAT share one address; the per-sender (2) and global (10) caps bound email volume |
| Global intro cap stays at 10 a day (review C3-F12) | Easy to exhaust (5 senders × 3 IPs, ~4 minutes), but what it protects is one personal mailbox, and every refusal points to `hello@patrickjv.com` |
| Readiness via a custom `patrickjv/health` method, not `ping` or a tool | `ping` results must be empty; a tool would be shown to users. Booleans only, through the full rejection chain |
| Deploy only `main`'s current head | GitHub re-runs keep the old SHA; a re-run must never put superseded code back. Rollback stays a deliberate `wrangler rollback` |
| Deploy with Cloudflare Workers Builds, not GitHub Actions (review D4, 7 Oct) | A repository secret on GitHub Free is readable by a workflow on any branch, and a leaked Workers token could deploy a forged `did.json`. Workers Builds deploys with a Cloudflare-managed token, so GitHub holds no deploy credential; the monitor keeps the post-deploy smoke and alerts on failed builds |
| `/404` soft 404 accepted (review C3-F9) | `noindex`, unlinked; a fix would rely on asset-server behaviour that differs between `wrangler dev` and production |

## Lessons worth keeping

- **Verify the claim, not the declaration.** A spoofed GPTBot UA proved a block but could not prove an allow; a rate-limit binding that deploys fine still blocked only 1 of 40 requests live.
- **Reviews converge in rounds.** Each Codex round's findings were narrower than the last (20-email cap bypass → midnight rollover → IPv4-mapped IPv6 forms); stop when only edge cases remain.
- **Revert-and-fail every guard.** Each safety test was deliberately broken to prove it could fail.
- **Look at it.** The page was not seen rendered until headless Chromium was set up; doing so immediately found a wrapping bug invisible to file checks.
- **Propagation is real.** Fresh Cloudflare deploys briefly served stale or 404 assets from some locations; re-test before chasing a bug.
- **Two independent reviewers beat one.** The two models agreed on every High finding but each found things the other missed (Codex: WebMCP draft API, build write order; Claude: edge, DNS and quota exposure needing live access).
- **Local dev is not production.** `wrangler dev` honoured a `_headers` detach line that production ignores; the result was a four-minute outage. Verify response headers on the live site after any header change, and turn a surprise into a build guard.
- **The gaps move outward.** By round 3 the code held up line by line; what remained sat between components (CI re-runs vs. production, monitor vs. deploy, WAF vs. Worker limits) and outside the repo (the alias zone, the token's scope, DS publication, a subdomain's own DMARC). Review the whole system, not just the diff.
- **Strict monitors catch real regressions.** The smoke check that compares the live CSP with the repo's `_headers` had been added minutes earlier, in the same release, and caught the incident straight after the deploy. A check that only tests for 200 would have passed.
