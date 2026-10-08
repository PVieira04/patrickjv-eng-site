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
