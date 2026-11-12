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

// ---- report.json fields, enumerations and the D6 gate ----
import { reportErrors, ENUMS } from "../lib/projects.mjs";
import { report } from "./projects-helpers.mjs";

const edit = (doc, fn) => { const d = structuredClone(doc); fn(d); return d; };
const rejected = (d) => { d.status = "rejected"; d.rejection = { reason: "The window is too short." }; d.review = { outcome: "not_reviewed", critic_calls: 0, open_issues: [] }; d.figures = []; d.answer = null; d.passes = []; d.final_call = null; d.summary.author = "system"; };
const capped = (d) => { d.status = "capped"; d.stop_reason = "run_tokens"; };
const failedNoPlan = (d) => { d.status = "failed"; d.stop_reason = "model_error"; d.plan = null; d.figures = []; d.review = { outcome: "not_reviewed", critic_calls: 0, open_issues: [] }; };

test("F-005 (US-2, D3): the fixture report passes, and so does one of each status", () => {
  assert.deepEqual(reportErrors(report()), []);
  for (const f of [rejected, capped, failedNoPlan]) assert.deepEqual(reportErrors(edit(report(), f)), [], f.name);
  assert.deepEqual(reportErrors(edit(report(), (d) => { d.schema_version = "1.4.0"; d.extra_minor_field = { any: 1 }; })), [], "a newer 1.x minor with extra fields is accepted");
});

test("F-005 (US-2, D3): every field the page reads is checked: missing or wrong-typed fails, per status", () => {
  const paths = ["schema_version", "run_id", "status", "question", "dataset", "dataset.name", "dataset.source", "dataset.visibility", "dataset.licence", "finished_at", "models", "models.harness", "plan", "plan.hypothesis", "plan.dataset", "plan.start", "plan.end", "plan.method", "plan.statistic", "plan.significance", "review", "review.outcome", "review.open_issues", "review.open_issues.0.tag", "review.open_issues.0.explanation", "summary", "summary.text", "summary.author", "figures", "figures.0"];
  const at = (d, p) => { const k = p.split("."); const last = k.pop(); return [k.reduce((o, x) => o[x], d), last]; };
  for (const p of paths) {
    assert.notDeepEqual(reportErrors(edit(report(), (d) => { const [o, k] = at(d, p); if (Array.isArray(o)) o.splice(+k, 1, 7); else delete o[k]; })), [], `missing ${p}`);
    assert.notDeepEqual(reportErrors(edit(report(), (d) => { const [o, k] = at(d, p); o[k] = 7; })), [], `wrong type ${p}`);
  }
  for (const p of ["question", "plan.hypothesis", "summary.text", "review.open_issues.0.explanation"]) {
    assert.notDeepEqual(reportErrors(edit(report(), (d) => { const [o, k] = at(d, p); o[k] = ""; })), [], `empty ${p}`);
  }
  assert.notDeepEqual(reportErrors(edit(report(), (d) => { d.finished_at = "2026-11-11T14:41:12+00:00"; })), [], "finished_at without Z");
  assert.notDeepEqual(reportErrors(edit(report(), (d) => { d.finished_at = "2026-02-30T14:41:12Z"; })), [], "an impossible date");
  assert.notDeepEqual(reportErrors(edit(report(), (d) => { d.plan.start = "2025-1-2"; })), [], "plan.start not a date");
  assert.notDeepEqual(reportErrors(edit(report(), (d) => { d.figures = [d.figures[0], d.figures[0]]; })), [], "duplicate figures");
  // Status-specific fields.
  assert.notDeepEqual(reportErrors(edit(report(), (d) => { rejected(d); delete d.rejection; })), [], "rejected without rejection");
  assert.notDeepEqual(reportErrors(edit(report(), (d) => { rejected(d); d.rejection.reason = ""; })), [], "rejected with an empty reason");
  assert.notDeepEqual(reportErrors(edit(report(), (d) => { rejected(d); d.plan = null; })), [], "rejected with no plan");
  for (const f of [capped, failedNoPlan]) {
    assert.notDeepEqual(reportErrors(edit(report(), (d) => { f(d); delete d.stop_reason; })), [], `${f.name} without stop_reason`);
    assert.notDeepEqual(reportErrors(edit(report(), (d) => { f(d); d.stop_reason = 3; })), [], `${f.name} with a wrong-typed stop_reason`);
  }
});

test("F-005 (US-2): summary.author \"human\" fails (F-001e refuses it too)", () => {
  assert.match(reportErrors(edit(report(), (d) => { d.summary.author = "human"; })).join(), /summary\.author/);
});

test("F-005 (D3): schema_version major other than 1 and a bad run_id pattern fail", () => {
  for (const v of ["2.0.0", "0.9.0", "1.0", "1.01.0"]) assert.match(reportErrors(edit(report(), (d) => { d.schema_version = v; })).join(), /schema_version/, v);
  for (const v of ["20261111T143000Z-A1B2C3", "20261111T143000Z-a1b2c", "2026-11-11-a1b2c3"]) assert.match(reportErrors(edit(report(), (d) => { d.run_id = v; })).join(), /run_id/, v);
});

test("F-005 (D3): the Enumerations table is the site's, and an unknown value in each enumerated report field fails", () => {
  assert.deepEqual(ENUMS, {
    status: ["completed", "rejected", "capped", "failed"],
    outcome: ["passed", "not_passed", "not_reviewed"],
    tag: ["look_ahead", "overlap_autocorrelation", "sample_size", "return_definition", "contract_roll", "timezone_session", "multiple_comparisons"],
    stop_reason: ["pass_tool_calls", "run_tool_calls", "run_tokens", "sandbox_unavailable", "dataset_unavailable", "access_denied", "run_not_owned", "invalid_model_output", "model_error", "internal_error", "abandoned", "unsanctioned_call", "run_mismatch", "missing_critique"],
    harness: ["langgraph", "claude-code"],
    author: ["model", "system"],
    role: ["trap_caught", "rejected_plan", "clean_pass"],
  });
  const cases = {
    status: (d) => { d.status = "paused"; },
    "review.outcome": (d) => { d.review.outcome = "skipped"; },
    "review.open_issues[].tag": (d) => { d.review.open_issues[0].tag = "survivorship"; },
    stop_reason: (d) => { capped(d); d.stop_reason = "out_of_time"; },
    "models.harness": (d) => { d.models.harness = "autogen"; },
    "summary.author": (d) => { d.summary.author = "editor"; },
  };
  for (const [field, f] of Object.entries(cases)) assert.notDeepEqual(reportErrors(edit(report(), f)), [], field);
});

test("F-005 (US-4, D6): the synthetic-only gate on a run: visibility, source and licence, with near-misses", () => {
  const gate = (f) => reportErrors(edit(report(), (d) => f(d.dataset))).filter((e) => /D6/.test(e));
  assert.deepEqual(gate(() => {}), []);
  assert.deepEqual(gate((s) => { s.source = "synthetic:research_agent.data.synth seed=0"; }), []);
  const fail = {
    "visibility private": (s) => { s.visibility = "private"; },
    "synthetic:other": (s) => { s.source = "synthetic:other"; },
    "no digits after seed=": (s) => { s.source = "synthetic:research_agent.data.synth seed="; },
    "a trailing space": (s) => { s.source = "synthetic:research_agent.data.synth seed=1 "; },
    "a trailing newline": (s) => { s.source = "synthetic:research_agent.data.synth seed=1\n"; },
    "an unescaped dot would match": (s) => { s.source = "synthetic:research_agentXdataXsynth seed=1"; },
    "a real dataset": (s) => { s.source = "databento:GLBX.MDP3"; },
    "licence differing only in case": (s) => { s.licence = "synthetic data, no restrictions"; },
    "licence with a trailing space": (s) => { s.licence = "Synthetic data, no restrictions "; },
  };
  for (const [what, f] of Object.entries(fail)) assert.notDeepEqual(gate(f), [], what);
});

// ---- Scorecard types (F-001e "Scorecard types", re-checked) and the scorecard gate ----
import { scorecardErrors } from "../lib/projects.mjs";
import { scorecard, EVAL_ID } from "./projects-helpers.mjs";

const withBaseline = (d) => { d.baseline = { config_differences: ["fingerprint.config.models.analyst"], change: 0.1, se: 0.05, mde: 0.12, verdict: "no detectable change", left_out: ["roll-gap"] }; };
const card = (f) => edit(scorecard(), f);
const cardErrors = (f, id = EVAL_ID) => scorecardErrors(card(f), id);

test("F-005 (US-2, D3): the fixture scorecard passes, with and without a baseline", () => {
  assert.deepEqual(scorecardErrors(scorecard(), EVAL_ID), []);
  assert.deepEqual(cardErrors(withBaseline), []);
  assert.deepEqual(cardErrors((d) => { withBaseline(d); d.baseline.verdict = "better"; d.baseline.left_out = []; d.baseline.config_differences = []; }), []);
});

test("F-005 (US-2, D3): each nullable row accepts null", () => {
  const ok = {
    "fingerprint.config.package_version": (d) => { d.fingerprint.config.package_version = null; },
    "questions[].trap_handled": (d) => { d.questions[1].trap_handled = null; },
    "aggregate.se": (d) => { d.aggregate.se = null; },
    "baseline.change": (d) => { withBaseline(d); d.baseline.change = null; },
    "baseline.se": (d) => { withBaseline(d); d.baseline.se = null; },
    "baseline.mde": (d) => { withBaseline(d); d.baseline.mde = null; },
    "a null value in fingerprint.config.caps": (d) => { d.fingerprint.config.caps.pass_tool_calls = null; },
    "a null repeat": (d) => { d.runs[0] = { run_id: null, question_id: "open-vol", status: null }; },
  };
  for (const [row, f] of Object.entries(ok)) assert.deepEqual(cardErrors(f), [], row);
});

test("F-005 (US-2, D3): each row of the scorecard types table refuses a wrong type", () => {
  const q = (d) => d.questions[1];
  const bad = {
    scorecard_version: [(d) => { d.scorecard_version = 1; }, (d) => { d.scorecard_version = "2.0.0"; }, (d) => { delete d.scorecard_version; }],
    created_at: [(d) => { d.created_at = "2026-11-11"; }, (d) => { d.created_at = "2026-11-11T15:00:00+00:00"; }],
    k: [(d) => { d.k = 0; }, (d) => { d.k = true; }, (d) => { d.k = 1.5; }, (d) => { d.k = "2"; }],
    "fingerprint.config.harness": [(d) => { d.fingerprint.config.harness = "autogen"; }, (d) => { delete d.fingerprint.config.harness; }],
    "fingerprint.config.models.analyst": [(d) => { d.fingerprint.config.models.analyst = ""; }, (d) => { d.fingerprint.config.models.analyst = "x".repeat(201); }],
    "fingerprint.config.models.critic": [(d) => { d.fingerprint.config.models.critic = 3; }],
    "fingerprint.config.caps": [(d) => { d.fingerprint.config.caps = { Run_tokens: 1 }; }, (d) => { d.fingerprint.config.caps = { a: true }; }, (d) => { d.fingerprint.config.caps = { a: "1" }; }, (d) => { d.fingerprint.config.caps = { a: {} }; }, (d) => { d.fingerprint.config.caps = [1]; }],
    "fingerprint.config.seed": [(d) => { d.fingerprint.config.seed = -1; }, (d) => { d.fingerprint.config.seed = "42"; }],
    "fingerprint.config.package_version": [(d) => { d.fingerprint.config.package_version = "x".repeat(65); }, (d) => { d.fingerprint.config.package_version = ""; }, (d) => { delete d.fingerprint.config.package_version; }],
    questions: [(d) => { d.questions = []; }, (d) => { d.questions[1].id = "open-vol"; }, (d) => { d.questions = Array.from({ length: 51 }, (_, i) => ({ ...d.questions[0], id: `q${i}` })); }],
    "questions[].id": [(d) => { q(d).id = "Roll-gap"; }],
    "questions[].n_repeats": [(d) => { q(d).n_repeats = 0; }],
    "questions[].correct": [(d) => { q(d).correct = -1; }, (d) => { q(d).correct = 3; }],
    "questions[].unscored_passes": [(d) => { q(d).unscored_passes = -1; }],
    "questions[].unreviewed_trap_passes": [(d) => { q(d).unreviewed_trap_passes = "0"; }],
    "questions[].trap_recall": [(d) => { q(d).trap_recall.x = 3; }, (d) => { q(d).trap_recall.n = -1; }, (d) => { delete q(d).trap_recall.n; }],
    "questions[].critic_precision": [(d) => { q(d).critic_precision.x = "1"; }, (d) => { q(d).critic_precision = null; }],
    "questions[].trap_handled": [(d) => { q(d).trap_handled = 3; }, (d) => { q(d).trap_handled = -1; }],
    "questions[].statistic_mismatches": [(d) => { q(d).statistic_mismatches = [{ run_id: "bad", statistic: "x" }]; }, (d) => { q(d).statistic_mismatches = [{ run_id: "20261111T141000Z-1a1b1c" }]; }, (d) => { q(d).statistic_mismatches = {}; }],
    "questions[].other_issues": [(d) => { q(d).other_issues = { survivorship: 1 }; }, (d) => { q(d).other_issues = { sample_size: -1 }; }],
    "aggregate.score": [(d) => { d.aggregate.score = 1.5; }, (d) => { d.aggregate.score = null; }],
    "aggregate.se": [(d) => { d.aggregate.se = -0.1; }],
    "baseline.config_differences": [(d) => { withBaseline(d); d.baseline.config_differences = [""]; }],
    "baseline.change": [(d) => { withBaseline(d); d.baseline.change = 1.5; }],
    "baseline.se": [(d) => { withBaseline(d); d.baseline.se = -1; }],
    "baseline.mde": [(d) => { withBaseline(d); d.baseline.mde = "x"; }],
    "baseline.verdict": [(d) => { withBaseline(d); d.baseline.verdict = "same"; }, (d) => { withBaseline(d); delete d.baseline.verdict; }],
    "baseline.left_out": [(d) => { withBaseline(d); d.baseline.left_out = ["Roll gap"]; }],
    eval_id: [(d) => { d.eval_id = "eval-2026"; }],
    dropped: [(d) => { d.dropped = ["b", "a"]; }, (d) => { d.dropped = ["a", "a"]; }, (d) => { d.dropped = [1]; }, (d) => { delete d.dropped; }],
    runs: [(d) => { d.runs = {}; }, (d) => { d.runs.pop(); }],
    "runs[].run_id": [(d) => { d.runs[0].run_id = "bad"; }],
    "runs[].question_id": [(d) => { d.runs[0].question_id = "Open-vol"; }, (d) => { d.runs[0].question_id = "other-question"; }],
    "runs[].status": [(d) => { d.runs[0].status = null; }, (d) => { d.runs[2].status = "completed"; }, (d) => { d.runs[0].status = "paused"; }],
    "runs[].dataset": [(d) => { d.runs[0].dataset.name = "Synth"; }, (d) => { d.runs[0].dataset.source = "s".repeat(201); }, (d) => { d.runs[0].dataset.visibility = "secret"; }, (d) => { d.runs[0].dataset.licence = ""; }, (d) => { d.runs[2].dataset = d.runs[0].dataset; }],
    "runs[].models.harness": [(d) => { d.runs[0].models.harness = "autogen"; }, (d) => { d.runs[2].models = { harness: "langgraph" }; }],
  };
  for (const [row, fs] of Object.entries(bad)) fs.forEach((f, i) => assert.notDeepEqual(cardErrors(f), [], `${row} #${i}`));
});

test("F-005 (US-2, D3): each field F-001e drops by default fails when present, and so does any unknown path", () => {
  const dropped = {
    "fingerprint.sha256": (d) => { d.fingerprint.sha256 = "0".repeat(64); },
    "fingerprint.config.git.commit": (d) => { d.fingerprint.config.git = { commit: "0".repeat(40) }; },
    "fingerprint.config.git.dirty": (d) => { d.fingerprint.config.git = { dirty: false }; },
    "fingerprint.config.prompts": (d) => { d.fingerprint.config.prompts = { analyst: "0".repeat(64) }; },
    "fingerprint.config.questions_sha256": (d) => { d.fingerprint.config.questions_sha256 = "0".repeat(64); },
    "baseline.fingerprint": (d) => { withBaseline(d); d.baseline.fingerprint = { sha256: "0".repeat(64) }; },
    "questions[].run_ids": (d) => { d.questions[0].run_ids = ["20261111T140000Z-0a0b0c", "20261111T140500Z-0d0e0f"]; },
  };
  for (const [path, f] of Object.entries(dropped)) assert.ok(cardErrors(f).some((e) => e.includes(path)), `${path}: ${cardErrors(f).join("\n")}`);
  const unknown = {
    "a new top-level field": (d) => { d.notes = "x"; },
    "a new question field": (d) => { d.questions[0].difficulty = 3; },
    "a new key in a statistic mismatch": (d) => { d.questions[1].statistic_mismatches[0].value = 1; },
    "a new key in a repeat": (d) => { d.runs[0].finished_at = "2026-11-11T14:41:12Z"; },
    "a new key in a repeat's models": (d) => { d.runs[0].models.analyst = "example:analyst-model"; },
    "a new key in aggregate": (d) => { d.aggregate.n = 4; },
  };
  for (const [what, f] of Object.entries(unknown)) assert.match(cardErrors(f).join("\n"), /not in the scorecard types/, what);
});

test("F-005 (D3): the scorecard's eval_id must equal the export id", () => {
  assert.match(scorecardErrors(scorecard(), "eval-20261111T160000Z").join(), /eval_id/);
});

test("F-005 (US-4, D6): the scorecard gate: no non-null repeat, a non-null repeat on a non-synthetic dataset, or one without models.harness fails; a null repeat is skipped", () => {
  const gate = (f) => cardErrors(f).filter((e) => /D6|non-null|models\.harness/.test(e));
  assert.deepEqual(gate(() => {}), []);
  assert.deepEqual(gate((d) => { d.runs[1] = { run_id: null, question_id: "open-vol", status: null }; }), [], "a null repeat is skipped");
  assert.notDeepEqual(gate((d) => { d.runs = d.runs.map((r) => ({ run_id: null, question_id: r.question_id, status: null })); }), [], "every repeat null");
  for (const [field, v] of [["visibility", "private"], ["source", "synthetic:other"], ["source", "synthetic:research_agent.data.synth seed="], ["source", "synthetic:research_agent.data.synth seed=1 "], ["licence", "synthetic data, no restrictions"]]) {
    assert.notDeepEqual(gate((d) => { d.runs[3].dataset[field] = v; }), [], `${field}=${JSON.stringify(v)}`);
  }
  assert.notDeepEqual(gate((d) => { delete d.runs[1].models; }), [], "no models");
  assert.notDeepEqual(gate((d) => { delete d.runs[1].models.harness; }), [], "no models.harness");
});
