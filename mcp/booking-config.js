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

// Agent-facing form of a stored UTC time: local wall time in tz with its offset, to the second.
export function withOffset(iso, tz) {
  const ms = Date.parse(iso);
  const off = offsetAt(ms, tz);
  const a = Math.abs(off);
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(ms + off * 60000).toISOString().slice(0, 19);
  return `${local}${off < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
