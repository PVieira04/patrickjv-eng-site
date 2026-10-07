// Tests for infra/cloudflare-export.mjs (decision D2): the normalisers keep configuration and drop
// volatile fields, the check reports readable paths, and no committed export holds a personal address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseDns, normaliseRuleset, normaliseSettings, normaliseEmailRules, diffPaths, ZONES } from "../infra/cloudflare-export.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("normaliseDns: keeps configuration, drops ids/timestamps/meta, sorts by type, name, content", () => {
  const out = normaliseDns([
    { id: "2", type: "TXT", name: "b.example", content: "x", proxied: false, ttl: 1, created_on: "t", modified_on: "t", meta: {}, tags: [], comment: null, proxiable: false },
    { id: "1", type: "AAAA", name: "a.example", content: "100::", proxied: true, ttl: 1, comment: "Placeholder", settings: {} },
  ]);
  assert.deepEqual(out, [
    { type: "AAAA", name: "a.example", content: "100::", proxied: true, ttl: 1, comment: "Placeholder" },
    { type: "TXT", name: "b.example", content: "x", proxied: false, ttl: 1 },
  ]);
});

test("normaliseRuleset and normaliseSettings: rule content only; settings as id → value", () => {
  assert.deepEqual(normaliseRuleset({ id: "x", version: "7", last_updated: "t", phase: "p", rules: [{ id: "r", ref: "r", version: "3", last_updated: "t", description: "d", expression: "e", action: "a", enabled: true }] }),
    { phase: "p", rules: [{ description: "d", expression: "e", action: "a", enabled: true }] });
  assert.deepEqual(normaliseSettings([{ id: "ssl", value: "full", modified_on: "t", editable: true }, { id: "ipv6", value: "on" }]), { ipv6: "on", ssl: "full" });
});

test("normaliseEmailRules: forward destinations off the zones are redacted", () => {
  const [rule] = normaliseEmailRules([{ id: "i", tag: "t", name: "n", priority: 0, enabled: true, matchers: [], actions: [{ type: "forward", value: ["someone@gmail.com", "hello@patrickjv.com"] }] }]);
  assert.deepEqual(rule.actions[0].value, ["<verified destination>", "hello@patrickjv.com"]);
  assert.equal(rule.id, undefined);
});

test("diffPaths: names the changed path; equal values give nothing", () => {
  assert.deepEqual(diffPaths({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), []);
  assert.deepEqual(diffPaths({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), ["a[1].b: committed 2 → live 3"]);
  assert.deepEqual(diffPaths(null, { a: 1 }), ["(root): committed null → live {\"a\":1}"]);
});

test("committed exports contain no email address outside the zones", () => {
  const dir = join(ROOT, "infra/cloudflare");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.deepEqual(files.sort(), ["account.json", ...ZONES.map((z) => `${z}.json`)].sort());
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const foreign = (text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []).filter((a) => !ZONES.some((z) => a.toLowerCase().endsWith("@" + z)));
    assert.deepEqual(foreign, [], `${f} holds an address off the zones`);
  }
});
