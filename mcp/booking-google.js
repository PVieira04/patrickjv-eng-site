// Google Calendar client for booking (F-001), acting as hello@patrickjv.com through one OAuth
// refresh token. Scopes: calendar.freebusy and calendar.events.owned. By design it can only ask
// other calendars for free/busy; the only events it touches are on hello@'s own primary calendar.
// It never logs: callers log the failing subsystem only, as logFailure does.
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

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

export function createGoogle({ clientId, clientSecret, refreshToken, fetch, now = () => new Date(), sleep }) {
  let cached = null; // { token, expiresAt (ms) }

  async function refresh() {
    const res = await fetch(TOKEN_URL, {
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
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
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

  return { accessToken, freeBusy, ping };
}
