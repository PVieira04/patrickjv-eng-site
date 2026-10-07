# 06 — Operations

## Deploying

**Normal path: push to `main`. Cloudflare Workers Builds deploys** (since 7 Oct 2026, replacing the GitHub Actions `deploy.yml`; decision [D4](reviews/2026-10-06-merged-review.md#6-owner-decisions)). Each of the three Workers is connected to the GitHub repo `PVieira04/patrickjv-eng-site`, production branch `main`; Cloudflare clones the repo, runs the build command and then the deploy command with a **Cloudflare-managed build token**. **No Cloudflare credential is needed in GitHub** (the old Actions secret was deleted on 7 Oct — [owner clean-up](#no-ci-deploy-token-any-more-owner-clean-up)). Non-production (other-branch) builds are **off**. Node is pinned by `.node-version` (`24`).

| Worker | Build command | Deploy command | Build watch paths |
|---|---|---|---|
| `patrickjv-eng-site` | `npm ci && npm test` | `npx wrangler deploy` | include `*`; exclude `docs/*`, `README.md`, `designs/*` |
| `patrickjv-redirect` | `npm ci && npm test` | `npx wrangler deploy -c redirect/wrangler.jsonc` | include `redirect/*` |
| `patrickjv-mcp` | `npm ci && npm test` | `npx wrangler deploy -c mcp/wrangler.jsonc` | include `mcp/*`, `lib/*`, `content.json` |

The tests (build drift check + unit tests) run inside every build, before its deploy command: a red `npm test` deploys nothing. The configuration lives in the Cloudflare dashboard (Worker → Settings → Build), not in the repo; the wrangler configs only carry a header comment saying so.

**Watch-path caveat.** A Worker rebuilds only when a push changes a file inside its include list (and outside its excludes). Editing `content.json` rebuilds the site and the MCP Worker, **not** the redirect Worker; editing only `docs/` rebuilds nothing. A change to shared code outside a Worker's include list (for example `package.json` or `package-lock.json` for the MCP Worker) does **not** redeploy it until a later push touches its paths — redeploy by hand if it must ship now. The monitor's "main is deployed" ignore list must stay equal to the site's excludes (`test/workflows.test.mjs` checks this table against the workflow).

**Seeing builds.** Cloudflare dashboard → Workers & Pages → the Worker → **Deployments** (versions) and **Builds** (logs per commit). In GitHub, each build reports a check run on its commit, named exactly `Workers Builds: patrickjv-eng-site`, `Workers Builds: patrickjv-redirect` and `Workers Builds: patrickjv-mcp` (app `cloudflare-workers-and-pages`) — first seen on `bbf5caa`, all three successful. Before a risky change, record the current version of each Worker (`npx wrangler deployments list`, with `-c redirect/wrangler.jsonc` and `-c mcp/wrangler.jsonc` for the others) so a rollback target is known.

**Rollback.** `npx wrangler rollback <version-id>` per Worker, or the dashboard's Deployments view ([Rollback](#rollback)). A rollback holds only until the next build of that Worker: a later push inside its watch paths redeploys `main`, so fix or revert on `main` too.

**Manual fallback** (Workers Builds unavailable): `npm ci`, then `npm run deploy` — runs `npm test`, then `wrangler deploy` for the site, the redirect Worker and the MCP Worker, using Wrangler's OAuth login. Then `npm run smoke -- https://patrickjv.com --aliases --mcp --registry --strict-https` — and check response headers on the live site, not just under `wrangler dev` (see [Incidents](#incidents)). Deploy only `main`'s head by hand. A manual deploy produces no check run, so the monitor keeps comparing production with the last commit whose **Workers Builds** site build succeeded and will FAIL "deployed = repo" if the manual deploy shipped a different commit, until the next successful site build (retrying the latest build in the dashboard should record it — not yet tried).

Right after a deploy, Cloudflare can briefly serve the previous version from some locations (a minute or so); re-check before assuming a regression.

<a id="ci"></a>
## CI

GitHub Actions no longer deploys and holds **no secrets**. Both workflows use actions pinned to full commit SHAs — `actions/checkout` **v7.0.1** (`3d3c42e…`) and `actions/setup-node` **v7.0.0** (`8207627…`), both on the Node 24 action runtime — plus `persist-credentials: false`, least-privilege `permissions`, the `ubuntu-24.04` runner and Node 24. **Dependabot** (`.github/dependabot.yml`) opens weekly PRs for GitHub Actions (bumping the pinned SHA and its version comment together) and npm (dev dependencies grouped into one PR); each PR runs `test.yml`, nothing merges itself. `test/workflows.test.mjs` guards the properties below (revert-and-fail verified).

| Workflow | When | What |
|---|---|---|
| `test.yml` | Every push and pull request | `npm ci --ignore-scripts`, `npm test`. No secrets. (Workers Builds runs the same `npm test` again before each deploy.) |
| `monitor.yml` | Every 6 hours, on demand, and on every completed `Workers Builds: …` check run | Scheduled/dispatch: live smoke against the last deployed commit, plus "main is deployed". Check run: build-failure alert and post-deploy smoke (see [Monitoring](#monitoring)). Permissions `contents: read`, `checks: read` only. |

**Stale SHAs and races (reviews Codex-1, Codex-6).** Workers Builds builds the commit that was pushed; there is no GitHub re-run that could redeploy an old SHA. Rollback is a deliberate `wrangler rollback`. Two residuals, both **unverified**: whether Workers Builds cancels or serialises a build that a newer push supersedes, and whether two quick pushes can finish out of order (leaving the older commit live). The monitor covers both: the post-deploy smoke is skipped if a newer `main` commit has its own site build, and the scheduled "deployed = repo" checks compare production with the newest successfully built commit, so an out-of-order finish FAILs there.

**Concurrency.** Scheduled and dispatched monitor runs share the group `monitor` (queue, never cancel; GitHub keeps one pending run per group, and displacing a pending monitor is harmless). Check-run runs use one group per commit **and** Worker, so one Worker's pending run never displaces another's alert.

**Transitional note.** The monitor runs `smoke.mjs` from the *deployed* commit with the flags in `main`'s `monitor.yml`. A new smoke flag therefore reaches the monitor only once the commit that adds it is deployed; if that deploy fails, the monitor fails with a usage error until it succeeds. `check_run` runs always use the default branch's `monitor.yml`.

<a id="token-rotation"></a>
### No CI deploy token any more: owner clean-up

Until 7 Oct 2026 `deploy.yml` deployed with `CLOUDFLARE_API_TOKEN`, a repository-level Actions secret (an "Edit Cloudflare Workers" template token, readable by a workflow on any branch — review C3-F1). Workers Builds removes the need for it. Nothing in the repo reads `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` or `DEPLOY_ENABLED` any more (`test/workflows.test.mjs` fails if a workflow references any secret). Owner steps, in this order:

1. ~~Cloudflare → My Profile → API Tokens → the GitHub Actions Workers token (created 6 Oct 2026) → **Delete**~~ — **done 7 Oct** (the Workers Builds token Cloudflare manages for the build is kept)
2. ~~`gh secret delete CLOUDFLARE_API_TOKEN`~~ — **done 7 Oct**
3. ~~`gh variable delete DEPLOY_ENABLED`~~ — **done 7 Oct**
4. ~~`gh variable delete CLOUDFLARE_ACCOUNT_ID`~~ — **done 7 Oct**. The repo now has **no Actions secrets or variables**.

Production does not depend on any of these: deleting them changes nothing live.

## Monitoring

`.github/workflows/monitor.yml` has two jobs.

**`smoke`** — every **6 hours** at 00:17, 06:17, 12:17 and 18:17 UTC, and on demand:

1. **Find the last deployed commit**: the newest of `main`'s last 30 commits whose `Workers Builds: patrickjv-eng-site` check run (app `cloudflare-workers-and-pages`) concluded `success`. Commits that only touch files outside the site's watch paths have no site build and are skipped. Errors if none is found.
2. **Smoke** that commit — checked out at that SHA, so "deployed = repo" compares like with like (review Codex-6): `node smoke.mjs https://patrickjv.com --aliases --mcp --registry --strict-https --dns` — **30 checks**, each **PASS**, **WARN** or **FAIL**, written to the run's step summary.
3. **main is deployed**: if `main`'s head differs from the deployed commit in any file outside the site's watch-path excludes (`docs/*`, `README.md`, `designs/*` — keep equal to the dashboard), it reads the head's `Workers Builds: patrickjv-eng-site` check run: queued or in progress → notice; concluded `failure`, `cancelled` or anything but success → **error "Workers Builds failed"**; no check run at all → **error** "main is not deployed".

**`build-result`** — on every completed check run whose app is `cloudflare-workers-and-pages` and whose name starts with `Workers Builds: ` (other check runs start the workflow but skip the job):

- **Build-failure alert**: any conclusion other than `success` fails the run with an error naming the Worker ("Workers Builds failed: patrickjv-mcp"). This is the deploy-failure notification.
- **Post-deploy smoke**, site build only (one smoke per push, not three): skipped if a newer `main` commit has its own site build; otherwise checks out the check run's `head_sha` and runs `node smoke.mjs https://patrickjv.com --aliases --mcp --strict-https` up to 5 times, waiting 20, 40, 60, 80 s between attempts (edge propagation). The result goes to the step summary.

The run fails on any FAIL. Every check requires its exact success status, and media types are compared exactly (`type/subtype`, parameters ignored). No redirects are followed, each request has a 10 s deadline, and one failing check never stops the rest. `test/smoke.test.mjs` runs the script against a local mock of the site, correct by default and broken one way at a time, and unit-tests the verdict helpers.

- `did.json`: 200, `application/json`, no redirect; live bytes and the repo copy both match the frozen sha256
- `/`, `/index.md`, `/llms.txt`, `/robots.txt`, `/sitemap.xml`, `/.well-known/security.txt`, `/photo.webp`, `/og-card.jpg`, `/favicon.ico`: 200, the expected media type, and **deployed = repo** (sha256 of the live body equals the repo file)
- `/` returns 200 with HSTS, `nosniff`, and exactly the CSP that `public/_headers` sets for `/`
- `Accept: text/markdown` on `/` returns 200 `text/markdown` whose body equals `public/index.md`
- `security.txt`: 200 `text/plain` and `Expires` more than 30 days ahead
- A missing font path (`/fonts/does-not-exist.woff2`) returns 404 with at most one CSP header and without the fonts' 30-day cache
- `http://patrickjv.com/` redirects to HTTPS — FAIL with `--strict-https` (used by CI since Always Use HTTPS was enabled on 7 Oct); WARN without it
- `--aliases`: `www.patrickjv.com`, `pvieira.co.uk`, `www.pvieira.co.uk` GET → 301 to `https://patrickjv.com/a/b?x=1`; POST → 308 (a 301 is a FAIL); **no `NEL`/`Report-To`** on `patrickjv.com` or `pvieira.co.uk` (FAIL on either). The NEL checks reuse responses already fetched, adding no requests
- `--mcp`: `initialize` (version `2025-11-25`, `serverInfo.name` = `patrickjv.com`, `serverInfo.version` = `server.json`), `notifications/initialized` → 202, `tools/list` = exactly the five tools, each with icons, `tools/call list_faq` items deep-equal to `content.json`'s `faq`, and **`patrickjv/health` → `introReady: true`** (FAIL otherwise — [readiness](04-mcp-and-webmcp.md#readiness)). Read-only; never calls `request_intro`. Five requests in all, inside the edge limit of 6 per 10 s per IP
- `--registry`: `com.patrickjv/profile` is active on the MCP Registry with the same version and remote
- `--dns` (DNS-over-HTTPS to `cloudflare-dns.com`, three queries): `patrickjv.com` **CAA** present (FAIL if not); **DNSSEC** — a DS record at the parent and an authenticated (AD) in-zone answer — **WARN** while the DS is missing (registrar publication pending, review C3-F7); exactly one **DMARC** record at `_dmarc.patrickjv.com` (FAIL if none or several)

On 7 Oct, after the round-2 deploy and the zone hardening, the then 24-check run with `--strict-https` gave 24 passed. On 7 Oct after the round-3 fixes (not yet deployed), the 30-check run gave 23 passed, 3 warned (`pvieira.co.uk` NEL, DNSSEC DS pending, Registry timeout), 4 failed — all four expected until the deploy: `/` and `/sitemap.xml` bytes and the `/` CSP (the page script and `dateModified` changed) and `patrickjv/health` (method not yet deployed). The Registry check allows 30 s and reports an unreachable Registry as WARN (it is a third-party service; 12 s responses and timeouts have been observed), while a wrong or missing listing FAILs.

A failed scheduled run notifies according to GitHub's Actions notification settings — GitHub sends scheduled-run notifications to the user who last modified the cron schedule, and only if that user has Actions notifications on. Check those settings rather than assuming an email will arrive. Runs started by a `check_run` event (the build-failure alert) are triggered by Cloudflare's app, not by you or a schedule: **whether GitHub notifies you of a failed `build-result` run is unverified** — check after the first real failure, and watch the Actions tab (or Cloudflare's own build notifications) until then. The monitor does **not** check email delivery: `patrickjv/health` shows configuration only; delivery failures appear as redacted `mcp_failure` events (`email`, `quota`, `config`) in Workers Logs, so an occasional manual test introduction is still worthwhile.

<a id="rollback"></a>
## Rollback

**Any Worker, to an earlier version** (fastest; used in the 6 Oct incident):

```bash
npx wrangler deployments list                                  # find the previous version id
npx wrangler rollback <version-id> -m "reason"                 # site Worker
npx wrangler rollback <version-id> -c redirect/wrangler.jsonc  # redirect Worker
npx wrangler rollback <version-id> -c mcp/wrangler.jsonc       # MCP Worker
```

Each Worker is rolled back separately — record all three versions before a deploy. Wrangler's OAuth login can do this; the dashboard (Worker → Deployments) can too. A rollback lasts until the next Workers Builds build of that Worker: a later push inside its watch paths redeploys `main`.

**`patrickjv.com` to the old `patrickjv-did` Worker** (static assets: `did.json` only — still deployed):

```bash
T=$(npx wrangler auth token | tail -1)
curl -X PUT -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/domains \
  -d '{"hostname":"patrickjv.com","service":"patrickjv-did","environment":"production","zone_id":"<patrickjv.com zone id>","override_existing_origin":true}'
```

The forward switch used the same call with `"service":"patrickjv-eng-site"`.

<a id="incidents"></a>
## Incidents

### 6 Oct 2026, 22:23–22:27 UTC — page style and script blocked by a double CSP

- **What happened.** The review-fix release (deployed manually at 22:23 UTC) set a baseline `Content-Security-Policy` on `/*` and removed it from `/` with a `! Content-Security-Policy` detach line, then set the page's own policy on `/`. Under `wrangler dev` the detach worked. **In production, Workers static-asset `_headers` does not honour `! Header` detach lines**, so browsers received both policies; a resource must satisfy every policy, and the baseline (`default-src 'none'`, no hashes) blocked the page's inline style and script. The page rendered unstyled and WebMCP did not register. `did.json`, the MCP server and the redirects were unaffected.
- **Detection.** The new strict smoke check (`/ security headers … CSP = public/_headers`) failed straight after the deploy — the live CSP header did not equal the one policy `_headers` was expected to produce.
- **Mitigation.** `npx wrangler rollback` of the site Worker to the previous (pre-review) version at 22:25 UTC, which served until the fix. About two minutes of broken styling, four minutes in all.
- **Fix** (`8c90261`, deployed 22:27 UTC). No CSP on `/*`; the page policy only on `/` and `/index.html`; the baseline set explicitly on each known non-HTML path; `404.html` (served at arbitrary paths) carries its own policy in a build-maintained `<meta http-equiv>`.
- **Guard.** The build now fails on any `! Header` line, any CSP on `/*` or on a wildcard rule, and any path pattern given a CSP by two rules — unit-tested with fixtures since round 2 (revert-and-fail verified). The smoke check still compares the live CSP on `/`, and checks a missing font path for a doubled CSP.
- **Lessons.** Local dev is not production: verify response headers on the live site after every header change. A strict monitor that compares against the repo catches real regressions within minutes. Record every Worker's version before deploying, so rollback is one command.

## Credentials, keys and where they live

| Thing | Location | Notes |
|---|---|---|
| Cloudflare (personal account) | Wrangler OAuth on the dev machine (`~/.config/.wrangler`) | Cannot touch DNS or rulesets — use the dashboard for those |
| MCP Registry signing key | `~/.config/mcp-registry/key.pem` (600) | Back it up (password manager). Public half: `public/.well-known/mcp-registry-auth` (keep deployed). **If lost:** generate a new ed25519 key, replace the public key in `mcp-registry-auth`, deploy, then `mcp-publisher login http` with the new key — ownership is proven by the domain, not the old key. |
| Google Search Console proof | DNS TXT on `patrickjv.com` | Keep it |
| GitHub Pages domain verification | DNS TXT `_github-pages-challenge-pvieira04.patrickjv.com` (added 7 Oct 2026; `patrickjv.com` verified under GitHub → Settings → Pages → Verified domains, review C3-F6) | **Keep it** — GitHub re-checks it, and removing it un-verifies the domain, re-opening the takeover risk for `tenlines` (a CNAME to `pvieira04.github.io`). If the `tenlines` Pages site is retired, delete its CNAME first |
| `QUOTA_SALT` | Worker secret on `patrickjv-mcp` (set 6 Oct 2026 with `wrangler secret put QUOTA_SALT -c mcp/wrangler.jsonc`) | Keys the HMAC of the quota counters' IP and sender keys. **Required**: if it is missing or shorter than 32 characters, `request_intro` is refused (tool error, logged as subsystem `config`); the read tools carry on. Not stored anywhere else and not needed elsewhere; if it is changed, the day's per-IP and per-sender counts restart (the global count does not). |
| Workers Builds build token | Managed by Cloudflare (Workers Builds, since 7 Oct 2026) | Not in GitHub. The old GitHub Actions token `CLOUDFLARE_API_TOKEN` is unused — delete it ([owner clean-up](#token-rotation)) |
| GitHub Actions `GITHUB_TOKEN` | Per run, automatic | `contents: read` (test); `contents: read` + `checks: read` (monitor, to read Workers Builds check runs) |
| GitHub | `gh` CLI (has `user` scope, used to set the profile website/bio) | Remove with `gh auth refresh -h github.com -r user` if unwanted |

Not stored anywhere: the Immich API key used to fetch the portrait (deleted locally and revoked in Immich).

<a id="mcp-registry-updates"></a>
## MCP Registry updates

```bash
cd mcp   # edit server.json: bump "version"
mcp-publisher validate
K="$(openssl pkey -in ~/.config/mcp-registry/key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
mcp-publisher login http --domain patrickjv.com --private-key "$K" </dev/null; unset K
mcp-publisher publish
```

## Renewals and guards

| Item | When | Guard |
|---|---|---|
| `security.txt` `Expires` | 2027-10-06 | Build fails from 2027-09-06 |
| Domain `patrickjv.com` | 2027-04-03 | Check auto-renew and payment method in Cloudflare Registrar |
| Domain `pvieira.co.uk` | 2027-06-14 | As above |
| `did.json` | Never edit | Build + 6-hourly monitor |
| Google TXT record | Permanent | — |

## Follow-ups

| Date | Action |
|---|---|
| Any time | **Test `did:web` federated sign-in with `patrickjv.com`** — the one check not yet done since the switch-over (parked) |
| ~13 Oct 2026 | If sign-in works, **delete the `patrickjv-did` Worker**; if not, roll back (above) |
| ~20 Oct 2026 | Check indexing (Search Console, Bing), search "Patrick Vieira platform engineer", ask ChatGPT/Claude/Perplexity; then promote the AEO learning-log entry |
| When there is a first article | Build the writing section |

Ready-to-paste `/schedule` commands for the two dated follow-ups (each opens a GitHub issue on the day) were provided in the session that built the site.

<a id="owner-actions-still-open"></a>
### Owner actions still open

From the [review](reviews/2026-10-06-merged-review.md) (rounds 1–3). These need the Cloudflare dashboard, the GitHub settings UI or a decision; Wrangler's OAuth cannot change DNS, rulesets or zone settings. Re-checked on 7 Oct.

| Review | Action | Then |
|---|---|---|
| R3 | `patrickjv.com` DMARC is `p=none; rua=mailto:hello@patrickjv.com; fo=1` (monitoring) | After ~2 weeks of clean aggregate reports, `p=quarantine`, then `p=reject`. `fo=1` does nothing without a `ruf` address (C3-F13) — drop it at the same edit, or leave it as harmless |
| Codex-3 / C3-F13 | `marineweather.patrickjv.com` has its **own** DMARC `v=DMARC1; p=none;` with **no `rua`**: it overrides the apex policy and reports nowhere | Add `rua=mailto:hello@patrickjv.com`; check the actual From, DKIM (`resend._domainkey`, a **1024-bit** key — regenerate at 2048 if Resend allows) and MAIL FROM (`send.marineweather`, Amazon SES) alignment in the reports; then tighten its own policy |
| R4 / C3-F7 | DNSSEC is enabled on `patrickjv.com`, but the **DS record is not published** at the registrar (RDAP `delegationSigned: false`), so there is no protection yet | Cloudflare Registrar should publish it automatically; if `smoke --dns` still WARNs after a few days, chase it (Cloudflare dashboard → DNS → Settings → DNSSEC, or Registrar support) |
| R6 | Tighten the "Markdown for agents" rule so `q=0` or an HTML-first `Accept` does not get Markdown | — |
| R7 | The redirect Worker is still metered with no rate limit — an alias flood could use up the account's daily Worker quota (which the MCP Worker shares). Replace it with free Single Redirect rules, or widen the WAF rule to the alias hosts | — |

## Useful commands

```bash
npx wrangler deployments list                       # site Worker history
npx wrangler deployments list -c mcp/wrangler.jsonc # MCP Worker history
npx wrangler tail patrickjv-mcp                     # live MCP logs
gh workflow run monitor.yml && gh run watch          # run the monitor now
```
