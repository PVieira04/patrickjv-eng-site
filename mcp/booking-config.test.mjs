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

test("day_full: at most 3 confirmed meetings per London day; holds don't count", () => {
  const b = (id, hhmm, status = "confirmed") => ({ id, ...span(hhmm, hhmm.replace(":00", ":30")), status });
  const three = [b("a", "10:00"), b("b", "13:00"), b("c", "15:00")];
  assert.deepEqual(check(SLOT, { bookings: three }), { ok: false, reason: "day_full" });
  // Meetings being created or deleted still count; holds don't, so fake holds can't fill a day.
  assert.deepEqual(check(SLOT, { bookings: [b("a", "10:00", "confirming"), b("b", "13:00", "cancelling"), b("c", "15:00")] }), { ok: false, reason: "day_full" });
  assert.deepEqual(check(SLOT, { bookings: [b("a", "10:00", "pending_confirmation"), b("b", "13:00"), b("c", "15:00")] }), { ok: true });
  assert.deepEqual(check(SLOT, { bookings: [b("a", "10:00", "cancelled"), b("b", "13:00"), b("c", "15:00")] }), { ok: true });
  // Another day's meetings don't count.
  assert.deepEqual(check(SLOT, { bookings: three.map((x) => ({ ...x, start: x.start.replace("11-04", "11-05"), end: x.end.replace("11-04", "11-05") })) }), { ok: true });
  // The confirm being re-checked doesn't count itself: it would be the 3rd, not the 4th.
  const own = { id: "me", ...span("11:00", "11:30"), status: "confirming" };
  assert.deepEqual(check(SLOT, { bookings: [own, b("b", "13:00"), b("c", "15:00")], excludeId: "me", ignoreNotice: true }), { ok: true });
  assert.deepEqual(check(SLOT, { bookings: [own, ...three], excludeId: "me", ignoreNotice: true }), { ok: false, reason: "day_full" });
  // A full day offers no slots; the next day is unaffected.
  const opts = { cfg: realConfig(), typeId: "consultation", now: NOW, busy: [], bookings: three };
  assert.deepEqual(availableSlots({ ...opts, from: "2026-11-04", to: "2026-11-04" }), []);
  assert.equal(availableSlots({ ...opts, from: "2026-11-05", to: "2026-11-05" }).length, 27);
});

test("day_full counts by the London day, not the UTC day", () => {
  // Fri 23 Oct 2026 is BST: 23:00 UTC on the 22nd is already 00:00 on the 23rd in London.
  const now = new Date("2026-10-21T12:00:00.000Z");
  const slot = "2026-10-23T09:00:00.000Z"; // 10:00 BST
  const at = (iso) => ({ start: iso, end: new Date(Date.parse(iso) + 30 * 60000).toISOString(), status: "confirmed" });
  const london23 = ["2026-10-22T23:00:00.000Z", "2026-10-22T23:30:00.000Z", "2026-10-23T14:00:00.000Z"].map((iso, i) => ({ id: `l${i}`, ...at(iso) }));
  const london22 = ["2026-10-22T21:00:00.000Z", "2026-10-22T22:00:00.000Z", "2026-10-23T14:00:00.000Z"].map((iso, i) => ({ id: `m${i}`, ...at(iso) }));
  assert.deepEqual(check(slot, { now, bookings: london23 }), { ok: false, reason: "day_full" });
  assert.deepEqual(check(slot, { now, bookings: london22 }), { ok: true });
});

// npm test runs before every deploy, so this is how a bad booking.json fails the build.
test("booking.json: the repo's real file passes validation", () => {
  const cfg = realConfig();
  assert.equal(validateConfig(cfg), cfg);
});

test("validateConfig: every bad value is refused, naming the field", () => {
  const bad = (fn) => { const c = realConfig(); fn(c); return c; };
  for (const [field, cfg] of [
    ["config", null], ["config", []],
    ["timezone", bad((c) => { c.timezone = "Mars/Olympus"; })],
    ["timezone", bad((c) => { delete c.timezone; })],
    ["hours", bad((c) => { delete c.hours; })],
    ["hours.days", bad((c) => { c.hours.days = ["mon", "funday"]; })],
    ["hours.days", bad((c) => { c.hours.days = []; })],
    ["hours.days", bad((c) => { c.hours.days = ["mon", "mon"]; })],
    ["hours.start", bad((c) => { c.hours.start = "9:00"; })],
    ["hours.start", bad((c) => { c.hours.start = "24:00"; })],
    ["hours.end", bad((c) => { c.hours.end = "17:60"; })],
    ["hours.end", bad((c) => { c.hours.start = "17:00"; c.hours.end = "10:00"; })],
    ["hours.end", bad((c) => { c.hours.end = "10:00"; })],
    ...["slotStepMinutes", "minNoticeHours", "horizonDays", "bufferMinutes", "maxPerDay", "holdHours", "retentionDays"].flatMap((k) =>
      [0, -1, 1.5, "15", null].map((v) => [k, bad((c) => { c[k] = v; })])),
    ["caps", bad((c) => { delete c.caps; })],
    ...["perIpPerDay", "perEmailPerDay", "globalPerDay", "liveHoldsPerEmail"].flatMap((k) =>
      [0, 2.5, "4", undefined].map((v) => [`caps.${k}`, bad((c) => { c.caps[k] = v; })])),
    ["meetingTypes", bad((c) => { c.meetingTypes = []; })],
    ["meetingTypes", bad((c) => { c.meetingTypes = {}; })],
    ["meetingTypes[0].id", bad((c) => { c.meetingTypes[0].id = "Consultation"; })],
    ["meetingTypes[0].id", bad((c) => { c.meetingTypes[0].id = "a b"; })],
    ["meetingTypes[1].id", bad((c) => { c.meetingTypes[1].id = "consultation"; })],
    ["meetingTypes[0].title", bad((c) => { c.meetingTypes[0].title = ""; })],
    ["meetingTypes[0].description", bad((c) => { c.meetingTypes[0].description = 42; })],
    ["meetingTypes[0].minutes", bad((c) => { c.meetingTypes[0].minutes = 20; })], // not a multiple of the 15-minute step
    ["meetingTypes[0].minutes", bad((c) => { c.meetingTypes[0].minutes = 0; })],
    ["meetingTypes[1].minutes", bad((c) => { c.meetingTypes[1].minutes = "15"; })],
    ["calendars", bad((c) => { c.calendars = "primary"; })],
    ["calendars[0]", bad((c) => { c.calendars[0].id = "primary"; })], // both id and idSecret
    ["calendars[2]", bad((c) => { delete c.calendars[2].id; })], // blocks, but neither
    ["calendars[1]", bad((c) => { c.calendars[1].id = "x"; c.calendars[1].idSecret = "CAL_X"; })],
    ["calendars[0].blocks", bad((c) => { c.calendars[0].blocks = "yes"; })],
    ["calendars[0].idSecret", bad((c) => { c.calendars[0].idSecret = "cal-main"; })],
    ["calendars[2].id", bad((c) => { c.calendars[2].id = ""; })],
    // A personal calendar's ID is an email address: it belongs in a Worker secret, not this public file.
    ["calendars[2].id", bad((c) => { c.calendars[2].id = "someone@googlemail.com"; })],
    ["calendars[1].account", bad((c) => { delete c.calendars[1].account; })],
    ["calendars[1].label", bad((c) => { c.calendars[1].label = ""; })],
  ]) {
    assert.throws(() => validateConfig(cfg), (e) => e instanceof Error && e.message.includes(field), `${field}: ${JSON.stringify(cfg)?.slice(0, 120)}`);
  }
});

test("validateConfig: a calendar that doesn't block needs no ID (it is never queried)", () => {
  const cfg = realConfig();
  assert.deepEqual(cfg.calendars[1], { account: "personal", label: "Birthdays", blocks: false });
  assert.equal(validateConfig(cfg), cfg);
});

// Performance (review): a full-horizon availableSlots, with ~20 live bookings, must stay cheap —
// it runs on every get_availability. The golden hash pins the result to the output of the
// original, unoptimised implementation on this fixed input, so a faster version can't drift.
test("availableSlots: full horizon with 20 bookings is fast and gives exactly the original result", async () => {
  const cfg = realConfig();
  const now = new Date("2026-10-19T09:00:00.000Z"); // Mon, BST; the horizon crosses the 25 Oct clock change
  const days = ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-11-02", "2026-11-04", "2026-11-10", "2026-11-13"];
  const statuses = ["confirmed", "pending_confirmation", "confirming", "cancelled", "cancelling"];
  const bookings = Array.from({ length: 17 }, (_, i) => {
    const start = Date.parse(localToUtc(days[i % days.length], `${String(10 + (i * 3) % 7).padStart(2, "0")}:${["00", "15", "30", "45"][i % 4]}`, TZ));
    return { id: `b${i}`, status: statuses[i % statuses.length], start: new Date(start).toISOString(), end: new Date(start + 30 * 60000).toISOString() };
  });
  // A day filled by three meetings (maxPerDay), so day_full is exercised too.
  for (const [i, t] of ["10:00", "12:00", "14:00"].entries()) {
    const start = Date.parse(localToUtc("2026-11-05", t, TZ));
    bookings.push({ id: `f${i}`, status: "confirmed", start: new Date(start).toISOString(), end: new Date(start + 30 * 60000).toISOString() });
  }
  const busy = [
    { start: "2026-10-22T11:00:00Z", end: "2026-10-22T13:00:00Z" },
    { start: "2026-10-26T15:00:00Z", end: "2026-10-26T16:00:00Z" },
    { start: "2026-11-09T00:00:00Z", end: "2026-11-10T00:00:00Z" },
  ];
  const run = (typeId) => availableSlots({ cfg, typeId, now, busy, bookings });
  run("consultation"); // warm up
  const t0 = performance.now();
  const slots = { consultation: run("consultation"), "recruiter-intro": run("recruiter-intro") };
  const ms = performance.now() - t0;
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(JSON.stringify(slots)).digest("hex");
  assert.deepEqual([slots.consultation.length, slots["recruiter-intro"].length, hash], GOLDEN);
  assert.ok(ms < 200, `two full-horizon calls took ${ms.toFixed(1)} ms`);
});
// From the original implementation (commit c703977) on the input above.
const GOLDEN = [381, 410, "082808ca43196a7f6ab30d9305e78ab254a888bbae0146cc406317a580bb4a91"];

// Found in the live MCP test (8 Oct 2026): hold_expires (now + 2 h) has milliseconds, and the
// offset came out fractional ("+00:59.99778…"). Output is to the second with a whole-minute offset.
test("withOffset: an instant with milliseconds still gets a whole-minute offset", () => {
  assert.equal(withOffset("2026-10-09T00:13:21.997Z", "Europe/London"), "2026-10-09T01:13:21+01:00");
  assert.equal(withOffset("2026-10-26T10:00:00.500Z", "Europe/London"), "2026-10-26T10:00:00+00:00");
});
