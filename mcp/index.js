// Worker entry: wires Cloudflare-only pieces (EmailMessage, Durable Object, bindings) into the
// testable handler.
import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import content from "../content.json" with { type: "json" };
import { handle, reserveIntro, pruneQuota } from "./handler.js";

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

export default {
  fetch(request, env) {
    return handle(request, env, {
      content,
      now: () => new Date(),
      sendEmail: (from, to, raw) => env.EMAIL.send(new EmailMessage(from, to, raw)),
      reserve: (ipKey, senderKey) => env.QUOTA.get(env.QUOTA.idFromName("intro-quota")).reserve(ipKey, senderKey),
    });
  },
};
