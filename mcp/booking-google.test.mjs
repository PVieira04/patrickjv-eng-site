// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoogle, GoogleError, assertNoErrors, meetLinkOf } from "./booking-google.js";

const API = "https://www.googleapis.com/calendar/v3";

// A fetch stand-in. `routes` is a list of [method, urlPattern, reply]; reply is a response spec
// ({status, body}), a list of them served in order (the last one repeats), or a function of the
// recorded call. Every call is recorded; an unrouted call fails the test.
function fakeFetch(routes) {
  const calls = [];
  const served = new Map();
  const f = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body, signal: init.signal };
    calls.push(call);
    const route = routes.find(([m, re]) => m === call.method && re.test(call.url));
    if (!route) throw new Error(`unexpected request: ${call.method} ${call.url}`);
    let reply = route[2];
    if (Array.isArray(reply)) {
      const n = served.get(route) || 0;
      served.set(route, n + 1);
      reply = reply[Math.min(n, reply.length - 1)];
    }
    if (typeof reply === "function") reply = reply(call);
    const status = reply.status ?? 200;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

const tokenOk = (n = 1) => ({ body: { access_token: `at-${n}`, expires_in: 3599, token_type: "Bearer" } });

// A client with a movable clock and recorded sleeps.
function client(routes, { start = "2026-10-08T12:00:00Z" } = {}) {
  const fetch = fakeFetch(routes);
  let t = Date.parse(start);
  const sleeps = [];
  const g = createGoogle({
    clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken", fetch,
    now: () => new Date(t), sleep: async (ms) => { sleeps.push(ms); },
  });
  return { g, fetch, sleeps, advance: (ms) => { t += ms; } };
}

test("accessToken: refreshes with the stored refresh token and caches until 60 s before expiry", async () => {
  let n = 0;
  const { g, fetch, advance } = client([["POST", /^https:\/\/oauth2\.googleapis\.com\/token$/, () => tokenOk(++n)]]);
  assert.equal(await g.accessToken(), "at-1");
  const form = new URLSearchParams(fetch.calls[0].body);
  assert.deepEqual(Object.fromEntries(form), { client_id: "cid", client_secret: "csecret", refresh_token: "rtoken", grant_type: "refresh_token" });
  advance((3599 - 61) * 1000);
  assert.equal(await g.accessToken(), "at-1", "still cached 61 s before expiry");
  assert.equal(fetch.calls.length, 1);
  advance(2000);
  assert.equal(await g.accessToken(), "at-2", "refreshed inside the last 60 s");
  assert.equal(fetch.calls.length, 2);
});

test("accessToken: invalid_grant (revoked token) throws GoogleError with status and reason, and no secrets", async () => {
  const { g } = client([["POST", /oauth2/, { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }]]);
  const e = await g.accessToken().catch((x) => x);
  assert.ok(e instanceof GoogleError, String(e));
  assert.equal(e.status, 400);
  assert.equal(e.reason, "invalid_grant");
  assert.doesNotMatch(e.message, /rtoken|csecret/);
});

test("accessToken: a 200 without an access_token is a failure, not a token", async () => {
  const { g } = client([["POST", /oauth2/, { body: { error: "weird" } }]]);
  await assert.rejects(g.accessToken(), GoogleError);
});

test("ping (health): true when a refresh succeeds, false when it fails; always refreshes", async () => {
  const ok = client([["POST", /oauth2/, tokenOk()]]);
  await ok.g.accessToken();
  assert.equal(await ok.g.ping(), true);
  assert.equal(ok.fetch.calls.length, 2, "ping refreshes even with a cached token, so a revoked token shows");
  const bad = client([["POST", /oauth2/, { status: 400, body: { error: "invalid_grant" } }]]);
  assert.equal(await bad.g.ping(), false);
  const down = client([["POST", /oauth2/, () => { throw new TypeError("network down"); }]]);
  assert.equal(await down.g.ping(), false);
});

test("freeBusy: one freebusy.query for all calendars; busy merged and sorted as UTC ISO; bearer token sent", async () => {
  const { g, fetch } = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /\/calendar\/v3\/freeBusy$/, { body: { calendars: {
      "a@example.com": { busy: [{ start: "2026-10-26T13:00:00Z", end: "2026-10-26T14:00:00Z" }, { start: "2026-10-26T10:00:00Z", end: "2026-10-26T10:30:00Z" }] },
      primary: { busy: [{ start: "2026-10-26T10:15:00Z", end: "2026-10-26T11:00:00Z" }, { start: "2026-10-26T14:00:00Z", end: "2026-10-26T14:30:00Z" }] },
    } } }],
  ]);
  const r = await g.freeBusy(["a@example.com", "primary"], "2026-10-26T00:00:00.000Z", "2026-10-27T00:00:00.000Z");
  assert.deepEqual(r, {
    busy: [
      { start: "2026-10-26T10:00:00.000Z", end: "2026-10-26T11:00:00.000Z" }, // overlapping blocks merged
      { start: "2026-10-26T13:00:00.000Z", end: "2026-10-26T14:30:00.000Z" }, // touching blocks merged
    ],
    errors: [],
  });
  const q = fetch.calls[1];
  assert.equal(q.url, `${API}/freeBusy`);
  assert.equal(q.headers.authorization, "Bearer at-1");
  assert.deepEqual(JSON.parse(q.body), { timeMin: "2026-10-26T00:00:00.000Z", timeMax: "2026-10-27T00:00:00.000Z", items: [{ id: "a@example.com" }, { id: "primary" }] });
});

test("freeBusy: a calendar error (or a missing calendar) is reported, and assertNoErrors refuses the result", async () => {
  const { g } = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /freeBusy$/, { body: { calendars: {
      "a@example.com": { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
      primary: { busy: [{ start: "2026-10-26T10:00:00Z", end: "2026-10-26T10:30:00Z" }] },
    } } }],
  ]);
  const r = await g.freeBusy(["a@example.com", "primary", "b@example.com"], "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z");
  assert.deepEqual(r.errors, [{ calendar: "a@example.com", reason: "notFound" }, { calendar: "b@example.com", reason: "missing" }]);
  assert.equal(r.busy.length, 1);
  const e = (() => { try { assertNoErrors(r); } catch (x) { return x; } })();
  assert.ok(e instanceof GoogleError);
  assert.equal(e.reason, "notFound");
  // Calendar IDs of personal calendars are email addresses (secrets): never in the message.
  assert.doesNotMatch(e.message, /@/);
  assert.doesNotThrow(() => assertNoErrors({ busy: [], errors: [] }));
});

test("freeBusy: an HTTP error throws GoogleError with Google's reason", async () => {
  const { g } = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /freeBusy$/, { status: 403, body: { error: { code: 403, message: "Forbidden", errors: [{ reason: "insufficientPermissions" }] } } }],
  ]);
  const e = await g.freeBusy(["primary"], "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z").catch((x) => x);
  assert.ok(e instanceof GoogleError);
  assert.deepEqual([e.status, e.reason], [403, "insufficientPermissions"]);
});

test("free/busy only: the client has no method that lists events, or reads any but its own by ID", () => {
  const { g } = client([]);
  const allowed = ["accessToken", "freeBusy", "insertEvent", "getEvent", "deleteEvent", "ping"];
  assert.equal(typeof g.freeBusy, "function");
  for (const k of Object.keys(g)) assert.ok(allowed.includes(k), `unexpected method ${k}`);
});

const ID = "0123456789abcdef0123456789abcdef";
const EVENT = {
  id: ID, summary: "Consultation: Jane Smith", description: "Booked via patrickjv.com.",
  start: "2026-10-26T10:00:00.000Z", end: "2026-10-26T10:30:00.000Z", timeZone: "Europe/London",
  attendees: ["patrick@example.org", "jane@example.com"],
};
const MEET = "https://meet.google.com/abc-defg-hij";
const eventBody = (statusCode, link) => ({ body: {
  id: ID, ...(link ? { hangoutLink: link } : {}),
  conferenceData: { createRequest: { requestId: ID, status: { statusCode } } },
} });
const EVENT_URL = new RegExp(`/calendars/primary/events/${ID}$`);

test("insertEvent: on hello@'s primary calendar, Patrick and the guest invited, Meet requested, invites sent", async () => {
  const { g, fetch } = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /\/calendars\/primary\/events\?/, eventBody("success", MEET)],
  ]);
  assert.deepEqual(await g.insertEvent(EVENT), { created: true, meetLink: MEET });
  const ins = fetch.calls[1];
  // "primary" with hello@'s token: hello@ is the organiser, so guests never see Patrick's address as organiser.
  assert.equal(ins.url, `${API}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`);
  assert.equal(ins.headers.authorization, "Bearer at-1");
  const b = JSON.parse(ins.body);
  assert.equal(b.id, ID, "the booking ID is the event ID, so a retry is a 409, not a second event");
  assert.equal(b.summary, "Consultation: Jane Smith", "the title is passed through as given");
  assert.equal(b.description, EVENT.description);
  // With the zone named, Google shows invites in London time ("2pm (British Summer Time)"), not UTC
  // (seen in the first live invite, 8 Oct 2026).
  assert.deepEqual(b.start, { dateTime: EVENT.start, timeZone: "Europe/London" });
  assert.deepEqual(b.end, { dateTime: EVENT.end, timeZone: "Europe/London" });
  assert.deepEqual(b.attendees, [{ email: "patrick@example.org" }, { email: "jane@example.com" }]);
  assert.equal(b.guestsCanSeeOtherGuests, false, "the guest isn't shown Patrick's personal address in the guest list");
  assert.deepEqual(b.conferenceData, { createRequest: { requestId: ID, conferenceSolutionKey: { type: "hangoutsMeet" } } });
});

test("insertEvent: while Meet creation is pending, re-reads the event (1 s apart) until it succeeds", async () => {
  const { g, fetch, sleeps } = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /\/calendars\/primary\/events\?/, eventBody("pending")],
    ["GET", EVENT_URL, [eventBody("pending"), eventBody("success", MEET)]],
  ]);
  assert.deepEqual(await g.insertEvent(EVENT), { created: true, meetLink: MEET });
  assert.deepEqual(sleeps, [1000, 1000]);
  assert.equal(fetch.calls.filter((c) => c.method === "GET").length, 2);
});

test("insertEvent: Meet still pending after 5 tries, or failed: created, with no link (the invite carries it)", async () => {
  const pending = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /\/calendars\/primary\/events\?/, eventBody("pending")],
    ["GET", EVENT_URL, eventBody("pending")],
  ]);
  assert.deepEqual(await pending.g.insertEvent(EVENT), { created: true, meetLink: null });
  assert.deepEqual(pending.sleeps, [1000, 1000, 1000, 1000, 1000]);
  const failed = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /\/calendars\/primary\/events\?/, eventBody("failure")],
  ]);
  assert.deepEqual(await failed.g.insertEvent(EVENT), { created: true, meetLink: null });
  assert.deepEqual(failed.sleeps, []);
});

test("insertEvent: 409 duplicate means already created; the event is read back for its Meet link", async () => {
  const { g, fetch } = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /\/calendars\/primary\/events\?/, { status: 409, body: { error: { code: 409, errors: [{ reason: "duplicate" }] } } }],
    ["GET", EVENT_URL, eventBody("success", MEET)],
  ]);
  assert.deepEqual(await g.insertEvent(EVENT), { created: false, meetLink: MEET });
  assert.equal(fetch.calls[2].url, `${API}/calendars/primary/events/${ID}`);
});

test("insertEvent: any other error throws GoogleError (the caller rolls the claim back)", async () => {
  const { g } = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /\/calendars\/primary\/events\?/, { status: 500, body: { error: { code: 500, errors: [{ reason: "backendError" }] } } }],
  ]);
  const e = await g.insertEvent(EVENT).catch((x) => x);
  assert.ok(e instanceof GoogleError);
  assert.deepEqual([e.status, e.reason], [500, "backendError"]);
});

// The event exists once events.insert has answered; a failed re-read must not turn that into a
// failed insert, or the caller would roll back a booking whose meeting is in the calendar.
test("insertEvent: the event was made but re-reading it for the Meet link fails: created, with no link", async () => {
  const fail = { status: 500, body: { error: { errors: [{ reason: "backendError" }] } } };
  const pending = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /\/calendars\/primary\/events\?/, eventBody("pending")],
    ["GET", EVENT_URL, fail],
  ]);
  assert.deepEqual(await pending.g.insertEvent(EVENT), { created: true, meetLink: null });
  const dup = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /\/calendars\/primary\/events\?/, { status: 409, body: { error: { errors: [{ reason: "duplicate" }] } } }],
    ["GET", EVENT_URL, fail],
  ]);
  assert.deepEqual(await dup.g.insertEvent(EVENT), { created: false, meetLink: null });
});

test("getEvent: reads one event on hello@'s primary calendar by ID; gone (404/410) is null; other errors throw", async () => {
  const { g, fetch } = client([["POST", /oauth2/, tokenOk()], ["GET", EVENT_URL, eventBody("success", MEET)]]);
  const ev = await g.getEvent(ID);
  assert.equal(ev.id, ID);
  assert.equal(meetLinkOf(ev), MEET);
  assert.equal(fetch.calls[1].url, `${API}/calendars/primary/events/${ID}`);
  for (const status of [404, 410]) {
    const gone = client([["POST", /oauth2/, tokenOk()], ["GET", EVENT_URL, { status, body: { error: { errors: [{ reason: "notFound" }] } } }]]);
    assert.equal(await gone.g.getEvent(ID), null, String(status));
  }
  const down = client([["POST", /oauth2/, tokenOk()], ["GET", EVENT_URL, { status: 503, body: { error: { errors: [{ reason: "backendError" }] } } }]]);
  await assert.rejects(down.g.getEvent(ID), (e) => e instanceof GoogleError && e.status === 503);
  assert.equal(meetLinkOf(eventBody("pending").body), null, "no link until Meet creation succeeds");
});

// Records the ms of every AbortSignal.timeout made while fn runs.
async function timeouts(fn) {
  const seen = [], orig = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
  try { await fn(); } finally { AbortSignal.timeout = orig; }
  return seen;
}

test("every Google call (token, free/busy, events) times out after 20 s, so a hung call can't hold a booking open", async () => {
  const { g, fetch } = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /freeBusy$/, { body: { calendars: { primary: { busy: [] } } } }],
    ["POST", /\/calendars\/primary\/events\?/, eventBody("pending")],
    ["GET", EVENT_URL, eventBody("success", MEET)],
    ["DELETE", /\/calendars\/primary\/events\//, { status: 204 }],
  ]);
  const seen = await timeouts(async () => {
    await g.freeBusy(["primary"], "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z");
    await g.insertEvent(EVENT);
    await g.deleteEvent(ID);
  });
  assert.equal(fetch.calls.length, 5);
  assert.ok(fetch.calls.every((c) => c.signal instanceof AbortSignal));
  assert.deepEqual(seen, Array(5).fill(20_000));
});

test("deleteEvent: deletes from hello@'s primary calendar with attendees notified; 204 deleted, 404/410 not", async () => {
  for (const [status, deleted] of [[204, true], [404, false], [410, false]]) {
    const { g, fetch } = client([["POST", /oauth2/, tokenOk()], ["DELETE", /\/calendars\/primary\/events\//, { status }]]);
    assert.deepEqual(await g.deleteEvent(ID), { deleted }, String(status));
    assert.equal(fetch.calls[1].url, `${API}/calendars/primary/events/${ID}?sendUpdates=all`);
  }
  const { g } = client([["POST", /oauth2/, tokenOk()], ["DELETE", /events/, { status: 500, body: { error: { errors: [{ reason: "backendError" }] } } }]]);
  await assert.rejects(g.deleteEvent(ID), (e) => e instanceof GoogleError && e.status === 500);
});

test("free/busy only: exactly these methods, and every Calendar call is freeBusy or on hello@'s primary calendar", async () => {
  const { g, fetch } = client([
    ["POST", /oauth2/, tokenOk()],
    ["POST", /freeBusy$/, { body: { calendars: { primary: { busy: [] } } } }],
    ["POST", /\/calendars\/primary\/events\?/, eventBody("pending")],
    ["GET", EVENT_URL, eventBody("success", MEET)],
    ["DELETE", /\/calendars\/primary\/events\//, { status: 204 }],
  ]);
  assert.deepEqual(Object.keys(g).sort(), ["accessToken", "deleteEvent", "freeBusy", "getEvent", "insertEvent", "ping"]);
  await g.freeBusy(["primary"], "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z");
  await g.insertEvent(EVENT);
  await g.getEvent(ID);
  await g.deleteEvent(ID);
  for (const c of fetch.calls.filter((x) => x.url.startsWith(API)))
    assert.match(c.url.slice(API.length), /^\/freeBusy$|^\/calendars\/primary\/events(\/|\?)/, c.url);
});
