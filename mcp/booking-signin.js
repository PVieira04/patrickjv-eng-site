// Sign-in for F-002 and F-004: the site is an OpenID Connect relying party (a sign-in client), never
// an OAuth server (F-002 D2). Google (its own Google Cloud project, patrickjv-signin), Microsoft
// (one multi-tenant Entra app with personal accounts) and Altimist ID are entries in one table
// (F-004 D2); the flow is shared. Each asks for openid, email and profile only. Authorization code
// flow with PKCE (S256), state and nonce; the code is exchanged server to server, and only the ID
// token's verified claims are read, once. Providers' tokens are never kept. It never logs: callers
// log the failing subsystem only.
const TIMEOUT_MS = 20_000;
const IAT_SKEW_S = 5 * 60;
// Microsoft's tenant for personal accounts, whose addresses Microsoft has verified (F-004 D3).
const MS_PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const redirectUri = (provider) => `https://patrickjv.com/book/callback/${provider}`;

// `required`: claims that must be non-empty strings. `check(c)`: the provider's own rules, then the
// person, as {person} or {error}. Altimist ID's endpoints are from its discovery document
// (https://altimist.id/.well-known/openid-configuration, checked 12 Oct 2026).
export const PROVIDERS = {
  google: {
    host: "https://accounts.google.com",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
    secrets: ["SIGNIN_GOOGLE_CLIENT_ID", "SIGNIN_GOOGLE_CLIENT_SECRET"],
    scope: "openid email profile",
    authParams: { prompt: "select_account" },
    required: ["sub", "email"],
    check(c) {
      if (!["https://accounts.google.com", "accounts.google.com"].includes(c.iss)) return { error: "iss" };
      if (!c.email.includes("@")) return { error: "email" };
      // Any address Google has verified is accepted, including a Google account on a work address
      // whose mail runs elsewhere. Google warns the flag can outlive a change of who owns such a
      // mailbox; for booking a call that risk was accepted (F-002 D9). The person is keyed on sub.
      if (c.email_verified !== true && c.email_verified !== "true") return { error: "email_verified" };
      return { person: person("google", c.sub, c.email, c.name) };
    },
  },
  microsoft: {
    host: "https://login.microsoftonline.com",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    discoveryUrl: "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
    secrets: ["SIGNIN_MICROSOFT_CLIENT_ID", "SIGNIN_MICROSOFT_CLIENT_SECRET"],
    scope: "openid profile email",
    authParams: { prompt: "select_account" },
    required: ["tid", "oid"],
    check(c, t) {
      if (!GUID.test(c.tid)) return { error: "tid" };
      if (c.iss !== `https://login.microsoftonline.com/${c.tid}/v2.0`) return { error: "iss" };
      if (c.ver !== "2.0") return { error: "ver" };
      if ("nbf" in c && !(typeof c.nbf === "number" && c.nbf <= t)) return { error: "nbf" };
      // The address (F-004 D3): `email` only (never upn or preferred_username), when the
      // organisation that verified its domain says this account has it (xms_edov), or for a
      // personal account. Weaker than a mailbox check; accepted, with the "Booked" email as backstop.
      if (typeof c.email !== "string" || !c.email.includes("@") || !(c.xms_edov === true || c.tid === MS_PERSONAL_TENANT)) return { error: "address" };
      // Keyed on tenant and object ID, Microsoft's recommendation; never on the address.
      return { person: person("microsoft", `${c.tid}:${c.oid}`, c.email, c.name) };
    },
  },
  altimist: {
    host: "https://altimist.id",
    authUrl: "https://altimist.id/oidc/authorize",
    tokenUrl: "https://altimist.id/oidc/token",
    discoveryUrl: "https://altimist.id/.well-known/openid-configuration",
    secrets: ["SIGNIN_ALTIMIST_CLIENT_ID", "SIGNIN_ALTIMIST_CLIENT_SECRET"],
    scope: "openid email profile",
    authParams: {},
    required: ["sub", "email"],
    check(c) {
      if (c.iss !== "https://altimist.id") return { error: "iss" };
      if (!c.email.includes("@")) return { error: "email" };
      // Altimist ID proves the address with a one-time code at sign-up (F-004 D4); if it ever says
      // otherwise, believe it.
      if ("email_verified" in c && c.email_verified !== true) return { error: "email_verified" };
      const name = [c.given_name, c.family_name].filter((s) => typeof s === "string" && s.trim()).join(" ");
      return { person: person("altimist", c.sub, c.email, name) };
    },
  },
};

// `reason` is the provider's short error code; messages never carry codes, tokens or secrets.
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

export function authUrl({ provider = "google", clientId, state, nonce, codeChallenge }) {
  const p = PROVIDERS[provider];
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(provider), response_type: "code", scope: p.scope,
    state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256", ...p.authParams,
  });
  return `${p.authUrl}?${q}`;
}

export function createSignin({ provider = "google", clientId, clientSecret, fetch }) {
  const p = PROVIDERS[provider];
  // The ID token for a code, straight from the provider's token endpoint (so over TLS, server to server).
  async function exchange(code, codeVerifier) {
    const res = await fetch(p.tokenUrl, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: codeVerifier, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri(provider) }).toString(),
    });
    let body = null;
    try { body = await res.json(); } catch { /* none */ }
    if (!res.ok || typeof body?.id_token !== "string") throw new SigninError(`${provider} code exchange failed`, typeof body?.error === "string" ? body.error : "no_id_token");
    return body.id_token;
  }
  // For health: the provider's discovery document is reachable.
  async function ready() {
    try {
      const res = await fetch(p.discoveryUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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
function person(provider, subject, email, name) {
  const shown = typeof name === "string" ? plainName(name) : "";
  return { provider, subject, email, display_name: shown || email.slice(0, email.lastIndexOf("@")) };
}

// The checks OIDC Core 3.1.3.7 requires of an ID token received directly from the token endpoint
// (so its signature needn't be checked): the shared rules, then the provider's own (F-004). Gives
// the person it identifies: {person} or {error}.
export function verifyIdToken(jwt, { provider = "google", clientId, nonce, now }) {
  const p = PROVIDERS[provider];
  if (!p) return { error: "provider" };
  const c = decodePayload(jwt);
  if (!c) return { error: "malformed" };
  const t = Math.floor(now.getTime() / 1000);
  if (typeof c.aud !== "string" || c.aud !== clientId) return { error: "aud" };
  if (!(typeof c.exp === "number" && c.exp > t)) return { error: "exp" };
  if (!(typeof c.iat === "number" && Math.abs(t - c.iat) <= IAT_SKEW_S)) return { error: "iat" };
  if (typeof c.nonce !== "string" || c.nonce !== nonce) return { error: "nonce" };
  for (const k of p.required) if (typeof c[k] !== "string" || c[k] === "") return { error: k };
  return p.check(c, t);
}
