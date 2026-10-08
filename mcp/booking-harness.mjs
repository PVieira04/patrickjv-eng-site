// Test helper: the real Worker handler wired to the real BookingStore body (node:sqlite, fake
// Google and Resend), as the HTTP API, MCP and WebMCP tests use it.
import { readFileSync } from "node:fs";
import { handle } from "./handler.js";
import { openSql } from "./booking-sqlite.mjs";
import { createBookingService } from "./booking-service.js";
import { ENV, fakeFetch, alarmStorage } from "./booking-fakes.mjs";

const cfg = JSON.parse(readFileSync(new URL("../booking.json", import.meta.url), "utf8"));
const content = JSON.parse(readFileSync(new URL("../content.json", import.meta.url), "utf8"));
const SALT = "test-salt-0123456789abcdef0123456789";
export const NOW = new Date("2026-10-19T09:00:00.000Z"); // Monday, BST
export const ORIGIN = "https://patrickjv.com";

const limiter = (limit) => {
  const n = new Map();
  return { calls: () => [...n.values()].reduce((a, b) => a + b, 0), limit: async ({ key }) => { n.set(key, (n.get(key) || 0) + 1); return { success: n.get(key) <= limit }; } };
};
export const quiet = async (fn) => { const saved = [console.error, console.log]; console.error = console.log = () => {}; try { return await fn(); } finally { [console.error, console.log] = saved; } };

export function harness({ enabled = true, fetchOpts = {}, minute = 1e9, burst = 1e9, env: over = {}, storeDown = false } = {}) {
  const f = fakeFetch(fetchOpts);
  const clock = { now: NOW };
  const svc = createBookingService({ sql: openSql(), storage: alarmStorage(), env: { ...ENV, ...over }, cfg, fetch: f.fetch, sleep: async () => {}, now: () => clock.now });
  let storeCalls = 0;
  // Like a Durable Object stub: every method is async and results are structured-cloned.
  const stub = new Proxy(svc, { get: (o, k) => async (...a) => { storeCalls++; if (storeDown) throw new Error("DO unreachable"); return structuredClone(await o[k](...a)); } });
  const alerts = [];
  const rl = { minute: limiter(minute), burst: limiter(burst) };
  const env = {
    INTRO_FROM: "intro@patrickjv.com", INTRO_TO_ADDRESS: "owner@example.com", QUOTA_SALT: SALT,
    RL_MCP: rl.minute, RL_BURST: rl.burst, RL_INTRO: limiter(1e9),
    EMAIL: { send: async () => {} }, QUOTA: { idFromName: () => ({}), get: () => ({}) }, BOOKING: { idFromName: () => ({}), get: () => stub },
    BOOKING_ENABLED: enabled ? "true" : "false", ...ENV, ...over,
  };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete env[k];
  const deps = {
    content, now: () => clock.now, reserve: async () => ({ ok: true }),
    sendEmail: async (from, to, raw) => { alerts.push({ from, to, raw }); },
    booking: () => stub,
  };
  const call = (path, { method = "GET", headers = {}, body, ip = "203.0.113.7" } = {}) => handle(new Request("https://patrickjv.com" + path, {
    method, duplex: "half", headers: Object.fromEntries(Object.entries({ "cf-connecting-ip": ip, ...headers }).filter(([, v]) => v !== undefined)),
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), env, deps);
  const post = (body, opts = {}) => call("/api/booking", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...opts.headers }, body, ip: opts.ip });
  const actPost = (t, { form = true, headers = {} } = {}) => call("/api/booking/act", { method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", origin: ORIGIN, ...headers },
    body: form ? `t=${encodeURIComponent(t)}` : { t } });
  return { call, post, actPost, f, svc, clock, env, alerts, rl, storeCalls: () => storeCalls };
}
