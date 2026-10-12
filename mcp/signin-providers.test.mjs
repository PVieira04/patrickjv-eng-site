// F-004 through the Worker: Microsoft and Altimist ID sign-in beside Google, on F-002's confirm
// page and booking core. The real handler and BookingStore body (node:sqlite) with fake Google,
// Microsoft, Altimist ID and Resend. Providers are launched (or put on trial) in the harness's own
// copy of booking.json; every provider's secrets are set unless a test removes them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, quiet, ORIGIN } from "./booking-harness.mjs";
import { MS_TENANT, MS_PERSONAL } from "./booking-fakes.mjs";

const SLOT = "2026-10-21T10:00:00+01:00";
const SLOT2 = "2026-10-22T10:00:00+01:00";
const ask = (over = {}) => ({ type: "consultation", start: SLOT, ...over });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const PROVIDERS = ["google", "microsoft", "altimist"];
const NAME = { google: "Google", microsoft: "Microsoft", altimist: "Altimist ID" };
const SECRETS = { google: ["SIGNIN_GOOGLE_CLIENT_ID", "SIGNIN_GOOGLE_CLIENT_SECRET"], microsoft: ["SIGNIN_MICROSOFT_CLIENT_ID", "SIGNIN_MICROSOFT_CLIENT_SECRET"], altimist: ["SIGNIN_ALTIMIST_CLIENT_ID", "SIGNIN_ALTIMIST_CLIENT_SECRET"] };
const AUTH = { google: "https://accounts.google.com/o/oauth2/v2/auth", microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", altimist: "https://altimist.id/oidc/authorize" };

// A harness with these providers launched (and these on trial).
function launched(providers = PROVIDERS, trial = [], opts = {}) {
  const h = harness(opts);
  h.cfg.signin = { providers, trial };
  return h;
}
const request = async (h, args = ask()) => (await h.tool("book_meeting", args)).structuredContent;
const page = async (h, path) => { const res = await h.call(path); const html = await res.text(); return { res, html, t: text(html) }; };
const confirmPage = (h, url, extra = "") => page(h, `/book/confirm?t=${h.ticketOf(url)}${extra}`);
const buttons = (html) => [...html.matchAll(/<form method="post" action="\/book\/confirm\/([a-z]+)">/g)].map((m) => m[1]);
const status = async (h, id) => (await h.tool("get_booking_status", { booking_id: id })).structuredContent.status;
const unready = (h, p) => { for (const k of SECRETS[p]) h.secret(k, undefined); };
const ready = (h, p) => { for (const [k, v] of Object.entries({ SIGNIN_GOOGLE_CLIENT_ID: "signin-client.apps.googleusercontent.com", SIGNIN_GOOGLE_CLIENT_SECRET: "signin-secret", SIGNIN_MICROSOFT_CLIENT_ID: "3f1c9a2e-0000-4000-8000-00000000c11e", SIGNIN_MICROSOFT_CLIENT_SECRET: "ms-secret", SIGNIN_ALTIMIST_CLIENT_ID: "patrickjv-com-client", SIGNIN_ALTIMIST_CLIENT_SECRET: "altimist-secret" })) if (SECRETS[p].includes(k)) h.secret(k, v); };
const quotaRows = (h) => h.rows("SELECT kind, key, n FROM quota ORDER BY kind, key");

// ---- D2: one flow, three providers -----------------------------------------------------------------

test("F-004 (D2): start and callback work for google, microsoft and altimist through one implementation; each books with its own proof and identity", async () => {
  const h = launched();
  for (const [p, start] of [["google", SLOT], ["microsoft", SLOT2], ["altimist", "2026-10-23T10:00:00+01:00"]]) {
    const r = await request(h, ask({ start }));
    const s = await h.signInOn(r.confirm_url, {}, { provider: p });
    assert.equal(s.start.status, 303, p);
    assert.match(s.start.headers.get("set-cookie"), /^__Host-pjv_signin=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/, p);
    const loc = new URL(s.start.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, AUTH[p], p);
    assert.equal(loc.searchParams.get("redirect_uri"), `https://patrickjv.com/book/callback/${p}`);
    assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
    assert.match(text(s.html), /Booked/, `${p}: ${text(s.html).slice(0, 200)}`);
    const b = h.rows("SELECT proof, guest_email, identity_id FROM bookings WHERE id = ?", r.booking_id)[0];
    assert.equal(b.proof, `signin:${p}`);
    assert.equal(h.rows("SELECT provider FROM identities WHERE id = ?", b.identity_id)[0].provider, p);
  }
  assert.equal(h.rows("SELECT subject FROM identities WHERE provider = 'microsoft'")[0].subject, `${MS_TENANT}:oid-omar`);
  assert.deepEqual(h.rows("SELECT guest_name FROM bookings ORDER BY start_utc").map((b) => b.guest_name), ["Jane Smith", "Omar Khan", "Sam Lee"]);
});

test("F-004 (D2): an unknown provider in the path is 404, for the start and the callback", async () => {
  const h = launched();
  const r = await request(h);
  for (const p of ["github", "Google", "google2", ""]) {
    assert.equal((await h.startSignin(h.ticketOf(r.confirm_url), { provider: p })).status, 404, `start ${p}`);
    assert.equal((await h.call(`/book/callback/${p}?state=x&code=y`)).status, 404, `callback ${p}`);
  }
  assert.equal(await status(h, r.booking_id), "pending_confirmation");
});

test("F-004 (D2): a transaction started for one provider and completed on another's callback is refused, for each pair: state is spent, the request and its ticket are unchanged and can start again", async () => {
  for (const from of PROVIDERS) for (const to of PROVIDERS.filter((p) => p !== from)) {
    const h = launched();
    const r = await request(h);
    const start = await h.startSignin(h.ticketOf(r.confirm_url), { provider: from });
    const cookie = h.cookieOf(start);
    const { code, state } = h.f.authorize(start.headers.get("location"), {}, h.clock.now);
    const res = await quiet(() => h.callback({ code, state }, cookie, to));
    assert.ok(res.status >= 400, `${from} → ${to}`);
    assert.doesNotMatch(text(await res.text()), /Booked/);
    assert.deepEqual(h.rows("SELECT * FROM signin_tx"), [], `${from} → ${to}: state consumed`);
    const back = await h.callback({ code, state }, cookie, from);
    assert.ok(back.status >= 400, `${from} → ${to}: the spent transaction can't finish on its own callback either`);
    assert.equal(await status(h, r.booking_id), "pending_confirmation");
    assert.match(text((await h.signInOn(r.confirm_url, {}, { provider: from })).html), /Booked/, `${from} → ${to}: the ticket still works`);
  }
});

test("F-004 shared token rules through the callback: a bad ID token from any provider is refused with the request open and the transaction spent", async () => {
  const h = launched();
  h.cfg.caps.signinAttemptsPerTicket = 50;
  const r = await request(h);
  for (const p of PROVIDERS) {
    for (const claims of [{ aud: "someone-else" }, { nonce: "other" }, { exp: Math.floor(h.clock.now / 1000) - 1 }, { iat: "1" }, { iss: "https://evil.example" }]) {
      const s = await h.signInOn(r.confirm_url, claims, { provider: p });
      assert.equal(s.res.status, 400, `${p} ${JSON.stringify(claims)}`);
      assert.match(text(s.html), /Sign-in didn't finish/);
      assert.deepEqual(h.rows("SELECT * FROM signin_tx"), []);
    }
  }
  for (const [p, claims] of [["google", { sub: "" }], ["microsoft", { oid: "" }], ["microsoft", { tid: 7 }], ["altimist", { sub: undefined }], ["altimist", { email: "" }]]) {
    assert.equal((await h.signInOn(r.confirm_url, claims, { provider: p })).res.status, 400, `${p} ${JSON.stringify(claims)}`);
  }
  assert.equal(await status(h, r.booking_id), "pending_confirmation");
});

// ---- US-1, D3: Microsoft's address rule --------------------------------------------------------------

test("F-004 (US-1, D3): Microsoft: a work account with xms_edov true books; a personal account books with or without it; xms_edov false or missing, or no email, is refused with the request left open", async () => {
  const h = launched();
  h.cfg.caps.signinAttemptsPerTicket = 50;
  const refusedBook = "Microsoft couldn't confirm this address belongs to you. Sign in another way, or book at patrickjv.com/book with email instead.";
  const r = await request(h);
  for (const claims of [{ xms_edov: false }, { xms_edov: undefined }, { email: undefined }, { email: undefined, upn: "omar@contoso.example", preferred_username: "omar@contoso.example" }]) {
    const s = await h.signInOn(r.confirm_url, claims, { provider: "microsoft" });
    assert.equal(s.res.status, 403, JSON.stringify(claims));
    assert.match(text(s.html), new RegExp(refusedBook.replace(/[.?]/g, "\\$&")));
    assert.match(s.res.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(await status(h, r.booking_id), "pending_confirmation");
  }
  const personal = { tid: MS_PERSONAL, iss: `https://login.microsoftonline.com/${MS_PERSONAL}/v2.0`, oid: "oid-personal", email: "omar@outlook.com" };
  assert.match(text((await h.signInOn(r.confirm_url, { ...personal, xms_edov: undefined }, { provider: "microsoft" })).html), /Booked/);
  const r2 = await request(h, ask({ start: SLOT2 }));
  assert.match(text((await h.signInOn(r2.confirm_url, {}, { provider: "microsoft" })).html), /Booked/, "work account with xms_edov");
  assert.equal(h.rows("SELECT guest_email FROM bookings WHERE id = ?", r.booking_id)[0].guest_email, "omar@outlook.com");
});

test("F-004 (US-1, D3): cancelling with a Microsoft sign-in whose address isn't confirmed says so and leaves the meeting booked", async () => {
  const h = launched();
  const r = await request(h);
  await h.signInOn(r.confirm_url, {}, { provider: "microsoft" });
  const c = (await h.tool("cancel_booking", { booking_id: r.booking_id })).structuredContent;
  const s = await h.signInOn(c.confirm_url, { xms_edov: false }, { provider: "microsoft" });
  assert.equal(s.res.status, 403);
  assert.match(text(s.html), /Microsoft couldn't confirm this address belongs to you\. Sign in with the account you booked with, or use the cancel link in your 'Booked' email\./);
  assert.equal(await status(h, r.booking_id), "confirmed");
});

// ---- US-2: Altimist ID and "Create one" --------------------------------------------------------------

test("F-004 (US-2): the 'Create one' link is exactly Altimist ID's self-service sign-up returning to this confirm page, only while Altimist ID is offered; its return URL shows the confirm page", async () => {
  const h = launched();
  const r = await request(h);
  const { html, t } = await confirmPage(h, r.confirm_url);
  assert.match(t, /No Altimist ID\? Create one/);
  const href = html.match(/<a href="([^"]*)">Create one<\/a>/)[1].replace(/&amp;/g, "&");
  assert.equal(href, `https://altimist.id/signup/self-service?app_id=patrickjv-com&return_to=${encodeURIComponent(r.confirm_url)}`);
  const back = new URL(new URL(href).searchParams.get("return_to"));
  assert.equal(back.href, r.confirm_url);
  const again = await page(h, back.pathname + back.search);
  assert.equal(again.res.status, 200);
  assert.match(again.t, /Book your call/);
  assert.ok(buttons(again.html).includes("altimist"));

  unready(h, "altimist");
  assert.doesNotMatch((await confirmPage(h, r.confirm_url)).t, /Create one/, "not ready: no link");
  ready(h, "altimist");
  h.cfg.signin = { providers: ["google"], trial: [] };
  assert.doesNotMatch((await confirmPage(h, r.confirm_url)).t, /Create one|Altimist ID/, "not launched: no link");
});

// ---- US-3: cancel with the account you booked with ---------------------------------------------------

test("F-004 (US-3): a cancel link offers only the booking's own provider and names it; cancel_booking's next_step names it; that provider's sign-in cancels", async () => {
  const h = launched();
  for (const [p, start] of [["google", SLOT], ["microsoft", SLOT2], ["altimist", "2026-10-23T10:00:00+01:00"]]) {
    const r = await request(h, ask({ start }));
    await h.signInOn(r.confirm_url, {}, { provider: p });
    const c = (await h.tool("cancel_booking", { booking_id: r.booking_id })).structuredContent;
    assert.deepEqual(Object.keys(c).sort(), ["confirm_url", "link_expires", "next_step", "status"]);
    assert.equal(c.next_step, `Give this link to your person: they sign in with the same ${NAME[p]} account they booked with to cancel.`);
    const { html, t } = await confirmPage(h, c.confirm_url);
    assert.deepEqual(buttons(html), [p]);
    assert.match(t, new RegExp(`You booked with ${NAME[p]}\\. Sign in with ${NAME[p]} to cancel this call\\. Only the person it's booked for can cancel it\\.`));
    assert.match(html, new RegExp(`<button type="submit">Sign in with ${NAME[p]} to cancel</button>`));
    assert.doesNotMatch(t, /Create one/);
    assert.match(text((await h.signInOn(c.confirm_url, {}, { provider: p })).html), /Cancelled/, p);
    assert.equal(await status(h, r.booking_id), "cancelled");
  }
});

test("F-004 (US-3): the same email through another provider, or another account on the same provider, can't cancel", async () => {
  const h = launched();
  const r = await request(h);
  await h.signInOn(r.confirm_url, {}, { provider: "microsoft" });
  const c = (await h.tool("cancel_booking", { booking_id: r.booking_id })).structuredContent;
  const viaGoogle = await h.signInOn(c.confirm_url, { email: "omar@contoso.example" }, { provider: "google" });
  assert.match(text(viaGoogle.html), /This booking belongs to someone else/);
  const otherAccount = await h.signInOn(c.confirm_url, { oid: "oid-someone-else" }, { provider: "microsoft" });
  assert.match(text(otherAccount.html), /This booking belongs to someone else/);
  assert.equal(await status(h, r.booking_id), "confirmed");
});

// ---- US-4, D7: offered only when launched and ready ----------------------------------------------------

test("F-004 (US-4, D7): the confirm page offers exactly the launched providers that are ready, in the fixed order, whatever the list's order", async () => {
  for (const [providers, unset, want] of [
    [["google"], [], ["google"]],
    [["google", "altimist", "microsoft"], [], ["google", "microsoft", "altimist"]],
    [["google", "microsoft"], [], ["google", "microsoft"]],
    [["google", "microsoft", "altimist"], ["microsoft"], ["google", "altimist"]],
    [["google", "microsoft"], ["google"], ["microsoft"]],
  ]) {
    const h = launched(providers);
    const r = await request(h);
    for (const p of unset) unready(h, p);
    const { html, t } = await confirmPage(h, r.confirm_url);
    assert.deepEqual(buttons(html), want, JSON.stringify([providers, unset]));
    for (const p of want) assert.match(html, new RegExp(`<button type="submit">Sign in with ${NAME[p]} to book</button>`));
    assert.match(t, /We use your name and email address from the account you sign in with for the invite, and nothing else\./);
  }
});

test("F-004 (US-4, D7): GET /api/booking/types returns signin_providers, the ready launched ones in order; trial providers never appear", async () => {
  const h = launched(["google", "altimist", "microsoft"], []);
  const types = async () => (await (await h.call("/api/booking/types")).json()).signin_providers;
  assert.deepEqual(await types(), ["google", "microsoft", "altimist"]);
  unready(h, "microsoft");
  assert.deepEqual(await types(), ["google", "altimist"]);
  h.cfg.signin = { providers: ["google"], trial: ["altimist"] };
  assert.deepEqual(await types(), ["google"]);
  assert.deepEqual(await (await harness().call("/api/booking/types")).json().then((b) => b.signin_providers), ["google"], "the repo's booking.json");
});

test("F-004 (US-4): start responses: unknown path 404; a known provider not launched, or launched but not ready, is a 303 to the request's own confirm page with nothing new created; on trial and ready, it starts", async () => {
  const h = launched(["google", "microsoft"], ["altimist"]);
  const r = await request(h);
  const t = h.ticketOf(r.confirm_url);
  assert.equal((await h.startSignin(t, { provider: "github" })).status, 404);
  const before = quotaRows(h);
  unready(h, "microsoft");
  h.cfg.signin = { providers: ["google", "microsoft"], trial: [] }; // altimist: neither launched nor on trial
  for (const p of ["microsoft", "altimist"]) {
    const res = await h.startSignin(t, { provider: p });
    assert.equal(res.status, 303, p);
    assert.equal(res.headers.get("location"), `/book/confirm?t=${t}&unavailable=1`, p);
    assert.equal(res.headers.get("set-cookie"), null, p);
  }
  assert.deepEqual(quotaRows(h), before, "no request allowance and no sign-in attempt taken");
  assert.deepEqual(h.rows("SELECT * FROM signin_tx"), []);
  assert.equal(h.rows("SELECT count(*) c FROM booking_requests")[0].c, 1, "the same request is reused");
  h.cfg.signin = { providers: ["google"], trial: ["altimist"] };
  const trial = await h.startSignin(t, { provider: "altimist" });
  assert.equal(trial.status, 303);
  assert.match(trial.headers.get("location"), /^https:\/\/altimist\.id\/oidc\/authorize\?/);
});

test("F-004 (US-4): an invalid, used or expired ticket is handled as F-002 handles it, whatever the provider (ready or not)", async () => {
  const h = launched(["google", "microsoft"]);
  const used = await request(h);
  await h.signInOn(used.confirm_url, {}, { provider: "microsoft" });
  const old = await request(h, ask({ start: SLOT2 }));
  for (const p of ["google", "microsoft", "altimist"]) {
    assert.equal((await h.startSignin("AAAAAAAAAAAAAAAAAAAAAA", { provider: p })).status, 404, `${p}: unknown`);
    const u = await h.startSignin(h.ticketOf(used.confirm_url), { provider: p });
    assert.match(text(await u.text()), /This call is already booked/, `${p}: used`);
  }
  h.clock.now = new Date(h.clock.now.getTime() + 61 * 60e3);
  for (const p of ["google", "microsoft", "altimist"]) {
    const e = await h.startSignin(h.ticketOf(old.confirm_url), { provider: p });
    assert.equal(e.status, 410, `${p}: expired`);
    assert.match(text(await e.text()), /This link has expired/);
  }
});

test("F-004 (US-4): the confirm page after a refused start says what to do: another provider; none ready; or, cancelling, the booking's own provider isn't available (no button)", async () => {
  const h = launched(["google", "microsoft"]);
  const r = await request(h);
  unready(h, "microsoft");
  const refused = await h.startSignin(h.ticketOf(r.confirm_url), { provider: "microsoft" });
  const other = await page(h, refused.headers.get("location"));
  assert.match(other.t, /That sign-in isn't available just now\. Choose another\./);
  assert.deepEqual(buttons(other.html), ["google"]);

  unready(h, "google");
  const none = await page(h, (await h.startSignin(h.ticketOf(r.confirm_url), { provider: "google" })).headers.get("location"));
  assert.match(none.t, /Sign-in isn't available just now\. Try again in a few minutes, or book at patrickjv\.com\/book with email instead\./);
  assert.deepEqual(buttons(none.html), []);
  assert.deepEqual(buttons((await confirmPage(h, r.confirm_url)).html), [], "the plain confirm page agrees");

  // Cancelling: the booking's provider unready while others are ready.
  ready(h, "google"); ready(h, "microsoft");
  await h.signInOn(r.confirm_url, {}, { provider: "microsoft" });
  const c = (await h.tool("cancel_booking", { booking_id: r.booking_id })).structuredContent;
  unready(h, "microsoft");
  const res = await h.startSignin(h.ticketOf(c.confirm_url), { provider: "microsoft" });
  assert.equal(res.status, 303);
  const cancelPage = await page(h, res.headers.get("location"));
  assert.match(cancelPage.t, /Microsoft sign-in isn't available just now\. Try again in a few minutes, or use the cancel link in your 'Booked' email\./);
  assert.deepEqual(buttons(cancelPage.html), [], "Google is ready, but only the booking's provider is ever offered");
  assert.equal(await status(h, r.booking_id), "confirmed");
});

test("F-004 (US-4): a provider that goes unready between rendering the page and submitting gets the 303; one that recovers after the page loads is offered on the next load", async () => {
  const h = launched(["google", "altimist"]);
  const r = await request(h);
  assert.deepEqual(buttons((await confirmPage(h, r.confirm_url)).html), ["google", "altimist"]);
  unready(h, "altimist");
  const res = await h.startSignin(h.ticketOf(r.confirm_url), { provider: "altimist" });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /^\/book\/confirm\?t=/);
  ready(h, "altimist");
  assert.deepEqual(buttons((await confirmPage(h, r.confirm_url)).html), ["google", "altimist"]);
  assert.match(text((await h.signInOn(r.confirm_url, {}, { provider: "altimist" })).html), /Booked/);
});

// ---- D7: trial ---------------------------------------------------------------------------------------

test("F-004 (D7) trial: &try=<provider> shows a trial provider's button (and Altimist ID's 'Create one') in its place; try= for a provider not on trial is ignored", async () => {
  const h = launched(["google"], ["altimist", "microsoft"]);
  const r = await request(h);
  assert.deepEqual(buttons((await confirmPage(h, r.confirm_url)).html), ["google"], "no try: launched only");
  const al = await confirmPage(h, r.confirm_url, "&try=altimist");
  assert.deepEqual(buttons(al.html), ["google", "altimist"]);
  const href = al.html.match(/<a href="([^"]*)">Create one<\/a>/)[1].replace(/&amp;/g, "&");
  assert.equal(href, `https://altimist.id/signup/self-service?app_id=patrickjv-com&return_to=${encodeURIComponent(`${r.confirm_url}&try=altimist`)}`);
  assert.match(al.html, /try%3Daltimist/);
  assert.deepEqual(buttons((await confirmPage(h, r.confirm_url, "&try=microsoft")).html), ["google", "microsoft"]);
  // Not on trial: launched, or neither.
  h.cfg.signin = { providers: ["google", "microsoft"], trial: [] };
  assert.deepEqual(buttons((await confirmPage(h, r.confirm_url, "&try=altimist")).html), ["google", "microsoft"]);
  assert.deepEqual(buttons((await confirmPage(h, r.confirm_url, "&try=github")).html), ["google", "microsoft"]);
});

test("F-004 (D7) trial: a trial provider's sign-in books and cancels; its cancel page and cancel_booking's next_step name it; it stays out of signin_providers and the general copy", async () => {
  const h = launched(["google"], ["altimist"]);
  const r = await request(h);
  assert.match(r.next_step, /sign in with Google before/);
  assert.match(text((await h.signInOn(r.confirm_url, {}, { provider: "altimist" })).html), /Booked/);
  const c = (await h.tool("cancel_booking", { booking_id: r.booking_id })).structuredContent;
  assert.equal(c.next_step, "Give this link to your person: they sign in with the same Altimist ID account they booked with to cancel.");
  const { html, t } = await confirmPage(h, c.confirm_url);
  assert.deepEqual(buttons(html), ["altimist"]);
  assert.match(t, /You booked with Altimist ID\./);
  assert.match(text((await h.signInOn(c.confirm_url, {}, { provider: "altimist" })).html), /Cancelled/);
  assert.deepEqual((await (await h.call("/api/booking/types")).json()).signin_providers, ["google"]);
  const init = await h.mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.doesNotMatch(init.result.instructions, /Altimist/);
});

// ---- D7: callbacks after a change ----------------------------------------------------------------------

test("F-004 (D7) callbacks: secrets removed mid-flow, or the provider removed from both lists, refuse the callback with state spent and the request and ticket unchanged", async () => {
  for (const change of ["secrets", "lists"]) {
    const h = launched(["google", "microsoft"]);
    const r = await request(h);
    const start = await h.startSignin(h.ticketOf(r.confirm_url), { provider: "microsoft" });
    const { code, state } = h.f.authorize(start.headers.get("location"), {}, h.clock.now);
    if (change === "secrets") unready(h, "microsoft");
    else h.cfg.signin = { providers: ["google"], trial: [] };
    const res = await h.callback({ code, state }, h.cookieOf(start), "microsoft");
    assert.equal(res.status, 503, change);
    assert.match(text(await res.text()), /Microsoft sign-in isn't available just now\. Nothing was booked\./, change);
    assert.deepEqual(h.rows("SELECT * FROM signin_tx"), [], `${change}: state consumed`);
    assert.equal(await status(h, r.booking_id), "pending_confirmation", change);
    assert.equal(h.f.calls.filter((c) => c.url.includes("/oauth2/v2.0/token")).length, 0, `${change}: no exchange`);
    assert.match(text((await h.signInOn(r.confirm_url)).html), /Booked/, `${change}: the ticket still works with Google`);
  }
  // A provider moved from launched to trial mid-flow is still enabled: its callback completes.
  const h = launched(["google", "microsoft"]);
  const r = await request(h);
  const start = await h.startSignin(h.ticketOf(r.confirm_url), { provider: "microsoft" });
  const { code, state } = h.f.authorize(start.headers.get("location"), {}, h.clock.now);
  h.cfg.signin = { providers: ["google"], trial: ["microsoft"] };
  assert.match(text(await (await h.callback({ code, state }, h.cookieOf(start), "microsoft")).text()), /Booked/);
});

test("F-004 data model: a Google transaction in flight across the deploy (an F-002 signin_tx row) completes on Google's callback", async () => {
  const h = harness();
  const r = await request(h);
  const start = await h.startSignin(h.ticketOf(r.confirm_url));
  const { code, state } = h.f.authorize(start.headers.get("location"), {}, h.clock.now);
  // As F-002 stored it: no provider column, then the new code's migrate() on the next call.
  h.run("ALTER TABLE signin_tx DROP COLUMN provider");
  const { migrate } = await import("./booking-store.js");
  migrate(h.sql);
  assert.match(text(await (await h.callback({ code, state }, h.cookieOf(start))).text()), /Booked/);
});

// ---- D7: request admission -------------------------------------------------------------------------------

test("F-004 (D7) request admission: accepted when any launched provider is ready (Google not ready, Microsoft ready: only Microsoft offered); 503 with a next_step when none is", async () => {
  const h = launched(["google", "microsoft"]);
  unready(h, "google");
  const r = await request(h);
  assert.equal(r.status, "pending_confirmation");
  assert.deepEqual(buttons((await confirmPage(h, r.confirm_url)).html), ["microsoft"]);
  unready(h, "microsoft");
  for (const res of [await h.tool("book_meeting", ask({ start: SLOT2 })), await h.call("/api/booking/request", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: ask({ start: SLOT2 }) })]) {
    const body = res.structuredContent ?? (assert.equal(res.status, 503), await res.json());
    assert.equal(body.error, "unavailable");
    assert.match(body.next_step, /book at https:\/\/patrickjv\.com\/book with email instead/);
  }
  // Trial providers don't admit requests.
  const t = launched(["google"], ["microsoft"]);
  unready(t, "google");
  assert.equal((await t.tool("book_meeting", ask())).structuredContent.error, "unavailable");
});

// ---- D5: publisher-domain verification -------------------------------------------------------------------

test("F-004 (D5): /.well-known/microsoft-identity-association.json names the Microsoft app when its client ID is set, and is 404 when it isn't", async () => {
  const h = harness();
  const res = await h.call("/.well-known/microsoft-identity-association.json");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(await res.text(), '{"associatedApplications":[{"applicationId":"3f1c9a2e-0000-4000-8000-00000000c11e"}]}');
  const off = harness({ env: { SIGNIN_MICROSOFT_CLIENT_ID: undefined } });
  assert.equal((await off.call("/.well-known/microsoft-identity-association.json")).status, 404);
  assert.equal((await h.call("/.well-known/microsoft-identity-association.json", { method: "POST" })).status, 405);
});

// ---- Health -----------------------------------------------------------------------------------------------

test("F-004 health: providers reports each enabled provider's readiness (secrets) and reachability (discovery), \"off\" otherwise; signinReady keeps its F-002 meaning", async () => {
  const health = async (h) => (await h.mcp("patrickjv/health")).result;
  const base = await health(harness());
  assert.deepEqual(base.providers, { google: { ready: true, reachable: true }, microsoft: "off", altimist: "off" });
  assert.equal(base.signinReady, true);
  const h = launched(["google", "microsoft"], ["altimist"], { fetchOpts: { fail: { discovery: ["login.microsoftonline.com"] } } });
  unready(h, "altimist");
  const r = await health(h);
  assert.deepEqual(r.providers, { google: { ready: true, reachable: true }, microsoft: { ready: true, reachable: false }, altimist: { ready: false, reachable: true } });
  assert.equal(r.signinReady, true);
  const noGoogle = launched(["google", "microsoft"]);
  unready(noGoogle, "google");
  const g = await health(noGoogle);
  assert.equal(g.signinReady, false);
  assert.deepEqual(g.providers.google, { ready: false, reachable: true });
  assert.deepEqual(g.providers.microsoft, { ready: true, reachable: true });
  assert.ok(!JSON.stringify(r).includes("secret"));
});

// ---- D8: the Worker's own pages pass the employer guard --------------------------------------------------

test("F-004 (D8): the confirm and cancel pages, with all three providers and with Altimist ID on trial, pass the build's employer guard", async () => {
  const { employerMention } = await import("../build.mjs");
  const pages = [];
  const h = launched();
  const r = await request(h);
  pages.push((await confirmPage(h, r.confirm_url)).html);
  await h.signInOn(r.confirm_url, {}, { provider: "altimist" });
  const c = (await h.tool("cancel_booking", { booking_id: r.booking_id })).structuredContent;
  pages.push((await confirmPage(h, c.confirm_url)).html);
  unready(h, "altimist");
  pages.push((await confirmPage(h, c.confirm_url)).html);
  const t = launched(["google"], ["altimist"]);
  const r2 = await request(t);
  pages.push((await confirmPage(t, r2.confirm_url, "&try=altimist")).html);
  const res = await t.call(`/book/confirm?t=${t.ticketOf(r2.confirm_url)}&try=altimist`);
  pages.push(res.headers.get("content-security-policy"));
  for (const html of pages) assert.equal(employerMention(html), null, html.slice(0, 200));
  assert.ok(pages.some((p) => p.includes("Altimist ID")), "the pages do name Altimist ID");
});

// ---- Security --------------------------------------------------------------------------------------------

test("F-004 security: the confirm page's form-action is 'self' plus exactly the enabled providers' authorisation hosts; Origin and the cookie rules apply to every provider", async () => {
  for (const [providers, trial, hosts] of [
    [["google"], [], "https://accounts.google.com"],
    [["google", "microsoft"], [], "https://accounts.google.com https://login.microsoftonline.com"],
    [["google"], ["altimist"], "https://accounts.google.com https://altimist.id"],
    [["google", "altimist"], ["microsoft"], "https://accounts.google.com https://login.microsoftonline.com https://altimist.id"],
  ]) {
    const h = launched(providers, trial);
    const r = await request(h);
    const csp = (await h.call(`/book/confirm?t=${h.ticketOf(r.confirm_url)}`)).headers.get("content-security-policy");
    assert.match(csp, new RegExp(`form-action 'self' ${hosts.replace(/\./g, "\\.")};`), JSON.stringify([providers, trial]));
  }
  const h = launched();
  const r = await request(h);
  for (const p of ["microsoft", "altimist"]) {
    for (const origin of [undefined, "null", "https://evil.example"]) {
      const res = await h.startSignin(h.ticketOf(r.confirm_url), { provider: p, headers: { origin } });
      assert.equal(res.status, 403, `${p} ${origin}`);
      assert.equal(res.headers.get("set-cookie"), null);
    }
    const res = await h.call(`/book/confirm/${p}`, { method: "GET" });
    assert.equal(res.status, 405);
    const cb = await h.call(`/book/callback/${p}?state=x&code=y`, { method: "POST" });
    assert.equal(cb.status, 405);
    const none = await h.call(`/book/callback/${p}?state=x&code=y`);
    assert.equal(none.status, 400, "no cookie, unknown state");
    assert.equal(none.headers.get("x-frame-options"), "DENY");
  }
});
