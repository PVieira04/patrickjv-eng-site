# F-001 spikes: evidence for the booking spec

> **Purpose:** Record what was checked before building [F-001](../F-001-booking.md), how it was checked, what came back, and what it changed in the spec. Any claim the spec makes about a platform should trace back to a row here.
> **Update when:** A spike is re-run, a pending spike runs, or a platform changes behaviour. Add the date; don't overwrite old results.

Three kinds of evidence, in falling order of strength:

- **Run:** code in this folder, executed; output recorded below.
- **Docs:** checked against the vendor's own documentation on the date given, with the source. Weaker: docs can be wrong or vague, and are re-checked by a run where one is planned.
- **Pending:** needs an account or setup that doesn't exist yet.

## Summary

| # | Question | Evidence | Result | Spec change |
|---|---|---|---|---|
| S1 | Can a Worker generate Europe/London slots across clock changes with no library? | Run | ✅ Yes | None needed |
| S2 | Does "all writes go through one Durable Object" prevent double booking? | Run | ❌ **Not on its own**: 13 and 5 winners for one slot | Claim-before-await rule |
| S3 | Which Google OAuth scopes, and does the refresh token last? | Docs | ✅ `calendar.freebusy` + `calendar.events.owned`; app must be In production | Scopes and setup steps |
| S4 | Can a service account create events with guests? | Docs | ❌ Not on a consumer account | OAuth only |
| S5 | Can the booking ID double as the Google event ID? | Docs | ⚠️ Not as base64url | IDs are 32 hex characters |
| S6 | Meet links for a consumer organiser | Docs | ✅ Yes, created asynchronously | Confirm step waits for `success` |
| S7 | What blocks time in free/busy? | Docs | ⚠️ Timed Busy tasks **do** block; Free events probably don't | Spec corrected; live check in S11 |
| S8 | Can `hello@` send guest emails through Gmail? | Docs (secondary) | ❌ Account has no Gmail | Use a mail service |
| S9 | Which mail service, on free plans? | Docs + account | ✅ Existing Resend account, second domain | Resend setup section |
| S10 | Resend domain `patrickjv.com` verified | Run (DNS) + account | ✅ Verified 2026-10-08 | — |
| S11 | Live Google behaviour end to end | Pending | ⏳ Needs the `hello@` account | — |

---

## S1: Europe/London slots using only `Intl`

**Assumption in the spec:** slots are 10:00–17:00 London time, stored in UTC, correct across the clock changes, with no date library (Workers have `Intl` and the full tz database).

**Method:** [`tz-slots.mjs`](tz-slots.mjs) converts London wall-clock times to UTC with two passes of `Intl.DateTimeFormat` offset lookups, generates 30-minute slots on a 15-minute step, and checks the first and last slot on days either side of both changes. Run: `node docs/specs/F-001-spikes/tz-slots.mjs` (Node 24).

**Result (2026-10-08): all pass.**

| Day | Clock | First slot (UTC) | Last slot (UTC) | Slots |
|---|---|---|---|---|
| Fri 23 Oct 2026 | BST | 09:00 | 15:30 | 27 |
| Mon 26 Oct 2026 | GMT (day after clocks back) | 10:00 | 16:30 | 27 |
| Tue 27 Oct 2026 | GMT | 10:00 | 16:30 | 27 |
| Fri 26 Mar 2027 | GMT | 10:00 | 16:30 | 27 |
| Mon 29 Mar 2027 | BST (day after clocks forward) | 09:00 | 15:30 | 27 |

Display checks from the same run: a Paris visitor sees "Monday, 26 October 2026 at 11:00 (Europe/Paris)"; a Kathmandu visitor sees "15:45:00 GMT+5:45"; an agent gets `2026-10-26T10:00:00+00:00`.

**Spec change:** none. The build's tests should reuse these cases.

## S2: Race for one slot in a Durable Object

**Assumption in the spec (before):** "serialise in a Durable Object" means exactly one of two racing bookings wins.

**Why it was doubtful:** a Durable Object runs one request at a time only until that request awaits something outside its own storage. While it waits on an outgoing call (here, Google), other requests run.

**Method:** [`race/`](race/) is a minimal Worker with a SQLite Durable Object and two booking methods. Both stand in for Google with a 30 ms wait.

- `naive`: check the slot is free → await "Google" → write `confirmed`.
- `safe`: check and write a `confirming` row in one synchronous block (no `await` between) → await "Google" → set `confirmed`.

[`race/run.sh`](race/run.sh) starts it under local `wrangler dev`, fires 20 concurrent requests at one slot in each mode, and counts confirmed bookings. Run: `bash docs/specs/F-001-spikes/race/run.sh`.

**Result:**

| Run | naive | safe |
|---|---|---|
| 2026-10-08, first | **13** | 1 |
| 2026-10-08, second | **5** | 1 |

The naive count varies with timing; any number above 1 is a double booking.

**Spec change:** the Technical section now states the claim-before-await rule, and an acceptance criterion requires a concurrency test asserting one winner. The `confirming` state in the recovery edge case is what makes the rule work.

**Limit:** this ran on local `workerd`, not on Cloudflare. Durable Object input/output gates behave the same in both, but the build's concurrency test is the lasting guard.

## S3–S8: Google, from documentation

Checked 2026-10-08 against Google's own documentation unless marked otherwise.

| # | Finding | Source |
|---|---|---|
| S3 | freebusy.query accepts `calendar.freebusy` ("View your availability in your calendars"). events.insert accepts `calendar.events.owned` ("See, create, change, and delete events on Google calendars you own"); nothing narrower works on the primary calendar (`calendar.app.created` covers only secondary calendars the app creates). | developers.google.com/workspace/calendar/api/v3/reference/freebusy/query, …/events/insert, …/calendar/api/auth |
| S3 | Refresh tokens: "a publishing status of 'Testing' is issued a refresh token expiring in 7 days". Production tokens die if revoked, unused for 6 months, on a password change *only if Gmail scopes are granted*, or when more than 100 are issued for one client and account (the oldest is dropped silently). An unverified production app works behind a warning, up to 100 users. | developers.google.com/identity/protocols/oauth2; support.google.com/cloud/answer/7454865 |
| S4 | "Service accounts need to use domain-wide delegation of authority to populate the attendee list." Domain-wide delegation needs Workspace. | …/calendar/api/v3/reference/events |
| S5 | Event IDs: "lowercase letters a-v and digits 0-9", "between 5 and 1024 characters", "unique per calendar". A duplicate returns `409 duplicate`, but "we cannot guarantee that ID collisions will be detected at event creation time." Deleted events remain as cancelled records. | …/calendar/api/v3/reference/events/insert |
| S6 | Meet: `conferenceSolutionKey.type` `hangoutsMeet` with `conferenceDataVersion=1`. Creation is asynchronous (`createRequest.status`). Meet supports meetings organised by personal accounts. | …/calendar/api/guides/create-events; support.google.com/meet/answer/9302870 |
| S7 | A `transparent` (Free) event "does not block time on the calendar"; the freebusy page doesn't say outright that such events are left out. A task with a set time can be marked Busy and then shows to others as busy. At most 50 calendars per query. | …/v3/reference/events; support.google.com/calendar/answer/34580 |
| S8 | "You don't need to have a Gmail address to create a Google Account." Adding Gmail later changes the account's username to a new @gmail.com address. Third-party reports (not Google) show the Gmail API returning `Mail service not enabled` for such accounts. | support.google.com/accounts/answer/27441, …/answer/76194 |
| — | No published limits on calendar invites from consumer accounts (Workspace's are about 10,000 external invitations "in a short period"). Not a concern at this volume. | knowledge.workspace.google.com/admin/calendar/avoid-calendar-use-limits |

**Spec changes:** scopes and publishing status in "Google setup"; no service account; booking IDs are 32 lowercase hex characters and are also the Google event IDs (a 409 means "already created", with claim-before-await as the real guard); the confirm step waits for the Meet link; the free/busy note corrected for timed tasks; guest email moved off Gmail.

## S9–S10: Guest email

**Cloudflare Email Sending** (checked 2026-10-08): public beta since 16 April 2026, same `send_email` binding. "Sending to arbitrary recipients requires the Workers Paid plan"; it isn't available on Free. Source: developers.cloudflare.com/email-service/platform/pricing/. **Rejected**, to stay on free plans.

**Resend** (resend.com/pricing, 2026-10-08): free plan "100 emails a day, 3 domains", 3,000 a month. Whether the daily limit is shared across domains isn't stated; the spec assumes it is.

**Existing account:** the marine-weather project already sends through Resend from `marineweather.patrickjv.com` (eu-west-1). `patrickjv.com` was added to the same account on 2026-10-08 as its second domain, region eu-west-1, open and click tracking off.

**S10, DNS check (2026-10-08, ~15:30–16:00 UTC):** all three records Resend asks for resolve with the exact values from its API, on both Cloudflare's (1.1.1.1) and Google's (8.8.8.8) public resolvers:

| Record | Value | Resend status |
|---|---|---|
| TXT `resend._domainkey` | DKIM key ending `…IwIDAQAB` (1024-bit) | pending |
| CNAME `rsend` | `rsend-euw1.forge.rmta.net` (→ Amazon SES eu-west-1 MX and SPF) | pending |
| CNAME `send` | `send.forge.rmta.net` | not_started |

Apex MX and SPF unchanged (Cloudflare Email Routing, `-all`). The zone has no DNSSEC trust chain yet (DS record not at the registrar), so there's nothing that could make lookups fail.

**Status:** **verified** on 2026-10-08, the same afternoon, within a few hours of the records going live. A send-only API key, `patrickjv-booking / patrickjv-mcp / send-only`, was created for the booking Worker.

## S11: Live Google spike (pending)

**Why:** S3–S7 rest on documentation, and S7 is partly inferred. This run proves them against real accounts.

**Needs:** the `hello@patrickjv.com` Google account, a published OAuth app with the redirect URI `http://localhost:8765/callback`, one personal calendar shared with `hello@` as "See only free/busy", and on that calendar on a test day: a normal event at 10:00, an event marked Free at 12:00, and a timed task marked Busy at 14:00.

**Method:**

1. [`google/get-token.mjs`](google/get-token.mjs) runs the consent once as `hello@` and prints the granted scopes and a refresh token. Run in a private terminal; the token is a secret.
2. [`google/spike.mjs`](google/spike.mjs) checks:
   - token refresh
   - free/busy on the shared calendar
   - which of the three test items block time
   - events.insert with a hex ID, a guest and a Meet link (waiting for the link)
   - that a repeat insert returns 409
   - deleting with guests notified
   - re-inserting a deleted ID

   It pauses 60 seconds so the guest inbox can be checked for the invite.

**Pass:** everything PASS; the INFO lines recorded here; the invite arrives from `hello@` with a Meet link and without showing Patrick's personal address.

**Result:** not run yet.
