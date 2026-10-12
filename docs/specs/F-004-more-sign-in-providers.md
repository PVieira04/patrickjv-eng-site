# Feature Spec: Sign in with Microsoft or Altimist ID to confirm

> **Purpose:** F-002 P2. Let people confirm (and cancel) a booking by signing in with Microsoft or Altimist ID as well as Google, through F-002's existing confirm page and booking core.
> **Update when:** Requirements shift, acceptance criteria change, or scope moves during the build.
> **Related:** [F-002](F-002-signed-in-agent-booking.md) (P1, shipped; this is its P2), [F-001](F-001-booking.md), [`../06-operations.md`](../06-operations.md).

---

## Metadata

| Field | Value |
|---|---|
| Spec ID | F-004 |
| Status | Draft |
| Owner | @PVieira04 |
| Created | 2026-10-12 |
| Depends on | F-002 P1 (live since 9 Oct 2026); an Entra app registration with a verified publisher; an Altimist ID client registration |

---

## Summary

F-002 made signing in with Google the way a booking is confirmed. People without a Google account, or whose company runs on Microsoft 365, are left with `/book`'s email form, and their agents can't book for them at all. F-004 adds **Sign in with Microsoft** (work, school and personal accounts) and **Sign in with Altimist ID** as more buttons on the same confirm page. Each provider's only job is to produce F-002's `person` and `grant`; the booking core, caps, failure rules and cancellation stay as they are.

MCP URL-mode elicitation, which F-002 listed under P2, is **out of scope**: the protocol changed it in 2026-07-28 and the major clients don't reliably support it yet (research, 9 Oct 2026). The confirm link stays in the tool result.

---

## User Stories

### US-1: Confirm with my Microsoft account

As **a person whose work email runs on Microsoft 365, or who has an Outlook.com account**, I want **to confirm the booking my agent made by signing in with Microsoft**, so that **I don't need a Google account**.

### US-2: Confirm with Altimist ID

As **a person with an Altimist ID**, I want **to confirm with it, or create one on the way**, so that **I can use the passkey I already have**.

### US-3: Cancel with the account I booked with

As **a guest**, I want **cancelling to accept the same account I confirmed with**, so that **the provider I chose doesn't matter later**.

### US-4: Only offered what works

As **a person on the confirm page**, I want **to see only the sign-in options that are switched on and set up**, so that **I don't hit a button that can't work**.

---

## Goals & Non-Goals

**Goals**
- Microsoft and Altimist ID confirm and cancel exactly as Google does in F-002, through `confirmRequest` and `cancelMeeting`.
- The address used for the invite is one the provider stands behind (rules per provider, D3–D4).
- A provider is offered only when it's launched and its secrets are set; launching one is a config change, not a code change.
- Cost stays at £0.

**Non-Goals**
- MCP URL-mode elicitation (see Summary).
- Linking accounts: a person who signs in with Google one day and Microsoft the next counts as two people for the per-person caps. Accepted: the caps exist to bound abuse, and the daily and global caps still apply.
- Agents signing in with their own identity (F-002 P4).
- Retiring the email form (F-002 P3).
- Microsoft Graph or any scope beyond sign-in.

---

## Decisions (2026-10-12, with Patrick)

| # | Decision | Alternatives rejected |
|---|---|---|
| D1 | **Microsoft and Altimist ID in this phase; URL elicitation deferred.** | Elicitation now: no client can use it yet, and the spec just changed. |
| D2 | **One provider table, F-002's flow unchanged.** Each provider is an entry with its endpoints, client secret names, scopes and a `claims → {person} \| {error}` function. The start (`POST /book/confirm/{provider}`), the callback (`GET /book/callback/{provider}`), `signin_tx`, the cookie, PKCE, `state` and `nonce` handling are shared and bound to the provider (a transaction started for one provider can't complete on another's callback). ID tokens come from each provider's token endpoint over TLS, server to server, so signatures aren't checked (OIDC Core 3.1.3.7), as for Google. | A copy of the flow per provider: three places to keep a security fix in step. |
| D3 | **Microsoft: one multi-tenant app with personal accounts** (`signInAudience = AzureADandPersonalMicrosoftAccount`, `/common/v2.0` endpoints), scopes `openid profile email`, optional ID-token claims `email` and `xms_edov`, and `removeUnverifiedEmailClaim = true` set on the app. **Key:** `provider: "microsoft"`, `subject: <tid>:<oid>` (Microsoft: `tid` must be part of the key; never key on email, `upn` or `preferred_username`). **Address:** the `email` claim, accepted only if `xms_edov` is `true`, or the account is a personal Microsoft account (`tid` = `9188040d-6c67-4c5b-b112-36a304b66dad`), whose addresses Microsoft treats as verified. Otherwise refused (see Functional). **The assurance is weaker than a mailbox check and accepted as such:** for work and school accounts, `xms_edov` means the organisation that verified the address's domain asserts this account has the address; nobody proved the mailbox at sign-in. That's the same trust F-002 gives a Workspace address with a matching `hd`. For personal accounts, Microsoft verified the address when the account was made, as Google does for non-Gmail accounts (F-002 D9). The "Booked" email to the address remains the backstop. **Issuer:** `tid` is a GUID and `iss` equals exactly `https://login.microsoftonline.com/<tid>/v2.0`. **Credential:** a client secret (a Worker secret), as for Google. | `organizations` or `consumers` only: leaves out half the people this is for. Keying on `sub`: also valid, but `tid`+`oid` is Microsoft's own recommendation and stays the same if we ever add a second app. A certificate credential: more code and a private key to manage, for a sign-in-only app. |
| D4 | **Altimist ID: trust its address.** Altimist ID proves an address with a one-time code at sign-up, so its `email` is treated as verified, as D9 of F-002 treats any address Google has verified. Its tokens carry no `email_verified` claim today; **if one appears, it must be `true`**. **Key:** `provider: "altimist"`, `subject: <sub>`. **Name:** `given_name` and `family_name` joined, else the part of the address before `@` (Altimist ID can return empty names). **Issuer:** exactly `https://altimist.id`. | Waiting for Altimist ID to emit `email_verified` and `name`: holds this phase on work elsewhere for no real gain in assurance. |
| D5 | **Publisher verification before Microsoft goes live.** Some organisations let staff approve only apps from verified publishers; unverified, their users get "needs admin approval". The Microsoft button is switched on only after the publisher is verified. The site serves `/.well-known/microsoft-identity-association.json` with the app's ID, which publisher-domain verification for `patrickjv.com` needs. | Launching unverified: some company users blocked at first sight of the button. |
| D6 | **The Microsoft secret's expiry is guarded like `security.txt`.** Its expiry date lives in `booking.json` (`signin.microsoftSecretExpires`, `YYYY-MM-DD`). Whenever `microsoft` is a launched provider (D7), the build fails if the date is missing or malformed, and from 30 days before it, as for `security.txt`'s `Expires`. When Microsoft isn't launched the value is ignored. Rotation is a runbook entry. | Remembering: a sign-in that silently stops working when the secret lapses. |
| D7 | **Launched in config, offered when ready.** `booking.json` lists the **launched** providers (`signin.providers`, default `["google"]`). **Validation** (build and Worker start, as for the rest of `booking.json`): the list must be non-empty, start with `"google"`, contain only `google`, `microsoft` and `altimist`, and have no duplicates; anything else fails the build (tested for each case). **Trial:** `signin.trial` (an array, default `[]`; only `microsoft` or `altimist`, no duplicates, none also in `signin.providers`, else the build fails, tested for each case) lists providers that aren't launched but may be started directly for manual checks: `POST /book/confirm/<provider>` works for them when ready, but they get no button and appear in no general copy or `signin_providers`. **Exceptions, where the person is already using that provider:** the confirm page opened with `&try=<provider>` shows that provider's button (and, for Altimist ID, the "Create one" link) in its place in the fixed order, so the manual checks exercise the real page; a booking made with a trial provider is named as such on its cancel page and in `cancel_booking`'s `next_step`; failure messages about it name it; and the privacy page names every enabled provider because a trial sign-in still sends data to it. `try=` for a provider that isn't on trial is ignored (tested). A provider can't be in both lists (build fails). Launched and trial providers together are the **enabled** ones. The list's order doesn't matter: providers are always shown and named in the fixed order Google, Microsoft, Altimist ID. The static copy (the booking guide everywhere it's published, `/book.md`, `llms.txt`) names the launched providers, built from that list, so a short outage never changes published text. **Callbacks:** a transaction started while a provider was ready may complete if, at the callback, the provider is still enabled (launched or on trial) and its secrets are still set (the code exchange itself shows whether it's reachable); otherwise the callback is refused, `state` is consumed, and the request and ticket are unchanged (tested: secrets removed mid-flow; provider removed from both lists mid-flow; a trial provider's sign-in completes and books, and cancels). At runtime a launched provider is **ready** when its client ID and secret are set, which is exactly how F-002 gates Google today (request admission and sign-in start check the secrets, not reachability), and buttons appear only for ready ones. Reachability of each provider's discovery document is reported by health and checked by the smoke test, as F-002 does for Google, but doesn't hide buttons or refuse requests: an unreachable provider shows up as a failed code exchange, handled as F-002 handles it. The Worker-rendered surfaces (the confirm page, `initialize`, `get_booking_guide`) read the same `booking.json`, so the guide text is identical everywhere. `/book` and the homepage's WebMCP are static pages, so they get the ready list from `GET /api/booking/types`, which gains `signin_providers: [...]`. Launching Microsoft is a `booking.json` change plus the secrets. **Both Workers must deploy on a `booking.json` change:** `patrickjv-mcp`'s Workers Builds watch paths (set in the Cloudflare dashboard, listed in `docs/06-operations.md`) gain `booking.json`, which they lack today, so a config-only push redeploys it too. Health reports each launched provider's readiness (secrets set) and reachability (discovery fetched within the last minute, shared 1-minute cache); `signinReady` keeps its F-002 meaning (Google); the smoke check requires every launched provider to be ready and reachable. | Switching on by secrets alone: the static copy couldn't know, and setting a secret would launch a provider with no deploy or review. A code flag per provider: needs code changes. |
| D8 | **The site may name "Altimist ID", and nothing else from Altimist** (decided with Patrick, 12 Oct 2026). The build's denylist keeps blocking "altimist" in every form except an exact allow-list, removed from the text before the denylist is applied, on every page the guard already checks (the CV stays excluded, as today; the homepage embeds the booking guide and WebMCP code, so a per-page exception can't work): the product name `Altimist ID` (case-sensitive), the host `altimist.id` (and URLs on it), the paths `/book/confirm/altimist` and `/book/callback/altimist`, the provider id as a quoted string `"altimist"`, and the query parameter `try=altimist` in raw or percent-encoded form (`try%3Daltimist`, as it appears inside the encoded `return_to` of the "Create one" link). Anything else containing "altimist" ("Altimist" alone, `altimist.com`, "altimist id", "Altimist IDs") still fails the build. The Worker's own pages are checked against the same function in its tests. | A per-page exception: can't cover the guide embedded in the homepage. Dropping Altimist ID; removing "altimist" from the denylist (the guard would stop catching accidental employer mentions). |

---

## Instructions for agents and people

- The booking guide (one source, `content.json` → `booking_guide`) changes step 5 to: "They open it and sign in with {sign_in_providers} before `link_expires`", where `{sign_in_providers}` is filled from `booking.json`'s launched list (D7) joined in the fixed order (Google, Microsoft, Altimist ID, whatever the list's order) as English: one name ("Google"), two joined by "or" ("Google or Microsoft", "Google or Altimist ID"), three as "Google, Microsoft or Altimist ID". The build and the Worker fill it from the same file, so F-002's drift test keeps comparing identical text.
- **No other booking copy names a single provider.** Every sentence that tells an agent or a person how to confirm uses the same `{sign_in_providers}` phrase: the MCP server's `initialize` instructions, the `book_meeting`, `get_booking_status` and `cancel_booking` tool descriptions (MCP and WebMCP), `index.md`'s and `llms.txt`'s MCP lines, `/book`'s intro, "For AI agents" note, disclosure line ("We use your name and email address from…", which names the provider the person chose, once chosen) and progress text ("Taking you to <provider> to sign in…", likewise), and every error or `next_step` that mentions signing in. Today about 15 places in `mcp/`, `build.mjs`, `content.json` and `lib/` say "with Google"; each becomes the phrase.
- `book_meeting`'s `next_step` names the launched providers the same way: "Give this link to the person you're booking for. They need to sign in with {sign_in_providers} before <link_expires> to book the call. Then call get_booking_status."
- `cancel_booking`'s `next_step` for a sign-in booking names the account to use: "Give this link to your person: they sign in with the same <provider> account they booked with to cancel."
- The confirm page before a provider is chosen says "We use your name and email address from the account you sign in with for the invite, and nothing else."; once one is chosen (the progress text) it names that provider. One button per ready provider, Google first, then Microsoft, then Altimist ID: "Sign in with Microsoft to book", "Sign in with Altimist ID to book". Under the Altimist ID button: "No Altimist ID? Create one" (D4's sign-up link, see Functional). The line about what's shared names the provider chosen ("We use your name and email address from <provider> for the invite, and nothing else.").
- `/book`'s choice after a time is picked: the same buttons, then "Book with email instead".
- Public copy is approved by Patrick before release.

---

## User Flows

### Flow 1: Confirm with Microsoft or Altimist ID

1. As F-002 Flow 1 up to the confirm page.
2. The person clicks "Sign in with Microsoft" (or Altimist ID). `POST /book/confirm/microsoft` creates a `signin_tx` bound to the ticket, purpose and provider, sets the `__Host-` cookie and redirects to the provider with PKCE (S256), `state` and `nonce`.
3. The provider returns to `/book/callback/microsoft`. The site consumes `state`, exchanges the code server-side, checks the ID token as D3 (or D4) says, builds `person` and `grant` (`proof: "signin:microsoft"` or `"signin:altimist"`), and calls `confirmRequest`.
4. From here it's F-002: booked, declined or being finished.

### Flow 2: Create an Altimist ID on the way

Under the Altimist ID button, "No Altimist ID? Create one" opens `https://altimist.id/signup/self-service?app_id=patrickjv-com&return_to=<the confirm page URL, ticket included, URL-encoded>` (Altimist ID's self-service contract, checked 12 Oct 2026: it requires `app_id` and a `return_to` whose origin is allow-listed for that app). After sign-up the person is back on the confirm page with the ticket still valid (if it hasn't expired) and clicks "Sign in with Altimist ID".

### Flow 3: Cancel

As F-002 Flow 3: a sign-in whose `provider` and `subject` match the guest cancels. A cancel link offers **only the booking's own provider** ("You booked with Microsoft. Sign in with Microsoft to cancel."), because no other account can cancel it. If that provider isn't ready, the page says so and points to the "Booked" email's cancel link, as the start-refusal rule below describes. A sign-in with the right provider but a different account changes nothing ("This booking belongs to someone else").

---

## Acceptance Criteria

### Functional

- [ ] **(D2)** Sign-in start and callback work for `google`, `microsoft` and `altimist` through one shared implementation. An unknown provider in the path is 404. A transaction started for one provider and completed on another provider's callback is refused: `state` is consumed (as F-002 consumes it before any other check), so that transaction is spent, while the request, its ticket and any booking are unchanged and the person can start again (tested for each pair).
- [ ] **Shared token rules, all providers:** `exp` and `iat` must be numbers, `exp` in the future and `iat` within 5 minutes; `nonce` must equal the transaction's; `aud` must be a string equal to our client ID for that provider (an array is refused, as Google's shipped check already does, so Google's behaviour doesn't change). **Required claims, each a non-empty string:** Google: `sub` and `email` (as F-002); Microsoft: `tid` and `oid` (an `email` that is missing, not a string, empty or without `@` is handled by D3's address rule: refused with the address message, not as a malformed token); Altimist ID: `sub` and `email`. A claim the provider doesn't define (for example `oid` from Google) is never required. Each failure is refused with the request, its ticket and any booking unchanged; `state` is consumed, so that sign-in transaction is spent, as in F-002 (tested per provider, including empty strings and wrong types).
- [ ] **(US-1, D3)** Microsoft ID-token checks, each tested with a fake Microsoft: `aud` is our client ID; `tid` is a GUID; `iss` is exactly `https://login.microsoftonline.com/<tid>/v2.0`; `exp` in the future, `nbf` (if present) not in the future, `iat` within 5 minutes; `nonce` matches; `ver` is `2.0`; `oid` present. Refused: any of these failing; an `iss` for a different tenant than `tid`; a `tid` that isn't a GUID.
- [ ] **(US-1, D3)** Microsoft address rule (tested): a work account with `email` and `xms_edov: true` books; a personal account (`tid` 9188040d-…) with `email` books with or without `xms_edov`; a work account with `email` but `xms_edov` false or missing, or no `email` at all, is refused with nothing changed and the request left open, and the page says, when booking, "Microsoft couldn't confirm this address belongs to you. Sign in another way, or book at patrickjv.com/book with email instead.", and when cancelling, "Microsoft couldn't confirm this address belongs to you. Sign in with the account you booked with, or use the cancel link in your 'Booked' email." with the meeting left booked (both tested) `upn` and `preferred_username` are never used as the address.
- [ ] **(US-1, D3)** The person is `{provider: "microsoft", subject: "<tid>:<oid>", email: <email>, display_name: <name claim, else the part before @>}`. Two sign-ins with the same `tid` and `oid` but different addresses are the same person for the caps (tested).
- [ ] **(US-2, D4)** Altimist ID ID-token checks (tested with a fake Altimist ID): the shared rules above, `iss` exactly `https://altimist.id`, and `email` containing `@`. If `email_verified` is present it must be `true`. The name is `given_name` + `family_name` when either is non-empty, else the part of the address before `@`. The person is `{provider: "altimist", subject: <sub>, …}`.
- [ ] **(US-2)** The "Create one" link is exactly `https://altimist.id/signup/self-service?app_id=patrickjv-com&return_to=<encoded confirm URL>` and appears only while Altimist ID is ready; returning to the confirm URL with a live ticket shows the confirm page again (tested: the link, and the confirm page for that URL; the round trip through Altimist ID is a manual check).
- [ ] **(US-3)** `cancelMeeting` accepts a sign-in only when `provider` and `subject` both match the guest (tested: same provider and subject cancels; same email through a different provider changes nothing; same provider, different subject changes nothing). The cancel page names the provider the booking was made with. `cancel_booking`'s `next_step` names the booking's provider (tested for each provider).
- [ ] **(US-4, D7)** The confirm page, `/book` and the WebMCP popup offer exactly the launched providers that are ready (secrets set, as F-002 gates Google). A provider that isn't launched, or is launched but not ready, gets no button. **Start responses:** a path that isn't one of `google`, `microsoft`, `altimist` is 404; a known provider that isn't launched (and isn't on trial) or isn't ready, with a valid ticket, is the 303 described below; a provider on trial and ready starts normally; an invalid, used or expired ticket is handled as in F-002, whatever the provider (tested for each). `GET /api/booking/types` returns `signin_providers` (the ready ones, in order) and `/book` and the WebMCP prompt render buttons from it (tested). Health adds `providers: {google, microsoft, altimist}`: for an enabled provider (launched or on trial) `{ready: <secrets set>, reachable: <discovery fetched within the last minute>}`, otherwise `"off"`; the smoke check requires both `true` for every launched provider; `signinReady` keeps its F-002 meaning. **Freshness on static pages:** `/book` and the homepage fetch `signin_providers` when the person reaches the sign-in choice (after picking a time), not at page load, **A start refused because its known provider isn't ready** (launched but not ready, or not launched), with a valid ticket, redirects (303) to that request's own confirm page (`/book/confirm?t=…`), which says what to do for its purpose: **booking**, with other providers ready: "That sign-in isn't available just now. Choose another." above the ready buttons; **booking**, with none ready: "Sign-in isn't available just now. Try again in a few minutes, or book at patrickjv.com/book with email instead."; **cancelling** (only the booking's own provider is ever offered): "<booking's provider> sign-in isn't available just now. Try again in a few minutes, or use the cancel link in your 'Booked' email.", with no button (each tested, including a booking's provider unready while others are ready). Nothing new is created: the same request and ticket are reused, no request allowance is taken, and no sign-in attempt is counted. On `/book` the request is created once, on the first sign-in click, and the page keeps its `confirm_url`; when a start is refused, the WebMCP popup lands on the same confirm page (an accepted start goes straight to the provider, as today). Tested: a provider goes unready between rendering the choices and submitting, on `/book`, on the confirm page and in the WebMCP popup; a provider recovers after the page loads.
- [ ] **(D7) Request admission:** `book_meeting` and `POST /api/booking/request` accept a request when at least one launched provider is ready, and refuse with F-001's `503` and a `next_step` when none is (today's Google-only check generalised). With Google not ready but Microsoft ready, a request is accepted and the confirm page offers only Microsoft (tested both ways).
- [ ] **(D5)** `GET /.well-known/microsoft-identity-association.json` returns `{"associatedApplications":[{"applicationId":"<SIGNIN_MICROSOFT_CLIENT_ID>"}]}` with `content-type: application/json` when Microsoft's client ID is set, and 404 when it isn't (tested).
- [ ] **(D6)** With `microsoft` launched, the build fails when `signin.microsoftSecretExpires` is missing or not a valid `YYYY-MM-DD` date, and from 30 days before it, with a message naming the runbook entry; it passes before then (tested with a fixed clock, as for `security.txt`). With Microsoft not launched, the value is ignored (tested).
- [ ] **Guide:** the booking guide and `next_step` name the launched providers (tested for `["google"]`, `["google","microsoft"]`, `["google","altimist"]`, `["google","microsoft","altimist"]` and `["google","altimist","microsoft"]`, the last two giving the same text); every published copy still matches its source (F-002's drift test, extended); the confirm page's buttons follow readiness, not the launched list alone.
- [ ] **No single-provider copy:** with all three providers launched, a test renders every surface listed under "Instructions" (the build's output, the Worker's `initialize`, `tools/list` on MCP and WebMCP data, every booking error and `next_step`) and finds no **sign-in instruction** that names one provider as *the* way to confirm. A sign-in instruction is a sentence that mentions signing in or an account ("sign in", "signs in", "signing in", "sign-in", "account"); sentences about the calendar service ("Google has sent the invite", "Google notifies attendees") aren't sign-in instructions and aren't checked. the pre-choice disclosure line is checked directly (it must not name a provider); the rest of the covered text is the guide, `initialize` instructions, tool descriptions, `next_step`s, error messages, `/book`'s intro, "For AI agents" note, disclosure line and progress text, and `index.md`/`llms.txt`; a sentence there fails if it names any single provider ("Google", "Microsoft" or "Altimist ID", in any phrasing such as "with Google" or "their Google sign-in") other than as part of the full `{sign_in_providers}` phrase. Exempt by design: the disclosure and progress text once they name the provider the person chose, button labels ("Sign in with <provider> to book", "…to cancel"), and on a cancellation, the sentences naming the booking's own provider (the cancel page, `cancel_booking`'s `next_step`, and the cancel-path messages above), and messages reporting a failure *of* the provider the person just used ("Microsoft couldn't confirm this address…", "<provider> sign-in isn't available just now"), which name that provider by design. With only Google launched, the same surfaces read exactly as F-002's ("with Google"), except the changes the "F-002 unchanged" criterion lists (the `next_step` wording and the provider-neutral pre-choice disclosure).
- [ ] **(D8)** One function applies the denylist with D8's allow-list, used by the build for every page and by the Worker's tests for the confirm and cancel pages. Tested: each allowed form passes on any page; `Altimist` alone, `altimist id`, `Altimist IDs`, `altimist.com`, `ALTIMIST ID` and an allowed form glued to other text (`Altimist IDx`, `altimist.identity`) fail; the full build with all three providers launched passes.
- [ ] **F-002 unchanged:** every F-002 test stays green with only Google launched, except these intended changes, each replaced by an assertion of the new shape: health gains `providers` (the tests that pin health's exact keys, `mcp/handler.test.mjs` and `test/smoke.test.mjs`, now expect it); `GET /api/booking/types` gains `signin_providers`; `/book/confirm/google` becomes the `google` case of `/book/confirm/{provider}` at the same path; the confirm page's pre-choice disclosure becomes provider-neutral (the assertion in `mcp/signin-flow.test.mjs` that pins "from Google" now pins the neutral sentence); `book_meeting`'s and `cancel_booking`'s `next_step` text changes to this spec's wording (the assertions in `mcp/signin-flow.test.mjs` and `test/booking-guide.test.mjs` that pin F-002's sentences now pin the new ones); with only Google launched, every other F-002 copy assertion is unchanged, because the phrase renders as "Google".
- [ ] **Manual checks, each gating that provider's launch** (adding it to `signin.providers`), done with the provider on `signin.trial` (ready, not launched), by opening the confirm page with `&try=<provider>`: **Altimist ID:** a booking confirmed and cancelled with an Altimist ID, including creating one on the way. **Microsoft:** the same with (a) a Microsoft 365 work account and (b) an Outlook.com personal account (also checks whether `xms_edov` arrives for personal accounts). Each is recorded in the spikes log. The phase's code ships when the automated criteria pass; Google's behaviour is unchanged by it.

### Non-functional

- [ ] **Security:** the cookie, `Origin`, framing and CSP rules of F-002 apply to every provider's routes. On every page that starts a sign-in (the confirm page, `/book`, and the homepage for WebMCP), `form-action` is `'self'` plus exactly the authorisation hosts of the enabled providers (launched or on trial: `https://accounts.google.com`, `https://login.microsoftonline.com`, `https://altimist.id`), built from `booking.json`, so a trial sign-in works from the real confirm page (tested per page, for launched-only and launched-plus-trial lists).
- [ ] **Privacy:** `/privacy` names every enabled provider (launched or on trial) as an identity provider and what's kept from each (the same fields as Google); with only Google enabled it reads as today (tested for each enabled list).
- [ ] **Observability:** while booking is enabled, the smoke check fails when any **launched** provider isn't ready (secrets missing) or isn't reachable (discovery not fetched); providers that aren't launched are ignored whatever secrets they have; with booking disabled it passes, as in F-002 (tested in `healthVerdict`). Logs carry the subsystem and provider only.
- [ ] **Cost:** Free plan; no new storage.

---

## Data Model

One column added: `signin_tx.provider` (`ALTER TABLE … ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'`), so transactions in flight during the deploy finish on Google's callback (tested: `migrate()` on an F-002 database holding an in-flight transaction, which then completes). No other change: `identities.provider` gains the values `microsoft` and `altimist`, and `bookings.proof` gains `signin:microsoft` and `signin:altimist`.

---

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/book/confirm/{provider}` | Start sign-in with `google`, `microsoft` or `altimist` (F-002's `/book/confirm/google` is the `google` case) |
| GET | `/book/callback/{provider}` | The provider returns here |
| GET | `/.well-known/microsoft-identity-association.json` | Publisher-domain verification (D5) |

New Worker routes: `patrickjv.com/.well-known/microsoft-identity-association.json` to the `patrickjv-mcp` Worker.

---

## Setup (manual)

**Microsoft** (in an Entra tenant Patrick personally controls, not a work tenant; publisher verification needs an Entra tenant and a Microsoft AI Cloud Partner Program account):
1. App registration "patrickjv.com", supported account types "Any Microsoft Entra directory and personal Microsoft accounts", web redirect URI `https://patrickjv.com/book/callback/microsoft`.
2. Token configuration: optional ID-token claims `email` and `xms_edov`.
3. Set `authenticationBehaviors.removeUnverifiedEmailClaim = true` (Microsoft Graph PATCH on the application).
4. A client secret, 24 months. Store `SIGNIN_MICROSOFT_CLIENT_ID` and `SIGNIN_MICROSOFT_CLIENT_SECRET` as Worker secrets, and put the secret's expiry date in `booking.json` as `signin.microsoftSecretExpires`.
5. Branding: name "patrickjv.com", home page, privacy URL, publisher domain `patrickjv.com` (verified through the `.well-known` file, which serves once `SIGNIN_MICROSOFT_CLIENT_ID` is set; that doesn't launch anything).
6. Publisher verification through Partner Center.
7. **Trial, then launch:** first add `"microsoft"` to `signin.trial` and deploy, and do the manual checks; then move it from `signin.trial` to `signin.providers` and deploy (D7). Only the move makes the button appear.

**Both Workers:** add `booking.json` to `patrickjv-mcp`'s build watch paths in the Cloudflare dashboard, and update the table in `docs/06-operations.md` to match.

**Altimist ID:**
1. Register the client with redirect URI `https://patrickjv.com/book/callback/altimist`, display name "patrickjv.com".
2. Add an app policy `patrickjv-com` allowing `https://patrickjv.com` as a self-service sign-up origin (the `app_id` the "Create one" link uses).
3. Store `SIGNIN_ALTIMIST_CLIENT_ID` and `SIGNIN_ALTIMIST_CLIENT_SECRET` as Worker secrets.
4. **Trial, then launch:** add `"altimist"` to `signin.trial`, deploy and do the manual checks; then move it to `signin.providers` and deploy (D7).

---

## Edge Cases

- **Microsoft "needs admin approval":** should be rare after publisher verification; if it happens, the person signs in another way. Nothing on our side can fix an organisation's consent policy.
- **Microsoft guest accounts:** `/common` signs people in to their home tenant, so `tid` is their home tenant; the key is stable.
- **A personal Microsoft account without an `email` claim:** refused as above (can happen for phone-number-only accounts).
- **Altimist ID sign-up takes longer than the ticket lasts:** the confirm page shows "expired", with F-002's advice to ask again.
- **A provider goes down mid-flow:** the callback's code exchange fails; F-002's rule applies (the transaction is spent, the ticket isn't).

---

## Open Questions

- **Is an individual eligible for a Partner Center account?** (D5) Patrick checks Partner Center's enrolment before Microsoft's setup step 6. Until it's resolved, Microsoft is built and tested but not added to `signin.providers`. If an individual can't be verified, D5 goes back to Patrick (launch unverified, or don't launch Microsoft); Google and Altimist ID ship either way.

---

## References

- Microsoft: supported account types, ID-token claims and optional claims (`xms_edov`), `authenticationBehaviors`, publisher verification, consent settings (learn.microsoft.com, checked 9 Oct 2026).
- Altimist ID discovery: `https://altimist.id/.well-known/openid-configuration` (checked 12 Oct 2026: auth code + PKCE S256, `client_secret_post`/`client_secret_basic`, scopes `openid email profile`, claims `sub email given_name family_name groups`, no userinfo).
- MCP elicitation (deferred): 2025-11-25 and 2026-07-28 specifications.
