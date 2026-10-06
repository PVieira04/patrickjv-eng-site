# 04 — MCP and WebMCP

## The MCP server

- **Endpoint:** `https://patrickjv.com/mcp` — MCP **Streamable HTTP**, stateless, JSON responses only (no SSE), no auth. Protocol versions `2025-11-25` and `2025-06-18`.
- **Worker:** `patrickjv-mcp` (`mcp/`), on the route `patrickjv.com/mcp*` only.
- **Server info:** name `patrickjv.com`, version imported from `mcp/server.json` (currently `1.1.0` — one source, so the server and the Registry entry cannot disagree), `websiteUrl`, and **icons** (the pjv favicon) on the server and every tool.

| Tool | Kind | Returns / does |
|---|---|---|
| `get_profile` | read-only | Name, headline, tagline, location, links (website, LinkedIn, GitHub, email) |
| `list_work` | read-only | Title, summary, tags per work item |
| `list_skills` | read-only | Skills |
| `list_faq` | read-only | The five Quick answers |
| `request_intro` | write | Emails Patrick an introduction on someone's behalf |

Read tools carry `readOnlyHint: true` (and `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`); `request_intro` carries `readOnlyHint: false`, `openWorldHint: true`. Read tools return `structuredContent` and its JSON serialisation as text, and take no arguments. Data comes from `lib/agent-data.mjs`, shared with the page.

`request_intro` arguments: `from_name` (1–100), `from_email` (ASCII address, ≤ 254), `reason` (`recruiting` | `collaboration` | `speaking` | `other`), `message` (20–2000), optional `organisation` (≤ 100), optional `agent` (≤ 100). Lengths are counted in Unicode **code points**, as JSON Schema counts them. Strictly validated, no type coercion, unknown fields rejected:

- `from_email` must be a **dot-atom** local part (no leading, trailing or consecutive dots; ≤ 64 octets) at a valid hostname. The domain is lower-cased; the local part keeps its case (it may be case-sensitive) and goes into `Reply-To` exactly.
- Single-line fields lose control characters and **bidi-override and zero-width characters**, so the Subject cannot display differently from what it says.
- The tool description states the privacy terms: the message is forwarded and not stored; rate-limit counters are hashed and kept for one day.

The email arrives from "patrickjv.com intro" `<intro@patrickjv.com>` with subject `[Intro · <reason>] <name> (<organisation>)` (RFC 2047 encoded words, every header line ≤ 76 characters), `Reply-To` the sender's address only, a CRLF-canonical base64 text body, and a footer marking it as an unverified sender.

### Code layout

- `mcp/handler.js` — all protocol and safety logic, including the quota Durable Object's reservation (`reserveIntro`) and alarm (`pruneQuota`) logic, with no Cloudflare-only imports, so it is fully unit-tested in Node.
- `mcp/index.js` — wires in `EmailMessage` (`cloudflare:email`) and the `IntroQuota` Durable Object, whose methods call `reserveIntro` / `pruneQuota`.
- `mcp/handler.test.mjs` — 46 tests, run against the real reservation code with an in-memory storage. `redirect/index.test.mjs` — 7 tests.

## Cost and abuse controls

Requests are rejected in the **cheapest order**; everything up to step 8 happens before the body is read:

1. Edge **WAF rule**: `/mcp*`, 6 requests / 10 s per IP, block 10 s — the Worker never runs for blocked requests.
2. Path must be exactly `/mcp` (else 404).
3. **Origin:** any `Origin` header that is present — **even an empty one** — must be exactly `https://patrickjv.com`, else 403. Server-side clients send no Origin and are allowed. CORS is granted only to `patrickjv.com`.
4. Method: `OPTIONS` → 204; anything but `POST` → 405.
5. Media type exactly `application/json` → else 415.
6. Declared `Content-Length` > 16 KiB → 413.
7. **`RL_MCP`**: 30 requests / 60 s per client, counting every request → 429 (`Retry-After: 60`). Clients are keyed by IPv4 address or IPv6 /64 (IPv4-mapped IPv6 normalised to IPv4).
8. **`MCP-Protocol-Version`**: if present it must be a supported version (an empty value is not) → else 400. If **absent**, the request is served exactly as under a negotiated version: the server is stateless and its responses are identical under both versions it speaks, so clients that omit the header (older clients, or ones that never initialised) still work.
9. Body read with a **byte counter**, cancelled the moment it exceeds 16 KiB (413); strict UTF-8.
10. Strict JSON-RPC envelope: object, `jsonrpc: "2.0"`, `params` an object, batches rejected. Client JSON-RPC responses must have exactly one of `result`/`error` (a well-formed `{code, message}`) → 202. Notifications → 202. Numeric `id`s must be **safe integers written as integer literals** — an id beyond 2^53 (or `1.0000000000000001`) is refused rather than answered with a different id.
11. **`RL_BURST`**: 10 requests / 10 s per client → 429, counting real work only: `initialize`, `ping`, `tools/list`, notifications and client responses are exempt, so a shared egress address (e.g. a hosted MCP client) does not use up its burst allowance on handshakes.
12. `initialize` must carry `protocolVersion` (string), `capabilities` (object) and `clientInfo` (`name`, `version` strings) → else JSON-RPC `-32602`.

For `request_intro` additionally:

13. Arguments validated (above) → tool error, nothing sent.
14. **`RL_INTRO`**: 1 per 60 s per client.
15. **Daily caps — 10 in total, 4 per IP (or IPv6 /64), 2 per sender** — reserved **atomically** in a SQLite-backed **Durable Object** (`IntroQuota`) **before** the email is sent. The per-IP cap is 4, not 2, because hosted MCP clients and corporate NAT put many people behind one address; the per-sender and global caps are the real bound on email volume. The Durable Object computes the day itself and never rolls back to an older day. Reservations are never refunded, so failures can only reduce what is sent (**fail-closed**).
16. **What the Durable Object stores:** only **HMAC-SHA256** keys, never an IP or an address — keyed with the `QUOTA_SALT` Worker secret (set on 6 Oct 2026), separately for the IP key and the sender key. The sender key is deliberately coarser than the address: lower-cased, `+tag` removed, and for Gmail (`gmail.com`/`googlemail.com`) dots removed, so trivial variants of one mailbox share one cap (`Reply-To` still uses the original). Only today's counters are kept: a new day replaces them, and an **alarm** at the end of their day (UTC midnight) deletes them even if no request follows. Whenever counters are stored an alarm is kept no earlier than the end of their day: a reservation moves a still-pending alarm from the previous day forward, an alarm that finds today's counters schedules the next midnight, and counters stored before alarms existed get one on the next reservation (even a refused one). **`QUOTA_SALT` is required:** if it is missing or shorter than 32 characters, `request_intro` refuses with a tool error (logged as subsystem `config`) before any rate limit, reservation or email — there is no fallback key, since a key in public source would protect nothing. The read tools are unaffected.
17. Binding, quota and email failures return a JSON-RPC or tool error rather than crashing; the tool asks the caller not to retry.

**Observability:** Workers Logs are enabled (`observability.enabled`), with `observability.redact_query_string: true` so query strings are stripped from request URLs in invocation logs and traces. Every caught failure logs a redacted `{"event":"mcp_failure","subsystem":…}` event (e.g. `ratelimit`, `body_read`, `json_parse`, `quota`, `email`, `config`) and quota refusals log `intro_quota_rejected` with which cap — never message bodies, addresses or IPs.

**Security headers** (`nosniff`, `Referrer-Policy: no-referrer`, HSTS, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`) are sent on **every** MCP response, including errors; the redirect Worker sends the same set.

**Lesson learned:** the Workers rate-limit *binding* is approximate and per-machine (counted per Cloudflare location) — live, it blocked only **1 of 40** rapid requests. The edge WAF rule is what makes rate limiting real: with it, a 40-request burst gives exactly **6 × 200 then 34 × 429** from the edge.

## Security review

Hardened over **three Codex (gpt-6.1-sol) adversarial review rounds** until only an edge case remained:

| Round | Main findings → fixes |
|---|---|
| 1 | Non-atomic KV daily caps (20 parallel requests sent 20 emails) → Durable Object reservation before send. Unbounded body read → byte-capped reader. Reply-To injection via display name → address-only Reply-To. No Origin validation → 403 + restricted CORS + 415. Weak envelope/argument validation → strict, no coercion. Uncaught binding errors → caught. 2025-03-26 batching obligation → version dropped. RFC 2047 word length → split. Text/structured mismatch → unified. |
| 2 | Quota day could roll backwards at midnight → DO-owned monotonic day. IPv6 key normalisation → strict parser. First Subject line > 76 chars → first-word budget. Loose media-type match → exact. `arguments: null` / extra args on read tools → rejected. Confirmed DO atomicity is correct. |
| 3 | IPv4-mapped IPv6 forms produced different keys → full parse then numeric `::ffff:0:0/96` detection. Everything else verified (tens of thousands of generated cases). |

A fourth, whole-site review on the evening of 6 Oct (Claude Opus 5.5 and Codex, [merged findings](reviews/2026-10-06-merged-review.md)) led to the protocol polish above: R14 (observability), R15 (handshake-exempt burst limit, per-IP cap 4), R19 (headers on every response), R30–R36 (ids, empty Origin, dot-atom, code points, CRLF, `initialize`/response validation, bidi stripping), R37 (sender key folding), R38 (308), R39 (version from `server.json`), R40 (HMAC keys, alarm pruning, privacy note), R41 (tests on the real reservation path; protocol header, OPTIONS and Content-Length tests) and R42 (absent protocol header accepted). A Codex round-2 review of those fixes added: alarm rescheduling (N2), a required `QUOTA_SALT` (N4), query-string redaction in logs (N6) and the protocol headers on the page's WebMCP request (R42).

Key guards were proven with **revert-and-fail**: each was deliberately broken and the matching test failed. Confirmed in **production**: a test introduction arrived in Gmail's Inbox; the MCP server connects as a Claude custom connector showing all five tools.

<a id="sender-verification"></a>
### Why no sender verification

Double opt-in (email the sender a confirmation link) needs sending to arbitrary addresses, which Cloudflare only allows on Workers Paid (or an external service such as Resend). The chosen design is limits-only: exact daily caps, plus an "unverified sender" note in every email.

<a id="mcp-registry"></a>
## MCP Registry

Listed on the official registry (`registry.modelcontextprotocol.io`) as **`com.patrickjv/profile`** v1.1.0, status **active**, remote `streamable-http` → `https://patrickjv.com/mcp`. `npm run smoke -- --registry` checks the listing (active, same version as `mcp/server.json`, same remote).

- Entry: `mcp/server.json` (schema `2025-12-11`; description ≤ 100 characters — validated with `mcp-publisher validate`). Its `version` is also the server's `serverInfo.version`.
- Namespace proof: **HTTP domain verification** — `public/.well-known/mcp-registry-auth` holds the ed25519 public key (`v=MCPv1; k=ed25519; p=…`), served as `text/plain; charset=utf-8`.
- The **private key** exists only at `~/.config/mcp-registry/key.pem` (mode 600) on Patrick's machine — back it up. To update the listing: bump `version`, then `mcp-publisher login http --domain patrickjv.com --private-key <hex>` and `mcp-publisher publish` (see [06](06-operations.md#mcp-registry-updates)).

## Using it

- **Claude:** Settings → Connectors → Add custom connector → `https://patrickjv.com/mcp`. Suggested permissions: read tools "Always allow", Request an introduction "Ask".
- **Any MCP client:** add the URL as a remote (Streamable HTTP) server.
- `npm run smoke -- https://patrickjv.com --mcp` runs the read-only lifecycle — `initialize` (checks the negotiated version, `serverInfo.name` = `patrickjv.com` and `serverInfo.version`), `notifications/initialized` (202), `tools/list` (exactly the five tools, each with icons), `tools/call list_faq` (`structuredContent.items` deep-equal to `content.json`'s `faq`) — sending `MCP-Protocol-Version` after initialisation and never calling `request_intro`.

<a id="webmcp"></a>
## WebMCP

The page registers five tools with **`document.modelContext`** (the current draft), falling back to `navigator.modelContext` (earlier drafts), when either is present (Chromium experiment; WebKit opposes the spec, so no Safari/iOS): `get_profile`, `list_work`, `list_skills`, `list_faq` and **`request_intro`**.

- Tool names, titles, descriptions, input schemas and `readOnlyHint` annotations come from the MCP server's `tools()`, spliced in by the build, so the two surfaces describe the same tools in the same words (including "not the footballer").
- The script feature-detects, uses `registerTool` (each returned promise's rejection is caught) or falls back to `provideContext`, and is wrapped in `try/catch`; the page works identically without JavaScript.
- `request_intro` asks the **person** to confirm (the draft's `requestUserInteraction` if offered, else `window.confirm`) showing **all six fields** — From, Email, Organisation, Reason, Agent and Message — and sends a **snapshot** of exactly what was shown. It honours the caller's abort `signal`: checked before confirming, again before sending, and passed to `fetch`. It then POSTs a single `tools/call` to `/mcp`, so every server-side limit applies, with `MCP-Protocol-Version: 2025-11-25` and `Accept: application/json, text/event-stream`. It does not run the `initialize` handshake (one request, not three); the stateless server accepts that (step 8 above).
- Tested in headless Chromium with a stubbed `modelContext` (before the review fixes): declining sends nothing; accepting sends exactly one correct request; no CSP violations.
