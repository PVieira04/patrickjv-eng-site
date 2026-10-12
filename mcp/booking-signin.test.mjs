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

// ---- F-004: Microsoft and Altimist ID, one provider table (D2) -------------------------------------

const MS_CLIENT = "3f1c9a2e-0000-4000-8000-00000000c11e";
const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const PERSONAL = "9188040d-6c67-4c5b-b112-36a304b66dad";
const msClaims = (over = {}) => ({
  iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: MS_CLIENT, ver: "2.0", tid: TENANT, oid: "00000000-0000-0000-66f3-3332eca7ea81",
  sub: "pairwise-sub", email: "omar@contoso.example", xms_edov: true, name: "Omar Khan", preferred_username: "omar@contoso.example",
  nonce: "n-1", iat: secs(NOW) - 10, nbf: secs(NOW) - 10, exp: secs(NOW) + 3600, ...over,
});
const AL_CLIENT = "patrickjv-com-client";
const alClaims = (over = {}) => ({
  iss: "https://altimist.id", aud: AL_CLIENT, sub: "al-sub-1", email: "sam@example.org", given_name: "Sam", family_name: "Lee",
  nonce: "n-1", iat: secs(NOW) - 10, exp: secs(NOW) + 3600, ...over,
});
const verifyAs = (provider, c, clientId) => signin.verifyIdToken(idToken(c), { provider, clientId, nonce: "n-1", now: NOW });
const ms = (c) => verifyAs("microsoft", c, MS_CLIENT);
const al = (c) => verifyAs("altimist", c, AL_CLIENT);

test("F-004 (D2): one provider table: google, microsoft and altimist, each with its endpoints, secret names and scopes", () => {
  assert.deepEqual(Object.keys(signin.PROVIDERS), ["google", "microsoft", "altimist"]);
  assert.deepEqual(signin.PROVIDERS.microsoft.secrets, ["SIGNIN_MICROSOFT_CLIENT_ID", "SIGNIN_MICROSOFT_CLIENT_SECRET"]);
  assert.deepEqual(signin.PROVIDERS.altimist.secrets, ["SIGNIN_ALTIMIST_CLIENT_ID", "SIGNIN_ALTIMIST_CLIENT_SECRET"]);
  assert.deepEqual(signin.PROVIDERS.google.secrets, ["SIGNIN_GOOGLE_CLIENT_ID", "SIGNIN_GOOGLE_CLIENT_SECRET"]);
  assert.deepEqual(Object.fromEntries(Object.entries(signin.PROVIDERS).map(([k, p]) => [k, p.host])),
    { google: "https://accounts.google.com", microsoft: "https://login.microsoftonline.com", altimist: "https://altimist.id" });
});

test("F-004 (D3): Microsoft's authorisation URL: /common/v2.0, openid profile email, code flow with PKCE S256, state and nonce, back to /book/callback/microsoft", async () => {
  const url = new URL(signin.authUrl({ provider: "microsoft", clientId: MS_CLIENT, state: "st", nonce: "no", codeChallenge: "ch" }));
  assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  const p = Object.fromEntries(url.searchParams);
  assert.deepEqual([p.client_id, p.redirect_uri, p.response_type, p.scope, p.state, p.nonce, p.code_challenge, p.code_challenge_method],
    [MS_CLIENT, "https://patrickjv.com/book/callback/microsoft", "code", "openid profile email", "st", "no", "ch", "S256"]);
});

test("F-004 (D4): Altimist ID's authorisation URL comes from its discovery document: /oidc/authorize, openid email profile, PKCE S256, back to /book/callback/altimist", () => {
  const url = new URL(signin.authUrl({ provider: "altimist", clientId: AL_CLIENT, state: "st", nonce: "no", codeChallenge: "ch" }));
  assert.equal(url.origin + url.pathname, "https://altimist.id/oidc/authorize");
  const p = Object.fromEntries(url.searchParams);
  assert.deepEqual([p.client_id, p.redirect_uri, p.response_type, p.scope, p.state, p.nonce, p.code_challenge, p.code_challenge_method],
    [AL_CLIENT, "https://patrickjv.com/book/callback/altimist", "code", "openid email profile", "st", "no", "ch", "S256"]);
});

test("F-004 (D2): each provider's code is exchanged at its own token endpoint, with its own redirect URI; ready() is its own discovery document", async () => {
  for (const [provider, token, discovery] of [
    ["microsoft", "https://login.microsoftonline.com/common/oauth2/v2.0/token", "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration"],
    ["altimist", "https://altimist.id/oidc/token", "https://altimist.id/.well-known/openid-configuration"],
  ]) {
    const seen = [];
    const fetch = async (url, init) => { seen.push({ url, body: init?.body && Object.fromEntries(new URLSearchParams(init.body)) }); return url === discovery ? Response.json({}) : Response.json({ id_token: "tok" }); };
    const s = signin.createSignin({ provider, clientId: "cid", clientSecret: "secret", fetch });
    assert.equal(await s.exchange("the-code", "the-verifier"), "tok");
    assert.equal(seen[0].url, token, provider);
    assert.deepEqual(seen[0].body, { grant_type: "authorization_code", code: "the-code", code_verifier: "the-verifier", client_id: "cid", client_secret: "secret", redirect_uri: `https://patrickjv.com/book/callback/${provider}` });
    assert.equal(await s.ready(), true);
    assert.equal(seen[1].url, discovery);
    const down = signin.createSignin({ provider, clientId: "cid", clientSecret: "secret", fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }) });
    await assert.rejects(down.exchange("c", "v"), (e) => e.reason === "invalid_grant");
    assert.equal(await down.ready(), false);
  }
});

test("F-004 (US-1, D3): a Microsoft work account with email and xms_edov true gives {provider microsoft, subject tid:oid, email, name}", () => {
  assert.deepEqual(ms(msClaims()), { person: { provider: "microsoft", subject: `${TENANT}:00000000-0000-0000-66f3-3332eca7ea81`, email: "omar@contoso.example", display_name: "Omar Khan" } });
  assert.equal(ms(msClaims({ name: undefined })).person.display_name, "omar", "no name: the part before @");
  assert.equal(ms(msClaims({ name: "Omar‮\nKhan" })).person.display_name, "Omar Khan");
  assert.equal(ms(msClaims({ nbf: undefined })).person?.provider, "microsoft", "nbf is optional");
  // The same tid and oid with another address is the same person (the key never uses the address).
  assert.equal(ms(msClaims({ email: "o.khan@contoso.example" })).person.subject, ms(msClaims()).person.subject);
  assert.notEqual(ms(msClaims({ tid: PERSONAL, iss: `https://login.microsoftonline.com/${PERSONAL}/v2.0` })).person.subject, ms(msClaims()).person.subject, "tid is part of the key");
});

test("F-004 (US-1, D3): Microsoft ID-token checks each refuse on their own: aud, tid a GUID, iss exactly for that tid, exp, nbf, iat, nonce, ver 2.0, oid", () => {
  for (const [why, c] of [
    ["aud", msClaims({ aud: "someone-else" })],
    ["aud", msClaims({ aud: [MS_CLIENT] })],
    ["tid", msClaims({ tid: "contoso", iss: "https://login.microsoftonline.com/contoso/v2.0" })],
    ["tid", msClaims({ tid: `${TENANT}x`, iss: `https://login.microsoftonline.com/${TENANT}x/v2.0` })],
    ["iss", msClaims({ iss: `https://login.microsoftonline.com/${PERSONAL}/v2.0` })], // another tenant than tid
    ["iss", msClaims({ iss: "https://login.microsoftonline.com/common/v2.0" })],
    ["iss", msClaims({ iss: `https://sts.windows.net/${TENANT}/` })],
    ["exp", msClaims({ exp: secs(NOW) })],
    ["nbf", msClaims({ nbf: secs(NOW) + 60 })],
    ["nbf", msClaims({ nbf: "0" })],
    ["iat", msClaims({ iat: secs(NOW) - 301 })],
    ["nonce", msClaims({ nonce: "n-2" })],
    ["ver", msClaims({ ver: "1.0" })],
    ["ver", msClaims({ ver: undefined })],
    ["oid", msClaims({ oid: undefined })],
    ["oid", msClaims({ oid: "" })],
    ["tid", msClaims({ tid: undefined })],
  ]) {
    assert.deepEqual(ms(c), { error: why }, `${why}: ${JSON.stringify(c).slice(0, 80)}`);
  }
});

test("F-004 (US-1, D3): Microsoft address rule: xms_edov true, or a personal account; anything else, or no usable email, is the address refusal; upn and preferred_username are never the address", () => {
  const personal = (over = {}) => msClaims({ tid: PERSONAL, iss: `https://login.microsoftonline.com/${PERSONAL}/v2.0`, ...over });
  assert.equal(ms(personal()).person?.email, "omar@contoso.example");
  assert.equal(ms(personal({ xms_edov: undefined })).person?.email, "omar@contoso.example", "personal accounts book with or without xms_edov");
  assert.equal(ms(personal({ xms_edov: false })).person?.email, "omar@contoso.example");
  for (const c of [
    msClaims({ xms_edov: false }), msClaims({ xms_edov: undefined }), msClaims({ xms_edov: "true" }),
    msClaims({ email: undefined }), msClaims({ email: "" }), msClaims({ email: 42 }), msClaims({ email: "no-at-sign" }),
    msClaims({ email: undefined, upn: "omar@contoso.example" }), // upn and preferred_username are never used
    personal({ email: undefined }),
  ]) {
    assert.deepEqual(ms(c), { error: "address" }, JSON.stringify(c).slice(0, 120));
  }
});

test("F-004 (US-2, D4): Altimist ID: iss exactly https://altimist.id, an address with @, email_verified true if present; the name is given + family name, else the part before @", () => {
  assert.deepEqual(al(alClaims()), { person: { provider: "altimist", subject: "al-sub-1", email: "sam@example.org", display_name: "Sam Lee" } });
  assert.equal(al(alClaims({ email_verified: true })).person?.subject, "al-sub-1");
  assert.equal(al(alClaims({ family_name: "" })).person.display_name, "Sam");
  assert.equal(al(alClaims({ given_name: "", family_name: "Lee" })).person.display_name, "Lee");
  assert.equal(al(alClaims({ given_name: "", family_name: "" })).person.display_name, "sam");
  assert.equal(al(alClaims({ given_name: undefined, family_name: undefined })).person.display_name, "sam");
  for (const [why, c] of [
    ["iss", alClaims({ iss: "https://altimist.id/" })],
    ["iss", alClaims({ iss: "https://evil.example" })],
    ["email", alClaims({ email: "no-at-sign" })],
    ["email_verified", alClaims({ email_verified: false })],
    ["email_verified", alClaims({ email_verified: "true" })],
  ]) {
    assert.deepEqual(al(c), { error: why }, why);
  }
});

test("F-004 shared token rules, every provider: exp and iat numbers (exp ahead, iat within 5 minutes), nonce equal, aud a string equal to that provider's client ID; required claims non-empty strings", () => {
  const cases = { google: [claims, CLIENT, ["sub", "email"]], microsoft: [msClaims, MS_CLIENT, ["tid", "oid"]], altimist: [alClaims, AL_CLIENT, ["sub", "email"]] };
  for (const [provider, [make, clientId, required]] of Object.entries(cases)) {
    const v = (c) => verifyAs(provider, c, clientId);
    assert.ok(v(make()).person, provider);
    for (const [why, c] of [
      ["aud", make({ aud: [clientId] })], ["aud", make({ aud: CLIENT === clientId ? MS_CLIENT : CLIENT })],
      ["exp", make({ exp: String(secs(NOW) + 3600) })], ["exp", make({ exp: undefined })], ["exp", make({ exp: secs(NOW) - 1 })],
      ["iat", make({ iat: String(secs(NOW)) })], ["iat", make({ iat: undefined })], ["iat", make({ iat: secs(NOW) + 301 })],
      ["nonce", make({ nonce: "n-2" })], ["nonce", make({ nonce: 1 })],
      ...required.flatMap((k) => [[k, make({ [k]: "" })], [k, make({ [k]: 7 })], [k, make({ [k]: undefined })]]),
    ]) {
      // Microsoft's email is D3's address rule, not a required claim.
      assert.deepEqual(v(c), { error: why }, `${provider} ${why}: ${JSON.stringify(c).slice(0, 100)}`);
    }
    // A claim this provider doesn't define is never required.
    if (provider !== "microsoft") assert.ok(v(make({ oid: undefined, tid: undefined })).person, `${provider}: oid/tid not required`);
  }
  assert.deepEqual(verifyAs("github", claims(), CLIENT), { error: "provider" });
});
