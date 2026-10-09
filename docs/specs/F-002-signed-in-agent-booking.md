# Feature Spec: Confirm bookings by signing in

> **Purpose:** Replace F-001's "please confirm" email with a sign-in by the person the booking is for, on every channel, through one core that can later accept other proofs of who that person is (a standing agent key, a provider-asserted delegation, an OAuth token).
> **Update when:** Requirements shift, acceptance criteria change, or scope moves during the build.
> **Related:** [F-001 Booking](F-001-booking.md) (this builds on it), [`../04-mcp-and-webmcp.md`](../04-mcp-and-webmcp.md), [`../06-operations.md`](../06-operations.md), [research](F-001-spikes/README.md#f-002-research-2026-10-09).

---

## Metadata

| Field | Value |
|---|---|
| Spec ID | F-002 |
| Status | Draft |
| Phase | P1 specified in full; P2–P4 outlined |
| Owner | @PVieira04 |
| Created | 2026-10-09 |
| Last updated | 2026-10-09 (rewritten around confirm-by-sign-in) |
| Depends on | F-001 (shipped 8 Oct 2026); a new Google Cloud project for visitor sign-in |

---

## Summary

Today a booking is a 2-hour hold that becomes a meeting when the guest clicks a link emailed to them, because the site can't trust an address an agent types. F-002 makes **signing in the confirmation**. An agent (or a person on `/book`) asks for a slot; the site holds it for 10 minutes and returns a **"Sign in to confirm"** link. The person opens it, signs in with Google on patrickjv.com, and the meeting is booked in their **verified** name. No confirmation email, no address typed by an agent, and no tokens issued to agents.

Reading stays anonymous: an agent can look up meeting types and free times and relay them without anyone signing in. Only the act of booking (and cancelling a confirmed meeting) needs the person.

The confirmation step is one core operation: **confirm this hold for this verified person**. P1 proves the person by an interactive sign-in. Later phases can add other proofs, notably an **agent key** a person creates once so their agent can book without a sign-in each time. The booking logic doesn't change when they're added. The long-term aim is to retire anonymous booking and anonymous intro messages altogether (P4).

---

## User Stories

### US-1: Agent books after its person signs in

As **a person whose AI agent is booking a call for me**, I want **the agent to hand me one link that I sign in on to confirm**, so that **the meeting is booked in my name in seconds, with no email round trip**.

**Why this matters:** The confirmation email exists only because the site can't tell who the agent is acting for. Signing in at the moment of booking proves it directly.

### US-2: Agents can research without anyone signing in

As **an AI agent researching for my person**, I want to **read Patrick's profile, meeting types and free times without signing in**, so that **I can tell my person when Patrick is free before they decide to book**.

### US-3: Nobody else's inbox is involved

As **anyone**, I want **the site never to email an address an agent typed**, so that **nobody can use it to send me mail in my name**.

**Why this matters:** On agent channels the guest is whoever signs in; there's no address to misuse. (`/book` keeps an email fallback until P4.)

### US-4: The guest cancels with the same proof

As **a guest**, I want **my agent to ask to cancel and me to confirm it by signing in**, so that **cancelling needs me, not just my agent**.

### US-5: Abuse stays bounded

As **Patrick**, I want **unconfirmed holds to be short and capped, and confirmed bookings capped per person**, so that **nobody can block my calendar or fill it**.

### US-6 (P3): Standing permission for my agent

As **a person who books often**, I want to **set up a key once that lets my agent book and cancel for me without signing in each time**, so that **my agent can act on my behalf within limits I choose**.

---

## Goals & Non-Goals

**Goals**

- Every agent booking (MCP and WebMCP) is confirmed by the guest signing in; no confirmation email on those channels.
- The guest's name and address come only from the sign-in.
- Reading tools stay anonymous.
- One confirmation core that later proofs (agent keys, delegation, OAuth tokens) plug into without changing booking logic.
- Cost stays at £0.
- **P4:** retire anonymous booking (the email path on `/book`) and anonymous `request_intro`.

**Non-Goals**

- **Being an OAuth authorisation server in P1.** The site is a Google sign-in *client* only. Issuing tokens to agents was researched and rejected for P1 (D2). Agent keys (P3) are the planned standing-permission mechanism.
- **Booking for someone else.** The guest is whoever proves their identity. The site never builds delegation itself; accepting a provider-asserted "acts for" claim would be a new decision (see Watch).
- **Keeping Google's tokens.** Only the verified claims are read, once, at sign-in.
- **Rescheduling** (still F-001's planned v2).

---

## Decisions (2026-10-09)

| # | Decision | Alternatives rejected |
|---|---|---|
| D1 | **Signing in confirms the booking.** On MCP and WebMCP, `book_meeting` creates a hold and returns a single-use "Sign in to confirm" link; the meeting is made when the person signs in on it. Reading needs no sign-in. Decided with Patrick: authorisation is for the one booking request, not a session. | F-001's confirmation email: the reason for F-002. An optional fast lane beside it: keeps strangers' inboxes exposed. |
| D2 | **The site is a sign-in client (OpenID Connect relying party), not an OAuth server.** | Making `/mcp` an OAuth 2.1 resource server with `@cloudflare/workers-oauth-provider`. Researched in depth (spikes and four review passes): it needs client registration and an allowlist, and works smoothly only in some clients (ChatGPT needs a different sign-in signal). The library also showed replayable refresh tokens, KV writes before consent and a non-atomic code exchange on KV's 1,000 writes a day. It can return later as one more proof (D6) if MCP clients converge on it. |
| D3 | **Holds awaiting sign-in last 10 minutes**, and the confirm link is single-use and expires with the hold. The agent needs seconds; the time is for the person to open the link and sign in. | F-001's 2-hour hold: blocks a slot far longer than a sign-in takes. |
| D4 | **A separate Google Cloud project** (`patrickjv-signin`) with only `openid email profile`. | The calendar project: it would work (the user cap counts only sensitive scopes), but branding and the cap are per project, and a public sign-in shouldn't share risk with the project holding the calendar token. ([spike](F-001-spikes/README.md#f-002-research-2026-10-09)) |
| D5 | **The agent never supplies the guest's address.** `book_meeting` on agent channels takes the type, start and an optional note; name and address come from the sign-in. | Accepting an `email` and checking it against the sign-in: invites mismatches and gives agents a field to misuse. |
| D6 | **One confirmation core with interchangeable proofs.** `confirmHold(hold, person, proof)` is the only way a hold becomes a meeting. `person` is a verified identity (`provider`, `subject`, `email`, `name`); `proof` records how it was established (`signin:google` in P1; later `agent_key:<id>`, `email_link`, `oauth:<client>`, `delegation:<issuer>`). Caps, the free/busy re-check, claim-before-await and the "Booked" email live in the core, so a new proof only has to produce a verified person. | Separate booking code per channel: drift, and every new proof would need its own copy of the rules. |
| D7 | **Caps.** Holds awaiting sign-in: at most 2 live per IP, F-001's 4 per IP a day, and the global 10 a day (taken when the hold is created). Confirmed bookings: at most 2 per person a day and 2 upcoming per person, plus F-001's 3 a day. None refunded. Values provisional (Open Questions). | Keying hold caps on email: there's no email until sign-in. |
| D8 | **`/book` keeps the email path as a fallback until P4**, beside "Sign in with Google to confirm", for people without a Google account. Agent channels get no email path. | Removing it in P1: people without Google couldn't book until P2's providers arrive. |

---

## User Flows

### Flow 1: Agent books (MCP or WebMCP)

Maps to: US-1, US-2, US-3

1. The agent reads `list_meeting_types` and `get_availability` anonymously and relays free times to its person.
2. The person picks one. The agent calls `book_meeting({type, start, note?})`. The site reserves hold caps, re-checks the slot, and creates a hold (10 minutes) with a single-use confirm ticket. It returns `{booking_id, status: "pending_confirmation", confirm_url, hold_expires}`.
   - **MCP:** the result tells the agent to give the person `confirm_url`. On MCP 2026-07-28 connections that declare URL-mode elicitation, the server may request it with that URL (P2); otherwise it's plain text.
   - **WebMCP:** the page shows "Sign in to confirm" with the meeting details, and opens Google sign-in in a popup when the person clicks.
3. The person opens the link: patrickjv.com shows the meeting type and time and a **Sign in with Google to confirm** button.
4. Google sign-in (authorization code flow with PKCE, `state` and `nonce` bound to the ticket). The site exchanges the code server-side, requires `email_verified`, and calls `confirmHold(hold, person, "signin:google")`.
5. The core re-checks free/busy, creates the event with the person as guest, and sends the "Booked" email. The page says "Booked".
6. The agent polls `get_booking_status` and tells its person it's confirmed.

### Flow 2: Person books on `/book`

Maps to: US-1, US-3

Same as Flow 1 from step 3: picking a slot creates the hold and shows the confirm page, with "Sign in with Google to confirm" and, until P4, "Confirm by email instead" (F-001's path).

### Flow 3: Agent cancels a confirmed meeting

Maps to: US-4

1. The agent calls `cancel_booking({booking_id})`. For a confirmed meeting it returns a single-use `confirm_url` (10 minutes).
2. The person signs in on it. If they're the booking's guest (same `provider` and `subject`), the meeting is cancelled; otherwise nothing changes ("This booking belongs to someone else").
3. A pending hold is still withdrawn directly by `booking_id`, as in F-001.

---

## Acceptance Criteria (P1)

### Functional

- [ ] **(US-2)** `list_meeting_types`, `get_availability`, `get_booking_status` and the profile tools work with no sign-in on MCP, WebMCP and the HTTP API.
- [ ] **(US-1, US-3)** Agent-channel `book_meeting` takes `type`, `start` and optional `note` only; an `email` or `name` argument is refused (`400`). It creates a 10-minute hold and returns `{booking_id, status: "pending_confirmation", confirm_url, hold_expires}`. No email is sent.
- [ ] **(US-1)** `confirm_url` carries a 128-bit random ticket, stored hashed, single-use, expiring with the hold. Opening it (GET) shows the meeting and the sign-in button and changes nothing.
- [ ] **(US-1)** Sign-in uses Google's authorization code flow with PKCE (S256), a `state` and `nonce` bound to the ticket and to a `__Host-` cookie set when sign-in starts, and a server-side code exchange. A missing, mismatched or replayed `state`, a wrong `nonce`, a missing cookie, an expired ticket, or `email_verified` not true is refused, and nothing is booked (each tested with a fake Google).
- [ ] **(US-1, D6)** A successful sign-in calls `confirmHold(hold, person, "signin:google")`, which reserves the per-person caps, re-checks free/busy, creates the event with the person's verified name and address, sets the booking `confirmed`, records `identity_id` and `proof`, and sends the "Booked" email to that address. Claim-before-await holds: 20 concurrent sign-ins on one ticket, or on overlapping holds, give exactly one meeting (tested).
- [ ] **(US-1)** Failure after the claim follows F-001: Google refusing the insert or a clash ends the booking `declined` with the slot freed and the page saying so; an unknown outcome stays `confirming` for the alarm's recovery, and the page says "being finished — check your email" (tested).
- [ ] **(US-1)** WebMCP's `book_meeting` returns the same result, and the homepage shows a "Sign in to confirm" prompt with the meeting details that opens Google sign-in in a popup on click. If the popup is blocked, it falls back to the `confirm_url` link (tested in headless Chromium).
- [ ] **(US-4)** `cancel_booking` on a confirmed meeting returns a single-use `confirm_url`. Signing in as the booking's guest cancels it, and Google notifies attendees; signing in as anyone else changes nothing. A pending hold is withdrawn directly.
- [ ] **(US-5, D7)** Hold caps (2 live per IP, 4 per IP a day, 10 globally a day) are taken when the hold is created; person caps (2 a day, 2 upcoming) are taken at confirmation. None is refunded, and refused requests leave the counts unchanged (tested).
- [ ] **(D8)** `/book` offers sign-in confirmation and, until P4, F-001's email confirmation as a fallback. F-001's tests for the email path stay green unchanged.
- [ ] **(D6)** `confirmHold` is the only code path that turns a hold into a meeting. The email path (D8) and the sign-in path both call it, with proofs `email_link` and `signin:google` (tested).
- [ ] **(US-1)** Manual check: a booking made through the Claude connector (link in chat → sign-in on a phone → "Booked"), and one through WebMCP in a browser.

### Non-functional

- [ ] **Security:** no tokens are issued to agents. The ticket is the only bearer value, it's good for one hold, and it expires in 10 minutes. The confirm page can't be framed. Cookie-carrying POSTs require an exact `Origin`. The Google client secret is a Worker secret.
- [ ] **Privacy:** `/privacy` adds Google as identity provider, the short-lived sign-in cookie (strictly necessary, expires in 10 minutes), and what's kept about a signed-in person: provider, subject, verified email and name, deleted 30 days after their last booking. The site sets no lasting cookie in P1.
- [ ] **Observability:** health adds `signinReady` (Google client secrets set, Google's discovery document reachable). Smoke checks that an anonymous `book_meeting` returns a `confirm_url` and no email. Logs carry the subsystem only.
- [ ] **Cost:** Free plan; storage only in `BookingStore` SQLite. No KV.

---

## Data Model

In `BookingStore` (SQLite):

```sql
CREATE TABLE identities (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL,
  email TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
  delete_after TEXT NOT NULL, UNIQUE (provider, subject)
);
CREATE TABLE signin_tx (                -- one per sign-in in progress; deleted when used or after 10 minutes
  state_hash TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL, cookie_hash TEXT NOT NULL,
  nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, purpose TEXT NOT NULL,  -- 'confirm' | 'cancel'
  expires_at TEXT NOT NULL
);
```

`bookings` gains `identity_id` and `proof` (`signin:google`, `email_link`; later `agent_key:<id>`, `oauth:<client>`, `delegation:<issuer>`). Hold tickets reuse F-001's `tokens` table with a new action, `confirm_signin`. P3 adds `agent_keys` (below).

---

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/book/confirm?t=` | Confirm page for a hold or a cancellation (no state change) |
| POST | `/book/confirm/google` | Start Google sign-in for that ticket (sets the `__Host-` cookie) |
| GET | `/book/callback/google` | Google returns here; verify, then `confirmHold` (or cancel) |

New route: `patrickjv.com/book/confirm*` and `/book/callback*` to the `patrickjv-mcp` Worker. MCP and WebMCP tool shapes change as in Functional above. `get_booking_status` is unchanged.

---

## Edge Cases & Error Handling

- **The person never signs in:** the hold lapses after 10 minutes and the slot frees; status reads `expired`.
- **The link is opened on a different device:** fine. The ticket carries the hold; the cookie binds only the sign-in round trip on that device.
- **Someone other than the intended person signs in:** they become the guest. The agent's person sees status `confirmed`, and the "Booked" email goes to whoever signed in. This is accepted: the link is handed to the person by their own agent.
- **Google's email is unverified:** refused, nothing booked.
- **Caps reached at confirmation:** the page says so and the hold is released.
- **Popup blocked (WebMCP):** the link fallback works.

---

## Phases after P1

- **P2, more ways to sign in and better hand-off:** Microsoft (key on tenant plus object ID; email counted only when Microsoft marks it verified) and Altimist ID, as more buttons on the confirm page; MCP URL-mode elicitation on 2026-07-28 connections.
- **P3, agent keys: standing permission (US-6).** A signed-in person creates a key at `patrickjv.com/agents`. They name it, choose its scope (`book`, `cancel`), set an expiry of at most 90 days, and can set limits below the person caps. The key is shown once, stored hashed, and revocable at any time. An agent presents it as `Authorization: Bearer` on `/mcp` or the HTTP API. With a valid key, `book_meeting` calls `confirmHold(hold, keyOwner, "agent_key:<id>")` straight away, with no link. Every booking still sends the "Booked" email, so the person sees what their agent did. This is a deliberate, person-chosen exception to per-request sign-in, and it needs its own acceptance criteria and `/privacy` text when planned. It works with any MCP client that can send a custom header, with no OAuth needed.
- **P3, OAuth for MCP (optional):** if MCP clients converge on OAuth sign-in, a token can become one more proof (`oauth:<client>`) through the same core. The [research](F-001-spikes/README.md#f-002-research-2026-10-09) records what that route needs.
- **P4, retire anonymous paths:** remove `/book`'s email confirmation and make `request_intro` require a sign-in or an agent key. Reading stays anonymous.

---

## Watch: agent identities that act for several people

Not a planned feature. If an identity provider ever issues a verifiable "agent X acts for person Y, approved by Y" (OAuth token exchange's `act` claim, IETF drafts on AI agents acting on behalf of users, enterprise agent identities, or verifiable credentials), it would plug in as a `delegation:<issuer>` proof under D6, with Y as the guest. Accepting it would be a new decision revisiting the "booking for someone else" non-goal. These points weren't spiked; check them before relying on any.

---

## Google setup (manual, P1)

In a **new** Google Cloud project `patrickjv-signin` owned by `hello@` (about 30 minutes, plus brand-verification waiting time):

1. Branding: app name "patrickjv.com", support email, home page, privacy policy `https://patrickjv.com/privacy`, authorised domain `patrickjv.com`, optional logo. Audience: External, **Publish**.
2. Data access: `openid`, `email`, `profile` only.
3. Web client, redirect URI `https://patrickjv.com/book/callback/google`. Store the ID and secret as Worker secrets `SIGNIN_GOOGLE_CLIENT_ID` and `SIGNIN_GOOGLE_CLIENT_SECRET`.
4. Verify and publish branding; test with an account other than `hello@` (no warning screen).

---

## Open Questions

- [ ] **Caps (D7) are provisional:** 2 live holds per IP; 2 confirmed bookings per person a day; 2 upcoming per person. Owner: @PVieira04, before build.
- [ ] **Hold length:** 10 minutes (D3). Owner: @PVieira04.
- [ ] **WebMCP prompt:** confirm in the build that a page can open the Google popup from the person's click while an agent drives the tools, and that a browser agent can't click it on the person's behalf (unverified).

---

## References

- Research and spikes (2026-10-09): [F-001-spikes](F-001-spikes/README.md#f-002-research-2026-10-09), covering the OAuth-server route (D2), the Google project choice (D4), ChatGPT and the KV write budget.
- Google OpenID Connect: https://developers.google.com/identity/openid-connect/openid-connect
- MCP elicitation (URL mode, 2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- Google unverified apps and brand verification: https://support.google.com/cloud/answer/7454865, https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
