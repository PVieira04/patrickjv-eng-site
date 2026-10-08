// Worker entry: wires Cloudflare-only pieces (EmailMessage, Durable Objects, bindings) into the
// testable handler.
import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import content from "../content.json" with { type: "json" };
import { handle, reserveIntro, pruneQuota, BOOKING_CONFIG } from "./handler.js";
import { createBookingService } from "./booking-service.js";

// One instance holds the day's counters. The logic lives in handler.js (reserveIntro, pruneQuota)
// so the unit tests run the same code against an in-memory storage.
export class IntroQuota extends DurableObject {
  reserve(ipKey, senderKey) {
    return reserveIntro(this.ctx.storage, new Date(), ipKey, senderKey);
  }
  // Fires at the end (UTC midnight) of the stored counters' day: storage keeps only today's counters.
  alarm() {
    return pruneQuota(this.ctx.storage, new Date());
  }
}

// One instance (idFromName("booking")) holds bookings, link tokens and booking quotas, and runs
// every booking operation, Google and email calls included, so the store's claim-before-await
// blocks serialise. The logic lives in booking-service.js and booking-store.js (tested in Node).
export class BookingStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Migrates the SQLite schema (idempotent) before any call is served.
    this.svc = createBookingService({
      sql: ctx.storage.sql, storage: ctx.storage, env, cfg: BOOKING_CONFIG,
      fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  }
  request(input, ipKey, emailKey) { return this.svc.request(input, ipKey, emailKey); }
  act(token) { return this.svc.act(token); }
  peek(token) { return this.svc.peek(token); }
  cancel(bookingId) { return this.svc.cancel(bookingId); }
  status(bookingId) { return this.svc.status(bookingId); }
  availability(type, from, to) { return this.svc.availability(type, from, to); }
  health() { return this.svc.health(); }
  // Expires holds, prunes old records, finishes confirms/cancels cut off mid-call, and sets the next alarm.
  alarm() { return this.svc.alarm(); }
}

export default {
  fetch(request, env) {
    return handle(request, env, {
      content,
      now: () => new Date(),
      sendEmail: (from, to, raw) => env.EMAIL.send(new EmailMessage(from, to, raw)),
      reserve: (ipKey, senderKey) => env.QUOTA.get(env.QUOTA.idFromName("intro-quota")).reserve(ipKey, senderKey),
      booking: () => env.BOOKING.get(env.BOOKING.idFromName("booking")),
    });
  },
};
