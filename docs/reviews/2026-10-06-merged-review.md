# Adversarial review — merged findings (6–7 Oct 2026)

Two independent reviewers received an identical prompt: review the entire repository **and** the deployed site, adversarially, for everything big and small.

- **Claude Opus 5.5** (subagent, live network access): 26 findings.
- **Codex gpt-6.1-sol** (read-only sandbox, **no network** — worked from a live snapshot): 50 findings. Raw report: [2026-10-06-codex-gpt-6.1-sol.md](2026-10-06-codex-gpt-6.1-sol.md).

After de-duplication: ~55 distinct findings, **none Critical**. Both agreed on every High. Source: **[B]** both, **[C]** Claude only, **[X]** Codex only. **Owner** = needs a Cloudflare dashboard change (Wrangler's OAuth cannot edit DNS, rulesets or zone settings). **Status** records the outcome after the three fix branches (`c1d1637`, `9d50958`, `778d2c5`, merged as `3f42cff`, `65a46ad`, `2e49a17`) and the production CSP fix (`8c90261`), updated after the Codex round-2 fixes ("round 2", see [§7](#7-round-2-codex)): **Fixed** (commit), **Docs fixed**, **Partially fixed** (what remains), **Owner, pending** (dashboard change not yet made) or **Not done** (why). Owner items were re-checked live on 6 Oct after the fixes. Round 3 (7 Oct) is in [§8](#8-round-3-claude--codex); where it found a fix incomplete, the row below says so.

## 1. Edge, DNS and email (Owner)

| ID | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| R1 | High [B] | `http://patrickjv.com` serves the page, `did.json` and `/mcp` over plaintext (no HTTP→HTTPS) | SSL/TLS → Edge Certificates → **Always Use HTTPS** | **Fixed 7 Oct** (API, scoped zone token): Always Use HTTPS on — `http://patrickjv.com/*` 301s to HTTPS with path and query (did.json included); smoke and CI now run with `--strict-https` |
| R2 | High [B] | `pvieira.co.uk`: two SPF records (permerror), template DMARC (`pct100`, `youremailaddress@yourdomain.com`), Hostinger MX after registrar move (possibly dangling), Elastic Email DKIM `api._domainkey` and `tracking` leftovers | Delete the 7 legacy records; add null MX, `v=spf1 -all`, `v=DMARC1; p=reject; adkim=s; aspf=s`, `*._domainkey "v=DKIM1; p="` (domain sends/receives no mail) | **Fixed 6 Oct** (via API with a scoped DNS token): 7 legacy records deleted (Hostinger MX ×2, both SPF, template DMARC, Elastic Email `api._domainkey` and `tracking`); added null MX `0 .`, `v=spf1 -all`, `v=DMARC1; p=reject; adkim=s; aspf=s`, `*._domainkey "v=DKIM1; p="`. Verified via Cloudflare and Google DNS; alias redirects unaffected |
| R3 | Med [B] | `patrickjv.com`: no DMARC, SPF `~all` | DMARC `p=quarantine` with reporting → `reject`; SPF `-all` | **Partially fixed 7 Oct**: SPF `-all`; DMARC published as `p=none; rua=mailto:hello@patrickjv.com; fo=1` (monitoring first, because the apex sends real mail — MCP intros). **Remaining:** tighten to `quarantine`/`reject` once reports show legitimate mail aligns |
| R4 | Med [C] | TLS 1.0/1.1 accepted; no DNSSEC on `patrickjv.com`; [B] no CAA | Min TLS 1.2; enable DNSSEC; CAA for Cloudflare's CAs | **Fixed 7 Oct**: minimum TLS 1.2 (curl with TLS ≤ 1.1 refused, 1.2 → 200); CAA `issue`/`issuewild` for letsencrypt.org, pki.goog, ssl.com plus `iodef` (Cloudflare adds its other CAs automatically; Let's Encrypt also covers the GitHub Pages subdomain); DNSSEC enabled — **pending** registrar DS publication (automatic with Cloudflare Registrar; verify DS appears). **Round 3:** DS still absent (smoke `--dns` WARNs); the alias zone `pvieira.co.uk` still accepts TLS 1.0/1.1 and has no CAA (owner, C3-F3); and the CAA reasoning above was wrong — the apex CAA does **not** govern `tenlines` (a CNAME to `pvieira04.github.io`: CAA lookup follows the CNAME, so github.io's CAA applies) |
| R5 | Med [B] | Cloudflare NEL/`Report-To` headers point at `a.nel.cloudflare.com` (third-party reporting) | Disable NEL if available; correct the privacy claim | **Partially fixed 7 Oct**: NEL disabled on `patrickjv.com` — `Report-To`/`NEL` no longer sent there (verified). **Round 3:** the alias zone `pvieira.co.uk` still sends both on its redirects — **Fixed 7 Oct (owner)**: NEL disabled on `pvieira.co.uk` too (verified: no `NEL`/`Report-To` on the alias redirects); smoke `--aliases` now FAILs on either zone |
| R6 | Low [B] | Markdown rewrite matches any `Accept` containing `text/markdown` (even `q=0`, or `text/html` first) | Tighten the rule expression | **Fixed 7 Oct**: the rule now needs `Accept` to **start with** `text/markdown` (`any(starts_with(http.request.headers["accept"][*], "text/markdown"))`). Verified live: `text/html, text/markdown;q=0` and `…;q=0.1` → HTML; `text/markdown`, `text/markdown, text/html;q=0.9` → Markdown. Free-plan rules cannot parse q-values, so `text/markdown;q=0` listed **first** still gets Markdown — accepted |
| R7 | Med [C] | Redirect Worker is metered and un-throttled: an alias flood could exhaust the account's shared daily Worker quota | Replace with free Single Redirect rules, or widen the WAF rule to cover alias hosts | **Fixed 7 Oct**: Single Redirect rules on both zones (GET/HEAD 301, other methods 308, query kept); the three hosts are proxied `AAAA 100::` placeholders; `patrickjv-redirect` Worker and `redirect/` deleted. Verified live: 301/308 to the exact target on all three hosts, including a trailing-dot host. HSTS kept on `pvieira.co.uk` via the zone HSTS setting; the other redirect security headers are dropped (no body to protect) |
| R8 | Low [C] | Domain expiry (patrickjv.com 2027-04-03, pvieira.co.uk 2027-06-14) untracked | Confirm auto-renew; document | **Docs fixed** (`9f63ab5`); **Owner, pending** — confirm auto-renew |

## 2. Robustness (code)

| ID | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| R10 | Med [X] | WebMCP: current draft exposes `document.modelContext`; page only checks `navigator.modelContext` → **0 tools** on draft-compliant browsers. Registration promises ignored; abort signal ignored | Support both; await/catch registration; honour `signal` | **Fixed** (`778d2c5`) |
| R11 | Med [B] | WebMCP confirm dialog omits `organisation`/`agent`; input not snapshotted; read tools lack `readOnlyHint`; stale comment; description drops "not the footballer" | Show every field; snapshot; annotations; reuse MCP descriptions | **Fixed** (`778d2c5`) — all six fields shown, snapshot sent, `readOnlyHint`, descriptions from the MCP server's `tools()` |
| R12 | Med [B] | Smoke passes against HTTP 500s / duplicate tools; did.json not compared with the frozen hash; no checks for headers/CSP, live page vs repo, Markdown negotiation, HTTP→HTTPS, security.txt, Registry; no timeouts; one failure aborts the rest; argument parsing | Strict, per-check, timed smoke | **Fixed** (`c1d1637`; round 2 closed the false PASSes, N1) — every check requires its success status and exact media type; deterministic files are byte-compared with the repo; Markdown body, MCP server name and FAQ content compared; POST 301 now FAILs; missing-font 404 checked. The header/CSP check covers `/` only |
| R13 | Med [B] | CI never runs tests (gate skips everything, shows green); token job-wide; actions on mutable tags; `persist-credentials` true; no PR validation | Separate test job; token only on deploy step; SHA-pinned actions; `persist-credentials: false`; pinned runner | **Fixed** (`c1d1637`; round 2: the deploy step runs `wrangler deploy` directly — no test rerun with the token — and only `main` can deploy) — superseded 7 Oct: Workers Builds deploys; GitHub Actions only tests and monitors, with no secrets (`test/workflows.test.mjs`) |
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
| D4 | The CI deploy token is a repository-level secret (readable by a workflow on **any branch** — GitHub Free private repos have no branch protection, rulesets or environment protection) and was made from the account-wide "Edit Cloudflare Workers" template; a leak could deploy any Worker, including one serving a forged `did.json` (C3-F1, Codex-4) | Keep deploy-on-push for now; rotate to a least-privilege token with a TTL | **Resolved 7 Oct: Cloudflare Workers Builds** deploys all three Workers; `deploy.yml` deleted; no deploy credential in GitHub. Owner clean-up of the old token, secret and variables: **done 7 Oct** ([06](../06-operations.md#token-rotation)) |

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

## 8. Round 3 (Claude + Codex)

Two more independent reviews of `06a1af7` on 7 Oct: Codex gpt-6.1-sol ([raw report](2026-10-07-codex-round-3.md), offline, live snapshot) and Claude Opus 5.5 ([summary](2026-10-07-claude-round-3.md), live read-only access). **No Critical or High.** What remained sat between components (CI re-runs vs. production, monitor vs. deploy, WAF vs. Worker limits) and outside the repo (the alias zone, the token's scope, DS publication, a subdomain's own DMARC). **Fixed (round 3)** means fixed in the round-3 fix commit — the commit that adds this section — with tests, each new guard revert-and-fail verified; those fixes reach production on that commit's deploy.

| ID | Sev | Finding | Status |
|---|---|---|---|
| Codex-1 | Med | A re-run of an old deploy run (GitHub keeps its SHA) redeploys superseded code, and its own smoke passes | **Fixed (round 3)** — immediately before deploying, the job compares `$GITHUB_SHA` with `main`'s head (`gh api …/commits/main`, read-only `GITHUB_TOKEN`) and skips deploy and smoke with a notice if superseded; fails closed if the API call fails. Rollback stays `wrangler rollback`. **7 Oct:** moot — `deploy.yml` is gone; Workers Builds builds each pushed commit and has no re-run of an old SHA from GitHub. Residual (unverified): whether a superseded build is cancelled, and whether two quick pushes can finish out of order — the monitor skips the post-deploy smoke when a newer site build exists, and its scheduled "deployed = repo" check FAILs if an older commit ends up live |
| Codex-2 / C3-F8 | Med / Low | `request_intro` can be completely unavailable (secret, binding or quota missing) while every check passes | **Fixed (round 3)** — read-only `patrickjv/health` JSON-RPC method returning only booleans `{introReady, salt, email, quota, rateLimits}`, through the full rejection chain; smoke `--mcp` FAILs unless `introReady` is true. Delivery itself is still not monitored (no email is sent by monitoring); alerting on `mcp_failure` events is **not done** (Workers Logs alerting is a dashboard feature) — occasional manual test introductions remain the delivery check |
| Codex-3 / C3-F13 | Med / Low | `marineweather` has its own DMARC `p=none` with no `rua`, overriding the apex; Resend DKIM key is 1024-bit; apex `fo=1` is inert without `ruf` | **Owner** — add `rua`, check alignment, then tighten; regenerate DKIM at 2048 if possible ([06](../06-operations.md#owner-actions-still-open)) |
| Codex-4 / C3-F1 | Med | CI token from the "Edit Cloudflare Workers" template (account-level KV/R2 etc.); repository secret readable from any branch's workflow; leak could forge `did.json` | **Resolved 7 Oct (D4)** — Workers Builds deploys with a Cloudflare-managed token; no workflow references a secret. Old token, `CLOUDFLARE_API_TOKEN` secret and the `DEPLOY_ENABLED`/`CLOUDFLARE_ACCOUNT_ID` variables **deleted 7 Oct** ([06](../06-operations.md#token-rotation)) |
| Codex-5 | Low | WebMCP: an unreadable response body after sending was reported as "Not sent" | **Fixed (round 3)** — once sent, an unreadable/unparseable body or a response without `result`/`error` gives the same "may or may not have been delivered. Do not retry; email hello@…" wording as a network error; server errors pass through |
| Codex-6 / C3-F15 | Low / Nit | Monitor compared live bytes with a fresh `main` checkout and shared no concurrency with deploy: false alarms mid-deploy | **Fixed (round 3)** — monitor joins the `deploy` concurrency group (queue, no cancel), smokes the commit of the last successful deploy run whose deploy step actually ran, and separately FAILs if `main` has undeployed served changes with no deploy queued. **7 Oct:** the shared group is gone with `deploy.yml`; the monitor now smokes the newest commit whose `Workers Builds: patrickjv-eng-site` check run succeeded, notices a queued/in-progress head build and errors on a failed one. A scheduled run that lands mid-build can still compare against a half-propagated edge (no lock across Cloudflare and GitHub) — re-run before chasing it |
| Codex-7 | Low | `paths-ignore: "**/*.md"` skipped deploys of served Markdown under `public/` | **Fixed (round 3)** — ignores only `docs/**`, `README.md`, `designs/**/*.md`. Remaining: a *new* served file is not covered by smoke or the date hash until added to them (none exists today) |
| Codex-8 / C3-F5 | Low / Med | `docs/06` said deploy-on-push and the token did not exist; no rotation procedure | **Docs fixed** — CI as it is (enabled, verified by run 37547188717 on the `06a1af7` push), stale-SHA guard, monitor-vs-deploy, concurrency, rotation procedure, what breaks on revocation |
| C3-F2 | Med | Edge WAF (6 / 10 s per IP) is stricter than the Worker and cancels the R15 handshake exemption for IPv4; 1015 HTML to MCP clients; per-IP caps shared by hosted-client egress; "stops floods" overstated (~51,840 req/IP/day) | **Docs fixed** + **Accepted** (numbers in [04](../04-mcp-and-webmcp.md#which-limit-binds)); **Owner decided 7 Oct: keep 6 / 10 s** (the stricter edge limit is accepted) |
| C3-F3 | Med | Alias zone `pvieira.co.uk` not hardened: NEL on, TLS 1.0/1.1, no CAA, no Always Use HTTPS | **Fixed 7 Oct (owner)** — NEL off, minimum TLS 1.2, Always Use HTTPS on (read back via the API), and the same 11 CAA records as `patrickjv.com` (verified over DoH); docs/01, 05, 07 updated; smoke FAILs on the alias NEL |
| C3-F4 | Med (suspected) | Workers Logs invocation logs retain per-request IP/geo | **Fixed (round 3)** — `observability.logs.invocation_logs: false` on the MCP Worker (schema-checked, dry run clean); custom events still flow; config guarded by a test |
| C3-F6 | Low–Med | `tenlines` GitHub Pages custom domain unverified (takeover risk if the site goes but the CNAME stays) | **Fixed 7 Oct (owner)** — `patrickjv.com` verified under GitHub → Settings → Pages → Verified domains (TXT `_github-pages-challenge-pvieira04`, visible on Cloudflare and Google DoH); delete the CNAME if the site is retired. R4's CAA reasoning corrected |
| C3-F7 | Low | DS not published; docs claimed the protection; nothing monitored it | **Fixed (round 3)** monitoring — smoke `--dns` (in the monitor) WARNs until DS + AD; **Owner** — chase DS publication; docs say "no protection until the DS appears" |
| C3-F9 | Low | Soft 404: `GET /404` returns 200 | **Accepted** — `noindex`, unlinked; no `_redirects` change without verifying production behaviour ([05](../05-quality-and-audits.md)) |
| C3-F10 | Low | `dateModified` moved on non-content changes | **Fixed (round 3)** — hash covers `index.html`, `index.md`, `llms.txt`, `sitemap.xml`, `robots.txt` and page-referenced images only; `_headers`, 404 page, fonts, `security.txt`, `mcp-registry-auth` excluded; convergence kept; tests for both directions |
| C3-F11 | Low | Intro emails carried country and user agent to Gmail | **Fixed (round 3)** — removed (timestamp and unverified-sender note kept); privacy docs list what is processed where |
| C3-F12 | Low | Global cap of 10 a day is easy to exhaust | **Accepted** — 5 senders × 3 IPs, ~4 minutes; protects one mailbox; refusals point to email ([04](../04-mcp-and-webmcp.md#which-limit-binds)) |
| C3-F14 | Nit | WebMCP confirm showed raw input; the server strips bidi/zero-width/control characters | **Fixed (round 3)** — the page normalises exactly as `validateIntro` before the dialog, shows and sends the normalised values (VM test against `validateIntro`; headless Chromium check) |
| C3-F15 | Nit | Actions on Node 20, no Dependabot, `sha_pinning_required` off, no shared concurrency | **Fixed (round 3)** — `actions/checkout` v7.0.1 and `actions/setup-node` v7.0.0 (Node 24), SHA-pinned with version comments; `.github/dependabot.yml` (actions + npm weekly, dev deps grouped); shared concurrency (above). **Owner option:** Settings → Actions → "Require actions to be pinned to a full-length commit SHA" (availability on this plan unverified) |
| C3-F16 | Nit | README presented 6 Oct Lighthouse/axe as current | **Fixed 7 Oct**: Lighthouse 100×4 (mobile and desktop) and axe 0 re-run on the live site after the round-3 deploy; README and docs/05 updated |

**Earlier fixes found incomplete in round 3:**

| ID | What remained | Status |
|---|---|---|
| R4 | Alias zone TLS 1.0/1.1 and no CAA; DS not published; wrong CAA reasoning for `tenlines` | Alias zone **fixed 7 Oct** (TLS 1.2, CAA); DS **Owner** — DNSSEC on, DS not yet published; **Docs fixed** (reasoning); DS monitored by smoke `--dns` |
| R5 | `pvieira.co.uk` still sends NEL/`Report-To` | **Fixed 7 Oct (owner)**; smoke FAILs on either zone |
| R13 | The token secret is readable from any branch's workflow; the docs' credential table was stale | **Resolved 7 Oct (D4)**: Workers Builds; no workflow uses a secret. Owner deletes the old secret; **Docs fixed** |
| R15 | The edge WAF is stricter than the Worker limits, so the handshake exemption barely helps on IPv4 | **Accepted** — owner kept the WAF at 6 / 10 s (7 Oct); documented |
| R40 | "Kept for one day" ignored 30-day Durable Object recovery history; invocation logs; country/client metadata in emails; mailbox retention unstated | **Fixed (round 3)** — tool description now "expire daily"; invocation logs off; metadata removed; docs/05 lists Gmail, counters, the 30-day recovery window and logs. The page footer still has only the one-line note (no separate privacy page); legal completeness against ICO guidance not assessed |
| R12 / N1 / N3 | Smoke still passes when referenced fonts or responsive portraits 404, and does not assess a header CSP's interaction with the 404 page's `<meta>` policy | **Open** — not in round 3's scope; the next smoke extension should fetch every asset referenced by HTML/CSS/`srcset` and require no CSP header on the 404 page |
| R38 | Always Use HTTPS answers `http://` with an edge **301** before the redirect Worker, so an HTTP POST can become GET (checked 7 Oct: `POST http://www.patrickjv.com/a` → 301) | **Accepted** — HTTPS POST gets the Worker's 308; plain-HTTP non-GET to an alias is not a real use. Owner option: an edge redirect rule returning 308 for `http://` |
