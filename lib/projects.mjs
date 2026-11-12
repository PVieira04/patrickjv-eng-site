// F-005: the research-agent showcase's export contract and its checks — the manifest
// (projects/research-agent/published.json), the export folders `research publish` writes, the PNG
// check, the report.json field and enumeration checks, the scorecard type re-check, the D6
// synthetic-only gate, and the output scan (F-001e's SCAN_RULES, the employer denylist and the
// optional local denylist). Used by build.mjs for every build and by --record before it writes.
// Every check names a file and a rule, never the matched text.

import { crc32 } from "node:zlib";

// ---------------------------------------------------------------------------------------------
// Output scan. F-001e's SCAN_RULES are normative: exactly these names and patterns (Python `re`
// syntax, the same in JavaScript). One difference is accepted: JavaScript's \w and \b are ASCII
// where Python's are Unicode, which can only make a rule here match more, never less.
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
export const scanHits = (text) => COMPILED.filter(([, re]) => re.test(text)).map(([name]) => name);

// The local denylist (.denylist.local), in F-001e's "Denylist format": UTF-8, one term per line,
// each stripped; blank lines and lines starting with # skipped. A file with no terms checks nothing.
export const parseDenylist = (text) => text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
// Whether any term appears, case-insensitively, touching no word character on either side:
// (?<!\w) term (?!\w), with \w Unicode-aware as in Python.
const reEscape = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
export const denylistHit = (text, terms) => terms.some((t) => new RegExp(`(?<![\\p{L}\\p{N}_])${reEscape(t)}(?![\\p{L}\\p{N}_])`, "iu").test(text));

// ---------------------------------------------------------------------------------------------
// PNG check (D3): the signature, then whole chunks with correct CRCs, every type on the allow-list,
// exactly one IHDR, first, of length 13, with width and height 1 to 4,096; at least one IDAT; PLTE
// before the first IDAT; IEND last with nothing after it. Returns { width, height } or { error }.
// Figures are never text-scanned: the allow-list is what keeps text chunks out of them.
// ---------------------------------------------------------------------------------------------
export const MAX_SIDE = 4096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "pHYs", "bKGD"]);
export function pngCheck(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { error: "not a PNG (bad signature)" };
  const seen = [];
  let pos = 8, width, height;
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
      if (width < 1 || width > MAX_SIDE || height < 1 || height > MAX_SIDE) return { error: `${width} x ${height} pixels; each side must be 1 to ${MAX_SIDE}` };
    }
    if (type === "PLTE" && seen.includes("IDAT")) return { error: "PLTE comes after IDAT" };
    seen.push(type);
    pos += 12 + len;
    if (type === "IEND") {
      if (pos !== buf.length) return { error: "data after IEND" };
      if (!seen.includes("IDAT")) return { error: "no IDAT chunk" };
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
  else enumOf(doc.models.harness, ENUMS.harness, "models.harness");
  if (doc.plan === null) need(doc.status !== "rejected", "plan", "present for a rejected run");
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
  if (doc.status === "rejected") need(isObj(doc.rejection) && isStr(doc.rejection.reason), "rejection.reason", "a non-empty string for a rejected run");
  if (doc.status === "capped" || doc.status === "failed") enumOf(doc.stop_reason, ENUMS.stop_reason, "stop_reason");
  return e.map((x) => "report.json: " + x);
}
