// F-002 in headless Chromium: the Google sign-in round trip in a real browser (the __Host- cookie
// set on the confirm page's POST must come back on Google's top-level redirect to the callback,
// under the pages' real CSP), and the homepage's WebMCP "Sign in to book" prompt (a popup, or a
// link when the popup is blocked). Chromium resolves patrickjv.com and accounts.google.com to a
// local HTTPS server (self-signed, made with openssl): patrickjv.com is the real Worker handler
// (with the real BookingStore body on node:sqlite) plus the built public/ files with their
// _headers CSP; Google is the fake sign-in from booking-fakes.mjs. Skipped where Chromium or
// openssl isn't available (see test/book-calendar-browser.test.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { build } from "../build.mjs";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { harness } from "../mcp/booking-harness.mjs";
import { headersFor } from "./book-fake-server.mjs";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const WORKER = /^\/(mcp|api\/booking|book\/confirm|book\/callback)/;
const TYPE = { ".html": "text/html; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".ico": "image/x-icon" };
// F-004: each provider's sign-in host and the callback it returns to.
const PROVIDER_HOSTS = { "accounts.google.com": "google", "login.microsoftonline.com": "microsoft", "altimist.id": "altimist" };

// F-004: the site as built with Microsoft launched and Altimist ID on trial, for the F-004 tests
// (the F-002 tests use the committed public/).
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const f004Dir = mkdtempSync(join(tmpdir(), "signin-f004-"));
for (const f of ["content.json", "cv.json", "build-state.json"]) cpSync(join(ROOT, f), join(f004Dir, f));
for (const d of ["writing", "public"]) cpSync(join(ROOT, d), join(f004Dir, d), { recursive: true });
const F004_SIGNIN = { providers: ["google", "microsoft"], trial: ["altimist"], microsoftSecretExpires: "2099-01-01" };
writeFileSync(join(f004Dir, "booking.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(ROOT, "booking.json"), "utf8")), signin: F004_SIGNIN }));
const f004Build = build({ root: f004Dir });
const F004_PUBLIC = join(f004Dir, "public");

// One HTTPS server for every host; `site.h` is the harness of the test running, `site.public` the
// built site it serves.
const certDir = mkdtempSync(join(tmpdir(), "signin-cert-"));
let tls = null;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"), "-days", "1",
    "-subj", "/CN=patrickjv.com", "-addext", "subjectAltName=DNS:patrickjv.com,DNS:accounts.google.com,DNS:login.microsoftonline.com,DNS:altimist.id"], { stdio: "ignore" });
  tls = { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) };
} catch { /* no openssl: skipped */ }
const site = { h: null, claims: {}, callbackCookies: [], public: PUBLIC };
const server = tls && createServer(tls, async (req, res) => {
  const u = new URL(req.url, `https://${req.headers.host}`);
  if (PROVIDER_HOSTS[u.hostname]) {
    // The provider's sign-in page: the person signs in, and it redirects back with a code.
    const { code, state } = site.h.f.authorize(u.href, site.claims, site.h.clock.now);
    res.writeHead(302, { location: `https://patrickjv.com/book/callback/${PROVIDER_HOSTS[u.hostname]}?${new URLSearchParams({ code, state })}` });
    return res.end();
  }
  if (WORKER.test(u.pathname)) {
    if (u.pathname.startsWith("/book/callback/")) site.callbackCookies.push(req.headers.cookie ?? null);
    let body = "";
    for await (const chunk of req) body += chunk;
    const headers = Object.fromEntries(["content-type", "origin", "cookie", "accept"].filter((k) => req.headers[k] !== undefined).map((k) => [k, req.headers[k]]));
    const r = await site.h.call(u.pathname + u.search, { method: req.method, headers, body: req.method === "POST" ? body : undefined });
    const out = {};
    r.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
    const cookies = r.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(r.status, out);
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const path = u.pathname === "/" ? "/index.html" : u.pathname === "/book" ? "/book.html" : u.pathname;
  const file = join(site.public, path);
  if (!existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { ...(path.endsWith(".html") ? headersFor(u.pathname, site.public) : {}), "content-type": TYPE[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
if (server) await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server?.address().port;
const hostRules = ["patrickjv.com", ...Object.keys(PROVIDER_HOSTS)].map((host) => `MAP ${host}:443 127.0.0.1:${port}`).join(", ");
const browser = server ? await chromium.launch({ args: [`--host-resolver-rules=${hostRules}`] }).catch(() => null) : null;
const skip = browser ? false : "headless Chromium (or openssl) is not available";
after(async () => { await browser?.close(); server?.close(); rmSync(certDir, { recursive: true, force: true }); rmSync(f004Dir, { recursive: true, force: true }); });

// `f004`: serve the site built with Microsoft launched and Altimist ID on trial, and give the
// harness the same booking.json sign-in settings.
async function open(h, { timezoneId = "America/New_York", claims = {}, init, f004 = false } = {}) {
  Object.assign(site, { h, claims, callbackCookies: [], public: f004 ? F004_PUBLIC : PUBLIC });
  if (f004) h.cfg.signin = structuredClone(F004_SIGNIN);
  const context = await browser.newContext({ locale: "en-GB", timezoneId, ignoreHTTPSErrors: true });
  if (init) await context.addInitScript(init);
  const problems = [];
  const watch = (p) => { p.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); }); p.on("pageerror", (e) => problems.push(String(e))); };
  context.on("page", watch);
  return { context, problems };
}

test("Chromium sign-in round trip: confirm page (visitor's zone and London), the __Host- cookie comes back on Google's redirect, and the call is booked", { skip }, async () => {
  const h = harness();
  const r = (await h.tool("book_meeting", { type: "consultation", start: "2026-10-21T10:00:00+01:00" })).structuredContent;
  const { context, problems } = await open(h);
  try {
    const page = await context.newPage();
    await page.goto(r.confirm_url);
    const text = await page.textContent("main");
    assert.match(text, /Wed 21 Oct 2026, 10:00–10:30 BST/, "London time");
    assert.match(await page.textContent("[data-start]"), /In your time zone: .*05:00.*(EDT|GMT-4)/, "the visitor's own zone, by the page's script under its CSP hash");
    await page.click("button:text('Sign in with Google to book')");
    await page.waitForSelector("h1:text('Booked')");
    assert.equal(site.callbackCookies.length, 1);
    assert.match(site.callbackCookies[0] ?? "", /__Host-pjv_signin=[A-Za-z0-9_-]{43}/, "the cookie came back on the callback");
    assert.equal((await h.tool("get_booking_status", { booking_id: r.booking_id })).structuredContent.status, "confirmed");
    assert.deepEqual((await context.cookies("https://patrickjv.com")).filter((c) => c.name === "__Host-pjv_signin"), [], "cleared afterwards");
    assert.deepEqual(problems, [], "no console errors (CSP violations are logged as errors)");
  } finally { await context.close(); }
});

// The page's WebMCP tools, as an in-browser agent would call them: document.modelContext is
// provided here, recording what the page registers.
const AGENT = `Object.defineProperty(document, "modelContext", { value: { registerTool: (t) => { (window.__tools = window.__tools || {})[t.name] = t; return Promise.resolve(); } } });`;
async function bookViaWebMcp(page) {
  await page.goto("https://patrickjv.com/");
  await page.waitForFunction(() => window.__tools && window.__tools.book_meeting);
  return page.evaluate(async () => JSON.parse((await window.__tools.book_meeting.execute({ type: "consultation", start: "2026-10-21T10:00:00+01:00" }, {})).content[0].text));
}

test("Chromium WebMCP book_meeting: the homepage shows a 'Sign in to book' prompt with the meeting; a click opens Google sign-in in a popup, which books the call", { skip }, async () => {
  const h = harness();
  const { context, problems } = await open(h, { init: AGENT });
  try {
    const page = await context.newPage();
    const r = await bookViaWebMcp(page);
    assert.equal(r.status, "pending_confirmation");
    const prompt = await page.waitForSelector("#signin-prompt");
    assert.match(await prompt.textContent(), /Sign in to book/);
    assert.match(await prompt.textContent(), /Consultation/);
    assert.match(await prompt.textContent(), /21 Oct/);
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("#signin-prompt button")]);
    await popup.waitForSelector("h1:text('Booked')");
    assert.equal((await h.tool("get_booking_status", { booking_id: r.booking_id })).structuredContent.status, "confirmed");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("Chromium WebMCP book_meeting: with the popup blocked, the prompt falls back to the confirm_url link", { skip }, async () => {
  const h = harness();
  const { context, problems } = await open(h, { init: AGENT + "window.open = function () { return null; };" });
  try {
    const page = await context.newPage();
    const r = await bookViaWebMcp(page);
    await page.waitForSelector("#signin-prompt");
    await page.click("#signin-prompt button");
    const link = await page.waitForSelector("#signin-prompt a[href]:visible");
    assert.equal(await link.getAttribute("href"), r.confirm_url);
    await link.click();
    await page.waitForSelector("h1:text('Book your call')");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("Chromium /book (D8): after a time is picked, 'Sign in with Google to book' makes the request and signs in, in one step, and books the call", { skip }, async () => {
  const h = harness();
  const { context, problems } = await open(h, { timezoneId: "Europe/London" });
  try {
    const page = await context.newPage();
    await page.goto("https://patrickjv.com/book");
    await page.click("#types input");
    await page.click("#days button:not([aria-disabled=true])");
    await page.click("#times label");
    await page.click("#by-signin-google"); // F-004: one button per provider
    await page.waitForSelector("h1:text('Booked')");
    const [req] = h.rows("SELECT id, source, state FROM booking_requests");
    assert.deepEqual([req.source, req.state], ["page", "used"]);
    assert.equal(h.rows("SELECT status FROM bookings WHERE id = ?", req.id)[0].status, "confirmed");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

// ---- F-004: Microsoft launched, Altimist ID on trial, under the built pages' real CSP ----------------

test("F-004 the site builds with Microsoft launched and Altimist ID on trial", () => {
  assert.deepEqual(f004Build.errors, []);
});

test("Chromium F-004 /book: 'Sign in with Microsoft to book' makes the request and signs in with Microsoft, in one step, and books the call", { skip }, async () => {
  const h = harness();
  const { context, problems } = await open(h, { timezoneId: "Europe/London", f004: true });
  try {
    const page = await context.newPage();
    await page.goto("https://patrickjv.com/book");
    await page.click("#types input");
    await page.click("#days button:not([aria-disabled=true])");
    await page.click("#times label");
    await page.waitForSelector("#by-signin-microsoft");
    assert.deepEqual(await page.$$eval("#how button", (bs) => bs.map((b) => b.textContent)), ["Sign in with Google to book", "Sign in with Microsoft to book", "Book with email instead"], "trial providers get no button");
    await page.click("#by-signin-microsoft");
    await page.waitForSelector("h1:text('Booked')");
    const [req] = h.rows("SELECT id, state FROM booking_requests");
    assert.equal(h.rows("SELECT proof FROM bookings WHERE id = ?", req.id)[0].proof, "signin:microsoft");
    assert.deepEqual(problems, [], "no console errors (CSP violations are logged as errors)");
  } finally { await context.close(); }
});

test("Chromium F-004 /book: a provider that goes unready after the buttons are shown lands on the request's confirm page, which offers another", { skip }, async () => {
  const h = harness();
  const { context, problems } = await open(h, { timezoneId: "Europe/London", f004: true });
  try {
    const page = await context.newPage();
    await page.goto("https://patrickjv.com/book");
    await page.click("#types input");
    await page.click("#days button:not([aria-disabled=true])");
    await page.click("#times label");
    await page.waitForSelector("#by-signin-microsoft");
    h.secret("SIGNIN_MICROSOFT_CLIENT_SECRET", undefined);
    await page.click("#by-signin-microsoft");
    await page.waitForSelector("h1:text('Book your call')");
    assert.match(await page.textContent("main"), /That sign-in isn't available just now\. Choose another\./);
    assert.deepEqual(await page.$$eval("main button", (bs) => bs.map((b) => b.textContent)), ["Sign in with Google to book"]);
    await page.click("button:text('Sign in with Google to book')");
    await page.waitForSelector("h1:text('Booked')");
    assert.equal(h.rows("SELECT count(*) c FROM booking_requests")[0].c, 1, "one request");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("Chromium F-004 WebMCP book_meeting: the prompt offers each ready launched provider; Microsoft in the popup books the call", { skip }, async () => {
  const h = harness();
  const { context, problems } = await open(h, { init: AGENT, f004: true });
  try {
    const page = await context.newPage();
    const r = await bookViaWebMcp(page);
    await page.waitForSelector("#signin-prompt button:text('Sign in with Microsoft to book')");
    assert.deepEqual(await page.$$eval("#signin-prompt button", (bs) => bs.map((b) => b.textContent)), ["Sign in with Google to book", "Sign in with Microsoft to book"]);
    assert.match(await page.textContent("#signin-prompt"), /Nothing is booked until you sign in with Google or Microsoft\./);
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("#signin-prompt button:text('Sign in with Microsoft to book')")]);
    await popup.waitForSelector("h1:text('Booked')");
    assert.equal(h.rows("SELECT proof FROM bookings WHERE id = ?", r.booking_id)[0].proof, "signin:microsoft");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("Chromium F-004 WebMCP: a provider that goes unready after the prompt is shown lands the popup on the confirm page, which offers another", { skip }, async () => {
  const h = harness();
  const { context, problems } = await open(h, { init: AGENT, f004: true });
  try {
    const page = await context.newPage();
    await bookViaWebMcp(page);
    await page.waitForSelector("#signin-prompt button:text('Sign in with Microsoft to book')");
    h.secret("SIGNIN_MICROSOFT_CLIENT_ID", undefined);
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("#signin-prompt button:text('Sign in with Microsoft to book')")]);
    await popup.waitForSelector("h1:text('Book your call')");
    assert.match(await popup.textContent("main"), /That sign-in isn't available just now\. Choose another\./);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("Chromium F-004 trial: the confirm page with &try=altimist offers Altimist ID and 'Create one'; its sign-in books under the page's CSP", { skip }, async () => {
  const h = harness();
  const { context, problems } = await open(h, { f004: true });
  try {
    const r = (await h.tool("book_meeting", { type: "consultation", start: "2026-10-21T10:00:00+01:00" })).structuredContent;
    const page = await context.newPage();
    await page.goto(`${r.confirm_url}&try=altimist`);
    assert.deepEqual(await page.$$eval("main button", (bs) => bs.map((b) => b.textContent)), ["Sign in with Google to book", "Sign in with Microsoft to book", "Sign in with Altimist ID to book"]);
    assert.match(await page.getAttribute("a:text('Create one')", "href"), /^https:\/\/altimist\.id\/signup\/self-service\?app_id=patrickjv-com&return_to=/);
    await page.click("button:text('Sign in with Altimist ID to book')");
    await page.waitForSelector("h1:text('Booked')");
    assert.equal(h.rows("SELECT proof FROM bookings WHERE id = ?", r.booking_id)[0].proof, "signin:altimist");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});
