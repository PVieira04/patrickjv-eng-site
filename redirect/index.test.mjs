// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const cases = [
  ["http://pvieira.co.uk/", "https://patrickjv.com/"],
  ["https://www.pvieira.co.uk/a/b?x=1&y=%20z", "https://patrickjv.com/a/b?x=1&y=%20z"],
  ["https://WWW.PatrickJV.com:8443/Path", "https://patrickjv.com/Path"],
  ["https://pvieira.co.uk./trailing-dot", "https://patrickjv.com/trailing-dot"],
  ["https://pvieira.co.uk//evil.example/x", "https://patrickjv.com//evil.example/x"],
];

for (const [from, to] of cases) {
  test(`${from} -> ${to}`, async () => {
    const res = await worker.fetch(new Request(from));
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), to);
    assert.equal(new URL(res.headers.get("location")).host, "patrickjv.com");
  });
}
