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
- These audits were run on 6 Oct **before** the evening's review fixes (privacy note, 404 page, per-path headers, WebMCP changes) and have not been re-run since. After the fixes, headless Chromium confirmed the live page and 404 page load with no CSP violations (see below).

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
| `/fonts/*` | `Cache-Control: public, max-age=2592000` (30 days, then revalidated by ETag); baseline CSP |
| Each image in `public/` (photos, favicons, icons, share card) | `Cache-Control: public, max-age=86400` (one day); baseline CSP |
| Anything else (including the 404 page) | No CSP header; `404.html` carries its own policy in a `<meta http-equiv="Content-Security-Policy">`: `default-src 'none'; img-src 'self'; font-src 'self'; style-src 'sha256-…'; base-uri 'none'; form-action 'none'` (framing is still blocked by `X-Frame-Options: DENY`) |

The page CSP allows exactly the page's single inline `<style>` and single inline WebMCP `<script>` by hash (the JSON-LD block is a data block and is never executed). The build recomputes every hash on every run; inline `style="…"` attributes and `on…` handlers are banned (they would need `'unsafe-inline'`). Verified in a real browser: no "Refused…" violations, and the page loads with **zero third-party requests**. The MCP and redirect Workers send their own security headers on every response (see [04](04-mcp-and-webmcp.md#cost-and-abuse-controls)).

**Why one rule per path.** In Cloudflare's static-asset `_headers`, every rule whose path matches applies, and a header set by two rules reaches the browser twice. The `! Header` syntax to detach an inherited header works under `wrangler dev` but is **not honoured in production**. A first version set a baseline CSP on `/*` and detached it on `/`; locally the page had one policy, in production it had both, and the stricter baseline blocked the page's style and script (6 Oct incident — see [06](06-operations.md#incidents)). The build now refuses detach lines, a CSP on `/*`, and two CSP rules for one path; the live smoke check compares the CSP on `/` with `public/_headers`.

**Caching.** Font files keep their names (no fingerprint), so they are cached for 30 days and revalidated rather than marked `immutable`; a changed font should get a new file name. Images are cached for one day. HTML and text files keep the asset server's default (`max-age=0, must-revalidate`).

**404 page.** Unknown paths return `public/404.html` with a real 404 status (`not_found_handling: "404-page"`): one `<h1>`, `noindex`, a link home, the site's fonts and palette. Checked live: status 404 and no CSP violations.

`/.well-known/security.txt` (RFC 9116): contact `hello@patrickjv.com`, expires 2027-10-06 — the build fails 30 days before expiry, or if `Expires` is invalid or more than a year ahead.

## Privacy

- No analytics or tracking scripts, no cookies, and no third-party requests during page loads (fonts self-hosted — Google Fonts previously saw every visitor's IP).
- The page footer says it plainly: *"Introductions sent through this site's MCP or browser-agent tools are forwarded to my email and not stored here."* The same note ends `index.md` and `llms.txt`, and the `request_intro` tool description states it too.
- The MCP server stores only rate-limit counters, under **HMAC-SHA256 keys** (keyed with a Worker secret) of the client IP and of a normalised sender address — never the raw values — and keeps them for **one day**: an alarm deletes them at the next UTC midnight. Messages are forwarded by email, not stored. Workers Logs record only redacted failure events.
- Caveat: Cloudflare adds Network Error Logging headers (`Report-To`/`NEL` → `a.nel.cloudflare.com`), so a browser *may* send a network-error report to Cloudflare if a load fails. This is a zone-level Cloudflare feature, not site code, and is still present (review R5).
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
