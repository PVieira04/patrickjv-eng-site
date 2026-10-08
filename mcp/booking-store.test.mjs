// Run with: npm test
// The booking store's state machine, against real SQLite (node:sqlite) and fake Google/email
// dependencies that genuinely yield (setTimeout), so interleavings like a Durable Object's happen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openSql } from "./booking-sqlite.mjs";
// Namespace import: a function not written yet fails only the tests that call it.
import * as store from "./booking-store.js";

const cfg = {
  timezone: "Europe/London",
  hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "10:00", end: "17:00" },
  slotStepMinutes: 15, minNoticeHours: 24, horizonDays: 28, bufferMinutes: 15, maxPerDay: 3,
  holdHours: 2, retentionDays: 30,
  caps: { perIpPerDay: 4, perEmailPerDay: 2, globalPerDay: 10, liveHoldsPerKey: 1 },
  meetingTypes: [
    { id: "consultation", title: "Consultation", minutes: 30, description: "A consultation." },
    { id: "recruiter-intro", title: "Recruiter intro", minutes: 15, description: "An intro." },
  ],
  calendars: [],
};

const NOW = new Date("2026-10-19T09:00:00.000Z"); // Monday
const SLOT = "2026-10-21T10:00:00.000Z"; // Wednesday, 49 hours ahead
const HOUR = 3600e3;
const later = (ms, from = NOW) => new Date(from.getTime() + ms);
const tick = () => new Promise((r) => setTimeout(r, Math.random() * 5));

// A stand-in for package A's checkSlot with the contract's rules that matter here: unknown type,
// notice, overlap (with buffer) against busy and other bookings, excludeId, and day_full (counted
// on the UTC day, which is the London day for these test times' purposes).
const LIVE = new Set(["pending_confirmation", "confirming", "confirmed", "cancelling"]);
const COUNTS = new Set(["confirming", "confirmed", "cancelling"]);
function fakeCheckSlot({ cfg, typeId, start, now, busy, bookings, ignoreNotice = false, excludeId }) {
  const type = cfg.meetingTypes.find((t) => t.id === typeId);
  if (!type) return { ok: false, reason: "unknown_type" };
  const s = Date.parse(start);
  if (Number.isNaN(s)) return { ok: false, reason: "not_a_slot" };
  if (!ignoreNotice && s < now.getTime() + cfg.minNoticeHours * HOUR) return { ok: false, reason: "notice" };
  const e = s + type.minutes * 60e3, buf = cfg.bufferMinutes * 60e3;
  const hits = (i) => Date.parse(i.start) < e + buf && Date.parse(i.end) > s - buf;
  if (busy.some(hits)) return { ok: false, reason: "busy" };
  const others = bookings.filter((b) => b.id !== excludeId && LIVE.has(b.status));
  if (others.some(hits)) return { ok: false, reason: "taken" };
  const day = start.slice(0, 10);
  if (others.filter((b) => COUNTS.has(b.status) && b.start.slice(0, 10) === day).length >= cfg.maxPerDay) return { ok: false, reason: "day_full" };
  return { ok: true };
}

const ACT = "https://patrickjv.com/api/booking/act?t=";
const tokenOf = (url) => url.slice(ACT.length);

// Fresh database plus recording fakes. Every fake awaits a real timer before answering.
function setup({ busy = [], emailFails = false, insertFails = false, deleteFails = false } = {}) {
  const sql = openSql();
  store.migrate(sql);
  const calls = { freeBusy: 0, emails: [], inserted: [], deleted: [] };
  const deps = {
    checkSlot: fakeCheckSlot,
    freeBusy: async () => { calls.freeBusy++; await tick(); return { busy }; },
    sendEmail: async (kind, booking, links) => {
      await tick();
      if (typeof emailFails === "function" ? emailFails(kind) : emailFails) throw new Error("mail down");
      calls.emails.push({ kind, booking, links });
    },
    actUrl: (t) => ACT + t,
    day: (iso) => iso.slice(0, 10),
    insertEvent: async (ev) => {
      await tick();
      if (insertFails) throw new Error("google down");
      calls.inserted.push(ev);
      return { created: true, meetLink: "https://meet.google.com/abc-defg-hij" };
    },
    deleteEvent: async (id) => { await tick(); if (deleteFails) throw new Error("google down"); calls.deleted.push(id); return { deleted: true }; },
  };
  return { sql, deps, calls };
}

let n = 0;
const input = (over = {}) => ({ type: "consultation", start: SLOT, name: "Jane Smith", email: "jane@example.com", note: "Hello", source: "page", ...over });
// A request from a distinct IP and email unless told otherwise.
const request = (t, over = {}, keys = {}) => {
  n++;
  return store.requestBooking(t.sql, { cfg, now: keys.now ?? NOW, input: input(over), ipKey: keys.ipKey ?? `ip${n}`, emailKey: keys.emailKey ?? `em${n}`, deps: t.deps });
};
const row = (t, id) => t.sql.exec("SELECT * FROM bookings WHERE id = ?", id).one();

test("booking IDs are 32 random lowercase hex characters (128 bits), never repeated", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => store.newId()));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test("tokens are 128-bit base64url; the hash is hex SHA-256 of the token", async () => {
  const { token, hash } = await store.newToken();
  assert.match(token, /^[A-Za-z0-9_-]{22}$/, "16 bytes, base64url, unpadded");
  const expect = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
  assert.equal(hash, expect);
  assert.notEqual((await store.newToken()).token, token);
});

test("migrate is idempotent", () => {
  const sql = openSql();
  store.migrate(sql);
  store.migrate(sql);
  const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((r) => r.name);
  assert.deepEqual(tables, ["bookings", "quota", "tokens"]);
});
