// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoogle, GoogleError } from "./booking-google.js";

const API = "https://www.googleapis.com/calendar/v3";

// A fetch stand-in. `routes` is a list of [method, urlPattern, reply]; reply is a response spec
// ({status, body}), a list of them served in order (the last one repeats), or a function of the
// recorded call. Every call is recorded; an unrouted call fails the test.
function fakeFetch(routes) {
  const calls = [];
  const served = new Map();
  const f = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body };
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
