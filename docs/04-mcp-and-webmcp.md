# 04 — MCP and WebMCP

## The MCP server

- **Endpoint:** `https://patrickjv.com/mcp` — MCP **Streamable HTTP**, stateless, JSON responses only (no SSE), no auth. Protocol versions `2025-11-25` and `2025-06-18`.
- **Worker:** `patrickjv-mcp` (`mcp/`), on the routes `patrickjv.com/mcp*` and `patrickjv.com/api/booking*` ([booking](#booking)) only.
- **Server info:** name `patrickjv.com`, version imported from `mcp/server.json` (currently `1.2.0` — one source, so the server and the Registry entry cannot disagree), `websiteUrl`, and **icons** (the pjv favicon) on the server and every tool.

| Tool | Kind | Returns / does |
|---|---|---|
| `get_profile` | read-only | Name, headline, tagline, location, links (website, LinkedIn, GitHub, email) |
| `list_work` | read-only | Title, summary, tags per work item |
| `list_skills` | read-only | Skills |
| `list_faq` | read-only | The five Quick answers |
| `request_intro` | write | Emails Patrick an introduction on someone's behalf |
| `list_meeting_types`, `get_availability`, `book_meeting`, `get_booking_status`, `cancel_booking` | read / write | Booking, see [below](#booking) |

Read tools carry `readOnlyHint: true` (and `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`); `request_intro` carries `readOnlyHint: false`, `openWorldHint: true`. Read tools return `structuredContent` and its JSON serialisation as text, and take no arguments. Data comes from `lib/agent-data.mjs`, shared with the page.

`request_intro` arguments: `from_name` (1–100), `from_email` (ASCII address, ≤ 254), `reason` (`recruiting` | `collaboration` | `speaking` | `other`), `message` (20–2000), optional `organisation` (≤ 100), optional `agent` (≤ 100). Lengths are counted in Unicode **code points**, as JSON Schema counts them. Strictly validated, no type coercion, unknown fields rejected:

- `from_email` must be a **dot-atom** local part (no leading, trailing or consecutive dots; ≤ 64 octets) at a valid hostname. The domain is lower-cased; the local part keeps its case (it may be case-sensitive) and goes into `Reply-To` exactly.
- Single-line fields lose control characters and **bidi-override and zero-width characters**, so the Subject cannot display differently from what it says.
- The tool description states the privacy terms: the message is forwarded and not stored by this site; rate-limit counters are hashed and **expire daily**. It deliberately does not promise exactly one day of retention: Cloudflare keeps 30 days of Durable Object recovery history (see [05](05-quality-and-audits.md#privacy)).

The email arrives from "patrickjv.com intro" `<intro@patrickjv.com>` with subject `[Intro · <reason>] <name> (<organisation>)` (RFC 2047 encoded words, every header line ≤ 76 characters), `Reply-To` the sender's address only, a CRLF-canonical base64 text body, and a footer with the time received and an unverified-sender note. Since round 3 (C3-F11) the footer carries **no country or client (user-agent) metadata** — data minimisation; it was never needed to judge an introduction.

### Code layout

- `mcp/handler.js` — all protocol and safety logic, including the quota Durable Object's reservation (`reserveIntro`) and alarm (`pruneQuota`) logic, with no Cloudflare-only imports, so it is fully unit-tested in Node.
- `mcp/index.js` — wires in `EmailMessage` (`cloudflare:email`) and the `IntroQuota` Durable Object, whose methods call `reserveIntro` / `pruneQuota`.
- `mcp/handler.test.mjs` — 51 tests, run against the real reservation code with an in-memory storage.

## Cost and abuse controls

Requests are rejected in the **cheapest order**; everything up to step 8 happens before the body is read:

1. Edge **WAF rule**: `/mcp*`, 6 requests / 10 s per IP, block 10 s — the Worker never runs for blocked requests. It caps the rate (up to ~51,840 requests per IP per day still get through), it does not stop a flood outright; see [Which limit binds](#which-limit-binds).
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

**Observability:** Workers Logs keep **only the handler's own console events**: `observability.logs.invocation_logs: false` (since round 3, review C3-F4/R40) turns off the per-request invocation logs, which would otherwise record each request's metadata (client IP, location, user agent); `redact_query_string: true` stays as a second line of defence. Verified against the installed Wrangler schema and with `npx wrangler deploy --dry-run -c mcp/wrangler.jsonc`. Every caught failure logs a redacted `{"event":"mcp_failure","subsystem":…}` event (e.g. `ratelimit`, `body_read`, `json_parse`, `quota`, `email`, `config`) and quota refusals log `intro_quota_rejected` with which cap — never message bodies, addresses or IPs.

**Security headers** (`nosniff`, `Referrer-Policy: no-referrer`, HSTS, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`) are sent on **every** MCP response, including errors.

<a id="which-limit-binds"></a>
### Which limit binds (accepted trade-offs, review C3-F2 / C3-F12)

- **The edge WAF rule is stricter than the Worker.** It counts *every* request per IP — handshakes included — at 6 per 10 s; the Worker allows 30 per minute and 10 non-handshake calls per 10 s. For IPv4 the WAF is therefore the binding limit, and the R15 handshake exemption only helps within it (or for IPv6, where the WAF counts single addresses but the Worker counts a /64). A blocked request gets Cloudflare's **1015 HTML page** (status 429), which MCP clients cannot parse as JSON-RPC.
- **Shared egress.** An MCP session is about 4 requests, so one IPv4 address (a hosted MCP client's egress, or corporate NAT) gets roughly **one and a half sessions per 10 s** for all its users together. The per-IP intro cap (4 a day) is shared the same way.
- **Global cap.** 10 introductions a day in total. Exhausting it needs 5 sender addresses (2 each) and 3 IPs (4 each), and takes about 4 minutes at 1 per minute per IP — then `request_intro` refuses everyone until UTC midnight, with the error naming `hello@patrickjv.com`. Accepted: email volume to one personal mailbox is the thing being protected, and the fallback is always email.
- **Owner option:** raise the WAF threshold (e.g. to 20 per 10 s), so the Worker's own limits bind and a shared egress address is not blocked by the handshake. That is a dashboard change; until decided, the numbers above stand.

**Lesson learned:** the Workers rate-limit *binding* is approximate and per-machine (counted per Cloudflare location) — live, it blocked only **1 of 40** rapid requests. The edge WAF rule is what makes rate limiting real: with it, a 40-request burst gives exactly **6 × 200 then 34 × 429** from the edge.

## Security review

Hardened over **three Codex (gpt-6.1-sol) adversarial review rounds** until only an edge case remained:

| Round | Main findings → fixes |
|---|---|
| 1 | Non-atomic KV daily caps (20 parallel requests sent 20 emails) → Durable Object reservation before send. Unbounded body read → byte-capped reader. Reply-To injection via display name → address-only Reply-To. No Origin validation → 403 + restricted CORS + 415. Weak envelope/argument validation → strict, no coercion. Uncaught binding errors → caught. 2025-03-26 batching obligation → version dropped. RFC 2047 word length → split. Text/structured mismatch → unified. |
| 2 | Quota day could roll backwards at midnight → DO-owned monotonic day. IPv6 key normalisation → strict parser. First Subject line > 76 chars → first-word budget. Loose media-type match → exact. `arguments: null` / extra args on read tools → rejected. Confirmed DO atomicity is correct. |
| 3 | IPv4-mapped IPv6 forms produced different keys → full parse then numeric `::ffff:0:0/96` detection. Everything else verified (tens of thousands of generated cases). |

A fourth, whole-site review on the evening of 6 Oct (Claude Opus 5.5 and Codex, [merged findings](reviews/2026-10-06-merged-review.md)) led to the protocol polish above: R14 (observability), R15 (handshake-exempt burst limit, per-IP cap 4), R19 (headers on every response), R30–R36 (ids, empty Origin, dot-atom, code points, CRLF, `initialize`/response validation, bidi stripping), R37 (sender key folding), R38 (308), R39 (version from `server.json`), R40 (HMAC keys, alarm pruning, privacy note), R41 (tests on the real reservation path; protocol header, OPTIONS and Content-Length tests) and R42 (absent protocol header accepted). A Codex round-2 review of those fixes added: alarm rescheduling (N2), a required `QUOTA_SALT` (N4), query-string redaction in logs (N6) and the protocol headers on the page's WebMCP request (R42). Round 3 (Claude and Codex, 7 Oct) added: the `patrickjv/health` readiness method, invocation logs off, no country/client metadata in emails, an accurate retention statement, and WebMCP normalisation and uncertain-delivery wording (see [the merged review §8](reviews/2026-10-06-merged-review.md#8-round-3-claude--codex)).

Key guards were proven with **revert-and-fail**: each was deliberately broken and the matching test failed. Confirmed in **production**: a test introduction arrived in Gmail's Inbox; the MCP server connects as a Claude custom connector showing all five tools.

<a id="readiness"></a>
### Readiness signal: `patrickjv/health`

A read-only JSON-RPC method that says whether `request_intro` is **configured**, for monitoring (reviews Codex-2 / C3-F8):

```json
{"jsonrpc":"2.0","id":4,"method":"patrickjv/health"}
→ {"jsonrpc":"2.0","id":4,"result":{"introReady":true,"salt":true,"email":true,"quota":true,"rateLimits":true,"bookingEnabled":false,"bookingReady":false}}
```

- **Booleans only**: `salt` (the `QUOTA_SALT` secret is present and at least 32 characters), `email` (the `EMAIL` send binding plus non-empty `INTRO_FROM`/`INTRO_TO_ADDRESS`), `quota` (the `IntroQuota` Durable Object binding), `rateLimits` (`RL_INTRO`, `RL_MCP`, `RL_BURST`), and `introReady` = all four. Never a secret, its length or an address.
- **Booking:** `bookingEnabled` is the kill switch (`BOOKING_ENABLED` is exactly `"true"`). `bookingReady` says booking would work if switched on: every booking secret set (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `RESEND_API_KEY`, `BOOKING_OWNER_EMAIL`, the `CAL_*` calendar secrets, the `BOOKING_FROM` var, `QUOTA_SALT`) and the `BOOKING` binding present, and only then the `BookingStore` answering and a **fresh Google token refresh** succeeding (cached for a minute in the store). It's reported independently of the flag so it can be checked before launch. Because the 6-hourly monitor calls it, the refresh token is never unused for six months, and a revoked one shows within 6 hours.
- It goes through the **same rejection chain** as every request (WAF, Origin, method, media type, size, `RL_MCP`, protocol header) and counts against `RL_BURST` (it is not handshake-exempt).
- **Why a custom method:** MCP requires a `ping` result to be empty, so extending `ping` would break the spec; a tool would be listed to users in every client. A vendor-prefixed method (`patrickjv/…`, the slash style MCP uses for its own methods) cannot collide with a future spec method, and any other server answers it with `-32601`.
- It shows configuration, not delivery: an Email Routing outage would not show here. Routine monitoring never sends an email; delivery is confirmed by occasional manual tests and by redacted `mcp_failure` events (`email`, `quota`, `config`) in Workers Logs.
- `smoke --mcp` FAILs unless `introReady` is `true`, and, when `bookingEnabled` is `true`, `bookingReady` is too (exactly seven boolean keys). Booking switched off passes whatever its readiness.

<a id="sender-verification"></a>
### Why no sender verification

Double opt-in (email the sender a confirmation link) needs sending to arbitrary addresses, which Cloudflare only allows on Workers Paid (or an external service such as Resend). The chosen design is limits-only: exact daily caps, plus an "unverified sender" note in every email.

<a id="booking"></a>
## Booking (F-001)

Spec: [F-001](specs/F-001-booking.md). **Ships dark:** `BOOKING_ENABLED` is `"false"` in `mcp/wrangler.jsonc` until the [launch checklist](06-operations.md#booking-launch) is done.

Every booking starts as a **hold** and becomes a meeting only when the guest clicks **Confirm** in an email sent to the address given. Page bookings and agent bookings take the same path. All booking state lives in one SQLite Durable Object, `BookingStore`, and every operation (holding, confirming, cancelling, availability) runs inside it, so its claim-before-await blocks serialise (spike S2).

### Tools

| Tool | Kind | Input | Output |
|---|---|---|---|
| `list_meeting_types` | read-only | none | `{items: [{id, title, minutes, description}]}` from `booking.json` |
| `get_availability` | read-only | `type`; optional `from`, `to` (`YYYY-MM-DD`, London days, clamped to today … +28 days) | `{timezone: "Europe/London", slots: [{start, end}]}`, ISO 8601 with the London offset (`2026-10-21T10:00:00+01:00`) |
| `book_meeting` | write, not idempotent | `type`, `start` (as given by `get_availability`), `name` (1–100), `email` (ASCII, ≤ 254), optional `note` (≤ 500) | `{booking_id, status: "pending_confirmation", hold_expires}` |
| `get_booking_status` | read-only | `booking_id` (32 lowercase hex) | `{status, status_reason?, start, end, type}`; never the guest's name or address |
| `cancel_booking` | destructive | `booking_id` | `{status: "cancelled"}` for a hold; `{status: "confirmed", cancellation: "requested"}` for a meeting (the guest is emailed a confirm-cancellation link) |

- Descriptions tell agents to book or cancel only when the person asked, not to retry on error, and (for `book_meeting`) what is kept and for how long, with a link to `/privacy`. `initialize`'s `instructions` say the same.
- Failures are tool errors (`isError: true`) whose text is the message plus the error code and "Do not retry automatically."; `structuredContent` is `{error, message, reason?}`.
- Statuses: `pending_confirmation`, `confirmed`, `declined` (`guest_declined`, `slot_taken`, `day_full`), `expired` (`hold_expired`), `cancelled` (`guest_cancelled`, `agent_withdrew`, `email_failed`).

### HTTP API (`/api/booking*`)

Served by the same Worker on a second route, for the `/book` page and the page's WebMCP tools. JSON responses carry the same security headers as `/mcp`; errors are `{error, message}` (the page shows `message` as plain text).

| Method | Path | Does |
|---|---|---|
| GET | `/api/booking/types` | `{types: [...]}` |
| GET | `/api/booking/availability?type=&from=&to=` | as `get_availability` |
| POST | `/api/booking` | JSON `{type, start, name, email, note?, source?}` → **202** `{booking_id, status, hold_expires}` |
| GET | `/api/booking/status?booking_id=` | as `get_booking_status` (for WebMCP) |
| POST | `/api/booking/cancel` | JSON `{booking_id}`, as `cancel_booking` (for WebMCP) |
| GET | `/api/booking/act?t=<token>` | HTML page saying what the link will do, with a button; **never changes anything** (mail scanners prefetch links) |
| POST | `/api/booking/act` | form or JSON `{t}` → performs confirm, decline, cancel or confirm-cancel → HTML result page |

**`source`** is the channel a request arrived on: `mcp` for the MCP tools (always; an agent can't set it), and on `POST /api/booking` an optional `"page"` (the default, sent by `/book`) or `"webmcp"` (sent by the page's WebMCP `book_meeting`); anything else is 400. "page" versus "webmcp" is self-reported by the browser and is not proof of a human: it only chooses the hold email's wording ("Someone used this email address…" or "An AI agent asked…"). Consent comes from the email confirmation, not the channel.

**Status codes:** 400 invalid input or a start that was never a slot · 403 foreign `Origin` · 404 unknown path, unknown or used link · 405 · 409 slot taken, or a start now inside the 24-hour notice window or past the horizon (so the page reloads slots) · 410 expired link · 413 · 415 · 429 rate limit, daily cap (`reason` `ip`, `email` or `global`; global says "Booking is closed for today") or `hold_pending` · 503 `booking_disabled`, `unavailable` (Google or the store unreachable, or not configured) or `email_failed`.

**Act pages** work without JavaScript: plain HTML in the site's colours and font, inline CSS allowed by its hash. Their CSP is `default-src 'none'; style-src 'sha256-…'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, with `Cache-Control: no-store` (the URL holds a token) and `Referrer-Policy: same-origin` rather than `no-referrer`, because a form POST under `no-referrer` sends `Origin: null`, which the Origin check refuses. They show the meeting type and time (London and UTC), never the guest's details, and say "This link has already been used" (404), "This link has expired" (410) or "That slot was taken" (409, with a link to `/book`).

### Limits, in order

The HTTP API uses `/mcp`'s rejection order: path → `Origin` (any present Origin must be `https://patrickjv.com`) → method → media type (`application/json`; the act POST also takes a form) → declared size (16 KiB) → **`RL_MCP`** (every request) → **`RL_BURST`** (every POST) → capped body read. No new rate-limit namespace: the store's daily caps are the real bound. Then, in the store, reserved atomically before any Google call or email and never refunded: **10 requests a day in total, 4 per IP (IPv6 /64), 2 per guest email**, and **one live hold per IP and per email**. Quota keys are HMACs with `QUOTA_SALT` (`booking-ip`, `booking-email`, the email folded as for introductions). The request that reaches the global cap triggers **one alert email** to `INTRO_TO_ADDRESS` through the `send_email` binding, once a day.

**Kill switch:** `BOOKING_ENABLED` other than exactly `"true"` makes `book_meeting`, `cancel_booking`, `POST /api/booking` and `POST /api/booking/cancel` answer 503 `booking_disabled` ("Booking isn't open yet."). Links already emailed keep working (confirm, decline, cancel), as the spec's edge case requires. `list_meeting_types` and status always work; availability works whenever booking is configured.

**Availability** reuses one free/busy answer for 60 s, so listing slots can't make the Worker hammer Google; holding and confirming always ask Google afresh.

### Inside the BookingStore

- `mcp/booking-service.js` builds the deps from `env` inside the Durable Object: the Google client (`hello@`'s refresh token), the Resend mailer (`BOOKING_FROM`), free/busy over the `blocks: true` calendars (IDs from `booking.json` or the Worker secret each `idSecret` names), the act-link URL and Patrick's address (`BOOKING_OWNER_EMAIL`, invited to every meeting; `guestsCanSeeOtherGuests: false`).
- The **alarm** expires lapsed holds, deletes records past retention, and finishes confirms or cancels cut off by an eviction: a booking left in `confirming` or `cancelling` with no call in this instance working on it for over 2 minutes is retried (`insertEvent` with the same ID, where 409 means it exists, then "Booked" email; or `deleteEvent`). On a Google failure it's left for the next alarm, a few minutes later. Before every confirm or cancel the alarm is pulled to within 3 minutes, so recovery happens even if the instance dies mid-call.
- Health asks the store for a fresh Google token refresh, cached for a minute.

### Code layout (booking)

`booking-config.js` (rules, London time, slots), `booking-store.js` (schema, state machine), `booking-google.js` (Calendar client), `booking-email.js` (Resend client and texts), `booking-service.js` (the Durable Object's body), `handler.js` (validation, kill switch, MCP tools, HTTP API, act pages, health), `index.js` (`BookingStore` class). Tests: `booking-*.test.mjs` against `node:sqlite` with a fake Google and Resend (`booking-fakes.mjs`, `booking-harness.mjs`), and `test/webmcp-booking.test.mjs`, which runs the page's WebMCP script against the real handler.

<a id="mcp-registry"></a>
## MCP Registry

Listed on the official registry (`registry.modelcontextprotocol.io`) as **`com.patrickjv/profile`** v1.1.0 (1.2.0, with booking, is published at launch), status **active**, remote `streamable-http` → `https://patrickjv.com/mcp`. `npm run smoke -- --registry` checks the listing (active, same version as `mcp/server.json`, same remote).

- Entry: `mcp/server.json` (schema `2025-12-11`; description ≤ 100 characters — validated with `mcp-publisher validate`). Its `version` is also the server's `serverInfo.version`.
- Namespace proof: **HTTP domain verification** — `public/.well-known/mcp-registry-auth` holds the ed25519 public key (`v=MCPv1; k=ed25519; p=…`), served as `text/plain; charset=utf-8`.
- The **private key** exists only at `~/.config/mcp-registry/key.pem` (mode 600) on Patrick's machine — back it up. To update the listing: bump `version`, then `mcp-publisher login http --domain patrickjv.com --private-key <hex>` and `mcp-publisher publish` (see [06](06-operations.md#mcp-registry-updates)).

## Using it

- **Claude:** Settings → Connectors → Add custom connector → `https://patrickjv.com/mcp`. Suggested permissions: read tools "Always allow", Request an introduction "Ask".
- **Any MCP client:** add the URL as a remote (Streamable HTTP) server.
- `npm run smoke -- https://patrickjv.com --mcp` runs the read-only lifecycle — `initialize` (checks the negotiated version, `serverInfo.name` = `patrickjv.com` and `serverInfo.version`), `notifications/initialized` (202), `tools/list` (exactly the ten tools, each with icons), `tools/call list_faq` (`structuredContent.items` deep-equal to `content.json`'s `faq`), `patrickjv/health` (`introReady` must be `true`, and `bookingReady` too if booking is on) — five requests, sending `MCP-Protocol-Version` after initialisation and never calling `request_intro` or a booking write.

<a id="webmcp"></a>
## WebMCP

The page registers ten tools with **`document.modelContext`** (the current draft), falling back to `navigator.modelContext` (earlier drafts), when either is present (Chromium experiment; WebKit opposes the spec, so no Safari/iOS): `get_profile`, `list_work`, `list_skills`, `list_faq`, **`request_intro`** and the five booking tools.
- **Booking tools** call the same-origin booking API (`/api/booking*`), which runs the same operations as the MCP tools, so results are the same; `connect-src 'self'` already allows it. `book_meeting` sends only the five known fields plus `source: "webmcp"`. A server error is passed on as the server's message; once a booking request has been sent, no readable answer is reported as "may or may not have been held", never "not booked". The build fails if a booking tool has no implementation in the page script, and `test/webmcp-booking.test.mjs` runs the script against the real handler.

- Tool names, titles, descriptions, input schemas and `readOnlyHint` annotations come from the MCP server's `tools()`, spliced in by the build, so the two surfaces describe the same tools in the same words (including "not the footballer").
- The script feature-detects, uses `registerTool` (each returned promise's rejection is caught) or falls back to `provideContext`, and is wrapped in `try/catch`; the page works identically without JavaScript.
- `request_intro` first **normalises the input exactly as the server will** (single-line fields lose control, bidi and zero-width characters; the message gets LF newlines and loses control characters; `from_email` and `reason` are trimmed — review C3-F14), then asks the **person** to confirm (the draft's `requestUserInteraction` if offered, else `window.confirm`) showing **all six fields** — From, Email, Organisation, Reason, Agent and Message — and sends a **snapshot** of exactly what was shown, so the approved text is the text in the email. It honours the caller's abort `signal`: checked before confirming, again before sending, and passed to `fetch`. It then POSTs a single `tools/call` to `/mcp`, so every server-side limit applies, with `MCP-Protocol-Version: 2025-11-25` and `Accept: application/json, text/event-stream`. It does not run the `initialize` handshake (one request, not three); the stateless server accepts that (step 8 above).
- **Delivery wording.** A server JSON-RPC error is passed on as the server's message. Once the request has been sent, a network error, an unreadable or unparseable response body, or a response with neither `result` nor `error` is reported as **uncertain** — "may or may not have been delivered. Do not retry; the person can email hello@patrickjv.com instead" — never "not sent" (review Codex-5).
- `test/webmcp.test.mjs` runs the page's script in a VM: five tools register; hostile input (bidi, zero-width, control characters, CRLF) is shown and sent exactly as the server's `validateIntro` normalises it; declining sends nothing; unreadable or unexpected responses give the uncertain-delivery wording.
- Tested in headless Chromium on 7 Oct (local `wrangler dev`, stubbed `document.modelContext`, `/mcp` stubbed): five tools registered; the confirm dialog showed the normalised values and exactly those were sent; declining sent nothing; an unreadable body gave the uncertain-delivery wording; no console or CSP errors.
