# 04 — MCP and WebMCP

## The MCP server

- **Endpoint:** `https://patrickjv.com/mcp` — MCP **Streamable HTTP**, stateless, JSON responses only (no SSE), no auth. Protocol versions `2025-11-25` and `2025-06-18`.
- **Worker:** `patrickjv-mcp` (`mcp/`), on the route `patrickjv.com/mcp*` only.
- **Server info:** name `patrickjv.com`, version `1.1.0`, `websiteUrl`, and **icons** (the pjv favicon) on the server and every tool.

| Tool | Kind | Returns / does |
|---|---|---|
| `get_profile` | read-only | Name, headline, tagline, location, links (website, LinkedIn, GitHub, email) |
| `list_work` | read-only | Title, summary, tags per work item |
| `list_skills` | read-only | Skills |
| `list_faq` | read-only | The five Quick answers |
| `request_intro` | write | Emails Patrick an introduction on someone's behalf |

Read tools return `structuredContent` and its JSON serialisation as text. Data comes from `lib/agent-data.mjs`, shared with the page.

`request_intro` arguments: `from_name` (1–100), `from_email` (ASCII address), `reason` (`recruiting` | `collaboration` | `speaking` | `other`), `message` (20–2000), optional `organisation`, optional `agent`. Strictly validated, no type coercion, unknown fields rejected. The email arrives from "patrickjv.com intro" `<intro@patrickjv.com>` with subject `[Intro · <reason>] <name> (<organisation>)`, `Reply-To` the sender's address only, and a footer marking it as an unverified sender.

### Code layout

- `mcp/handler.js` — all protocol and safety logic, with no Cloudflare-only imports, so it is fully unit-tested in Node.
- `mcp/index.js` — wires in `EmailMessage` (`cloudflare:email`) and the `IntroQuota` Durable Object.
- `mcp/handler.test.mjs` — 22 tests.

## Cost and abuse controls

Requests are rejected in the **cheapest order**, before the body is read:

1. Edge **WAF rule**: `/mcp*`, 6 requests / 10 s per IP, block 10 s — the Worker never runs for blocked requests.
2. Path must be exactly `/mcp` (else 404).
3. **Origin:** browsers' cross-origin requests from anywhere but `https://patrickjv.com` → 403. Server-side clients send no Origin and are allowed. CORS is granted only to `patrickjv.com`.
4. Method: `POST` (and `OPTIONS`); `GET` → 405.
5. Media type exactly `application/json` → else 415.
6. Declared `Content-Length` > 16 KiB → 413.
7. In-Worker rate limits keyed by IPv4 address or IPv6 /64 (IPv4-mapped IPv6 normalised to IPv4): burst 5 / 10 s and 10 / 60 s → 429.
8. Body read with a **byte counter**, cancelled the moment it exceeds 16 KiB; strict UTF-8.
9. Strict JSON-RPC envelope: object, `jsonrpc: "2.0"`, `id` string or integer, `params` object; batches rejected.

For `request_intro` additionally:

10. Per-client limit: 1 per 60 s.
11. **Daily caps — 10 in total, 2 per IP, 2 per sender address** — reserved **atomically** in a SQLite-backed **Durable Object** (`IntroQuota`) **before** the email is sent. The Durable Object computes the day itself and never rolls back to an older day. Reservations are never refunded, so failures can only reduce what is sent (**fail-closed**). Sender addresses are stored as SHA-256 hashes.
12. Binding failures return a JSON-RPC error rather than crashing.

**Lesson learned:** the Workers rate-limit *binding* is approximate and per-machine — live, it blocked only **1 of 40** rapid requests. The edge WAF rule is what makes rate limiting real: with it, a 40-request burst gives exactly **6 × 200 then 34 × 429** from the edge.

## Security review

Hardened over **three Codex (gpt-6.1-sol) adversarial review rounds** until only an edge case remained:

| Round | Main findings → fixes |
|---|---|
| 1 | Non-atomic KV daily caps (20 parallel requests sent 20 emails) → Durable Object reservation before send. Unbounded body read → byte-capped reader. Reply-To injection via display name → address-only Reply-To. No Origin validation → 403 + restricted CORS + 415. Weak envelope/argument validation → strict, no coercion. Uncaught binding errors → caught. 2025-03-26 batching obligation → version dropped. RFC 2047 word length → split. Text/structured mismatch → unified. |
| 2 | Quota day could roll backwards at midnight → DO-owned monotonic day. IPv6 key normalisation → strict parser. First Subject line > 76 chars → first-word budget. Loose media-type match → exact. `arguments: null` / extra args on read tools → rejected. Confirmed DO atomicity is correct. |
| 3 | IPv4-mapped IPv6 forms produced different keys → full parse then numeric `::ffff:0:0/96` detection. Everything else verified (tens of thousands of generated cases). |

Key guards were proven with **revert-and-fail**: each was deliberately broken and the matching test failed. Confirmed in **production**: a test introduction arrived in Gmail's Inbox; the MCP server connects as a Claude custom connector showing all five tools.

<a id="sender-verification"></a>
### Why no sender verification

Double opt-in (email the sender a confirmation link) needs sending to arbitrary addresses, which Cloudflare only allows on Workers Paid (or an external service such as Resend). The chosen design is limits-only: exact daily caps, plus an "unverified sender" note in every email.

<a id="mcp-registry"></a>
## MCP Registry

Listed on the official registry (`registry.modelcontextprotocol.io`) as **`com.patrickjv/profile`** v1.1.0, status **active**, remote `streamable-http` → `https://patrickjv.com/mcp`.

- Entry: `mcp/server.json` (schema `2025-12-11`; description ≤ 100 characters — validated with `mcp-publisher validate`).
- Namespace proof: **HTTP domain verification** — `public/.well-known/mcp-registry-auth` holds the ed25519 public key (`v=MCPv1; k=ed25519; p=…`).
- The **private key** exists only at `~/.config/mcp-registry/key.pem` (mode 600) on Patrick's machine — back it up. To update the listing: bump `version`, then `mcp-publisher login http --domain patrickjv.com --private-key <hex>` and `mcp-publisher publish` (see [06](06-operations.md#mcp-registry-updates)).

## Using it

- **Claude:** Settings → Connectors → Add custom connector → `https://patrickjv.com/mcp`. Suggested permissions: read tools "Always allow", Request an introduction "Ask".
- **Any MCP client:** add the URL as a remote (Streamable HTTP) server.
- `npm run smoke -- https://patrickjv.com --mcp` performs a read-only handshake (never calls `request_intro`).

<a id="webmcp"></a>
## WebMCP

The page registers five tools with `navigator.modelContext` when present (Chromium experiment; WebKit opposes the spec, so no Safari/iOS): `get_profile`, `list_work`, `list_skills`, `list_faq` and **`request_intro`**.

- The script feature-detects, uses `registerTool` or falls back to `provideContext`, and is wrapped in `try/catch`; the page works identically without JavaScript.
- `request_intro` asks the **person** to confirm (`client.requestUserInteraction` if available, else `window.confirm`) before POSTing to `/mcp`, so every server-side limit applies. Its input schema is copied from the MCP server's `tools()` by the build.
- Tested in headless Chromium with a stubbed `modelContext`: declining sends nothing; accepting sends exactly one correct request; no CSP violations.
