// Google Calendar client for booking (F-001), acting as hello@patrickjv.com through one OAuth
// refresh token. Scopes: calendar.freebusy and calendar.events.owned. By design it can only ask
// other calendars for free/busy; the only events it touches are on hello@'s own primary calendar.
// It never logs: callers log the failing subsystem only, as logFailure does.
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
// Every call gives up after this, so a hung Google can't hold a booking open for long.
const TIMEOUT_MS = 20_000;

// `status` is the HTTP status (0 when there was no usable response); `reason` is Google's short
// error code (e.g. invalid_grant, notFound). Messages never carry tokens, secrets or addresses.
export class GoogleError extends Error {
  constructor(message, { status = 0, reason = "unknown" } = {}) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
    this.reason = reason;
  }
}

// Any calendar that couldn't be read makes availability unknown, never "free". The message names
// no calendar: personal calendar IDs are email addresses, kept as secrets.
export function assertNoErrors(result) {
  if (result.errors.length) throw new GoogleError("free/busy failed for a calendar", { status: 503, reason: result.errors[0].reason });
}

const readJson = async (res) => { try { return await res.json(); } catch { return null; } };
// Google's error bodies: {error: {errors: [{reason}], status}} for the Calendar API.
const apiReason = (body) => body?.error?.errors?.[0]?.reason || body?.error?.status || "unknown";

// Sorted, with overlapping or touching intervals joined; times normalised to toISOString().
function mergeBusy(intervals) {
  const sorted = intervals.map((b) => [Date.parse(b.start), Date.parse(b.end)]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() }));
}

const meetStatus = (ev) => ev?.conferenceData?.createRequest?.status?.statusCode;
// An event's Google Meet link, once Meet creation has succeeded; otherwise null.
export const meetLinkOf = (ev) => (meetStatus(ev) === "success" && ev.hangoutLink ? ev.hangoutLink : null);

export function createGoogle({ clientId, clientSecret, refreshToken, fetch, now = () => new Date(), sleep }) {
  let cached = null; // { token, expiresAt (ms) }

  async function refresh() {
    const res = await fetch(TOKEN_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
    });
    const body = await readJson(res);
    if (!res.ok || typeof body?.access_token !== "string") {
      throw new GoogleError("Google token refresh failed", { status: res.status, reason: typeof body?.error === "string" ? body.error : "no_access_token" });
    }
    cached = { token: body.access_token, expiresAt: now().getTime() + Number(body.expires_in || 0) * 1000 };
    return cached.token;
  }

  // Cached until 60 s before Google says it expires, so a token never lapses mid-request.
  async function accessToken() {
    if (cached && now().getTime() < cached.expiresAt - 60_000) return cached.token;
    return refresh();
  }

  // For health: always a fresh refresh, so a revoked refresh token shows even while an access
  // token is cached.
  async function ping() {
    try { await refresh(); return true; } catch { return false; }
  }

  async function api(path, { method = "GET", body } = {}) {
    const token = await accessToken(); // before the timeout starts: a refresh has its own
    const res = await fetch(API + path, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ok: res.ok, body: await readJson(res) };
  }
  const fail = (what, r) => new GoogleError(`Google ${what} failed`, { status: r.status, reason: apiReason(r.body) });

  // The only read of other calendars: busy intervals, no titles or details.
  async function freeBusy(calendarIds, timeMin, timeMax) {
    const r = await api("/freeBusy", { method: "POST", body: { timeMin, timeMax, items: calendarIds.map((id) => ({ id })) } });
    if (!r.ok) throw fail("freebusy", r);
    const busy = [], errors = [];
    for (const id of calendarIds) {
      const cal = r.body?.calendars?.[id];
      if (!cal) errors.push({ calendar: id, reason: "missing" });
      else if (cal.errors?.length) errors.push({ calendar: id, reason: cal.errors[0].reason || "unknown" });
      else busy.push(...(cal.busy || []));
    }
    return { busy: mergeBusy(busy), errors };
  }

  // Events live only on hello@'s own primary calendar, so hello@ is the organiser. `attendees` are
  // email addresses (Patrick's and the guest's). The booking ID is the event ID: a retried insert
  // gets 409 rather than making a second event.
  const eventPath = (id) => `/calendars/primary/events/${encodeURIComponent(id)}`;

  // One event on hello@'s own primary calendar, by its ID (the booking ID); null if there is none.
  // Recovery uses it to see whether an insert whose answer was lost made the event.
  async function getEvent(id) {
    const r = await api(eventPath(id));
    if (r.status === 404 || r.status === 410) return null;
    if (!r.ok) throw fail("events.get", r);
    return r.body;
  }

  async function insertEvent({ id, summary, description, start, end, timeZone, attendees }) {
    const r = await api("/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", {
      method: "POST",
      body: {
        id, summary, description,
        // The zone makes Google show invites in London time, not UTC (the instant is unchanged).
        start: { dateTime: start, timeZone }, end: { dateTime: end, timeZone },
        attendees: attendees.map((email) => ({ email })),
        // Keeps Patrick's personal address out of the guest list the guest sees.
        guestsCanSeeOtherGuests: false,
        conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } },
      },
    });
    if (r.status !== 409 && !r.ok) throw fail("events.insert", r);
    const created = r.status !== 409;
    // From here the event exists, so nothing below may throw: a failed re-read only costs the link
    // (the invite carries it), never the booking.
    let ev = created ? r.body : null;
    try {
      // A 409 has no event body, so the existing event is read for its link.
      if (!created) ev = await getEvent(id);
      // Meet links are made asynchronously: re-read while pending, up to 5 times a second apart.
      for (let i = 0; i < 5 && meetStatus(ev) === "pending"; i++) {
        await sleep(1000);
        ev = await getEvent(id);
      }
    } catch { /* keep what we have */ }
    return { created, meetLink: meetLinkOf(ev) };
  }

  // Google emails the attendees the cancellation. Already gone (404/410) isn't an error.
  async function deleteEvent(id) {
    const r = await api(`${eventPath(id)}?sendUpdates=all`, { method: "DELETE" });
    if (r.status === 404 || r.status === 410) return { deleted: false };
    if (!r.ok) throw fail("events.delete", r);
    return { deleted: true };
  }

  return { accessToken, freeBusy, insertEvent, getEvent, deleteEvent, ping };
}
