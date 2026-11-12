// F-005 PR 2: the research-agent export contract, the manifest, the D6 gate, the output scan and
// --record. Every fixture is hand-made synthetic data (test/fixtures/projects/), never a real export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("F-005 (US-4): .gitignore lists .denylist.local, so the local terms are never committed", () => {
  assert.ok(readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/).includes(".denylist.local"));
});
