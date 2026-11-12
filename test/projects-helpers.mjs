// Helpers for the F-005 tests: build PNGs chunk by chunk and write synthetic export folders in the
// shape research-agent's `research publish` writes them (export.json with sorted keys, 2-space
// indent, trailing newline). Every fixture is hand-made synthetic data, never a real export.
import { mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const FIXTURES = fileURLToPath(new URL("./fixtures/projects/", import.meta.url));
export const RUN_ID = "20261111T143000Z-a1b2c3";
export const EVAL_ID = "eval-20261111T150000Z";

export const sha = (b) => createHash("sha256").update(b).digest("hex");

// JSON as F-001e writes it: keys sorted at every level, 2-space indent, newline at the end.
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
export const dump = (v) => JSON.stringify(sorted(v), null, 2) + "\n";

// One PNG chunk: length, type, data, CRC over type + data (`crc` overrides it).
export function chunk(type, data = Buffer.alloc(0), crc) {
  const t = Buffer.from(type, "latin1");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc ?? crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}
export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function ihdr(width, height) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0); d.writeUInt32BE(height, 4);
  d[8] = 8; d[9] = 2; // 8-bit RGB
  return chunk("IHDR", d);
}
// A PNG whose IDAT holds `idat` (by default a real grey image; the check does not inflate it), so
// its total size is exact: 8 + 25 + (12 + idat length) + 12 bytes.
const pixels = (w, h) => deflateSync(Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(3 * w, 0x80)]))));
export const png = ({ width = 4, height = 3, idat = pixels(width, height), extra = [] } = {}) =>
  Buffer.concat([SIGNATURE, ihdr(width, height), ...extra, chunk("IDAT", idat), chunk("IEND")]);
export const pngOfSize = (bytes, opts) => png({ ...opts, idat: Buffer.alloc(bytes - 57, 0xab) });

// Write `files` (path -> Buffer or string) into `dir` with an export.json listing them, and return
// the export digest. `edit(doc)` may change export.json before it is written; `raw` replaces it.
export function writeExport(dir, { kind = "run", id = RUN_ID, files, edit, raw, version = "0.1.0" }) {
  rmSync(dir, { recursive: true, force: true });
  for (const [f, b] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), b);
  }
  let doc = {
    export_version: "1.0.0", kind, id,
    tool: { name: "research-agent", version },
    exported_at: "2026-11-11T15:04:05Z",
    files: Object.keys(files).sort().map((path) => { const b = Buffer.from(files[path]); return { path, sha256: sha(b), bytes: b.length }; }),
  };
  if (edit) doc = edit(doc) ?? doc;
  const text = raw ?? dump(doc);
  writeFileSync(join(dir, "export.json"), text);
  return sha(Buffer.from(text));
}

// Every file in a folder, path -> Buffer (relative, "/"-separated), export.json excluded.
export function readTree(dir) {
  const out = {};
  (function walk(rel) {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const f = rel ? `${rel}/${name}` : name;
      if (lstatSync(join(dir, f)).isDirectory()) walk(f);
      else if (f !== "export.json") out[f] = readFileSync(join(dir, f));
    }
  })("");
  return out;
}

// The committed run and scorecard fixtures, as path -> Buffer, and as parsed JSON to edit.
export const runFiles = () => readTree(join(FIXTURES, "run"));
export const scorecardFiles = () => readTree(join(FIXTURES, "scorecard"));
export const report = () => JSON.parse(readFileSync(join(FIXTURES, "run/report.json"), "utf8"));
export const scorecard = () => JSON.parse(readFileSync(join(FIXTURES, "scorecard/scorecard.json"), "utf8"));
export const copyFixture = (name, to) => cpSync(join(FIXTURES, name), to, { recursive: true });
