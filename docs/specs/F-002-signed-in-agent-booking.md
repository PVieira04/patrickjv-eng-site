# Feature Spec: Confirm bookings by signing in

> **Purpose:** Replace F-001's "please confirm" email with a sign-in by the person the booking is for, on the agent channels and as `/book`'s main path, through one core that also accepts an agent signing in with an identity set up for it (its person's own account, or its own account that its person has authorised at the identity provider).
> **Update when:** Requirements shift, acceptance criteria change, or scope moves during the build.
> **Related:** [F-001 Booking](F-001-booking.md) (this builds on it), [`../04-mcp-and-webmcp.md`](../04-mcp-and-webmcp.md), [`../06-operations.md`](../06-operations.md), [research](F-001-spikes/README.md#f-002-research-2026-10-09).

---

## Metadata

| Field | Value |
|---|---|
| Spec ID | F-002 |
| Status | Approved |
| Phase | P1 specified in full; P2–P3 outlined; P4 optional |
| Owner | @PVieira04 |
| Created | 2026-10-09 |
| Last updated | 2026-10-09 (no hold on the sign-in path; approved by Patrick after seven Codex passes) |
| Depends on | F-001 (shipped 8 Oct 2026); a new Google Cloud project for visitor sign-in |

---

## Summary

Today a booking is a 2-hour hold that becomes a meeting when the guest clicks a link emailed to them, because the site can't trust an address an agent types. F-002 makes **signing in the confirmation**. An agent (or a person on `/book`) asks for a slot, and the site returns a **"Sign in to confirm"** link for that slot. Nothing is reserved yet. The person opens the link and signs in with Google on patrickjv.com. Only then does the site claim the slot and book the meeting, for their **verified** Google address (the display name comes from Google too, but Google doesn't verify it). No confirmation email, no address typed by an agent, and no tokens issued to agents.

There's no hold on this path because nothing needs holding: the gap between the agent asking and the person signing in is a minute or two, not F-001's wait for an inbox. If the slot is taken in that gap, the person is told and picks another. With at most 3 meetings a day that should be rare.

Reading stays anonymous: an agent can look up meeting types and free times and relay them without anyone signing in. Only the act of booking (and cancelling a confirmed meeting) needs the person.

The booking step is one core operation: **book this requested slot for this verified person**. P1 proves the person by an interactive sign-in. An agent may complete that sign-in itself, if its identity is set up for it: either it has access to its person's own account, or it has its own account that its person has authorised at the identity provider. That depends on how the identity is set up, not on anything the site builds (P4). The long-term aim is to retire anonymous booking and anonymous intro messages altogether (P3).

---

## User Stories

### US-1: Agent books after its person signs in

As **a person whose AI agent is booking a call for me**, I want **the agent to hand me one link that I sign in on to confirm**, so that **the meeting is booked in my name in seconds, with no email round trip**.

**Why this matters:** The confirmation email exists only because the site can't tell who the agent is acting for. Signing in at the moment of booking proves it directly.

### US-2: Agents can research without anyone signing in

As **an AI agent researching for my person**, I want to **read Patrick's profile, meeting types and free times without signing in**, so that **I can tell my person when Patrick is free before they decide to book**.

### US-3: The booking tools never email an address an agent typed

As **anyone**, I want **the site's booking tools never to email an address an agent typed**, so that **nobody can use them to send me mail in my name**.

**Why this matters:** On the MCP and WebMCP tools the guest is whoever signs in; there's no address to misuse. `/book` keeps F-001's email form as a fallback until P3. That form is an ordinary anonymous web form: an agent driving a browser can fill it in as a person can, and nothing on a website can tell them apart (threat model). F-001's caps bound it, and P3 removes it.

### US-4: The guest cancels with the same proof

As **a guest**, I want **my agent to ask to cancel and me to confirm it the same way I confirmed the booking**, so that **cancelling needs me, not just my agent**.

### US-5: Abuse stays bounded

As **Patrick**, I want **booking requests to reserve nothing, and confirmed bookings to be capped per person**, so that **nobody can block my calendar or fill it**.

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

- Every booking made through the MCP and WebMCP tools is confirmed by the guest signing in; those tools have no email path.
- The guest's name and address come only from the sign-in.
- Nothing is reserved on the calendar until a verified person confirms.
- Reading tools stay anonymous.
- One booking core that accepts a sign-in by the person, or by an agent using an identity set up for it, without changing booking logic.
- Cost stays at £0.
- **P3:** retire anonymous booking (the email form on `/book`) and anonymous `request_intro`.

**Non-Goals**

- **Being an OAuth authorisation server in P1.** The site is a Google sign-in *client* only. Issuing tokens to agents was researched and rejected (D2).
- **Issuing agent credentials or managing delegation ourselves.** No site-issued agent keys or API tokens, and no record here of who may act for whom. Whether an agent can act for a person is set up at the identity provider (P4).
- **Booking for someone else.** The guest is whoever proves their identity, or the person an identity provider says the signed-in agent acts for (P4). The site never records delegation itself.
- **Keeping Google's tokens.** Only the verified claims are read, once, at sign-in.
- **Changing F-001's email path.** It stays as built (its own code, caps and failure rules) until P3 removes it.
- **Offering alternative slots on the confirm page.** If the slot has gone, the page says so and points back to the agent or `/book`.
- **Rescheduling** (still F-001's planned v2).

---

## Decisions (2026-10-09)

| # | Decision | Alternatives rejected |
|---|---|---|
| D1 | **Signing in books the meeting.** On MCP and WebMCP, `book_meeting` records a **booking request** and returns a "Sign in to confirm" link; the meeting is made when the person signs in on it. Reading needs no sign-in. Decided with Patrick: authorisation is for the one booking request, not a session. | F-001's confirmation email: the reason for F-002. An optional fast lane beside it: keeps strangers' inboxes exposed. |
| D2 | **The site is a sign-in client (OpenID Connect relying party), not an OAuth server.** | Making `/mcp` an OAuth 2.1 resource server with `@cloudflare/workers-oauth-provider`. Researched in depth (spikes and four review passes): it needs client registration and an allowlist, and works smoothly only in some clients (ChatGPT needs a different sign-in signal). The library also showed replayable refresh tokens, KV writes before consent and a non-atomic code exchange on KV's 1,000 writes a day. It can return later as one more proof (D6) if MCP clients converge on it. |
| D3 | **No hold on the sign-in path.** A booking request reserves nothing and doesn't affect availability. The slot is claimed only when the person signs in, by the same claim-before-await rule as F-001's confirm. The request's link lasts `requestMinutes` (default 60, in `booking.json`). The notice rule (`minNoticeHours`) is checked when the request is made and not again at sign-in, as F-001 doesn't re-apply it at confirmation; free/busy, overlap and `maxPerDay` are checked again at the claim. Config validation (build and Worker start, as for F-001's config) rejects a `booking.json` where `requestMinutes` isn't less than `minNoticeHours` × 60, so a request can never outlive its slot; the claim also refuses a start that has already passed, as a backstop. | **A 10-minute hold** (this spec's earlier draft): it blocked the calendar for a step that takes a minute, and it needed hold caps per IP, a hold-to-email conversion route, a state where the guest was unknown (nullable guest columns and a table rebuild), and refund rules for its counters. The only thing it bought was the slot being guaranteed for those minutes. **A stateless signed link** instead of a stored request: it needs a signing secret, can't be withdrawn, and `get_booking_status` couldn't tell an open request from an expired or made-up one. |
| D4 | **A separate Google Cloud project** (`patrickjv-signin`) with only `openid email profile`. | The calendar project: it would work (the user cap counts only sensitive scopes), but branding and the cap are per project, and a public sign-in shouldn't share risk with the project holding the calendar token. ([spike](F-001-spikes/README.md#f-002-research-2026-10-09)) |
| D5 | **The agent never supplies the guest's address.** `book_meeting` on MCP and WebMCP takes the type, start and an optional note; name and address come from the sign-in. | Accepting an `email` and checking it against the sign-in: invites mismatches and gives agents a field to misuse. |
| D6 | **One booking core with interchangeable proofs.** `confirmRequest(request, person, grant)` is the only way a booking request becomes a meeting, and `cancelMeeting(booking, person, grant)` the only way a sign-in booking ends. `person` is the guest: `provider` and `subject` (the stable key), `email`, and `display_name`, which is asserted, not verified. `grant` is the authority to act. **P1's grant has exactly these fields:** `proof` (`signin:google`), `actor` (always `null` in P1), `scope` (`book` or `cancel`), `ticket_hash` (the ticket this sign-in was started from) and `expires_at` (that ticket's expiry). **The core checks the grant in the same synchronous block as the claim:** `scope` matches the operation, `ticket_hash` matches the request (or the booking's cancel ticket), and `expires_at` hasn't passed. **Booking** then checks the person caps and the slot. **Cancelling** checks only that the booking is `confirmed`, hasn't started, and (for a sign-in proof) that `provider` and `subject` match the guest; caps and availability never stop a cancellation. Each proof's only job is to produce `person` and `grant`. **The grant is checked once, at the claim.** After that the booking carries its own authority: the alarm's recovery finishes a `confirming` or `cancelling` booking as F-001's recovery does, with no grant and without taking any cap again, even after the ticket has expired. **Cancelling a sign-in booking accepts two proofs:** a sign-in by the guest (`proof: signin:google`, `scope: cancel`), or the cancel link in that booking's "Booked" email (`proof: booked_email_link`, `scope: cancel`, `ticket_hash` and `expires_at` from that F-001 token), whose possession proves the verified mailbox. Once authorised, `cancelMeeting` runs F-001's cancellation unchanged: claim `cancelling` and spend the ticket, delete the event (attendees notified), then `cancelled`; if the deletion fails, the booking goes back to `confirmed` and the ticket is usable again until it expires; a booking left in `cancelling` by an eviction is finished by the alarm. Later proofs (P2, P4) may add an `actor`, limits or revocation; this check is where they go. | Separate booking code per sign-in provider: drift, and every new proof would need its own copy of the rules. **Routing F-001's email path through the core:** rewrites shipped, tested code that P3 deletes; the email path keeps its own code and rules until then. |
| D7 | **Caps.** Booking requests: at most `requestsPerIpPerDay` (default 20) per IP and `requestsPerDay` (default 200) in total, taken when the request is created and never refunded. A cancel link from `cancel_booking` takes the same two counters, and issuing one revokes the booking's previous sign-in cancel link (`cancel_signin` tokens only; the "Booked" email's cancel link is unaffected), so a booking has at most one live sign-in cancel link. Each ticket (request or cancel) can start at most `signinAttemptsPerTicket` (default 5) sign-ins. Together these bound storage, sign-in transactions and Google calls, because a request blocks nothing. Confirmed sign-in bookings: at most `confirmationsPerPersonPerDay` (2) per person and `upcomingPerPerson` (2) upcoming per person, plus F-001's `maxPerDay` (3 meetings a day across both paths). The per-person daily count is taken at the claim and never refunded. Upcoming meetings are counted from current bookings in `confirming`, `confirmed` or `cancelling` whose end is in the future, so they free up when a meeting ends or is cancelled. F-001's email caps apply unchanged to the email form. All values live in `booking.json` as defaults Patrick can change without code. UTC days, as in F-001. | Keying request caps on email: there's no email until sign-in. A live-requests cap per IP: requests reserve nothing, so there's nothing for it to protect. |
| D8 | **`/book` offers sign-in first and keeps F-001's email form as a separate fallback until P3**, for people without a Google account. The person chooses before anything is created: sign-in makes a booking request; email makes an F-001 hold. Nothing converts one into the other. The MCP and WebMCP booking tools have no email path. F-001's `POST /api/booking` stays as the email form's endpoint; like any web form it can be driven by an agent in a browser, which is the same exposure F-001 has today, bounded by F-001's caps. | Converting a sign-in request to email (the earlier draft): needed a route that had to be kept from agents, which an open HTTP endpoint can't do. Removing the email form in P1: people without Google couldn't book until P2's providers arrive. |

**Threat model for confirmation.** A sign-in proves that **whoever controls the Google account at that moment** approved the booking, not that a human clicked. An agent driving the person's own signed-in browser (WebDriver, or an in-browser agent such as Claude in Chrome) can complete the sign-in, and no website can tell the difference. The site treats that as the person's authority, because they let the agent act in their browser. The "Booked" email to the verified address is the backstop. The confirmation stops an agent from booking in the name of **someone else** (it can't sign in to an account it doesn't control), and from booking with an address it merely typed. It doesn't stop a person's own agent acting within that person's session. A person who wants that delegation explicit can give their agent its own account and authorise it at the identity provider (P4).

---

## Instructions for agents and people

**One booking guide, published everywhere, readable without sign-in.** The guide is written once, in `content.json` (`booking_guide`), with `{request_minutes}` and the meeting types filled in from `booking.json` when it's published, so the guide never states a timing or type the configuration doesn't have. The build and the Worker publish it in each place an agent might start:

- the MCP server's `initialize` instructions
- a read-only tool, `get_booking_guide`, on MCP and WebMCP (some clients never show `instructions` to their model)
- `llms.txt` and `index.md` ("How to book a call"), and a plain page `/book.md`
- the `/book` page, in a short "For AI agents" note

Draft text, to be approved as public copy:

> **How to book a call with Patrick Vieira**
> 1. Call `list_meeting_types` to see the options (Consultation, 30 minutes; Recruiter intro, 15 minutes).
> 2. Call `get_availability` with a type. It lists free times in London working hours, each with its UTC offset. Steps 1 and 2 need no sign-in.
> 3. Agree a time with your person.
> 4. Call `book_meeting` with the type, the start time and an optional note. Don't send their name or email address: those come from their sign-in. This doesn't reserve the time yet.
> 5. Give your person the `confirm_url` from the result. They open it and sign in with Google before `link_expires` (within {request_minutes} minutes). That books the call in their name, and Google sends them the invite. If someone else has taken the time in the meantime, the page tells them.
> 6. Call `get_booking_status` to check it's confirmed. If it says `pending_confirmation`, the booking isn't finished yet (your person may still be signing in, or the site may be finishing it): wait and check again, and don't book again. If it says `declined` or `expired`, start again from step 2.
>
> To cancel, call `cancel_booking`. A request your person hasn't signed in on yet is withdrawn at once. If it returns a `confirm_url`, give it to your person: they sign in to cancel. If it says a cancellation email was sent, your person uses the link in that email. If it says the booking is still being finished, check again in a few minutes and cancel then. People can also book at https://patrickjv.com/book.

**Each tool says what to do next.** Tool descriptions carry the step they cover. Results include a `next_step` sentence:
- `book_meeting`: "Give this link to the person you're booking for. They need to sign in with Google before <link_expires> to book the call. Then call get_booking_status." (with the actual expiry time)
- `get_booking_status`: one sentence for each public status (`pending_confirmation`, `confirmed`, `declined`, `expired`, `cancelled`).
- `cancel_booking`: one sentence for each outcome (withdrawn; link to give the person; cancellation email sent).
- Errors say what to change, never only a code.

**For the person, on the confirm page:**
- The meeting type, day and time in their time zone, with London time as well.
- "Sign in with Google to book this call. We use your name and email address from Google for the invite, and nothing else."
- "This link works until <time>."
- If the time is no longer free when the page opens, it says "This time has just been taken. Ask your assistant to find another, or go to patrickjv.com/book", with no sign-in button, and the request is settled `declined` (see Functional). "No longer free" means another booking or live F-001 hold overlaps it, free/busy shows it busy, or the day is full; not whether `get_availability` still lists it, since that listing applies the notice rule, which a request isn't held to after it's made (D3).
- A used, withdrawn or expired link shows what happened, never a blanket "book again":
  - **booking `confirming`:** "Your call is being finished. Check your email in a few minutes, and don't book again."
  - **booking `confirmed`:** "This call is already booked. Your invite is in your email."
  - **`declined`, `expired` or `cancelled`:** what happened, plus "Ask your assistant to book again, or go to patrickjv.com/book".
  - **request still open** (a sign-in attempt failed or was abandoned): the sign-in button again.

**On a cancel link** (from `cancel_booking` on a sign-in booking), the same page shows the meeting and "Sign in with Google to cancel this call. Only the person it's booked for can cancel it.", with the link's expiry. After a cancellation it says "Cancelled. Google has told everyone invited." A used or expired cancel link shows the booking's current state: `confirmed` before the start, "This call is still booked. Ask your assistant for a new cancel link, or use the cancel link in your booking email."; `confirmed` after the start, "This call has already started, so it can't be cancelled here."; `cancelled`, "This call is already cancelled." Signing in as someone else shows "This booking belongs to someone else" and changes nothing.

The "Booked" email stays as in F-001.

---

## User Flows

### Flow 1: Agent books (MCP or WebMCP)

Maps to: US-1, US-2, US-3

1. The agent reads `list_meeting_types` and `get_availability` anonymously and relays free times to its person.
2. The person picks one. The agent calls `book_meeting({type, start, note?})`. The site checks the slot against current availability, takes the request caps, and stores a booking request with a single-use 128-bit ticket. It returns `{booking_id, status: "pending_confirmation", confirm_url, link_expires, next_step}`. Nothing is reserved and no email is sent.
   - **MCP:** the result tells the agent to give the person `confirm_url`. On MCP 2026-07-28 connections that declare URL-mode elicitation, the server may request it with that URL (P2); otherwise it's plain text.
   - **WebMCP:** the page shows "Sign in to book" with the meeting details, and opens Google sign-in in a popup when the person clicks.
3. The person opens the link: patrickjv.com shows the meeting type and time and a **Sign in with Google to book** button.
4. Google sign-in (authorization code flow with PKCE, `state` and `nonce` bound to the ticket). The site exchanges the code server-side, checks the ID token, builds `person` and `grant`, and calls `confirmRequest(request, person, grant)`.
5. The core claims the slot, re-checks free/busy, creates the event with the person as guest, and sends the "Booked" email. The page says "Booked".
6. The agent polls `get_booking_status` and tells its person it's confirmed.

### Flow 2: Person books on `/book`

Maps to: US-1, US-3

The person picks a slot and chooses how to confirm:

- **"Sign in with Google to book"** (the main button): the page creates a booking request exactly as in Flow 1 (`POST /api/booking/request`) and starts the sign-in for its ticket straight away, so there's no extra confirm-page step. From step 4 it's Flow 1.
- **"Book with email instead"** (until P3): F-001's form and flow, unchanged: name and email, a 2-hour hold, F-001's caps, and a Confirm/Decline email.

### Flow 3: Agent cancels

Maps to: US-4

`cancel_booking({booking_id})` depends on what the ID refers to:

- **An open booking request:** withdrawn at once (`cancelled`); its link stops working.
- **An F-001 pending hold (email form):** withdrawn at once, as in F-001.
- **A booking being finished (`confirming`) or being cancelled (`cancelling`):** refused with F-001's `not_cancellable`, decided on the internal state as F-001's `cancelByAgent` does. The result carries the public status (`pending_confirmation` or `confirmed`) and a `next_step`: "This booking is still being finished. Check again in a few minutes, then cancel if needed." or "A cancellation is already in progress." Nothing changes.
- **A confirmed sign-in booking (proof `signin:google`):** returns a single-use `confirm_url` lasting `requestMinutes` or until the meeting starts, whichever is sooner (F-001's cancel links also end at the start); it revokes any earlier sign-in cancel link for that booking (not the "Booked" email's link). After the start, `cancel_booking` returns F-001's `not_cancellable`. A sign-in whose `provider` and `subject` match the guest cancels it, and Google notifies attendees. Anyone else's sign-in changes nothing ("This booking belongs to someone else"). The cancel link in that booking's "Booked" email also still works (it went to the verified address, so holding it proves the mailbox, as in F-001).
- **A confirmed email-form booking, or one from before F-002:** exactly as F-001: the guest's confirmed address is sent a confirm-cancellation link, and no `confirm_url` is returned. That address was proved by its own mailbox, so it isn't one an agent typed.

---

## Acceptance Criteria (P1)

### Functional

- [ ] **(US-2)** `list_meeting_types`, `get_availability`, `get_booking_status`, `get_booking_guide` and the profile tools work with no sign-in on MCP and WebMCP, and F-001's read endpoints (`GET /api/booking/types`, `/api/booking/availability`, `/api/booking/status`) work with no sign-in. No new HTTP read endpoint is added: WebMCP's `get_booking_guide` reads the guide embedded in the page, as the profile tools do.
- [ ] **(US-1, US-3, D5)** `book_meeting` on MCP and WebMCP, and `POST /api/booking/request`, take `type`, `start` and optional `note` only (plus the HTTP endpoint's optional `source`, as the API section says); an `email` or `name` argument is refused (HTTP API: `400 invalid_input`; MCP: a tool result with `isError: true` and the same error code, as F-001's validation does). A start that isn't currently a free slot is refused exactly as F-001's `POST /api/booking` refuses it today (`409 slot_taken` for a slot no longer free; `409 invalid_slot` for one inside the notice window or past the horizon; `400 invalid_slot` for one that was never a slot) and uses no allowance. **Order, as F-001's:** validate the arguments, then check the slot against local bookings, live F-001 holds, the day count and the shared free/busy cache (the one `get_availability` uses: it covers the whole horizon and is refreshed at most once a minute), then take the request counters, then store the request. So request creation calls Google at most once a minute however many requests arrive, refused or not (tested: 50 requests for busy slots within a minute make at most one free/busy call and take no allowance). If the cache is stale and Google can't be reached, the request is refused with F-001's `503 unavailable` and takes no allowance. Otherwise it stores a booking request and returns `{booking_id, status: "pending_confirmation", confirm_url, link_expires, next_step}`. No email is sent (fake mailer), and `get_availability` still offers the slot afterwards (tested).
- [ ] **(US-1)** `confirm_url` carries a 128-bit random ticket, stored hashed, that expires `requestMinutes` after the request is made. Opening it (GET) shows the meeting and the sign-in button and changes nothing. The first time the site finds an open request's slot no longer free (opening the confirm page, a `get_booking_status` read, or starting a sign-in), it settles the request `declined` (`slot_taken` or `day_full`) for good: the link stops working, the page says so, and the status reads `declined`, so the page, the tool and the guide's "start again" agree and the old link can't make a second booking later (tested). The only reads that write are these two (the confirm page GET, and `get_booking_status` on MCP, WebMCP and `GET /api/booking/status`), and only to record this. `get_booking_status` keeps `readOnlyHint: true` on MCP and WebMCP alike (tested for parity): the write doesn't change anything the caller asked for, it only records what the calendar already shows, and the request could no longer have been booked anyway; it's a fact about the calendar, so a link preview opening the page does no harm. **"No longer free" is judged from data the site already has:** other bookings and live F-001 holds, the day count, and free/busy from the shared 1-minute availability cache. If that cache is stale and refreshing it fails, only the local checks apply and the request stays open; the claim re-checks free/busy anyway. Once the request has become a booking, or has been withdrawn or has expired, the ticket starts no further sign-in.
- [ ] **(US-1)** Sign-in: Google's authorization code flow with PKCE (S256). Transaction lifecycle:
  - **Start** (`POST /book/confirm/google`) creates a `signin_tx` row bound to the ticket and to its purpose (`book` or `cancel`), and sets `__Host-pjv_signin` (`Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`). `Lax` so the cookie arrives on Google's top-level redirect back.
  - **Admission:** a ticket can start at most `signinAttemptsPerTicket` sign-ins (counted when `signin_tx` is created, never refunded); the next attempt is refused and the page says "Too many tries. Ask your assistant for a new link." Expired `signin_tx` rows are pruned by the alarm. Tested.
  - **Callback** consumes `state` atomically before any outside call. It's single-use even if what follows fails, and a failed exchange means starting again from the confirm page while the ticket lasts.
  - **ID token**, from Google's token endpoint over TLS, server to server, so the signature check can be skipped (OIDC Core 3.1.3.7): `iss` is `https://accounts.google.com` or `accounts.google.com`, `aud` is our client ID, `exp` hasn't passed, `iat` is within 5 minutes, `nonce` matches the transaction, `sub` is present, and `email_verified` is true.
  - **The address must be Google-authoritative:** either it ends in `@gmail.com`, or the token carries an `hd` (Workspace domain) claim matching the address's domain. Google warns that for other addresses, `email_verified` can survive a change of who owns the mailbox. A non-authoritative address is refused for both booking and cancelling, with nothing changed and the request left open. The page says "Google can't vouch for this address. Sign in with a Gmail or Google Workspace account, or book at patrickjv.com/book with email instead." No email is sent to it (tested both ways: a `@gmail.com` address and an `hd`-matching address succeed; a verified address with no matching `hd` is refused).
  - **Refused, with nothing booked or cancelled** (each tested with a fake Google): any check failing; a missing, mismatched or replayed `state`; a cookie that's missing or not this transaction's; a transaction past its 10-minute `expires_at`, even if it hasn't been pruned yet; an expired, used or withdrawn ticket; or a `cancel` transaction used to book, and the other way round. A real browser round trip (headless Chromium against a local fake Google) covers cookie delivery on the callback.
- [ ] **(US-1, D6)** A successful sign-in calls `confirmRequest(request, person, grant)` with the grant shape D6 defines. **In one synchronous block before any outside call** it checks the grant (scope, ticket, expiry), upserts the identity, checks and takes the person caps, checks the slot is still free of other bookings and live F-001 holds and within `maxPerDay`, creates the booking row (`id` = the request's `booking_id`) in `confirming` with `identity_id`, `proof`, `actor` and the guest's name and address, and marks the request used. So the alarm's recovery has everything it needs if the Worker is evicted. Then it re-checks free/busy and creates the event with the person's address and display name (Google's `name` claim if present, otherwise the part of the email before `@`; never treated as verified), sets the booking `confirmed`, and sends the "Booked" email to that address. A request made with 24h05m notice and signed in on 10 minutes later still books (notice isn't re-applied; tested). Claim-before-await holds (tested): 20 concurrent sign-ins on one ticket, or on different requests for overlapping slots, give exactly one meeting; and one person confirming 5 different requests at once never exceeds their caps, including the 2-upcoming limit when they already have one upcoming meeting. Recovery of a booking cut off after the claim completes it using the stored guest. For sign-in bookings, recovery settles the same way as the live path: if Google refuses the insert (4xx) or the re-check finds a clash, the booking ends `declined` and frees the slot and the person's upcoming allowance, rather than being retried forever (tested: eviction after the claim, then a 4xx on recovery's insert). If the meeting's start has passed by the time recovery runs and Google has no event for it, recovery settles the booking `declined` (`unavailable`) without inserting (tested).
- [ ] **(US-1)** Failures after a sign-in (each tested). F-001's email path keeps its own failure rules, untouched:
  - **The slot is taken by the time of the claim, or the re-check finds a clash, or Google refuses the insert (4xx):** the booking ends `declined` (`slot_taken`, `day_full` or `unavailable`), the request is used, and the page says what happened: "This time has just been taken" for `slot_taken`, "Patrick's day is full" for `day_full`, and "Google couldn't add this call" for `unavailable`, each with the advice above. The agent sees `declined` and starts again.
  - **Free/busy unreachable after the claim, or the insert's outcome unknown (timeout, network error, 5xx):** the booking stays `confirming` for the alarm's recovery, as in F-001, and the page says it's being finished and to check email. Nothing is rolled back or refunded after a claim: recovery either completes the booking or settles it `declined` (tested with eviction before and after the insert is attempted; recovery asks Google whether the event exists before anything else, as F-001's does).
  - **Sign-in denied, or the code exchange fails:** that transaction is spent, the request stays open, and the person can try again until it expires.
  - **Caps reached at the claim:** nothing is booked, the request stays open (another account may still use it), and the page says which limit was reached.
- [ ] **(US-1)** WebMCP's `book_meeting` returns the same result, and the homepage shows a "Sign in to book" prompt with the meeting details that opens Google sign-in in a popup on click. If the popup is blocked, it falls back to the `confirm_url` link (tested in headless Chromium). This test checks the mechanics only. Per the threat model, a popup doesn't prove a human acted.
- [ ] **(US-4)** `cancel_booking` behaves as Flow 3 says for each kind of ID, each tested:
  - an open request: withdrawn, status `cancelled`, its ticket starts no sign-in;
  - an F-001 pending hold: withdrawn, as in F-001;
  - a booking in `confirming` or `cancelling`: `not_cancellable` with the public status and `next_step` Flow 3 gives, and nothing changes (each tested, including `confirming` left by an eviction);
  - a sign-in booking: returns a single-use `confirm_url`; signing in as the guest (same `provider` and `subject`) cancels it and Google notifies attendees; signing in as anyone else, or with a non-authoritative address, changes nothing; a second sign-in on a used cancel link changes nothing; the "Booked" email's cancel link also cancels it, through `cancelMeeting` with the `booked_email_link` grant; a cancel link issued 30 minutes before the start stops working at the start; a second `cancel_booking` revokes the first sign-in cancel link while the "Booked" email's link keeps working; a guest who has reached their booking caps can still cancel; once authorised, a failed deletion puts the booking back to `confirmed` with the link usable again until it expires, as F-001 does; if that link has used all its sign-in attempts, the page says "Couldn't cancel just now. Ask your assistant for a new cancel link, or use the cancel link in your booking email." (tested); the confirm page shows the cancellation copy above for each state;
  - an email-form or pre-F-002 booking: F-001's confirm-cancellation email to the guest's confirmed address, and no `confirm_url`.
- [ ] **(US-5, D7)** Limits behave as D7 defines (tested):
  - Request counters (per IP a day, global a day) are taken atomically when a request is stored and never refunded. Requests refused by cheap checks (invalid arguments, slot not free) take nothing.
  - The per-person daily confirmation count is taken at the claim and never refunded.
  - Upcoming meetings per person are counted from current bookings (`confirming`, `confirmed` or `cancelling` whose end is in the future, by `identity_id`). They free up when a meeting ends or is cancelled.
  - `maxPerDay` counts meetings from both paths.
  - A refused request changes no count.
  - Values come from `booking.json`.
- [ ] **(US-1)** A forwarded link is handled as Edge Cases describe (tested): the first sign-in that books becomes the guest; later attempts get "already booked"; cancellation recognises that guest.
- [ ] **(D8)** `/book` offers "Sign in with Google to book" and, until P3, "Book with email instead". The sign-in choice creates a booking request and starts sign-in in one step; the email choice is F-001's form, unchanged. There's no route that turns a request into an email booking or the reverse. F-001's tests for the email path stay green.
- [ ] **(F-001 US-8)** `BOOKING_ENABLED=false` refuses new requests and new cancel links with F-001's `503` (`book_meeting`, `POST /api/booking/request`, `cancel_booking` on a sign-in booking), and `/book` says booking is closed; read tools still work. Links already issued keep working, as F-001's emailed links do while booking is off: an open request can still be signed in on and booked, and a cancel link can still cancel. Bookings in `confirming` or `cancelling` are still finished by the alarm. Tested both ways.
- [ ] **(D6)** `confirmRequest` is the only code path that turns a booking request into a meeting, and `cancelMeeting` the only one that cancels a sign-in booking, on either proof (tested by checking that the callback, the alarm's recovery and the HTTP API reach them and nothing else writes those transitions).
- [ ] **(US-7)** The booking guide comes from one source, `content.json` → `booking_guide`. It's published, readable with no sign-in, in the MCP `initialize` instructions, the `get_booking_guide` tool (MCP and WebMCP, read-only, identical), `llms.txt`, `index.md`, `/book.md` and the `/book` page. A test checks every place carries the same text, and the build fails if one drifts. A test also changes `requestMinutes` and the meeting types in a copy of `booking.json` and checks the rendered guide, the `next_step` text and the confirm page all follow.
- [ ] **(US-7)** Every booking tool's description names its step in the guide. `book_meeting`, `get_booking_status` and `cancel_booking` results include a `next_step` sentence (one for each status or outcome), and every booking error includes a sentence saying what to do. Tested for each result and error code.
- [ ] **(US-7)** An agent given only `https://patrickjv.com/` can reach the full guide in one hop, whichever way it reads the site. Tests: the homepage HTML links to `/book` (which carries the guide in its "For AI agents" note) and to `/book.md`; `llms.txt` and `index.md` link to `/book.md`; `/book.md` contains the full guide.
- [ ] **(US-8)** The confirm page shows the meeting in the visitor's time zone and in London time, says why sign-in is asked and what's shared, and gives the link's expiry. It shows the state-specific message for: a slot no longer free; a booking `confirming`; `confirmed`; `declined`; `expired`; `cancelled`; and a request still open after a failed attempt (each tested). None of them suggests booking again while a booking is `confirming` or `confirmed`. Public copy is approved by Patrick before release.
- [ ] **(US-1)** Manual check: a booking made through the Claude connector (link in chat → sign-in on a phone → "Booked"), and one through WebMCP in a browser.

### Non-functional

- [ ] **Security:** no OAuth or API tokens are issued to agents. Bearer values, each tested for its limits: the **`booking_id`** (128-bit random, as F-001) lets its holder read status, withdraw an open request and ask for a cancel link, never book or cancel a meeting; a **request ticket** can start sign-ins only while its request is open and expires after `requestMinutes`; a **cancel ticket** can start sign-ins only to cancel its booking and expires after `requestMinutes` or at the meeting start, whichever is sooner. Tickets are stored hashed and each starts at most `signinAttemptsPerTicket` sign-ins. The confirm page can't be framed. Cookie-carrying POSTs require an exact `Origin`. The Google client secret is a Worker secret.
- [ ] **Privacy:** `/privacy` adds Google as identity provider, the short-lived sign-in cookie (strictly necessary, expires in 10 minutes), what a booking request keeps (type, time, note and a hashed IP, nothing about the person; deleted 30 days after it's used, withdrawn, declined or expires), and what's kept about a signed-in person: provider, subject, verified email and name, deleted 30 days after the later of their last sign-in and the end of their last meeting. The site sets no lasting cookie in P1.
- [ ] **Observability:** health adds `signinReady` (sign-in client ID and secret set, Google's discovery document reachable). Smoke's health check requires `signinReady` whenever it requires `bookingReady`, so the 6-hourly monitor and the post-deploy smoke fail when sign-in is unavailable (tested in `healthVerdict`'s tests). The production smoke creates one booking request for the first free slot, checks the result's shape, then withdraws it with `cancel_booking` and checks it reads `cancelled`. If there's no free slot in the horizon, the request is refused with `429` (allowance used up), or it's refused with `409` because the calendar changed between the two calls, the smoke reports that step as skipped and passes, as it does when booking is disabled. That a request reserves nothing is proved by the unit tests, not the live smoke. It also checks that a call with an `email` argument is refused. Logs carry the subsystem only.
- [ ] **Cost:** Free plan; storage only in `BookingStore` SQLite. No KV.

---

## Status for callers

`get_booking_status` keeps F-001's public statuses and adds no new one. It looks up the ID among bookings first, then booking requests:

| Internal state | Public status | `status_reason` |
|---|---|---|
| Request open, slot still free | `pending_confirmation` | — |
| Request found with its slot no longer free | `declined` | `slot_taken` or `day_full` (settled when first found, see Functional) |
| Request past `link_expires`, never used | `expired` | `request_expired` |
| Request withdrawn | `cancelled` | `agent_withdrew` (F-001's reason) |
| Booking `confirming` | `pending_confirmation` (as F-001) | — |
| Booking `confirmed` / `cancelling` | `confirmed` (as F-001) | — |
| Booking `declined` | `declined` | `slot_taken`, `day_full` or `unavailable` |
| Booking `cancelled` | `cancelled` | as F-001 |

The guide and the tool description list exactly these five public statuses.

---

## Data Model

In `BookingStore` (SQLite):

```sql
CREATE TABLE booking_requests (         -- sign-in path; reserves nothing
  id TEXT PRIMARY KEY,                  -- the booking_id returned to the agent; the booking reuses it
  ticket_hash TEXT NOT NULL UNIQUE, type TEXT NOT NULL, start_utc TEXT NOT NULL, end_utc TEXT NOT NULL,
  note TEXT, source TEXT NOT NULL, ip_key TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- 'open' | 'used' | 'cancelled' | 'declined'; expiry is read from expires_at
  reason TEXT,                          -- for 'declined': 'slot_taken' | 'day_full'
  settled_at TEXT                       -- when it left 'open'
);
CREATE TABLE identities (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL,
  email TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL,
  delete_after TEXT NOT NULL,           -- 30 days after the later of last sign-in and last meeting end
  UNIQUE (provider, subject)
);
CREATE TABLE signin_tx (                -- one per sign-in in progress; deleted when used or after 10 minutes
  state_hash TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL, cookie_hash TEXT NOT NULL,
  nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, purpose TEXT NOT NULL,  -- 'book' | 'cancel'
  expires_at TEXT NOT NULL
);
```

`bookings` gains `identity_id`, `proof` and `actor`, added with `ALTER TABLE … ADD COLUMN` (nullable; existing F-001 rows keep `NULL`, which marks an email-form booking). A sign-in booking row is created only at the claim, with the guest already known, so every existing `NOT NULL` column can be filled and no table rebuild is needed: `guest_name` and `guest_email` from the sign-in, `email_key` computed from the verified address exactly as F-001 computes it from a typed one, and `source` and `ip_key` copied from the request (`source` is the channel the request came from: `mcp`, `webmcp` or `page`). Cancel tickets for sign-in bookings reuse F-001's `tokens` table with a new action, `cancel_signin`. A request is deleted 30 days after `settled_at` if it was used, withdrawn or declined, otherwise 30 days after `expires_at`; the alarm prunes them with F-001's records (tested for each state). A used request's booking row then carries on under F-001's retention.

---

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/booking/request` | Create a booking request (`{type, start, note?, source?}`); used by WebMCP's `book_meeting` and `/book`'s sign-in button. `source` is optional, exactly `"page"` (default) or `"webmcp"`, self-reported as in F-001, and only records the channel. MCP requests are stored as `mcp`. |
| GET | `/book/confirm?t=` | Confirm page for a booking request or a cancellation. No state change, except settling an open request `declined` when its slot is no longer free (see Functional) |
| POST | `/book/confirm/google` | Start Google sign-in for that ticket (sets the `__Host-` cookie) |
| GET | `/book/callback/google` | Google returns here; verify, then `confirmRequest` (or `cancelMeeting`) |

F-001's `POST /api/booking` stays, unchanged, as the email form's endpoint until P3; WebMCP's `book_meeting` no longer uses it. New routes: `patrickjv.com/book/confirm*` and `/book/callback*` to the `patrickjv-mcp` Worker. MCP and WebMCP tool shapes change as in Functional above. `get_booking_status` and `cancel_booking` keep their input shapes; their results follow "Status for callers" and Flow 3.

---

## Edge Cases & Error Handling

- **The person never signs in:** the request lapses after `requestMinutes`; nothing was reserved, so nothing needs freeing. Status reads `expired`.
- **Someone else books the slot before the person signs in:** the confirm page says so if it's already known when the page opens; otherwise the claim declines with `slot_taken`. Either way nothing is booked and the agent starts again from free times.
- **Two requests for the same slot:** both can exist; the first sign-in to claim wins, the other is `declined` (`slot_taken`).
- **The link is opened on a different device:** fine. The ticket carries the request; the cookie binds only the sign-in round trip on that device.
- **Someone other than the intended person signs in:** they become the guest. The agent's person sees status `confirmed`, and the "Booked" email goes to whoever signed in. This is accepted: the link is handed to the person by their own agent, and it's no worse than anyone using `/book`. Status `confirmed` means the booking was made, not that the agent's intended person made it. Later attempts on the ticket get "already booked".
- **Google's email is unverified, or not Google-authoritative:** refused, nothing booked, the request stays open.
- **Caps reached at the claim:** the page says so; nothing is booked.
- **Popup blocked (WebMCP):** the link fallback works.

---

## Phases after P1

- **P2, more ways to sign in and better hand-off:** Microsoft (key on tenant plus object ID; email counted only when Microsoft marks it verified) and Altimist ID, as more buttons on the confirm page; MCP URL-mode elicitation on 2026-07-28 connections.
- **P3, retire anonymous paths:** remove `/book`'s email form (and F-001's `POST /api/booking` and its email-confirm code) and make `request_intro` require a sign-in. Reading stays anonymous.
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

None. Resolved by Patrick on 2026-10-09:

- **Defaults (D3, D7)** accepted with the spec's approval: a request link lasts 60 minutes; at most 20 requests per IP a day and 200 in total; at most 5 sign-in attempts per link; 2 confirmations per person a day; 2 upcoming meetings per person. All are in `booking.json` and can be changed without code.

- **No hold on the sign-in path** (D3): the slot is claimed only at sign-in.
- **Threat model** accepted: an agent driving its guest's own signed-in browser counts as the guest.

---

## References

- Research and spikes (2026-10-09): [F-001-spikes](F-001-spikes/README.md#f-002-research-2026-10-09), covering the OAuth-server route (D2), the Google project choice (D4), ChatGPT and the KV write budget.
- Google OpenID Connect: https://developers.google.com/identity/openid-connect/openid-connect
- MCP elicitation (URL mode, 2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- Google unverified apps and brand verification: https://support.google.com/cloud/answer/7454865, https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
