# 07 — History and decisions

The site was designed, built and launched in one session on **6 October 2026**, with Claude Code (Claude Opus) doing the build and **Codex (gpt-6.1-sol)** acting as a second, independent designer and as an adversarial reviewer.

## Starting point

- `patrickjv.com` served only `/.well-known/did.json` (from the `patrickjv-did` Worker); everything else was a 404.
- `pvieira.co.uk` and its `www` returned **525** (a proxied record pointing at a broken origin).
- `www.patrickjv.com` did not exist.

## Timeline

| Time | Commit | What |
|---|---|---|
| 15:25 | `44782b8` | Six candidate designs (three by Claude, three by Codex) built from one brief and one `content.json`; compared **blind** (shuffled 1–6 on a preview Worker). Patrick chose **#5 = `claude-b`, the "systems / technical drawing" design**. Initial site with `did.json` byte-identical to the live one. |
| 15:51 | `2cf6173` | Copy reframed **employer-agnostic**; LinkedIn/GitHub buttons; portrait chosen from Immich via an API key (shortlist reviewed from 1,566 photos of Patrick; a Feb 2026 studio shot won). |
| 16:02 | `425b719` | First Codex review → split into an **assets-only site + redirect Worker** (quota risk to `did.json`). |
| 16:06 | — | **Switch-over**: `patrickjv.com` moved in place to the new site; `did.json` stayed 200 and identical throughout. Aliases attached after old DNS records were removed. |
| 16:17 | `936dd45` | `ProfilePage` graph with footballer disambiguation, `/index.md`, WebMCP read tools. AI training crawlers unblocked in Cloudflare; Google and Bing registration; Crawler Hints. |
| 16:34 | `271158e` | Quick answers section + `FAQPage`. |
| 17:30 | `4ee5a7f` | `build.mjs`: every machine copy generated from `content.json`, with drift checks; Content Signals in `robots.txt`. |
| 17:35 | `03b2170` | Person linked to `did:web:patrickjv.com`; Markdown negotiation rule. |
| 18:12 | `0c93d4f` | Email Routing; `hello@patrickjv.com` published. |
| 18:31 | `2ce4862` | Favicon: Claude vs Codex candidates; **Codex's "datum mark" (dark)** chosen. "London" added to the title. |
| 18:52 | `4b051ce` | **Remote MCP server** with `request_intro`, after three Codex review rounds. Edge WAF rate limit added after the binding proved too loose. |
| 21:22 | `4fa5753` | Security headers + CSP, self-hosted fonts, MCP icons, share card, print styles. Headless Chromium set up — first real visual verification. |
| 21:29 | `ed24391` | Responsive photo, WebMCP `request_intro`, daily monitor, deploy-on-push workflow. |
| 21:32 | `1a97fc2` | Published to the **MCP Registry** as `com.patrickjv/profile`. |
| 21:40 | `2c0a660` | `security.txt`. |

## The design competition

`designs/BRIEF.md` was given to both tools unchanged; `designs/mapping.json` holds the blind key.

| # | Folder | Maker | Direction |
|---|---|---|---|
| 1 | `codex-1` | Codex | Warm editorial journal |
| 2 | `claude-c` | Claude | Warm / human, paper and clay palette |
| 3 | `codex-3` | Codex | Bold cobalt typography |
| 4 | `codex-2` | Codex | Precise systems console |
| **5** | **`claude-b`** | **Claude** | **Systems / technical drawing — chosen** |
| 6 | `claude-a` | Claude | Editorial, print-magazine serif |

Working independently, Codex chose directions close to Claude's (editorial, systems), which made the blind comparison a fair test of execution.

## Key decisions

| Decision | Why |
|---|---|
| Plain static HTML, no framework | The chosen design was a single complete file; a framework would add a build step and nothing else |
| Assets-only site Worker | Static assets are unmetered; `did.json` cannot be knocked out by quota |
| Separate redirect Worker, fixed destination | No host list → no trailing-dot bypass, no open redirect |
| Custom Domains, not DNS edits | Wrangler can attach them (and creates records); its OAuth cannot edit DNS |
| Employer-agnostic copy | A professional page about skills and work, not an employer |
| Allow all AI crawlers | Public professional profile; answer bots matter most and training helps disambiguation long-term |
| MCP server on its own route | Only `/mcp*` runs code; edge rule stops floods before it |
| Limits-only for `request_intro` | Double opt-in needs Workers Paid or an external sender |
| No MCP server card / A2A card / `_agent` DNS | Nothing reads them yet; the MCP Registry does the discovery job |
| No analytics script | Keeps zero third-party requests on page load (Cloudflare NEL aside — see [05](05-quality-and-audits.md#privacy)) |
| Codex favicon over Claude's | Bolder and clearer at 16 px, where favicons are judged |

## Lessons worth keeping

- **Verify the claim, not the declaration.** A spoofed GPTBot UA proved a block but could not prove an allow; a rate-limit binding that deploys fine still blocked only 1 of 40 requests live.
- **Reviews converge in rounds.** Each Codex round's findings were narrower than the last (20-email cap bypass → midnight rollover → IPv4-mapped IPv6 forms); stop when only edge cases remain.
- **Revert-and-fail every guard.** Each safety test was deliberately broken to prove it could fail.
- **Look at it.** The page was not seen rendered until headless Chromium was set up; doing so immediately found a wrapping bug invisible to file checks.
- **Propagation is real.** Fresh Cloudflare deploys briefly served stale or 404 assets from some locations; re-test before chasing a bug.
