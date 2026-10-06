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
