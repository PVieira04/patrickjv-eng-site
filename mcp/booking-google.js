// Google Calendar client for booking (F-001), acting as hello@patrickjv.com through one OAuth
// refresh token. Scopes: calendar.freebusy and calendar.events.owned. By design it can only ask
// other calendars for free/busy; the only events it touches are on hello@'s own primary calendar.
// It never logs: callers log the failing subsystem only, as logFailure does.
const TOKEN_URL = "https://oauth2.googleapis.com/token";

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

const readJson = async (res) => { try { return await res.json(); } catch { return null; } };

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

  return { accessToken, ping };
}
