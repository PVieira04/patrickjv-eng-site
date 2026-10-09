// Run with: npm test
// F-002's Google sign-in client (mcp/booking-signin.js): the authorisation URL (code flow, PKCE
// S256, state and nonce), the server-side code exchange, the ID token checks and the person they
// produce. Against a fake Google token endpoint: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as signin from "./booking-signin.js";
import { idToken } from "./booking-fakes.mjs";

const CLIENT = "signin-client.apps.googleusercontent.com";
const NOW = new Date("2026-10-19T09:00:00.000Z");
const secs = (d) => Math.floor(d.getTime() / 1000);
const claims = (over = {}) => ({
  iss: "https://accounts.google.com", aud: CLIENT, sub: "1234567890", email: "jane@gmail.com", email_verified: true,
  name: "Jane Smith", nonce: "n-1", iat: secs(NOW) - 10, exp: secs(NOW) + 3600, ...over,
});
const verify = (c, opts = {}) => signin.verifyIdToken(idToken(c), { clientId: CLIENT, nonce: "n-1", now: NOW, ...opts });

test("F-002 sign-in: the authorisation URL asks Google for openid email profile by code flow, with PKCE S256, state and nonce, back to /book/callback/google", async () => {
  const verifier = "v".repeat(64);
  const url = new URL(signin.authUrl({ clientId: CLIENT, state: "st", nonce: "no", codeChallenge: await signin.pkceChallenge(verifier) }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = Object.fromEntries(url.searchParams);
  assert.equal(p.client_id, CLIENT);
  assert.equal(p.redirect_uri, "https://patrickjv.com/book/callback/google");
  assert.equal(p.response_type, "code");
  assert.equal(p.scope, "openid email profile");
  assert.equal(p.state, "st");
  assert.equal(p.nonce, "no");
  assert.equal(p.code_challenge_method, "S256");
  assert.equal(p.code_challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("F-002 sign-in: the code is exchanged server to server with the verifier and client secret; the ID token comes back", async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) }); return Response.json({ id_token: "tok", access_token: "unused" }); };
  const g = signin.createSignin({ clientId: CLIENT, clientSecret: "secret", fetch });
  assert.equal(await g.exchange("the-code", "the-verifier"), "tok");
  assert.equal(seen[0].url, "https://oauth2.googleapis.com/token");
  assert.deepEqual(seen[0].body, { grant_type: "authorization_code", code: "the-code", code_verifier: "the-verifier", client_id: CLIENT, client_secret: "secret", redirect_uri: "https://patrickjv.com/book/callback/google" });
  const bad = signin.createSignin({ clientId: CLIENT, clientSecret: "secret", fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }) });
  await assert.rejects(bad.exchange("c", "v"), (e) => e.reason === "invalid_grant" && !String(e.message).includes("secret"));
  const none = signin.createSignin({ clientId: CLIENT, clientSecret: "secret", fetch: async () => Response.json({ access_token: "x" }) });
  await assert.rejects(none.exchange("c", "v"));
});

test("F-002 sign-in: an ID token passing every check gives the person (provider, subject, email, display name) and nothing else", () => {
  for (const iss of ["https://accounts.google.com", "accounts.google.com"]) {
    assert.deepEqual(verify(claims({ iss })), { person: { provider: "google", subject: "1234567890", email: "jane@gmail.com", display_name: "Jane Smith" } });
  }
  // email_verified arrives as a string from some Google endpoints.
  assert.ok(verify(claims({ email_verified: "true" })).person);
  // No name: the part of the address before @, never treated as verified.
  assert.equal(verify(claims({ name: undefined })).person.display_name, "jane");
  assert.equal(verify(claims({ name: "  " })).person.display_name, "jane");
  // A name is tidied to one plain line (no control or bidi characters), at most 100 characters.
  assert.equal(verify(claims({ name: "Jane\u202e\nSmith" })).person.display_name, "Jane Smith");
  assert.equal(verify(claims({ name: "x".repeat(150) })).person.display_name.length, 100);
});

test("F-002 sign-in: each ID token check refuses on its own (iss, aud, exp, iat within 5 minutes, nonce, sub, email_verified)", () => {
  for (const [why, c] of [
    ["iss", claims({ iss: "https://evil.example" })],
    ["aud", claims({ aud: "someone-else" })],
    ["aud", claims({ aud: [CLIENT, "other"] })],
    ["exp", claims({ exp: secs(NOW) })],
    ["iat", claims({ iat: secs(NOW) - 301 })],
    ["iat", claims({ iat: secs(NOW) + 301 })],
    ["nonce", claims({ nonce: "n-2" })],
    ["nonce", claims({ nonce: undefined })],
    ["sub", claims({ sub: "" })],
    ["sub", claims({ sub: undefined })],
    ["email_verified", claims({ email_verified: false })],
    ["email_verified", claims({ email_verified: undefined })],
    ["email", claims({ email: undefined })],
  ]) {
    assert.deepEqual(verify(c), { error: why }, why);
  }
  for (const junk of ["", "a.b", "a.!!!.c", "x.eyJ9.y"]) assert.ok(signin.verifyIdToken(junk, { clientId: CLIENT, nonce: "n-1", now: NOW }).error, junk);
});

test("F-002 sign-in: any address Google has verified is accepted, whoever runs its mail; an unverified one isn't", () => {
  for (const c of [
    claims({ email: "jane@gmail.com" }),
    claims({ email: "Jane@GMAIL.com" }),
    claims({ email: "jane@googlemail.com" }),
    claims({ email: "omar@acme.example", hd: "acme.example" }),
    claims({ email: "omar@acme.example" }), // a Google account on a work address whose mail runs elsewhere
    claims({ email: "omar@sub.acme.example", hd: "acme.example" }), // a Workspace user on a secondary domain
  ]) {
    assert.equal(verify(c).person?.email, c.email, c.email);
  }
  assert.deepEqual(verify(claims({ email: "omar@acme.example", email_verified: false })), { error: "email_verified" });
});

test("F-002 sign-in: ready() is Google's discovery document being reachable", async () => {
  const up = signin.createSignin({ clientId: CLIENT, clientSecret: "s", fetch: async (url) => (url === "https://accounts.google.com/.well-known/openid-configuration" ? Response.json({ issuer: "https://accounts.google.com" }) : new Response(null, { status: 404 })) });
  assert.equal(await up.ready(), true);
  const down = signin.createSignin({ clientId: CLIENT, clientSecret: "s", fetch: async () => new Response(null, { status: 503 }) });
  assert.equal(await down.ready(), false);
  const offline = signin.createSignin({ clientId: CLIENT, clientSecret: "s", fetch: async () => { throw new TypeError("offline"); } });
  assert.equal(await offline.ready(), false);
});
