// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateConfig, localToUtc, localDay, withOffset, candidateSlots, checkSlot, availableSlots } from "./booking-config.js";

const TZ = "Europe/London";

// The repo's real config, read fresh for each test so no test can leak changes into another.
const realConfig = () => JSON.parse(readFileSync(new URL("../booking.json", import.meta.url), "utf8"));

test("booking.json: two meeting types, Consultation (30 min) and Recruiter intro (15 min)", () => {
  const cfg = validateConfig(realConfig());
  assert.deepEqual(cfg.meetingTypes.map(({ id, title, minutes }) => ({ id, title, minutes })), [
    { id: "consultation", title: "Consultation", minutes: 30 },
    { id: "recruiter-intro", title: "Recruiter intro", minutes: 15 },
  ]);
  for (const t of cfg.meetingTypes) assert.ok(t.description.length > 0, `${t.id} has a description`);
});

// Spike S1: London wall-clock times convert to UTC per day, never by a fixed offset. Clocks go
// back on Sun 25 Oct 2026 and forward on Sun 28 Mar 2027.
test("clocks change (S1): 10:00 and 17:00 London are 09:00/16:00 UTC in BST, 10:00/17:00 UTC in GMT", () => {
  for (const [day, open, close] of [
    ["2026-10-23", "2026-10-23T09:00:00.000Z", "2026-10-23T16:00:00.000Z"], // Fri, BST
    ["2026-10-26", "2026-10-26T10:00:00.000Z", "2026-10-26T17:00:00.000Z"], // Mon after clocks back, GMT
    ["2026-10-27", "2026-10-27T10:00:00.000Z", "2026-10-27T17:00:00.000Z"], // Tue, GMT
    ["2027-03-26", "2027-03-26T10:00:00.000Z", "2027-03-26T17:00:00.000Z"], // Fri, GMT
    ["2027-03-29", "2027-03-29T09:00:00.000Z", "2027-03-29T16:00:00.000Z"], // Mon after clocks forward, BST
  ]) {
    assert.equal(localToUtc(day, "10:00", TZ), open, `${day} 10:00`);
    assert.equal(localToUtc(day, "17:00", TZ), close, `${day} 17:00`);
  }
});

test("clocks change (S1): localDay is the London calendar day, not the UTC one", () => {
  assert.equal(localDay("2026-10-23T23:30:00.000Z", TZ), "2026-10-24"); // 00:30 BST on Saturday
  assert.equal(localDay("2026-10-26T23:30:00.000Z", TZ), "2026-10-26"); // 23:30 GMT
  assert.equal(localDay("2027-03-28T23:30:00.000Z", TZ), "2027-03-29"); // 00:30 BST
  assert.equal(localDay("2026-10-25T00:30:00.000Z", TZ), "2026-10-25"); // 01:30 BST, the hour that repeats
});

// Stored times are UTC (Date#toISOString); agents get ISO 8601 with London's offset at that instant.
test("UTC storage and offset output: stored as Z, shown to agents with the London offset", () => {
  const stored = localToUtc("2026-10-26", "10:00", TZ);
  assert.match(stored, /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/);
  assert.equal(withOffset(stored, TZ), "2026-10-26T10:00:00+00:00"); // GMT
  assert.equal(withOffset("2026-10-23T09:00:00.000Z", TZ), "2026-10-23T10:00:00+01:00"); // BST
  assert.equal(withOffset("2027-03-29T15:30:00.000Z", TZ), "2027-03-29T16:30:00+01:00");
  // Round trip: the offset form names the same instant as the stored one.
  for (const iso of ["2026-10-23T09:00:00.000Z", "2026-10-26T10:00:00.000Z"])
    assert.equal(new Date(withOffset(iso, TZ)).toISOString(), iso);
  // Other zones format the same way (negative and non-hour offsets).
  assert.equal(withOffset("2026-10-26T10:00:00.000Z", "America/New_York"), "2026-10-26T06:00:00-04:00");
  assert.equal(withOffset("2026-10-26T10:00:00.000Z", "Asia/Kathmandu"), "2026-10-26T15:45:00+05:45");
});

// London wall-clock "HH:MM" of a stored UTC time.
const londonTime = (iso) => withOffset(iso, TZ).slice(11, 16);

test("slots: weekdays only, 10:00–17:00 London, on the quarter hour, ending by 17:00", () => {
  const cfg = realConfig();
  // Mon 2 Nov to Sun 8 Nov 2026 (GMT).
  const slots = candidateSlots(cfg, "consultation", "2026-11-02", "2026-11-08");
  const days = [...new Set(slots.map((s) => localDay(s.start, TZ)))];
  assert.deepEqual(days, ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
  assert.equal(slots.length, 5 * 27);
  for (const s of slots) {
    assert.equal(Date.parse(s.end) - Date.parse(s.start), 30 * 60000);
    assert.ok(londonTime(s.start) >= "10:00" && londonTime(s.end) <= "17:00", s.start);
    assert.equal(Number(londonTime(s.start).slice(3)) % 15, 0, s.start);
    assert.equal(s.start, new Date(s.start).toISOString()); // stored form: UTC ISO
  }
  const monday = slots.filter((s) => localDay(s.start, TZ) === "2026-11-02");
  assert.equal(londonTime(monday[0].start), "10:00");
  assert.equal(londonTime(monday.at(-1).start), "16:30");
  assert.equal(londonTime(monday.at(-1).end), "17:00");

  // A 15-minute type fits one more slot at each step: last start 16:45.
  const intro = candidateSlots(cfg, "recruiter-intro", "2026-11-02", "2026-11-02");
  assert.equal(intro.length, 28);
  assert.equal(londonTime(intro.at(-1).start), "16:45");

  // Weekend only, an unknown type, or an empty range: nothing.
  assert.deepEqual(candidateSlots(cfg, "consultation", "2026-11-07", "2026-11-08"), []);
  assert.deepEqual(candidateSlots(cfg, "nope", "2026-11-02", "2026-11-02"), []);
  assert.deepEqual(candidateSlots(cfg, "consultation", "2026-11-03", "2026-11-02"), []);
});

test("slots follow the config: days, hours and step", () => {
  const cfg = { ...realConfig(), hours: { days: ["sat"], start: "09:30", end: "11:00" }, slotStepMinutes: 30 };
  const slots = candidateSlots(cfg, "consultation", "2026-11-02", "2026-11-08");
  assert.deepEqual(slots.map((s) => withOffset(s.start, TZ)), ["2026-11-07T09:30:00+00:00", "2026-11-07T10:00:00+00:00", "2026-11-07T10:30:00+00:00"]);
});

// Spike S1's table: first and last 30-minute slot, and the count, either side of both changes.
test("clocks change (S1): slots on 23, 26, 27 Oct 2026 and 26, 29 Mar 2027", () => {
  const cfg = realConfig();
  for (const [day, first, last] of [
    ["2026-10-23", "2026-10-23T09:00:00.000Z", "2026-10-23T15:30:00.000Z"],
    ["2026-10-26", "2026-10-26T10:00:00.000Z", "2026-10-26T16:30:00.000Z"],
    ["2026-10-27", "2026-10-27T10:00:00.000Z", "2026-10-27T16:30:00.000Z"],
    ["2027-03-26", "2027-03-26T10:00:00.000Z", "2027-03-26T16:30:00.000Z"],
    ["2027-03-29", "2027-03-29T09:00:00.000Z", "2027-03-29T15:30:00.000Z"],
  ]) {
    const s = candidateSlots(cfg, "consultation", day, day);
    assert.equal(s.length, 27, day);
    assert.equal(s[0].start, first, day);
    assert.equal(s.at(-1).start, last, day);
    assert.equal(londonTime(s[0].start), "10:00", day);
    assert.equal(londonTime(s.at(-1).end), "17:00", day);
  }
  // Across the weekend of the change: Fri 23 and Mon 26 only, each 10:00–17:00 London.
  const span = candidateSlots(cfg, "consultation", "2026-10-23", "2026-10-26");
  assert.deepEqual([...new Set(span.map((s) => localDay(s.start, TZ)))], ["2026-10-23", "2026-10-26"]);
});

// Mon 2 Nov 2026, 12:00 GMT: notice runs to Tue 3 Nov 12:00, the horizon to Mon 30 Nov 12:00.
const NOW = new Date("2026-11-02T12:00:00.000Z");
const check = (start, over = {}) => checkSlot({ cfg: realConfig(), typeId: "consultation", start, now: NOW, busy: [], bookings: [], ...over });

test("checkSlot: unknown type, and starts that aren't offered slots", () => {
  assert.deepEqual(check("2026-11-04T10:00:00.000Z", { typeId: "nope" }), { ok: false, reason: "unknown_type" });
  for (const bad of [
    "2026-11-04T10:05:00.000Z", // not on the step
    "2026-11-04T09:45:00.000Z", // before opening
    "2026-11-04T16:45:00.000Z", // a 30-minute meeting would end after 17:00
    "2026-11-07T10:00:00.000Z", // Saturday
    "2026-11-04T10:00:30.000Z", // seconds
    "not a date", "", null,
  ]) assert.deepEqual(check(bad), { ok: false, reason: "not_a_slot" }, String(bad));
  // The same instant written with an offset is the same slot.
  assert.deepEqual(check("2026-11-04T10:00:00+00:00"), { ok: true });
  assert.deepEqual(check("2026-11-04T16:45:00.000Z", { typeId: "recruiter-intro" }), { ok: true });
});

test("checkSlot: 24 hours' notice and a 4-week horizon", () => {
  assert.deepEqual(check("2026-11-03T12:00:00.000Z"), { ok: true }); // exactly 24 h
  assert.deepEqual(check("2026-11-03T11:45:00.000Z"), { ok: false, reason: "notice" });
  assert.deepEqual(check("2026-11-02T14:00:00.000Z"), { ok: false, reason: "notice" });
  assert.deepEqual(check("2026-11-30T12:00:00.000Z"), { ok: true }); // exactly 28 days
  assert.deepEqual(check("2026-11-30T12:15:00.000Z"), { ok: false, reason: "horizon" });
  // Confirm doesn't re-apply notice (spec: a hold made with 25 h confirmed 1 h 59 later).
  assert.deepEqual(check("2026-11-02T14:00:00.000Z", { ignoreNotice: true }), { ok: true });
});

test("availableSlots: from now + 24 h to now + 28 days, from/to clamped to that window", () => {
  const cfg = realConfig();
  const all = availableSlots({ cfg, typeId: "consultation", now: NOW, busy: [], bookings: [] });
  assert.equal(all[0].start, "2026-11-03T12:00:00.000Z");
  assert.equal(all.at(-1).start, "2026-11-30T12:00:00.000Z");
  for (const s of all) assert.deepEqual(check(s.start), { ok: true });
  // 18 full weekdays (Wed 4 to Fri 27 Nov), Tue 3 Nov from 12:00 (19) and Mon 30 Nov to 12:00 (9).
  assert.equal(all.length, 18 * 27 + 19 + 9);
  assert.deepEqual(availableSlots({ cfg, typeId: "consultation", now: NOW, from: "2026-01-01", to: "2027-12-31", busy: [], bookings: [] }), all);
  const one = availableSlots({ cfg, typeId: "consultation", now: NOW, from: "2026-11-05", to: "2026-11-05", busy: [], bookings: [] });
  assert.equal(one.length, 27);
  assert.ok(one.every((s) => localDay(s.start, TZ) === "2026-11-05"));
  assert.deepEqual(availableSlots({ cfg, typeId: "consultation", now: NOW, from: "2026-12-01", busy: [], bookings: [] }), []);
  assert.deepEqual(availableSlots({ cfg, typeId: "consultation", now: NOW, to: "2026-11-02", busy: [], bookings: [] }), []);
});

// Wed 4 Nov 2026 (GMT), 11:00–11:30: with 15-minute buffers, 10:45–11:45 must be clear.
const SLOT = "2026-11-04T11:00:00.000Z";
const at = (hhmm) => `2026-11-04T${hhmm}:00.000Z`;
const span = (a, b) => ({ start: at(a), end: at(b) });

test("buffers: the slot plus 15 minutes either side must be free in free/busy", () => {
  for (const ok of [span("10:30", "10:45"), span("11:45", "12:00"), span("09:00", "10:00")])
    assert.deepEqual(check(SLOT, { busy: [ok] }), { ok: true }, JSON.stringify(ok));
  for (const clash of [span("10:30", "10:46"), span("11:44", "12:00"), span("11:10", "11:20"), span("09:00", "13:00")])
    assert.deepEqual(check(SLOT, { busy: [span("09:00", "09:15"), clash] }), { ok: false, reason: "busy" }, JSON.stringify(clash));
});

test("buffers: the same 15 minutes against other bookings and live holds", () => {
  const b = (id, a, z, status) => ({ id, ...span(a, z), status });
  for (const status of ["pending_confirmation", "confirming", "confirmed", "cancelling"]) {
    assert.deepEqual(check(SLOT, { bookings: [b("x", "11:30", "12:00", status)] }), { ok: false, reason: "taken" }, status);
    assert.deepEqual(check(SLOT, { bookings: [b("x", "11:45", "12:15", status)] }), { ok: true }, status);
    assert.deepEqual(check(SLOT, { bookings: [b("x", "10:15", "10:45", status)] }), { ok: true }, status);
  }
  // Finished bookings don't block.
  for (const status of ["declined", "expired", "cancelled"])
    assert.deepEqual(check(SLOT, { bookings: [b("x", "11:00", "11:30", status)] }), { ok: true }, status);
  // A confirm re-checks its own slot without tripping over its own row.
  const own = b("me", "11:00", "11:30", "confirming");
  assert.deepEqual(check(SLOT, { bookings: [own], excludeId: "me" }), { ok: true });
  assert.deepEqual(check(SLOT, { bookings: [own, b("other", "11:15", "11:30", "pending_confirmation")], excludeId: "me" }), { ok: false, reason: "taken" });
});

test("buffers: availableSlots drops every slot within 15 minutes of busy time", () => {
  const opts = { cfg: realConfig(), typeId: "consultation", now: NOW, from: "2026-11-04", to: "2026-11-04" };
  const free = availableSlots({ ...opts, busy: [], bookings: [] }).map((s) => s.start);
  const left = availableSlots({ ...opts, busy: [span("11:00", "11:30")], bookings: [] }).map((s) => s.start);
  assert.deepEqual(free.filter((s) => !left.includes(s)), [at("10:30"), at("10:45"), at("11:00"), at("11:15"), at("11:30")]);
  const held = availableSlots({ ...opts, busy: [], bookings: [{ id: "h", ...span("11:00", "11:30"), status: "pending_confirmation" }] }).map((s) => s.start);
  assert.deepEqual(held, left);
});
