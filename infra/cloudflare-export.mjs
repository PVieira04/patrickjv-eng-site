// Read-only export of the Cloudflare configuration that lives in the dashboard (decision D2), so it
// has history in git and drift is visible. The dashboard stays the source of truth; nothing here
// writes to Cloudflare.
//   CLOUDFLARE_READ_TOKEN=… npm run cf:export   rewrite infra/cloudflare/*.json from the live config
//   CLOUDFLARE_READ_TOKEN=… npm run cf:check    exit 1 and list the differences if live ≠ committed
// CLOUDFLARE_READ_TOKEN: a read-only API token for both zones (see docs/06). Account-level Worker
// data (Custom Domains, script names) is read with Wrangler's OAuth login instead.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const ACCOUNT = "03634b9f9d8fee0893d95c82d77ea2f5";
export const ZONES = ["patrickjv.com", "pvieira.co.uk"];
const API = "https://api.cloudflare.com/client/v4";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "infra/cloudflare");

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== "").map((k) => [k, o[k]]));
const byKey = (...keys) => (a, b) => { for (const k of keys) { const x = JSON.stringify(a[k] ?? ""), y = JSON.stringify(b[k] ?? ""); if (x !== y) return x < y ? -1 : 1; } return 0; };

// ---- normalisers: keep configuration, drop ids, timestamps and counters ----
export function normaliseDns(records) {
  return records.map((r) => pick(r, ["type", "name", "content", "data", "priority", "proxied", "ttl", "comment"])).sort(byKey("type", "name", "content"));
}
export function normaliseRuleset(rs) {
  return {
    phase: rs.phase,
    rules: (rs.rules ?? []).map((r) => pick(r, ["description", "expression", "action", "action_parameters", "ratelimit", "enabled"])),
  };
}
export function normaliseSettings(settings) {
  return Object.fromEntries(settings.map((s) => [s.id, s.value]).sort(([a], [b]) => (a < b ? -1 : 1)));
}
// Forward destinations are personal addresses (the docs never name them): keep only whether the
// destination is on one of the zones; anything else becomes a placeholder.
export function normaliseEmailRules(rules) {
  const redact = (v) => (ZONES.some((z) => v.endsWith("@" + z)) ? v : "<verified destination>");
  return rules
    .map((r) => ({ ...pick(r, ["name", "matchers", "enabled", "priority"]), actions: r.actions.map((a) => ({ ...a, value: a.value?.map(redact) })) }))
    .sort(byKey("priority", "name"));
}

// ---- reading ----
async function get(path, token) {
  const res = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!body.success) throw new Error(`GET ${path}: ${res.status} ${(body.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || "no JSON body"}`);
  return body.result;
}

export async function exportZone(name, token) {
  const [zone] = await get(`/zones?name=${name}`, token);
  if (!zone) throw new Error(`zone ${name} not visible to the token`);
  const z = `/zones/${zone.id}`;
  const rulesets = (await get(`${z}/rulesets`, token)).filter((r) => r.kind === "zone");
  const flags = await get(`${z}/flags`, token);
  return {
    zone: pick(zone, ["name", "type", "status", "paused", "name_servers"]),
    plan: zone.plan?.name,
    dnssec: pick(await get(`${z}/dnssec`, token), ["status", "ds", "algorithm", "key_tag", "flags"]),
    dns: normaliseDns(await get(`${z}/dns_records?per_page=1000`, token)),
    rulesets: Object.fromEntries((await Promise.all(rulesets.map((r) => get(`${z}/rulesets/${r.id}`, token)))).map(normaliseRuleset).sort(byKey("phase")).map((r) => [r.phase, r.rules])),
    settings: { ...normaliseSettings(await get(`${z}/settings`, token)), nel: (await get(`${z}/settings/nel`, token)).value },
    crawler_hints: flags?.cache?.crawlhints_enabled ?? null,
    bot_management: (({ using_latest_model, ...rest }) => rest)(await get(`${z}/bot_management`, token)),
    email_routing: { enabled: (await get(`${z}/email/routing`, token)).enabled, rules: normaliseEmailRules(await get(`${z}/email/routing/rules`, token)) },
    worker_routes: (await get(`${z}/workers/routes`, token)).map((r) => pick(r, ["pattern", "script"])).sort(byKey("pattern")),
  };
}

export async function exportAccount(token) {
  return {
    worker_custom_domains: (await get(`/accounts/${ACCOUNT}/workers/domains`, token)).map((d) => pick(d, ["hostname", "service", "environment", "zone_name"])).sort(byKey("hostname")),
    worker_scripts: (await get(`/accounts/${ACCOUNT}/workers/scripts`, token)).map((s) => s.id).sort(),
  };
}

// Paths (a.b[2].c) where two JSON values differ, for a readable --check report.
export function diffPaths(a, b, path = "") {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = Array.isArray(a) ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diffPaths(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k));
  }
  return [`${path || "(root)"}: committed ${JSON.stringify(a)?.slice(0, 120)} → live ${JSON.stringify(b)?.slice(0, 120)}`];
}

async function main() {
  const check = process.argv.includes("--check");
  const token = process.env.CLOUDFLARE_READ_TOKEN;
  if (!token) { console.error("CLOUDFLARE_READ_TOKEN is not set (a read-only token for both zones; see docs/06)"); process.exit(2); }
  const wrangler = execFileSync("npx", ["wrangler", "auth", "token"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").at(-1);
  const live = { "account.json": await exportAccount(wrangler) };
  for (const z of ZONES) live[`${z}.json`] = await exportZone(z, token);
  mkdirSync(OUT, { recursive: true });
  let drift = 0;
  for (const [file, data] of Object.entries(live)) {
    const path = join(OUT, file);
    if (check) {
      const committed = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
      const diffs = diffPaths(committed, data);
      drift += diffs.length;
      console.log(diffs.length ? `DRIFT ${file}\n  ${diffs.join("\n  ")}` : `ok    ${file}`);
    } else {
      writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
      console.log(`wrote infra/cloudflare/${file}`);
    }
  }
  if (check && drift) { console.log(`\n${drift} difference(s): if the dashboard change was intended, run npm run cf:export and commit; otherwise undo it in the dashboard.`); process.exit(1); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(2); });
