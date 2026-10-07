// Guards on the deploy workflow (R13): the deployment token never reaches the test run, and only
// main can deploy. Text checks on the YAML with comment lines removed, so prose cannot satisfy them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const code = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8")
  .split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, "")).join("\n");
const deploy = code("deploy.yml");
const deployJob = deploy.slice(deploy.indexOf("\n  deploy:"));

test("deploy.yml: tests run in the reusable (secret-free) job, never in the token-bearing deploy job", () => {
  assert.match(deploy, /uses: \.\/\.github\/workflows\/test\.yml/);
  assert.match(deployJob, /needs: test/);
  assert.doesNotMatch(deployJob, /npm (run )?(deploy|test)\b|node --test|build\.mjs/);
  for (const c of ["npx wrangler deploy\n", "npx wrangler deploy -c redirect/wrangler.jsonc", "npx wrangler deploy -c mcp/wrangler.jsonc"]) assert.ok(deployJob.includes(c), c);
});

test("deploy.yml: the token is only in the deploy step's env, and only main deploys", () => {
  assert.equal(deploy.split("secrets.CLOUDFLARE_API_TOKEN").length - 1, 1, "token referenced exactly once");
  const step = deployJob.slice(deployJob.indexOf("- name: Deploy site"), deployJob.indexOf("- name: Smoke"));
  assert.match(step, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(deployJob, /if: .*github\.ref == 'refs\/heads\/main'/);
});

const monitor = code("monitor.yml");
const DEPLOY_STEP = "Deploy site, redirect and MCP Workers";
const stepOf = (y, name) => { const i = y.indexOf(`- name: ${name}`); assert.ok(i >= 0, `no step "${name}"`); const j = y.indexOf("\n      - ", i + 1); return y.slice(i, j < 0 ? undefined : j); };

test("deploy.yml: a superseded SHA (re-run of an old run) is skipped, right before deploying", () => {
  const guard = stepOf(deployJob, "Skip if superseded by a newer main");
  assert.match(guard, /gh api "repos\/\$GITHUB_REPOSITORY\/commits\/main" --jq \.sha/);
  assert.match(guard, /"\$head" = "\$GITHUB_SHA"/);
  assert.match(guard, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.ok(deployJob.indexOf("Skip if superseded") < deployJob.indexOf(`- name: ${DEPLOY_STEP}`), "guard runs before the deploy step");
  const current = /if: steps\.current\.outputs\.current == 'true'/;
  assert.match(stepOf(deployJob, DEPLOY_STEP), current);
  assert.match(stepOf(deployJob, "Smoke the live site"), current);
});

test("deploy.yml: paths-ignore covers only unserved files (served Markdown under public/ deploys)", () => {
  const ignores = [...deploy.slice(deploy.indexOf("paths-ignore:"), deploy.indexOf("workflow_dispatch")).matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ignores, ["docs/**", "README.md", "designs/**/*.md"]);
});

test("monitor.yml: shares the deploy concurrency group (queue, never cancel) and smokes the last deployed commit", () => {
  for (const y of [deploy, monitor]) assert.match(y, /concurrency:\n  group: deploy\n  cancel-in-progress: false/);
  assert.match(monitor, /actions: read/);
  const find = stepOf(monitor, "Find the last deployed commit");
  assert.match(find, /actions\/workflows\/deploy\.yml\/runs\?branch=main&status=success/);
  assert.ok(find.includes(`select(.name == "${DEPLOY_STEP}")`), "looks for deploy.yml's real deploy step by name");
  assert.ok(deployJob.includes(`- name: ${DEPLOY_STEP}\n`), "the step name the monitor looks for exists in deploy.yml");
  const checkout = monitor.slice(monitor.indexOf("actions/checkout@"), monitor.indexOf("actions/setup-node@"));
  assert.match(checkout, /ref: \$\{\{ steps\.deployed\.outputs\.sha \}\}/);
  assert.match(monitor, /node smoke\.mjs https:\/\/patrickjv\.com --aliases --mcp --registry --strict-https --dns/);
});

test("monitor.yml: the 'main is deployed' check ignores exactly deploy.yml's paths-ignore", () => {
  const conv = stepOf(monitor, "main is deployed");
  assert.match(conv, /if: always\(\)/);
  assert.match(conv, /docs\/\*\|README\.md\|designs\/\*\.md\) ;;/);
  assert.match(conv, /select\(\.status != "completed"\)/);
});

test("workflows: every action pinned to a full commit SHA, checkout/setup-node on v7 (Node 24 runtime); Dependabot weekly", () => {
  for (const f of ["deploy.yml", "monitor.yml", "test.yml"]) {
    const uses = [...code(f).matchAll(/uses: (\S+)/g)].map((m) => m[1]).filter((u) => !u.startsWith("./"));
    assert.ok(uses.length >= 2, f);
    for (const u of uses) assert.match(u, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, `${f}: ${u}`);
    const raw = readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");
    assert.match(raw, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/, f);
    assert.match(raw, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/, f);
  }
  const dep = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  assert.match(dep, /package-ecosystem: github-actions\n\s+directory: \/\n\s+schedule:\n\s+interval: weekly/);
  assert.match(dep, /package-ecosystem: npm\n\s+directory: \/\n\s+schedule:\n\s+interval: weekly\n\s+groups:\n\s+dev-dependencies:\n\s+dependency-type: development/);
});
