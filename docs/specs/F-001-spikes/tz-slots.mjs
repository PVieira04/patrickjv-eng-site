// Timezone spike for F-001: Europe/London slots as UTC instants using only Intl (as in a Worker).
// Run: node docs/specs/F-001-spikes/tz-slots.mjs
const TZ = "Europe/London";
// Offset (minutes) of TZ at a given UTC instant.
function offsetAt(utcMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs) / 60000;
}
// Local wall time in TZ -> UTC ms (two-pass to settle across a transition).
function localToUtc(y, m, d, hh, mm) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetAt(guess) * 60000;
  t = guess - offsetAt(t) * 60000;
  return t;
}
function daySlots(y, m, d, minutes, step = 15) {
  const out = [];
  for (let start = 10 * 60; start + minutes <= 17 * 60; start += step) {
    const s = localToUtc(y, m, d, Math.floor(start / 60), start % 60);
    out.push(s);
  }
  return out;
}
const iso = (ms) => new Date(ms).toISOString().slice(11, 16) + "Z";
const london = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(ms);
let fail = 0;
const check = (name, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${got}${ok ? "" : " (want " + want + ")"}`); };
for (const [y, m, d, firstUtc, lastUtc] of [
  [2026, 10, 23, "09:00Z", "15:30Z"], [2026, 10, 26, "10:00Z", "16:30Z"], [2026, 10, 27, "10:00Z", "16:30Z"],
  [2027, 3, 26, "10:00Z", "16:30Z"], [2027, 3, 29, "09:00Z", "15:30Z"],
]) {
  const s = daySlots(y, m, d, 30);
  check(`${y}-${m}-${d} first`, iso(s[0]), firstUtc);
  check(`${y}-${m}-${d} last`, iso(s.at(-1)), lastUtc);
  check(`${y}-${m}-${d} count`, s.length, 27);
  console.log(`   shown in London: ${london(s[0])} … ${london(s.at(-1))}`);
}
// Visitor display in another zone names the zone.
const s = daySlots(2026, 10, 26, 30)[0];
console.log("   Paris visitor sees:", new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "short" }).format(s), "(Europe/Paris)");
console.log("   Kathmandu visitor sees:", new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", timeStyle: "long" }).format(s));
// ISO 8601 with offset for agents.
const off = offsetAt(s); const sign = off >= 0 ? "+" : "-"; const a = Math.abs(off);
const local = new Date(s + off * 60000).toISOString().slice(0, 19);
console.log("   agent ISO:", `${local}${sign}${String(a / 60 | 0).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`);
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
