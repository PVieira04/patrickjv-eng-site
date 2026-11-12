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

// ---- Output scan: F-001e's SCAN_RULES, verbatim, and the local denylist ----
import { SCAN_RULES, scanHits, parseDenylist, denylistHit } from "../lib/projects.mjs";

test("F-005 (US-4): SCAN_RULES are exactly the block in the spec, by name and pattern, in order", () => {
  const spec = readFileSync(join(ROOT, "docs/specs/F-005-research-agent-showcase.md"), "utf8");
  const block = spec.split("\n```\nhome_path")[1].split("\n```")[0];
  const rules = ("home_path" + block).split("\n").map((l) => { const m = l.match(/^(\S+)\s+(.+)$/); return [m[1], m[2]]; });
  assert.equal(rules.length, 18);
  assert.deepEqual(SCAN_RULES, rules);
});

test("F-005 (US-4): each scan rule hits, including home_path after every prefix character and both Windows slash forms", () => {
  const hits = {
    home_path: ["/home/someone/x", " /Users/someone", "(/root/x", "`/home/a", ":/home/a", "[/home/a", "</home/a", ",/home/a", "{/home/a", '"/home/a', "'/home/a", "=/home/a", "/mnt/c/Users/someone"],
    tilde_home: ["~/notes", "see ~/x"],
    windows_user_path: ["C:\\Users\\x", "C:/Users/x"],
    wsl_path: ["\\\\wsl.localhost\\Ubuntu", "\\\\wsl$\\Ubuntu"],
    file_url: ["file:///etc/x"],
    run_dir: ["runs/20261111T143000Z-a1b2c3/report.json"],
    data_cache: ["data/cache/x"],
    mcp_json: ["the .mcp.json file"],
    research_toml: ["research.toml"],
    run_user: ["/run/user/1000"],
    xdg_runtime: ["XDG_RUNTIME_DIR"],
    key_sk: ["sk-" + "a".repeat(20)],
    key_github: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map((p) => p + "A".repeat(36)),
    key_github_pat: ["github_pat_" + "a".repeat(60)],
    key_aws: ["AKIA" + "A".repeat(16)],
    key_databento: ["db-" + "a".repeat(24)],
    key_langsmith: ["lsv2_pt_" + "a".repeat(32), "lsv2_sk_" + "a".repeat(32)],
    private_key: ["-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----"],
  };
  assert.deepEqual(Object.keys(hits), SCAN_RULES.map(([n]) => n));
  for (const [rule, texts] of Object.entries(hits)) for (const t of texts) assert.ok(scanHits(t).includes(rule), `${rule}: ${t}`);
});

test("F-005 (US-4): F-001e's near-misses pass the scan", () => {
  for (const t of ["highs_open", "risk-adjusted_return", "ghp_short", "/projects/research-agent/runs/20261111T143000Z-a1b2c3/", "patrickjv.com", "a~/b", "x/home/y"]) {
    assert.deepEqual(scanHits(t), [], t);
  }
});

test("F-005 (US-4): .denylist.local is parsed as F-001e's denylist format", () => {
  assert.deepEqual(parseDenylist("  Zorblax Ltd  \n\n# a comment line\nacme.\r\n   \n#zorblax\n-corp"), ["Zorblax Ltd", "acme.", "-corp"]);
  assert.deepEqual(parseDenylist("# only a comment\n\n   \n"), []);
});

test("F-005 (US-4): a denylist term matches case-insensitively, never inside a longer word, and punctuation-ended terms match", () => {
  const terms = parseDenylist("zorblax\nacme.\n-corp");
  assert.equal(denylistHit("Built at ZORBLAX in 2020", terms), true);
  assert.equal(denylistHit("Built at Zorblax.", terms), true);
  assert.equal(denylistHit("zorblaxian tooling", terms), false);
  assert.equal(denylistHit("prezorblax", terms), false);
  assert.equal(denylistHit("the zorblax_x key", terms), false, "_ is a word character");
  assert.equal(denylistHit("see acme. later", terms), true);
  assert.equal(denylistHit("see acme.x later", terms), false, "the term may not touch a word character on either side");
  assert.equal(denylistHit("see acmes", terms), false);
  assert.equal(denylistHit("the -corp suffix", terms), true);
  assert.equal(denylistHit("big-corp", terms), false, "g touches the term on its left");
  assert.equal(denylistHit("a comment line", parseDenylist("# a comment line")), false, "comment text is not a term");
  assert.equal(denylistHit("anything", []), false);
});

// ---- PNG check (D3) ----
import { pngCheck } from "../lib/projects.mjs";
import { png, chunk, ihdr, SIGNATURE } from "./projects-helpers.mjs";

test("F-005 (D3): a valid PNG passes the PNG check and reports its IHDR size; 4096 x 4096 passes", () => {
  assert.deepEqual(pngCheck(png()), { width: 4, height: 3 });
  assert.deepEqual(pngCheck(png({ width: 4096, height: 4096, idat: Buffer.from([1]) })), { width: 4096, height: 4096 });
  const allowed = ["PLTE", "tRNS", "gAMA", "cHRM", "sRGB", "pHYs", "bKGD"].map((t) => chunk(t, Buffer.alloc(3)));
  assert.equal(pngCheck(png({ extra: allowed })).error, undefined, "every allow-listed chunk type passes");
});

test("F-005 (D3): the PNG check refuses each malformed or disallowed case", () => {
  const good = png();
  const iend = chunk("IEND"), idat = chunk("IDAT", Buffer.from([1, 2, 3]));
  const withBadCrc = Buffer.from(good); withBadCrc[good.length - 1] ^= 0xff;
  const pastEnd = Buffer.from(good); pastEnd.writeUInt32BE(1e6, 8 + 25);
  const bad = {
    "a private chunk (prVt)": png({ extra: [chunk("prVt", Buffer.from("x"))] }),
    "a tEXt chunk": png({ extra: [chunk("tEXt", Buffer.from("Comment\0hello"))] }),
    "a bad signature": Buffer.concat([Buffer.from("GIF89a\r\n"), good.subarray(8)]),
    "a bad CRC": withBadCrc,
    "a chunk length past the end": pastEnd,
    "a truncated file": good.subarray(0, good.length - 5),
    "IHDR not first": Buffer.concat([SIGNATURE, idat, ihdr(4, 3), iend]),
    "two IHDRs": Buffer.concat([SIGNATURE, ihdr(4, 3), ihdr(4, 3), idat, iend]),
    "an IHDR of length 12": Buffer.concat([SIGNATURE, chunk("IHDR", ihdr(4, 3).subarray(8, 20)), idat, iend]),
    "a zero width": png({ width: 0 }),
    "a zero height": png({ height: 0 }),
    "a width of 4097": png({ width: 4097, idat: Buffer.from([1]) }),
    "a height of 4097": png({ height: 4097, idat: Buffer.from([1]) }),
    "no IDAT": Buffer.concat([SIGNATURE, ihdr(4, 3), iend]),
    "PLTE after IDAT": Buffer.concat([SIGNATURE, ihdr(4, 3), idat, chunk("PLTE", Buffer.alloc(3)), iend]),
    "data after IEND": Buffer.concat([good, Buffer.from([0])]),
    "a chunk after IEND": Buffer.concat([good, idat]),
    "no IEND": Buffer.concat([SIGNATURE, ihdr(4, 3), idat]),
    "an empty file": Buffer.alloc(0),
  };
  for (const [what, b] of Object.entries(bad)) assert.equal(typeof pngCheck(b).error, "string", what);
});
