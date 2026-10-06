# 06 — Operations

## Deploying

Manual (current): `npm ci`, then `npm run deploy` — runs `npm test` (build drift check + 68 unit tests), then `wrangler deploy` for the site, the redirect Worker and the MCP Worker. **Before deploying, record the current version of each Worker** (`npx wrangler deployments list`, with `-c redirect/wrangler.jsonc` and `-c mcp/wrangler.jsonc` for the others) so a rollback target is known. Then `npm run smoke -- https://patrickjv.com --aliases --mcp --registry` — and check response headers on the live site, not just under `wrangler dev` (see [Incidents](#incidents)).

Right after a deploy, Cloudflare can briefly serve the previous version from some locations (a minute or so); re-check before assuming a regression.

## CI

All workflows use actions pinned to commit SHAs (`actions/checkout` and `actions/setup-node` v4.4.0), `persist-credentials: false`, `permissions: contents: read`, the `ubuntu-24.04` runner and Node 24, and install with `npm ci --ignore-scripts`.

| Workflow | When | What |
|---|---|---|
| `test.yml` | Every push and pull request (also called by `deploy.yml`) | `npm test`. No secrets. |
| `deploy.yml` | Push to `main` (docs-only changes — `docs/**`, `**/*.md` — are skipped) and on demand | Calls `test.yml`; then the `deploy` job runs `npm run deploy` and a post-deploy smoke (`--aliases --mcp`) with up to 5 attempts and growing back-off (the edge can serve the old version briefly). One deploy at a time (`concurrency: deploy`). |
| `monitor.yml` | Every 6 hours and on demand | Live smoke (see [Monitoring](#monitoring)). No secrets. |

### Deploy on push (ready, not yet enabled)

The `deploy` job shows as **skipped** unless the repository variable `DEPLOY_ENABLED` is `true` (secrets cannot be read in an `if:`). The Cloudflare token is exposed **only to the deploy step**, not to the job or the tests. To enable:

1. Cloudflare → My Profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"**; account resources: this account only; zone resources: `patrickjv.com`, `pvieira.co.uk`.
2. `gh secret set CLOUDFLARE_API_TOKEN -R PVieira04/patrickjv-eng-site` (paste when prompted; never in chat).
3. `gh variable set DEPLOY_ENABLED -R PVieira04/patrickjv-eng-site --body true`.

The repo variable `CLOUDFLARE_ACCOUNT_ID` is already set. As of 6 Oct 2026 neither the token nor `DEPLOY_ENABLED` exists, so every deploy so far has been manual.

## Monitoring

`.github/workflows/monitor.yml` runs **every 6 hours** at 00:17, 06:17, 12:17 and 18:17 UTC (and on demand): `node smoke.mjs https://patrickjv.com --aliases --mcp --registry` — **23 checks**, each reported as **PASS**, **WARN** or **FAIL**, with the output written to the run's step summary. The run fails only on a FAIL. No redirects are followed, each request has a 10 s deadline, and one failing check never stops the rest.

- `did.json`: 200, `application/json`, no redirect; live bytes and the repo copy both match the frozen sha256
- `/`, `/index.md`, `/llms.txt`, `/robots.txt`, `/sitemap.xml`, `/photo.webp`, `/favicon.ico`, `/og-card.jpg`: 200 with the expected content type
- The live `/` is byte-identical to the repo's `public/index.html` (fails if commits are not deployed yet)
- `/` sends HSTS, `nosniff`, and exactly the CSP that `public/_headers` sets for `/`
- `Accept: text/markdown` on `/` returns `text/markdown`
- `security.txt`: 200 and `Expires` more than 30 days ahead
- `http://patrickjv.com/` redirects to HTTPS — **WARN** until Always Use HTTPS is turned on; `--strict-https` makes it a FAIL
- `--aliases`: `www.patrickjv.com`, `pvieira.co.uk`, `www.pvieira.co.uk` GET → 301 to `https://patrickjv.com/a/b?x=1`; POST → 308
- `--mcp`: `initialize` (version `2025-11-25`, `serverInfo.version` = `server.json`), `notifications/initialized` → 202, `tools/list` = exactly the five tools, each with icons, `tools/call list_faq` = the `content.json` count (read-only; never calls `request_intro`)
- `--registry`: `com.patrickjv/profile` is active on the MCP Registry with the same version and remote

On 6 Oct after the fixes, a local run gave **22 passed, 1 warned (HTTP→HTTPS), 0 failed**.

A failed scheduled run notifies according to GitHub's Actions notification settings — GitHub sends scheduled-run notifications to the user who last modified the cron schedule, and only if that user has Actions notifications on. Check those settings rather than assuming an email will arrive.

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
- **Guard.** The build now fails on any `! Header` line, any CSP on `/*`, and any path pattern given a CSP by two rules (revert-and-fail verified). The smoke check still compares the live CSP on `/`.
- **Lessons.** Local dev is not production: verify response headers on the live site after every header change. A strict monitor that compares against the repo catches real regressions within minutes. Record every Worker's version before deploying, so rollback is one command.

## Credentials, keys and where they live

| Thing | Location | Notes |
|---|---|---|
| Cloudflare (personal account) | Wrangler OAuth on the dev machine (`~/.config/.wrangler`) | Cannot touch DNS or rulesets — use the dashboard for those |
| MCP Registry signing key | `~/.config/mcp-registry/key.pem` (600) | Back it up (password manager). Public half: `public/.well-known/mcp-registry-auth` (keep deployed). **If lost:** generate a new ed25519 key, replace the public key in `mcp-registry-auth`, deploy, then `mcp-publisher login http` with the new key — ownership is proven by the domain, not the old key. |
| Google Search Console proof | DNS TXT on `patrickjv.com` | Keep it |
| `QUOTA_SALT` | Worker secret on `patrickjv-mcp` (set 6 Oct 2026 with `wrangler secret put QUOTA_SALT -c mcp/wrangler.jsonc`) | Keys the HMAC of the quota counters' IP and sender keys. Not stored anywhere else and not needed elsewhere; if it is changed, the day's per-IP and per-sender counts restart (the global count does not). |
| Cloudflare API token for CI | Not created yet (GitHub secret `CLOUDFLARE_API_TOKEN`) | See [Deploy on push](#deploy-on-push-ready-not-yet-enabled) |
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
| When ready | Enable deploy-on-push (token + `DEPLOY_ENABLED`) |
| When there is a first article | Build the writing section |

Ready-to-paste `/schedule` commands for the two dated follow-ups (each opens a GitHub issue on the day) were provided in the session that built the site.

### Owner actions still open (Cloudflare dashboard)

From the [6 Oct review](reviews/2026-10-06-merged-review.md); Wrangler's OAuth cannot change DNS, rulesets or zone settings. Each was re-checked live on 6 Oct after the fixes and is still outstanding.

| Review | Action | Then |
|---|---|---|
| R1 | SSL/TLS → Edge Certificates → **Always Use HTTPS** (`http://patrickjv.com/` still serves the page with 200) | Add `--strict-https` to `monitor.yml` and `deploy.yml` so a regression fails |
| R2 | `pvieira.co.uk` DNS lockdown: delete the legacy Hostinger MX, both SPF records, the template DMARC and the Elastic Email DKIM/tracking records; add null MX, `v=spf1 -all`, `v=DMARC1; p=reject; adkim=s; aspf=s`, `*._domainkey "v=DKIM1; p="` | — |
| R3 | `patrickjv.com`: add DMARC (`p=quarantine` with reporting, then `reject`); SPF `~all` → `-all` | — |
| R4 | Minimum TLS 1.2 (TLS 1.1 still negotiates); DNSSEC on `patrickjv.com`; CAA records for Cloudflare's CAs | — |
| R5 | Turn off Network Error Logging if the plan allows | Update the privacy caveat in [05](05-quality-and-audits.md#privacy) |
| R6 | Tighten the "Markdown for agents" rule so `q=0` or an HTML-first `Accept` does not get Markdown | — |
| R7 | The redirect Worker is still metered with no rate limit — an alias flood could use up the account's daily Worker quota (which the MCP Worker shares). Replace it with free Single Redirect rules, or widen the WAF rule to the alias hosts | — |

## Useful commands

```bash
npx wrangler deployments list                       # site Worker history
npx wrangler deployments list -c mcp/wrangler.jsonc # MCP Worker history
npx wrangler tail patrickjv-mcp                     # live MCP logs
gh workflow run monitor.yml && gh run watch          # run the monitor now
```
