# Adversarial review — merged findings (6 Oct 2026)

Two independent reviewers received an identical prompt: review the entire repository **and** the deployed site, adversarially, for everything big and small.

- **Claude Opus 5.5** (subagent, live network access): 26 findings.
- **Codex gpt-6.1-sol** (read-only sandbox, **no network** — worked from a live snapshot): 50 findings. Raw report: [2026-10-06-codex-gpt-6.1-sol.md](2026-10-06-codex-gpt-6.1-sol.md).

After de-duplication: ~55 distinct findings, **none Critical**. Both agreed on every High. Source: **[B]** both, **[C]** Claude only, **[X]** Codex only. **Owner** = needs a Cloudflare dashboard change (Wrangler's OAuth cannot edit DNS, rulesets or zone settings). **Status** is updated as fixes land.

## 1. Edge, DNS and email (Owner)

| ID | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| R1 | High [B] | `http://patrickjv.com` serves the page, `did.json` and `/mcp` over plaintext (no HTTP→HTTPS) | SSL/TLS → Edge Certificates → **Always Use HTTPS** | Owner |
| R2 | High [B] | `pvieira.co.uk`: two SPF records (permerror), template DMARC (`pct100`, `youremailaddress@yourdomain.com`), Hostinger MX after registrar move (possibly dangling), Elastic Email DKIM `api._domainkey` and `tracking` leftovers | Delete the 7 legacy records; add null MX, `v=spf1 -all`, `v=DMARC1; p=reject; adkim=s; aspf=s`, `*._domainkey "v=DKIM1; p="` (domain sends/receives no mail) | Owner |
| R3 | Med [B] | `patrickjv.com`: no DMARC, SPF `~all` | DMARC `p=quarantine` with reporting → `reject`; SPF `-all` | Owner |
| R4 | Med [C] | TLS 1.0/1.1 accepted; no DNSSEC on `patrickjv.com`; [B] no CAA | Min TLS 1.2; enable DNSSEC; CAA for Cloudflare's CAs | Owner |
| R5 | Med [B] | Cloudflare NEL/`Report-To` headers point at `a.nel.cloudflare.com` (third-party reporting) | Disable NEL if available; correct the privacy claim | Owner + docs |
| R6 | Low [B] | Markdown rewrite matches any `Accept` containing `text/markdown` (even `q=0`, or `text/html` first) | Tighten the rule expression | Owner |
| R7 | Med [C] | Redirect Worker is metered and un-throttled: an alias flood could exhaust the account's shared daily Worker quota | Replace with free Single Redirect rules, or widen the WAF rule to cover alias hosts | Owner |
| R8 | Low [C] | Domain expiry (patrickjv.com 2027-04-03, pvieira.co.uk 2027-06-14) untracked | Confirm auto-renew; document | Owner + docs |

## 2. Robustness (code)

| ID | Sev | Finding | Fix |
|---|---|---|---|
| R10 | Med [X] | WebMCP: current draft exposes `document.modelContext`; page only checks `navigator.modelContext` → **0 tools** on draft-compliant browsers. Registration promises ignored; abort signal ignored | Support both; await/catch registration; honour `signal` |
| R11 | Med [B] | WebMCP confirm dialog omits `organisation`/`agent`; input not snapshotted; read tools lack `readOnlyHint`; stale comment; description drops "not the footballer" | Show every field; snapshot; annotations; reuse MCP descriptions |
| R12 | Med [B] | Smoke passes against HTTP 500s / duplicate tools; did.json not compared with the frozen hash; no checks for headers/CSP, live page vs repo, Markdown negotiation, HTTP→HTTPS, security.txt, Registry; no timeouts; one failure aborts the rest; argument parsing | Strict, per-check, timed smoke |
| R13 | Med [B] | CI never runs tests (gate skips everything, shows green); token job-wide; actions on mutable tags; `persist-credentials` true; no PR validation | Separate test job; token only on deploy step; SHA-pinned actions; `persist-credentials: false`; pinned runner |
| R14 | Med [B] | MCP failures silent (bare `catch`); Worker observability off | Workers Logs on; redacted error events |
| R15 | Med [C] | Burst limits too tight for shared egress (e.g. the Claude connector): `initialize`/notifications/`tools/list` count; per-IP daily intro cap shared across a provider's users | Exempt handshake from burst; raise read limits; keep sender + global caps |
| R16 | Low [B] | `workers_dev: true` exposes a duplicate production origin | `workers_dev: false`, `preview_urls: false` |
| R17 | Med [B] | No `Vary: Accept` on the negotiated `/` | Add for `/` and `/index.md` |
| R18 | Med [B] | Text responses lack `charset=utf-8`; `mcp-registry-auth` has no Content-Type | Explicit types in `_headers` |
| R19 | Low [B] | CSP only on `/`; `/mcp`, redirects, `.md`, `.well-known`, 404 lack headers | Baseline CSP for all paths; headers on Worker responses |
| R20 | Low [B] | Empty 404 body | `public/404.html` + `not_found_handling` |

## 3. Build checks

| ID | Sev | Finding | Fix |
|---|---|---|---|
| R21 | Med [B] | "Visible copy" check is a substring test: hidden sections pass; changed `mailto:` target passes; `40` matched inside `1,400+`; Skills item removal missed | Section-aware element checks + link-target checks |
| R22 | Med [X] | `<meta description>`/Open Graph hand-written, can drift from `content.json` | Generate or verify head metadata |
| R23 | Med [C] | Date logic does not converge in one run (dirty-check covers only two inputs); depends on git + wall clock | Content-hash-based `dateModified` |
| R24 | Low [B] | JSON spliced into `<script>` without escaping `<` | Escape `<` as `<` |
| R25 | Low [X] | Build writes files before rejecting invalid output | Validate first, then write |
| R26 | Low [B] | Inline style/script guards bypassable (quotes/case/attributes) | Robust detection |
| R27 | Low [X] | `security.txt` expiry: invalid date crashes; no upper bound | Validate finite date, ≤ 1 year |
| R28 | Low [X] | Docs describe the employer denylist as a general guard | Reword (a denylist cannot detect every employer) |

## 4. MCP protocol polish

| ID | Sev | Finding |
|---|---|---|
| R30 | Low [X] | Numeric JSON-RPC IDs beyond 2^53 lose precision |
| R31 | Low [X] | Empty `Origin:` header accepted |
| R32 | Low [X] | Email validation accepts `.a@`, `a..b@`, `a.@`; lowercases the case-sensitive local part |
| R33 | Low [X] | Lengths counted in UTF-16 units, not code points (schema mismatch) |
| R34 | Low [X] | MIME text body uses LF, not CRLF |
| R35 | Low [X] | `initialize` params (`capabilities`, `clientInfo`) and client-response shapes not validated |
| R36 | Low [C] | Bidi-override and zero-width characters pass into the Subject |
| R37 | Low [C] | `+tag` / Gmail-dot variants bypass the per-sender cap |
| R38 | Low [C] | Redirect returns 301 for POST (becomes GET) — use 308 for non-GET/HEAD |
| R39 | Nit [B] | Server version duplicated in `server.json` and `handler.js` |
| R40 | Low [B] | Quota DO stores raw IP keys indefinitely; unsalted sender hashes; privacy docs inaccurate; no privacy notice |
| R41 | Low [B] | Tests: no coverage for bad protocol header, OPTIONS, declared Content-Length; harness re-implements the DO; weak malformed-RPC assertion |
| R42 | Low [X] | Built-in clients (smoke, WebMCP) skip the MCP lifecycle / protocol header |

## 5. Docs, assets, hygiene

| ID | Sev | Finding |
|---|---|---|
| R50 | Nit [X] | HTML is ~45 KB, not "~30 KB"; quota errors are 1027, not 429 |
| R51 | Low [X] | Print CSS targets non-existent `.frame`; "one-page CV" over-claimed |
| R52 | Nit [C] | `tfp.pvieira.co.uk` A record documented but does not exist |
| R53 | Low [B] | Icon/share-card generators not reproducible (unpinned `sharp`, local fonts); card not drift-checked |
| R54 | Nit [B] | No `engines`; docs say `npm install` despite lockfile |
| R55 | Nit [C] | `npm audit`: 3 high in dev-only tooling (sharp via miniflare via wrangler) |
| R56 | Low [X] | Fonts cached `immutable` without fingerprinted filenames; images `max-age=0` |
| R57 | Low [X] | Possible reflow failure at large text size (`.skills` 13rem minimum) |
| R58 | Nit [C] | `■` in the Profile label is announced by screen readers |
| R59 | Nit [C] | `addressCountry` should be `GB` |
| R60 | Low [B] | Design-preview tooling would republish candidates containing old employer copy and Google Fonts |
| R61 | Nit [X] | Biased shuffle in `build-preview.mjs`; raw Codex transcripts committed |
| R62 | Low [B] | Dashboard-owned config only in prose; rollback covers one Worker; Registry key single copy |

## 6. Owner decisions

| ID | Question | Default taken |
|---|---|---|
| D1 | JSON-LD `identifier` points at `did.json`, whose `alsoKnownAs` lists DIDs on an employer's domain — a subtle link from the employer-agnostic site | **Keep** for now (file is already public; reversible) |
| D2 | Export dashboard config (rules, DNS) into the repo as code | Read-only export script, later |
| D3 | Test federated sign-in before deleting `patrickjv-did` | Scheduled (~13 Oct) |
