// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMailer, MailError, holdEmail, bookedEmail, cancelRequestEmail, capAlertEmail } from "./booking-email.js";

// A fetch stand-in that records calls and answers with one fixed response.
function fakeFetch(status, body) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body, signal: init.signal });
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

test("Resend: the send times out after 15 s, so a hung call can't hold a booking open", async () => {
  const fetch = fakeFetch(200, { id: "x" });
  const mailer = createMailer({ apiKey: "k", from: "hello@patrickjv.com", fetch });
  const seen = [], orig = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
  try { await mailer.send(MSG); } finally { AbortSignal.timeout = orig; }
  assert.ok(fetch.calls[0].signal instanceof AbortSignal);
  assert.deepEqual(seen, [15_000]);
});

// Sample bookings either side of the clocks going back on Sun 25 Oct 2026.
const BST = { start: "2026-10-23T09:00:00.000Z", end: "2026-10-23T09:30:00.000Z", when: "Fri 23 Oct 2026, 10:00–10:30 BST (09:00–09:30 UTC)" };
const GMT = { start: "2026-10-26T10:00:00.000Z", end: "2026-10-26T10:30:00.000Z", when: "Mon 26 Oct 2026, 10:00–10:30 GMT (10:00–10:30 UTC)" };
const URLS = {
  confirmUrl: "https://patrickjv.com/api/booking/act?t=CONFIRMtoken",
  declineUrl: "https://patrickjv.com/api/booking/act?t=DECLINEtoken",
  cancelUrl: "https://patrickjv.com/api/booking/act?t=CANCELtoken",
  confirmCancelUrl: "https://patrickjv.com/api/booking/act?t=CONFIRMCANCELtoken",
};
const hold = (over = {}) => holdEmail({
  name: "Jane Smith", typeTitle: "Consultation", start: GMT.start, end: GMT.end, note: "",
  confirmUrl: URLS.confirmUrl, declineUrl: URLS.declineUrl, holdExpires: "2026-10-08T14:00:00.000Z", viaAgent: false, ...over,
});

// Plain text only, and none of the tells the copy rules ban.
function assertPlain(email) {
  assert.equal(typeof email.subject, "string");
  assert.equal(typeof email.text, "string");
  for (const s of [email.subject, email.text]) {
    assert.doesNotMatch(s, /<\/?[a-z][^>]*>/i, "no HTML");
    assert.doesNotMatch(s, /—/, "no em dashes");
    assert.doesNotMatch(s, /hope this (email )?finds you|seamless|don't hesitate|undefined|null|NaN/i);
  }
  assert.doesNotMatch(email.subject, /[\r\n]/);
}

test("hold email: the meeting, both time formats either side of the clock change, links, expiry, ignore = nothing booked", () => {
  for (const t of [BST, GMT]) {
    const e = hold({ start: t.start, end: t.end });
    assertPlain(e);
    assert.ok(e.text.includes(t.when), `${t.when} in:\n${e.text}`);
  }
  const e = hold();
  assert.match(e.subject, /Consultation/);
  assert.match(e.subject, /Patrick Vieira/);
  assert.match(e.text, /Jane Smith/);
  assert.match(e.text, /Consultation/);
  assert.ok(e.text.includes(URLS.confirmUrl) && e.text.includes(URLS.declineUrl));
  assert.ok(e.text.includes("Thu 8 Oct 2026, 15:00 BST (14:00 UTC)"), "hold expiry in both formats");
  assert.match(e.text, /ignore this email/i);
  assert.match(e.text, /nothing (is|will be) booked/i);
  assert.doesNotMatch(e.text, /AI agent/);
});

test("hold email: says when an AI agent asked on the person's behalf", () => {
  const e = hold({ viaAgent: true });
  assertPlain(e);
  assert.match(e.text, /AI agent/);
  assert.match(e.text, /on your behalf/);
});

test("hold email: never carries the note (whoever asked for the hold wrote it, not the inbox's owner)", () => {
  const e = hold({ note: "Platform team, 40 engineers.\nKeen to talk about agents." });
  assert.doesNotMatch(e.text, /Platform team|Keen to talk|note/i);
});

test("booked email: booked, Google invite on its way, Meet link if known, cancel link; no note", () => {
  for (const t of [BST, GMT]) {
    const e = bookedEmail({ name: "Jane Smith", typeTitle: "Recruiter intro", start: t.start, end: t.end, meetLink: "https://meet.google.com/abc-defg-hij", cancelUrl: URLS.cancelUrl });
    assertPlain(e);
    assert.ok(e.text.includes(t.when), e.text);
    assert.match(e.subject, /Recruiter intro/);
    assert.match(e.text, /Jane Smith/);
    assert.match(e.text, /invite/i);
    assert.ok(e.text.includes("https://meet.google.com/abc-defg-hij"));
    assert.ok(e.text.includes(URLS.cancelUrl));
  }
  const noLink = bookedEmail({ name: "Jane Smith", typeTitle: "Consultation", start: GMT.start, end: GMT.end, meetLink: null, cancelUrl: URLS.cancelUrl });
  assertPlain(noLink);
  assert.match(noLink.text, /Meet link is in the invite/);
  assert.doesNotMatch(noLink.text, /meet\.google\.com/);
});

test("cancel-request email: an agent asked to cancel; the link confirms; ignoring keeps the meeting", () => {
  for (const t of [BST, GMT]) {
    const e = cancelRequestEmail({ name: "Jane Smith", typeTitle: "Consultation", start: t.start, end: t.end, confirmCancelUrl: URLS.confirmCancelUrl });
    assertPlain(e);
    assert.ok(e.text.includes(t.when), e.text);
    assert.match(e.subject, /cancel/i);
    assert.match(e.text, /AI agent/);
    assert.ok(e.text.includes(URLS.confirmCancelUrl));
    assert.match(e.text, /ignore this email/i);
    assert.match(e.text, /meeting stays/i);
  }
});

test("cap alert email to Patrick: booking closed for the day because the daily cap was reached", () => {
  const e = capAlertEmail({ day: "2026-10-26" });
  assertPlain(e);
  assert.match(e.subject, /closed/i);
  assert.match(e.text, /2026-10-26/);
  assert.match(e.text, /daily cap/i);
});
