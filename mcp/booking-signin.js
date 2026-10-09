// Google sign-in for F-002: the site is an OpenID Connect relying party (a sign-in client), never
// an OAuth server (D2). Its own Google Cloud project (patrickjv-signin) asks for openid, email and
// profile only (D4). Authorization code flow with PKCE (S256), state and nonce; the code is
// exchanged server to server, and only the ID token's verified claims are read, once. Google's
// tokens are never kept. It never logs: callers log the failing subsystem only.
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration";
export const SIGNIN_REDIRECT = "https://patrickjv.com/book/callback/google";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const TIMEOUT_MS = 20_000;
const IAT_SKEW_S = 5 * 60;

// `reason` is Google's short error code; messages never carry codes, tokens or secrets.
export class SigninError extends Error {
  constructor(message, reason = "unknown") {
    super(message);
    this.name = "SigninError";
    this.reason = reason;
  }
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// 32 random bytes, base64url: used for state, nonce, the cookie and the PKCE verifier.
export const randomValue = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export async function pkceChallenge(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function authUrl({ clientId, state, nonce, codeChallenge }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: SIGNIN_REDIRECT, response_type: "code", scope: "openid email profile",
    state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256", prompt: "select_account",
  });
  return `${AUTH_URL}?${q}`;
}

export function createSignin({ clientId, clientSecret, fetch }) {
  // The ID token for a code, straight from Google's token endpoint (so over TLS, server to server).
  async function exchange(code, codeVerifier) {
    const res = await fetch(TOKEN_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: codeVerifier, client_id: clientId, client_secret: clientSecret, redirect_uri: SIGNIN_REDIRECT }).toString(),
    });
    let body = null;
    try { body = await res.json(); } catch { /* none */ }
    if (!res.ok || typeof body?.id_token !== "string") throw new SigninError("Google code exchange failed", typeof body?.error === "string" ? body.error : "no_id_token");
    return body.id_token;
  }
  // For health: Google's discovery document is reachable.
  async function ready() {
    try {
      const res = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok;
    } catch { return false; }
  }
  return { exchange, ready };
}

function decodePayload(jwt) {
  const parts = typeof jwt === "string" ? jwt.split(".") : [];
  if (parts.length !== 3) return null;
  try {
    const bin = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return claims !== null && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch { return null; }
}

// The display name is asserted by the account holder, not verified: one plain line (no control,
// bidi or zero-width characters, as request_intro's fields), at most 100 characters.
const plainName = (s) => [...s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "").replace(/\s+/g, " ").trim()].slice(0, 100).join("");

// The checks OIDC Core 3.1.3.7 requires of an ID token received directly from the token endpoint
// (so its signature needn't be checked), then the person it identifies. {person} or {error}.
export function verifyIdToken(jwt, { clientId, nonce, now }) {
  const c = decodePayload(jwt);
  if (!c) return { error: "malformed" };
  const t = Math.floor(now.getTime() / 1000);
  if (!ISSUERS.includes(c.iss)) return { error: "iss" };
  if (c.aud !== clientId) return { error: "aud" };
  if (!(typeof c.exp === "number" && c.exp > t)) return { error: "exp" };
  if (!(typeof c.iat === "number" && Math.abs(t - c.iat) <= IAT_SKEW_S)) return { error: "iat" };
  if (typeof c.nonce !== "string" || c.nonce !== nonce) return { error: "nonce" };
  if (typeof c.sub !== "string" || c.sub === "") return { error: "sub" };
  if (typeof c.email !== "string" || !c.email.includes("@")) return { error: "email" };
  // Any address Google has verified is accepted, including a Google account on a work address
  // whose mail runs elsewhere. Google warns the flag can outlive a change of who owns such a
  // mailbox; for booking a call that risk was accepted (F-002 D9). The person is keyed on sub.
  if (c.email_verified !== true && c.email_verified !== "true") return { error: "email_verified" };
  const name = typeof c.name === "string" ? plainName(c.name) : "";
  return { person: { provider: "google", subject: c.sub, email: c.email, display_name: name || c.email.slice(0, c.email.lastIndexOf("@")) } };
}
