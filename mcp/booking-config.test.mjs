// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateConfig } from "./booking-config.js";

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
