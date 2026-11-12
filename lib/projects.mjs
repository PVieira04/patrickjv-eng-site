// F-005: the research-agent showcase's export contract and its checks — the manifest
// (projects/research-agent/published.json), the export folders `research publish` writes, the PNG
// check, the report.json field and enumeration checks, the scorecard type re-check, the D6
// synthetic-only gate, and the output scan (F-001e's SCAN_RULES, the employer denylist and the
// optional local denylist). Used by build.mjs for every build and by --record before it writes.
// Every check names a file and a rule, never the matched text.

import { crc32, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, openSync, fstatSync, closeSync, constants as FS } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------------------------
// Output scan. F-001e's SCAN_RULES are normative: exactly these names and patterns (Python `re`
// syntax, the same in JavaScript). Two engine differences, handled: JavaScript's \w and \b are
// ASCII where Python's are Unicode, which can only make a rule here match more (every place they
// sit, an ASCII word character is on one side); and JavaScript's \s lacks \x1c-\x1f and \x85,
// which Python's has, so the text is also scanned with those replaced by spaces.
// ---------------------------------------------------------------------------------------------
const BEFORE = "(?:^|[\\s\"'(=`:\\[<,{])";
export const SCAN_RULES = [
  ["home_path", BEFORE + "(?:/mnt/[A-Za-z])?/(?:home|Users|root)/[A-Za-z0-9._-]+"],
  ["tilde_home", BEFORE + "~/"],
  ["windows_user_path", BEFORE + "[A-Za-z]:[\\\\/]Users[\\\\/]"],
  ["wsl_path", "\\\\\\\\wsl(?:\\.localhost|\\$)\\\\"],
  ["file_url", "file://"],
  ["run_dir", "(?<![/\\w])runs/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}/"],
  ["data_cache", "\\bdata/cache/"],
  ["mcp_json", "\\.mcp\\.json\\b"],
  ["research_toml", "\\bresearch\\.toml\\b"],
  ["run_user", "/run/user/[0-9]+"],
  ["xdg_runtime", "\\bXDG_RUNTIME_DIR\\b"],
  ["key_sk", "\\bsk-[A-Za-z0-9_-]{20,}"],
  ["key_github", "\\bgh[pousr]_[A-Za-z0-9]{36}\\b"],
  ["key_github_pat", "\\bgithub_pat_[A-Za-z0-9_]{60,}"],
  ["key_aws", "\\bAKIA[0-9A-Z]{16}\\b"],
  ["key_databento", "\\bdb-[A-Za-z0-9]{24,}"],
  ["key_langsmith", "\\blsv2_(?:pt|sk)_[A-Za-z0-9_]{32,}"],
  ["private_key", "-----BEGIN [A-Z ]*PRIVATE KEY-----"],
];
const COMPILED = SCAN_RULES.map(([name, p]) => [name, new RegExp(p)]);
// The names of the rules `text` matches.
export const scanHits = (text) => {
  const spaced = text.replace(/[\x1c-\x1f\x85]/g, " ");
  return COMPILED.filter(([, re]) => re.test(text) || re.test(spaced)).map(([name]) => name);
};

// The local denylist (.denylist.local), in F-001e's "Denylist format": UTF-8, one term per line
// (split as Python's splitlines), each stripped of Python's whitespace set (not U+FEFF, which
// String.prototype.trim would also remove); blank lines and lines starting with # skipped. A file
// with no terms checks nothing.
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
export const parseDenylist = (text) => text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).map((l) => l.replace(STRIP, "")).filter((l) => l && !l.startsWith("#"));
// Whether any term appears, case-insensitively, touching no word character on either side:
// (?<!\w) term (?!\w), with \w Unicode-aware as in Python. Python folds with casefold(); here a
// term hits if it matches under the `iu` flags (simple case folding) or after folding both sides
// with toUpperCase().toLowerCase() (full folding: ß -> ss, ﬁ -> fi).
const reEscape = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const termRe = (t) => new RegExp(`(?<![\\p{L}\\p{N}_])${reEscape(t)}(?![\\p{L}\\p{N}_])`, "iu");
const fold = (s) => s.toUpperCase().toLowerCase();
export const denylistHit = (text, terms) => terms.some((t) => termRe(t).test(text) || termRe(fold(t)).test(fold(text)));

// ---------------------------------------------------------------------------------------------
// PNG check (D3): the signature, then whole chunks with correct CRCs, every type on the allow-list,
// exactly one IHDR, first, of length 13, with width and height 1 to 4,096 and valid header fields;
// at least one IDAT; PLTE before the first IDAT; IEND last with nothing after it. As F-001e's chunk
// filter also requires: the fixed or bounded lengths below, each of those chunks at most once, and
// the IDAT data exactly one complete zlib stream, nothing after it, inflating to no more than the
// image's raw size plus 1,024 bytes. Returns { width, height } or { error }. Figures are never
// text-scanned: the allow-list is what keeps text chunks out of them.
// ---------------------------------------------------------------------------------------------
export const MAX_SIDE = 4096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "pHYs", "bKGD"]);
const CHUNK_LENGTHS = { gAMA: (n) => n === 4, cHRM: (n) => n === 32, sRGB: (n) => n === 1, pHYs: (n) => n === 9, bKGD: (n) => [1, 2, 6].includes(n), tRNS: (n) => n >= 1 && n <= 256, PLTE: (n) => n >= 3 && n <= 768 && n % 3 === 0 };
// Valid bit depths per colour type, and channels per pixel (PNG specification).
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_SLACK = 1024;
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
// The size of the filtered image data (a filter byte per row, per Adam7 pass when interlaced).
function rawSize(w, h, depth, colour, interlace) {
  const rows = (pw, ph) => (pw && ph ? ph * (1 + Math.ceil((pw * CHANNELS[colour] * depth) / 8)) : 0);
  if (!interlace) return rows(w, h);
  return ADAM7.reduce((n, [x0, y0, dx, dy]) => n + rows(Math.ceil(Math.max(0, w - x0) / dx), Math.ceil(Math.max(0, h - y0) / dy)), 0);
}
// Whether `stream` is exactly one zlib stream that ends, with nothing after it, inflating to at
// most `bound` bytes (output discarded; inflation stops at the bound).
function oneZlibStream(stream, bound) {
  try {
    const { engine } = inflateSync(stream, { info: true, maxOutputLength: Math.max(1, bound) });
    return engine.bytesWritten === stream.length;
  } catch { return false; }
}
export function pngCheck(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { error: "not a PNG (bad signature)" };
  const seen = [], idat = [];
  let pos = 8, width, height, depth, colour, interlace;
  while (pos < buf.length) {
    if (buf.length - pos < 12) return { error: "truncated (a partial chunk at the end)" };
    const len = buf.readUInt32BE(pos);
    if (len > buf.length - pos - 12) return { error: "a chunk length runs past the end of the file" };
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const name = /^[A-Za-z]{4}$/.test(type) ? type : "a chunk with an invalid type";
    if (!CHUNKS.has(type)) return { error: `chunk ${name} is not on the allow-list` };
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) return { error: `chunk ${type} has a bad CRC` };
    if (!seen.length && type !== "IHDR") return { error: "IHDR is not the first chunk" };
    if (type === "IHDR") {
      if (seen.length) return { error: "more than one IHDR" };
      if (len !== 13) return { error: `IHDR has length ${len}, not 13` };
      width = buf.readUInt32BE(pos + 8); height = buf.readUInt32BE(pos + 12);
      [depth, colour] = [buf[pos + 16], buf[pos + 17]];
      const [compression, filter] = [buf[pos + 18], buf[pos + 19]];
      interlace = buf[pos + 20];
      if (width < 1 || width > MAX_SIDE || height < 1 || height > MAX_SIDE) return { error: `${width} x ${height} pixels; each side must be 1 to ${MAX_SIDE}` };
      if (!DEPTHS[colour]?.includes(depth)) return { error: `IHDR: bit depth ${depth} with colour type ${colour} is not valid` };
      if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) return { error: "IHDR: compression and filter must be 0, interlace 0 or 1" };
    }
    if (CHUNK_LENGTHS[type]) {
      if (!CHUNK_LENGTHS[type](len)) return { error: `chunk ${type} has length ${len}, which isn't allowed` };
      if (seen.includes(type)) return { error: `chunk ${type} appears more than once` };
    }
    if (type === "PLTE" && seen.includes("IDAT")) return { error: "PLTE comes after IDAT" };
    if (type === "IDAT") idat.push(buf.subarray(pos + 8, pos + 8 + len));
    seen.push(type);
    pos += 12 + len;
    if (type === "IEND") {
      if (len !== 0) return { error: `IEND has length ${len}, not 0` };
      if (pos !== buf.length) return { error: "data after IEND" };
      if (!idat.length) return { error: "no IDAT chunk" };
      if (!oneZlibStream(Buffer.concat(idat), rawSize(width, height, depth, colour, interlace) + PNG_SLACK)) return { error: "IDAT is not exactly one complete zlib stream within the image's size" };
      return { width, height };
    }
  }
  return { error: seen.includes("IDAT") ? "no IEND chunk (truncated)" : "no IDAT chunk" };
}

// ---------------------------------------------------------------------------------------------
// Patterns, limits and enumerations ("Export contract"). The report schema is private, so only
// the fields the pages read are checked here; full schema validation stays in `research publish`.
// A value not in ENUMS (for example from a newer 1.x schema) fails until the spec adds it.
// ---------------------------------------------------------------------------------------------
export const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;
export const EVAL_ID = /^eval-[0-9]{8}T[0-9]{6}Z$/;
export const FIGURE_PATH = /^calls\/[1-9][0-9]{0,3}\/out\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,55}\.png$/;
export const LIMITS = { figures: 20, figureBytes: 204_800, runFigureBytes: 1_048_576 };
const MAJOR_1 = /^1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const QUESTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DATASET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MODEL_ID = /^[a-z0-9_-]{1,32}:[A-Za-z0-9._-]{1,100}$/;
const UTC = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,6})?Z$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
export const ENUMS = {
  status: ["completed", "rejected", "capped", "failed"],
  outcome: ["passed", "not_passed", "not_reviewed"],
  tag: ["look_ahead", "overlap_autocorrelation", "sample_size", "return_definition", "contract_roll", "timezone_session", "multiple_comparisons"],
  stop_reason: ["pass_tool_calls", "run_tool_calls", "run_tokens", "sandbox_unavailable", "dataset_unavailable", "access_denied", "run_not_owned", "invalid_model_output", "model_error", "internal_error", "abandoned", "unsanctioned_call", "run_mismatch", "missing_critique"],
  harness: ["langgraph", "claude-code"],
  author: ["model", "system"],
  role: ["trap_caught", "rejected_plan", "clean_pass"],
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v) && Math.abs(v) <= 2 ** 53;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const len = (s) => [...s].length; // Unicode code points, as Python's len()
const isStr = (v, lo = 1, hi = Infinity) => typeof v === "string" && len(v) >= lo && len(v) <= hi;
const realDate = (y, m, d) => { const t = new Date(Date.UTC(+y, +m - 1, +d)); return t.getUTCFullYear() === +y && t.getUTCMonth() === +m - 1 && t.getUTCDate() === +d; };
export const isUtc = (v) => { const m = typeof v === "string" && v.match(UTC); return !!m && realDate(m[1], m[2], m[3]) && +m[4] < 24 && +m[5] < 60 && +m[6] < 60; };
export const isDate = (v) => { const m = typeof v === "string" && v.match(DATE); return !!m && realDate(m[1], m[2], m[3]); };

// D6, the synthetic-only gate. No config switch: opening it is a change to the spec.
const GATE_SOURCE = /^synthetic:research_agent\.data\.synth seed=[0-9]+$/;
const GATE_LICENCE = "Synthetic data, no restrictions";
function gateErrors(ds, where) {
  const e = [];
  if (ds.visibility !== "public") e.push(`${where}.visibility is not "public" (D6: synthetic data only)`);
  if (typeof ds.source !== "string" || !GATE_SOURCE.test(ds.source)) e.push(`${where}.source is not the synthetic generator (D6: synthetic data only)`);
  if (ds.licence !== GATE_LICENCE) e.push(`${where}.licence is not exactly "${GATE_LICENCE}" (D6: synthetic data only)`);
  return e;
}
// A dataset object as the report schema has it: name, and source, visibility and licence.
function datasetErrors(ds, where) {
  if (!isObj(ds)) return [`${where} must be an object`];
  const e = [];
  if (typeof ds.name !== "string" || !DATASET_NAME.test(ds.name)) e.push(`${where}.name must be a dataset name`);
  if (!isStr(ds.source, 1, 200)) e.push(`${where}.source must be a string of 1 to 200 characters`);
  if (!["public", "private"].includes(ds.visibility)) e.push(`${where}.visibility must be "public" or "private"`);
  if (!isStr(ds.licence, 1, 200)) e.push(`${where}.licence must be a string of 1 to 200 characters`);
  return e.length ? e : gateErrors(ds, where);
}

// The report.json fields the pages read, their types and enumerations, and the D6 gate. Errors are
// prefixed "report.json: " and name the field, never its value.
export function reportErrors(doc) {
  const e = [];
  const need = (ok, field, what) => { if (!ok) e.push(`${field} must be ${what}`); };
  const enumOf = (v, list, field) => need(list.includes(v), field, `one of ${list.join(", ")}`);
  if (!isObj(doc)) return ["report.json: must be a JSON object"];
  need(typeof doc.schema_version === "string" && MAJOR_1.test(doc.schema_version), "schema_version", "a 1.x.y version");
  need(typeof doc.run_id === "string" && RUN_ID.test(doc.run_id), "run_id", "a run id");
  enumOf(doc.status, ENUMS.status, "status");
  need(isStr(doc.question), "question", "a non-empty string");
  e.push(...datasetErrors(doc.dataset, "dataset"));
  need(isUtc(doc.finished_at), "finished_at", "a UTC timestamp ending in Z");
  if (!isObj(doc.models)) e.push("models must be an object");
  else {
    enumOf(doc.models.harness, ENUMS.harness, "models.harness");
    for (const k of ["planner", "analyst", "critic"]) need(typeof doc.models[k] === "string" && MODEL_ID.test(doc.models[k]), `models.${k}`, "a model id (provider:model)");
  }
  if (doc.plan === null) need(doc.status === "failed" || doc.status === "capped", "plan", "present unless the run failed or was capped");
  else if (!isObj(doc.plan)) e.push("plan must be null or an object");
  else {
    for (const k of ["hypothesis", "method", "statistic", "significance"]) need(isStr(doc.plan[k]), `plan.${k}`, "a non-empty string");
    need(typeof doc.plan.dataset === "string" && DATASET_NAME.test(doc.plan.dataset), "plan.dataset", "a dataset name");
    for (const k of ["start", "end"]) need(isDate(doc.plan[k]), `plan.${k}`, "a date (YYYY-MM-DD)");
  }
  if (!isObj(doc.review)) e.push("review must be an object");
  else {
    enumOf(doc.review.outcome, ENUMS.outcome, "review.outcome");
    if (!Array.isArray(doc.review.open_issues)) e.push("review.open_issues must be an array");
    else doc.review.open_issues.forEach((x, i) => {
      if (!isObj(x)) return e.push(`review.open_issues[${i}] must be an object`);
      enumOf(x.tag, ENUMS.tag, `review.open_issues[${i}].tag`);
      need(isStr(x.explanation), `review.open_issues[${i}].explanation`, "a non-empty string");
    });
  }
  if (!isObj(doc.summary)) e.push("summary must be an object");
  else {
    need(isStr(doc.summary.text), "summary.text", "a non-empty string");
    enumOf(doc.summary.author, ENUMS.author, "summary.author");
  }
  if (!Array.isArray(doc.figures)) e.push("figures must be an array");
  else {
    doc.figures.forEach((f, i) => need(typeof f === "string" && FIGURE_PATH.test(f), `figures[${i}]`, "a figure path (calls/<N>/out/<name>.png)"));
    need(new Set(doc.figures).size === doc.figures.length, "figures", "unique");
    need(doc.figures.length <= LIMITS.figures, "figures", `at most ${LIMITS.figures} entries`);
  }
  if (doc.status === "rejected") {
    need(isObj(doc.rejection) && isStr(doc.rejection.reason), "rejection.reason", "a non-empty string for a rejected run");
    need(!Array.isArray(doc.figures) || doc.figures.length === 0, "figures", "empty for a rejected run (no analysis ran)");
  }
  if (doc.status === "capped" || doc.status === "failed") enumOf(doc.stop_reason, ENUMS.stop_reason, "stop_reason");
  return e.map((x) => "report.json: " + x);
}

// ---------------------------------------------------------------------------------------------
// Scorecard types (F-001e "Scorecard types", normative): every path, type and null rule, re-checked
// on the exported scorecard.json. A path outside the table — including every field F-001e drops by
// default — fails. Two kept entries are subtrees (caps, statistic_mismatches) and other_issues is a
// mapping; every other path is a leaf.
// ---------------------------------------------------------------------------------------------
const SCORECARD_LEAVES = new Set([
  "scorecard_version", "created_at", "k",
  "fingerprint.config.harness", "fingerprint.config.models.analyst", "fingerprint.config.models.critic", "fingerprint.config.caps", "fingerprint.config.seed", "fingerprint.config.package_version",
  "questions[].id", "questions[].n_repeats", "questions[].correct", "questions[].trap_recall.x", "questions[].trap_recall.n", "questions[].critic_precision.x", "questions[].critic_precision.n",
  "questions[].trap_handled", "questions[].unscored_passes", "questions[].unreviewed_trap_passes", "questions[].statistic_mismatches[].run_id", "questions[].statistic_mismatches[].statistic", "questions[].other_issues",
  "aggregate.score", "aggregate.se",
  "baseline.config_differences", "baseline.change", "baseline.se", "baseline.mde", "baseline.verdict", "baseline.left_out",
  "eval_id", "dropped",
  "runs[].run_id", "runs[].question_id", "runs[].status", "runs[].dataset.name", "runs[].dataset.source", "runs[].dataset.visibility", "runs[].dataset.licence", "runs[].models.harness",
]);
const OBJECT_PATHS = new Set([""]), ARRAY_PATHS = new Set();
for (const leaf of SCORECARD_LEAVES) {
  for (const m of leaf.matchAll(/\.|\[\]/g)) (m[0] === "." ? OBJECT_PATHS : ARRAY_PATHS).add(leaf.slice(0, m.index));
  for (const m of leaf.matchAll(/\[\]\./g)) OBJECT_PATHS.add(leaf.slice(0, m.index + 2));
}
const CAPS_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const VERDICTS = ["better", "worse", "no detectable change"];

// Every path in `value` that the table doesn't name, in F-001e's dotted notation, leaf by leaf.
function unknownPaths(value, path, out) {
  const child = (k) => (path ? `${path}.${k}` : k);
  if (SCORECARD_LEAVES.has(path)) return out;
  if (Array.isArray(value) && ARRAY_PATHS.has(path)) value.forEach((v) => unknownPaths(v, path + "[]", out));
  else if (isObj(value) && OBJECT_PATHS.has(path)) for (const [k, v] of Object.entries(value)) unknownPaths(v, child(k), out);
  else if (ARRAY_PATHS.has(path) || OBJECT_PATHS.has(path)) return out; // the wrong container type: the type checks name it
  else if (isObj(value) && Object.keys(value).length) for (const [k, v] of Object.entries(value)) unknownPaths(v, child(k), out);
  else if (Array.isArray(value) && value.length) value.forEach((v) => unknownPaths(v, path + "[]", out));
  else out.add(path);
  return out;
}

export function scorecardErrors(card, id) {
  if (!isObj(card)) return ["scorecard.json: must be a JSON object"];
  const e = [...unknownPaths(card, "", new Set())].sort().map((p) => `${p} is not in the scorecard types (a field F-001e drops, or one this site doesn't know)`);
  const need = (ok, path, what) => { if (!ok) e.push(`${path} must be ${what}`); };
  const intMin = (v, path, lo) => need(isInt(v) && v >= lo, path, `an integer >= ${lo}`);
  const obj = (v, path) => { need(isObj(v), path, "an object"); return isObj(v) ? v : {}; };

  need(typeof card.scorecard_version === "string" && MAJOR_1.test(card.scorecard_version), "scorecard_version", "a 1.x.y version");
  need(isUtc(card.created_at), "created_at", "a UTC timestamp ending in Z");
  intMin(card.k, "k", 1);
  const config = obj(obj(card.fingerprint, "fingerprint").config, "fingerprint.config");
  need(ENUMS.harness.includes(config.harness), "fingerprint.config.harness", `one of ${ENUMS.harness.join(", ")}`);
  const models = obj(config.models, "fingerprint.config.models");
  for (const r of ["analyst", "critic"]) need(isStr(models[r], 1, 200), `fingerprint.config.models.${r}`, "a string of 1 to 200 characters");
  need(isObj(config.caps) && Object.entries(config.caps).every(([k, v]) => CAPS_KEY.test(k) && (v === null || isNum(v))), "fingerprint.config.caps", "an object of cap names to numbers or null");
  intMin(config.seed, "fingerprint.config.seed", 0);
  need(Object.hasOwn(config, "package_version") && (config.package_version === null || isStr(config.package_version, 1, 64)), "fingerprint.config.package_version", "null or a string of 1 to 64 characters");

  const questions = Array.isArray(card.questions) ? card.questions : [];
  need(Array.isArray(card.questions) && questions.length >= 1 && questions.length <= 50, "questions", "an array of 1 to 50 entries");
  const ids = questions.map((q) => q?.id);
  need(new Set(ids).size === ids.length, "questions[].id", "unique");
  questions.forEach((q, i) => {
    const p = `questions[${i}]`;
    if (!isObj(q)) return e.push(`${p} must be an object`);
    need(typeof q.id === "string" && QUESTION_ID.test(q.id), `${p}.id`, "a question id");
    intMin(q.n_repeats, `${p}.n_repeats`, 1);
    const n = isInt(q.n_repeats) && q.n_repeats >= 1 ? q.n_repeats : null;
    for (const k of ["correct", "unscored_passes", "unreviewed_trap_passes"]) intMin(q[k], `${p}.${k}`, 0);
    if (n !== null && isInt(q.correct)) need(q.correct <= n, `${p}.correct`, "at most n_repeats");
    for (const k of ["trap_recall", "critic_precision"]) {
      const r = q[k];
      need(isObj(r) && isInt(r.x) && isInt(r.n) && r.x >= 0 && r.x <= r.n, `${p}.${k}`, "{x, n}, integers with 0 <= x <= n");
    }
    need(q.trap_handled === null || (isInt(q.trap_handled) && q.trap_handled >= 0 && (n === null || q.trap_handled <= n)), `${p}.trap_handled`, "null or an integer from 0 to n_repeats");
    need(Array.isArray(q.statistic_mismatches) && q.statistic_mismatches.every((m) => isObj(m) && typeof m.run_id === "string" && RUN_ID.test(m.run_id) && isStr(m.statistic, 1, 200)), `${p}.statistic_mismatches`, "an array of {run_id, statistic}");
    need(isObj(q.other_issues) && Object.entries(q.other_issues).every(([k, v]) => ENUMS.tag.includes(k) && isInt(v) && v >= 0), `${p}.other_issues`, "checklist tags mapped to integers >= 0");
  });

  const agg = obj(card.aggregate, "aggregate");
  need(isNum(agg.score) && agg.score >= 0 && agg.score <= 1, "aggregate.score", "a number from 0 to 1");
  need(Object.hasOwn(agg, "se") && (agg.se === null || (isNum(agg.se) && agg.se >= 0)), "aggregate.se", "null or a number >= 0");
  if (Object.hasOwn(card, "baseline")) {
    const b = obj(card.baseline, "baseline");
    need(Array.isArray(b.config_differences) && b.config_differences.every((s) => isStr(s, 1, 200)), "baseline.config_differences", "an array of strings of 1 to 200 characters");
    need(Object.hasOwn(b, "change") && (b.change === null || (isNum(b.change) && b.change >= -1 && b.change <= 1)), "baseline.change", "null or a number from -1 to 1");
    for (const k of ["se", "mde"]) need(Object.hasOwn(b, k) && (b[k] === null || (isNum(b[k]) && b[k] >= 0)), `baseline.${k}`, "null or a number >= 0");
    need(VERDICTS.includes(b.verdict), "baseline.verdict", `one of ${VERDICTS.join(", ")}`);
    need(Array.isArray(b.left_out) && b.left_out.every((x) => typeof x === "string" && QUESTION_ID.test(x)), "baseline.left_out", "an array of question ids");
  }

  need(typeof card.eval_id === "string" && EVAL_ID.test(card.eval_id), "eval_id", "an eval id (eval-YYYYMMDDTHHMMSSZ)");
  need(card.eval_id === id, "eval_id", "the export's id");
  const dropped = card.dropped;
  need(Array.isArray(dropped) && dropped.every((s) => typeof s === "string") && dropped.every((s, i) => i === 0 || dropped[i - 1] < s), "dropped", "an array of strings, sorted and unique");

  // runs[]: one entry per repeat. A null repeat (run_id null) has status null and no dataset or
  // models, and is skipped by the gate; every other one passes the D6 gate and names its harness.
  const runs = Array.isArray(card.runs) ? card.runs : [];
  need(Array.isArray(card.runs), "runs", "an array");
  runs.forEach((r, i) => {
    const p = `runs[${i}]`;
    if (!isObj(r)) return e.push(`${p} must be an object`);
    need(typeof r.question_id === "string" && QUESTION_ID.test(r.question_id) && ids.includes(r.question_id), `${p}.question_id`, "the id of a question in this scorecard");
    if (r.run_id === null) {
      need(r.status === null, `${p}.status`, "null for a null repeat");
      need(!Object.hasOwn(r, "dataset") && !Object.hasOwn(r, "models"), p, "without dataset or models (a null repeat)");
      return;
    }
    need(typeof r.run_id === "string" && RUN_ID.test(r.run_id), `${p}.run_id`, "null or a run id");
    need(ENUMS.status.includes(r.status), `${p}.status`, `one of ${ENUMS.status.join(", ")}`);
    e.push(...datasetErrors(r.dataset, `${p}.dataset`));
    need(isObj(r.models) && ENUMS.harness.includes(r.models.harness), `${p}.models.harness`, `one of ${ENUMS.harness.join(", ")} (every non-null repeat names its harness)`);
  });
  if (Array.isArray(card.runs) && !runs.some((r) => isObj(r) && r.run_id !== null)) e.push("runs must have at least one non-null repeat (D6)");
  for (const q of questions) {
    if (!isObj(q) || !isInt(q.n_repeats)) continue;
    const got = runs.filter((r) => isObj(r) && r.question_id === q.id).length;
    need(got === q.n_repeats, "runs", `one entry per repeat (question ${JSON.stringify(q.id)} has ${q.n_repeats}, runs has ${got})`);
  }
  return e.map((x) => "scorecard.json: " + x);
}

// ---------------------------------------------------------------------------------------------
// JSON.parse keeps the last of two equal keys, but what is published is the raw file: a report
// with a real dataset followed by a synthetic one would pass a check of the parsed value. So every
// JSON file this feature reads (report.json, scorecard.json, export.json, published.json) is
// parsed by JSON.parse for syntax and values, then scanned once more for a key repeated within one
// object (keys compared after unescaping). JSON.parse makes "__proto__" an ordinary own key.
// ---------------------------------------------------------------------------------------------
function duplicateKey(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i], top = stack[stack.length - 1];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (top?.keys && top.expectKey) {
        const k = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(k)) return k;
        top.keys.add(k);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push({ keys: null });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && top?.keys) top.expectKey = true;
  }
  return null;
}
export function parseJson(text) {
  const value = JSON.parse(text);
  const dup = duplicateKey(text);
  if (dup !== null) throw new Error(`duplicate key ${JSON.stringify(dup)} (JSON.parse would keep only the last one)`);
  return value;
}

// ---------------------------------------------------------------------------------------------
// The text checks every exported text file gets (report.json, report.md, scorecard.json, and
// published.json): SCAN_RULES, the employer denylist and .denylist.local, over the raw text and,
// for JSON, over every key and string value (so an escaped form in the raw text still hits).
// ---------------------------------------------------------------------------------------------
const strings = (v, out = []) => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
};
export function textErrors(name, text, ctx, doc) {
  const all = [text, ...(doc === undefined ? [] : strings(doc))];
  const e = [...new Set(all.flatMap(scanHits))].map((rule) => `${name} matches output scan rule ${rule}`);
  const employer = all.map(ctx.employerMention).find(Boolean);
  if (employer) e.push(`${name} names an employer: ${employer}`);
  if (ctx.denylist?.length && all.some((t) => denylistHit(t, ctx.denylist))) e.push(`${name} matches a term in .denylist.local`);
  return e;
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
const decode = (buf) => { try { return utf8.decode(buf); } catch { return null; } };
const readJson = (buf, name, e) => {
  const text = decode(buf);
  if (text === null) { e.push(`${name} is not valid UTF-8`); return {}; }
  try { return { text, doc: parseJson(text) }; } catch (x) { e.push(`${name} is not valid JSON (${x.message})`); return { text }; }
};
const fmt = (n) => n.toLocaleString("en-GB");

// The files of one run (path -> Buffer, export.json excluded), checked as the export contract, the
// field checks, the gate and the scan require. `id` is the export's id or the run's directory.
export function runFileErrors(id, files, ctx) {
  const e = [];
  let doc = null;
  if (!files.has("report.json")) e.push("report.json is missing");
  else {
    const r = readJson(files.get("report.json"), "report.json", e);
    if (r.doc !== undefined) {
      doc = r.doc;
      e.push(...reportErrors(doc));
      if (isObj(doc) && doc.run_id !== id) e.push(`report.json: run_id is not ${id}, the run it is published as`);
    }
    if (r.text !== undefined) e.push(...textErrors("report.json", r.text, ctx, r.doc));
  }
  if (!files.has("report.md")) e.push("report.md is missing");
  else {
    const md = decode(files.get("report.md"));
    if (md === null) e.push("report.md is not valid UTF-8");
    else {
      md.toLowerCase().split("\n").forEach((line, i) => { if (line.includes("![") || line.includes("<img")) e.push(`report.md line ${i + 1} has image syntax`); });
      e.push(...textErrors("report.md", md, ctx));
    }
  }
  const named = Array.isArray(doc?.figures) ? doc.figures.filter((f) => typeof f === "string") : [];
  let total = 0, count = 0;
  for (const [f, buf] of files) {
    if (f === "report.json" || f === "report.md") continue;
    if (!named.includes(f)) { e.push(`${f} is not a figure report.json names`); continue; }
    count++;
    total += buf.length;
    if (buf.length > LIMITS.figureBytes) e.push(`${f} is ${fmt(buf.length)} bytes, over ${fmt(LIMITS.figureBytes)}`);
    const png = pngCheck(buf);
    if (png.error) e.push(`${f} fails the PNG check: ${png.error}`);
  }
  for (const f of named) if (!files.has(f)) e.push(`${f} is named in report.json but not present`);
  if (count > LIMITS.figures) e.push(`${count} figures; at most ${LIMITS.figures}`);
  if (total > LIMITS.runFigureBytes) e.push(`${fmt(total)} bytes of figures, over ${fmt(LIMITS.runFigureBytes)} per run`);
  return e;
}

// The files of a scorecard: exactly scorecard.json, type-checked, gated and scanned.
export function scorecardFileErrors(id, files, ctx) {
  const e = [];
  for (const f of files.keys()) if (f !== "scorecard.json") e.push(`${f} is not part of a scorecard export`);
  if (!files.has("scorecard.json")) return [...e, "scorecard.json is missing"];
  const r = readJson(files.get("scorecard.json"), "scorecard.json", e);
  if (r.doc !== undefined) e.push(...scorecardErrors(r.doc, id));
  if (r.text !== undefined) e.push(...textErrors("scorecard.json", r.text, ctx, r.doc));
  return e;
}

// Read a file that must be a regular file, without following a link and without blocking on a
// FIFO: open with O_NOFOLLOW | O_NONBLOCK, check the open descriptor with fstat, read from it. With
// `single`, a file with more than one hard link is refused too (an export's files are its own).
export function readRegular(path, { single = false } = {}) {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    if (single && st.nlink > 1) throw new Error(`${path} is a hard link (${st.nlink} links); copy the file instead`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
const readExportFile = (path) => readRegular(path, { single: true });

// Walk a directory with lstat, never following a link: path -> Buffer for regular files (each read
// once, with `read`), and every directory; a symlink or any other entry is an error.
function walkFiles(dir, label, read, e, skip = () => false) {
  const files = new Map(), dirs = [];
  (function walk(rel) {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const f = rel ? `${rel}/${name}` : name;
      if (skip(f)) continue;
      const st = lstatSync(join(dir, f));
      if (st.isSymbolicLink()) e.push(`${label}${f} is a symlink; only regular files are accepted`);
      else if (st.isDirectory()) { dirs.push(f); walk(f); }
      else if (st.isFile()) {
        try { files.set(f, read(join(dir, f))); } catch (x) { e.push(`${label}${f} could not be read as a regular file: ${x.code === "ELOOP" ? "it is a symlink" : x.message.replace(join(dir, f), f)}`); }
      }
      else e.push(`${label}${f} is not a regular file (a FIFO, socket or device)`);
    }
  })("");
  return { files, dirs };
}

// ---------------------------------------------------------------------------------------------
// An export folder, as `research publish` writes it: export.json and the files it lists, every
// entry a regular file, each read once (the same Buffer is hashed, checked and copied). Returns
// { errors, id, digest, files, doc }; the digest is the sha256 of export.json's bytes.
// ---------------------------------------------------------------------------------------------
const EXPORT_KEYS = ["export_version", "kind", "id", "tool", "exported_at", "files"];
export function readExport(dir, kind, read = readExportFile) {
  const e = [];
  dir = dir.replace(/(?<=.)[\\/]+$/, ""); // "folder/" would make lstat follow a symlinked folder
  let st;
  try { st = lstatSync(dir); } catch { return { errors: [`export folder ${dir} not found`] }; }
  if (st.isSymbolicLink()) return { errors: [`export folder ${dir} is a symlink; pass the folder itself`] };
  if (!st.isDirectory()) return { errors: [`export folder ${dir} is not a directory`] };
  const { files, dirs } = walkFiles(dir, "export: ", read, e, (f) => f === "export.json");
  for (const d of dirs) if (![...files.keys()].some((f) => f.startsWith(d + "/"))) e.push(`export: ${d} is a directory with no files`);
  let raw;
  try {
    const s = lstatSync(join(dir, "export.json"));
    if (!s.isFile()) return { errors: [...e, "export: export.json is not a regular file"] };
  } catch { return { errors: [...e, "export: export.json is missing"] }; }
  try { raw = read(join(dir, "export.json")); } catch (x) { return { errors: [...e, `export: export.json could not be read as a regular file (${x.code ?? x.message})`] }; }
  const digest = sha256hex(raw);
  const pe = [];
  const { doc } = readJson(raw, "export.json", pe);
  if (pe.length) return { errors: [...e, ...pe.map((x) => "export: " + x)], digest };
  const need = (ok, what) => { if (!ok) e.push(`export: export.json ${what}`); };
  if (!isObj(doc)) return { errors: [...e, "export: export.json must be a JSON object"], digest };
  for (const k of Object.keys(doc)) need(EXPORT_KEYS.includes(k), `has an unknown key ${JSON.stringify(k)}`);
  need(typeof doc.export_version === "string" && MAJOR_1.test(doc.export_version), "export_version must be 1.x.y");
  need(doc.kind === kind, `kind must be "${kind}"`);
  need(typeof doc.id === "string" && (kind === "run" ? RUN_ID : EVAL_ID).test(doc.id), `id must be ${kind === "run" ? "a run id" : "an eval id"}`);
  need(isObj(doc.tool) && doc.tool.name === "research-agent", 'tool.name must be "research-agent"');
  need(isObj(doc.tool) && isStr(doc.tool.version, 1, 64) && Object.keys(doc.tool).every((k) => k === "name" || k === "version"), "tool.version must be a string of 1 to 64 characters (and tool has only name and version)");
  need(isUtc(doc.exported_at), "exported_at must be a UTC timestamp ending in Z");
  const listed = Array.isArray(doc.files) ? doc.files : [];
  need(Array.isArray(doc.files), "files must be an array");
  const paths = [];
  listed.forEach((x, i) => {
    if (!isObj(x) || Object.keys(x).sort().join() !== "bytes,path,sha256" || typeof x.path !== "string") return e.push(`export: export.json files[${i}] must be {path, sha256, bytes}`);
    paths.push(x.path);
    const allowed = kind === "run" ? x.path === "report.json" || x.path === "report.md" || FIGURE_PATH.test(x.path) : x.path === "scorecard.json";
    if (!allowed) return e.push(`export: export.json files[${i}].path ${JSON.stringify(x.path)} is not a path a ${kind} export may hold`);
    need(SHA256.test(x.sha256), `files[${i}].sha256 must be 64 lowercase hex digits`);
    need(isInt(x.bytes) && x.bytes >= 0, `files[${i}].bytes must be an integer`);
    const b = files.get(x.path);
    if (!b) return e.push(`export: ${x.path} is listed in export.json but missing`);
    need(sha256hex(b) === x.sha256, `files[${i}]: ${x.path} does not match its sha256`);
    need(b.length === x.bytes, `files[${i}]: ${x.path} does not match its bytes`);
  });
  need(new Set(paths).size === paths.length, "files has a duplicate path");
  need(paths.every((p, i) => i === 0 || paths[i - 1] <= p), "files must be sorted by path");
  for (const f of files.keys()) if (!paths.includes(f)) e.push(`export: ${f} is in the folder but not listed in export.json`);
  return { errors: e, id: doc.id, digest, files, doc };
}

// ---------------------------------------------------------------------------------------------
// The manifest (projects/research-agent/published.json) and the published tree it governs.
// ---------------------------------------------------------------------------------------------
export const MANIFEST = "projects/research-agent/published.json";
export const PROJECT = "projects/research-agent";
export const MAX_RUNS = 8;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_KEYS = ["checked", "export_digest", "tool_version", "exported_at", "role", "files", "alt"];
const SCORECARD_KEYS = ["eval_id", "checked", "export_digest", "tool_version", "exported_at", "files"];
export const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

// The manifest's own format: unknown keys, types and patterns. Returns errors naming MANIFEST.
function manifestErrors(m) {
  const e = [];
  const need = (ok, what) => { if (!ok) e.push(`${MANIFEST}: ${what}`); };
  if (!isObj(m)) return [`${MANIFEST}: must be a JSON object`];
  for (const k of Object.keys(m)) need(["manifest_version", "runs", "scorecard"].includes(k), `unknown key ${JSON.stringify(k)}`);
  need(typeof m.manifest_version === "string" && MAJOR_1.test(m.manifest_version), "manifest_version must be 1.x.y");
  if (!isObj(m.runs)) { e.push(`${MANIFEST}: "runs" must be an object keyed by run id`); return e; }
  const common = (x, where, keys) => {
    for (const k of Object.keys(x)) need(keys.includes(k), `${where} has an unknown key ${JSON.stringify(k)}`);
    need(isDate(x.checked), `${where}.checked must be a date (YYYY-MM-DD)`);
    need(typeof x.export_digest === "string" && SHA256.test(x.export_digest), `${where}.export_digest must be 64 lowercase hex digits`);
    need(isStr(x.tool_version, 1, 64), `${where}.tool_version must be a string of 1 to 64 characters`);
    need(isUtc(x.exported_at), `${where}.exported_at must be a UTC timestamp ending in Z`);
    need(isObj(x.files) && Object.values(x.files).every((h) => typeof h === "string" && SHA256.test(h)), `${where}.files must map each path to its sha256`);
  };
  for (const [id, run] of Object.entries(m.runs)) {
    const where = `runs.${id}`;
    need(RUN_ID.test(id), `${where}: the key must be a run id`);
    if (!isObj(run)) { e.push(`${MANIFEST}: ${where} must be an object`); continue; }
    common(run, where, RUN_KEYS);
    if (Object.hasOwn(run, "role")) need(ENUMS.role.includes(run.role), `${where}.role must be one of ${ENUMS.role.join(", ")}`);
    need(isObj(run.alt) && Object.values(run.alt).every((a) => typeof a === "string"), `${where}.alt must map each figure to its alt text`);
  }
  if (Object.hasOwn(m, "scorecard")) {
    const sc = m.scorecard;
    if (!isObj(sc)) e.push(`${MANIFEST}: scorecard must be an object`);
    else {
      common(sc, "scorecard", SCORECARD_KEYS);
      need(typeof sc.eval_id === "string" && EVAL_ID.test(sc.eval_id), "scorecard.eval_id must be an eval id");
    }
  }
  return e;
}

// The manifest as --record writes it: runs sorted by id, keys in the spec's order. Keys it doesn't
// know are kept (after the known ones), so the check that follows refuses them instead of them
// being dropped silently.
export function serializeManifest(m) {
  const order = (x, keys) => isObj(x) ? Object.fromEntries([...keys.filter((k) => Object.hasOwn(x, k)), ...Object.keys(x).filter((k) => !keys.includes(k))].map((k) => [k, x[k]])) : x;
  const runs = Object.fromEntries(Object.keys(m.runs).sort().map((id) => [id, order(m.runs[id], RUN_KEYS)]));
  const out = order({ ...m, runs, ...(Object.hasOwn(m, "scorecard") ? { scorecard: order(m.scorecard, SCORECARD_KEYS) } : {}) }, ["manifest_version", "runs", "scorecard"]);
  return JSON.stringify(out, null, 2) + "\n";
}

export function loadDenylist(root) {
  try { return parseDenylist(readFileSync(join(root, ".denylist.local"), "utf8")); } catch (x) { if (x.code === "ENOENT") return []; throw x; }
}

// Read what the build governs: published.json, and every file under runs/<id>/ and scorecard/ as a
// Buffer (lstat walk; links and other entries are errors). Also fails on any export.json under
// projects/ or public/: it is never committed or served.
export function readProjectsTree(root) {
  const t = { manifestText: null, runs: Object.create(null), runDirs: Object.create(null), scorecard: null, errors: [] };
  const exists = (f) => { try { lstatSync(join(root, f)); return true; } catch { return false; } };
  for (const d of ["projects", PROJECT]) {
    if (exists(d) && lstatSync(join(root, d)).isSymbolicLink()) { t.errors.push(`${d} is a symlink; the build refuses to follow it`); return t; }
  }
  for (const top of ["projects", "public"]) {
    if (!exists(top)) continue;
    (function walk(rel) {
      for (const name of readdirSync(join(root, rel))) {
        const f = `${rel}/${name}`, st = lstatSync(join(root, f));
        if (name === "export.json") t.errors.push(`${f}: export.json is never committed or served (the manifest records its digest); delete it`);
        if (st.isDirectory()) walk(f);
      }
    })(top);
  }
  if (exists(MANIFEST)) {
    if (!lstatSync(join(root, MANIFEST)).isFile()) t.errors.push(`${MANIFEST} is not a regular file`);
    else t.manifestText = readRegular(join(root, MANIFEST)).toString("utf8");
  }
  const sub = (rel) => {
    if (!exists(rel)) return null;
    const st = lstatSync(join(root, rel));
    if (!st.isDirectory()) { t.errors.push(`${rel} is not a directory`); return null; }
    return walkFiles(join(root, rel), rel + "/", readRegular, t.errors);
  };
  const runs = sub(`${PROJECT}/runs`);
  if (runs) {
    for (const [f, buf] of runs.files) {
      const [id, ...rest] = f.split("/");
      if (!rest.length) { t.errors.push(`${PROJECT}/runs/${f} is not in the manifest (only run directories belong in runs/)`); continue; }
      (t.runs[id] ??= new Map()).set(rest.join("/"), buf);
    }
    for (const d of runs.dirs) {
      const [id, ...rest] = d.split("/");
      t.runs[id] ??= new Map();
      if (rest.length) (t.runDirs[id] ??= []).push(rest.join("/"));
    }
  }
  const sc = sub(`${PROJECT}/scorecard`);
  if (sc) t.scorecard = sc.files;
  return t;
}

// Every check the build runs on the published tree (also run by --record on the would-be tree).
// ctx: { employerMention, denylist, pendingAlt } — pendingAlt is the run --record is adding, whose
// alt texts are still empty (the owner writes them next; the build then requires them).
export function checkProjects(t, ctx) {
  const e = [...t.errors];
  let m = { manifest_version: "1.0.0", runs: {} };
  if (t.manifestText !== null) {
    try { m = parseJson(t.manifestText); } catch (x) { return [...e, `${MANIFEST} is not valid JSON (${x.message})`]; }
    e.push(...manifestErrors(m));
    if (!isObj(m) || !isObj(m.runs)) return e;
    const n = Object.keys(m.runs).length;
    if (n > MAX_RUNS) e.push(`${MANIFEST} lists ${n} runs; at most ${MAX_RUNS} can be published (the _headers rule budget, F-005 D10)`);
    e.push(...textErrors(MANIFEST, t.manifestText, ctx, m));
  }
  const listedFiles = (entry, files, base) => {
    const listed = isObj(entry.files) ? entry.files : {};
    for (const [f, h] of Object.entries(listed)) {
      if (!files.has(f)) e.push(`${base}/${f} is listed in the manifest but missing`);
      else if (sha256hex(files.get(f)) !== h) e.push(`${base}/${f} does not match its sha256 in the manifest (re-read it, then --record --replace)`);
    }
    for (const f of files.keys()) if (!Object.hasOwn(listed, f)) e.push(`${base}/${f} is not in the manifest`);
  };
  for (const [id, files] of Object.entries(t.runs)) {
    if (!Object.hasOwn(m.runs, id)) for (const f of files.keys()) e.push(`${PROJECT}/runs/${id}/${f} is not in the manifest`);
  }
  for (const [id, run] of Object.entries(m.runs)) {
    if (!isObj(run)) continue;
    const base = `${PROJECT}/runs/${id}`, files = (Object.hasOwn(t.runs, id) && t.runs[id]) || new Map();
    listedFiles(run, files, base);
    e.push(...runFileErrors(id, files, ctx).map((x) => `${base}: ${x}`));
    const figures = Object.keys(isObj(run.files) ? run.files : {}).filter((f) => FIGURE_PATH.test(f));
    const alt = isObj(run.alt) ? run.alt : {};
    for (const f of figures) {
      if (!Object.hasOwn(alt, f) || typeof alt[f] !== "string") e.push(`${MANIFEST}: runs.${id}.alt has no entry for ${f}`);
      else if (!alt[f].trim() && ctx.pendingAlt !== id) e.push(`${MANIFEST}: runs.${id}.alt for ${f} is empty; write what the figure shows${ctx.pendingAlt ? ` (write run ${id}'s alt text before recording another)` : ""}`);
    }
    for (const f of Object.keys(alt)) if (!figures.includes(f)) e.push(`${MANIFEST}: runs.${id}.alt names ${f}, which isn't a listed figure`);
  }
  const scBase = `${PROJECT}/scorecard`;
  if (isObj(m.scorecard)) {
    const files = t.scorecard ?? new Map();
    listedFiles(m.scorecard, files, scBase);
    e.push(...scorecardFileErrors(m.scorecard.eval_id, files, ctx).map((x) => `${scBase}: ${x}`));
  } else if (t.scorecard) for (const f of t.scorecard.keys()) e.push(`${scBase}/${f} is not in the manifest`);
  return e;
}

// The published tree as the pages read it, once checkProjects has passed on it: each run's
// manifest entry, parsed report.json, report.md text, files and figures (in report.json order, with
// their IHDR size and alt text), and the scorecard. Strings are decoded from the checked Buffers.
export function publishedData(t) {
  const m = t.manifestText === null ? { runs: {} } : parseJson(t.manifestText);
  const runs = Object.entries(m.runs).map(([id, entry]) => {
    const files = t.runs[id];
    const doc = parseJson(files.get("report.json").toString("utf8"));
    const figures = doc.figures.map((path) => { const { width, height } = pngCheck(files.get(path)); return { path, width, height, alt: entry.alt[path] }; });
    return { id, entry, doc, md: files.get("report.md").toString("utf8"), files, figures };
  });
  const scorecard = isObj(m.scorecard) ? { entry: m.scorecard, doc: parseJson(t.scorecard.get("scorecard.json").toString("utf8")) } : null;
  return { runs, scorecard };
}
