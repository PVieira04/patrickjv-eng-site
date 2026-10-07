# 05 — Quality and audits

## Results (live site, 6 Oct 2026)

| Audit | Mobile | Desktop |
|---|---|---|
| Lighthouse Performance | **100** | **100** |
| Lighthouse Accessibility | **100** | **100** |
| Lighthouse Best Practices | **100** | **100** |
| Lighthouse SEO | **100** | **100** |
| Largest Contentful Paint | 1.5 s | 0.4 s |
| Cumulative Layout Shift | 0 | 0 |
| Total Blocking Time | 0 ms | 0 ms |

- **axe-core** (WCAG 2.0/2.1/2.2 A and AA + best practices): **0 violations** in dark and light mode.
- Lighthouse's only remaining suggestions concerned the photo (served larger than displayed); fixed afterwards with a 320/640/960 `srcset`, `sizes="300px"` and `fetchpriority="high"`.
- Bing Webmaster live test: "No SEO/GEO issues found".
- These audits were run on 6 Oct **before** the evening's review fixes (privacy note, 404 page, per-path headers, WebMCP changes). After the fixes, headless Chromium confirmed the live page and 404 page load with no CSP violations (see below).

### Re-run, 7 Oct 2026 (review C3-F16)

Re-run on the live site after the round-3 deploy (commit aa55c83), headless Chromium via Playwright + Lighthouse:

| Audit | Mobile | Desktop |
|---|---|---|
| Performance / Accessibility / Best Practices / SEO | **100 / 100 / 100 / 100** | **100 / 100 / 100 / 100** |
| Largest Contentful Paint | 1.2 s (was 1.5 s) | 0.3 s (was 0.4 s) |
| Cumulative Layout Shift / Total Blocking Time | 0 / 0 ms | 0 / 0 ms |

axe-core (WCAG 2.0/2.1/2.2 A and AA + best practices): **0 violations** in dark and light mode. Lighthouse's only remaining suggestions are cache lifetimes (3–10 KiB), which are deliberate (fonts 30 days, images 1 day; see Caching).

## Security headers

Generated into `public/_headers` by the build. On every asset path (`/*`):

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `X-Frame-Options` | `DENY` |

Per path — **each CSP is set by exactly one rule**, and `/*` sets none:

| Path | Headers |
|---|---|
| `/`, `/index.html` | Page CSP: `default-src 'none'; img-src 'self'; font-src 'self'; style-src 'sha256-…'; script-src 'sha256-…'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests`. `/` also `Vary: Accept` |
| `/index.md`, `/llms.txt`, `/robots.txt`, `/sitemap.xml`, `/.well-known/security.txt`, `/.well-known/mcp-registry-auth` | Explicit `Content-Type` with `charset=utf-8` (`text/markdown`, `text/plain` or `application/xml`); baseline CSP `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. `/index.md` also `Vary: Accept` |
| `/.well-known/did.json` | Baseline CSP (content type left to the asset server: `application/json`) |
| Each file in `public/fonts/` (one exact rule per file, no `/fonts/*`) | `Cache-Control: public, max-age=2592000` (30 days, then revalidated by ETag); baseline CSP |
| Each image in `public/` (photos, favicons, icons, share card) | `Cache-Control: public, max-age=86400` (one day); baseline CSP |
| Anything else (including the 404 page, even under `/fonts/`) | No CSP header and no `_headers` cache policy; `404.html` carries its own policy in a `<meta http-equiv="Content-Security-Policy">`: `default-src 'none'; img-src 'self'; font-src 'self'; style-src 'sha256-…'; base-uri 'none'; form-action 'none'` (framing is still blocked by `X-Frame-Options: DENY`) |

The page CSP allows exactly the page's single inline `<style>` and single inline WebMCP `<script>` by hash (the JSON-LD block is a data block and is never executed). The build recomputes every hash on every run; inline `style="…"` attributes and `on…` handlers are banned (they would need `'unsafe-inline'`). Verified in a real browser: no "Refused…" violations, and the page loads with **zero third-party requests**. The MCP and redirect Workers send their own security headers on every response (see [04](04-mcp-and-webmcp.md#cost-and-abuse-controls)).

**Why one rule per path.** In Cloudflare's static-asset `_headers`, every rule whose path matches applies, and a header set by two rules reaches the browser twice. The `! Header` syntax to detach an inherited header works under `wrangler dev` but is **not honoured in production**. A first version set a baseline CSP on `/*` and detached it on `/`; locally the page had one policy, in production it had both, and the stricter baseline blocked the page's style and script (6 Oct incident — see [06](06-operations.md#incidents)). The build now refuses detach lines, a CSP on `/*` or any wildcard rule, and two CSP rules for one path (unit-tested with fixtures); the live smoke check compares the CSP on `/` with `public/_headers` and checks that a missing font path returns 404 with at most one CSP and without the 30-day cache. A wildcard such as `/fonts/*` was removed for that reason: it also matched missing paths, so their 404 page received the baseline CSP on top of its own `<meta>` policy (policies intersect, so the page lost its styles) plus a 30-day cache.

**Caching.** Font files keep their names (no fingerprint), so they are cached for 30 days and revalidated rather than marked `immutable`; a changed font should get a new file name. Images are cached for one day. HTML and text files keep the asset server's default (`max-age=0, must-revalidate`).

**404 page.** Unknown paths return `public/404.html` with a real 404 status (`not_found_handling: "404-page"`): one `<h1>`, `noindex`, a link home, the site's fonts and palette. Checked live: status 404 and no CSP violations.

**Soft 404 at `/404` — accepted (review C3-F9).** The asset server also serves the 404 file at its own clean URL, so `GET /404` returns **200** with the not-found page. It is harmless — the page carries `noindex`, nothing links to it and it is not in the sitemap — and a fix (a `_redirects` rule or renaming the file) would change asset-server behaviour that differs between `wrangler dev` and production (the 6 Oct incident), so it is left as is unless a production-verified fix appears.

`/.well-known/security.txt` (RFC 9116): contact `hello@patrickjv.com`, expires 2027-10-06 — the build fails 30 days before expiry, or if `Expires` is invalid or more than a year ahead.

## Privacy

- No analytics or tracking scripts, no cookies, and no third-party requests during page loads (fonts self-hosted — Google Fonts previously saw every visitor's IP).
- The page footer says it plainly: *"Introductions sent through this site's MCP or browser-agent tools are forwarded to my email and not stored here."* The same note ends `index.md` and `llms.txt`, and the `request_intro` tool description states it too.
- **Introductions (`request_intro`, MCP or WebMCP).** What is processed, where, and for how long:
  - **The message** (name, reply-to address, optional organisation and agent, reason, text) is sent once by email from `intro@patrickjv.com` to Patrick's personal **Gmail** mailbox (Google, US) and kept there like any other email, at Patrick's discretion. The site does not store it. The email also carries the time received and an "unverified sender" note — and, since round 3 (review C3-F11), **no country or client (user-agent) metadata**.
  - **Rate-limit counters** live in a Cloudflare Durable Object under **HMAC-SHA256 keys** (keyed with a Worker secret) of the client IP and of a normalised sender address — never the raw values. Counters **expire daily**: an alarm deletes them at the next UTC midnight, and a new day replaces them. Cloudflare's SQLite-backed Durable Objects keep **30 days of point-in-time recovery history**, so deleted counters (keyed hashes only) remain recoverable by the account owner on the platform for up to 30 days. Without the secret, introductions are refused rather than hashed with a public key.
  - **Logs.** Workers Logs keep only the MCP Worker's own redacted events (`mcp_failure` with a subsystem name, `intro_quota_rejected` with the cap) — **invocation logs are off** (review C3-F4), so no per-request IP, location or user agent is retained there; query strings are redacted as well. The per-minute rate-limit bindings hold short-lived counters in Cloudflare's rate-limiting service.
- Network Error Logging (Cloudflare `Report-To`/`NEL` headers, which could make browsers send failure reports to a Cloudflare endpoint) was **disabled on `patrickjv.com` on 7 Oct** (review R5). It was disabled on the alias zone **`pvieira.co.uk`** later on 7 Oct (review C3-F3); `smoke --aliases` FAILs if they reappear on either zone.
- The portrait's EXIF metadata was stripped.

## Responsive, theming and print

- Checked in headless Chromium at **1920, 1440, 1366, 1280, 1181, 1180, 1024, 820, 360 px**: no horizontal overflow, and every value in the contact strip fits on one line (the strip uses weighted columns, and a 2×2 grid below 1180 px).
- **Reflow:** at **320 px with text at 200%** there is no horizontal scroll (document width stays 320 px; the Skills grid's minimum column width is capped at the container width). Re-verified on the live site on 6 Oct after the fixes.
- Light and dark mode via `prefers-color-scheme`; both passed axe.
- The decorative `■` in the Profile label is `aria-hidden`, so screen readers do not announce it.
- **Print:** light palette forced, grid and dark panels removed, transitions disabled, nav, diagram and buttons hidden, external link targets printed after links, and cards, readouts, Quick answers, skills and contact rows kept whole (`break-inside: avoid`). The live page prints as **7 A4 pages** — a printable profile, not a one-page CV.

## How to re-run the audits

Headless Chromium works in WSL **without sudo** — the only missing library (`libasound.so.2`) is unpacked locally:

```bash
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright lighthouse @axe-core/playwright
npx playwright install chromium-headless-shell
# one-off: the missing system library, no root needed
apt-get download libasound2t64 && dpkg -x libasound2t64*.deb ~/.local/opt/pw-libs/root
export LD_LIBRARY_PATH=~/.local/opt/pw-libs/root/usr/lib/x86_64-linux-gnu
```

Lighthouse's own launcher cannot start the headless shell, so launch Chromium through Playwright with `--remote-debugging-port=9333` and call `lighthouse(url, { port: 9333 })` (desktop: pass `lighthouse/core/config/desktop-config.js`). axe needs a browser **context** (`browser.newContext()`), not a bare page. Alternatively use **pagespeed.web.dev** (its shared API quota is sometimes exhausted).

Gotcha: `emulateMedia({ media: "print" })` straight after load can catch CSS transitions mid-flight; the print stylesheet disables transitions for this reason.
