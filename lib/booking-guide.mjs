// The booking guide (F-002, US-7): written once in content.json (booking_guide), with the request
// link's lifetime and the meeting types filled in from booking.json, so it never states a timing
// or a type the configuration doesn't have. Shared by build.mjs (llms.txt, index.md, /book.md, the
// page's WebMCP data) and the MCP Worker (initialize instructions, get_booking_guide).
export function bookingGuide(c, cfg) {
  const g = c.booking_guide;
  const fill = (s) => s
    .replaceAll("{request_minutes}", String(cfg.requestMinutes))
    .replaceAll("{meeting_types}", cfg.meetingTypes.map((t) => `${t.title}, ${t.minutes} minutes`).join("; "));
  return [`# ${g.title}`, "", ...g.steps.map((s, i) => `${i + 1}. ${fill(s)}`), "", fill(g.cancel), ""].join("\n");
}
