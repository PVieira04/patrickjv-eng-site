// The BookingStore Durable Object's body (mcp/booking-service.js), run against node:sqlite with a
// fake Google and Resend: what the Worker's Durable Object does with its env and the store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openSql } from "./booking-sqlite.mjs";
import { createBookingService } from "./booking-service.js";
import { ENV, fakeFetch, alarmStorage, tokenIn } from "./booking-fakes.mjs";

const cfg = JSON.parse(readFileSync(new URL("../booking.json", import.meta.url), "utf8"));
const NOW = new Date("2026-10-19T09:00:00.000Z"); // Monday; BST
const SLOT = "2026-10-21T09:00:00.000Z"; // Wed 10:00 London
const guest = (over = {}) => ({ type: "consultation", start: SLOT, name: "Jane Smith", email: "jane@example.com", note: "About platforms", source: "mcp", ...over });

function service({ fetchOpts = {}, now = NOW, sql = openSql(), storage = alarmStorage(), env = ENV } = {}) {
  const f = fakeFetch(fetchOpts);
  const clock = { now };
  const svc = createBookingService({ sql, storage, env, cfg, fetch: f.fetch, sleep: async () => {}, now: () => clock.now });
  return { svc, f, sql, storage, clock };
}
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

test("service: a request holds the slot and emails the guest Confirm/Decline links from BOOKING_FROM; an alarm is set", async () => {
  const { svc, f, storage } = service();
  const r = await svc.request(guest(), "ip1", "em1");
  assert.match(r.booking_id, /^[0-9a-f]{32}$/);
  assert.equal(r.status, "pending_confirmation");
  const [mail] = f.mails();
  assert.equal(mail.from, ENV.BOOKING_FROM);
  assert.deepEqual(mail.to, ["jane@example.com"]);
  assert.match(mail.text, /An AI agent asked to book a Consultation/);
  assert.ok(tokenIn(mail.text, "confirm") && tokenIn(mail.text, "decline"));
  assert.ok(storage.at() > 0 && storage.at() <= Date.parse(r.hold_expires), "alarm no later than the hold's expiry");
  // A page booking says so, not "an AI agent".
  const page = await service().svc.request(guest({ source: "page" }), "ip2", "em2");
  assert.ok(page.booking_id);
});

test("service: free/busy asks only the blocking calendars (secret IDs resolved, Birthdays left out)", async () => {
  const { svc, f } = service();
  await svc.request(guest(), "ip1", "em1");
  const fb = f.calls.find((c) => c.url.endsWith("/freeBusy"));
  assert.deepEqual(fb.body.items.map((i) => i.id).sort(), ["family@example.net", "main@example.net", "primary"]);
});

test("service: confirming creates the event as hello@ with Patrick and the guest as plain-email attendees, then emails 'Booked'", async () => {
  const { svc, f } = service();
  const { booking_id } = await svc.request(guest(), "ip1", "em1");
  const r = await svc.act(tokenIn(f.mails()[0].text, "confirm"));
  assert.deepEqual(r, { result: "confirmed" });
  const ins = f.calls.find((c) => c.method === "POST" && c.url.includes("/calendars/primary/events"));
  assert.equal(ins.body.id, booking_id);
  assert.equal(ins.body.summary, "Consultation: Jane Smith");
  assert.deepEqual(ins.body.attendees, [{ email: "jane@example.com" }, { email: "owner@example.net" }]);
  assert.equal(ins.body.guestsCanSeeOtherGuests, false);
  const booked = f.mails()[1];
  assert.match(booked.subject, /^Booked: Consultation/);
  assert.match(booked.text, /meet\.google\.com/);
  assert.equal(svc.status(booking_id).status, "confirmed");
});

test("service: peek shows what a link does without changing anything", async () => {
  const { svc, f } = service();
  const { booking_id } = await svc.request(guest(), "ip1", "em1");
  const t = tokenIn(f.mails()[0].text, "confirm");
  const p = await svc.peek(t);
  assert.equal(p.state, "valid");
  assert.equal(p.action, "confirm");
  assert.equal(svc.status(booking_id).status, "pending_confirmation");
  assert.equal((await svc.peek("nope")).state, "unknown");
});

test("service: 20 parallel requests for one slot through the real deps: exactly one hold", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { svc } = service({ fetchOpts: { gate: () => gate } });
  const all = Array.from({ length: 20 }, (_, i) => svc.request(guest(), `ip${i}`, `em${i}`));
  setTimeout(release, 5);
  const results = await Promise.all(all);
  assert.equal(results.filter((r) => r.booking_id).length, 1, JSON.stringify(results.slice(0, 3)));
  assert.ok(results.filter((r) => !r.booking_id).every((r) => r.error === "slot_taken" || (r.error === "rate_limited" && r.reason === "global")), JSON.stringify(results));
  assert.ok(results.filter((r) => r.error === "slot_taken").length >= 8, "the losers raced past the pre-check and lost at the claim");
});

test("service: availability is UTC slots from live free/busy, skipping busy time; free/busy is reused for 60 s", async () => {
  const busy = [{ start: "2026-10-21T08:00:00Z", end: "2026-10-21T12:00:00Z" }];
  const { svc, f, clock } = service({ fetchOpts: { busy } });
  const r = await svc.availability("consultation", "2026-10-21", "2026-10-21");
  assert.equal(r.slots[0].start, "2026-10-21T12:15:00.000Z", "first slot after busy time plus the 15-minute buffer");
  assert.ok(r.slots.every((s) => s.start.endsWith("Z")));
  const freeBusyCalls = () => f.calls.filter((c) => c.url.endsWith("/freeBusy")).length;
  await svc.availability("recruiter-intro");
  assert.equal(freeBusyCalls(), 1, "cached");
  clock.now = new Date(NOW.getTime() + 61_000);
  await svc.availability("consultation");
  assert.equal(freeBusyCalls(), 2, "refreshed after 60 s");
});

test("service: availability with Google failing throws (never guesses free time)", async () => {
  const { svc } = service({ fetchOpts: { fail: { freebusy: true } } });
  await assert.rejects(() => svc.availability("consultation"));
});

test("service: cancel withdraws a hold; status never shows guest details", async () => {
  const { svc } = service();
  const { booking_id } = await svc.request(guest(), "ip1", "em1");
  assert.deepEqual(await svc.cancel(booking_id), { status: "cancelled" });
  const s = svc.status(booking_id);
  assert.equal(s.status, "cancelled");
  assert.ok(!JSON.stringify(s).includes("jane"));
  assert.equal(svc.status("0".repeat(32)), null);
});

test("service: the alarm expires lapsed holds and schedules the next run", async () => {
  const { svc, storage, clock } = service();
  const { booking_id } = await svc.request(guest(), "ip1", "em1");
  clock.now = new Date(NOW.getTime() + 3 * 3600e3);
  await svc.alarm();
  assert.equal(svc.status(booking_id).status, "expired");
  assert.equal(storage.at(), Date.parse("2026-10-20T00:00:00.000Z"), "next UTC midnight");
});

test("service: a request that writes quota but holds nothing still sets the alarm, so its counters get pruned", async () => {
  const { svc, storage } = service({ fetchOpts: { busy: [{ start: SLOT, end: "2026-10-21T10:00:00.000Z" }] } });
  assert.equal((await svc.request(guest(), "ip1", "em1")).error, "slot_taken");
  assert.equal(storage.at(), Date.parse("2026-10-20T00:00:00.000Z"), "next UTC midnight");
});

test("service: health pings Google with a fresh token refresh", async () => {
  assert.deepEqual(await service().svc.health(), { google: true });
  assert.deepEqual(await service({ fetchOpts: { fail: { token: true } } }).svc.health(), { google: false });
});

// Recovery: a confirm (or cancel) whose Durable Object was evicted mid-call leaves the row in
// confirming (or cancelling). A fresh instance's alarm finishes it.
async function stuck(action) {
  const sql = openSql();
  const first = service({ sql });
  const { booking_id } = await first.svc.request(guest(), "ip1", "em1");
  if (action === "cancelling") {
    await first.svc.act(tokenIn(first.f.mails()[0].text, "confirm"));
    sql.exec("UPDATE bookings SET status = 'cancelling' WHERE id = ?", booking_id);
  } else {
    sql.exec("UPDATE bookings SET status = 'confirming' WHERE id = ?", booking_id);
  }
  return { sql, booking_id };
}

test("recovery: a booking stuck in confirming is finished by retrying insertEvent (409 = it exists)", async () => {
  const { sql, booking_id } = await stuck("confirming");
  const later = new Date(NOW.getTime() + 5 * 60e3);
  const fresh = service({ sql, now: later, fetchOpts: { insertStatus: 409 } });
  fresh.f.events.set(booking_id, { id: booking_id, hangoutLink: "https://meet.google.com/x", conferenceData: { createRequest: { status: { statusCode: "success" } } } });
  await fresh.svc.alarm();
  assert.equal(fresh.svc.status(booking_id).status, "confirmed");
  assert.match(fresh.f.mails()[0].subject, /^Booked:/);
  assert.ok(fresh.f.mails()[0].text.includes("/api/booking/act?t="), "with a cancel link");
});

test("recovery: a Google failure leaves the booking for the next alarm, which comes within minutes", async () => {
  const { sql, booking_id } = await stuck("confirming");
  const later = new Date(NOW.getTime() + 5 * 60e3);
  const fresh = service({ sql, now: later, fetchOpts: { fail: { insert: true } } });
  await quiet(() => fresh.svc.alarm());
  assert.equal(fresh.svc.status(booking_id).status, "confirming");
  assert.ok(fresh.storage.at() <= later.getTime() + 5 * 60e3, "retried soon, not at midnight");
});

test("recovery: a booking stuck in cancelling is finished by retrying deleteEvent", async () => {
  const { sql, booking_id } = await stuck("cancelling");
  const fresh = service({ sql, now: new Date(NOW.getTime() + 5 * 60e3) });
  await fresh.svc.alarm();
  assert.equal(fresh.svc.status(booking_id).status, "cancelled");
  assert.ok(fresh.f.calls.some((c) => c.method === "DELETE"));
});

test("recovery: a confirm still in progress in this instance (under 2 minutes) is left alone", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const sql = openSql();
  const s = service({ sql });
  await s.svc.request(guest(), "ip1", "em1");
  s.f.opts.gate = () => gate; // Google now hangs
  const pending = s.svc.act(tokenIn(s.f.mails()[0].text, "confirm"));
  await new Promise((r) => setTimeout(r, 5));
  const inserts = () => s.f.calls.filter((c) => c.method === "POST" && c.url.includes("/events")).length;
  const before = inserts();
  s.clock.now = new Date(NOW.getTime() + 60e3);
  const alarm = s.svc.alarm();
  release();
  await Promise.all([pending, alarm]);
  assert.equal(inserts(), before + 1, "only the confirm's own insert ran");
});
