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

## Security headers

Generated into `public/_headers` by the build:

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `Content-Security-Policy` (`/`, `/index.html`) | `default-src 'none'; img-src 'self'; font-src 'self'; style-src 'sha256-…'; script-src 'sha256-…'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `X-Frame-Options` | `DENY` |
| `/fonts/*` `Cache-Control` | `public, max-age=31536000, immutable` |

The CSP allows exactly the page's single inline `<style>` and single inline WebMCP `<script>` by hash (the JSON-LD block is a data block and is never executed). The build recomputes the hashes on every run; inline `style="…"` attributes are banned (they would need `'unsafe-inline'`). Verified in a real browser: no "Refused…" violations, and the page loads with **zero third-party requests**.

`/.well-known/security.txt` (RFC 9116): contact `hello@patrickjv.com`, expires 2027-10-06 — the build fails 30 days before expiry.

## Privacy

- No analytics or tracking scripts, no cookies, no third-party requests (fonts self-hosted — Google Fonts previously saw every visitor's IP).
- The portrait's EXIF metadata was stripped.
- The MCP server stores only rate-limit counters (sender addresses hashed); messages are forwarded, not stored.

## Responsive, theming and print

- Checked in headless Chromium at **1920, 1440, 1366, 1280, 1181, 1180, 1024, 820, 360 px**: no horizontal overflow, and every value in the contact strip fits on one line (the strip uses weighted columns, and a 2×2 grid below 1180 px).
- Light and dark mode via `prefers-color-scheme`; both pass axe.
- **Print:** light palette forced, grid and dark panels removed, transitions disabled, nav and buttons hidden, link targets printed after links — usable as a one-page CV. Verified as an A4 PDF.

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
