# Feature Spec: Signed-in agent booking

> **Purpose:** Let AI agents book a meeting with Patrick for a person who has signed in, so the booking is made in a verified name and needs no confirmation email.
> **Update when:** Requirements shift, acceptance criteria change, or scope moves during the build.
> **Related:** [F-001 Booking](F-001-booking.md) (this builds on it), [`../04-mcp-and-webmcp.md`](../04-mcp-and-webmcp.md), [`../06-operations.md`](../06-operations.md).

---

## Metadata

| Field | Value |
|---|---|
| Spec ID | F-002 |
| Status | Draft |
| Phase | P1 (MCP sign-in with Google); P2 and P3 outlined |
| Owner | @PVieira04 |
| Created | 2026-10-09 |
| Last updated | 2026-10-09 |
| Depends on | F-001 (shipped 8 Oct 2026); a new Google Cloud project for visitor sign-in |

---

## Summary

Today every booking is a 2-hour hold that becomes a meeting only when the guest clicks a link emailed to them. That exists because an agent can give any email address, so the site can't trust it. F-002 replaces that check for agents with sign-in. An agent that wants to book over MCP must act for a person who has signed in with Google (more providers later). The booking uses that person's **verified** name and address, is confirmed immediately, and the person gets a "Booked" email with a one-click cancel link instead of a "Please confirm" email. Reading tools stay anonymous. For now `/book` and the homepage's WebMCP tools keep F-001's anonymous email-confirmation path. **The long-term aim is to retire anonymous booking and anonymous intro messages** once sign-in covers every path (P4); P1–P3 add the sign-in paths that make that possible.

---

## User Stories

### US-1: Agent books for its signed-in person

As **a person using an AI agent**, I want to **sign in when my agent books, and have the booking made straight away**, so that **a meeting gets booked without an email round trip**.

**Why this matters:** The confirmation email is friction that only exists because the site can't tell who the agent acts for. A verified identity removes the reason for it.

### US-2: Strangers' inboxes stay out of it

As **someone whose address an agent might use**, I want **no email from patrickjv.com unless I booked**, so that **nobody can use the site to send me mail in my name**.

**Why this matters:** Today a made-up address still gets a hold email (bounded by caps). With sign-in required for MCP bookings, an agent there can only book for the person who signed in. Until the anonymous `/book` and WebMCP paths are retired (P4), they still send a confirmation email to the address typed, so this story is fully met only at P4.

### US-3: Anonymous agents can still read

As **an agent without sign-in support**, I want to **still read the profile, meeting types and availability, and be told how a person can book**, so that **the site stays useful without an account**. (Until P4 that pointer is the anonymous `/book`; after P4 it's sign-in.)

### US-4: Signed-in owner cancels directly

As **a signed-in person**, I want **my agent to cancel my own meeting straight away**, so that **cancelling is as easy as booking**.

### US-5: Patrick controls which agent apps can connect

As **Patrick**, I want **only known agent apps (Claude and VS Code in P1; ChatGPT in P3) to be able to connect at first**, so that **the consent screen can't be abused by look-alike apps**.

### US-6: Abuse stays bounded

As **Patrick**, I want **per-person caps and the existing global caps on signed-in bookings**, so that **one compromised or misbehaving agent can't fill my calendar**.

### US-7 (P2): Sign in on the site

As **a visitor on patrickjv.com**, I want to **sign in on the site so `/book` and the homepage's WebMCP tools book directly, confirming each booking in the page**, so that **I skip the confirmation email there too**.

---

## Goals & Non-Goals

**Goals**

- An agent can book over MCP only for a signed-in person, and that booking is confirmed immediately in the person's verified name.
- Signed-in bookings send email only to the verified address. (The interim anonymous paths still send one confirmation email to the address typed, as in F-001.)
- Until P4, nothing that works anonymously today breaks, except anonymous MCP `book_meeting`/`cancel_booking`, which now need sign-in.
- **P4: retire anonymous booking and anonymous `request_intro`**, so every booking and intro comes from a signed-in person.
- Cost stays at £0.

**Non-Goals**

- **Booking for someone else, ever.** An agent books only for the email address of the account it's signed in with; any other `email` is refused (`email_mismatch`). Someone booking for another person has that person sign in (or, until P4, uses `/book`). The site never builds delegation itself (decided by Patrick, 2026-10-09). Accepting a provider-asserted "acts for" claim would be a new decision that revisits this non-goal; see Watch.
- **Dynamic Client Registration.** Deprecated in MCP 2026-07-28 and a spam risk on the Free plan's KV write allowance (1,000 a day). Only clients that identify with a Client ID Metadata Document (CIMD) can connect. Revisit only if a needed client lacks CIMD (Cursor is unverified).
- **Keeping Google's tokens.** Only the verified claims are read, once, at sign-in.
- **Rescheduling** (still F-001's planned v2).

---

## Decisions (2026-10-09)

| # | Decision | Alternatives rejected |
|---|---|---|
| D1 | **MCP booking writes require sign-in.** `book_meeting` and `cancel_booking` over MCP need a token; everything else stays anonymous. | Optional "fast lane": no client prompts sign-in unless the server asks, so most agent bookings would stay anonymous and strangers' inboxes would stay exposed. |
| D2 | **Allowlist of agent apps** at launch: Client ID Metadata Documents hosted on `claude.ai` and `vscode.dev`. Others are refused before the consent page. **ChatGPT moves to P3** (spike 2026-10-09): it supports CIMD, but it only shows its sign-in UI for a tool *result* carrying `_meta["mcp/www_authenticate"]` plus per-tool `securitySchemes`, not for the HTTP 401 Claude uses, and no documented signal tells the two clients apart. Its write-capable MCP is also limited to Business/Enterprise/Edu workspaces on the web. | Any CIMD client: more phishing surface on the consent page. |
| D3 | **A signed-in owner cancels directly**; anonymous bookings keep the emailed confirm-cancellation link. | Email confirmation for every cancellation: safer against a rogue agent, but undoes much of the point. |
| D4 | **A separate Google Cloud project** (`patrickjv-signin`) for visitor sign-in, scopes `openid email profile` only. | The same project as `hello@`'s calendar access. It would work: Google's 100-user cap counts only users granting unapproved sensitive scopes, and the warning screen follows the requested scopes. But branding and the cap are per project, a public sign-in would share risk with the project that holds the calendar token, and a basic-scope-only project can get brand verification (name and logo) cleanly. ([spike](F-001-spikes/README.md#f-002-research-2026-10-09)) |
| D5 | **Consent per booking comes from signing in for it (D7)**, backed by the agent host's own tool approval and the "Booked" notification with one-click cancel. Where a client declares elicitation on MCP 2026-07-28, also ask it to confirm the slot details (P3). | Consent granted once at connect time through the `booking` scope: a token that outlives the booking lets an agent book again without the person. |
| D7 | **Sign in for every booking.** No refresh tokens (`refreshTokenTTL: 0`), an access token lasting **15 minutes** (`accessTokenTTL: 900`, enough for one conversation: availability, then booking), and its grant **revoked as soon as a booking or cancellation succeeds**. Each booking therefore needs the person to sign in at that moment, which is also the per-booking consent D5 couldn't otherwise guarantee: an agent left on "always allow" can't book later in the person's name. (Decided by Patrick, 2026-10-09: people spend little time on the site, so asking every time is reasonable.) **Single use is enforced in `BookingStore`, not by KV revocation:** the token's grant ID is recorded as spent in the same synchronous block that claims the slot (claim-before-await), so concurrent requests with one token produce at most one booking or cancellation; revoking the grant in KV follows and may fail without harm. A confirm finished by the alarm's recovery still counts as that token's use. **Scope:** D7 governs OAuth tokens (MCP). P2's site session is ruled by its own per-booking in-page confirmation. | Rotating 30-day refresh tokens: the KV spike read the library's source and found that after a refresh the *previous* refresh token stays valid and reusing it re-arms it, so a leaked one could be replayed indefinitely. A 24-hour token: lets a misbehaving agent book again within the day without the person. |
| D8 | **Guard the KV write allowance** (Free plan: 1,000 writes, 1,000 deletes and 1,000 lists a day, separate counts, reset 00:00 UTC). (a) **Consent and the Google round-trip are ours, not the library's KV-backed helpers.** The consent page (GET) writes nothing. Approving it (POST) creates a transaction row in `BookingStore`'s SQLite, holding the approved request and a random upstream `state`, plus a `__Host-` cookie bound to it. The Google callback consumes that row. SQLite on a Durable Object allows 100,000 row writes a day on Free, so abandoned sign-ins cost nothing that matters. KV is touched only by `completeAuthorization`, the token exchange and revocation. (b) Rate limits: GET `/oauth/authorize` 10 a minute per IP; POST `/oauth/authorize` and `/oauth/token` 6 a minute per IP. (c) **Real writes are counted, not estimated.** The library gets a wrapped `OAUTH_KV` binding that records every put, delete and list in `BookingStore` under the UTC day it actually happens. A KV-writing step is admitted only if today's real count plus that step's maximum (at most 6 operations) is at or below **700**; otherwise it gets 503 with `Retry-After` until 00:00 UTC. In-flight steps are bounded by the rate limits (at most about 20 at once, so 120 operations), well inside the 300 headroom to Cloudflare's 1,000, including steps that straddle midnight. (d) Health warns at 500. If real use ever reaches it, move to Workers Paid ($5 a month, 1M writes). | Moving token storage to the Durable Object: the library hard-codes `env.OAUTH_KV` with no pluggable storage, so a full stand-in would be unsupported and fragile. Wrapping the binding only to count is a thin proxy. Using the library's consent helpers: they write KV when the consent page is shown, and need a cookie round trip between start and approval. |
| D9 | **Quota accounting for signed-in bookings.** Per identity: 2 requests a day and 2 upcoming meetings (replacing F-001's per-email caps on this path; values provisional, see Open Questions). F-001's per-IP daily cap and the global daily cap still apply, and so does the 3-a-day limit. With no hold email, the global count is reserved at the claim, synchronously, before any Google call. All are never refunded. | Dropping the per-IP cap for signed-in bookings: it costs nothing and still limits one machine using many accounts. |
| D6 | **Build with `@cloudflare/workers-oauth-provider` 1.2.x** using its split authorisation-server API (authorisation-request parsing, client lookup, `completeAuthorization`, the token endpoint and `validateToken`; consent and upstream sign-in are ours per D8a), and keep the existing stateless JSON MCP handler as the resource server. Before the build, confirm 1.2.3 exposes those pieces without its consent helpers; if it doesn't, stop and re-plan. | The library's `OAuthProvider` wrapper: it would 401 every anonymous request to `/mcp`. Cloudflare `agents`/McpAgent: not needed for a stateless server. A hosted broker (WorkOS AuthKit): another US processor, and free-tier MCP support unverified. |

**Residual risk, stated plainly:** with D7 a token is good for one booking within 15 minutes of signing in, so an agent can't book later without the person. Within that window, a misbehaving agent could book a different slot from the one the person asked for. It's bounded by the per-person caps (US-6), the immediate "Booked" email to the verified address, and one-click cancel.

---

## User Flows

### Flow 1: First booking from Claude (P1)

Maps to: US-1, US-5

1. The person asks Claude to book a call. Claude calls `book_meeting` without a token.
2. The server returns **HTTP 401** with `WWW-Authenticate: Bearer resource_metadata="https://patrickjv.com/.well-known/oauth-protected-resource/mcp", scope="booking"`.
3. Claude shows a **Connect** card. The person opens it: patrickjv.com's consent page names the app by its host ("claude.ai wants to book meetings with Patrick in your name").
4. The person approves and signs in with Google. The callback requires `email_verified`, creates or updates the identity, and Claude receives an access token bound to `https://patrickjv.com/mcp`.
5. Claude retries `book_meeting`. The store claims the slot (claim-before-await), re-checks free/busy, creates the event with the identity as guest, and returns `confirmed`.
6. The person gets the Google invite and a "Booked" email with a cancel link.

### Flow 2: Agent without sign-in support (P1)

Maps to: US-3

1. An agent calls `book_meeting` with no token and can't do OAuth.
2. It gets the 401. The tool's description already says booking needs sign-in, and points people to `https://patrickjv.com/book`.

### Flow 3: Owner cancels (P1)

Maps to: US-4

1. The person's agent calls `cancel_booking`; the person signs in for it (D7), and the agent retries with the token.
2. The booking belongs to that identity, so the meeting is cancelled at once; Google notifies attendees.

---

## Acceptance Criteria (P1: MCP sign-in with Google)

### Functional

- [ ] **(US-1, US-3)** An anonymous `tools/call` of `book_meeting` or `cancel_booking` returns **HTTP 401** with `WWW-Authenticate` carrying `resource_metadata` and `scope="booking"`. `initialize`, `tools/list`, the read tools, `get_booking_status` and `request_intro` still work with no token.
- [ ] **(US-1)** Protected-resource metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`, naming `resource: https://patrickjv.com/mcp`. Authorisation-server metadata advertises S256 only, `client_id_metadata_document_supported: true`, `"none"` among `token_endpoint_auth_methods_supported`, and has no `registration_endpoint`.
- [ ] **(US-1)** A token issued for a different resource, or an expired or revoked token, gets HTTP 401. PKCE `plain` is refused.
- [ ] **(US-1, US-2)** No token is issued unless Google returns `email_verified: true`. The identity is keyed on Google's `sub`, never on email.
- [ ] **(US-1, US-5)** The Google callback is bound to the sign-in that started it. The approved request (`client_id`, `redirect_uri`, `resource`, `scope`, PKCE `code_challenge`, `state`) is stored server-side in a `BookingStore` transaction when the person approves (D8a), and never taken back from the browser. The consent page's approve form carries an HMAC-signed copy of the parsed request, so a tampered POST is refused (tested); approval succeeds end to end with the fake Google (tested). The upstream `state` must match that transaction and the cookie the approval set, and is single-use. A missing, mismatched or replayed `state`, a callback without the cookie, or a transaction older than 10 minutes is refused with no token issued (each tested).
- [ ] **(US-1)** `book_meeting` with a valid token books for the identity: guest name and address come from the identity, the booking is `confirmed` with no hold email, and the event is created. An `email` argument that differs from the identity's is refused (`email_mismatch`), not silently ignored. Free/busy is re-checked and claim-before-await holds: the concurrent-booking test still has exactly one winner.
- [ ] **(US-1)** The "Booked" email goes to the verified address and carries the cancel link.
- [ ] **(US-4)** Cancellation, by path: over **MCP**, `cancel_booking` needs a token (no token → the 401 above); the owner's token (a fresh sign-in, per D7) cancels at once; another identity's token gets `not_owner` and nothing changes. Over the **HTTP API and WebMCP** (`POST /api/booking/cancel`, anonymous until P2), F-001's behaviour is unchanged: a pending hold is withdrawn, a confirmed meeting gets the emailed confirm-cancellation link.
- [ ] **(US-5)** A `client_id` whose host isn't on the allowlist is refused before the consent page. The consent page shows the client's host, not its self-declared name, and can't be framed.
- [ ] **(US-6)** Quota accounting per D9: per-identity caps (2 a day, 2 upcoming), per-IP, global and 3-a-day limits all checked; the global count reserved at the claim, before any Google call; none refunded (tested, including a refused request leaving counts unchanged).
- [ ] **(US-1, D7)** One token, one use: 20 concurrent `book_meeting` calls with the same token for **different** slots produce exactly one booking, and the rest get 401; the same holds for `cancel_booking`. A confirm completed by the alarm's recovery counts as the token's use (tested).
- [ ] **(US-1, D7)** Failure after the claim, for a signed-in booking (mirrors F-001's rules, without a hold email):
  - **Google refuses the insert (4xx), or free/busy shows a clash:** the booking ends `declined` (reason `slot_taken`, `day_full` or `unavailable`), its slot is free again, the token's use is **released**, so the person can retry within the 15 minutes without signing in again, and the response is the error with the `booking_id`.
  - **Outcome unknown (timeout, network error, 5xx):** the booking stays `confirming` for the alarm's recovery, the token stays spent, and the response is `202` with `{booking_id, status: "pending_confirmation"}`. The agent polls `get_booking_status`, and recovery ends at `confirmed` (with the "Booked" email) or `declined`.
  - Both cases are tested with the fake Google from F-001 (`fail.insert` and `fail.afterCreate`).
- [ ] **(US-3, interim)** Anonymous `/book` and anonymous WebMCP `book_meeting` behave exactly as in F-001: `name` and `email` are required at runtime when there's no sign-in (`400` otherwise), the booking is a 2-hour hold, and the Confirm/Decline email is sent. F-001's tests for these paths stay green unchanged.
- [ ] **(US-3)** The `book_meeting` description says booking over MCP needs sign-in and names `https://patrickjv.com/book` for people without it. `name` and `email` become optional in the schema, identical on MCP and WebMCP (the build's parity check still passes).
- [ ] **(US-1, US-5)** Manual check with the Claude connector: Connect card → consent → Google → automatic retry → event created, no hold email; then a **second** booking in the same conversation prompts sign-in again (D7).
- [ ] **(US-5)** Manual check with VS Code (Copilot): it connects through its Client ID Metadata Document and completes one booking. If VS Code doesn't surface the mid-session 401 as a sign-in prompt, record that and remove `vscode.dev` from the P1 allowlist.

### Non-functional

- [ ] **Security (D7):** access tokens last 15 minutes and there are no refresh tokens (the token endpoint refuses `refresh_token` grants); after a successful booking or cancellation the token's grant is revoked, so a second booking with the same token gets the 401 (tested); tokens and grants are stored hashed or encrypted by the library; `redirect_uri` matched exactly (loopback: any port); the OAuth endpoints are covered by the WAF flood rule and `RL_MCP`.
- [ ] **Privacy:** `/privacy` lists the sign-in cookies (the library's short-lived consent cookies, strictly necessary), Google as the identity provider, what's kept about a signed-in person and for how long. An identity is deleted 30 days after its last booking or sign-in, with its grants revoked.
- [ ] **Observability:** health gains `authReady` (KV bound, sign-in secrets set, Google discovery reachable); smoke checks the anonymous 401 and both metadata documents. Logs carry the subsystem only: never a token, `sub`, email or `client_id`.
- [ ] **Cost and KV budget (D8):** Free plan only. Loading the consent page writes nothing to KV or SQLite (tested). Abandoned sign-ins write only SQLite transaction rows, which expire after 10 minutes (tested). Every KV operation the library performs is counted under the UTC day it happens, through the wrapped binding (tested, including a write delayed across midnight, which counts towards the new day). A step is admitted only if the real count plus its maximum stays at or below 700; otherwise it gets 503 `Retry-After` and writes nothing (tested at the boundary, and with concurrent steps). Reads, `/book` and anonymous MCP keep working throughout. `/oauth/authorize` and `/oauth/token` are rate-limited per IP. Health reports the day's KV write count and warns at 500.

---

## Data Model

New tables in `BookingStore` (SQLite):

```sql
CREATE TABLE identities (
  id             TEXT PRIMARY KEY,   -- 128-bit random hex; the OAuth library's userId (stored in plaintext there, so opaque)
  provider       TEXT NOT NULL,      -- 'google' (P1); 'microsoft', 'altimist' later
  subject        TEXT NOT NULL,      -- provider's stable ID (Google sub)
  email          TEXT NOT NULL,      -- verified at sign-in
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  delete_after   TEXT NOT NULL,      -- 30 days after the later of last sign-in and last booking
  UNIQUE (provider, subject)
);
```

`oauth_transactions(id, state_hash, cookie_hash, request_json, created_at, expires_at)` holds approved sign-ins in flight (D8a), deleted when consumed or after 10 minutes, and `kv_usage(day, ops)` holds the real KV count (D8c). `bookings` gains `identity_id TEXT` (null for anonymous bookings). `source` gains `mcp_auth` (and `web_auth` in P2). Token and grant storage is the library's, in a new KV namespace `OAUTH_KV`.

---

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource/mcp` (and without `/mcp`) | RFC 9728 metadata |
| GET | `/.well-known/oauth-authorization-server` | AS metadata |
| GET | `/oauth/authorize` | Consent page (allowlist checked first) |
| POST | `/oauth/authorize` | Consent decision, then redirect to Google |
| GET | `/oauth/callback/google` | Google returns here; identity created; redirect to the client |
| POST | `/oauth/token` | Authorization-code exchange only (PKCE S256); `refresh_token` grants refused (D7) |

New Worker routes: `patrickjv.com/oauth/*` and `patrickjv.com/.well-known/oauth-*`. The Origin check doesn't apply to `/oauth/token`.

**Errors:** 401 with `WWW-Authenticate` for missing, invalid or already-used tokens on booking writes; 403 `email_mismatch`; 403 `not_owner`; 403 `client_not_allowed` at authorise; 429 identity caps.

---

## Edge Cases & Error Handling

- **Google returns `email_verified: false`:** no token; the consent flow ends with "We couldn't verify your email with Google."
- **Person's Google address changes:** the identity is keyed on `sub`, so it's the same identity; the stored email updates at next sign-in.
- **KV write budget reached (D8):** sign-in fails closed with 503 and `Retry-After`; tokens already issued keep working (validation only reads); anonymous paths (reads, `/book`) keep working.
- **Token expired or already used (D7):** the next booking write gets the 401 and the client shows Connect again; the person signs in for that booking.
- **Client not on the allowlist:** refused before consent, with a message naming `/book`.
- **Token valid but identity deleted (retention):** treated as invalid; the client re-runs sign-in.
- **Agent sends a different email:** `email_mismatch`; nothing booked.
- **Booking in progress when the token expires:** the claim already happened; the booking completes (the token is checked once, at the start).

---

## Phases after P1

- **P2, site sign-in:** "Sign in with Google" on `/book`, a `__Host-` session cookie (`Secure; HttpOnly; SameSite=Lax`), `GET /api/booking/me`, signed-in `/book` and WebMCP bookings confirmed directly. WebMCP asks for in-page confirmation before booking. Cookie-authenticated POSTs require an exact `Origin` and `Content-Type: application/json`. `/privacy` changes from "sets no cookies".
- **P3, more providers and consent:** Microsoft (key on tenant + object ID; email counted as verified only when Microsoft says so); Altimist ID (needs this site registered as a client, and its tokens to carry email verification and nothing internal); MCP elicitation for per-booking confirmation where clients support it; ChatGPT: per-tool `securitySchemes` (`noauth` on read tools, `oauth2` with scope `booking` on the two write tools, also mirrored in `_meta`), a tool-error result with `_meta["mcp/www_authenticate"]` instead of the 401 for ChatGPT, AS metadata with `authorization_response_iss_parameter_supported` (only if every authorisation response returns `iss`), allowlisting `https://chatgpt.com/oauth/client.json` and redirect `https://chatgpt.com/connector_platform_oauth_redirect`, then a live test in developer mode on a Business workspace (about half a day to a day); Dynamic Client Registration only if a needed client requires it.
- **P4, retire anonymous paths:** once sign-in covers `/book`, WebMCP and MCP for the providers people use, remove anonymous booking (hold and confirmation email) and anonymous `request_intro`. Reading stays anonymous. Needs its own acceptance criteria and a `/privacy` update when planned.

---

## Watch: agent identities that act for several people

A gap recorded on 2026-10-09, **not a planned feature**. Patrick asked whether an agent with its own identity can act for a list of other people. Building delegation here isn't worth it, because most people book once. The site would only *accept* it if an identity provider supplied it.

- **Today:** "Sign in with Google" says who signed in and nothing about whom they may act for. Google's own delegation (Gmail delegates, shared calendars) isn't passed on to other sites.
- **What would make it usable here:** a token or credential that proves "agent X acts for person Y, approved by Y", issued by a provider the site trusts and presented through MCP. The building blocks exist: OAuth token exchange (RFC 8693) with an `act` (actor) claim, IETF drafts on AI agents acting on behalf of users, enterprise agent-identity products, and verifiable credentials (the did:web/VC idea parked in F-001). MCP's authorisation spec doesn't cover acting for someone else yet. These points weren't spiked; check them before relying on any.
- **If it arrives:** accepting it would be a new decision that revisits the "booking for someone else" non-goal; nothing here pre-approves it. If approved, booking would accept the verified principal Y as the guest instead of the signed-in identity. Caps, D7 and the "Booked" email (sent to Y) stay as they are.

## Google setup (manual, P1)

In a **new** Google Cloud project `patrickjv-signin` owned by `hello@` (about 30–40 minutes, plus brand-verification waiting time):

1. Create the project.
2. Google Auth Platform → Branding: app name "patrickjv.com", support email, home page, privacy policy `https://patrickjv.com/privacy`, authorised domain `patrickjv.com`, optionally a logo. Audience: External, **Publish**.
3. Data access: only `openid`, `email`, `profile`.
4. Clients → Web application, redirect URI `https://patrickjv.com/oauth/callback/google`. Store the client ID and secret as Worker secrets (`SIGNIN_GOOGLE_CLIENT_ID`, `SIGNIN_GOOGLE_CLIENT_SECRET`).
5. Verify branding, then publish it within 7 days.
6. Test sign-in with an account other than `hello@`: no warning screen.

`patrickjv-booking` (calendar access) is not touched.

---

## Open Questions

- [ ] **Identity caps (D9) are provisional:** 2 requests a day and 2 upcoming meetings per person. Owner: @PVieira04, to confirm before build.
- [ ] **Privacy wording** for the sign-in cookies and Google as identity provider. Owner: @PVieira04, review with the build.
- [ ] **Which MCP protocol versions to speak.** The server speaks 2025-11-25 and 2025-06-18; MCP 2026-07-28 is current. P1 doesn't need it; P3's elicitation does. Owner: build.
- [ ] **Unverified details:** whether non-Claude clients surface a mid-session 401 as a sign-in prompt (VS Code, Cursor); whether a browser agent can dismiss WebMCP's `window.confirm` (P2). Verify during each phase.

---

## References

- Research (2026-10-09): design investigation and Google project spike, summarised in [F-001-spikes](F-001-spikes/README.md#f-002-research-2026-10-09).
- MCP authorization (2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- Claude lazy authentication: https://claude.com/docs/connectors/building/lazy-authentication
- `@cloudflare/workers-oauth-provider`: https://github.com/cloudflare/workers-oauth-provider
- Google unverified apps and user cap: https://support.google.com/cloud/answer/7454865, https://support.google.com/cloud/answer/15549945
- Google brand verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
