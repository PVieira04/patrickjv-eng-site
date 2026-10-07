// Guards on the GitHub workflows (R13, D4). Deploys are done by Cloudflare Workers Builds, so no
// workflow deploys and none holds a secret; the monitor reads Workers Builds' check runs.
// Text checks on the YAML with comment lines removed, so prose cannot satisfy them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const dir = new URL("../.github/workflows/", import.meta.url);
const raw = (f) => readFileSync(new URL(f, dir), "utf8");
const code = (f) => raw(f).split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, "")).join("\n");
const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const monitor = code("monitor.yml");
const stepOf = (y, name) => { const i = y.indexOf(`- name: ${name}`); assert.ok(i >= 0, `no step "${name}"`); const j = y.indexOf("\n      - ", i + 1); return y.slice(i, j < 0 ? undefined : j); };
const jobOf = (y, name) => { const i = y.indexOf(`\n  ${name}:\n`); assert.ok(i >= 0, `no job "${name}"`); const j = y.slice(i + 1).search(/\n  [\w-]+:\n/); return y.slice(i, j < 0 ? undefined : i + 1 + j); };

const APP = "cloudflare-workers-and-pages";
const SITE_CHECK = "Workers Builds: patrickjv-eng-site";
// The site Worker's build watch-path excludes, as configured in the Cloudflare dashboard and
// documented in docs/06 ("Deploying"). The monitor's "main is deployed" ignore list must equal it.
const SITE_WATCH_EXCLUDES = ["docs/*", "README.md", "designs/*"];

test("deploy.yml is gone: Workers Builds deploys; the workflows are exactly test, monitor", () => {
  assert.equal(existsSync(new URL("deploy.yml", dir)), false);
  assert.deepEqual(workflows.sort(), ["monitor.yml", "test.yml"]);
});

test("no workflow references a secret (no deploy credential in GitHub)", () => {
  for (const f of workflows) assert.doesNotMatch(raw(f), /secrets\./, f);
  for (const f of workflows) assert.doesNotMatch(code(f), /wrangler|CLOUDFLARE_API_TOKEN/, f);
});

test("monitor.yml: read-only permissions; schedule, dispatch and completed check runs", () => {
  assert.match(monitor, /permissions:\n  contents: read\n  checks: read\njobs:/);
  assert.match(monitor, /schedule:\n    - cron: "17 \*\/6 \* \* \*"/);
  assert.match(monitor, /workflow_dispatch:/);
  assert.match(monitor, /check_run:\n    types: \[completed\]/);
});

test("monitor.yml: smokes the last deployed commit, found via the site's Workers Builds check run", () => {
  const job = jobOf(monitor, "smoke");
  assert.match(job, /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(job, /concurrency:\n      group: monitor\n      cancel-in-progress: false/);
  const find = stepOf(job, "Find the last deployed commit");
  assert.match(find, /commits\?sha=main&per_page=30/);
  assert.ok(find.includes(`select(.app.slug == "${APP}" and .name == "${SITE_CHECK}" and .conclusion == "success")`), "site check run, right app, success");
  assert.match(find, /::error::/);
  const checkout = job.slice(job.indexOf("actions/checkout@"), job.indexOf("actions/setup-node@"));
  assert.match(checkout, /ref: \$\{\{ steps\.deployed\.outputs\.sha \}\}/);
  assert.match(job, /node smoke\.mjs https:\/\/patrickjv\.com --aliases --mcp --registry --strict-https --dns/);
  assert.match(job, /GITHUB_STEP_SUMMARY/);
});

test("monitor.yml: 'main is deployed' ignores exactly the site watch-path excludes and reads the head's build", () => {
  const conv = stepOf(jobOf(monitor, "smoke"), "main is deployed");
  assert.match(conv, /if: always\(\)/);
  const m = conv.match(/case "\$f" in\n\s+(\S+)\) ;;/);
  assert.ok(m, "ignore case arm");
  assert.deepEqual(m[1].split("|"), SITE_WATCH_EXCLUDES);
  assert.ok(conv.includes(`select(.app.slug == "${APP}" and .name == "${SITE_CHECK}")`));
  assert.match(conv, /title=Workers Builds failed/);
  assert.match(conv, /queued or in progress/);
  const docs = readFileSync(new URL("../docs/06-operations.md", import.meta.url), "utf8");
  const row = docs.split("\n").find((l) => l.startsWith("| `patrickjv-eng-site` |"));
  assert.ok(row, "docs/06 has the site Worker's row");
  assert.ok(row.includes("exclude "), "site row names its excludes");
  const excludes = [...row.slice(row.indexOf("exclude ")).split("|")[0].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  assert.deepEqual(excludes, SITE_WATCH_EXCLUDES, "docs/06 lists the same excludes");
});

test("monitor.yml: the check_run job is gated on the Workers Builds app and alerts on any non-success", () => {
  const job = jobOf(monitor, "build-result");
  assert.match(job, /github\.event_name == 'check_run' &&\n\s+github\.event\.check_run\.app\.slug == 'cloudflare-workers-and-pages' &&\n\s+startsWith\(github\.event\.check_run\.name, 'Workers Builds: '\)/);
  assert.match(job, /group: monitor-build-\$\{\{ github\.event\.check_run\.head_sha \}\}-\$\{\{ github\.event\.check_run\.name \}\}/);
  const result = stepOf(job, "Workers Builds result");
  assert.match(result, /if \[ "\$CONCLUSION" != success \]; then\n\s+echo "::error title=Workers Builds failed: \$worker::/);
  assert.match(result, /exit 1/);
  assert.doesNotMatch(result, /\n\s+if:/, "the alert step always runs");
});

test("monitor.yml: post-deploy smoke only for the site build, at its head_sha, with retries", () => {
  const job = jobOf(monitor, "build-result");
  assert.match(stepOf(job, "Still the newest site build on main?"), new RegExp(`if: >-\\n\\s+github\\.event\\.check_run\\.name == '${SITE_CHECK}'`));
  const gated = /if: steps\.current\.outputs\.current == 'true'/;
  const checkout = job.slice(job.indexOf("actions/checkout@"), job.indexOf("actions/setup-node@"));
  assert.match(checkout, gated);
  assert.match(checkout, /ref: \$\{\{ github\.event\.check_run\.head_sha \}\}/);
  const smoke = stepOf(job, "Smoke the live site");
  assert.match(smoke, gated);
  assert.match(smoke, /for attempt in 1 2 3 4 5; do/);
  assert.match(smoke, /sleep \$\(\(attempt \* 20\)\)/);
  assert.match(smoke, /node smoke\.mjs https:\/\/patrickjv\.com --aliases --mcp --strict-https/);
});

test("workflows: every action pinned to a full commit SHA, checkout/setup-node on v7 (Node 24 runtime); Dependabot weekly", () => {
  for (const f of workflows) {
    const uses = [...code(f).matchAll(/uses: (\S+)/g)].map((m) => m[1]).filter((u) => !u.startsWith("./"));
    assert.ok(uses.length >= 2, f);
    for (const u of uses) assert.match(u, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, `${f}: ${u}`);
    assert.match(raw(f), /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/, f);
    assert.match(raw(f), /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/, f);
  }
  const dep = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  assert.match(dep, /package-ecosystem: github-actions\n\s+directory: \/\n\s+schedule:\n\s+interval: weekly/);
  assert.match(dep, /package-ecosystem: npm\n\s+directory: \/\n\s+schedule:\n\s+interval: weekly\n\s+groups:\n\s+dev-dependencies:\n\s+dependency-type: development/);
});
