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
