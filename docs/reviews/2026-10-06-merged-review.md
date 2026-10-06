# Adversarial review — merged findings (6 Oct 2026)

Two independent reviewers received an identical prompt: review the entire repository **and** the deployed site, adversarially, for everything big and small.

- **Claude Opus 5.5** (subagent, live network access): 26 findings.
- **Codex gpt-6.1-sol** (read-only sandbox, **no network** — worked from a live snapshot): 50 findings. Raw report: [2026-10-06-codex-gpt-6.1-sol.md](2026-10-06-codex-gpt-6.1-sol.md).

After de-duplication: ~55 distinct findings, **none Critical**. Both agreed on every High. Source: **[B]** both, **[C]** Claude only, **[X]** Codex only. **Owner** = needs a Cloudflare dashboard change (Wrangler's OAuth cannot edit DNS, rulesets or zone settings). **Status** records the outcome after the three fix branches (`c1d1637`, `9d50958`, `778d2c5`, merged as `3f42cff`, `65a46ad`, `2e49a17`) and the production CSP fix (`8c90261`), updated after the Codex round-2 fixes ("round 2", see [§7](#7-round-2-codex)): **Fixed** (commit), **Docs fixed**, **Partially fixed** (what remains), **Owner, pending** (dashboard change not yet made) or **Not done** (why). Owner items were re-checked live on 6 Oct after the fixes.

## 1. Edge, DNS and email (Owner)

| ID | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| R1 | High [B] | `http://patrickjv.com` serves the page, `did.json` and `/mcp` over plaintext (no HTTP→HTTPS) | SSL/TLS → Edge Certificates → **Always Use HTTPS** | **Fixed 7 Oct** (API, scoped zone token): Always Use HTTPS on — `http://patrickjv.com/*` 301s to HTTPS with path and query (did.json included); smoke and CI now run with `--strict-https` |
| R2 | High [B] | `pvieira.co.uk`: two SPF records (permerror), template DMARC (`pct100`, `youremailaddress@yourdomain.com`), Hostinger MX after registrar move (possibly dangling), Elastic Email DKIM `api._domainkey` and `tracking` leftovers | Delete the 7 legacy records; add null MX, `v=spf1 -all`, `v=DMARC1; p=reject; adkim=s; aspf=s`, `*._domainkey "v=DKIM1; p="` (domain sends/receives no mail) | **Fixed 6 Oct** (via API with a scoped DNS token): 7 legacy records deleted (Hostinger MX ×2, both SPF, template DMARC, Elastic Email `api._domainkey` and `tracking`); added null MX `0 .`, `v=spf1 -all`, `v=DMARC1; p=reject; adkim=s; aspf=s`, `*._domainkey "v=DKIM1; p="`. Verified via Cloudflare and Google DNS; alias redirects unaffected |
| R3 | Med [B] | `patrickjv.com`: no DMARC, SPF `~all` | DMARC `p=quarantine` with reporting → `reject`; SPF `-all` | **Partially fixed 7 Oct**: SPF `-all`; DMARC published as `p=none; rua=mailto:hello@patrickjv.com; fo=1` (monitoring first, because the apex sends real mail — MCP intros). **Remaining:** tighten to `quarantine`/`reject` once reports show legitimate mail aligns |
| R4 | Med [C] | TLS 1.0/1.1 accepted; no DNSSEC on `patrickjv.com`; [B] no CAA | Min TLS 1.2; enable DNSSEC; CAA for Cloudflare's CAs | **Fixed 7 Oct**: minimum TLS 1.2 (curl with TLS ≤ 1.1 refused, 1.2 → 200); CAA `issue`/`issuewild` for letsencrypt.org, pki.goog, ssl.com plus `iodef` (Cloudflare adds its other CAs automatically; Let's Encrypt also covers the GitHub Pages subdomain); DNSSEC enabled — **pending** registrar DS publication (automatic with Cloudflare Registrar; verify DS appears) |
| R5 | Med [B] | Cloudflare NEL/`Report-To` headers point at `a.nel.cloudflare.com` (third-party reporting) | Disable NEL if available; correct the privacy claim | **Fixed 7 Oct**: NEL disabled on the zone — `Report-To`/`NEL` headers no longer sent (verified) |
| R6 | Low [B] | Markdown rewrite matches any `Accept` containing `text/markdown` (even `q=0`, or `text/html` first) | Tighten the rule expression | **Owner, pending** |
| R7 | Med [C] | Redirect Worker is metered and un-throttled: an alias flood could exhaust the account's shared daily Worker quota | Replace with free Single Redirect rules, or widen the WAF rule to cover alias hosts | **Owner, pending** — redirect Worker still metered and un-throttled |
| R8 | Low [C] | Domain expiry (patrickjv.com 2027-04-03, pvieira.co.uk 2027-06-14) untracked | Confirm auto-renew; document | **Docs fixed** (`9f63ab5`); **Owner, pending** — confirm auto-renew |

## 2. Robustness (code)

| ID | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| R10 | Med [X] | WebMCP: current draft exposes `document.modelContext`; page only checks `navigator.modelContext` → **0 tools** on draft-compliant browsers. Registration promises ignored; abort signal ignored | Support both; await/catch registration; honour `signal` | **Fixed** (`778d2c5`) |
| R11 | Med [B] | WebMCP confirm dialog omits `organisation`/`agent`; input not snapshotted; read tools lack `readOnlyHint`; stale comment; description drops "not the footballer" | Show every field; snapshot; annotations; reuse MCP descriptions | **Fixed** (`778d2c5`) — all six fields shown, snapshot sent, `readOnlyHint`, descriptions from the MCP server's `tools()` |
| R12 | Med [B] | Smoke passes against HTTP 500s / duplicate tools; did.json not compared with the frozen hash; no checks for headers/CSP, live page vs repo, Markdown negotiation, HTTP→HTTPS, security.txt, Registry; no timeouts; one failure aborts the rest; argument parsing | Strict, per-check, timed smoke | **Fixed** (`c1d1637`; round 2 closed the false PASSes, N1) — every check requires its success status and exact media type; deterministic files are byte-compared with the repo; Markdown body, MCP server name and FAQ content compared; POST 301 now FAILs; missing-font 404 checked. The header/CSP check covers `/` only |
| R13 | Med [B] | CI never runs tests (gate skips everything, shows green); token job-wide; actions on mutable tags; `persist-credentials` true; no PR validation | Separate test job; token only on deploy step; SHA-pinned actions; `persist-credentials: false`; pinned runner | **Fixed** (`c1d1637`; round 2: the deploy step runs `wrangler deploy` directly — no test rerun with the token — and only `main` can deploy) — deploy-on-push still needs the token and `DEPLOY_ENABLED` (owner) |
| R14 | Med [B] | MCP failures silent (bare `catch`); Worker observability off | Workers Logs on; redacted error events | **Fixed** (`9d50958`; round 2: query strings redacted from invocation logs, N6) |
| R15 | Med [C] | Burst limits too tight for shared egress (e.g. the Claude connector): `initialize`/notifications/`tools/list` count; per-IP daily intro cap shared across a provider's users | Exempt handshake from burst; raise read limits; keep sender + global caps | **Fixed** (`9d50958`) — burst 10/10 s excluding handshake, minute 30/60 s, per-IP cap 4 |
| R16 | Low [B] | `workers_dev: true` exposes a duplicate production origin | `workers_dev: false`, `preview_urls: false` | **Fixed** (`778d2c5`; round 2 added `preview_urls: false` to the redirect Worker) — all three Workers have both off |
| R17 | Med [B] | No `Vary: Accept` on the negotiated `/` | Add for `/` and `/index.md` | **Fixed** (`778d2c5`) |
| R18 | Med [B] | Text responses lack `charset=utf-8`; `mcp-registry-auth` has no Content-Type | Explicit types in `_headers` | **Fixed** (`778d2c5`) — verified live |
| R19 | Low [B] | CSP only on `/`; `/mcp`, redirects, `.md`, `.well-known`, 404 lack headers | Baseline CSP for all paths; headers on Worker responses | **Fixed** (`9d50958` Workers, `778d2c5` assets) — asset CSPs reworked to one rule per path in `8c90261` after the production incident; the 404 page uses a `<meta>` CSP; round 2 replaced `/fonts/*` with exact per-file rules so a missing font path gets only that `<meta>` policy (N3) |
| R20 | Low [B] | Empty 404 body | `public/404.html` + `not_found_handling` | **Fixed** (`778d2c5`) |

## 3. Build checks

| ID | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| R21 | Med [B] | "Visible copy" check is a substring test: hidden sections pass; changed `mailto:` target passes; `40` matched inside `1,400+`; Skills item removal missed | Section-aware element checks + link-target checks | **Fixed** (`778d2c5`) — Codex round 2: content hidden by CSS (e.g. `display:none`) still passes; open |
| R22 | Med [X] | `<meta description>`/Open Graph hand-written, can drift from `content.json` | Generate or verify head metadata | **Fixed** (`778d2c5`) — head metadata generated |
| R23 | Med [C] | Date logic does not converge in one run (dirty-check covers only two inputs); depends on git + wall clock | Content-hash-based `dateModified` | **Fixed** (`778d2c5`) — `build-state.json`; round 2 added the served assets' sha256 to the hash (N5) |
| R24 | Low [B] | JSON spliced into `<script>` without escaping `<` | Escape `<` as `\u003c` | **Fixed** (`778d2c5`) |
| R25 | Low [X] | Build writes files before rejecting invalid output | Validate first, then write | **Fixed** (`778d2c5`) — validate, then temp file + rename; round 2 made the write's claims accurate (not transactional) and added a best-effort rollback |
| R26 | Low [B] | Inline style/script guards bypassable (quotes/case/attributes) | Robust detection | **Fixed** (`778d2c5`) |
| R27 | Low [X] | `security.txt` expiry: invalid date crashes; no upper bound | Validate finite date, ≤ 1 year | **Fixed** (`778d2c5`) |
| R28 | Low [X] | Docs describe the employer denylist as a general guard | Reword (a denylist cannot detect every employer) | **Docs fixed** (`9f63ab5`) |

## 4. MCP protocol polish

| ID | Sev | Finding | Status |
|---|---|---|---|
| R30 | Low [X] | Numeric JSON-RPC IDs beyond 2^53 lose precision | **Fixed** (`9d50958`) |
| R31 | Low [X] | Empty `Origin:` header accepted | **Fixed** (`9d50958`) |
| R32 | Low [X] | Email validation accepts `.a@`, `a..b@`, `a.@`; lowercases the case-sensitive local part | **Fixed** (`9d50958`) |
| R33 | Low [X] | Lengths counted in UTF-16 units, not code points (schema mismatch) | **Fixed** (`9d50958`) |
| R34 | Low [X] | MIME text body uses LF, not CRLF | **Fixed** (`9d50958`) |
| R35 | Low [X] | `initialize` params (`capabilities`, `clientInfo`) and client-response shapes not validated | **Fixed** (`9d50958`) |
| R36 | Low [C] | Bidi-override and zero-width characters pass into the Subject | **Fixed** (`9d50958`) |
| R37 | Low [C] | `+tag` / Gmail-dot variants bypass the per-sender cap | **Fixed** (`9d50958`) |
| R38 | Low [C] | Redirect returns 301 for POST (becomes GET) — use 308 for non-GET/HEAD | **Fixed** (`9d50958`) — verified live |
| R39 | Nit [B] | Server version duplicated in `server.json` and `handler.js` | **Fixed** (`9d50958`) |
| R40 | Low [B] | Quota DO stores raw IP keys indefinitely; unsalted sender hashes; privacy docs inaccurate; no privacy notice | **Fixed** (`9d50958` HMAC keys with the `QUOTA_SALT` secret, alarm pruning; `778d2c5` footer privacy note; round 2: alarm always rescheduled while counters exist, N2, and no public fallback key, N4); docs corrected |
| R41 | Low [B] | Tests: no coverage for bad protocol header, OPTIONS, declared Content-Length; harness re-implements the DO; weak malformed-RPC assertion | **Fixed** (`9d50958`) |
| R42 | Low [X] | Built-in clients (smoke, WebMCP) skip the MCP lifecycle / protocol header | **Fixed** — server accepts an absent header (`9d50958`); smoke runs the full lifecycle with the header (`c1d1637`); round 2: the page's WebMCP `fetch` sends `MCP-Protocol-Version: 2025-11-25` and `Accept: application/json, text/event-stream` (still one stateless `tools/call`, no `initialize`, by design) |

## 5. Docs, assets, hygiene

| ID | Sev | Finding | Status |
|---|---|---|---|
| R50 | Nit [X] | HTML is ~45 KB, not "~30 KB"; quota errors are 1027, not 429 | **Docs fixed** (`9f63ab5`) |
| R51 | Low [X] | Print CSS targets non-existent `.frame`; "one-page CV" over-claimed | **Fixed** (`9f63ab5` docs, `778d2c5` print selectors) |
| R52 | Nit [C] | `tfp.pvieira.co.uk` A record documented but does not exist | **Docs fixed** (`9f63ab5`) |
| R53 | Low [B] | Icon/share-card generators not reproducible (unpinned `sharp`, local fonts); card not drift-checked | **Not done** — generators still need an unpinned `sharp` and local fonts; the card is not drift-checked |
| R54 | Nit [B] | No `engines`; docs say `npm install` despite lockfile | **Fixed** (`c1d1637` `engines: >=24`; README now says `npm ci`) |
| R55 | Nit [C] | `npm audit`: 3 high in dev-only tooling (sharp via miniflare via wrangler) | **Not done** — `npm audit` still reports 3 high (dev-only, via wrangler); awaiting an upstream release. An npm `overrides` entry is the fallback |
| R56 | Low [X] | Fonts cached `immutable` without fingerprinted filenames; images `max-age=0` | **Fixed** (`778d2c5`) — fonts 30 days revalidated, images 1 day |
| R57 | Low [X] | Possible reflow failure at large text size (`.skills` 13rem minimum) | **Fixed** (`778d2c5`) — verified live at 320 px with 200% text |
| R58 | Nit [C] | `■` in the Profile label is announced by screen readers | **Fixed** (`778d2c5`) |
| R59 | Nit [C] | `addressCountry` should be `GB` | **Fixed** (`778d2c5`) |
| R60 | Low [B] | Design-preview tooling would republish candidates containing old employer copy and Google Fonts | **Fixed** (`c1d1637`) — preview tooling removed; `designs/PROVENANCE.md` |
| R61 | Nit [X] | Biased shuffle in `build-preview.mjs`; raw Codex transcripts committed | **Fixed** (`c1d1637`) |
| R62 | Low [B] | Dashboard-owned config only in prose; rollback covers one Worker; Registry key single copy | **Docs fixed** (`9f63ab5`; rollback for all three Workers documented after the incident) — **Owner, pending**: back up the Registry key |

## 6. Owner decisions

| ID | Question | Default taken | Status |
|---|---|---|---|
| D1 | JSON-LD `identifier` points at `did.json`, whose `alsoKnownAs` lists DIDs on an employer's domain — a subtle link from the employer-agnostic site | **Keep** for now (file is already public; reversible) | **Kept** (decision stands; reversible) |
| D2 | Export dashboard config (rules, DNS) into the repo as code | Read-only export script, later | **Later** — not done |
| D3 | Test federated sign-in before deleting `patrickjv-did` | Scheduled (~13 Oct) | **Pending** — sign-in not yet tested; ~13 Oct |

## 7. Round 2 (Codex)

A second Codex review ([raw report](2026-10-06-codex-round-2.md)) checked the fixes at `8c90261` and found no new Critical or High defect. Its new findings and remainders, all fixed in round 2 with tests (each guard revert-and-fail verified):

| ID | Sev | Finding | Status |
|---|---|---|---|
| N1 | Med | Smoke could certify wrong responses: POST 301 only a WARN; no status requirement on some checks; content-type prefix match; Markdown, FAQ, server name and asset bodies not compared | **Fixed** — every check requires its success status; exact media type (`type/subtype`); "deployed = repo" sha256 for `/`, `index.md`, `llms.txt`, `robots.txt`, `sitemap.xml`, `security.txt`, portrait, share card, favicon; Markdown negotiation body = `public/index.md`; `serverInfo.name` and `list_faq` items deep-equal `content.json`; POST 301 FAILs; missing-font 404 check; pacing comment corrected (4 MCP requests vs the edge's 6 per 10 s). `test/smoke.test.mjs` runs smoke against a local mock, correct and broken one way at a time |
| N2 | Low | A delayed midnight alarm could consume the only cleanup alarm; legacy counters never got one | **Fixed** — a reservation moves an alarm earlier than the end of the stored day; the alarm handler reschedules when today's counters survive; legacy counters get an alarm on the next reservation, even a refused one |
| N3 | Low | `/fonts/*` gave missing font paths a second CSP (breaking the 404 page's styles) and a 30-day cache | **Fixed** — one exact rule per file in `public/fonts/`; the build refuses CSP on any wildcard rule; `_headers` guard unit-tested with fixtures |
| N4 | Low | Missing `QUOTA_SALT` fell back to a public key | **Fixed** — `request_intro` refuses (tool error, subsystem `config`) unless `QUOTA_SALT` has at least 32 characters; no fallback; read tools unaffected. The secret is set in production |
| N5 | Low | `dateModified` ignored changes to served asset bytes | **Fixed** — sha256 of images, fonts, `security.txt` and `mcp-registry-auth` included in the build-state hash (`did.json` excluded: it has its own frozen check) |
| N6 | Low | Invocation logs could keep query strings | **Fixed** — `observability.redact_query_string: true` on the MCP Worker (key verified against the installed Wrangler schema and a dry run) |
| N7 | Nit | Content coverage tracked values, so a new field with a duplicate value passed | **Fixed** — coverage tracked by `content.json` field path |
| CI (R13) | Med | Deploy step ran `npm run deploy`, rerunning tests with the token; manual dispatch could deploy any branch | **Fixed** — deploy step runs the three `npx wrangler deploy` commands with the token in that step only; job requires `refs/heads/main`; `test/workflows.test.mjs` guards both |
| Atomicity (R25) | — | Comment and CLI claimed temp-file staging left "no mix" / "nothing written" | **Fixed** — wording now accurate (validation failures write nothing; staging is not transactional); failed renames roll back the files already replaced, and the CLI says when outputs may be partial |
| R42 | Low | Page WebMCP request sent no protocol header | **Fixed** — sends `MCP-Protocol-Version: 2025-11-25` and `Accept: application/json, text/event-stream` |
| R16 | Low | Redirect Worker lacked `preview_urls: false` | **Fixed** |

Still open from Codex's round-2 table, not addressed in round 2: **R21** (content hidden by CSS, e.g. `#skills { display:none }`, still passes the page check — the parser does not evaluate CSS), **R53** (generator reproducibility) and **R55** (dev-dependency advisories).
