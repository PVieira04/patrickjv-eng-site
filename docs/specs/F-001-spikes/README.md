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
| S7 | What blocks time in free/busy? | Docs, then Run (S11) | ✅ Normal events block; Free events and timed tasks don't | Spec corrected after S11 |
| S8 | Can `hello@` send guest emails through Gmail? | Docs (secondary) | ❌ Account has no Gmail | Use a mail service |
| S9 | Which mail service, on free plans? | Docs + account | ✅ Existing Resend account, second domain | Resend setup section |
| S10 | Resend domain `patrickjv.com` verified | Run (DNS) + account | ✅ Verified 2026-10-08 | — |
| S11 | Live Google behaviour end to end | Run | ✅ All pass | Exact calendar IDs; `/privacy` needed to publish |

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
| S3 | **Console, 2026-10-08 (hello@'s project):** `calendar.freebusy` is listed as **non-sensitive**, `calendar.events.owned` as **sensitive**, and there are no restricted scopes. So the unverified-app warning comes from `events.owned` alone, and no security assessment is needed (that applies only to restricted scopes). | Google Cloud Console → Google Auth Platform → Data Access |
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

## S11: Live Google spike

**Why:** S3–S7 rest on documentation, and S7 is partly inferred. This run proves them against real accounts.

**Needs:** the `hello@patrickjv.com` Google account, a published OAuth app with the redirect URI `http://localhost:8765/callback`, one personal calendar shared with `hello@` as "See only free/busy", and on that calendar on a test day: a normal event at 10:00, an event marked Free at 12:00, and a timed task marked Busy at 14:00.

**Method:**

Both scripts read the OAuth client from the JSON downloaded from Google Cloud (`GOOGLE_CLIENT_FILE`, via [`google/client.mjs`](google/client.mjs)), so the client secret is never typed, pasted or printed.

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

**Result (2026-10-08, third run; OAuth app in Testing, `hello@` as a test user):**

```
PASS token refresh: scopes: …/calendar.events.owned …/calendar.freebusy
PASS freebusy on shared calendar: 2 busy blocks
   busy 10:00–10:30
   busy 18:00–00:00            (an unrelated evening item already on that calendar)
PASS normal event at 10:00 blocks
PASS 'Free' event at 12:00 does NOT block
INFO timed Busy task at 14:00: does not block
PASS events.insert with hex id + attendee
PASS Meet link created: success
PASS repeat insert returns 409
PASS delete with sendUpdates=all: 204
INFO re-insert of a deleted id: 409
ALL PASS
```

Checked by hand in the guest inbox: the invite arrived, its organiser shows as "Patrick, hello@patrickjv.com" (the personal address isn't visible), and it has a working "Join with Google Meet" link. The delete returned 204; arrival of the cancellation email wasn't checked.

**Findings beyond pass/fail:**

- **Timed tasks don't block.** The 14:00 task was created with a time set and default settings. Google's help suggests a task can be set to show as Busy; that variant wasn't tested. The spec now says tasks don't block by default.
- **Calendar IDs must be exact.** The first run used the `@gmail.com` spelling and got `notFound`; the calendar's real ID is `…@googlemail.com` (an older UK account). The second run, with the right ID, worked. The `CAL_PERSONAL_*` secrets must be copied from Settings → Integrate calendar.
- **Sharing free/busy only is enough.** No other access, and `hello@` didn't have to accept or add the calendar.
- **Publishing needs a privacy policy URL.** In Testing, sign-in is blocked (`Error 403: access_denied`) unless the account is on the test-user list, even for the project's owner. "Publish app" stays disabled until Branding has a home page **and a privacy policy URL**, and the site has no privacy page. The spec now requires `/privacy`, plus a publish order.
- **Scope classification** (Console): `calendar.freebusy` non-sensitive, `calendar.events.owned` sensitive, none restricted.
- **The spike's first version passed a check on missing data:** with free/busy failing, "Free event doesn't block" passed vacuously. `spike.mjs` now skips the blocking checks when free/busy returns an error.

**The Testing refresh token** was shown in a chat transcript during the spike. It must be revoked (`POST https://oauth2.googleapis.com/revoke`). The production token is created fresh once the app is published.

## Launch checks (8 Oct 2026)

After booking was switched on, these were checked on the live site:

- **`/book`:** a booking made from a phone went through end to end.
- **MCP:** `list_meeting_types`, `get_availability`, `book_meeting` and `get_booking_status` were called against `https://patrickjv.com/mcp`. The guest confirmed from their inbox, and the status read `confirmed`.
- **The guest's Google invite:**
  - organiser "Patrick, hello@patrickjv.com";
  - guest list "hidden at organizer's request", so `guestsCanSeeOtherGuests: false` works and Patrick's personal address isn't shown;
  - a working Meet link;
  - the note shown as plain text.
- **Agent cancellation:** `cancel_booking` over MCP on the confirmed meeting returned `cancellation: requested` and left it `confirmed`. Once the guest used the emailed "Confirm cancellation" link, the status read `cancelled` (`guest_cancelled`) and all 27 Tuesday slots were free again.
- **WebMCP:** the live homepage was loaded in headless Chromium with a recording stand-in for `document.modelContext`. All ten tools registered once `/api/booking/types` reported `enabled`, and the read and status tools returned live data. This covers the page script and the API, not Chrome's own experimental WebMCP.
- **Found and fixed:**
  - `hold_expires` had a fractional offset (`+00:59.997…`) because of milliseconds. Fixed in #5.
  - The invite read "1pm (Coordinated Universal Time)" for 14:00 BST. Events now carry `timeZone: Europe/London`. Fixed in #6.

## F-002 research (2026-10-09)

Two read-only investigations for [F-002](../F-002-signed-in-agent-booking.md), checked against official docs that day.

**Outcome (rewrite, 2026-10-09):** F-002 dropped the OAuth-server route for P1. Sign-in now confirms each booking, and the site is only a Google sign-in client (F-002 D2). The findings below are kept as the evidence for that decision, and for the optional OAuth phase (P3).

**Design investigation:**

- **MCP version:** the current MCP revision is **2026-07-28**. It deprecates Dynamic Client Registration in favour of Client ID Metadata Documents (CIMD), and adds a multi-round-trip mechanism through which a stateless server can use elicitation.
- **Optional auth:** authorisation is optional in the spec, and `tools/list` may vary by authorisation. Claude documents "lazy auth": a 401 with `WWW-Authenticate` on a tool call shows a Connect card, then retries the call.
- **Library:** `@cloudflare/workers-oauth-provider` 1.2.3 has a split authorisation-server API. It can sit beside the existing stateless handler, with token validation done in `handle()`. Its `OAuthProvider` wrapper would 401 every anonymous request. It needs a KV namespace; the Free plan allows 1,000 writes a day.
- **Client support:** Claude (web, desktop and mobile) supports CIMD with the full flow, and Claude Code supports OAuth via `/mcp`. ChatGPT needs per-tool `securitySchemes` to prompt mid-session. VS Code supports CIMD. Cursor's CIMD support and mid-session prompts are unverified.

**Google project spike:**

- **The 100-user cap** for unverified apps counts only users granting unapproved sensitive or restricted scopes, and it applies per project for the project's lifetime.
- **The "unverified app" warning** follows the scopes requested, so `openid email profile` alone shouldn't trigger it, even in a mixed project. That last part is inferred, not stated by Google.
- **Branding:** branding and publishing status are per project. Brand verification (needed to show a name or logo) is automated, and works for basic-scope-only apps.
- **Decision (D4):** a separate project for visitor sign-in, to keep its branding and risk apart from the calendar token's project.

**KV write spike** (read from the source of `@cloudflare/workers-oauth-provider` 1.2.3; Cloudflare pricing and limits pages):

- **Free plan allowances:** 1,000 writes, 1,000 deletes and 1,000 lists a day, each counted separately, plus 100,000 reads. They reset at 00:00 UTC, with at most 1 write per second per key.
- **Cost per operation:**
  - full sign-in: about 5 writes, 2 deletes and 1 list
  - each refresh: 2 writes, and the refresh token rotates
  - each token check: 1 read
  - Client ID Metadata Documents are cached in the Cache API, not in KV
- **Gap: the consent page writes before the person acts.** Showing it creates a KV transaction, so anonymous GETs of `/oauth/authorize` could use up the day's writes. Fixed by D8.
- **Gap: refresh tokens can be replayed.** After a refresh, the previous refresh token stays valid and reusing it re-arms it. Fixed by D7: no refresh tokens.
- **No pluggable storage:** `OAUTH_KV` is hard-coded in the library.

**ChatGPT spike:**

- **Registration:** CIMD is supported (`client_id` `https://chatgpt.com/oauth/client.json`, redirect `https://chatgpt.com/connector_platform_oauth_redirect`). The authorisation server must advertise S256 and `none`, and copy `resource` into the token's audience.
- **Sign-in prompt:** ChatGPT shows its sign-in UI only when the tool declares per-tool `securitySchemes` and a call returns a tool error with `_meta["mcp/www_authenticate"]`. An HTTP 401 isn't documented as triggering it.
- **Plans:** write-capable MCP is in beta for Business, Enterprise and Edu workspaces on the web, enabled by an admin.
- **Outcome:** ChatGPT moved to P3 (F-002 D2).

Sources: developers.openai.com/apps-sdk/build/auth and /apps-sdk/reference. The other sources are listed in F-002's References.
