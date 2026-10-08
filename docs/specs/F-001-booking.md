# Feature Spec: Booking

> **Purpose:** Define what booking on patrickjv.com is, who it's for, and what it must do, before any code is written.
> **Update when:** Requirements shift, acceptance criteria change, or scope moves during the build.
> **Related:** [`../01-architecture.md`](../01-architecture.md), [`../04-mcp-and-webmcp.md`](../04-mcp-and-webmcp.md), [`../06-operations.md`](../06-operations.md).

---

## Metadata

| Field | Value |
|---|---|
| Spec ID | F-001 |
| Status | Draft |
| Phase | v1 |
| Owner | @PVieira04 |
| Created | 2026-10-08 |
| Last updated | 2026-10-08 |
| Target release | TBD |
| Depends on | A Google account for `hello@patrickjv.com` (setup below); the existing `patrickjv-mcp` Worker |

---

## Summary

Visitors and AI agents can book a meeting with Patrick from his real availability. A person books on a `/book` page; an agent books through the site's MCP server or WebMCP tools. Either way the booking starts as a hold, and becomes a meeting only when the guest clicks a confirmation link in their own inbox. Bookings land in Patrick's calendar and never overlap anything already there.

Two reasons: Patrick uses it for consultations and recruiter calls, and it shows agents acting for people with the person's consent kept in the loop.

---

## User Stories

### US-1: Visitor books a consultation

As a **visitor**, I want to **pick a free 30-minute slot and book it**, so that **I get a meeting without trading emails about times**.

**Why this matters:** The main human path, and the one Patrick uses most.

### US-2: Recruiter books an intro

As a **recruiter**, I want to **book a short intro call that is separate from consultations**, so that **the meeting is the right length and Patrick knows what it is for**.

**Why this matters:** Recruiter calls are shorter and a different conversation. The meeting type tells Patrick which one it is before he joins.

### US-3: Agent reads meeting types and availability

As an **AI agent**, I want to **list meeting types and free slots over MCP or WebMCP**, so that **I can offer my person real times**.

**Why this matters:** The same data the page shows, readable by machines in both places the site already serves tools.

### US-4: Agent books for its person, who confirms

As an **AI agent acting for a person**, I want to **hold a slot and have my person confirm it from their inbox**, so that **the meeting only exists if they agreed to it**.

**Why this matters:** An agent can claim any email address. The confirmation email is the proof that the address belongs to someone who wants the meeting. Unconfirmed holds lapse and free the slot.

### US-5: Guest cancels

As a **guest**, I want to **cancel from a link in my confirmation email**, so that **I don't have to write to anyone**.

### US-6: Patrick's calendar stays true

As **Patrick**, I want **bookings in my calendar, never overlapping anything already there**, so that **I can trust the slots the site offers**.

### US-7: Patrick changes the rules without code

As **Patrick**, I want **meeting types, hours, rules and calendars in one config file in the repo**, so that **changing them is an edit and a deploy**.

### US-8: Abuse stays bounded

As **Patrick**, I want **caps and flood protection like request_intro's**, so that **nobody can fill my calendar or run up costs**.

### US-9: Agent cancels

As an **AI agent**, I want to **withdraw a pending hold, or ask to cancel a confirmed booking**, so that **I can undo a booking when my person changes their mind**.

**Why this matters:** Withdrawing a hold that hasn't been confirmed needs no consent: nothing exists yet. Cancelling a real meeting does, so the person gets a "Confirm cancellation" link and only that link cancels it.

---

## Goals & Non-Goals

**Goals**

- A person or an agent can book either meeting type from real free time, with no double bookings.
- No meeting is created, and no invite sent, for an email address whose owner didn't confirm it. Page and agent bookings follow the same path: hold, email, confirm.
- Guests never see Patrick's personal address; the site never reads anything from his calendars beyond free/busy.
- Daily costs and email volume stay bounded under abuse, failing closed.

**Non-Goals (v1)**

- **Rescheduling.** Planned for v2, see below. In v1 a guest cancels and books again.
- **Payments.** Consultations are free to book.
- **Guest accounts.** Links in emails are the only credentials.
- **Video other than Google Meet.**
- **Delegation credentials for agents** (did:web or verifiable credentials proving an agent speaks for a person). Email confirmation does that job in v1; credentials are a phase 3 stretch.
- **Syncing changes made in Google back to the site.** If a guest declines the invite in Google, the slot simply becomes free again in free/busy. The site's booking record isn't updated.

---

## User Flows

### Flow 1: Visitor books (US-1, US-2, US-4)

1. Visitor opens `/book`, picks a meeting type.
2. Page fetches availability and shows free slots in the visitor's timezone, naming the zone ("times shown in Europe/Paris").
3. Visitor picks a slot and enters name, email and an optional note (≤500 characters).
4. Server reserves quota and holds the slot for 2 hours. Site emails the visitor **Confirm** and **Decline** links.
5. Page says "Check your inbox to confirm. We're holding this slot for 2 hours."
6. Visitor clicks Confirm; from here it's the same as Flow 2, step 4. Google sends the invite, and the site sends a "Booked" email with the cancel link.

### Flow 2: Agent books (US-3, US-4)

1. Agent calls `list_meeting_types`, then `get_availability`.
2. Agent calls `book_meeting` with its person's name, email and a slot. Server reserves quota and holds the slot for 2 hours. It returns `pending_confirmation` and a booking ID.
3. Site emails the person: who it's with, the time in Europe/London and UTC, the note, and **Confirm** and **Decline** links.
4. Person clicks Confirm. Server re-checks the slot against live free/busy, other bookings and the 3-a-day limit, then creates the event. The confirm page says "Booked" (or "That slot was taken — book another" if the re-check fails). Site sends a "Booked" email with the cancel link.
5. Agent polls `get_booking_status` and sees `confirmed`, `declined` or `expired`.

### Flow 3: Guest cancels (US-5)

1. Guest clicks the cancel link in their confirmation email, sees the booking and a **Cancel meeting** button (a GET never changes state).
2. On POST, server deletes the event (Google notifies attendees) and marks the booking `cancelled`.

### Flow 4: Agent cancels (US-9)

- Pending hold: `cancel_booking` withdraws it at once, status `cancelled`, slot free.
- Confirmed booking: `cancel_booking` emails the guest a **Confirm cancellation** link and returns `cancellation_requested`; the booking stays `confirmed` until the link is used.

---

## Acceptance Criteria

### Functional

- [ ] **(US-1, US-2)** Two meeting types: Consultation (30 min) and Recruiter intro (15 min), read from `booking.json`.
- [ ] **(US-1)** Slots fall within 10:00–17:00 Europe/London on weekdays, start on the quarter hour, and end by 17:00.
- [ ] **(US-1)** No slot sooner than 24 hours from now or later than 4 weeks ahead.
- [ ] **(US-1, US-6)** A slot is offered only if the meeting plus 15 minutes before and after is free in every calendar with `blocks: true`, and no other booking or live hold overlaps it.
- [ ] **(US-1)** At most 3 confirmed meetings on any one Europe/London day. Holds don't count toward it, so fake holds can't fill a day; a confirm that would make a 4th is declined with reason `day_full`, and a full day offers no slots.
- [ ] **(US-1)** Times are stored in UTC and shown in the visitor's timezone with the zone named; agents get ISO 8601 with an offset.
- [ ] **(US-1)** Tests cover the clocks-back change on 25 Oct 2026: slots on 23, 26 and 27 Oct are at 10:00–17:00 London time (09:00–16:00 UTC before, 10:00–17:00 UTC after).
- [ ] **(US-1, US-4)** A page booking follows the same hold-and-confirm path as an agent booking: no event and no Google invite until the guest confirms from their inbox.
- [ ] **(US-6)** Events are organised by `hello@patrickjv.com`, invite Patrick and the guest, carry a Meet link, and have the meeting type in the title ("Consultation: <guest name>").
- [ ] **(US-6)** The site only ever calls free/busy on Patrick's calendars; it never reads event titles or details.
- [ ] **(US-3)** MCP and WebMCP both expose `list_meeting_types`, `get_availability`, `book_meeting`, `get_booking_status`, `cancel_booking` with the same names and schemas (the build fails if they drift, as it does today).
- [ ] **(US-4)** `book_meeting` and `POST /api/booking` create no event; they hold the slot for 2 hours and email Confirm/Decline links to the given address.
- [ ] **(US-4)** Confirm re-checks the slot against live free/busy and existing bookings before creating the event; if taken, the booking becomes `declined` with reason `slot_taken`.
- [ ] **(US-4)** A hold not confirmed within 2 hours becomes `expired` and stops blocking the slot.
- [ ] **(US-4, US-6)** If two bookings race for one slot, exactly one gets it (all writes go through one Durable Object).
- [ ] **(US-5, US-9)** Confirm, decline and cancel links carry a random 128-bit token, are single-use, and expire: confirm/decline when the hold expires, cancel at the meeting start.
- [ ] **(US-5)** Cancelling deletes the event with attendees notified and frees the slot.
- [ ] **(US-9)** `cancel_booking` on a pending hold withdraws it; on a confirmed booking it only sends a confirm-cancellation email.
- [ ] **(US-9)** `cancel_booking` and `get_booking_status` need the booking ID; booking IDs are random (128-bit), not sequential.
- [ ] **(US-7)** Meeting types, hours, rules and calendars come only from `booking.json`; the build validates it and fails on a bad file.
- [ ] **(US-8)** Daily caps: 4 booking requests per IP (same as `request_intro`, because hosted MCP clients share egress addresses), 2 per guest email, 10 in total, reserved atomically before any Google call or email, never refunded (fail closed).
- [ ] **(US-8)** One live hold at a time per IP and per guest email; a second request while one is pending gets 429 `hold_pending`, and the first can be withdrawn with `cancel_booking`.
- [ ] **(US-8)** When the global cap is reached, the page and tools say "Booking is closed for today" and Patrick gets one alert email (to `INTRO_TO_ADDRESS`, via the existing `send_email` binding) that day, so a cap exhausted by abuse doesn't go unnoticed.
- [ ] **(US-8)** The WAF flood rule covers the booking API path as well as `/mcp`.
- [ ] **(US-8)** `BOOKING_ENABLED=false` makes every booking-write path refuse and the page say booking is closed; read tools still work.

### Non-functional

- [ ] **Accessibility:** `/book` has 0 axe violations, Lighthouse accessibility 100, and the slot picker works by keyboard alone.
- [ ] **Performance:** Lighthouse performance stays 100 on `/book`; the page ships no framework.
- [ ] **Security:** no Google credential except the `hello@` refresh token (Worker secret); narrowest scopes that work (see Google setup). No state change on GET.
- [ ] **Privacy:** no PII in logs (same rule as `logFailure`); booking records deleted 30 days after the meeting, holds 30 days after expiry; the privacy line on the site says what's stored and for how long.
- [ ] **Observability:** `patrickjv/health` reports `bookingReady` (secrets set, token refresh works, DO reachable, flag on), and `npm run smoke` checks it.
- [ ] **Operations:** `docs/06-operations.md` has a runbook for re-authorising `hello@` (new refresh token, `wrangler secret put`, check `bookingReady`) and for switching mail provider. The existing 6-hourly monitor (`monitor.yml`) runs the smoke check, so a revoked token is noticed within 6 hours even when nobody books.
- [ ] **Copy:** public copy passes the AI-tells check and names no employer.

---

## Technical

### Where it runs

- **`/book` page:** static, built by `build.mjs` like the rest of the site. Calls the booking API with `fetch`.
- **Booking API and MCP tools:** the existing `patrickjv-mcp` Worker, with a second route `patrickjv.com/api/booking*`. Reusing it keeps one place for rate limits, salted quota keys, security headers and health. The static site stays code-free for ordinary page views.
- **State:** a new SQLite Durable Object class `BookingStore`, one instance (`idFromName("booking")`). It holds bookings, tokens and booking quotas, and handles every write. An alarm expires holds and prunes old records.
- **The race rule (proven by spike, 2026-10-08):** a Durable Object only serialises code up to the first `await` on anything outside its own storage. While it waits on Google, other requests run. In a local spike, 20 concurrent bookings that checked the slot, awaited a simulated Google call, then wrote, produced **13** confirmed bookings for one slot. So every booking and confirm must **claim before it awaits**: check the slot and write a `holding`/`confirming` row in the same synchronous block, with no `await` between them, and only then call Google. Afterwards, it settles or rolls back. The same spike with claim-first produced exactly **1**. A test fires concurrent requests at one slot and asserts one winner.
- **Email:** Cloudflare's `send_email` can only deliver to verified addresses, so it can't reach guests. Guest emails go out from `hello@patrickjv.com` through **Resend's free tier** (decided 2026-10-08, to keep the site on free plans), called with `fetch` from the Worker.
  - **Reuse the existing Resend account.** It already sends for the marine-weather forecasts from `marineweather.patrickjv.com` (Amazon SES eu-west-1, DKIM `resend._domainkey.marineweather`, MAIL FROM `send.marineweather`). The free plan allows 3 domains, so `patrickjv.com` is added as a second domain. No new vendor or account.
  - **Domain is the apex, `patrickjv.com`**, so the From address is `hello@patrickjv.com` and DKIM aligns with the apex DMARC policy. Resend's records don't clash with Email Routing: a DKIM TXT record at `resend._domainkey`, and two CNAMEs to Resend's own mail servers, `send` → `send.forge.rmta.net` and `rsend` → `rsend-euw1.forge.rmta.net`, which supply the bounce MX and SPF. The apex MX and SPF stay unchanged. (Domain added 2026-10-08, eu-west-1, open and click tracking off.)
  - **Separate API key** (`RESEND_API_KEY` Worker secret on `patrickjv-mcp`), with sending access only and limited to `patrickjv.com` if Resend allows that. It's not shared with the marine-weather Worker, so either can be revoked alone.
  - **Shared daily budget.** Treat the 100-a-day free limit as per account, because Resend doesn't say. Marine weather uses a few a day (two forecasts plus occasional alerts). Booking's caps (10 requests a day, about 20 emails at most) leave plenty of headroom. If Resend returns 429, the hold is released, as with any send failure.
  - Rejected: **Cloudflare Email Sending** needs Workers Paid ($5 a month) to send to arbitrary recipients; it isn't available on Free.

  Gmail API is **not** the path. A Google account made with a non-Gmail address appears to have no Gmail mailbox, and third-party reports show `Mail service not enabled`. All sending goes through one `sendGuestEmail()` function, so switching provider changes only that function and its secret (runbook in `docs/06-operations.md`). Volume is at most ~20 emails a day (caps), plain text, no tracking, one link per action. Replies to `hello@` go to Patrick through Email Routing. Before launch, add the provider's SPF/DKIM records to `patrickjv.com` and check that DMARC passes, especially if the planned DMARC tightening has gone live. Patrick's own alerts keep using `send_email`. Google Calendar sends the invites itself, so they don't depend on any of this.

### `booking.json` (repo root)

```jsonc
{
  "timezone": "Europe/London",
  "hours": { "days": ["mon", "tue", "wed", "thu", "fri"], "start": "10:00", "end": "17:00" },
  "slotStepMinutes": 15,
  "minNoticeHours": 24,
  "horizonDays": 28,
  "bufferMinutes": 15,
  "maxPerDay": 3,
  "holdHours": 2,
  "retentionDays": 30,
  "caps": { "perIpPerDay": 4, "perEmailPerDay": 2, "globalPerDay": 10, "liveHoldsPerKey": 1 },
  "meetingTypes": [
    { "id": "consultation", "title": "Consultation", "minutes": 30, "description": "..." },
    { "id": "recruiter-intro", "title": "Recruiter intro", "minutes": 15, "description": "..." }
  ],
  // Accounts and the calendars in each. Only blocks:true calendars are queried, and only those
  // need sharing (free/busy only) with hello@. IDs of personal calendars are secrets, not config:
  // "idSecret" names the Worker secret that holds the calendar ID.
  "calendars": [
    { "account": "personal", "label": "Main", "idSecret": "CAL_PERSONAL_MAIN", "blocks": true },
    { "account": "personal", "label": "Family", "idSecret": "CAL_PERSONAL_FAMILY", "blocks": true },
    { "account": "personal", "label": "Birthdays", "blocks": false },
    { "account": "hello", "label": "Bookings", "id": "primary", "blocks": true }
  ]
}
```

Calendar IDs for personal Gmail calendars are email addresses, so they go in Worker secrets, not in this public file. Events marked "Free" are expected not to block, and untimed tasks don't. But a task with a set time, marked Busy, shows as busy to others and **will** block. Both behaviours are inferred from Google's docs, not stated outright; the live spike checks them.

### Booking record (BookingStore, SQLite)

```sql
CREATE TABLE bookings (
  id            TEXT PRIMARY KEY,        -- 128-bit random, 32 lowercase hex; also the Google event ID
  type          TEXT NOT NULL,           -- meetingTypes[].id
  start_utc     TEXT NOT NULL,           -- ISO 8601, Z
  end_utc       TEXT NOT NULL,
  status        TEXT NOT NULL,           -- pending_confirmation | confirmed | declined | expired | cancelled
  status_reason TEXT,                    -- slot_taken | day_full | guest_declined | hold_expired | guest_cancelled | agent_withdrew
  source        TEXT NOT NULL,           -- page | mcp | webmcp
  guest_name    TEXT NOT NULL,
  guest_email   TEXT NOT NULL,
  note          TEXT,                    -- ≤500 chars, plain text
  event_id      TEXT,                    -- Google event ID once confirmed
  hold_expires  TEXT,                    -- for pending only
  created_at    TEXT NOT NULL,
  delete_after  TEXT NOT NULL            -- meeting end or hold expiry + retentionDays
);
CREATE TABLE tokens (
  hash        TEXT PRIMARY KEY,          -- SHA-256 of the token; the token itself is never stored
  booking_id  TEXT NOT NULL,
  action      TEXT NOT NULL,             -- confirm | decline | cancel | confirm_cancel
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE TABLE quota (day TEXT, kind TEXT, key TEXT, n INTEGER, PRIMARY KEY (day, kind, key));
```

Quota keys are HMACs of the IP (/64 for IPv6) and lower-cased email, using `QUOTA_SALT`, like `IntroQuota`.

### MCP / WebMCP tools

| Tool | Input | Output | Annotations |
|---|---|---|---|
| `list_meeting_types` | none | `[{id, title, minutes, description}]` | read-only |
| `get_availability` | `type`, optional `from`, `to` (ISO dates, clamped to the horizon) | `{timezone: "Europe/London", slots: [{start, end}]}` in ISO 8601 with offset | read-only |
| `book_meeting` | `type`, `start` (ISO 8601 with offset), `name` (1–100), `email` (≤254, ASCII), optional `note` (≤500) | `{booking_id, status: "pending_confirmation", hold_expires}` | not idempotent; description says only use when the person asked for it, and don't retry on error |
| `get_booking_status` | `booking_id` | `{status, status_reason?, start, end, type}` | read-only |
| `cancel_booking` | `booking_id` | `{status: "cancelled"}` for a hold, `{status: "confirmed", cancellation: "requested"}` for a confirmed booking | destructive |

`get_booking_status` doesn't return the guest's name or email: the booking ID is a bearer secret, but there's no need to leak the person's details to whoever holds it.

### HTTP API (`/api/booking`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/booking/types` | Meeting types |
| GET | `/api/booking/availability?type=&from=&to=` | Free slots |
| POST | `/api/booking` | Page booking: `{type, start, name, email, note?}` → `202 {booking_id, status: "pending_confirmation", hold_expires}` |
| GET | `/api/booking/act?t=<token>` | Shows what the token will do, with a button (no state change) |
| POST | `/api/booking/act` | `{t}` → performs confirm / decline / cancel / confirm-cancel |

The MCP tools call the same functions. Same Origin check, size caps, `RL_*` limits and security headers as `/mcp`; responses are JSON except the `act` pages, which are small HTML pages in the site's style.

**Errors:** 400 invalid input · 403 bad Origin · 404 unknown or used token · 409 slot no longer free · 410 token expired · 429 cap, rate limit or `hold_pending` · 503 `BOOKING_ENABLED=false`, Google unreachable, or not configured.

### Google setup (one-off, manual)

1. Create a free Google account using `hello@patrickjv.com` as its address ("use my current email address"). Mail to `hello@` is already routed by Cloudflare Email Routing, so verification arrives.
2. From each personal Gmail account, share each `blocks: true` calendar with `hello@patrickjv.com` as **"See only free/busy"**. Don't share the others.
3. In Google Cloud (project owned by `hello@`): enable the Calendar API, create an OAuth client (web), set the consent screen to **External** and **publish** it. In Testing mode refresh tokens expire after 7 days.
4. Authorise once as `hello@` with the scopes below; store the refresh token, client ID and client secret as Worker secrets (`GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
5. Scopes (confirmed in Google's API reference, 2026-10-08): `calendar.freebusy` for freebusy.query, and `calendar.events.owned` for events.insert/delete on calendars hello@ owns. No narrower scope works on the primary calendar. No Gmail scope, which also means a password change doesn't revoke the token. The unverified app shows a one-time warning on Patrick's own consent screen; check in the Cloud Console which scopes it marks sensitive.
6. Publishing status must be **In production**. In Testing, refresh tokens expire after 7 days. Unverified production apps are capped at 100 users, which is irrelevant here.
7. Once, at setup, read the calendar's `conferenceProperties.allowedConferenceSolutionTypes` and check it includes `hangoutsMeet`.

A service account isn't used. Google's events reference says service accounts need domain-wide delegation to add attendees, and that needs Workspace (confirmed 2026-10-08).

**Meet links:** create with `conferenceData.createRequest` (`hangoutsMeet`) and `conferenceDataVersion=1`. Creation is asynchronous, so the confirm step checks that `createRequest.status` is `success` (re-reading the event briefly if `pending`) before the "Booked" email includes the link. The Google invite carries the link either way.

### Resend setup (one-off, manual)

1. In the existing Resend account (the one marine weather uses), add the domain `patrickjv.com`, choosing the same region as `marineweather` (eu-west-1).
2. Add the records Resend shows in Cloudflare DNS, all DNS-only (not proxied): TXT `resend._domainkey`, CNAME `send`, CNAME `rsend`. Then run `npm run cf:export` and check the diff: the apex MX and SPF must be unchanged. DNS writes are blocked in auto mode, so Patrick adds these himself.
3. Create a new API key named `patrickjv-booking / patrickjv-mcp / send-only`, with sending access only and limited to `patrickjv.com` if offered, and store it with `wrangler secret put RESEND_API_KEY -c mcp/wrangler.jsonc`.
4. Send one test email to an outside address and check that SPF, DKIM and DMARC all pass in its headers. Do this again after the planned DMARC tightening.

### WAF

Extend the "MCP flood guard" expression to `starts_with(http.request.uri.path, "/mcp") or starts_with(http.request.uri.path, "/api/booking")`. Rulesets writes are blocked in auto mode, so this is a manual step. The entrypoint PUT takes only `{rules}`.

---

## Edge Cases & Error Handling

- **Google down or token revoked:** availability returns 503 and the page says "Booking is unavailable right now"; no slots are guessed. Confirm fails with 503 and leaves the hold in place until it expires, so the person can retry the link. `bookingReady` goes false and smoke fails.
- **Free/busy changes between listing and booking:** every booking and confirm re-checks live free/busy inside the Durable Object before writing.
- **Event created, DB write fails (or the reverse):** the DO writes the record as `confirming`-locked first, creates the event, then sets `confirmed` with `event_id`. If the event call fails, it rolls back to `pending_confirmation`. If the DO write after the event fails, the event's Google ID **is** the booking ID (32 lowercase hex characters, a subset of Google's base32hex rule: a–v, 0–9, 5–1024 characters). A retry gets `409 duplicate`, treated as "already created". Booking IDs are random and never reused, so a deleted event's leftover cancelled record never collides. Google says it can't guarantee to detect collisions at insert time, so the claim-first rule above is the real guard, and the 409 is a backstop.
- **Clocks change:** slots are generated in Europe/London local time and converted to UTC per day, never by adding fixed offsets. 29 Mar 2027 (clocks forward) is covered by the same tests.
- **Visitor's timezone unknown or odd** (e.g. +05:45, +14:00): the page uses `Intl` and names the zone; if unavailable it falls back to Europe/London and says so.
- **Slot just inside the notice window** at confirm time: a hold made with 25 hours' notice and confirmed 1h59 later still has 23 hours' notice. Confirm doesn't re-apply the notice rule, only free/busy and overlap.
- **Same person books twice:** allowed up to the per-email cap; different slots only.
- **Guest declines the Google invite:** the event stays in the calendar with the guest's "no"; the site isn't told. Patrick deletes it if he wants the time back (Non-goal: sync).
- **Link clicked twice, or after use:** 404 page "This link has already been used"; no second action.
- **Mail scanners prefetch links:** GET only shows a button; the action needs POST, so prefetching can't confirm or cancel anything.
- **Email to the guest fails** (provider error or quota): the hold is released at once and the request returns 503; nothing was booked. The failure is logged by subsystem only. Repeated failures make `bookingReady` false.
- **Refresh token revoked** (access removed, Google security check, unused for 6 months, or more than 100 tokens issued for this client, when Google silently drops the oldest. Password changes don't revoke it, because there's no Gmail scope). The 6-hourly health check refreshes the token, so it is never unused for 6 months: token refresh fails, `bookingReady` goes false, the page says booking is unavailable, and the next 6-hourly monitor run fails. Fix: the re-auth runbook.
- **Caps used up by abuse:** booking closes for the day for everyone (fail closed, by design). Patrick gets one alert; the WAF rule and one-live-hold rule make this cost an attacker several IPs and addresses.
- **Kill switch on with holds outstanding:** confirm links still work for holds made before; new bookings are refused.
- **Daily cap reached:** 429 with "Try again tomorrow"; agents are told not to retry.
- **Note contains HTML or links:** stored and shown as plain text, escaped everywhere, never rendered as HTML.
- **Config error** (overlapping hours, unknown calendar secret): the build fails; at runtime a missing secret makes `bookingReady` false and booking refuse.

---

## Rescheduling (planned, v2)

A guest or agent asks to move a confirmed booking to another free slot. It reuses request-then-confirm: the new slot is held, the guest gets a "Confirm new time" link, and only on click is the event moved (Google `events.patch`, attendees notified). Until then the old time stands. Tools: `reschedule_booking(booking_id, start)`. Out of v1 to keep the first release small.

## Planned follow-up: work calendar as a busy source

Add a work calendar as a blocking calendar through its published free/busy-only ICS link.

- Config entry `{ "account": "work", "label": "Work calendar (ICS)", "icsSecret": "ICS_WORK", "blocks": true }`; the URL is a Worker secret, fetched with a short cache (a few minutes) and parsed for busy intervals only.
- **Caveats:** the organisation's external-publishing policy may block publishing, and turning it on is that organisation's policy decision, to be made deliberately. How long Outlook takes to update a published calendar is unknown; measure it before relying on it.
- **Rejected:** subscribing to the ICS from Gmail (Google refreshes subscriptions only every few hours); Microsoft Graph (would put company credentials in a personal app).
- This public repo and site never name the employer; config and docs say "work calendar (ICS)".

---

## Open Questions

- [ ] **Live Google spike** (after `hello@` exists): freebusy.query on a calendar shared as free/busy only; a Free event and a timed Busy task each in the result or not; events.insert with a hex ID, attendees and a Meet link; a repeat insert returns 409; guests get the invite. Before build.

### Resolved (devil's-advocate pass, 2026-10-08)

- **Guest email path:** Resend free tier, reusing the marine-weather account with `patrickjv.com` added as a second domain and its own API key, behind one function. Not Gmail; not Cloudflare Email Sending (needs Workers Paid).
- **Page bookings:** confirm by email like agent bookings; one path for both.
- **Caps as a denial of service:** holds don't count toward 3-a-day; one live hold per IP and per email; Patrick alerted when the global cap is hit.
- **Per-IP cap:** 4, matching `request_intro`.
- **Spikes (2026-10-08):** Europe/London slot generation using only `Intl` passes both clock changes (23/26/27 Oct 2026, 26/29 Mar 2027). Race: claim-before-await is required (13 winners without it, 1 with it). Scopes, the service-account limit and event-ID rules confirmed from Google's API reference.
- **Single token:** re-auth runbook, plus `bookingReady` in the 6-hourly monitor.

---

## References

- Existing pattern: `mcp/handler.js` (`request_intro`, `IntroQuota`, `patrickjv/health`), `mcp/wrangler.jsonc`
- [`../04-mcp-and-webmcp.md`](../04-mcp-and-webmcp.md), [`../06-operations.md`](../06-operations.md)
- Google Calendar API: freebusy.query, events.insert (`conferenceData`, `sendUpdates=all`)
