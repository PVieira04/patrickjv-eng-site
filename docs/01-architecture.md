# 01 — Architecture

Everything runs on one **personal Cloudflare account** (Free plan) with two zones: `patrickjv.com` (primary) and `pvieira.co.uk` (alias).

## Request flow

```
                        ┌──────────────────────────── Cloudflare edge ───────────────────────────────┐
browser / crawler ────► │ URL Rewrite rule "Markdown for agents"                                      │
                        │   path = "/" and Accept contains text/markdown → rewrite to /index.md       │
                        │ WAF rate-limiting rule "MCP flood guard"                                    │
                        │   path starts with /mcp: 6 requests / 10 s per IP → block 10 s (error 1015) │
                        └──────────────┬──────────────────────────────┬───────────────────────────────┘
                                       │                              │
             Custom Domains            │            Route             │            Custom Domains
   patrickjv.com ──────────────► patrickjv-eng-site      patrickjv.com/mcp* ──► patrickjv-mcp
                                 (static assets only,    (MCP server: Durable Object quota,
                                  never runs code)        Email Routing send, rate limits)
   www.patrickjv.com ┐
   pvieira.co.uk     ├──────────► patrickjv-redirect  (301 → https://patrickjv.com + path + query;
   www.pvieira.co.uk ┘                                308 for non-GET/HEAD, so method and body survive)
```

## The three Workers

| Worker | Attached by | What it does | Config |
|---|---|---|---|
| `patrickjv-eng-site` | Custom Domain `patrickjv.com` | Serves `public/` as **static assets with no Worker script**. Asset requests are free and unmetered on the Free plan, so the site and `did.json` cannot be taken down by the 100,000 requests/day Worker quota. `_headers` adds security headers, a per-path CSP, content types and caching; unknown paths get `public/404.html` with status 404 (`not_found_handling: "404-page"`). `workers_dev` and `preview_urls` are off, so there is no duplicate `*.workers.dev` origin. | `wrangler.jsonc` |
| `patrickjv-redirect` | Custom Domains `www.patrickjv.com`, `pvieira.co.uk`, `www.pvieira.co.uk` | Every request → the fixed origin `https://patrickjv.com`, keeping path and query: `301` for GET/HEAD, `308` for any other method. No host list, so no trailing-dot bypass and no open redirect. Every response carries security headers. `workers_dev` and `preview_urls` are off. It is a metered Worker with no edge rate limit (review R7, still open). | `redirect/wrangler.jsonc` |
| `patrickjv-mcp` | **Route** `patrickjv.com/mcp*` | Remote MCP server (see [04](04-mcp-and-webmcp.md)). A zone route takes precedence over the Custom Domain for matching paths, so only `/mcp*` ever invokes code. Workers Logs keep only the handler's own redacted events (invocation logs off, query strings redacted); `workers_dev` and `preview_urls` are off. One secret, `QUOTA_SALT` (required for `request_intro`). | `mcp/wrangler.jsonc` |

A fourth Worker, **`patrickjv-did`**, predates this site: it served only `/.well-known/did.json`. It is **kept deployed as the rollback** until the new site is proven (see [06](06-operations.md#rollback)).

### Why assets-only for the site

The first version used one Worker with `run_worker_first: true` to handle redirects. A Codex review pointed out that this meters *every* request, and once the account's daily Worker quota is exhausted Cloudflare fails requests with a platform error (1027) — including `did.json`, which would break sign-in. Splitting into an assets-only site plus a separate redirect Worker removed that failure mode entirely.

## Domains and DNS

| Name | Records | Managed by |
|---|---|---|
| `patrickjv.com` | Worker Custom Domain (auto-managed) | Workers |
| `www.patrickjv.com` | Worker Custom Domain (auto-managed) | Workers |
| `pvieira.co.uk`, `www.pvieira.co.uk` | Worker Custom Domains (auto-managed). The old proxied A/CNAME records (which caused a 525 error) were deleted in the dashboard first — Custom Domains refuse to overwrite external records (error `100117`). | Workers |
| `pvieira.co.uk` mail | **Locked down (sends and receives no mail):** null MX `0 .`, SPF `v=spf1 -all`, DMARC `v=DMARC1; p=reject; adkim=s; aspf=s`, `*._domainkey` `v=DKIM1; p=` (revoked). Replaced legacy Hostinger/Elastic Email records on 6 Oct (review R2). | Manual (API/dashboard) |
| `patrickjv.com` MX | `route1/2/3.mx.cloudflare.net` + SPF `v=spf1 include:_spf.mx.cloudflare.net -all`; DMARC `v=DMARC1; p=none; rua=mailto:hello@patrickjv.com; fo=1` (monitoring; tighten later); CAA for letsencrypt.org, pki.goog, ssl.com (+ Cloudflare's own) and `iodef`; DNSSEC enabled (7 Oct; the DS record is **not yet published** at the registrar — the monitor WARNs until it is). Subdomains keep their own records: `marineweather` sends via Resend (MAIL FROM `send.marineweather` on Amazon SES; 1024-bit DKIM key `resend._domainkey`) and has its **own** DMARC `p=none` with no `rua` (it overrides the apex policy; owner action, review Codex-3/C3-F13); `tenlines` is a GitHub Pages CNAME whose custom domain is not yet verified in GitHub (owner action, C3-F6) | Email Routing (auto) |
| `patrickjv.com` TXT | `google-site-verification=…` — **keep**, Google re-checks it | Google Search Console |

The `patrickjv.com` custom domain was moved from `patrickjv-did` to `patrickjv-eng-site` **in place** (`PUT /workers/domains` with `override_existing_origin: true`), so DNS and the certificate never changed and `did.json` served `200` with identical bytes throughout the switch.

## Email

- **Email Routing** is enabled on `patrickjv.com`. Rule: `hello@patrickjv.com` → forwards to Patrick's personal Gmail (a verified destination). Forward-only; replies come from Gmail.
- **Outbound** (MCP `request_intro`): the `patrickjv-mcp` Worker's `send_email` binding sends a raw MIME message from `intro@patrickjv.com` to the single verified destination address. On the Free plan this binding can only deliver to verified destinations, which is exactly what is wanted — strangers can never use it to send email anywhere else.

## Zone settings changed in the dashboard

All on the **`patrickjv.com`** zone. The alias zone `pvieira.co.uk` has none of the 7 Oct hardening yet — NEL is still on, TLS 1.0/1.1 are accepted, no CAA, no Always Use HTTPS (owner actions, review C3-F3; see [06](06-operations.md#owner-actions-still-open)). Its redirect Worker answers only over HTTPS with a 301/308 to `https://patrickjv.com`.

| Setting | Value | Why |
|---|---|---|
| Security → Settings → Bot traffic → **Configure AI bot policies** | Search, Agent and Training all **Allow** | Cloudflare blocked AI training crawlers (GPTBot, ClaudeBot, CCBot, Bytespider, Amazonbot) by default with `403`. See [03](03-seo-aeo-machine-readability.md#ai-crawlers). |
| Rules → **URL Rewrite Rule** "Markdown for agents" | `(http.request.uri.path eq "/" and any(http.request.headers["accept"][*] contains "text/markdown"))` → path `/index.md`, query preserved | Markdown content negotiation with no Worker code |
| Security → Security rules → **Rate limiting rule** "MCP flood guard" | URI path starts with `/mcp`; per IP; 6 requests / 10 s; block 10 s | The Free plan's one rate-limiting rule. It **caps the rate** per IP before the MCP Worker runs — at most ~51,840 requests per IP per day get through, so it bounds a flood rather than stopping one; it is also stricter than the Worker's own limits (see [04](04-mcp-and-webmcp.md#cost-and-abuse-controls)) |
| Caching → Configuration → **Crawler Hints** | On | Tells search engines about changes via IndexNow |
| SSL/TLS → Edge Certificates → **Always Use HTTPS** | On (7 Oct) | HTTP → HTTPS at the edge, no Worker invoked; HSTS now takes effect from the first HTTPS visit |
| SSL/TLS → Edge Certificates → **Minimum TLS Version** | 1.2 (7 Oct) | TLS 1.0/1.1 refused |
| **Network Error Logging** | Off (7 Oct) on `patrickjv.com` — still **on** for `pvieira.co.uk` | Browsers are no longer told to send network-error reports to a Cloudflare reporting endpoint by the primary host; smoke `--aliases` FAILs if NEL returns there and WARNs while the alias zone still sends it |
| DNS → Settings → **DNSSEC** | Enabled (7 Oct; DS publication pending at the registrar — **no protection until the DS appears**; smoke `--dns` WARNs meanwhile) | Will protect the `did:web` identity from DNS spoofing once the chain of trust is complete |

## Free-plan limits that shaped the design

- Workers: 100,000 requests/day per account — avoided for the site by being assets-only.
- Rate-limiting rules: 1 per zone, 10-second period, 10-second block.
- Email sending to arbitrary recipients needs Workers Paid — so no double-opt-in confirmation emails (see [04](04-mcp-and-webmcp.md#sender-verification)).
- Wrangler's OAuth login cannot read or write DNS records or rulesets (error `10000`), so DNS deletions and rules were done in the dashboard.
