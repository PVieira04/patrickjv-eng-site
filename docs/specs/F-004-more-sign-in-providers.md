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

As **a person on the confirm page**, I want **to see only the sign-in options that are working right now**, so that **I don't hit a broken button**.

---

## Goals & Non-Goals

**Goals**
- Microsoft and Altimist ID confirm and cancel exactly as Google does in F-002, through `confirmRequest` and `cancelMeeting`.
- The address used for the invite is one the provider stands behind (rules per provider, D3–D4).
- A provider is offered only when its secrets are set and it's reachable; turning one on or off needs no code change.
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
| D3 | **Microsoft: one multi-tenant app with personal accounts** (`signInAudience = AzureADandPersonalMicrosoftAccount`, `/common/v2.0` endpoints), scopes `openid profile email`, optional ID-token claims `email` and `xms_edov`, and `removeUnverifiedEmailClaim = true` set on the app. **Key:** `provider: "microsoft"`, `subject: <tid>:<oid>` (Microsoft: `tid` must be part of the key; never key on email, `upn` or `preferred_username`). **Address:** the `email` claim, accepted only if `xms_edov` is `true`, or the account is a personal Microsoft account (`tid` = `9188040d-6c67-4c5b-b112-36a304b66dad`), whose addresses Microsoft treats as verified. Otherwise refused (see Functional). **Issuer:** `tid` is a GUID and `iss` equals exactly `https://login.microsoftonline.com/<tid>/v2.0`. **Credential:** a client secret (a Worker secret), as for Google. | `organizations` or `consumers` only: leaves out half the people this is for. Keying on `sub`: also valid, but `tid`+`oid` is Microsoft's own recommendation and stays the same if we ever add a second app. A certificate credential: more code and a private key to manage, for a sign-in-only app. |
| D4 | **Altimist ID: trust its address.** Altimist ID proves an address with a one-time code at sign-up, so its `email` is treated as verified, as D9 of F-002 treats any address Google has verified. Its tokens carry no `email_verified` claim today; **if one appears, it must be `true`**. **Key:** `provider: "altimist"`, `subject: <sub>`. **Name:** `given_name` and `family_name` joined, else the part of the address before `@` (Altimist ID can return empty names). **Issuer:** exactly `https://altimist.id`. | Waiting for Altimist ID to emit `email_verified` and `name`: holds this phase on work elsewhere for no real gain in assurance. |
| D5 | **Publisher verification before Microsoft goes live.** Some organisations let staff approve only apps from verified publishers; unverified, their users get "needs admin approval". The Microsoft button is switched on only after the publisher is verified. The site serves `/.well-known/microsoft-identity-association.json` with the app's ID, which publisher-domain verification for `patrickjv.com` needs. | Launching unverified: some company users blocked at first sight of the button. |
| D6 | **The Microsoft secret's expiry is guarded like `security.txt`.** Its expiry date is a plain value in `mcp/wrangler.jsonc` vars (`SIGNIN_MICROSOFT_SECRET_EXPIRES`, `YYYY-MM-DD`), and the build fails from 30 days before it, as for `security.txt`'s `Expires`. Rotation is a runbook entry. | Remembering: a sign-in that silently stops working when the secret lapses. |
| D7 | **Providers switch on by secrets.** A provider's button appears only when its client ID and secret are set and its discovery document was reachable within the last minute (shared 1-minute cache, as F-002's availability). Health reports each provider's readiness separately; `signinReady` stays the Google one (Google is always on), and the smoke check requires each provider that has secrets to be ready. | A code flag per provider: a deploy to turn one on. |

---

## Instructions for agents and people

- The booking guide (one source, `content.json` → `booking_guide`) changes step 5 to: "They open it and sign in with Google, Microsoft or Altimist ID before `link_expires`", naming only providers that are switched on, filled in when the guide is rendered (the Worker renders `initialize` and `get_booking_guide`; the build renders the static copies with every provider that has a `SIGNIN_*` setup entry, and the drift test compares like with like).
- `book_meeting`'s `next_step` says the same.
- The confirm page: one button per ready provider, Google first, then Microsoft, then Altimist ID: "Sign in with Microsoft to book", "Sign in with Altimist ID to book". Under the Altimist ID button: "No Altimist ID? Create one" (D4's sign-up link, see Functional). The line about what's shared names the provider chosen ("We use your name and email address from <provider> for the invite, and nothing else.").
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

Under the Altimist ID button, "No Altimist ID? Create one" opens Altimist ID's self-service sign-up with patrickjv.com as the app and the confirm page as the return address. After sign-up the person is back on the confirm page with the ticket still valid (if it hasn't expired) and clicks "Sign in with Altimist ID".

### Flow 3: Cancel

As F-002 Flow 3: a sign-in whose `provider` and `subject` match the guest cancels. Every ready provider is offered on a cancel link; signing in with a different provider than the booking's changes nothing ("This booking belongs to someone else"), so the page says which provider the booking was made with ("You booked with Microsoft").

---

## Acceptance Criteria

### Functional

- [ ] **(D2)** Sign-in start and callback work for `google`, `microsoft` and `altimist` through one shared implementation. An unknown provider in the path is 404. A transaction started for one provider and completed on another provider's callback is refused with nothing changed (tested for each pair).
- [ ] **(US-1, D3)** Microsoft ID-token checks, each tested with a fake Microsoft: `aud` is our client ID; `tid` is a GUID; `iss` is exactly `https://login.microsoftonline.com/<tid>/v2.0`; `exp` in the future, `nbf` (if present) not in the future, `iat` within 5 minutes; `nonce` matches; `ver` is `2.0`; `oid` present. Refused: any of these failing; an `iss` for a different tenant than `tid`; a `tid` that isn't a GUID.
- [ ] **(US-1, D3)** Microsoft address rule (tested): a work account with `email` and `xms_edov: true` books; a personal account (`tid` 9188040d-…) with `email` books with or without `xms_edov`; a work account with `email` but `xms_edov` false or missing, or no `email` at all, is refused with nothing changed and the request left open, and the page says "Microsoft couldn't confirm this address belongs to you. Sign in another way, or book at patrickjv.com/book with email instead." `upn` and `preferred_username` are never used as the address.
- [ ] **(US-1, D3)** The person is `{provider: "microsoft", subject: "<tid>:<oid>", email: <email>, display_name: <name claim, else the part before @>}`. Two sign-ins with the same `tid` and `oid` but different addresses are the same person for the caps (tested).
- [ ] **(US-2, D4)** Altimist ID ID-token checks (tested with a fake Altimist ID): `iss` exactly `https://altimist.id`, `aud` our client ID, `exp`, `iat` within 5 minutes, `nonce`, `sub` present, `email` present. If `email_verified` is present it must be `true`. The name is `given_name` + `family_name` when either is non-empty, else the part of the address before `@`. The person is `{provider: "altimist", subject: <sub>, …}`.
- [ ] **(US-2)** The "Create one" link opens Altimist ID's self-service sign-up for the patrickjv.com app with the confirm page's URL as the return address; returning with a live ticket shows the confirm page again (tested: the link's target and parameters; the round trip through Altimist ID is a manual check).
- [ ] **(US-3)** `cancelMeeting` accepts a sign-in only when `provider` and `subject` both match the guest (tested: same provider and subject cancels; same email through a different provider changes nothing; same provider, different subject changes nothing). The cancel page names the provider the booking was made with.
- [ ] **(US-4, D7)** The confirm page, `/book` and the WebMCP popup offer exactly the providers that are ready: secrets set and discovery reachable within the last minute. With Microsoft's secrets unset, its button doesn't appear and `POST /book/confirm/microsoft` is 404 (tested). Health adds `providers: {google, microsoft, altimist}` with `true`/`false`/`"off"` (`"off"` when its secrets aren't set); `signinReady` keeps its F-002 meaning.
- [ ] **(D5)** `GET /.well-known/microsoft-identity-association.json` returns `{"associatedApplications":[{"applicationId":"<SIGNIN_MICROSOFT_CLIENT_ID>"}]}` with `content-type: application/json` when Microsoft's client ID is set, and 404 when it isn't (tested).
- [ ] **(D6)** The build fails from 30 days before `SIGNIN_MICROSOFT_SECRET_EXPIRES`, with a message naming the runbook entry, and passes before then (tested with a fixed clock, as for `security.txt`). The build passes when the value is unset.
- [ ] **Guide:** the booking guide, `next_step` and confirm page name the ready providers (tested with each combination of providers on); every published copy still matches its source (F-002's drift test, extended).
- [ ] **F-002 unchanged:** every F-002 test stays green with only Google configured.
- [ ] **Manual checks:** a booking confirmed and then cancelled with (a) a Microsoft 365 work account, (b) an Outlook.com personal account (also checks whether `xms_edov` arrives for personal accounts), (c) an Altimist ID, including creating one on the way. Each is recorded in the spikes log.

### Non-functional

- [ ] **Security:** the cookie, `Origin`, framing and CSP rules of F-002 apply to every provider's routes; `/book`'s CSP `form-action` allows exactly `accounts.google.com`, `login.microsoftonline.com` and `altimist.id`.
- [ ] **Privacy:** `/privacy` names Microsoft and Altimist ID as identity providers and what's kept from each (the same fields as Google).
- [ ] **Observability:** the smoke check fails when a provider with secrets set isn't ready; logs carry the subsystem and provider only.
- [ ] **Cost:** Free plan; no new storage.

---

## Data Model

No schema change. `identities.provider` gains the values `microsoft` and `altimist`; `bookings.proof` gains `signin:microsoft` and `signin:altimist`. `signin_tx` gains a `provider` column (`ALTER TABLE … ADD COLUMN`, default `'google'` for rows in flight during the deploy).

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
4. A client secret, 24 months; store `SIGNIN_MICROSOFT_CLIENT_ID` and `SIGNIN_MICROSOFT_CLIENT_SECRET` as Worker secrets and the expiry in `SIGNIN_MICROSOFT_SECRET_EXPIRES`. **Don't** set the secrets until step 6 is done (D5: setting them switches the button on).
5. Branding: name "patrickjv.com", home page, privacy URL, publisher domain `patrickjv.com` (verified through the `.well-known` file, which needs the client ID; set `SIGNIN_MICROSOFT_CLIENT_ID` alone first, then the secret after step 6).
6. Publisher verification through Partner Center.

**Altimist ID:**
1. Register the client with redirect URI `https://patrickjv.com/book/callback/altimist`, display name "patrickjv.com".
2. Allow `https://patrickjv.com` as a self-service sign-up origin for that app.
3. Store `SIGNIN_ALTIMIST_CLIENT_ID` and `SIGNIN_ALTIMIST_CLIENT_SECRET` as Worker secrets.

---

## Edge Cases

- **Microsoft "needs admin approval":** should be rare after publisher verification; if it happens, the person signs in another way. Nothing on our side can fix an organisation's consent policy.
- **Microsoft guest accounts:** `/common` signs people in to their home tenant, so `tid` is their home tenant; the key is stable.
- **A personal Microsoft account without an `email` claim:** refused as above (can happen for phone-number-only accounts).
- **Altimist ID sign-up takes longer than the ticket lasts:** the confirm page shows "expired", with F-002's advice to ask again.
- **A provider goes down mid-flow:** the callback's code exchange fails; F-002's rule applies (the transaction is spent, the ticket isn't).

---

## Open Questions

- **Is an individual eligible for a Partner Center account?** (D5) If not, revisit D5 with Patrick before launch: the rest of the phase can be built and tested without it.
- **Altimist ID's self-service sign-up parameters** for the "Create one" link (app name and return address) are confirmed against Altimist ID's current behaviour during the build.

---

## References

- Microsoft: supported account types, ID-token claims and optional claims (`xms_edov`), `authenticationBehaviors`, publisher verification, consent settings (learn.microsoft.com, checked 9 Oct 2026).
- Altimist ID discovery: `https://altimist.id/.well-known/openid-configuration` (checked 12 Oct 2026: auth code + PKCE S256, `client_secret_post`/`client_secret_basic`, scopes `openid email profile`, claims `sub email given_name family_name groups`, no userinfo).
- MCP elicitation (deferred): 2025-11-25 and 2026-07-28 specifications.
