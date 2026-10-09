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

Today every booking is a 2-hour hold that becomes a meeting only when the guest clicks a link emailed to them. That exists because an agent can give any email address, so the site can't trust it. F-002 replaces that check for agents with sign-in. An agent that wants to book over MCP must act for a person who has signed in with Google (more providers later). The booking uses that person's **verified** name and address, is confirmed immediately, and the person gets a "Booked" email with a one-click cancel link instead of a "Please confirm" email. Reading tools stay anonymous. `/book` keeps the anonymous email-confirmation path for people who don't want to sign in.

---

## User Stories

### US-1: Agent books for its signed-in person

As **a person using an AI agent**, I want to **connect the agent to patrickjv.com once by signing in, and then have it book directly**, so that **a meeting gets booked without an email round trip**.

**Why this matters:** The confirmation email is friction that only exists because the site can't tell who the agent acts for. A verified identity removes the reason for it.

### US-2: Strangers' inboxes stay out of it

As **someone whose address an agent might use**, I want **no email from patrickjv.com unless I booked**, so that **nobody can use the site to send me mail in my name**.

**Why this matters:** Today a made-up address still gets a hold email (bounded by caps). With sign-in required for agent bookings, an agent can only book for the person who signed in.

### US-3: Anonymous agents still get what they need

As **an agent without sign-in support**, I want to **still read the profile, meeting types and availability, and be told where a human can book**, so that **the site stays useful without an account**.

### US-4: Signed-in owner cancels directly

As **a signed-in person**, I want **my agent to cancel my own meeting straight away**, so that **cancelling is as easy as booking**.

### US-5: Patrick controls which agent apps can connect

As **Patrick**, I want **only known agent apps (Claude and VS Code in P1; ChatGPT in P3) to be able to connect at first**, so that **the consent screen can't be abused by look-alike apps**.

### US-6: Abuse stays bounded

As **Patrick**, I want **per-person caps and the existing global caps on signed-in bookings**, so that **one compromised or misbehaving agent can't fill my calendar**.

### US-7 (P2): Sign in on the site

As **a visitor on patrickjv.com**, I want to **sign in once so `/book` and the homepage's WebMCP tools book directly**, so that **I skip the confirmation email there too**.

---

## Goals & Non-Goals

**Goals**

- An agent can book over MCP only for a signed-in person, and that booking is confirmed immediately in the person's verified name.
- No email is ever sent to an address that hasn't been verified by sign-in or by the person themselves (anonymous `/book` keeps email confirmation).
- Nothing that works anonymously today breaks, except anonymous MCP `book_meeting`/`cancel_booking`, which now need sign-in.
- Cost stays at £0.

**Non-Goals**

- **Booking for someone else (P1).** In P1 a signed-in person books for themselves; a different `email` is refused (`email_mismatch`). Delegated booking (an assistant booking for their manager) is planned for P3 (see below).
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
| D5 | **Per-request consent:** the agent host's own tool approval, the `booking` scope granted at connect time, and the "Booked" notification with one-click cancel. Where a client declares elicitation on MCP 2026-07-28, ask it to confirm the slot details (P3). | Short-lived tokens: refresh tokens defeat them and they cost KV writes. |
| D6 | **Build with `@cloudflare/workers-oauth-provider` 1.2.x** using its split authorisation-server API, and keep the existing stateless JSON MCP handler as the resource server. | The library's `OAuthProvider` wrapper: it would 401 every anonymous request to `/mcp`. Cloudflare `agents`/McpAgent: not needed for a stateless server. A hosted broker (WorkOS AuthKit): another US processor, and free-tier MCP support unverified. |

**Residual risk, stated plainly:** sign-in proves *who* the person is, not that they approved *this* booking. A misbehaving or compromised agent, or one set to "always allow", can book in the person's name. It's bounded by the per-person caps (US-6), the immediate "Booked" email to the verified address, and one-click cancel.

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

1. The signed-in person's agent calls `cancel_booking` with a token.
2. The booking belongs to that identity, so the meeting is cancelled at once; Google notifies attendees.

---

## Acceptance Criteria (P1: MCP sign-in with Google)

### Functional

- [ ] **(US-1, US-3)** An anonymous `tools/call` of `book_meeting` or `cancel_booking` returns **HTTP 401** with `WWW-Authenticate` carrying `resource_metadata` and `scope="booking"`. `initialize`, `tools/list`, the read tools, `get_booking_status` and `request_intro` still work with no token.
- [ ] **(US-1)** Protected-resource metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`, naming `resource: https://patrickjv.com/mcp`. Authorisation-server metadata advertises S256 only, `client_id_metadata_document_supported: true`, `"none"` among `token_endpoint_auth_methods_supported`, and has no `registration_endpoint`.
- [ ] **(US-1)** A token issued for a different resource, or an expired or revoked token, gets HTTP 401. PKCE `plain` is refused.
- [ ] **(US-1, US-2)** No token is issued unless Google returns `email_verified: true`. The identity is keyed on Google's `sub`, never on email.
- [ ] **(US-1)** `book_meeting` with a valid token books for the identity: guest name and address come from the identity, the booking is `confirmed` with no hold email, and the event is created. An `email` argument that differs from the identity's is refused (`email_mismatch`), not silently ignored. Free/busy is re-checked and claim-before-await holds: the concurrent-booking test still has exactly one winner.
- [ ] **(US-1)** The "Booked" email goes to the verified address and carries the cancel link.
- [ ] **(US-4)** `cancel_booking` with the owner's token cancels directly. A non-owner's token, or none, behaves as in F-001.
- [ ] **(US-5)** A `client_id` whose host isn't on the allowlist is refused before the consent page. The consent page shows the client's host, not its self-declared name, and can't be framed.
- [ ] **(US-6)** Per identity: at most 2 booking requests a day and 2 upcoming meetings. The global daily cap and the 3-a-day limit still apply. Caps are reserved before any Google call and never refunded.
- [ ] **(US-3)** The `book_meeting` description says booking over MCP needs sign-in and names `https://patrickjv.com/book` for people without it. `name` and `email` become optional in the schema, identical on MCP and WebMCP (the build's parity check still passes).
- [ ] **(US-1)** Manual check with the Claude connector: Connect card → consent → Google → automatic retry → event created, no hold email.

### Non-functional

- [ ] **Security:** access tokens last 1 hour; refresh tokens rotate and expire after 30 days unused; tokens and grants are stored hashed or encrypted by the library; `redirect_uri` matched exactly (loopback: any port); the OAuth endpoints are covered by the WAF flood rule and `RL_MCP`.
- [ ] **Privacy:** `/privacy` lists the sign-in cookies (the library's short-lived consent cookies, strictly necessary), Google as the identity provider, what's kept about a signed-in person and for how long. An identity is deleted 30 days after its last booking or sign-in, with its grants revoked.
- [ ] **Observability:** health gains `authReady` (KV bound, sign-in secrets set, Google discovery reachable); smoke checks the anonymous 401 and both metadata documents. Logs carry the subsystem only: never a token, `sub`, email or `client_id`.
- [ ] **Cost:** Free plan only. KV writes stay well under 1,000 a day at this scale.

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

`bookings` gains `identity_id TEXT` (null for anonymous bookings). `source` gains `mcp_auth` (and `web_auth` in P2). Token and grant storage is the library's, in a new KV namespace `OAUTH_KV`.

---

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource/mcp` (and without `/mcp`) | RFC 9728 metadata |
| GET | `/.well-known/oauth-authorization-server` | AS metadata |
| GET | `/oauth/authorize` | Consent page (allowlist checked first) |
| POST | `/oauth/authorize` | Consent decision, then redirect to Google |
| GET | `/oauth/callback/google` | Google returns here; identity created; redirect to the client |
| POST | `/oauth/token` | Code and refresh-token exchange (PKCE S256) |

New Worker routes: `patrickjv.com/oauth/*` and `patrickjv.com/.well-known/oauth-*`. The Origin check doesn't apply to `/oauth/token`.

**Errors:** 401 with `WWW-Authenticate` for missing or invalid tokens on booking writes; 403 `email_mismatch`; 403 `client_not_allowed` at authorise; 429 identity caps.

---

## Edge Cases & Error Handling

- **Google returns `email_verified: false`:** no token; the consent flow ends with "We couldn't verify your email with Google."
- **Person's Google address changes:** the identity is keyed on `sub`, so it's the same identity; the stored email updates at next sign-in.
- **KV write allowance exhausted:** sign-in and token refresh fail closed; anonymous paths (reads, `/book`) keep working.
- **Client not on the allowlist:** refused before consent, with a message naming `/book`.
- **Token valid but identity deleted (retention):** treated as invalid; the client re-runs sign-in.
- **Agent sends a different email:** `email_mismatch`; nothing booked.
- **Booking in progress when the token expires:** the claim already happened; the booking completes (the token is checked once, at the start).

---

## Phases after P1

- **P2, site sign-in:** "Sign in with Google" on `/book`, a `__Host-` session cookie (`Secure; HttpOnly; SameSite=Lax`), `GET /api/booking/me`, signed-in `/book` and WebMCP bookings confirmed directly. WebMCP asks for in-page confirmation before booking. Cookie-authenticated POSTs require an exact `Origin` and `Content-Type: application/json`. `/privacy` changes from "sets no cookies".
- **P3, delegated booking:** a signed-in person may give another `email`. That booking falls back to F-001's hold-and-confirm, with the hold email sent to that address and naming who asked ("Jane Smith, jane@…, asked to book this on your behalf"). The other person still consents by clicking, but the request is attributed to a verified, capped identity instead of being anonymous. Counts against the requester's identity caps and the recipient's per-email cap.
- **P3, more providers and consent:** Microsoft (key on tenant + object ID; email counted as verified only when Microsoft says so); Altimist ID (needs this site registered as a client, and its tokens to carry email verification and nothing internal); MCP elicitation for per-booking confirmation where clients support it; ChatGPT: per-tool `securitySchemes` (`noauth` on read tools, `oauth2` with scope `booking` on the two write tools, also mirrored in `_meta`), a tool-error result with `_meta["mcp/www_authenticate"]` instead of the 401 for ChatGPT, AS metadata with `authorization_response_iss_parameter_supported` (only if every authorisation response returns `iss`), allowlisting `https://chatgpt.com/oauth/client.json` and redirect `https://chatgpt.com/connector_platform_oauth_redirect`, then a live test in developer mode on a Business workspace (about half a day to a day); Dynamic Client Registration only if a needed client requires it.

---

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

- [ ] **Identity caps:** 2 requests a day and 2 upcoming meetings per person. Owner: @PVieira04, before build.
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
