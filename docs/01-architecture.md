# 01 — Architecture

Everything runs on one **personal Cloudflare account** (Free plan) with two zones: `patrickjv.com` (primary) and `pvieira.co.uk` (alias).

## Request flow

```
                        ┌──────────────────────────── Cloudflare edge ───────────────────────────────┐
browser / crawler ────► │ URL Rewrite rule "Markdown for agents"                                      │
                        │   path = "/" and Accept starts with text/markdown → rewrite to /index.md    │
                        │ WAF rate-limiting rule "MCP flood guard"                                    │
                        │   path starts with /mcp (and /api/booking, from launch): 6 / 10 s per IP    │
                        └──────────────┬──────────────────────────────┬───────────────────────────────┘
                                       │                              │
             Custom Domains            │            Route             │            Custom Domains
   patrickjv.com ──────────────► patrickjv-eng-site      patrickjv.com/mcp*         ──► patrickjv-mcp
                                 (static assets only,    patrickjv.com/api/booking* ──► (MCP server, booking API:
                                  never runs code)        Durable Objects IntroQuota and BookingStore,
                                                          Email Routing send, Google Calendar, Resend)
   www.patrickjv.com ┐   Single Redirect rules (no Worker, unmetered):
   pvieira.co.uk     ├──► 301 → https://patrickjv.com + path + query;
   www.pvieira.co.uk ┘    308 for non-GET/HEAD, so method and body survive
```

## The Workers

| Worker | Attached by | What it does | Config |
|---|---|---|---|
| `patrickjv-eng-site` | Custom Domain `patrickjv.com` | Serves `public/` as **static assets with no Worker script**. Asset requests are free and unmetered on the Free plan, so the site and `did.json` cannot be taken down by the 100,000 requests/day Worker quota. `_headers` adds security headers, a per-path CSP, content types and caching; unknown paths get `public/404.html` with status 404 (`not_found_handling: "404-page"`). `workers_dev` and `preview_urls` are off, so there is no duplicate `*.workers.dev` origin. | `wrangler.jsonc` |
| `patrickjv-mcp` | **Routes** `patrickjv.com/mcp*` and `patrickjv.com/api/booking*` | Remote MCP server and the booking API (see [04](04-mcp-and-webmcp.md), [booking](04-mcp-and-webmcp.md#booking)). A zone route takes precedence over the Custom Domain for matching paths, so only `/mcp*` and `/api/booking*` ever invoke code. Two SQLite Durable Objects: `IntroQuota` (introduction caps) and `BookingStore` (one instance, `idFromName("booking")`: bookings, link tokens and booking caps; runs every booking operation, and its alarm expires holds, prunes and recovers interrupted confirms). Booking ships dark (`BOOKING_ENABLED` `"false"`) and needs the booking secrets listed in `mcp/wrangler.jsonc`. Workers Logs keep only the handler's own redacted events (invocation logs off, query strings redacted); `workers_dev` and `preview_urls` are off. One secret, `QUOTA_SALT` (required for `request_intro`). | `mcp/wrangler.jsonc` |

Both are deployed by **Cloudflare Workers Builds** from this repo's `main` branch (build `npm ci && npm test`, then `wrangler deploy` with the Worker's config), each rebuilt only when a push touches its watch paths; GitHub holds no deploy credential (see [06](06-operations.md#deploying)).

A third Worker, **`patrickjv-did`**, predates this site: it served only `/.well-known/did.json`. It is **kept deployed as the rollback** until the new site is proven (see [06](06-operations.md#rollback)).

### Why assets-only for the site

The first version used one Worker with `run_worker_first: true` to handle redirects. A Codex review pointed out that this meters *every* request, and once the account's daily Worker quota is exhausted Cloudflare fails requests with a platform error (1027) — including `did.json`, which would break sign-in. Splitting into an assets-only site plus a separate redirect Worker removed that failure mode entirely. On 7 Oct the redirect Worker was replaced by free **Single Redirect rules** (review R7), so alias traffic no longer counts against the Worker quota either.

### Alias redirects

`www.patrickjv.com`, `pvieira.co.uk` and `www.pvieira.co.uk` are proxied `AAAA 100::` placeholder records; nothing behind them is ever reached. A **Single Redirect** rule set on each zone (Rules → Redirect Rules) answers at the edge, before any Worker, with a fixed destination:

| Rule | Expression | Action |
|---|---|---|
| GET/HEAD | `http.host in {<alias hosts, with and without a trailing dot>} and http.request.method in {"GET" "HEAD"}` | `301` to `concat("https://patrickjv.com", http.request.uri.path)`, query string kept |
| Other methods | the same hosts, `not http.request.method in {"GET" "HEAD"}` | `308`, same target |

The destination host is a literal, so no request can choose where it goes (no open redirect). Over HTTP, Always Use HTTPS answers first (an edge 301 to the same host over HTTPS; review R38). The redirects carry no security headers except HSTS on `pvieira.co.uk` (zone HSTS setting, `max-age=31536000; includeSubDomains`); `www.patrickjv.com` is covered by the apex's own `includeSubDomains` HSTS. Free plan: 10 Single Redirect rules per zone, 2 used on each.

## Domains and DNS

| Name | Records | Managed by |
|---|---|---|
| `patrickjv.com` | Worker Custom Domain (auto-managed) | Workers |
| `www.patrickjv.com`, `pvieira.co.uk`, `www.pvieira.co.uk` | Proxied `AAAA 100::` placeholders (since 7 Oct; they were the redirect Worker's Custom Domains until then). Only the Single Redirect rules answer them — see [Alias redirects](#alias-redirects) | Manual (API/dashboard) |
| `pvieira.co.uk` mail | **Locked down (sends and receives no mail):** null MX `0 .`, SPF `v=spf1 -all`, DMARC `v=DMARC1; p=reject; adkim=s; aspf=s`, `*._domainkey` `v=DKIM1; p=` (revoked). Replaced legacy Hostinger/Elastic Email records on 6 Oct (review R2). | Manual (API/dashboard) |
| `patrickjv.com` MX | `route1/2/3.mx.cloudflare.net` + SPF `v=spf1 include:_spf.mx.cloudflare.net -all`; DMARC `v=DMARC1; p=none; rua=mailto:hello@patrickjv.com; fo=1` (monitoring; tighten later); CAA for letsencrypt.org, pki.goog, ssl.com (+ Cloudflare's own) and `iodef`; DNSSEC enabled (7 Oct; the DS record is **not yet published** at the registrar — the monitor WARNs until it is). Subdomains keep their own records: `marineweather` sends via Resend (MAIL FROM `send.marineweather` on Amazon SES; 1024-bit DKIM key `resend._domainkey`) and has its **own** DMARC `p=none` with no `rua` (it overrides the apex policy; owner action, review Codex-3/C3-F13); `tenlines` is a GitHub Pages CNAME; `patrickjv.com` is a verified GitHub Pages domain (TXT `_github-pages-challenge-pvieira04`, 7 Oct, C3-F6) | Email Routing (auto) |
| `patrickjv.com` TXT | `google-site-verification=…` — **keep**, Google re-checks it | Google Search Console |

The `patrickjv.com` custom domain was moved from `patrickjv-did` to `patrickjv-eng-site` **in place** (`PUT /workers/domains` with `override_existing_origin: true`), so DNS and the certificate never changed and `did.json` served `200` with identical bytes throughout the switch.

## Email

- **Email Routing** is enabled on `patrickjv.com`. Rule: `hello@patrickjv.com` → forwards to Patrick's personal Gmail (a verified destination). Forward-only; replies come from Gmail.
- **Booking guest email** (holds, "Booked", cancellation requests) goes out from `hello@patrickjv.com` through **Resend**'s free tier (`RESEND_API_KEY`, domain `patrickjv.com` verified 8 Oct 2026), because `send_email` can only reach verified addresses. Google Calendar sends the invites itself. The once-a-day booking cap alert to Patrick uses `send_email`, like introductions.
- **Outbound** (MCP `request_intro`): the `patrickjv-mcp` Worker's `send_email` binding sends a raw MIME message from `intro@patrickjv.com` to the single verified destination address. On the Free plan this binding can only deliver to verified destinations, which is exactly what is wanted — strangers can never use it to send email anywhere else.

## Zone settings changed in the dashboard

Everything in this section is also recorded, as exported from the live account, in `infra/cloudflare/` ([06](06-operations.md#dashboard-config-export)).

All on the **`patrickjv.com`** zone. The alias zone `pvieira.co.uk` was hardened the same way on 7 Oct (review C3-F3): NEL off, minimum TLS 1.2, Always Use HTTPS, and the same 11 CAA records as `patrickjv.com`. Zone HSTS is on for `pvieira.co.uk` (7 Oct), so its redirects carry `Strict-Transport-Security`.

| Setting | Value | Why |
|---|---|---|
| Security → Settings → Bot traffic → **Configure AI bot policies** | Search, Agent and Training all **Allow** | Cloudflare blocked AI training crawlers (GPTBot, ClaudeBot, CCBot, Bytespider, Amazonbot) by default with `403`. See [03](03-seo-aeo-machine-readability.md#ai-crawlers). |
| Rules → **URL Rewrite Rule** "Markdown for agents" | `(http.request.uri.path eq "/" and any(starts_with(http.request.headers["accept"][*], "text/markdown")))` → path `/index.md`, query preserved | Markdown content negotiation with no Worker code. Only an `Accept` that lists `text/markdown` **first** gets Markdown (7 Oct, review R6); `text/html, text/markdown;q=0.1` gets HTML. Free-plan rules cannot parse q-values, so `text/markdown;q=0` listed first would still get Markdown — no real client sends that |
| Security → Security rules → **Rate limiting rule** "MCP flood guard" | URI path starts with `/mcp`; per IP; 6 requests / 10 s; block 10 s | The Free plan's one rate-limiting rule. It **caps the rate** per IP before the MCP Worker runs — at most ~51,840 requests per IP per day get through, so it bounds a flood rather than stopping one; it is also stricter than the Worker's own limits (see [04](04-mcp-and-webmcp.md#cost-and-abuse-controls)) |
| Caching → Configuration → **Crawler Hints** | On | Tells search engines about changes via IndexNow |
| SSL/TLS → Edge Certificates → **Always Use HTTPS** | On (7 Oct) | HTTP → HTTPS at the edge, no Worker invoked; HSTS now takes effect from the first HTTPS visit |
| SSL/TLS → Edge Certificates → **Minimum TLS Version** | 1.2 (7 Oct) | TLS 1.0/1.1 refused |
| **Network Error Logging** | Off (7 Oct) on `patrickjv.com` and `pvieira.co.uk` | Browsers are no longer told to send network-error reports to a Cloudflare reporting endpoint; smoke `--aliases` FAILs if NEL returns on either zone |
| DNS → Settings → **DNSSEC** | Enabled (7 Oct; DS publication pending at the registrar — **no protection until the DS appears**; smoke `--dns` WARNs meanwhile) | Will protect the `did:web` identity from DNS spoofing once the chain of trust is complete |

## Free-plan limits that shaped the design

- Workers: 100,000 requests/day per account — avoided for the site by being assets-only.
- Rate-limiting rules: 1 per zone, 10-second period, 10-second block.
- Email sending to arbitrary recipients needs Workers Paid — so no double-opt-in confirmation emails (see [04](04-mcp-and-webmcp.md#sender-verification)).
- Wrangler's OAuth login cannot read or write DNS records or rulesets (error `10000`), so DNS deletions and rules were done in the dashboard.
