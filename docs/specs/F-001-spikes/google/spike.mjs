// Live Google spike for F-001. Throwaway; nothing here goes in the repo.
// Env: GOOGLE_CLIENT_FILE (downloaded client JSON), GOOGLE_REFRESH_TOKEN,
//      SHARED_CAL_ID (a personal calendar shared with hello@ as "See only free/busy"),
//      GUEST_EMAIL (an outside address you can check), TEST_DAY (YYYY-MM-DD with the test items below).
// Before running, put these on SHARED_CAL_ID on TEST_DAY (London time):
//   10:00–10:30 normal event (Busy)  |  12:00–12:30 event set to "Free"  |  14:00 task with a time, set to Busy
import { loadClient } from "./client.mjs";
const env = process.env;
const client = loadClient();
for (const k of ["GOOGLE_REFRESH_TOKEN", "SHARED_CAL_ID", "GUEST_EMAIL", "TEST_DAY"])
  if (!env[k]) throw new Error(`Set ${k}`);
const results = [];
const note = (name, ok, detail) => { results.push([name, ok]); console.log(`${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Refresh token -> access token
const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
  client_id: client.id, client_secret: client.secret, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }) })).json();
note("token refresh", !!tok.access_token, tok.access_token ? `scopes: ${tok.scope}` : JSON.stringify(tok));
if (!tok.access_token) process.exit(1);
const api = (path, opts = {}) => fetch("https://www.googleapis.com/calendar/v3" + path, { ...opts,
  headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", ...opts.headers } });

// 2. freebusy on the shared calendar and hello@'s own
const day = env.TEST_DAY;
const fb = await (await api("/freeBusy", { method: "POST", body: JSON.stringify({
  timeMin: `${day}T00:00:00Z`, timeMax: `${day}T23:59:59Z`, timeZone: "Europe/London",
  items: [{ id: env.SHARED_CAL_ID }, { id: "primary" }] }) })).json();
const shared = fb.calendars?.[env.SHARED_CAL_ID];
note("freebusy on shared calendar", !!shared && !shared.errors, shared?.errors ? JSON.stringify(shared.errors) : `${shared?.busy?.length} busy blocks`);
const busy = (shared?.busy ?? []).map((b) => [b.start, b.end]);
const london = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
busy.forEach(([s, e]) => console.log(`   busy ${london(s)}–${london(e)}`));
const covers = (hhmm) => busy.some(([s, e]) => london(s) <= hhmm && hhmm < london(e));
note("normal event at 10:00 blocks", covers("10:00"));
note("'Free' event at 12:00 does NOT block", !covers("12:00"), "spec assumes free events are omitted");
note("timed Busy task at 14:00", null, covers("14:00") ? "BLOCKS (spec says it will)" : "does not block (update spec)");

// 3. Insert event with hex ID, guest, Meet link
const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const start = new Date(Date.now() + 3 * 864e5); start.setUTCMinutes(0, 0, 0);
const body = { id, summary: "Spike: F-001 test booking", description: "Test from the booking spike. Will be deleted.",
  start: { dateTime: start.toISOString() }, end: { dateTime: new Date(+start + 30 * 6e4).toISOString() },
  attendees: [{ email: env.GUEST_EMAIL }],
  conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } } };
const ins = await api("/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", { method: "POST", body: JSON.stringify(body) });
const ev = await ins.json();
note("events.insert with hex id + attendee", ins.status === 200, ins.status === 200 ? `id ${id}` : `${ins.status} ${JSON.stringify(ev.error)}`);
if (ins.status === 200) {
  let status = ev.conferenceData?.createRequest?.status?.statusCode, link = ev.hangoutLink;
  for (let i = 0; i < 5 && status === "pending"; i++) {
    await sleep(2000);
    const g = await (await api(`/calendars/primary/events/${id}`)).json();
    status = g.conferenceData?.createRequest?.status?.statusCode; link = g.hangoutLink;
  }
  note("Meet link created", status === "success" && !!link, `${status} ${link ?? ""}`);

  // 4. Repeat insert with the same id
  const dup = await api("/calendars/primary/events?conferenceDataVersion=1", { method: "POST", body: JSON.stringify(body) });
  note("repeat insert returns 409", dup.status === 409, String(dup.status));

  console.log(`\n   Check ${env.GUEST_EMAIL} for the invite now (from hello@, with a Meet link). Deleting in 60 s…`);
  await sleep(60000);

  // 5. Delete with notification, then reuse the id
  const del = await api(`/calendars/primary/events/${id}?sendUpdates=all`, { method: "DELETE" });
  note("delete with sendUpdates=all", del.status === 204, String(del.status));
  const re = await api("/calendars/primary/events", { method: "POST", body: JSON.stringify({ ...body, attendees: [], conferenceData: undefined }) });
  note("re-insert of a deleted id", null, `${re.status} (spec assumes 409; IDs are never reused anyway)`);
  if (re.status === 200) await api(`/calendars/primary/events/${id}`, { method: "DELETE" });
}
const failed = results.filter(([, ok]) => ok === false).length;
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS (plus INFO lines to read)");
