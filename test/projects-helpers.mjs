// Helpers for the F-005 tests: build PNGs chunk by chunk and write synthetic export folders in the
// shape research-agent's `research publish` writes them (export.json with sorted keys, 2-space
// indent, trailing newline). Every fixture is hand-made synthetic data, never a real export.
import { mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync, lstatSync, rmSync, readlinkSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
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
// IHDR: 8-bit RGB by default; `depth`, `colour`, `compression`, `filter` and `interlace` override.
export function ihdr(width, height, { depth = 8, colour = 2, compression = 0, filter = 0, interlace = 0 } = {}) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0); d.writeUInt32BE(height, 4);
  d[8] = depth; d[9] = colour; d[10] = compression; d[11] = filter; d[12] = interlace;
  return chunk("IHDR", d);
}
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// The raw (filtered, non-interlaced) image bytes: a filter byte, then the row's pixels, per row.
const rawSize = (w, h, depth, colour) => h * (1 + Math.ceil((w * CHANNELS[colour] * depth) / 8));
export const pixels = (w, h, depth = 8, colour = 2) => deflateSync(Buffer.alloc(rawSize(w, h, depth, colour)));
// A PNG whose IDAT holds `idat` (by default a real image of the given header), so its total size
// is 8 + 25 + (12 + idat length) + 12 bytes plus any `extra` chunks.
export const png = ({ width = 4, height = 3, depth = 8, colour = 2, idat = pixels(width, height, depth, colour), extra = [], header = {} } = {}) =>
  Buffer.concat([SIGNATURE, ihdr(width, height, { depth, colour, ...header }), ...extra, chunk("IDAT", idat), chunk("IEND")]);

// A zlib stream of exactly `size` bytes inflating to zeros: stored blocks (5 bytes of header
// each, up to 65,535 bytes of data), a 2-byte zlib header and a 4-byte Adler-32.
function adler32(b) { let a = 1, c = 0; for (const x of b) { a = (a + x) % 65521; c = (c + a) % 65521; } return ((c << 16) | a) >>> 0; }
export function storedZlib(size) {
  let k = 1;
  while (size - 6 - 5 * k > 65535 * k) k++;
  const data = Buffer.alloc(size - 6 - 5 * k);
  const parts = [Buffer.from([0x78, 0x01])];
  for (let i = 0; i < k; i++) {
    const piece = data.subarray(Math.floor((i * data.length) / k), Math.floor(((i + 1) * data.length) / k));
    const h = Buffer.alloc(5);
    h[0] = i === k - 1 ? 1 : 0; h.writeUInt16LE(piece.length, 1); h.writeUInt16LE(~piece.length & 0xffff, 3);
    parts.push(h, piece);
  }
  const a = Buffer.alloc(4); a.writeUInt32BE(adler32(data));
  return Buffer.concat([...parts, a]);
}
// A valid PNG of exactly `bytes` bytes: 4096 pixels wide, 16-bit RGBA, tall enough that the
// inflated stream fits within its raw size.
export function pngOfSize(bytes) {
  const idat = storedZlib(bytes - 57);
  return png({ width: 4096, height: Math.ceil(idat.length / (1 + 4096 * 8)) + 1, depth: 16, colour: 6, idat });
}

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
      const st = lstatSync(join(dir, f));
      if (st.isSymbolicLink()) out[f] = Buffer.from("symlink -> " + readlinkSync(join(dir, f)));
      else if (st.isDirectory()) walk(f);
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

// A scratch copy of the site starts with no published run or scorecard, whatever the repository
// has recorded: remove the recorded runs, scorecard and manifest, and the run pages the build
// generated from them, so a fixture test builds only from its own fixtures. The real recorded
// content is checked by `node build.mjs --check` against the checkout (npm test runs it first).
// It deletes, so it refuses any root that is not strictly inside tmpdir(), or is the checkout.
const CHECKOUT = fileURLToPath(new URL("..", import.meta.url));
export function clearRecorded(root) {
  const r = resolve(root), rel = relative(resolve(tmpdir()), r);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || r === resolve(CHECKOUT)) throw new Error(`clearRecorded: ${JSON.stringify(root)} is not a scratch copy inside ${tmpdir()}`);
  for (const f of ["projects/research-agent/runs", "projects/research-agent/scorecard", "projects/research-agent/published.json", "public/projects/research-agent"]) rmSync(join(root, f), { recursive: true, force: true });
  // With no run the showcase can't be launched (F-005 D9), so the copy starts unlaunched too.
  const c = join(root, "content.json"), h = join(root, "public/index.html");
  if (existsSync(c)) writeFileSync(c, JSON.stringify(unlaunch(JSON.parse(readFileSync(c, "utf8"))), null, 2) + "\n");
  if (existsSync(h)) writeFileSync(h, unlaunchHtml(readFileSync(h, "utf8")));
}

// The launch PR's edits undone: launched false, and the showcase's side-projects entry and its
// homepage card removed (F-005, Launch). No-ops on a copy that isn't launched.
export function unlaunch(c) {
  c.pages.projects.launched = false;
  c.side_projects = c.side_projects.filter((p) => p.url !== "/projects/research-agent");
  return c;
}
export const unlaunchHtml = (html) => html.replace(/\n {10}<li>\n {12}<article aria-labelledby="s-\d+-h">(?:(?!<\/li>)[\s\S])*?href="\/projects\/research-agent"[\s\S]*?<\/li>(?=\n)/, "");
