# Feature Spec: Confirm bookings by signing in

> **Purpose:** Replace F-001's "please confirm" email with a sign-in by the person the booking is for, on every channel, through one core that also accepts an agent signing in with an identity set up for it (its person's own account, or its own account that its person has authorised at the identity provider).
> **Update when:** Requirements shift, acceptance criteria change, or scope moves during the build.
> **Related:** [F-001 Booking](F-001-booking.md) (this builds on it), [`../04-mcp-and-webmcp.md`](../04-mcp-and-webmcp.md), [`../06-operations.md`](../06-operations.md), [research](F-001-spikes/README.md#f-002-research-2026-10-09).

---

## Metadata

| Field | Value |
|---|---|
| Spec ID | F-002 |
| Status | Draft |
| Phase | P1 specified in full; P2–P3 outlined; P4 optional |
| Owner | @PVieira04 |
| Created | 2026-10-09 |
| Last updated | 2026-10-09 (rewritten around confirm-by-sign-in) |
| Depends on | F-001 (shipped 8 Oct 2026); a new Google Cloud project for visitor sign-in |

---

## Summary

Today a booking is a 2-hour hold that becomes a meeting when the guest clicks a link emailed to them, because the site can't trust an address an agent types. F-002 makes **signing in the confirmation**. An agent (or a person on `/book`) asks for a slot; the site holds it for 10 minutes and returns a **"Sign in to confirm"** link. The person opens it, signs in with Google on patrickjv.com, and the meeting is booked in their **verified** name. No confirmation email, no address typed by an agent, and no tokens issued to agents.

Reading stays anonymous: an agent can look up meeting types and free times and relay them without anyone signing in. Only the act of booking (and cancelling a confirmed meeting) needs the person.

The confirmation step is one core operation: **confirm this hold for this verified person**. P1 proves the person by an interactive sign-in. An agent may complete that sign-in itself, if its identity is set up for it: either it has access to its person's own account, or it has its own account that its person has authorised at the identity provider. That depends on how the identity is set up, not on anything the site builds (P4). The long-term aim is to retire anonymous booking and anonymous intro messages altogether (P3).

---

## User Stories

### US-1: Agent books after its person signs in

As **a person whose AI agent is booking a call for me**, I want **the agent to hand me one link that I sign in on to confirm**, so that **the meeting is booked in my name in seconds, with no email round trip**.

**Why this matters:** The confirmation email exists only because the site can't tell who the agent is acting for. Signing in at the moment of booking proves it directly.

### US-2: Agents can research without anyone signing in

As **an AI agent researching for my person**, I want to **read Patrick's profile, meeting types and free times without signing in**, so that **I can tell my person when Patrick is free before they decide to book**.

### US-3: Nobody else's inbox is involved

As **anyone**, I want **the site never to email an address an agent typed**, so that **nobody can use it to send me mail in my name**.

**Why this matters:** On agent channels the guest is whoever signs in; there's no address to misuse. (`/book` keeps an email fallback until P3.)

### US-4: The guest cancels with the same proof

As **a guest**, I want **my agent to ask to cancel and me to confirm it by signing in**, so that **cancelling needs me, not just my agent**.

### US-5: Abuse stays bounded

As **Patrick**, I want **unconfirmed holds to be short and capped, and confirmed bookings capped per person**, so that **nobody can block my calendar or fill it**.

### US-7: An agent can find out how to book, without signing in

As **an AI agent that has just found patrickjv.com**, I want **the booking steps written out wherever I look first**, so that **I can explain them to my person and follow them without guessing, and without signing in to read them**.

**Why this matters:** Agents arrive by different routes: the MCP server, the homepage's WebMCP tools, `llms.txt`, or reading the page. A step that's only documented in one place gets missed, and an agent that misunderstands the sign-in step will invent an email address or give up.

### US-8: The person understands what they're confirming

As **a person handed a confirm link by my agent**, I want **the page to say what I'm booking, why I'm asked to sign in, and what's shared**, so that **I can confirm with confidence**.

### US-6 (P4, optional): My agent signs in with an identity I've set up

As **a person with an agent**, I want **my agent to confirm a booking by signing in with an identity I've set up for it**, so that **it can book for me without handing me a link each time**. That identity is either my own account, which my agent has access to, or the agent's own account, which I've authorised at the identity provider to act for me.

**Why this matters:** Whether an agent can act for someone is a property of its identity, and the identity provider manages it. The site only needs to accept that sign-in correctly.

---

## Goals & Non-Goals

**Goals**

- Every agent booking (MCP and WebMCP) is confirmed by the guest signing in; no confirmation email on those channels.
- The guest's name and address come only from the sign-in.
- Reading tools stay anonymous.
- One confirmation core that accepts a sign-in by the person, or by an agent using an identity set up for it, without changing booking logic.
- Cost stays at £0.
- **P3:** retire anonymous booking (the email path on `/book`) and anonymous `request_intro`.

**Non-Goals**

- **Being an OAuth authorisation server in P1.** The site is a Google sign-in *client* only. Issuing tokens to agents was researched and rejected (D2).
- **Issuing agent credentials or managing delegation ourselves.** No site-issued agent keys or API tokens, and no record here of who may act for whom. Whether an agent can act for a person is set up at the identity provider (P4).
- **Booking for someone else.** The guest is whoever proves their identity, or the person an identity provider says the signed-in agent acts for (P4). The site never records delegation itself.
- **Keeping Google's tokens.** Only the verified claims are read, once, at sign-in.
- **Rescheduling** (still F-001's planned v2).

---

## Decisions (2026-10-09)

| # | Decision | Alternatives rejected |
|---|---|---|
| D1 | **Signing in confirms the booking.** On MCP and WebMCP, `book_meeting` creates a hold and returns a single-use "Sign in to confirm" link; the meeting is made when the person signs in on it. Reading needs no sign-in. Decided with Patrick: authorisation is for the one booking request, not a session. | F-001's confirmation email: the reason for F-002. An optional fast lane beside it: keeps strangers' inboxes exposed. |
| D2 | **The site is a sign-in client (OpenID Connect relying party), not an OAuth server.** | Making `/mcp` an OAuth 2.1 resource server with `@cloudflare/workers-oauth-provider`. Researched in depth (spikes and four review passes): it needs client registration and an allowlist, and works smoothly only in some clients (ChatGPT needs a different sign-in signal). The library also showed replayable refresh tokens, KV writes before consent and a non-atomic code exchange on KV's 1,000 writes a day. It can return later as one more proof (D6) if MCP clients converge on it. |
| D3 | **Holds awaiting sign-in last 10 minutes** (a `booking.json` default), and the confirm link is single-use and expires with the hold. The agent needs seconds; the time is for the person to open the link and sign in. | F-001's 2-hour hold: blocks a slot far longer than a sign-in takes. |
| D4 | **A separate Google Cloud project** (`patrickjv-signin`) with only `openid email profile`. | The calendar project: it would work (the user cap counts only sensitive scopes), but branding and the cap are per project, and a public sign-in shouldn't share risk with the project holding the calendar token. ([spike](F-001-spikes/README.md#f-002-research-2026-10-09)) |
| D5 | **The agent never supplies the guest's address.** `book_meeting` on agent channels takes the type, start and an optional note; name and address come from the sign-in. | Accepting an `email` and checking it against the sign-in: invites mismatches and gives agents a field to misuse. |
| D6 | **One confirmation core with interchangeable proofs.** `confirmHold(hold, person, grant)` is the only way a hold becomes a meeting, and `cancelMeeting(booking, person, grant)` the only way a confirmed one ends. `person` is the guest: `provider` and `subject` (the stable key), `email`, and `display_name`, which is asserted, not verified. `grant` is the authority to act: `proof` (`signin:google`, `email_link`; later `signin:<provider>` for more providers), `actor` (the agent's identity, when the identity provider says an agent signed in for the person), `scopes` (`book`, `cancel`), `expires_at`, and optional `limits`. **The core checks the grant in the same synchronous block as the claim:** scope, expiry, revocation and limits, then the person caps, then the slot. So a grant's limits can't be overspent concurrently. Each proof's only job is to produce `person` and `grant`. P1's grant from a sign-in is one-shot: scope `book` (or `cancel`) for this ticket only. | Separate booking code per channel: drift, and every new proof would need its own copy of the rules. |
| D7 | **Caps.** Holds awaiting sign-in: at most 2 live per IP, F-001's 4 per IP a day, and the global 10 a day (taken when the hold is created). Confirmed bookings: at most 2 per person a day and 2 upcoming per person, plus F-001's 3 a day. Two kinds of limit: **daily counters** (holds per IP a day, global a day, confirmations per person a day; UTC day; never refunded) and **occupancy limits** (live holds per IP, upcoming meetings per person; counted from current bookings in `confirming`, `confirmed` or `cancelling` with a future start, so they free up when a hold lapses or a meeting ends or is cancelled). All values live in `booking.json` as defaults Patrick can change without code. | Keying hold caps on email: there's no email until sign-in. |
| D8 | **`/book` keeps the email path as a fallback until P3**, beside "Sign in with Google to confirm", for people without a Google account. Agent channels get no email path. | Removing it in P1: people without Google couldn't book until P2's providers arrive. |

**Threat model for confirmation.** A sign-in proves that **whoever controls the Google account at that moment** approved the booking, not that a human clicked. An agent driving the person's own signed-in browser (WebDriver, or an in-browser agent such as Claude in Chrome) can complete the sign-in, and no website can tell the difference. The site treats that as the person's authority, because they let the agent act in their browser. The "Booked" email to the verified address is the backstop. The confirmation stops an agent from booking in the name of **someone else** (it can't sign in to an account it doesn't control), and from booking with an address it merely typed. It doesn't stop a person's own agent acting within that person's session. A person who wants that delegation explicit can give their agent its own account and authorise it at the identity provider (P4).

---

## Instructions for agents and people

**One booking guide, published everywhere, readable without sign-in.** The guide is written once, in `content.json` (`booking_guide`), with `{hold_minutes}` and the meeting types filled in from `booking.json` when it's published, so the guide never states a timing or type the configuration doesn't have. and the build and the Worker publish it in each place an agent might start:

- the MCP server's `initialize` instructions
- a read-only tool, `get_booking_guide`, on MCP and WebMCP (some clients never show `instructions` to their model)
- `llms.txt` and `index.md` ("How to book a call"), and a plain page `/book.md`
- the `/book` page, in a short "For AI agents" note

Draft text, to be approved as public copy:

> **How to book a call with Patrick Vieira**
> 1. Call `list_meeting_types` to see the options (Consultation, 30 minutes; Recruiter intro, 15 minutes).
> 2. Call `get_availability` with a type. It lists free times in London working hours, each with its UTC offset. Steps 1 and 2 need no sign-in.
> 3. Agree a time with your person.
> 4. Call `book_meeting` with the type, the start time and an optional note. Don't send their name or email address: those come from their sign-in.
> 5. Give your person the `confirm_url` from the result. They open it and sign in with Google before `hold_expires` (within {hold_minutes} minutes). That books the call in their name, and Google sends them the invite.
> 6. Call `get_booking_status` to check it's confirmed. If it says `pending_confirmation` or `confirming`, wait and check again; don't book again. If it says `expired` or `declined`, start again from step 2.
>
> To cancel a booked call, call `cancel_booking` and give your person the link it returns. People can also book at https://patrickjv.com/book.

**Each tool says what to do next.** Tool descriptions carry the step they cover. Results include a `next_step` sentence:
- `book_meeting`: "Give this link to the person you're booking for. They need to sign in with Google before <hold_expires> to confirm. Then call get_booking_status." (with the actual expiry time)
- `get_booking_status`: one sentence for each status (`pending_confirmation`, `confirmed`, `expired`, `declined`, `cancelled`).
- Errors say what to change, never only a code.

**For the person, on the confirm page:**
- The meeting type, day and time in their time zone, with London time as well.
- "Sign in with Google to confirm this call. We use your name and email address from Google for the invite, and nothing else."
- "This link works once and expires at <time>."
- A used or expired link shows the booking's current state, never a blanket "book again":
  - **`confirming`:** "Your call is being finished. Check your email in a few minutes, and don't book again."
  - **`confirmed`:** "This call is already booked. Your invite is in your email."
  - **`declined`, `expired` or `cancelled`:** what happened, plus "Ask your assistant to book again, or go to patrickjv.com/book".
  - **`pending_confirmation`, sign-in path** (the hold is live but this sign-in attempt was spent): the sign-in button again.
  - **`pending_confirmation`, switched to email** (the sign-in ticket was spent by the switch): "Check your email for the confirmation link", with no sign-in button.

The "Booked" email stays as in F-001.

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

Same as Flow 1 from step 3: picking a slot creates the hold and shows the confirm page, with "Sign in with Google to confirm" and, until P3, "Confirm by email instead". Choosing email converts the **same** hold. The person types a name and email (`POST /api/booking/{id}/email`), F-001's per-email cap and one-live-hold-per-email rule are taken then, the hold's expiry extends to F-001's 2 hours, the sign-in ticket is spent, and F-001's Confirm/Decline email is sent. No second booking is created, and the hold caps already taken aren't charged again.

### Flow 3: Agent cancels a confirmed meeting

Maps to: US-4

1. The agent calls `cancel_booking({booking_id})`. For a confirmed meeting it returns a single-use `confirm_url` (10 minutes).
2. Which proofs can cancel depends on how the booking was confirmed:
   - **Sign-in bookings (`signin:google`):** a sign-in whose `provider` and `subject` match the guest, or the cancel link in that booking's "Booked" email (it went to the verified address, so holding it proves the mailbox, as in F-001).
   - **Email-confirmed bookings (`email_link`) and bookings from before F-002:** F-001's email links only. `cancel_booking`'s `confirm_url` page then says "Use the cancel link in your booking email", because there's no account to sign in with.
   - Anyone else's sign-in changes nothing ("This booking belongs to someone else").
3. A pending hold is still withdrawn directly by `booking_id`, as in F-001.

---

## Acceptance Criteria (P1)

### Functional

- [ ] **(US-2)** `list_meeting_types`, `get_availability`, `get_booking_status` and the profile tools work with no sign-in on MCP, WebMCP and the HTTP API.
- [ ] **(US-1, US-3)** Agent-channel `book_meeting` takes `type`, `start` and optional `note` only; an `email` or `name` argument is refused (HTTP API: `400 invalid_argument`; MCP: a tool result with `isError: true` and the same error code, as F-001's validation does). It creates a 10-minute hold and returns `{booking_id, status: "pending_confirmation", confirm_url, hold_expires}`. No email is sent.
- [ ] **(US-1)** `confirm_url` carries a 128-bit random ticket, stored hashed, single-use, expiring with the hold. Opening it (GET) shows the meeting and the sign-in button and changes nothing.
- [ ] **(US-1)** Sign-in: Google's authorization code flow with PKCE (S256). Transaction lifecycle:
  - **Start** (`POST /book/confirm/google`) creates a `signin_tx` row bound to the ticket and to its purpose (`confirm` or `cancel`), and sets `__Host-pjv_signin` (`Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`). `Lax` so the cookie arrives on Google's top-level redirect back.
  - **Callback** consumes `state` atomically before any outside call. It's single-use even if what follows fails, and a failed exchange means starting again from the confirm page while the ticket lasts.
  - **ID token**, from Google's token endpoint over TLS, server to server, so the signature check can be skipped (OIDC Core 3.1.3.7): `iss` is `https://accounts.google.com` or `accounts.google.com`, `aud` is our client ID, `exp` hasn't passed, `iat` is within 5 minutes, `nonce` matches the transaction, `sub` is present, and `email_verified` is true.
  - **Refused, with nothing booked or cancelled** (each tested with a fake Google): any check failing; a missing, mismatched or replayed `state`; a cookie that's missing or not this transaction's; an expired ticket; or a `cancel` transaction used to confirm, and the other way round. A real browser round trip (headless Chromium against a local fake Google) covers cookie delivery on the callback.
- [ ] **(US-1, D6)** A successful sign-in calls `confirmHold(hold, person, grant)`. **In one synchronous block before any outside call** it checks the grant, upserts the identity, writes `identity_id`, `proof`, `actor` and the guest's details onto the booking, checks and takes the person caps (the upcoming-meetings limit counts `confirming` rows by `identity_id`, so two concurrent confirmations can't both pass it), and sets `confirming`, so the alarm's recovery has everything it needs if the Worker is evicted. Then it re-checks free/busy and creates the event with the person's address and display name (Google's `name` claim if present, otherwise the part of the email before `@`; never treated as verified), sets the booking `confirmed`, and sends the "Booked" email to that address. Claim-before-await holds (tested): 20 concurrent sign-ins on one ticket, or on overlapping holds, give exactly one meeting; and one person confirming 5 different holds at once never exceeds their caps, including the 2-upcoming limit when they already have one upcoming meeting. Recovery of a booking cut off after the claim completes it using the stored guest, starting from a hold created with no guest details.
- [ ] **(US-1)** Failures on the **sign-in path** (proof `signin:*`), deliberately different from F-001 because the hold is short and the agent can simply ask again. The **email path** (proof `email_link`) keeps F-001's failure rules unchanged, including restoring the hold for retry after a 4xx insert. The core takes the policy from the grant's proof (each tested):
  - **Google refuses the insert (4xx), or the re-check finds a clash:** the booking ends `declined` (`unavailable`, `slot_taken` or `day_full`), the slot frees, and the page says so.
  - **Free/busy unreachable after the claim, before any insert is attempted:** the booking goes back to `pending_confirmation` with its guest details cleared, the ticket becomes usable again until the hold's original expiry, and the person's daily confirmation count taken at the claim is released, since nothing was attempted at Google. The page says "Couldn't check the calendar just now — try again".
  - **Outcome unknown after the claim:** stays `confirming` for the alarm's recovery, and the page says it's being finished and to check email.
  - **Sign-in denied, or the code exchange fails:** that transaction is spent, the ticket isn't, and the person can try again until the hold expires.
  - **Caps:** once an insert has been attempted, the person's daily count stays taken, whatever the outcome. The only release is the free/busy rollback above. The other daily counters are never refunded; the occupancy limits free up as bookings end.
- [ ] **(US-1)** WebMCP's `book_meeting` returns the same result, and the homepage shows a "Sign in to confirm" prompt with the meeting details that opens Google sign-in in a popup on click. If the popup is blocked, it falls back to the `confirm_url` link (tested in headless Chromium). This test checks the mechanics only. Per the threat model, a popup doesn't prove a human acted.
- [ ] **(US-4)** `cancel_booking` on a confirmed meeting returns a single-use `confirm_url`. Signing in as the booking's guest cancels it, and Google notifies attendees; signing in as anyone else changes nothing. A pending hold is withdrawn directly.
- [ ] **(US-5, D7)** Limits behave as D7 defines (tested):
  - Daily counters are taken atomically: holds per IP a day and globally a day when the hold is created (never refunded); confirmations per person a day at the claim (released only by the free/busy rollback, before any insert).
  - Occupancy limits are counted from current bookings: live holds per IP, and upcoming meetings per person (`confirming`, `confirmed` or `cancelling` with a future start). They free up when a hold lapses or a meeting is cancelled.
  - A refused request changes no count.
  - Values come from `booking.json`.
- [ ] **(US-1)** A forwarded link is handled as Edge Cases describe (tested): the first valid sign-in becomes the guest; later attempts on the same ticket get "already used"; cancellation recognises that guest.
- [ ] **(D8)** `/book` offers sign-in confirmation and, until P3, F-001's email confirmation as a fallback. Converting a hold to email behaves as Flow 2 says: same booking, F-001's email caps taken then, 2-hour expiry, sign-in ticket spent, no double charge (tested). F-001's tests for the email path stay green.
- [ ] **(D6)** `confirmHold` is the only code path that turns a hold into a meeting. The email path (D8) and the sign-in path both call it (tested). The email path's person is `{provider: "email", subject: <normalised address>, email, display_name: <typed>}` with grant `{proof: "email_link"}`, so person caps key on `provider` and `subject` for both.
- [ ] **(US-7)** The booking guide comes from one source, `content.json` → `booking_guide`. It's published, readable with no sign-in, in the MCP `initialize` instructions, the `get_booking_guide` tool (MCP and WebMCP, read-only, identical), `llms.txt`, `index.md`, `/book.md` and the `/book` page. A test checks every place carries the same text, and the build fails if one drifts. A test also changes `holdMinutes` and the meeting types in a copy of `booking.json` and checks the rendered guide, the `next_step` text and the confirm page all follow.
- [ ] **(US-7)** Every booking tool's description names its step in the guide. `book_meeting` and `get_booking_status` results include a `next_step` sentence (one for each status), and every booking error includes a sentence saying what to do. Tested for each result and error code.
- [ ] **(US-7)** An agent given only `https://patrickjv.com/` (reading `llms.txt` or the page, with no tools) can find the guide in one hop. Test: `llms.txt` links to `/book.md`, which contains the full guide.
- [ ] **(US-8)** The confirm page shows the meeting in the visitor's time zone and in London time, says why sign-in is asked and what's shared, and gives the link's expiry. A used or expired link shows the state-specific message for `confirming`, `confirmed`, `declined`, `expired`, `cancelled`, and `pending_confirmation` on each path (each tested). None of them suggests booking again while a booking is `confirming` or `confirmed`. Public copy is approved by Patrick before release.
- [ ] **(US-1)** Manual check: a booking made through the Claude connector (link in chat → sign-in on a phone → "Booked"), and one through WebMCP in a browser.

### Non-functional

- [ ] **Security:** no tokens are issued to agents. The ticket is the only bearer value, it's good for one hold, and it expires in 10 minutes. The confirm page can't be framed. Cookie-carrying POSTs require an exact `Origin`. The Google client secret is a Worker secret.
- [ ] **Privacy:** `/privacy` adds Google as identity provider, the short-lived sign-in cookie (strictly necessary, expires in 10 minutes), and what's kept about a signed-in person: provider, subject, verified email and name, deleted 30 days after the later of their last sign-in and the end of their last meeting. The site sets no lasting cookie in P1.
- [ ] **Observability:** health adds `signinReady` (Google client secrets set, Google's discovery document reachable). The production smoke check creates no holds (quotas are scarce): it checks `book_meeting`'s input schema in `tools/list`, and that a call with an `email` argument is refused. Hold creation and "no email sent" are covered by tests with a fake mailer, plus the manual checks. Logs carry the subsystem only.
- [ ] **Cost:** Free plan; storage only in `BookingStore` SQLite. No KV.

---

## Data Model

In `BookingStore` (SQLite):

```sql
CREATE TABLE identities (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL,
  email TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL,
  delete_after TEXT NOT NULL,           -- 30 days after the later of last sign-in and last meeting end
  UNIQUE (provider, subject)
);
CREATE TABLE signin_tx (                -- one per sign-in in progress; deleted when used or after 10 minutes
  state_hash TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL, cookie_hash TEXT NOT NULL,
  nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, purpose TEXT NOT NULL,  -- 'confirm' | 'cancel'
  expires_at TEXT NOT NULL
);
```

`bookings` gains `identity_id`, `proof` and `actor`. `guest_name`, `guest_email` and `email_key` become nullable: a sign-in hold has none until the claim fills them in. SQLite can't drop `NOT NULL` in place, so `migrate()` rebuilds the table by copying it, and is tested against a database holding live F-001 holds, confirmed meetings and unused tokens, all of which keep working. Hold tickets reuse F-001's `tokens` table with a new action, `confirm_signin`.

---

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/book/confirm?t=` | Confirm page for a hold or a cancellation (no state change) |
| POST | `/book/confirm/google` | Start Google sign-in for that ticket (sets the `__Host-` cookie) |
| GET | `/book/callback/google` | Google returns here; verify, then `confirmHold` (or cancel) |
| POST | `/api/booking/{id}/email` | `/book` only, until P3: convert this hold to F-001's email confirmation (`{name, email}`) |

New route: `patrickjv.com/book/confirm*` and `/book/callback*` to the `patrickjv-mcp` Worker. MCP and WebMCP tool shapes change as in Functional above. `get_booking_status` is unchanged.

---

## Edge Cases & Error Handling

- **The person never signs in:** the hold lapses after 10 minutes and the slot frees; status reads `expired`.
- **The link is opened on a different device:** fine. The ticket carries the hold; the cookie binds only the sign-in round trip on that device.
- **Someone other than the intended person signs in:** they become the guest. The agent's person sees status `confirmed`, and the "Booked" email goes to whoever signed in. This is accepted: the link is handed to the person by their own agent. Status `confirmed` means the booking was made, not that the agent's intended person made it. Later attempts on the ticket get "already used".
- **Google's email is unverified:** refused, nothing booked.
- **Caps reached at confirmation:** the page says so and the hold is released.
- **Popup blocked (WebMCP):** the link fallback works.

---

## Phases after P1

- **P2, more ways to sign in and better hand-off:** Microsoft (key on tenant plus object ID; email counted only when Microsoft marks it verified) and Altimist ID, as more buttons on the confirm page; MCP URL-mode elicitation on 2026-07-28 connections.
- **P3, retire anonymous paths:** remove `/book`'s email confirmation and make `request_intro` require a sign-in. Reading stays anonymous.
- **P4 (optional), identity providers with agent support (US-6).** Only if and when it's worth doing:
  - **Add a new identity provider built for agents** as another sign-in on the confirm page, or
  - **Update a provider already set up** (Google, Microsoft, Altimist ID) once it offers agent identities.

  Either way, the agent's sign-in works through the existing confirm page and core. If the provider says the agent acts for a person (for example an `act` actor claim, as in OAuth token exchange, RFC 8693), the core books for that person and records the agent as `actor` (D6). That's a per-provider check, not a delegation feature of the site.

  An agent that uses its person's own account needs nothing: P1 already handles it (threat model). Until P4 is taken up, watch which providers offer agent identities with a verifiable "acts for" statement, and the MCP and IETF work on agents acting for users. If MCP clients converge on OAuth sign-in instead, the [research](F-001-spikes/README.md#f-002-research-2026-10-09) records what that route needs.

---


## Google setup (manual, P1)

In a **new** Google Cloud project `patrickjv-signin` owned by `hello@` (about 30 minutes, plus brand-verification waiting time):

1. Branding: app name "patrickjv.com", support email, home page, privacy policy `https://patrickjv.com/privacy`, authorised domain `patrickjv.com`, optional logo. Audience: External, **Publish**.
2. Data access: `openid`, `email`, `profile` only.
3. Web client, redirect URI `https://patrickjv.com/book/callback/google`. Store the ID and secret as Worker secrets `SIGNIN_GOOGLE_CLIENT_ID` and `SIGNIN_GOOGLE_CLIENT_SECRET`.
4. Verify and publish branding; test with an account other than `hello@` (no warning screen).

---

## Open Questions

None blocking. Resolved by Patrick on 2026-10-09:

- **Defaults (D3, D7)** accepted: holds awaiting sign-in last 10 minutes; at most 2 live holds per IP; 2 confirmations per person a day; 2 upcoming meetings per person. All are in `booking.json` and can be changed without code.
- **Threat model** accepted: an agent driving its guest's own signed-in browser counts as the guest.

---

## References

- Research and spikes (2026-10-09): [F-001-spikes](F-001-spikes/README.md#f-002-research-2026-10-09), covering the OAuth-server route (D2), the Google project choice (D4), ChatGPT and the KV write budget.
- Google OpenID Connect: https://developers.google.com/identity/openid-connect/openid-connect
- MCP elicitation (URL mode, 2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- Google unverified apps and brand verification: https://support.google.com/cloud/answer/7454865, https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
