# 06 — Operations

## Deploying

Manual (current): `npm run deploy` — runs `npm test` (build drift check + 27 unit tests), then `wrangler deploy` for the site, the redirect Worker and the MCP Worker. Then `npm run smoke -- https://patrickjv.com --aliases --mcp`.

Right after a deploy, Cloudflare can briefly serve the previous version from some locations (a minute or so); re-check before assuming a regression.

### Deploy on push (ready, not yet enabled)

`.github/workflows/deploy.yml` runs tests → deploy → smoke on every push to `main`. It **skips cleanly** until the token exists. To enable:

1. Cloudflare → My Profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"**; account resources: this account only; zone resources: `patrickjv.com`, `pvieira.co.uk`.
2. `gh secret set CLOUDFLARE_API_TOKEN -R PVieira04/patrickjv-eng-site` (paste when prompted; never in chat).

The repo variable `CLOUDFLARE_ACCOUNT_ID` is already set.

## Monitoring

`.github/workflows/monitor.yml` runs daily at **06:17 UTC** (and on demand): `node smoke.mjs https://patrickjv.com --aliases --mcp` — **17 checks**:

- `did.json`: status 200, `content-type: application/json`, bytes identical to the repo copy
- `/`, `/index.md`, `/photo.webp`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`: 200
- `www.patrickjv.com`, `pvieira.co.uk`, `www.pvieira.co.uk`: 301 to `https://patrickjv.com/a/b?x=1`
- MCP: `initialize` 200, `notifications/initialized` 202, `tools/list` has 5 tools with icons, `list_faq` returns items (read-only; never calls `request_intro`)

A failed scheduled run emails the repo owner. The first run passed 17/17 from GitHub's runners.

<a id="rollback"></a>
## Rollback

The old `patrickjv-did` Worker (static assets: `did.json` only) is still deployed. To roll back `patrickjv.com`:

```bash
T=$(npx wrangler auth token | tail -1)
curl -X PUT -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/domains \
  -d '{"hostname":"patrickjv.com","service":"patrickjv-did","environment":"production","zone_id":"<patrickjv.com zone id>","override_existing_origin":true}'
```

The forward switch used the same call with `"service":"patrickjv-eng-site"`. Worker versions can also be rolled back with `wrangler rollback`.

## Credentials, keys and where they live

| Thing | Location | Notes |
|---|---|---|
| Cloudflare (personal account) | Wrangler OAuth on the dev machine (`~/.config/.wrangler`) | Cannot touch DNS or rulesets — use the dashboard for those |
| MCP Registry signing key | `~/.config/mcp-registry/key.pem` (600) | **Only copy — back it up.** Public half: `public/.well-known/mcp-registry-auth` (keep deployed) |
| Google Search Console proof | DNS TXT on `patrickjv.com` | Keep it |
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
| `did.json` | Never edit | Build + daily monitor |
| Google TXT record | Permanent | — |

## Follow-ups

| Date | Action |
|---|---|
| Any time | **Test `did:web` federated sign-in with `patrickjv.com`** — the one check not yet done since the switch-over (parked) |
| ~13 Oct 2026 | If sign-in works, **delete the `patrickjv-did` Worker**; if not, roll back (above) |
| ~20 Oct 2026 | Check indexing (Search Console, Bing), search "Patrick Vieira platform engineer", ask ChatGPT/Claude/Perplexity; then promote the AEO learning-log entry |
| When ready | Enable deploy-on-push (token) |
| When there is a first article | Build the writing section |

Ready-to-paste `/schedule` commands for the two dated follow-ups (each opens a GitHub issue on the day) were provided in the session that built the site.

## Useful commands

```bash
npx wrangler deployments list                       # site Worker history
npx wrangler deployments list -c mcp/wrangler.jsonc # MCP Worker history
npx wrangler tail patrickjv-mcp                     # live MCP logs
gh workflow run monitor.yml && gh run watch          # run the monitor now
```
