// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const env = { ASSETS: { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`) } };

for (const host of ["www.patrickjv.com", "pvieira.co.uk", "www.pvieira.co.uk"]) {
  test(`${host} redirects 301 to the primary, keeping path and query`, async () => {
    const res = await worker.fetch(new Request(`http://${host}/a/b?x=1`), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "https://patrickjv.com/a/b?x=1");
  });
}

test("primary host serves assets, did.json included", async () => {
  const res = await worker.fetch(new Request("https://patrickjv.com/.well-known/did.json"), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "asset:/.well-known/did.json");
});

test("workers.dev preview host serves assets, not a redirect", async () => {
  const res = await worker.fetch(new Request("https://patrickjv-eng-site.vieira-pjpv.workers.dev/"), env);
  assert.equal(res.status, 200);
});
