// The body of the BookingStore Durable Object (mcp/index.js): every booking operation runs here,
// inside the one Durable Object, so the store's synchronous claim blocks serialise (spike S2).
// The Google client, the mailer and the other deps are built here from env, so nothing that
// decides who gets a slot ever runs in the stateless Worker. No Cloudflare-only imports: the tests
// run this against node:sqlite with a fake fetch.
import { checkSlot, availableSlots } from "./booking-config.js";
import {
  migrate, requestBooking, act, cancelByAgent, peekToken, getStatus, liveBookings, expireHolds, prune, nextAlarmAt, recoverConfirm, emailFailures,
  createRequest, settleRequest, findTicket, startSignin, consumeSignin, peekTicket, confirmRequest, cancelMeeting, hashToken,
} from "./booking-store.js";
import { createGoogle, assertNoErrors, meetLinkOf } from "./booking-google.js";
import { createMailer, holdEmail, bookedEmail, cancelRequestEmail } from "./booking-email.js";
import { createSignin, authUrl, pkceChallenge, randomValue, verifyIdToken } from "./booking-signin.js";
import { quotaHash, senderQuotaKey, signinConfigured } from "./handler.js";

export const ACT_URL = "https://patrickjv.com/api/booking/act";
export const CONFIRM_URL = "https://patrickjv.com/book/confirm";
const MINUTE = 60e3, DAY = 864e5;
// A confirm or cancel left in confirming/cancelling for longer than this, with nothing in this
// instance working on it, was cut off (the Durable Object was evicted mid-call): the alarm
// finishes it.
export const STUCK_AFTER_MS = 2 * MINUTE;
// Availability reuses one free/busy answer for this long, so listing slots can't be used to make
// the Worker hammer Google. Booking and confirming always ask Google afresh.
const AVAILABILITY_CACHE_MS = MINUTE;
const PING_CACHE_MS = MINUTE;
// Guest emails failed in a row before health says email is down (fewer could be a blip).
const EMAIL_FAILURES_DOWN = 3;

const logFailure = (subsystem) => console.error(JSON.stringify({ event: "booking_failure", subsystem }));

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
    const mail = kind === "hold" ? holdEmail({ ...base, holdExpires: b.holdExpires, viaAgent: b.source !== "page", ...links })
      : kind === "booked" ? bookedEmail({ ...base, ...links })
      : kind === "cancel_request" ? cancelRequestEmail({ ...base, ...links })
      : null;
    if (!mail) throw new Error(`unknown email kind ${kind}`);
    await mailer.send({ to: b.email, ...mail });
  };
  const signin = createSignin({ clientId: env.SIGNIN_GOOGLE_CLIENT_ID, clientSecret: env.SIGNIN_GOOGLE_CLIENT_SECRET, fetch });
  const deps = {
    checkSlot, freeBusy, sendEmail,
    actUrl: (token) => `${ACT_URL}?t=${token}`,
    confirmUrl: (token) => `${CONFIRM_URL}?t=${token}`,
    // F-001's email key, for a sign-in booking's verified address (QUOTA_SALT is checked first).
    emailKey: (email) => quotaHash(env, "booking-email", senderQuotaKey(email)),
    day: (iso) => iso.slice(0, 10), // quota days are UTC days, like request_intro's
    insertEvent: (e) => google.insertEvent(e),
    // Null if there is no such event; otherwise just its Meet link (all the store needs).
    getEvent: async (id) => { const ev = await google.getEvent(id); return ev && { meetLink: meetLinkOf(ev) }; },
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

  // The shared free/busy answer for the whole horizon, at most a minute old: availability, and
  // (F-002) booking requests and the "is this request's slot still free?" reads use it, so none of
  // them can make the Worker hammer Google. One refresh at a time; a failed one isn't kept.
  let availabilityCache = null; // { at, busy: Promise }
  function cachedBusy() {
    const t = now();
    if (!availabilityCache || t.getTime() - availabilityCache.at >= AVAILABILITY_CACHE_MS) {
      const timeMin = t.toISOString(), timeMax = new Date(t.getTime() + (cfg.horizonDays + 1) * DAY).toISOString();
      const entry = { at: t.getTime(), busy: freeBusy(timeMin, timeMax).then((r) => r.busy) };
      entry.busy.catch(() => { if (availabilityCache === entry) availabilityCache = null; });
      availabilityCache = entry;
    }
    return availabilityCache.busy;
  }
  // For settling a request on a read: if the cache can't be had, only the local checks apply.
  const busyOrNone = () => cachedBusy().catch(() => []);
  let pingCache = null; // { at, ok }
  let signinCache = null; // { at, ok }

  // F-002: the callback, after its transaction is consumed: the code exchange and the ID token
  // checks give the person; the ticket gives the grant; then the core decides.
  async function finishSignin(tx, { code, error }) {
    if (error || !code) return { error: "denied", purpose: tx.purpose };
    let jwt;
    try { jwt = await signin.exchange(code, tx.code_verifier); } catch { logFailure("signin_exchange"); return { error: "exchange", purpose: tx.purpose }; }
    const v = verifyIdToken(jwt, { clientId: env.SIGNIN_GOOGLE_CLIENT_ID, nonce: tx.nonce, now: now() });
    if (v.error) return { error: v.error === "not_authoritative" ? "not_authoritative" : "id_token", purpose: tx.purpose };
    const found = findTicket(sql, tx.ticket_hash);
    if (!found || found.purpose !== tx.purpose) return { error: "forbidden", purpose: tx.purpose };
    const grant = { proof: "signin:google", actor: null, scope: tx.purpose };
    if (found.purpose === "book") {
      const r = found.request;
      return { purpose: "book", ...(await confirmRequest(sql, r.id, v.person, { ...grant, ticket_hash: r.ticket_hash, expires_at: r.expires_at }, { cfg, now: now(), deps })) };
    }
    return { purpose: "cancel", ...(await cancelMeeting(sql, found.booking.id, v.person, { ...grant, ticket_hash: found.tok.hash, expires_at: found.tok.expires_at }, { now: now(), deps })) };
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
        if (b.status === "confirming") await recoverConfirm(sql, b, { now: t, cfg, deps });
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
      // Every request may have written quota counters, refused or not: an alarm must be set to
      // prune them (alarmBy only ever moves it earlier).
      await alarmBy(nextAlarmAt(sql, now()));
      return r;
    },
    act(token) {
      return tracked(() => act(sql, { token, now: now(), cfg, deps }));
    },
    // `ipKey` (keyed hash) counts a sign-in cancel link against the request caps (F-002).
    // A refusal says why (`why`), decided on the internal state, so the agent is told what to do.
    cancel(bookingId, ipKey) {
      return tracked(async () => {
        const r = await cancelByAgent(sql, { bookingId, now: now(), cfg, ipKey, deps });
        if (r.error !== "not_cancellable") return r;
        const status = sql.exec("SELECT status FROM bookings WHERE id = ?", bookingId).toArray()[0]?.status;
        return { ...r, why: { confirming: "finishing", cancelling: "cancelling", confirmed: "started" }[status] ?? "finished" };
      });
    },
    peek(token) {
      return peekToken(sql, token, now());
    },
    status(bookingId) {
      return getStatus(sql, bookingId, now());
    },
    // get_booking_status (F-002): as status, but an open request whose slot has gone is settled
    // declined here, the first time it's seen.
    async readStatus(bookingId) {
      if (getStatus(sql, bookingId, now())?.status === "pending_confirmation") {
        const busy = await busyOrNone();
        settleRequest(sql, bookingId, { cfg, now: now(), busy, deps });
      }
      return getStatus(sql, bookingId, now());
    },
    // ---- F-002: the sign-in path ----
    // book_meeting (MCP, WebMCP) and /book's sign-in button: a booking request, checked against
    // the shared free/busy cache. If that is stale and Google can't be reached: unavailable.
    async signinRequest(input, ipKey) {
      let busy;
      try { busy = await cachedBusy(); } catch { logFailure("google_freebusy"); return { error: "unavailable" }; }
      const r = await createRequest(sql, { cfg, now: now(), input, ipKey, busy, deps });
      await alarmBy(nextAlarmAt(sql, now())); // counters and the request are pruned by the alarm
      return r;
    },
    // GET /book/confirm: what the ticket is for and its state, settling a request whose slot has gone.
    async confirmPage(token) {
      const hash = typeof token === "string" && token ? await hashToken(token) : null;
      const found = hash && findTicket(sql, hash);
      if (found?.purpose === "book") {
        const busy = await busyOrNone();
        settleRequest(sql, found.request.id, { cfg, now: now(), busy, deps });
      }
      return peekTicket(sql, token, { now: now(), cfg });
    },
    // POST /book/confirm/google: a sign-in transaction, and where to send the browser.
    async startSignin(token) {
      if (!signinConfigured(env)) return { error: "unavailable" };
      const busy = await busyOrNone();
      const [state, nonce, cookie, verifier] = [randomValue(), randomValue(), randomValue(), randomValue()];
      const [stateHash, cookieHash, challenge] = await Promise.all([hashToken(state), hashToken(cookie), pkceChallenge(verifier)]);
      const r = await startSignin(sql, { token, now: now(), cfg, busy, tx: { stateHash, cookieHash, nonce, codeVerifier: verifier }, deps });
      if (r.error) return { ...r, view: await peekTicket(sql, token, { now: now(), cfg }) };
      await alarmBy(nextAlarmAt(sql, now()));
      return { purpose: r.purpose, cookie, location: authUrl({ clientId: env.SIGNIN_GOOGLE_CLIENT_ID, state, nonce, codeChallenge: challenge }) };
    },
    // GET /book/callback/google: the transaction is consumed before any outside call, then the
    // sign-in is finished. `view` is the ticket's state afterwards, for the page.
    callback({ state, cookie, code, error }) {
      return tracked(async () => {
        const [stateHash, cookieHash] = await Promise.all([hashToken(String(state ?? "")), typeof cookie === "string" && cookie ? hashToken(cookie) : null]);
        const c = consumeSignin(sql, { stateHash: state ? stateHash : null, cookieHash, now: now() });
        if (c.error) return { error: `signin_${c.error}` };
        const r = await finishSignin(c.tx, { code, error });
        return { ...r, view: await peekTicket(sql, null, { now: now(), cfg, hash: c.tx.ticket_hash }) };
      });
    },
    // Free slots (UTC) for a type on London days from..to. Throws if Google can't answer.
    async availability(type, from, to) {
      const busy = await cachedBusy();
      const t = now();
      const slots = availableSlots({ cfg, typeId: type, now: t, from, to, busy, bookings: liveBookings(sql, t) });
      return { slots };
    },
    // Health: a fresh token refresh (so a revoked token shows), at most once a minute; and whether
    // guest email is failing (EMAIL_FAILURES_DOWN in a row). F-002: whether sign-in would work
    // (its secrets set and Google's discovery document reachable), also at most once a minute.
    async health() {
      const t = now().getTime();
      if (!pingCache || t - pingCache.at >= PING_CACHE_MS) pingCache = { at: t, ok: await google.ping() };
      if (!signinCache || t - signinCache.at >= PING_CACHE_MS) signinCache = { at: t, ok: signinConfigured(env) && (await signin.ready()) };
      return { google: pingCache.ok, email: emailFailures(sql) < EMAIL_FAILURES_DOWN, signin: signinCache.ok };
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
