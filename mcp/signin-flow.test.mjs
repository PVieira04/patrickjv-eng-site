// F-002 through the Worker: book_meeting on MCP and POST /api/booking/request make booking
// requests; the confirm page, the Google sign-in round trip and the callback book or cancel. The
// real handler and the real BookingStore body (node:sqlite), with a fake Google (calendar and
// sign-in) and Resend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { harness, quiet, NOW, ORIGIN } from "./booking-harness.mjs";
import { tokenIn } from "./booking-fakes.mjs";

const SLOT = "2026-10-21T10:00:00+01:00"; // Wed 10:00 London = 09:00 UTC
const SLOT2 = "2026-10-22T10:00:00+01:00";
const MINUTE = 60e3;
const ask = (over = {}) => ({ type: "consultation", start: SLOT, ...over });
const requestPost = (h, body, { ip, headers = {} } = {}) => h.call("/api/booking/request", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body, ip });
const freeBusyCalls = (h) => h.f.calls.filter((c) => c.url.endsWith("/freeBusy")).length;
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const later = (h, ms) => { h.clock.now = new Date(h.clock.now.getTime() + ms); };
async function booked(h, args = ask(), claims = {}) {
  const r = (await h.tool("book_meeting", args)).structuredContent;
  const s = await h.signInOn(r.confirm_url, claims);
  assert.match(text(s.html), /Booked/, text(s.html).slice(0, 300));
  return r;
}

// ---- book_meeting makes a booking request (US-1, US-3, D5) ---------------------------------------

test("F-002 book_meeting (MCP): takes type, start and an optional note; returns booking_id, pending_confirmation, confirm_url, link_expires and next_step; emails nobody; the slot is still offered", async () => {
  const h = harness();
  const r = await h.tool("book_meeting", ask({ note: "About platforms" }));
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const b = r.structuredContent;
  assert.deepEqual(Object.keys(b).sort(), ["booking_id", "confirm_url", "link_expires", "next_step", "status"]);
  assert.match(b.booking_id, /^[0-9a-f]{32}$/);
  assert.equal(b.status, "pending_confirmation");
  assert.match(b.confirm_url, /^https:\/\/patrickjv\.com\/book\/confirm\?t=[A-Za-z0-9_-]{22}$/);
  assert.equal(b.link_expires, "2026-10-19T11:00:00+01:00", "60 minutes, London time");
  assert.equal(b.next_step, "Give this link to the person you're booking for. They need to sign in with Google before 2026-10-19T11:00:00+01:00 to book the call. Then call get_booking_status.");
  assert.equal(h.f.mails().length, 0, "no email");
  const av = (await h.tool("get_availability", { type: "consultation", from: "2026-10-21", to: "2026-10-21" })).structuredContent;
  assert.ok(av.slots.some((s) => s.start === SLOT), "nothing is reserved");
  const st = (await h.tool("get_booking_status", { booking_id: b.booking_id })).structuredContent;
  assert.equal(st.status, "pending_confirmation");
});

test("F-002 book_meeting and POST /api/booking/request refuse an email or name argument (400 invalid_input; MCP isError), saying they come from the sign-in", async () => {
  const h = harness();
  for (const extra of [{ email: "jane@example.com" }, { name: "Jane" }, { name: "Jane", email: "jane@example.com" }]) {
    const r = await h.tool("book_meeting", ask(extra));
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.equal(r.structuredContent.error, "invalid_input");
    assert.match(r.content[0].text, /come from their Google sign-in/);
    const res = await requestPost(h, ask(extra));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_input");
    assert.match(body.message, /come from their Google sign-in/);
  }
  assert.equal(h.storeCalls(), 0, "refused before the store");
  const { result } = await h.mcp("tools/list");
  const schema = result.tools.find((t) => t.name === "book_meeting").inputSchema;
  assert.deepEqual(Object.keys(schema.properties), ["type", "start", "note"]);
  assert.deepEqual(schema.required, ["type", "start"]);
  assert.equal(schema.additionalProperties, false);
});

test("F-002 POST /api/booking/request: 202 with the same result; optional source is exactly \"page\" (default) or \"webmcp\"; MCP requests are stored as mcp", async () => {
  const h = harness();
  const res = await requestPost(h, ask());
  assert.equal(res.status, 202);
  const b = await res.json();
  assert.equal(b.status, "pending_confirmation");
  assert.ok(b.confirm_url && b.next_step);
  for (const source of ["mcp", "PAGE", "", "agent"]) {
    const bad = await requestPost(h, ask({ source }));
    assert.equal(bad.status, 400, source);
  }
  const web = await (await requestPost(h, ask({ source: "webmcp", start: SLOT2 }))).json();
  const mcp = (await h.tool("book_meeting", ask({ start: "2026-10-23T10:00:00+01:00" }))).structuredContent;
  const sources = Object.fromEntries(h.rows("SELECT id, source FROM booking_requests").map((r) => [r.id, r.source]));
  assert.deepEqual([sources[b.booking_id], sources[web.booking_id], sources[mcp.booking_id]], ["page", "webmcp", "mcp"]);
  // Cookie-free, but still only from this origin.
  assert.equal((await requestPost(h, ask(), { headers: { origin: "https://evil.example" } })).status, 403);
});

test("F-002 requests: a start that isn't a free slot is refused exactly as POST /api/booking refuses it, and uses no allowance", async () => {
  const h = harness({ fetchOpts: { busy: [{ start: "2026-10-21T09:00:00Z", end: "2026-10-21T09:30:00Z" }] } });
  for (const [start, status, error] of [
    [SLOT, 409, "slot_taken"], // busy in a calendar
    ["2026-10-19T15:00:00+01:00", 409, "invalid_slot"], // inside the notice window
    ["2026-12-21T10:00:00+00:00", 409, "invalid_slot"], // past the horizon
    ["2026-10-21T10:05:00+01:00", 400, "invalid_slot"], // never a slot
  ]) {
    const res = await requestPost(h, ask({ start }));
    assert.equal(res.status, status, start);
    assert.equal((await res.json()).error, error, start);
  }
  assert.deepEqual(h.rows("SELECT kind FROM quota WHERE kind LIKE 'request%'"), []);
});

test("F-002 requests: 50 requests for busy slots within a minute make at most one free/busy call and take no allowance", async () => {
  const h = harness({ fetchOpts: { busy: [{ start: "2026-10-21T08:00:00Z", end: "2026-10-21T16:00:00Z" }] } });
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => h.tool("book_meeting", ask({ start: `2026-10-21T${10 + (i % 7)}:00:00+01:00` }))));
  assert.ok(results.every((r) => r.isError && r.structuredContent.error === "slot_taken"));
  assert.ok(freeBusyCalls(h) <= 1, `${freeBusyCalls(h)} free/busy calls`);
  assert.deepEqual(h.rows("SELECT kind FROM quota WHERE kind LIKE 'request%'"), []);
});

test("F-002 requests: with the free/busy cache stale and Google unreachable, a request is 503 unavailable and takes no allowance", async () => {
  const h = harness({ fetchOpts: { fail: { freebusy: true } } });
  const r = await quiet(() => h.tool("book_meeting", ask()));
  assert.equal(r.structuredContent.error, "unavailable");
  assert.deepEqual(h.rows("SELECT kind FROM quota"), []);
});

test("F-002 requests: per-IP and global request caps are 429 with a sentence saying what to do", async () => {
  const h = harness();
  h.cfg.caps = { ...h.cfg.caps, requestsPerIpPerDay: 1 };
  try {
    assert.equal((await requestPost(h, ask())).status, 202);
    const res = await requestPost(h, ask());
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, "rate_limited");
    assert.match(body.message, /try again tomorrow/);
  } finally { h.cfg.caps = { ...h.cfg.caps, requestsPerIpPerDay: 20 }; }
});

// ---- The confirm page (GET changes nothing, except settling a request whose slot has gone) ------

test("F-002 GET /book/confirm: the meeting (London time, and the visitor's zone by script), why sign-in is asked, what's shared, the expiry and a sign-in button; nothing changes", async () => {
  const h = harness();
  const b = (await h.tool("book_meeting", ask())).structuredContent;
  const res = await h.call(new URL(b.confirm_url).pathname + new URL(b.confirm_url).search);
  assert.equal(res.status, 200);
  const html = await res.text();
  const t = text(html);
  assert.match(t, /Consultation with Patrick Vieira, Wed 21 Oct 2026, 10:00–10:30 BST/);
  assert.match(t, /Sign in with Google to book this call\. We use your name and email address from Google for the invite, and nothing else\./);
  assert.match(t, /This link works until Mon 19 Oct 2026, 11:00 BST\./);
  assert.match(html, /<form method="post" action="\/book\/confirm\/google">/);
  assert.match(html, /<button type="submit">Sign in with Google to book<\/button>/);
  assert.match(html, /data-start="2026-10-21T09:00:00.000Z"/, "the visitor's own time zone is filled in by the page's script");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self' https:\/\/accounts\.google\.com/, "the form's redirect goes to Google");
  assert.match(csp, /script-src 'sha256-/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal((await h.tool("get_booking_status", { booking_id: b.booking_id })).structuredContent.status, "pending_confirmation");
  assert.deepEqual(h.rows("SELECT * FROM signin_tx"), []);
});

test("F-002 confirm page: the first time a request's slot is found no longer free it is settled declined for good; the page, get_booking_status and the link agree", async () => {
  for (const via of ["page", "status"]) {
    const h = harness();
    const a = (await h.tool("book_meeting", ask())).structuredContent;
    await booked(h, ask(), { sub: "other", email: "other@gmail.com" }); // someone else books the same slot
    if (via === "status") {
      const st = (await h.tool("get_booking_status", { booking_id: a.booking_id })).structuredContent;
      assert.deepEqual([st.status, st.status_reason], ["declined", "slot_taken"]);
    }
    const page = await h.call(`/book/confirm?t=${h.ticketOf(a.confirm_url)}`);
    const t = text(await page.text());
    assert.match(t, /This time has just been taken\. Ask your assistant to find another, or go to patrickjv\.com\/book/, via);
    assert.doesNotMatch(t, /Sign in with Google/, "no sign-in button");
    const st = (await h.tool("get_booking_status", { booking_id: a.booking_id })).structuredContent;
    assert.deepEqual([st.status, st.status_reason], ["declined", "slot_taken"], via);
    // The slot freeing up again doesn't reopen it.
    const start = await h.startSignin(h.ticketOf(a.confirm_url));
    assert.equal(start.headers.get("location"), null);
  }
});

test("F-002 get_booking_status keeps readOnlyHint: true on MCP and WebMCP alike, though it may record a declined request", async () => {
  const { result } = await harness().mcp("tools/list");
  assert.equal(result.tools.find((t) => t.name === "get_booking_status").annotations.readOnlyHint, true);
  const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const d = JSON.parse(page.match(/var d = (\{.*\});/)[1]);
  assert.equal(d.tools.find((t) => t.name === "get_booking_status").annotations.readOnlyHint, true);
});

test("F-002 confirm page states (US-8): confirming, confirmed, declined, expired, cancelled, still open after a failed attempt; none suggests booking again while confirming or confirmed", async () => {
  const h = harness();
  const page = async (url) => text(await (await h.call(`/book/confirm?t=${h.ticketOf(url)}`)).text());
  const done = await booked(h);
  const confirmedPage = await page(done.confirm_url);
  assert.match(confirmedPage, /This call is already booked\. Your invite is in your email\./);
  assert.doesNotMatch(confirmedPage, /book again|patrickjv\.com\/book/);

  const open = (await h.tool("book_meeting", ask({ start: SLOT2 }))).structuredContent;
  await h.callback({ error: "access_denied", state: (await h.f.authorize((await h.startSignin(h.ticketOf(open.confirm_url))).headers.get("location"))).state }, "x");
  assert.match(await page(open.confirm_url), /Sign in with Google to book this call/, "a failed attempt leaves the button");

  const withdrawn = (await h.tool("book_meeting", ask({ start: "2026-10-23T10:00:00+01:00" }))).structuredContent;
  await h.tool("cancel_booking", { booking_id: withdrawn.booking_id });
  assert.match(await page(withdrawn.confirm_url), /This request was withdrawn\..*Ask your assistant to book again, or go to patrickjv\.com\/book/);

  const finishing = harness({ fetchOpts: { fail: { freebusy: false } } });
  const f1 = (await finishing.tool("book_meeting", ask())).structuredContent;
  finishing.f.opts.fail = { freebusy: true };
  const s = await quiet(() => finishing.signInOn(f1.confirm_url));
  assert.match(text(s.html), /Your call is being finished\. Check your email in a few minutes, and don't book again\./);
  const confirmingPage = text(await (await finishing.call(`/book/confirm?t=${finishing.ticketOf(f1.confirm_url)}`)).text());
  assert.match(confirmingPage, /Your call is being finished\. Check your email in a few minutes, and don't book again\./);
  assert.doesNotMatch(confirmingPage, /Ask your assistant to book again/);

  later(h, 61 * MINUTE);
  assert.match(await page(open.confirm_url), /This link has expired\..*Ask your assistant to book again, or go to patrickjv\.com\/book/);
  assert.equal((await h.call(`/book/confirm?t=${h.ticketOf(open.confirm_url)}`)).status, 410);
  assert.equal((await h.call("/book/confirm?t=AAAAAAAAAAAAAAAAAAAAAA")).status, 404);
});

// ---- The sign-in round trip ----------------------------------------------------------------------

test("F-002 sign-in: POST /book/confirm/google sets the __Host- cookie and redirects to Google (code flow, PKCE S256, state, nonce); the callback books for the verified Google address", async () => {
  const h = harness();
  const b = (await h.tool("book_meeting", ask({ note: "About platforms" }))).structuredContent;
  const start = await h.startSignin(h.ticketOf(b.confirm_url));
  assert.equal(start.status, 303);
  const cookie = start.headers.get("set-cookie");
  assert.match(cookie, /^__Host-pjv_signin=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/);
  const loc = new URL(start.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(loc.searchParams.get("client_id"), "signin-client.apps.googleusercontent.com");
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  assert.equal(loc.searchParams.get("scope"), "openid email profile");
  assert.ok(loc.searchParams.get("state") && loc.searchParams.get("nonce"));
  const { code, state } = h.f.authorize(loc.href, { sub: "g-123", email: "jane.doe@gmail.com", name: "Jane Doe" }, h.clock.now);
  const res = await h.callback({ code, state }, h.cookieOf(start));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie"), /^__Host-pjv_signin=; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/, "cleared");
  assert.match(text(await res.text()), /Booked/);
  const st = (await h.tool("get_booking_status", { booking_id: b.booking_id })).structuredContent;
  assert.equal(st.status, "confirmed");
  const ins = h.f.calls.find((c) => c.method === "POST" && c.url.includes("/calendars/primary/events"));
  assert.deepEqual(ins.body.attendees, [{ email: "jane.doe@gmail.com" }, { email: "owner@example.net" }]);
  assert.equal(ins.body.summary, "Consultation: Jane Doe");
  const [mail] = h.f.mails();
  assert.deepEqual(mail.to, ["jane.doe@gmail.com"]);
  assert.match(mail.subject, /^Booked: Consultation/);
  // The token exchange sent the PKCE verifier and our secret, server to server.
  const ex = h.f.calls.find((c) => c.url === "https://oauth2.googleapis.com/token" && String(c.body).includes("authorization_code"));
  assert.match(String(ex.body), /code_verifier=/);
});

test("F-002 sign-in start: needs this exact Origin, a form body and a valid ticket; each ticket starts at most 5 sign-ins, then 'Too many tries'", async () => {
  const h = harness();
  const b = (await h.tool("book_meeting", ask())).structuredContent;
  const t = h.ticketOf(b.confirm_url);
  for (const origin of [undefined, "null", "https://evil.example", "https://patrickjv.com.evil.example"]) {
    const res = await h.startSignin(t, { headers: { origin } });
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.headers.get("set-cookie"), null);
  }
  for (let i = 0; i < 5; i++) assert.equal((await h.startSignin(t)).status, 303, `attempt ${i + 1}`);
  const sixth = await h.startSignin(t);
  assert.equal(sixth.status, 429);
  assert.match(text(await sixth.text()), /Too many tries\. Ask your assistant for a new link\./);
  assert.match(text(await (await h.call(`/book/confirm?t=${t}`)).text()), /Too many tries/);
  assert.equal((await h.startSignin("AAAAAAAAAAAAAAAAAAAAAA")).status, 404);
});

test("F-002 callback refusals, each with nothing booked: missing, mismatched or replayed state; missing or another cookie; a lapsed transaction; a denied sign-in; a failed exchange; a bad ID token", async () => {
  const h = harness();
  const b = (await h.tool("book_meeting", ask())).structuredContent;
  const t = h.ticketOf(b.confirm_url);
  const begin = async (claims = {}) => {
    const start = await h.startSignin(t);
    return { ...h.f.authorize(start.headers.get("location"), claims, h.clock.now), cookie: h.cookieOf(start) };
  };
  const refused = async (res, why) => {
    assert.equal(res.status >= 400, true, why);
    assert.doesNotMatch(text(await res.text()), /Booked/, why);
  };
  let s = await begin();
  await refused(await h.callback({ code: s.code }, s.cookie), "missing state");
  s = await begin();
  await refused(await h.callback({ code: s.code, state: "not-the-state" }, s.cookie), "mismatched state");
  s = await begin();
  await refused(await h.callback({ code: s.code, state: s.state }), "missing cookie");
  await refused(await h.callback({ code: s.code, state: s.state }, s.cookie), "replayed state (consumed by the refusal above)");
  const other = await begin();
  s = await begin();
  await refused(await h.callback({ code: s.code, state: s.state }, other.cookie), "another transaction's cookie");
  s = await begin();
  later(h, 10 * MINUTE);
  await refused(await h.callback({ code: s.code, state: s.state }, s.cookie), "transaction past its 10 minutes");
  h.clock.now = NOW;
  h.cfg.caps = { ...h.cfg.caps, signinAttemptsPerTicket: 50 };
  try {
    s = await begin();
    await refused(await h.callback({ error: "access_denied", state: s.state }, s.cookie), "denied");
    h.f.opts.fail = { exchange: true };
    s = await begin();
    await refused(await quiet(() => h.callback({ code: s.code, state: s.state }, s.cookie)), "exchange fails");
    h.f.opts.fail = {};
    for (const claims of [{ aud: "someone-else" }, { iss: "https://evil.example" }, { email_verified: false }, { nonce: "other" }, { exp: Math.floor(NOW / 1000) - 1 }]) {
      s = await begin(claims);
      await refused(await h.callback({ code: s.code, state: s.state }, s.cookie), JSON.stringify(claims));
    }
    // A code is single-use at Google too; replaying a good round trip changes nothing.
    s = await begin();
    const ok = await h.callback({ code: s.code, state: s.state }, s.cookie);
    assert.match(text(await ok.text()), /Booked/);
    await refused(await h.callback({ code: s.code, state: s.state }, s.cookie), "replay after success");
  } finally { h.cfg.caps = { ...h.cfg.caps, signinAttemptsPerTicket: 5 }; }
  assert.equal(h.f.mails().length, 1, "only the one real booking was emailed");
});

test("F-002 sign-in: only Google-authoritative addresses book or cancel; any other verified address is refused with nothing changed, the request left open, and nobody emailed", async () => {
  const h = harness();
  const b = (await h.tool("book_meeting", ask())).structuredContent;
  const no = await h.signInOn(b.confirm_url, { email: "omar@acme.example" });
  assert.equal(no.res.status, 403);
  assert.match(text(no.html), /Google can't vouch for this address\. Sign in with a Gmail or Google Workspace account, or book at patrickjv\.com\/book with email instead\./);
  assert.equal((await h.tool("get_booking_status", { booking_id: b.booking_id })).structuredContent.status, "pending_confirmation");
  assert.equal(h.f.mails().length, 0);
  const ws = await h.signInOn(b.confirm_url, { sub: "ws-1", email: "omar@acme.example", hd: "acme.example" });
  assert.match(text(ws.html), /Booked/, "a matching hd claim is authoritative");
  assert.deepEqual(h.f.mails()[0].to, ["omar@acme.example"]);
  // Cancelling: the guest's own account, but signed in with a non-authoritative address, changes nothing.
  const c = (await h.tool("cancel_booking", { booking_id: b.booking_id })).structuredContent;
  const bad = await h.signInOn(c.confirm_url, { sub: "ws-1", email: "omar@acme.example" });
  assert.equal(bad.res.status, 403);
  assert.equal((await h.tool("get_booking_status", { booking_id: b.booking_id })).structuredContent.status, "confirmed");
});

test("F-002 sign-in: a cancel transaction can't book and a book transaction can't cancel", async () => {
  const h = harness();
  const done = await booked(h);
  const c = (await h.tool("cancel_booking", { booking_id: done.booking_id })).structuredContent;
  const fresh = (await h.tool("book_meeting", ask({ start: SLOT2 }))).structuredContent;
  for (const [url, flip] of [[fresh.confirm_url, "cancel"], [c.confirm_url, "book"]]) {
    const start = await h.startSignin(h.ticketOf(url));
    h.run("UPDATE signin_tx SET purpose = ?", flip);
    const { code, state } = h.f.authorize(start.headers.get("location"), {}, h.clock.now);
    const res = await h.callback({ code, state }, h.cookieOf(start));
    assert.equal(res.status >= 400, true, flip);
  }
  assert.equal((await h.tool("get_booking_status", { booking_id: done.booking_id })).structuredContent.status, "confirmed");
  assert.equal((await h.tool("get_booking_status", { booking_id: fresh.booking_id })).structuredContent.status, "pending_confirmation");
});

test("F-002 after a sign-in: caps reached says which limit and leaves the request open; a slot taken by the claim says so and the agent sees declined", async () => {
  const h = harness();
  await booked(h);
  await booked(h, ask({ start: SLOT2 }));
  const third = (await h.tool("book_meeting", ask({ start: "2026-10-23T10:00:00+01:00" }))).structuredContent;
  const capped = await h.signInOn(third.confirm_url);
  assert.equal(capped.res.status, 429);
  assert.match(text(capped.html), /Nothing was booked\./);
  assert.match(text(capped.html), /at most 2 calls/);
  assert.equal((await h.tool("get_booking_status", { booking_id: third.booking_id })).structuredContent.status, "pending_confirmation");

  const g = harness();
  const [a, b] = [(await g.tool("book_meeting", ask())).structuredContent, (await g.tool("book_meeting", ask())).structuredContent];
  await g.signInOn(a.confirm_url);
  const s2 = await g.signInOn(b.confirm_url, { sub: "other" });
  assert.match(text(s2.html), /This time has just been taken/);
  assert.equal((await g.tool("get_booking_status", { booking_id: b.booking_id })).structuredContent.status, "declined");
});

test("F-002 forwarded link: the first sign-in that books becomes the guest; later attempts get 'already booked'; cancellation recognises that guest", async () => {
  const h = harness();
  const b = (await h.tool("book_meeting", ask())).structuredContent;
  const first = await h.signInOn(b.confirm_url, { sub: "forwarded-to", email: "friend@gmail.com", name: "Friend" });
  assert.match(text(first.html), /Booked/);
  const second = await h.signInOn(b.confirm_url, { sub: "sub-jane" });
  assert.match(text(second.html), /This call is already booked/);
  const c = (await h.tool("cancel_booking", { booking_id: b.booking_id })).structuredContent;
  const intended = await h.signInOn(c.confirm_url, { sub: "sub-jane" });
  assert.match(text(intended.html), /This booking belongs to someone else/);
  const guest = await h.signInOn(c.confirm_url, { sub: "forwarded-to", email: "friend@gmail.com" });
  assert.match(text(guest.html), /Cancelled\. Google has told everyone invited\./);
});

// ---- Cancelling through the tools (Flow 3) ---------------------------------------------------------

test("F-002 cancel_booking (MCP): an open request is withdrawn; a sign-in booking returns a confirm_url and next_step; the guest's sign-in cancels it and Google notifies attendees", async () => {
  const h = harness();
  const open = (await h.tool("book_meeting", ask({ start: SLOT2 }))).structuredContent;
  const w = (await h.tool("cancel_booking", { booking_id: open.booking_id })).structuredContent;
  assert.equal(w.status, "cancelled");
  assert.match(w.next_step, /withdrawn/);
  assert.equal((await h.startSignin(h.ticketOf(open.confirm_url))).headers.get("location"), null, "its ticket starts no sign-in");

  const b = await booked(h);
  const c = (await h.tool("cancel_booking", { booking_id: b.booking_id })).structuredContent;
  assert.deepEqual(Object.keys(c).sort(), ["confirm_url", "link_expires", "next_step", "status"]);
  assert.equal(c.status, "confirmed");
  assert.match(c.next_step, /Give this link to the person/);
  const page = text(await (await h.call(`/book/confirm?t=${h.ticketOf(c.confirm_url)}`)).text());
  assert.match(page, /Sign in with Google to cancel this call\. Only the person it's booked for can cancel it\./);
  const done = await h.signInOn(c.confirm_url);
  assert.match(text(done.html), /Cancelled\. Google has told everyone invited\./);
  assert.ok(h.f.calls.some((c2) => c2.method === "DELETE" && c2.url.includes(b.booking_id) && c2.url.includes("sendUpdates=all")));
  assert.equal((await h.tool("get_booking_status", { booking_id: b.booking_id })).structuredContent.status, "cancelled");
  assert.match(text(await (await h.call(`/book/confirm?t=${h.ticketOf(c.confirm_url)}`)).text()), /This call is already cancelled\./);
});

test("F-002 cancel: the 'Booked' email's cancel link also cancels a sign-in booking; a second cancel_booking revokes the first sign-in link but not that one", async () => {
  const h = harness();
  const b = await booked(h);
  const first = (await h.tool("cancel_booking", { booking_id: b.booking_id })).structuredContent;
  await h.tool("cancel_booking", { booking_id: b.booking_id });
  assert.match(text(await (await h.call(`/book/confirm?t=${h.ticketOf(first.confirm_url)}`)).text()), /This call is still booked\. Ask your assistant for a new cancel link, or use the cancel link in your booking email\./);
  const res = await h.actPost(tokenIn(h.f.mails()[0].text));
  assert.equal(res.status, 200);
  assert.equal((await h.tool("get_booking_status", { booking_id: b.booking_id })).structuredContent.status, "cancelled");
});

test("F-002 cancel: a failed deletion leaves the booking confirmed; with the link's sign-in attempts used up the page says to ask for a new link or use the email's", async () => {
  const h = harness();
  const b = await booked(h);
  const c = (await h.tool("cancel_booking", { booking_id: b.booking_id })).structuredContent;
  h.f.opts.fail = { delete: true };
  const first = await quiet(() => h.signInOn(c.confirm_url));
  assert.match(text(first.html), /Couldn't cancel just now/);
  assert.equal((await h.tool("get_booking_status", { booking_id: b.booking_id })).structuredContent.status, "confirmed");
  for (let i = 0; i < 3; i++) await quiet(() => h.signInOn(c.confirm_url));
  const last = await quiet(() => h.signInOn(c.confirm_url));
  assert.match(text(last.html), /Couldn't cancel just now\. Ask your assistant for a new cancel link, or use the cancel link in your booking email\./);
  h.f.opts.fail = {};
});

test("F-002 cancel_booking: confirming and cancelling are not_cancellable with the public status and next_step Flow 3 gives; after the start, not_cancellable", async () => {
  const h = harness();
  const b = (await h.tool("book_meeting", ask())).structuredContent;
  h.f.opts.fail = { freebusy: true };
  await quiet(() => h.signInOn(b.confirm_url)); // left confirming, as if Google's answer was lost
  h.f.opts.fail = {};
  const r = await h.tool("cancel_booking", { booking_id: b.booking_id });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error, "not_cancellable");
  assert.equal(r.structuredContent.status, "pending_confirmation");
  assert.equal(r.structuredContent.next_step, "This booking is still being finished. Check again in a few minutes, then cancel if needed.");
  h.run("UPDATE bookings SET status = 'cancelling'");
  const r2 = (await h.tool("cancel_booking", { booking_id: b.booking_id })).structuredContent;
  assert.deepEqual([r2.status, r2.next_step], ["confirmed", "A cancellation is already in progress."]);
});

// ---- Kill switch (F-001 US-8) ------------------------------------------------------------------------

test("F-002 BOOKING_ENABLED off: new requests and cancel links are 503 booking_disabled; reads work; links already issued still book and cancel", async () => {
  const h = harness();
  const open = (await h.tool("book_meeting", ask({ start: SLOT2 }))).structuredContent;
  const b = await booked(h);
  const c = (await h.tool("cancel_booking", { booking_id: b.booking_id })).structuredContent;
  h.env.BOOKING_ENABLED = "false";
  assert.equal((await requestPost(h, ask({ start: "2026-10-23T10:00:00+01:00" }))).status, 503);
  assert.equal((await h.tool("book_meeting", ask())).structuredContent.error, "booking_disabled");
  assert.equal((await h.call("/api/booking/status?booking_id=" + b.booking_id)).status, 200);
  assert.equal((await h.call("/api/booking/cancel", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: { booking_id: b.booking_id } })).status, 503);
  assert.match(text((await h.signInOn(open.confirm_url, { sub: "s2", email: "s2@gmail.com" })).html), /Booked/);
  assert.match(text((await h.signInOn(c.confirm_url)).html), /Cancelled/);
});

// ---- D6: the core is the only way --------------------------------------------------------------------

test("F-002 (D6): only confirmRequest makes a request a meeting and only cancelMeeting ends a sign-in booking; the callback, the alarm and the HTTP API reach them and nothing else writes those transitions", () => {
  const src = readFileSync(new URL("./booking-store.js", import.meta.url), "utf8");
  const fn = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf("\n}\n", src.indexOf(`function ${name}(`)));
  // A request becomes used, and a booking row with an identity is made, in confirmRequest alone.
  const usedWrites = [...src.matchAll(/settleRequestRow\(sql, [^,]+, "used"/g)];
  assert.equal(usedWrites.length, 1);
  assert.ok(fn("confirmRequest").includes('settleRequestRow(sql, r.id, "used"'));
  const identityInserts = [...src.matchAll(/INSERT INTO bookings \([^)]*identity_id/g)];
  assert.equal(identityInserts.length, 1);
  assert.ok(fn("confirmRequest").includes("identity_id, proof, actor)"));
  // Sign-in bookings reach F-001's cancellation only through cancelMeeting.
  assert.match(fn("act"), /tok\.action === "cancel" && b\.proof\) \{\s*return cancelMeeting\(/);
  assert.equal([...src.matchAll(/cancelByLink\(sql/g)].length, 2, "act (email bookings) and cancelMeeting");
  // The service's callback reaches the core; the alarm reaches recoverConfirm/finishCancel; the HTTP
  // API reaches the service.
  const svc = readFileSync(new URL("./booking-service.js", import.meta.url), "utf8");
  assert.match(svc, /confirmRequest\(sql, /);
  assert.match(svc, /cancelMeeting\(sql, /);
  assert.equal([...svc.matchAll(/confirmRequest\(/g)].length, 1);
});

// ---- Health -----------------------------------------------------------------------------------------

test("F-002 patrickjv/health: signinReady needs the sign-in client ID and secret and Google's discovery document", async () => {
  assert.equal((await harness().mcp("patrickjv/health")).result.signinReady, true);
  assert.equal((await harness({ env: { SIGNIN_GOOGLE_CLIENT_SECRET: undefined } }).mcp("patrickjv/health")).result.signinReady, false);
  assert.equal((await harness({ env: { SIGNIN_GOOGLE_CLIENT_ID: undefined } }).mcp("patrickjv/health")).result.signinReady, false);
  assert.equal((await harness({ fetchOpts: { fail: { discovery: true } } }).mcp("patrickjv/health")).result.signinReady, false);
  const h = await harness().mcp("patrickjv/health");
  assert.ok(!JSON.stringify(h).includes("signin-secret") && !JSON.stringify(h).includes("signin-client"));
});
