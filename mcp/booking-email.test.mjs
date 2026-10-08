// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMailer, MailError } from "./booking-email.js";

// A fetch stand-in that records calls and answers with one fixed response.
function fakeFetch(status, body) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

// Captures console output so tests can check that nothing personal is logged.
async function capturingLogs(fn) {
  const lines = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.join(" "));
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines;
}

const MSG = { to: "jane@example.com", subject: "Confirm your Consultation with Patrick Vieira", text: "Hello Jane" };

test("Resend: POSTs plain text from hello@ to the guest with the API key; returns the message id", async () => {
  const fetch = fakeFetch(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
  const mailer = createMailer({ apiKey: "re_test_key", from: "Patrick Vieira <hello@patrickjv.com>", fetch });
  assert.deepEqual(await mailer.send(MSG), { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
  const c = fetch.calls[0];
  assert.equal(c.url, "https://api.resend.com/emails");
  assert.equal(c.method, "POST");
  assert.equal(c.headers.authorization, "Bearer re_test_key");
  assert.equal(c.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(c.body), { from: "Patrick Vieira <hello@patrickjv.com>", to: ["jane@example.com"], subject: MSG.subject, text: "Hello Jane" });
});

test("Resend: 429 and 500 throw MailError with the status, naming no address or key; nothing logged", async () => {
  for (const [status, body] of [
    [429, { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" }],
    [500, { statusCode: 500, name: "internal_server_error", message: "jane@example.com failed" }],
    [422, { statusCode: 422, name: "validation_error", message: "Invalid `to` field: jane@example.com" }],
  ]) {
    const mailer = createMailer({ apiKey: "re_test_key", from: "hello@patrickjv.com", fetch: fakeFetch(status, body) });
    let e;
    const logs = await capturingLogs(async () => { e = await mailer.send(MSG).catch((x) => x); });
    assert.ok(e instanceof MailError, String(e));
    assert.equal(e.status, status);
    assert.equal(e.reason, body.name);
    assert.doesNotMatch(e.message, /jane|re_test_key/);
    assert.deepEqual(logs, []);
  }
});
