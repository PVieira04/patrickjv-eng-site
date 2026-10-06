// Worker entry: wires Cloudflare-only pieces (EmailMessage, Durable Object, bindings) into the
// testable handler.
import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import content from "../content.json" with { type: "json" };
import { handle, reserveQuota } from "./handler.js";

// One instance holds the day's counters. Durable Objects run one call at a time, and the
// get/put below completes before the next call starts, so reservations are atomic.
export class IntroQuota extends DurableObject {
  async reserve(ipKey, senderKey) {
    const day = new Date().toISOString().slice(0, 10);
    const r = reserveQuota(await this.ctx.storage.get("counters"), day, ipKey, senderKey);
    if (r.ok) await this.ctx.storage.put("counters", r.state);
    return { ok: r.ok, which: r.which };
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
