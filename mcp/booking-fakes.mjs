// Test helper: a fake `fetch` standing in for Google (token, free/busy, events) and Resend, plus
// the env a fully configured booking Worker has. No network. Every call is recorded.
export const ENV = {
  GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", GOOGLE_REFRESH_TOKEN: "refresh-token",
  RESEND_API_KEY: "re_key", BOOKING_OWNER_EMAIL: "owner@example.net", BOOKING_FROM: "Patrick Vieira <hello@patrickjv.com>",
  CAL_PERSONAL_MAIN: "main@example.net", CAL_PERSONAL_FAMILY: "family@example.net",
};

// opts: busy [{start,end}] reported for every calendar; fail: {token, freebusy, insert, delete, mail,
// afterCreate} (true → that call fails; afterCreate makes the event, then answers 503); insertStatus
// (e.g. 409); gate: a promise every Google call awaits first; afterInsert: awaited once an insert
// has made the event, before it answers.
export function fakeFetch(opts = {}) {
  const calls = [];
  const events = new Map();
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body && (init.headers?.["content-type"] === "application/json" ? JSON.parse(init.body) : init.body);
    calls.push({ url: String(url), method: init.method || "GET", body });
    if (opts.gate) await opts.gate();
    if (u.host === "api.resend.com") {
      if (opts.fail?.mail) return json(500, { name: "application_error" });
      return json(200, { id: `mail-${calls.length}` });
    }
    if (u.host === "oauth2.googleapis.com") {
      if (opts.fail?.token) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: "at", expires_in: 3600 });
    }
    if (u.pathname.endsWith("/freeBusy")) {
      if (opts.fail?.freebusy) return json(500, { error: { status: "INTERNAL" } });
      const calendars = Object.fromEntries(body.items.map(({ id }) => [id, { busy: opts.busy ?? [] }]));
      return json(200, { calendars });
    }
    const m = u.pathname.match(/\/calendars\/primary\/events(?:\/([^/]+))?$/);
    if (m && (init.method || "GET") === "POST") {
      if (opts.fail?.insert) return json(500, { error: { errors: [{ reason: "backendError" }] } });
      if (opts.insertStatus === 409 || events.has(body.id)) return json(409, { error: { errors: [{ reason: "duplicate" }] } });
      const ev = { ...body, hangoutLink: "https://meet.google.com/abc-defg-hij", conferenceData: { createRequest: { status: { statusCode: "success" } } } };
      events.set(body.id, ev);
      if (opts.afterInsert) await opts.afterInsert();
      // The event exists but the caller never hears so (a 5xx or a timeout after Google acted).
      if (opts.fail?.afterCreate) return json(503, { error: { errors: [{ reason: "backendError" }] } });
      return json(200, ev);
    }
    if (m && init.method === "DELETE") {
      if (opts.fail?.delete) return json(500, { error: { errors: [{ reason: "backendError" }] } });
      if (!events.delete(decodeURIComponent(m[1]))) return json(404, { error: { errors: [{ reason: "notFound" }] } });
      return new Response(null, { status: 204 });
    }
    if (m) {
      const ev = events.get(decodeURIComponent(m[1]));
      return ev ? json(200, ev) : json(404, { error: { errors: [{ reason: "notFound" }] } });
    }
    return json(404, {});
  };
  return { fetch, calls, events, opts, mails: () => calls.filter((c) => c.url.startsWith("https://api.resend.com")).map((c) => c.body) };
}

// In-memory Durable Object alarm storage.
export function alarmStorage() {
  let at = null;
  return { getAlarm: async () => at, setAlarm: async (t) => { at = typeof t === "number" ? t : t.getTime(); }, deleteAlarm: async () => { at = null; }, at: () => at };
}

// The confirm (etc.) token in an emailed link.
export const tokenIn = (text, label) => {
  const urls = [...text.matchAll(/https:\/\/patrickjv\.com\/api\/booking\/act\?t=([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  return label === "decline" ? urls[1] : urls[0];
};
