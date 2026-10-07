# 06 — Operations

## Deploying

**Normal path: push to `main`.** `deploy.yml` runs the tests, deploys the three Workers and smokes the live site (see [CI](#ci)). Deploy-on-push has been **enabled since 6 Oct 2026** (`DEPLOY_ENABLED=true`, `CLOUDFLARE_API_TOKEN` secret set); verified by run [37547188717](https://github.com/PVieira04/patrickjv-eng-site/actions/runs/37547188717), which deployed and smoked the `06a1af7` push. Before a risky change, record the current version of each Worker (`npx wrangler deployments list`, with `-c redirect/wrangler.jsonc` and `-c mcp/wrangler.jsonc` for the others) so a rollback target is known.

**Manual fallback** (CI unavailable, or the token revoked): `npm ci`, then `npm run deploy` — runs `npm test` (build drift check + 106 unit tests), then `wrangler deploy` for the site, the redirect Worker and the MCP Worker, using Wrangler's OAuth login. Then `npm run smoke -- https://patrickjv.com --aliases --mcp --registry --strict-https` — and check response headers on the live site, not just under `wrangler dev` (see [Incidents](#incidents)). A manual deploy is not recorded in Actions, so the monitor keeps comparing production with the last **CI** deploy and will FAIL "deployed = repo" if the manual deploy shipped a different commit: after a manual deploy of `main`, run `gh workflow run deploy.yml --ref main` to record it.

Right after a deploy, Cloudflare can briefly serve the previous version from some locations (a minute or so); re-check before assuming a regression.

<a id="ci"></a>
## CI

All workflows use actions pinned to full commit SHAs — `actions/checkout` **v7.0.1** (`3d3c42e…`) and `actions/setup-node` **v7.0.0** (`8207627…`), both on the Node 24 action runtime (the Node 20 deprecation warning is gone; resolved with `gh api` from the release tags, which point straight at commits) — plus `persist-credentials: false`, least-privilege `permissions`, the `ubuntu-24.04` runner and Node 24, and `npm ci --ignore-scripts`. **Dependabot** (`.github/dependabot.yml`) opens weekly PRs for GitHub Actions (bumping the pinned SHA and its version comment together) and npm (dev dependencies grouped into one PR); each PR runs `test.yml`, nothing merges itself. `test/workflows.test.mjs` guards the properties below (each guard revert-and-fail verified).

| Workflow | When | What |
|---|---|---|
| `test.yml` | Every push and pull request (also called by `deploy.yml`) | `npm test`. No secrets. |
| `deploy.yml` | Push to `main`, unless only `docs/**`, `README.md` or `designs/**/*.md` changed (Markdown under `public/` **is** served, so it deploys — review Codex-7); and on demand | Calls `test.yml` (the only place tests run); then the `deploy` job — `main` only — checks the run's commit is still `main`'s head, runs the three `npx wrangler deploy` commands directly (not `npm run deploy`, which would rerun the tests with the token in their environment) and a post-deploy smoke (`--aliases --mcp --strict-https`) with up to 5 attempts and growing back-off. |
| `monitor.yml` | Every 6 hours and on demand | Live smoke against the last deployed commit, plus "main is deployed" (see [Monitoring](#monitoring)). No secrets beyond its own read-only `GITHUB_TOKEN`. |

**Gates on the deploy job.** It shows as **skipped** unless the repository variable `DEPLOY_ENABLED` is `true` (secrets cannot be read in an `if:`), and it requires `github.ref == 'refs/heads/main'`, so a manual dispatch from another branch cannot deploy. The Cloudflare token is exposed **only to the deploy step**, which runs nothing but `wrangler deploy` — not to the job or the tests.

**Stale-SHA guard (review Codex-1).** GitHub re-runs keep the original commit, so re-running an old deploy after a newer one would put superseded code back — and its own smoke would pass, because it compares production with that old checkout. Immediately before deploying, the job asks the API for `main`'s current head (`gh api repos/<repo>/commits/main` with the run's read-only `GITHUB_TOKEN`) and, if it differs from `$GITHUB_SHA`, **skips the deploy and the smoke** with a "Deploy skipped (superseded)" notice. If that API call fails, the step fails and nothing deploys. A deliberate rollback is a separate operation ([Rollback](#rollback)).

**Concurrency.** `deploy.yml` and `monitor.yml` share the concurrency group `deploy` with `cancel-in-progress: false`: one runs at a time and a running deploy is never cancelled, so the monitor never compares production mid-deploy (review Codex-6/C3-F15). GitHub keeps at most **one pending** run per group — a newer arrival replaces a pending one. Displacing a pending monitor is harmless; a displaced pending deploy would leave `main` undeployed, which the monitor's "main is deployed" check reports.

**Transitional note.** The monitor runs `smoke.mjs` from the *deployed* commit with the flags in `main`'s `monitor.yml`. A new smoke flag therefore reaches the monitor only once the commit that adds it is deployed; if that deploy fails, the monitor fails with a usage error until it succeeds.

<a id="token-rotation"></a>
### The CI deploy token: scope, risk and rotation

**Current state.** `CLOUDFLARE_API_TOKEN` is a **repository-level** Actions secret holding a Cloudflare API token created from the "Edit Cloudflare Workers" template (6 Oct 2026). `CLOUDFLARE_ACCOUNT_ID` is a repository variable. The token's exact effective policy has not been re-inspected since; the template also grants account-level permissions this site does not need (Workers KV, R2 and others — review Codex-4).

**Risk (review C3-F1, owner decision [D4](reviews/2026-10-06-merged-review.md#6-owner-decisions)).** On a private repository on GitHub Free, branch protection, rulesets and environment protection are unavailable, so a repository-level secret is readable by a workflow on **any branch** pushed to this repo — the `github.ref` guard protects only `deploy.yml` itself. Anyone (or any tool) able to push a branch could add a workflow that prints or uses the token. With account-wide Workers permissions, a leaked token could deploy any Worker on the account — including a site that serves a forged `/.well-known/did.json`, which backs `did:web:patrickjv.com` sign-in; the repo's DID guards cannot constrain direct API deployments. Options, for the owner:

1. **Cloudflare Workers Builds** — Cloudflare builds and deploys from the GitHub repo itself, so **no Cloudflare token lives in GitHub** at all (the GitHub App needs read access to the repo). Strongest; the post-deploy smoke would move to the monitor.
2. **Manual deploys only** — delete the secret and set `DEPLOY_ENABLED=false`; deploy with `npm run deploy` (Wrangler OAuth on the dev machine).
3. **Least-privilege token at the next rotation** (the minimum): only the permissions below, with an expiry. This shrinks what a leak can do but does not remove the any-branch exposure.

**What breaks if the secret is revoked or expires:** CI deploys only — the deploy step fails. **Production keeps running unchanged**, and the monitor keeps working (it uses no Cloudflare credential). Manual deploys still work with Wrangler OAuth.

**Rotation procedure** (new token first, old one revoked last, so there is never a gap):

1. Cloudflare → My Profile → API Tokens → **Create Custom Token** (not the template), with only:
   - Account → **Workers Scripts: Edit** (this account only);
   - Zone → **Workers Routes: Edit**, zone resources: **`patrickjv.com` only** (the MCP Worker's `patrickjv.com/mcp*` route is the only route in the three configs; the Custom Domains are attached outside them, so a deploy does not touch them, and `pvieira.co.uk` needs no permission);
   - **no** Workers KV, R2, Pages, D1, Queues or account settings permissions; client IP filtering optional;
   - **TTL**: an end date (e.g. 90 days), noted in [Renewals](#renewals-and-guards).
2. From a **separate terminal** (never paste a token into a chat or a command line): `gh secret set CLOUDFLARE_API_TOKEN -R PVieira04/patrickjv-eng-site` and paste when prompted.
3. `gh workflow run deploy.yml --ref main -R PVieira04/patrickjv-eng-site`, then `gh run watch`.
4. Confirm the run is **green** — the deploy step ran all three `wrangler deploy` commands and the smoke passed. If Wrangler reports a missing permission, add exactly that permission to the new token and repeat step 3.
5. **Revoke the old token** in Cloudflare (My Profile → API Tokens → the old token → Delete). Only now.

## Monitoring

`.github/workflows/monitor.yml` runs **every 6 hours** at 00:17, 06:17, 12:17 and 18:17 UTC (and on demand), in three steps:

1. **Find the last deployed commit**: the newest successful `deploy.yml` run on `main` whose "Deploy site, redirect and MCP Workers" step actually ran (a superseded or disabled run succeeds without deploying). Needs `actions: read`.
2. **Smoke** that commit — checked out at that SHA, so "deployed = repo" compares like with like (review Codex-6): `node smoke.mjs https://patrickjv.com --aliases --mcp --registry --strict-https --dns` — **30 checks**, each **PASS**, **WARN** or **FAIL**, written to the run's step summary.
3. **main is deployed**: if `main`'s head differs from the deployed commit in any file `deploy.yml` does not ignore, and no deploy run is queued, the step FAILs ("the deploy failed, was cancelled or is disabled"). Docs-only differences pass.

The run fails on any FAIL. Every check requires its exact success status, and media types are compared exactly (`type/subtype`, parameters ignored). No redirects are followed, each request has a 10 s deadline, and one failing check never stops the rest. `test/smoke.test.mjs` runs the script against a local mock of the site, correct by default and broken one way at a time, and unit-tests the verdict helpers.

- `did.json`: 200, `application/json`, no redirect; live bytes and the repo copy both match the frozen sha256
- `/`, `/index.md`, `/llms.txt`, `/robots.txt`, `/sitemap.xml`, `/.well-known/security.txt`, `/photo.webp`, `/og-card.jpg`, `/favicon.ico`: 200, the expected media type, and **deployed = repo** (sha256 of the live body equals the repo file)
- `/` returns 200 with HSTS, `nosniff`, and exactly the CSP that `public/_headers` sets for `/`
- `Accept: text/markdown` on `/` returns 200 `text/markdown` whose body equals `public/index.md`
- `security.txt`: 200 `text/plain` and `Expires` more than 30 days ahead
- A missing font path (`/fonts/does-not-exist.woff2`) returns 404 with at most one CSP header and without the fonts' 30-day cache
- `http://patrickjv.com/` redirects to HTTPS — FAIL with `--strict-https` (used by CI since Always Use HTTPS was enabled on 7 Oct); WARN without it
- `--aliases`: `www.patrickjv.com`, `pvieira.co.uk`, `www.pvieira.co.uk` GET → 301 to `https://patrickjv.com/a/b?x=1`; POST → 308 (a 301 is a FAIL); **no `NEL`/`Report-To`** on `patrickjv.com` (FAIL) and on `pvieira.co.uk` (**WARN** until the owner disables NEL on that zone — then make it a FAIL). The NEL checks reuse responses already fetched, adding no requests
- `--mcp`: `initialize` (version `2025-11-25`, `serverInfo.name` = `patrickjv.com`, `serverInfo.version` = `server.json`), `notifications/initialized` → 202, `tools/list` = exactly the five tools, each with icons, `tools/call list_faq` items deep-equal to `content.json`'s `faq`, and **`patrickjv/health` → `introReady: true`** (FAIL otherwise — [readiness](04-mcp-and-webmcp.md#readiness)). Read-only; never calls `request_intro`. Five requests in all, inside the edge limit of 6 per 10 s per IP
- `--registry`: `com.patrickjv/profile` is active on the MCP Registry with the same version and remote
- `--dns` (DNS-over-HTTPS to `cloudflare-dns.com`, three queries): `patrickjv.com` **CAA** present (FAIL if not); **DNSSEC** — a DS record at the parent and an authenticated (AD) in-zone answer — **WARN** while the DS is missing (registrar publication pending, review C3-F7); exactly one **DMARC** record at `_dmarc.patrickjv.com` (FAIL if none or several)

On 7 Oct, after the round-2 deploy and the zone hardening, the then 24-check run with `--strict-https` gave 24 passed. On 7 Oct after the round-3 fixes (not yet deployed), the 30-check run gave 23 passed, 3 warned (`pvieira.co.uk` NEL, DNSSEC DS pending, Registry timeout), 4 failed — all four expected until the deploy: `/` and `/sitemap.xml` bytes and the `/` CSP (the page script and `dateModified` changed) and `patrickjv/health` (method not yet deployed). The Registry check allows 30 s and reports an unreachable Registry as WARN (it is a third-party service; 12 s responses and timeouts have been observed), while a wrong or missing listing FAILs.

A failed scheduled run notifies according to GitHub's Actions notification settings — GitHub sends scheduled-run notifications to the user who last modified the cron schedule, and only if that user has Actions notifications on. Check those settings rather than assuming an email will arrive. The monitor does **not** check email delivery: `patrickjv/health` shows configuration only; delivery failures appear as redacted `mcp_failure` events (`email`, `quota`, `config`) in Workers Logs, so an occasional manual test introduction is still worthwhile.

<a id="rollback"></a>
## Rollback

**Any Worker, to an earlier version** (fastest; used in the 6 Oct incident):

```bash
npx wrangler deployments list                                  # find the previous version id
npx wrangler rollback <version-id> -m "reason"                 # site Worker
npx wrangler rollback <version-id> -c redirect/wrangler.jsonc  # redirect Worker
npx wrangler rollback <version-id> -c mcp/wrangler.jsonc       # MCP Worker
```

Each Worker is rolled back separately — record all three versions before a deploy. Wrangler's OAuth login can do this; no dashboard needed.

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
| `QUOTA_SALT` | Worker secret on `patrickjv-mcp` (set 6 Oct 2026 with `wrangler secret put QUOTA_SALT -c mcp/wrangler.jsonc`) | Keys the HMAC of the quota counters' IP and sender keys. **Required**: if it is missing or shorter than 32 characters, `request_intro` is refused (tool error, logged as subsystem `config`); the read tools carry on. Not stored anywhere else and not needed elsewhere; if it is changed, the day's per-IP and per-sender counts restart (the global count does not). |
| Cloudflare API token for CI | GitHub repository secret `CLOUDFLARE_API_TOKEN` (created 6 Oct 2026 from the "Edit Cloudflare Workers" template; deploy-on-push enabled) | Readable by a workflow on any branch; broader than needed. Rotate to least privilege — see [the CI deploy token](#token-rotation) and decision D4 |
| GitHub Actions `GITHUB_TOKEN` | Per run, automatic | `contents: read` (deploy, test); `contents: read` + `actions: read` (monitor, to read deploy history) |
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
| CI deploy token | At its TTL (set one at the next rotation) | Rotate with the [procedure](#token-rotation) before expiry; an expired token breaks CI deploys only |
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
| R4 / R5 / C3-F3 | Alias zone **`pvieira.co.uk`** has none of the 7 Oct hardening | On that zone: **Network Error Logging off**; **Minimum TLS 1.2**; **Always Use HTTPS** on; **CAA** (`issue`/`issuewild` for the CAs Cloudflare uses, plus `iodef`). Then make smoke's `pvieira.co.uk` NEL check a FAIL |
| C3-F6 | `tenlines.patrickjv.com` is a CNAME to `pvieira04.github.io` (GitHub Pages) whose custom domain is **not verified** in GitHub — if the Pages site is removed but the CNAME stays, someone else's Pages site could claim the name | GitHub → **Settings → Pages → Verified domains** → add `patrickjv.com` (GitHub gives a `_github-pages-challenge-…` TXT record to add). If the Pages site is retired, **delete the `tenlines` CNAME** first |
| R6 | Tighten the "Markdown for agents" rule so `q=0` or an HTML-first `Accept` does not get Markdown | — |
| R7 | The redirect Worker is still metered with no rate limit — an alias flood could use up the account's daily Worker quota (which the MCP Worker shares). Replace it with free Single Redirect rules, or widen the WAF rule to the alias hosts | — |
| C3-F1 / Codex-4 / D4 | The CI deploy token is account-wide and readable from any branch's workflow | Decide: Workers Builds, manual deploys, or least-privilege token — and at minimum rotate to least privilege ([procedure](#token-rotation)) |
| C3-F2 / C3-F12 | The edge WAF rule (6 / 10 s per IP) is stricter than the Worker's limits and is shared by everyone behind one egress address | Decide whether to raise the threshold (e.g. 20 / 10 s) so the Worker's limits bind ([trade-offs](04-mcp-and-webmcp.md#which-limit-binds)) |

## Useful commands

```bash
npx wrangler deployments list                       # site Worker history
npx wrangler deployments list -c mcp/wrangler.jsonc # MCP Worker history
npx wrangler tail patrickjv-mcp                     # live MCP logs
gh workflow run monitor.yml && gh run watch          # run the monitor now
```
