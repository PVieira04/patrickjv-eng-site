// Guest email for booking (F-001): the one function that sends to guests (Resend, plain text, no
// tracking), and the texts it sends. Switching provider changes only createMailer and its secret.
// Nothing here logs: callers log the failing subsystem only, as logFailure does.
const RESEND_URL = "https://api.resend.com/emails";

// `status` is the HTTP status; `reason` is Resend's error name (e.g. rate_limit_exceeded). The
// message never carries an address or the key: Resend's own messages can echo the recipient.
export class MailError extends Error {
  constructor(message, { status = 0, reason = "unknown" } = {}) {
    super(message);
    this.name = "MailError";
    this.status = status;
    this.reason = reason;
  }
}

export function createMailer({ apiKey, from, fetch }) {
  async function send({ to, subject, text }) {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok || typeof body?.id !== "string") {
      throw new MailError("Resend send failed", { status: res.status, reason: typeof body?.name === "string" ? body.name : "unknown" });
    }
    return { id: body.id };
  }
  return { send };
}

// Times in emails: London wall-clock time with its zone (BST or GMT, from Intl), then UTC, e.g.
// "Mon 26 Oct 2026, 10:00–10:30 GMT (10:00–10:30 UTC)". Booking hours are London hours, so the
// zone is fixed here rather than passed in.
const TZ = "Europe/London";
const parts = (iso, timeZone, opts) => Object.fromEntries(
  new Intl.DateTimeFormat("en-GB", { timeZone, ...opts }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
const dateOf = (iso) => {
  const p = parts(iso, TZ, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
};
const clock = (iso, timeZone) => {
  const p = parts(iso, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
  return { time: `${p.hour}:${p.minute}`, zone: p.timeZoneName };
};
const when = (start, end) => {
  const s = clock(start, TZ);
  return `${dateOf(start)}, ${s.time}–${clock(end, TZ).time} ${s.zone} (${clock(start, "UTC").time}–${clock(end, "UTC").time} UTC)`;
};
const at = (iso) => { const l = clock(iso, TZ); return `${dateOf(iso)}, ${l.time} ${l.zone} (${clock(iso, "UTC").time} UTC)`; };

const lines = (...ls) => ls.filter((l) => l !== null).join("\n");
const quote = (note) => note.replace(/\r\n?/g, "\n").split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");

// The texts below are public copy: plain, British English, first person from Patrick.
export function holdEmail({ name, typeTitle, start, end, note, confirmUrl, declineUrl, holdExpires, viaAgent }) {
  const hasNote = typeof note === "string" && note.trim() !== "";
  return {
    subject: `Please confirm: ${typeTitle} with Patrick Vieira`,
    text: lines(
      `Hello ${name},`,
      "",
      viaAgent
        ? `An AI agent asked to book a ${typeTitle} with me, Patrick Vieira, on your behalf:`
        : `Someone used this email address on patrickjv.com to book a ${typeTitle} with me, Patrick Vieira:`,
      "",
      when(start, end),
      "",
      ...(hasNote ? ["Your note:", quote(note.trim()), ""] : []),
      `I'm holding this time until ${at(holdExpires)}. It isn't booked until you confirm.`,
      "",
      "To confirm, open this link:",
      confirmUrl,
      "",
      "To decline:",
      declineUrl,
      "",
      "If you didn't ask for this, ignore this email. The hold will lapse and nothing will be booked.",
      "",
      "Patrick",
    ),
  };
}

export function bookedEmail({ name, typeTitle, start, end, meetLink, cancelUrl }) {
  return {
    subject: `Booked: ${typeTitle} with Patrick Vieira, ${dateOf(start)}`,
    text: lines(
      `Hello ${name},`,
      "",
      `Your ${typeTitle} with me is booked:`,
      "",
      when(start, end),
      "",
      "Google Calendar will send you an invite from hello@patrickjv.com.",
      meetLink ? `Google Meet: ${meetLink}` : "The Google Meet link is in the invite.",
      "",
      "If you need to cancel, use this link before the meeting starts:",
      cancelUrl,
      "",
      "See you then,",
      "Patrick",
    ),
  };
}

export function cancelRequestEmail({ name, typeTitle, start, end, confirmCancelUrl }) {
  return {
    subject: `Confirm cancellation: ${typeTitle} with Patrick Vieira`,
    text: lines(
      `Hello ${name},`,
      "",
      `An AI agent asked to cancel your ${typeTitle} with me:`,
      "",
      when(start, end),
      "",
      "To cancel it, open this link and confirm:",
      confirmCancelUrl,
      "",
      "If you want to keep it, ignore this email and the meeting stays booked.",
      "",
      "Patrick",
    ),
  };
}

// To Patrick, once a day at most (the caller sends it when the global cap is first hit).
export function capAlertEmail({ day }) {
  return {
    subject: "patrickjv.com booking closed for today: daily cap reached",
    text: lines(
      `Booking requests on patrickjv.com reached the daily cap on ${day}, so booking is closed for everyone until the counters reset.`,
      "",
      "If that wasn't real demand, check the booking API in Workers Logs and the WAF events for a flood.",
    ),
  };
}
