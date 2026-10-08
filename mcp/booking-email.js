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
