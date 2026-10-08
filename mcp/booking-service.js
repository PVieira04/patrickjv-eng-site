// The body of the BookingStore Durable Object (mcp/index.js): every booking operation runs here,
// inside the one Durable Object, so the store's synchronous claim blocks serialise (spike S2).
// The Google client, the mailer and the other deps are built here from env, so nothing that
// decides who gets a slot ever runs in the stateless Worker. No Cloudflare-only imports: the tests
// run this against node:sqlite with a fake fetch.
import { checkSlot, availableSlots } from "./booking-config.js";
import {
  migrate, requestBooking, act, cancelByAgent, peekToken, getStatus, liveBookings, expireHolds, prune, nextAlarmAt, newToken,
} from "./booking-store.js";
import { createGoogle, assertNoErrors } from "./booking-google.js";
import { createMailer, holdEmail, bookedEmail, cancelRequestEmail } from "./booking-email.js";

export const ACT_URL = "https://patrickjv.com/api/booking/act";
const MINUTE = 60e3, DAY = 864e5;
// A confirm or cancel left in confirming/cancelling for longer than this, with nothing in this
// instance working on it, was cut off (the Durable Object was evicted mid-call): the alarm
// finishes it.
export const STUCK_AFTER_MS = 2 * MINUTE;
// Availability reuses one free/busy answer for this long, so listing slots can't be used to make
// the Worker hammer Google. Booking and confirming always ask Google afresh.
const AVAILABILITY_CACHE_MS = MINUTE;
const PING_CACHE_MS = MINUTE;

const logFailure = (subsystem) => console.error(JSON.stringify({ event: "booking_failure", subsystem }));
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

// The calendar IDs free/busy is asked about: only blocks:true calendars, IDs from config or from
// the Worker secret it names. A missing secret yields undefined, which bookingConfigured() catches.
export const blockingCalendarIds = (cfg, env) => cfg.calendars.filter((c) => c.blocks).map((c) => c.id ?? env[c.idSecret]);

export function createBookingService({ sql, storage, env, cfg, fetch, sleep, now = () => new Date() }) {
  migrate(sql);
  const typeTitle = (id) => cfg.meetingTypes.find((t) => t.id === id)?.title ?? id;
  const google = createGoogle({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: env.GOOGLE_REFRESH_TOKEN, fetch, now, sleep });
  const mailer = createMailer({ apiKey: env.RESEND_API_KEY, from: env.BOOKING_FROM, fetch });
  const calendars = blockingCalendarIds(cfg, env);

  const freeBusy = async (timeMin, timeMax) => {
    const r = await google.freeBusy(calendars, timeMin, timeMax);
    assertNoErrors(r); // any unreadable calendar makes availability unknown, never free
    return { busy: r.busy };
  };
  // The one place guest email is sent (switching provider changes only createMailer).
  const sendEmail = async (kind, b, links) => {
    const base = { name: b.name, typeTitle: typeTitle(b.type), start: b.start, end: b.end };
    const mail = kind === "hold" ? holdEmail({ ...base, note: b.note, holdExpires: b.holdExpires, viaAgent: b.source !== "page", ...links })
      : kind === "booked" ? bookedEmail({ ...base, ...links })
      : kind === "cancel_request" ? cancelRequestEmail({ ...base, ...links })
      : null;
    if (!mail) throw new Error(`unknown email kind ${kind}`);
    await mailer.send({ to: b.email, ...mail });
  };
  const deps = {
    checkSlot, freeBusy, sendEmail,
    actUrl: (token) => `${ACT_URL}?t=${token}`,
    day: (iso) => iso.slice(0, 10), // quota days are UTC days, like request_intro's
    // The store passes {email, displayName}; the Google client takes plain addresses.
    insertEvent: (e) => google.insertEvent({ ...e, attendees: e.attendees.map((a) => (typeof a === "string" ? a : a.email)) }),
    deleteEvent: (id) => google.deleteEvent(id),
    ownerEmail: env.BOOKING_OWNER_EMAIL,
  };

  // Moves the alarm earlier (never later) than `at`.
  async function alarmBy(at) {
    const current = await storage.getAlarm();
    if (current == null || current > at) await storage.setAlarm(at);
  }

  // Calls that may leave a row in confirming/cancelling, with when they started, so the alarm
  // can tell a live call from one cut off by eviction.
  const inflight = new Map();
  async function tracked(fn) {
    const key = {};
    inflight.set(key, now().getTime());
    // If this instance dies mid-call, the alarm (which survives eviction) finishes the job.
    await alarmBy(now().getTime() + STUCK_AFTER_MS + MINUTE);
    try { return await fn(); } finally { inflight.delete(key); }
  }

  let availabilityCache = null; // { at, busy, timeMin, timeMax }
  let pingCache = null; // { at, ok }

  async function finishConfirm(b, t) {
    const ev = await deps.insertEvent({
      id: b.id, summary: `${typeTitle(b.type)}: ${b.guest_name}`,
      description: [`${typeTitle(b.type)}, booked on patrickjv.com.`, b.note ? `\nNote from the guest:\n${b.note}` : ""].join(""),
      start: b.start_utc, end: b.end_utc, attendees: [b.guest_email, deps.ownerEmail].filter(Boolean),
    }); // 409 (made before the eviction) is created:false, still a success
    const cancel = await newToken();
    const nowIso = t.toISOString();
    // Synchronous from here: settle only if nothing else moved it meanwhile.
    if (sql.exec("SELECT status FROM bookings WHERE id = ?", b.id).one().status !== "confirming") return;
    sql.exec("UPDATE bookings SET status = 'confirmed', status_reason = NULL, event_id = ?, hold_expires = NULL, delete_after = ? WHERE id = ?",
      b.id, plus(b.end_utc, cfg.retentionDays * DAY), b.id);
    sql.exec("UPDATE tokens SET used_at = ? WHERE booking_id = ? AND used_at IS NULL", nowIso, b.id);
    sql.exec("INSERT INTO tokens (hash, booking_id, action, expires_at) VALUES (?, ?, 'cancel', ?)", cancel.hash, b.id, b.start_utc);
    const forEmail = { id: b.id, type: b.type, start: b.start_utc, end: b.end_utc, name: b.guest_name, email: b.guest_email, note: b.note, source: b.source };
    try { await sendEmail("booked", forEmail, { cancelUrl: deps.actUrl(cancel.token), meetLink: ev?.meetLink ?? null }); } catch { logFailure("email"); }
  }

  async function finishCancel(b, t) {
    await deps.deleteEvent(b.event_id ?? b.id); // already gone is fine
    if (sql.exec("SELECT status FROM bookings WHERE id = ?", b.id).one().status !== "cancelling") return;
    sql.exec("UPDATE bookings SET status = 'cancelled', status_reason = 'guest_cancelled' WHERE id = ?", b.id);
    sql.exec("UPDATE tokens SET used_at = ? WHERE booking_id = ? AND used_at IS NULL", t.toISOString(), b.id);
  }

  // Returns true if anything is still stuck (so the alarm comes back soon).
  async function recoverStuck(t) {
    const rows = sql.exec("SELECT * FROM bookings WHERE status IN ('confirming', 'cancelling')").toArray();
    if (!rows.length) return false;
    const live = [...inflight.values()].some((started) => t.getTime() - started < STUCK_AFTER_MS);
    if (live) return true;
    let left = false;
    for (const b of rows) {
      try {
        if (b.status === "confirming") await finishConfirm(b, t);
        else await finishCancel(b, t);
      } catch {
        logFailure(b.status === "confirming" ? "recover_confirm" : "recover_cancel");
        left = true;
      }
    }
    return left;
  }

  return {
    async request(input, ipKey, emailKey) {
      const r = await requestBooking(sql, { cfg, now: now(), input, ipKey, emailKey, deps });
      if (r.booking_id) await alarmBy(nextAlarmAt(sql, now()));
      return r;
    },
    act(token) {
      return tracked(() => act(sql, { token, now: now(), cfg, deps }));
    },
    cancel(bookingId) {
      return tracked(() => cancelByAgent(sql, { bookingId, now: now(), deps }));
    },
    peek(token) {
      return peekToken(sql, token, now());
    },
    status(bookingId) {
      return getStatus(sql, bookingId, now());
    },
    // Free slots (UTC) for a type on London days from..to. Throws if Google can't answer.
    async availability(type, from, to) {
      const t = now();
      if (!availabilityCache || t.getTime() - availabilityCache.at >= AVAILABILITY_CACHE_MS) {
        const timeMin = t.toISOString(), timeMax = new Date(t.getTime() + (cfg.horizonDays + 1) * DAY).toISOString();
        availabilityCache = { at: t.getTime(), ...(await freeBusy(timeMin, timeMax)) };
      }
      const slots = availableSlots({ cfg, typeId: type, now: t, from, to, busy: availabilityCache.busy, bookings: liveBookings(sql, t) });
      return { slots };
    },
    // Health: a fresh token refresh (so a revoked token shows), at most once a minute.
    async health() {
      const t = now().getTime();
      if (!pingCache || t - pingCache.at >= PING_CACHE_MS) pingCache = { at: t, ok: await google.ping() };
      return { google: pingCache.ok };
    },
    async alarm() {
      const t = now();
      expireHolds(sql, t);
      prune(sql, t);
      const stuck = await recoverStuck(t);
      const next = nextAlarmAt(sql, t);
      await storage.setAlarm(stuck ? Math.min(next, t.getTime() + STUCK_AFTER_MS + MINUTE) : next);
    },
  };
}
