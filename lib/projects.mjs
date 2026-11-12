// F-005: the research-agent showcase's export contract and its checks — the manifest
// (projects/research-agent/published.json), the export folders `research publish` writes, the PNG
// check, the report.json field and enumeration checks, the scorecard type re-check, the D6
// synthetic-only gate, and the output scan (F-001e's SCAN_RULES, the employer denylist and the
// optional local denylist). Used by build.mjs for every build and by --record before it writes.
// Every check names a file and a rule, never the matched text.

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
