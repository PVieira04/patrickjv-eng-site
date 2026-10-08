// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateConfig, localToUtc, localDay } from "./booking-config.js";

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
