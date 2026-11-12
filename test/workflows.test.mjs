// Guards on the GitHub workflows (R13, D4). Deploys are done by Cloudflare Workers Builds, so no
// workflow deploys and none holds a secret; the monitor reads Workers Builds' check runs.
// Text checks on the YAML with comment lines removed, so prose cannot satisfy them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("deploy.yml is gone: Workers Builds deploys; the workflows are exactly test, monitor, deploy-watch", () => {
  assert.equal(existsSync(new URL("deploy.yml", dir)), false);
  assert.deepEqual(workflows.sort(), ["deploy-watch.yml", "monitor.yml", "test.yml"]);
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
  // Branch builds (any branch but main) fail by design here and deploy nothing; alerting on them
  // emailed Patrick for every feature-branch push (9 Oct 2026). Only main's builds deploy.
  assert.match(job, /startsWith\(github\.event\.check_run\.name, 'Workers Builds: '\) &&\n\s+github\.event\.check_run\.check_suite\.head_branch == 'main'/);
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
  // deploy-watch.yml only calls the API with the runner's gh: no checkout, no actions at all.
  assert.doesNotMatch(code("deploy-watch.yml"), /uses:/);
  for (const f of workflows.filter((w) => w !== "deploy-watch.yml")) {
    const uses = [...code(f).matchAll(/uses: (\S+)/g)].map((m) => m[1]).filter((u) => !u.startsWith("./"));
    assert.ok(uses.length >= 2, f);
    for (const u of uses) assert.match(u, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, `${f}: ${u}`);
    assert.match(raw(f), /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/, f);
    assert.match(raw(f), /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7\.1\.0/, f);
  }
  const dep = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  assert.match(dep, /package-ecosystem: github-actions\n\s+directory: \/\n\s+schedule:\n\s+interval: weekly/);
  assert.match(dep, /package-ecosystem: npm\n\s+directory: \/\n\s+schedule:\n\s+interval: weekly\n\s+groups:\n\s+dev-dependencies:\n\s+dependency-type: development/);
});

// run: scripts take values through env, never ${{ }} (no expression injection into the shell).
// Every run: key must be extracted (inline, block with any indicator, or next-line form), so an
// unusual form cannot slip a script past the check.
const isRunKey = (l) => /^\s*(?:- )?run:/.test(l);
const runBlocks = (y) => {
  const out = [];
  const lines = y.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*(?:- )?)run:(.*)$/);
    if (!m || /^\s*#/.test(lines[i])) continue;
    const rest = m[2].trim();
    const block = !rest || /^[|>][+-]?\d*[+-]?(\s+#.*)?$/.test(rest);
    // Body: every following line indented past the run: key's column (for a one-line value, its
    // plain-scalar continuation lines, which are part of the script too).
    const body = block ? [] : [rest];
    for (i++; i < lines.length && (lines[i].trim() === "" || lines[i].search(/\S/) > m[1].length); i++) body.push(lines[i]);
    i--;
    const rows = block ? body : body.slice(1);
    const ind = Math.min(...rows.filter((l) => l.trim()).map((l) => l.search(/\S/)));
    const text = rows.map((l) => l.slice(ind)).join("\n").replace(/\n+$/, "");
    out.push(block ? text : [rest, text].filter(Boolean).join("\n"));
  }
  return out;
};

test("workflows: no ${{ }} inside any run: script, and every run: key is checked", () => {
  for (const f of workflows) {
    const keys = raw(f).split("\n").filter((l) => !/^\s*#/.test(l) && isRunKey(l)).length;
    const blocks = runBlocks(raw(f));
    assert.ok(keys > 0, f);
    assert.equal(blocks.length, keys, `${f}: every run: key extracted`);
    for (const b of blocks) {
      assert.ok(b.trim(), `${f}: empty run: script`);
      assert.doesNotMatch(b, /\$\{\{/, f);
    }
  }
});

test("runBlocks: extracts inline, |, >-, |2 and next-line run: forms", () => {
  const y = "      - run: echo a\n      - run: >-\n          echo b\n      - run: |2\n          echo c\n      - run:\n          echo ${{ x }}\n" +
    "      - run: echo d\n          ${{ y }}\n        env:\n          A: b\n      - name: n\n        run: |\n          echo e\n        shell: bash\n";
  assert.deepEqual(runBlocks(y), ["echo a", "echo b", "echo c", "echo ${{ x }}", "echo d\n${{ y }}", "echo e"]);
});

// deploy-watch.yml: Workers Builds sometimes silently drops a main build that arrives while a branch
// build is running (#28, #31). It alerts only when a served push gets no site check run, or one that
// never leaves the queue; a build's conclusion is monitor.yml build-result's alert, not this one's.
const watch = code("deploy-watch.yml");

test("deploy-watch.yml: push to main only, read-only checks + contents, one small job, no secrets", () => {
  assert.match(watch, /\non:\n  push:\n    branches: \[main\]\npermissions:\n  checks: read\n  contents: read\njobs:/);
  assert.equal([...watch.matchAll(/\n  [\w-]+:\n    runs-on:/g)].length, 1, "exactly one job");
  assert.match(watch, /runs-on: ubuntu-24\.04\n    timeout-minutes: 15/);
  assert.match(watch, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(watch, /FORCED: \$\{\{ github\.event\.forced \}\}/);
  assert.match(raw("deploy-watch.yml"), /^#.*12 minutes[\s\S]*free[\s\S]*public/m, "header notes the worst-case minutes");
});

test("deploy-watch.yml: ignores exactly the site watch-path excludes (renames count both names); polls the site check run every 60 s", () => {
  const m = watch.match(/case "\$f" in\n\s+(\S+)\) ;;/);
  assert.ok(m, "ignore case arm");
  assert.deepEqual(m[1].split("|"), SITE_WATCH_EXCLUDES);
  assert.ok(watch.includes("(.files | length), (.files[] | .filename, (.previous_filename // empty))"), "count and both names of a rename");
  assert.match(watch, /-ge 300/);
  assert.ok(watch.includes(`select(.app.slug == "${APP}" and .name == "${SITE_CHECK}")`), "site check run, right app");
  assert.match(watch, /check-runs\?check_name=Workers%20Builds%3A%20patrickjv-eng-site/);
  assert.match(watch, /sleep 60/);
});

test("monitor.yml 'main is deployed' counts both names of a rename", () => {
  assert.ok(stepOf(jobOf(monitor, "smoke"), "main is deployed").includes(".files[] | .filename, (.previous_filename // empty)"));
});

test("no workflow or docs/06 recommends an empty commit (it changes no watched file, so builds nothing)", () => {
  assert.doesNotMatch(raw("deploy-watch.yml"), /push an empty commit|allow-empty/);
  assert.doesNotMatch(readFileSync(new URL("../docs/06-operations.md", import.meta.url), "utf8"), /push an empty commit|allow-empty/);
});

// The behaviour tests run the real run: script under bash with fake gh and sleep on PATH. npm test
// also runs inside every Workers Builds build, so they skip (never fail) where that cannot work.
const shellSkip = (() => {
  if (process.platform === "win32") return "skipped on Windows: the workflow script is bash";
  // The same constructs as the workflow script and the fake gh.
  const b = spawnSync("bash", ["-e", "-c", 'x=$(seq 0 1); while read -r l; do :; done < <(tail -n +2 <<< "$x"); sed -n 1p /dev/null; head -n 1 /dev/null; cat /dev/null; echo ok'], { encoding: "utf8", timeout: 10000 });
  if (b.error || b.stdout.trim() !== "ok") return "skipped: bash (with seq, tail, sed, head, cat, process substitution and here-strings) is not usable";
  let d;
  try {
    d = mkdtempSync(join(tmpdir(), "deploy-watch-probe-"));
    writeFileSync(join(d, "probe"), "#!/usr/bin/env bash\necho ok\n");
    chmodSync(join(d, "probe"), 0o755);
    const r = spawnSync(join(d, "probe"), { encoding: "utf8", timeout: 10000 });
    if (r.error || r.stdout.trim() !== "ok") return `skipped: cannot run executables from ${tmpdir()} (noexec?)`;
  } catch (e) {
    return `skipped: temp-dir probe failed (${e.message})`;
  } finally {
    if (d) rmSync(d, { recursive: true, force: true });
  }
  return false;
})();
// In GitHub Actions (test.yml) the environment must support them: fail there rather than skip.
const shTest = (name, fn) =>
  process.env.GITHUB_ACTIONS === "true" && shellSkip
    ? test(name, () => assert.fail(`GitHub Actions cannot run the deploy-watch script tests: ${shellSkip}`))
    : test(name, { skip: shellSkip }, fn);

const SHA = "b".repeat(40);
const watchScript = runBlocks(raw("deploy-watch.yml"))[0];
// files: changed paths (a string, or { filename, previous } for a rename), or null = the compare call
// fails. polls: one entry per check-runs call — "" no check run, "ERR" the call fails, else
// "<status> <conclusion> <url>". The fake returns what the workflow's --jq filter would print.
function runWatch({ files, polls = [], before = "a".repeat(40), forced = "false", count }) {
  const d = mkdtempSync(join(tmpdir(), "deploy-watch-"));
  try {
    const names = files ? files.flatMap((f) => (typeof f === "string" ? [f] : [f.filename, f.previous])) : [];
    writeFileSync(join(d, "compare"), files ? [count ?? files.length, ...names].join("\n") + "\n" : "");
    writeFileSync(join(d, "polls"), polls.join("\n") + "\n");
    writeFileSync(join(d, "n"), "0");
    writeFileSync(join(d, "gh"), `#!/usr/bin/env bash
case "$*" in
  *compare/*) ${files ? `cat "${d}/compare"` : "exit 1"} ;;
  *check-runs*) n=$(cat "${d}/n"); echo $((n + 1)) > "${d}/n"; line=$(sed -n "$((n + 1))p" "${d}/polls"); [ "$line" = ERR ] && exit 1; echo "$line" ;;
  *) exit 9 ;;
esac
`);
    writeFileSync(join(d, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(d, "gh"), 0o755);
    chmodSync(join(d, "sleep"), 0o755);
    const r = spawnSync("bash", ["-e", "-c", watchScript], {
      encoding: "utf8",
      env: { PATH: `${d}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: join(d, "summary"), GITHUB_REPOSITORY: "o/r", SHA, BEFORE: before, FORCED: forced, GH_TOKEN: "x" },
    });
    return { code: r.status, out: r.stdout + r.stderr, polls: Number(readFileSync(join(d, "n"), "utf8")) };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const DOCS = ["docs/06-operations.md", "README.md", "designs/x.png"];
const ok = ["completed success u"];

shTest("deploy-watch: a push touching only docs/, README.md, designs/ passes without polling", () => {
  const r = runWatch({ files: DOCS });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.polls, 0);
});

// Fail closed: anything that leaves the change list unknown counts as served, so it is checked.
for (const [what, args] of [
  ["a rename out of a served path into docs/", { files: [{ filename: "docs/old-build.mjs", previous: "build.mjs" }] }],
  ["a compare listing 300 files (the API's cap), all docs", { files: Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`) }],
  ["an empty change list", { files: [] }],
  ["a failed compare call", { files: null }],
  ["a force-push", { files: DOCS, forced: "true" }],
  ["a push with no previous commit (zero before)", { files: DOCS, before: "0".repeat(40) }],
]) {
  shTest(`deploy-watch: ${what} is checked, not skipped`, () => {
    const r = runWatch({ ...args, polls: ok });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.polls, 1, r.out);
  });
}

shTest("deploy-watch: the site build appears and succeeds -> pass", () => {
  const r = runWatch({ files: ["docs/a.md", "build.mjs"], polls: ["", "", "queued null u", "completed success u"] });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.polls, 4);
});

shTest("deploy-watch: a failed build passes here (no double alert): build-result in monitor.yml alerts on it", () => {
  const r = runWatch({ files: ["build.mjs"], polls: ["completed failure https://dash/build/1"] });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /::error/);
  assert.match(r.out, /failure[\s\S]*build-result/);
});

shTest("deploy-watch: a build in progress is not a dropped build: notice naming the status, stop polling", () => {
  const r = runWatch({ files: ["content.json"], polls: ["", "in_progress null u"] });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.polls, 2);
  assert.match(r.out, /::notice::.*in_progress/);
});

shTest("deploy-watch: a build still queued at 12 minutes fails, naming the status", () => {
  const r = runWatch({ files: ["content.json"], polls: Array(13).fill("queued null u") });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.polls, 13);
  assert.match(r.out, /::error[^\n]*still 'queued' after 12 minutes/);
});

shTest("deploy-watch: no site build after 12 minutes -> fail loudly with what to do", () => {
  const r = runWatch({ files: ["content.json"], polls: ["ERR"] });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.polls, 13, "polls at 0, 1, ... 12 minutes");
  assert.match(r.out, new RegExp(`::error[^:]*::Cloudflare didn't build ${SHA}: retry the build in the dashboard`));
  assert.match(r.out, /1 of 13 check-runs calls failed/);
});

shTest("deploy-watch: every check-runs call failing -> 'could not read check runs', not 'didn't build'", () => {
  const r = runWatch({ files: ["content.json"], polls: Array(13).fill("ERR") });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.polls, 13);
  assert.match(r.out, /::error[^\n]*could not read check runs/);
  assert.doesNotMatch(r.out, /didn't build/);
});

// The repo is public: the intro mailbox lives in the INTRO_TO_ADDRESS Worker secret, never in config.
test("mcp/wrangler.jsonc names no destination mailbox (it is the INTRO_TO_ADDRESS secret)", () => {
  const cfg = readFileSync(new URL("../mcp/wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(cfg, /"destination_address"|"INTRO_TO(_ADDRESS)?"\s*:/);
  assert.doesNotMatch(cfg, /[\w.+-]+@(?!patrickjv\.com)[\w-]+\.[\w.]+/, "no mailbox other than @patrickjv.com addresses");
});
