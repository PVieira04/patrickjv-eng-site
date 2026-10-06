# 03 — SEO, AEO and machine-readability

## Why each matters

- **SEO** is the foundation. AI answer engines cite from search indexes: ChatGPT search and Copilot use **Bing**, Google AI Overviews and Gemini use **Google**, Claude's web search uses **Brave**, Perplexity uses its own index plus others. Not indexed means not cited.
- **AEO** (answer engine optimisation) makes the content easy to *quote*: answer-shaped text, unambiguous entity data, clean formats.
- **Machine-readability** lets agents *read and act* without scraping: structured data, Markdown, `llms.txt`, MCP and WebMCP.

The specific obstacle for this site: **"Patrick Vieira" is a famous footballer.** Much of the work below exists to make it unambiguous that this is a different person — a platform engineer, `patrickjv`, in London.

## On-page SEO

| Item | Implementation |
|---|---|
| Title | `Patrick Vieira — Platform Engineer, London` ("London" added for disambiguation) |
| Meta description | The tagline (title, description, Open Graph and Twitter tags are generated from `content.json` by the build) |
| Canonical | `https://patrickjv.com/` |
| Open Graph / Twitter | Title, description, URL, `og-card.jpg` 1200×630 with width/height/alt, `summary_large_image` |
| Semantics | One `h1`, logical heading order, `header`/`main`/`section`/`article`/`footer`, `lang="en-GB"` |
| Favicon | Full set (Google shows favicons in results; previously `/favicon.ico` was a 404) |
| Sitemap / robots | `sitemap.xml`, `robots.txt` → sitemap |
| Speed | Static, ~49 KB HTML (~12 KB gzipped), self-hosted fonts, responsive photo — Lighthouse 100 (see [05](05-quality-and-audits.md)) |
| Redirects | Aliases 301 to the canonical domain, keeping paths |
| Off-site links | GitHub profile website → `https://patrickjv.com`, bio "Platform engineer — London"; LinkedIn links to the site. Two-way links tie the profiles to one entity. |

## Structured data (JSON-LD `@graph`)

- **`ProfilePage`** (`#profilepage`) — `mainEntity` → Person, `isPartOf` → WebSite, `hasPart` → FAQPage, `dateModified`.
- **`WebSite`** (`#website`).
- **`Person`** (`#person`) — `name`, `alternateName: ["patrickjv", "PatrickJV"]`, **`disambiguatingDescription`** ("Patrick Vieira, platform engineer based in London — not the footballer of the same name."), `jobTitle`, `hasOccupation`, `description`, `url`, `image`, `address`, `alumniOf`, `sameAs` (LinkedIn, GitHub), `knowsAbout`, `email`, and **`identifier: did:web:patrickjv.com`** (ties the verified identity to the profile).
- **`FAQPage`** (`#faq`) — the five Quick answers as `Question`/`acceptedAnswer`.

No `worksFor` — the site is employer-agnostic. Every `@id` reference resolves inside the graph.

## Answer-shaped content

A visible **Quick answers** section (section 07) with five Q&As written to be quoted directly, in the third person, including the footballer disambiguation. The same Q&As appear in the `FAQPage` markup, `index.md`, `llms.txt`, the WebMCP `list_faq` tool and the MCP `list_faq` tool.

## Agent-readable formats

| Format | Where |
|---|---|
| `llms.txt` | `/llms.txt` — summary, disambiguation, work, side projects, background, Quick answers, links, privacy note, and a "Machine-readable" section listing `index.md`, the sitemap and the MCP server |
| Markdown twin | `/index.md`, linked by `<link rel="alternate" type="text/markdown">` and from `llms.txt` |
| Markdown negotiation | `GET /` with `Accept: text/markdown` → `text/markdown; charset=utf-8` (Cloudflare URL Rewrite rule, no code). Browsers still get HTML. `/` and `/index.md` send `Vary: Accept` so caches keep the two apart. The rule matches any `Accept` containing `text/markdown`, even with `q=0` (review R6, open). |
| WebMCP | Five tools on the page (see [04](04-mcp-and-webmcp.md#webmcp)) |
| Remote MCP | `/mcp`, listed on the MCP Registry |

## AI crawlers

Testing user agents revealed that Cloudflare was **blocking AI training crawlers by default** with `403 Your request was blocked`: GPTBot, ClaudeBot, CCBot, Bytespider, Amazonbot. Answer/search bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Applebot, Google, Bing, DuckAssistBot, MistralAI-User, meta-externalagent) were already allowed.

**Decision:** allow all three categories (Search, Agent, Training). Answer bots matter most for AEO (they fetch live and cite with links); training adds a long-term, smaller benefit — models "knowing" this Patrick Vieira without searching. After the change, every tested crawler returns `200`. Note: a spoofed user agent cannot prove the *real* crawler is allowed; Cloudflare's AI Crawl Control analytics is the authoritative view.

`robots.txt` states the policy explicitly with **Content Signals**: `search=yes, ai-input=yes, ai-train=yes`.

## Search registration

| Engine | Status |
|---|---|
| **Google Search Console** | Domain property `patrickjv.com`, verified by DNS TXT (keep the record). Sitemap submitted; indexing requested. |
| **Bing Webmaster Tools** | Live URL test: "URL can be indexed by Bing", **"No SEO/GEO issues found"**, 2 markup types detected; indexing requested. An old April 2025 "DNS failure" record predates the site and will be replaced on recrawl. |
| **IndexNow** | Via Cloudflare Crawler Hints (on). |
| **MCP Registry** | `com.patrickjv/profile`, active (see [04](04-mcp-and-webmcp.md#mcp-registry)). |

`pvieira.co.uk` is deliberately not registered — it 301s, which search engines handle correctly.

## Agent-readiness layer map

The site was checked against a seven-layer "agent-readable business record" model (identity → canonical data → generated files → agent doors → messaging → fulfilment → concierge):

| Layer | This site |
|---|---|
| 1. Verified identity | ✅ `did:web:patrickjv.com`, linked from the Person data |
| 2. Single source of truth | ✅ `content.json` → generated copies |
| 3. Generated files | ✅ JSON-LD, `llms.txt`, `robots.txt` + Content-Signal, sitemap, Markdown negotiation |
| — `/.well-known/mcp.json` server card | ❌ Skipped: proposed standard nothing scans for yet (the MCP Registry is used instead) |
| — A2A `agent-card.json` | ❌ Skipped: there is no agent to advertise |
| — `_agent` DNS discovery | ❌ Skipped: early draft nothing reads |
| 4a. Open-web door (MCP) | ✅ `/mcp` + MCP Registry |
| 4b. Browser door (WebMCP) | ✅ Five tools (Chromium only) |
| 4c. Apple door (App Intents) | ➖ Not possible for a website (see below) |
| 5. Messaging | ✅ `hello@patrickjv.com` + MCP/WebMCP `request_intro` |
| 6. Fulfilment | ➖ Business feature, not applicable |
| 7. Concierge / analytics | ➖ Patrick is the concierge; analytics via Search Console, Bing and Cloudflare (no tracking script) |

## Research findings (6 Oct 2026)

**Apple** — no confirmed way for Siri or Apple Intelligence to discover or act on websites. Apple's agent surface is **native apps only** (App Intents / App Schemas, iOS/macOS 27). PWAs cannot expose App Intents. MCP appears in Apple's *developer* tooling (Xcode 26.3/27; a Safari 27 MCP *server* for local dev agents), not as a Siri MCP client — the macOS 26.1 beta MCP strings never became a confirmed feature. **WebKit formally opposes WebMCP** (standards-positions issue 670, closed 11 Jun 2026), so WebMCP is Chromium-only. For Apple, the signals that work are the classic ones: Applebot access and good HTML. No Apple statement either way on `llms.txt` or JSON-LD use.

**Cloudflare Email Service** — Email *Sending* is in public beta (since 16 Apr 2026). Sending to **arbitrary recipients requires Workers Paid**; on Free, only verified destination addresses. Hence no double-opt-in emails to senders.

**Not done, by choice:** Cloudflare Web Analytics (adds a third-party beacon, breaking the zero-third-party-requests property); Wikidata/Wikipedia entries (notability rules); keyword stuffing.

## The remaining lever

**Content worth citing.** Answer engines quote substance; a profile page gives them little. A writing section (Markdown posts → pages with `Article` data and a feed, generated by the existing build) is the biggest remaining AEO gain. It is ready to build once there is a first article.
