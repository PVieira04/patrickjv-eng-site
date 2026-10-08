// Booking rules from booking.json (repo root): config validation, Europe/London time, slots and
// availability. Pure functions, no I/O: callers pass the clock, free/busy and live bookings.

export function validateConfig(cfg) {
  return cfg;
}

// Zone maths with Intl only (proven by spike S1, docs/specs/F-001-spikes/tz-slots.mjs).
// Wall-clock fields of a UTC instant in tz.
function wallClock(utcMs, tz) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(utcMs));
  return Object.fromEntries(parts.map((x) => [x.type, x.value]));
}
// Offset of tz from UTC, in minutes, at a UTC instant.
function offsetAt(utcMs, tz) {
  const p = wallClock(utcMs, tz);
  return (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs) / 60000;
}
// Wall time on a local day to UTC ms: two passes, so a time near a clock change settles on the
// offset in force at that instant.
function localToUtcMs(day, hhmm, tz) {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetAt(guess, tz) * 60000;
  return guess - offsetAt(first, tz) * 60000;
}

export const localToUtc = (day, hhmm, tz) => new Date(localToUtcMs(day, hhmm, tz)).toISOString();

export function localDay(iso, tz) {
  const p = wallClock(Date.parse(iso), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const hhmmOf = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Every slot the hours allow for a meeting type, on London days fromDay..toDay inclusive. Each
// day's times are converted separately, so a clock change between days can't shift them.
export function candidateSlots(cfg, typeId, fromDay, toDay) {
  const type = cfg.meetingTypes.find((t) => t.id === typeId);
  if (!type) return [];
  const open = minutesOf(cfg.hours.start), close = minutesOf(cfg.hours.end);
  const out = [];
  for (let day = fromDay; day <= toDay; day = nextDay(day)) {
    if (!cfg.hours.days.includes(DAY_NAMES[new Date(`${day}T00:00:00Z`).getUTCDay()])) continue;
    for (let m = open; m + type.minutes <= close; m += cfg.slotStepMinutes) {
      const start = localToUtcMs(day, hhmmOf(m), cfg.timezone);
      out.push({ start: new Date(start).toISOString(), end: new Date(start + type.minutes * 60000).toISOString() });
    }
  }
  return out;
}

const HOUR = 3600000, DAY = 24 * HOUR;
// Bookings that hold their time: holds, and meetings that exist or are being created or deleted.
const LIVE = new Set(["pending_confirmation", "confirming", "confirmed", "cancelling"]);
const overlaps = (aStart, aEnd, b) => Date.parse(b.start) < aEnd && Date.parse(b.end) > aStart;

// Whether `start` (any ISO 8601 form) can be booked now for a meeting type.
export function checkSlot({ cfg, typeId, start, now, busy, bookings, ignoreNotice = false, excludeId }) {
  if (!cfg.meetingTypes.some((t) => t.id === typeId)) return { ok: false, reason: "unknown_type" };
  const ms = typeof start === "string" ? Date.parse(start) : NaN;
  if (Number.isNaN(ms)) return { ok: false, reason: "not_a_slot" };
  const day = localDay(new Date(ms).toISOString(), cfg.timezone);
  const slot = candidateSlots(cfg, typeId, day, day).find((s) => Date.parse(s.start) === ms);
  if (!slot) return { ok: false, reason: "not_a_slot" };
  if (!ignoreNotice && ms < now.getTime() + cfg.minNoticeHours * HOUR) return { ok: false, reason: "notice" };
  if (ms > now.getTime() + cfg.horizonDays * DAY) return { ok: false, reason: "horizon" };
  // The meeting plus the buffer before and after must touch nothing busy or booked.
  const buffer = cfg.bufferMinutes * 60000;
  const from = ms - buffer, to = Date.parse(slot.end) + buffer;
  if (busy.some((b) => overlaps(from, to, b))) return { ok: false, reason: "busy" };
  const others = bookings.filter((b) => LIVE.has(b.status) && b.id !== excludeId);
  if (others.some((b) => overlaps(from, to, b))) return { ok: false, reason: "taken" };
  // The daily cap counts meetings, not holds, so fake holds can't fill a day.
  const meetings = others.filter((b) => b.status !== "pending_confirmation" && localDay(b.start, cfg.timezone) === day);
  if (meetings.length >= cfg.maxPerDay) return { ok: false, reason: "day_full" };
  return { ok: true };
}

// Slots that pass checkSlot, on London days from..to ("YYYY-MM-DD", optional), clamped to today
// through the horizon. The caller validates the format of from and to.
export function availableSlots({ cfg, typeId, now, from, to, busy, bookings }) {
  const today = localDay(now.toISOString(), cfg.timezone);
  const last = localDay(new Date(now.getTime() + cfg.horizonDays * DAY).toISOString(), cfg.timezone);
  const first = from && from > today ? from : today;
  const end = to && to < last ? to : last;
  return candidateSlots(cfg, typeId, first, end)
    .filter((s) => checkSlot({ cfg, typeId, start: s.start, now, busy, bookings }).ok);
}

// Agent-facing form of a stored UTC time: local wall time in tz with its offset, to the second.
export function withOffset(iso, tz) {
  const ms = Date.parse(iso);
  const off = offsetAt(ms, tz);
  const a = Math.abs(off);
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(ms + off * 60000).toISOString().slice(0, 19);
  return `${local}${off < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
