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
import { png, chunk, ihdr, pixels, SIGNATURE } from "./projects-helpers.mjs";
import { deflateSync } from "node:zlib";

test("F-005 (D3): a valid PNG passes the PNG check and reports its IHDR size; 4096 x 4096 passes", () => {
  assert.deepEqual(pngCheck(png()), { width: 4, height: 3 });
  assert.deepEqual(pngCheck(png({ width: 4096, height: 4096, depth: 1, colour: 0 })), { width: 4096, height: 4096 });
  const allowed = [["PLTE", 3], ["tRNS", 1], ["gAMA", 4], ["cHRM", 32], ["sRGB", 1], ["pHYs", 9], ["bKGD", 1]].map(([t, n]) => chunk(t, Buffer.alloc(n)));
  assert.equal(pngCheck(png({ extra: allowed })).error, undefined, "every allow-listed chunk type, at its length, passes");
  for (const [t, ns] of Object.entries({ bKGD: [1, 2, 6], tRNS: [1, 256], PLTE: [3, 768] })) for (const n of ns) assert.equal(pngCheck(png({ extra: [chunk(t, Buffer.alloc(n))] })).error, undefined, `${t} of ${n}`);
  for (const [depth, colour] of [[1, 0], [2, 0], [4, 0], [16, 0], [16, 2], [1, 3], [2, 3], [4, 3], [8, 3], [8, 4], [16, 4], [8, 6], [16, 6]]) {
    assert.equal(pngCheck(png({ depth, colour })).error, undefined, `depth ${depth}, colour ${colour}`);
  }
  assert.equal(pngCheck(png({ header: { interlace: 1 }, idat: deflateSync(Buffer.alloc(30)) })).error, undefined, "Adam7 interlace");
  const split = pixels(4, 3);
  assert.equal(pngCheck(Buffer.concat([SIGNATURE, ihdr(4, 3), chunk("IDAT", split.subarray(0, 5)), chunk("IDAT", split.subarray(5)), chunk("IEND")])).error, undefined, "IDAT split across chunks");
});

test("F-005 (D3): as F-001e's chunk filter: fixed or bounded lengths, at most once each, a valid IHDR, and IDAT exactly one zlib stream", () => {
  const bad = {
    "gAMA of 3": [chunk("gAMA", Buffer.alloc(3))], "cHRM of 31": [chunk("cHRM", Buffer.alloc(31))], "sRGB of 2": [chunk("sRGB", Buffer.alloc(2))],
    "pHYs of 8": [chunk("pHYs", Buffer.alloc(8))], "bKGD of 3": [chunk("bKGD", Buffer.alloc(3))], "bKGD of 0": [chunk("bKGD")],
    "tRNS of 0": [chunk("tRNS")], "tRNS of 257": [chunk("tRNS", Buffer.alloc(257))],
    "PLTE of 0": [chunk("PLTE")], "PLTE of 4": [chunk("PLTE", Buffer.alloc(4))], "PLTE of 771": [chunk("PLTE", Buffer.alloc(771))],
    "two gAMA": [chunk("gAMA", Buffer.alloc(4)), chunk("gAMA", Buffer.alloc(4))], "two PLTE": [chunk("PLTE", Buffer.alloc(3)), chunk("PLTE", Buffer.alloc(3))],
    "two tRNS": [chunk("tRNS", Buffer.alloc(1)), chunk("tRNS", Buffer.alloc(1))],
  };
  for (const [what, extra] of Object.entries(bad)) assert.equal(typeof pngCheck(png({ extra })).error, "string", what);
  for (const [what, header] of Object.entries({ "depth 3": { depth: 3 }, "16-bit palette": { depth: 16, colour: 3 }, "colour type 1": { colour: 1 }, "colour type 7": { colour: 7 }, "4-bit RGB": { depth: 4 }, "compression 1": { compression: 1 }, "filter 1": { filter: 1 }, "interlace 2": { interlace: 2 } })) {
    assert.equal(typeof pngCheck(Buffer.concat([SIGNATURE, ihdr(4, 3, header), chunk("IDAT", pixels(4, 3)), chunk("IEND")])).error, "string", what);
  }
  const z = pixels(4, 3);
  for (const [what, idat] of Object.entries({
    "not zlib": Buffer.from([1, 2, 3]), "a truncated stream": z.subarray(0, z.length - 3), "trailing bytes after the stream": Buffer.concat([z, Buffer.from([0])]),
    "two streams": Buffer.concat([z, z]), "inflates past the raw size": deflateSync(Buffer.alloc(39 + 1025)),
  })) assert.equal(typeof pngCheck(png({ idat })).error, "string", what);
  assert.equal(pngCheck(png({ idat: deflateSync(Buffer.alloc(39 + 1024)) })).error, undefined, "within the raw size (3 rows of 1 + 12 bytes) plus F-001e's 1,024 bytes of slack");
});

test("F-005 (D3): the PNG check refuses each malformed or disallowed case", () => {
  const good = png();
  const iend = chunk("IEND"), idat = chunk("IDAT", pixels(4, 3));
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
    "a width of 4097": png({ width: 4097, height: 1 }),
    "a height of 4097": png({ height: 4097, width: 1 }),
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
import { scorecard, EVAL_ID, FIXTURES } from "./projects-helpers.mjs";

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

// ---- --record and --record-scorecard: the export contract, and every check before any write ----
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { record } from "../build.mjs";
import { writeExport, runFiles, scorecardFiles, dump, sha, pngOfSize, RUN_ID, readTree } from "./projects-helpers.mjs";

const MANIFEST = "projects/research-agent/published.json";
const TODAY = "2026-11-12";
// A scratch site root (only projects/ matters to --record) and a scratch export folder.
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "site-record-"));
  const root = join(base, "site"), dir = join(base, "export");
  mkdirSync(root);
  return { base, root, dir, done: () => rmSync(base, { recursive: true, force: true }) };
}
// Every file under a directory, path -> bytes (as hex), so "wrote nothing" compares the whole tree.
const snapshot = (dir) => existsSync(dir) ? Object.fromEntries(Object.entries(readTree(dir)).map(([f, b]) => [f, b.toString("hex")])) : {};
const reportWith = (f) => dump(edit(report(), f));
const runExport = (dir, { files: over = {}, ...opts } = {}) => writeExport(dir, { files: { ...runFiles(), ...over }, ...opts });
const manifestOf = (root) => JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
// The owner's step after --record: write every figure's alt text (the build refuses it empty).
const writeAlt = (root) => {
  const m = manifestOf(root);
  for (const run of Object.values(m.runs)) for (const f of Object.keys(run.alt)) run.alt[f] ||= "A synthetic chart.";
  writeFileSync(join(root, MANIFEST), JSON.stringify(m, null, 2) + "\n");
};

// Run --record and require it to fail, naming `pattern`, with the site root unchanged.
function refuses(s, args, pattern) {
  const before = snapshot(s.root);
  const r = record({ root: s.root, today: TODAY, ...args });
  assert.ok(r.errors.some((e) => pattern.test(e)), `expected ${pattern}, got:\n${r.errors.join("\n")}`);
  assert.deepEqual(snapshot(s.root), before, "nothing written");
}

test("F-005 (US-4, D2, D3): --record copies exactly report.json, report.md and the named figures, byte for byte, and adds the run to published.json", () => {
  const s = sandbox();
  try {
    const expect = runExport(s.dir);
    const r = record({ root: s.root, dir: s.dir, expect, today: TODAY });
    assert.deepEqual(r.errors, []);
    const base = join(s.root, "projects/research-agent/runs", RUN_ID);
    const exported = runFiles();
    assert.deepEqual(Object.keys(readTree(base)).sort(), Object.keys(exported).sort());
    for (const [f, b] of Object.entries(exported)) assert.ok(readFileSync(join(base, f)).equals(b), f);
    assert.ok(!existsSync(join(base, "export.json")), "export.json is never written");
    assert.deepEqual(manifestOf(s.root), {
      manifest_version: "1.0.0",
      runs: { [RUN_ID]: {
        checked: TODAY, export_digest: expect, tool_version: "0.1.0", exported_at: "2026-11-11T15:04:05Z",
        files: Object.fromEntries(Object.keys(exported).sort().map((f) => [f, sha(exported[f])])),
        alt: { "calls/1/out/vol_by_minute.png": "" },
      } },
    });
  } finally { s.done(); }
});

test("F-005 (D3): a figure that isn't valid UTF-8 and holds \\r\\n round-trips byte-identical from the export to projects/", () => {
  const s = sandbox();
  try {
    // A stored (level 0) zlib stream keeps these bytes as they are inside the IDAT.
    const fig = png({ idat: deflateSync(Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x0d, 0x0a, 0x00, 0x80, 0x0d, 0x0a]), { level: 0 }) });
    assert.ok(fig.includes(Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x0d, 0x0a])));
    assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(fig));
    const expect = runExport(s.dir, { files: { "calls/1/out/vol_by_minute.png": fig } });
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect, today: TODAY }).errors, []);
    assert.ok(readFileSync(join(s.root, "projects/research-agent/runs", RUN_ID, "calls/1/out/vol_by_minute.png")).equals(fig));
  } finally { s.done(); }
});

test("F-005 (US-4, D2): --record reads each export file once, and writes the bytes it hashed", () => {
  const s = sandbox();
  try {
    const expect = runExport(s.dir);
    const reads = {};
    const read = (f) => { reads[f] = (reads[f] ?? 0) + 1; return readFileSync(f); };
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect, today: TODAY, read }).errors, []);
    assert.deepEqual(Object.keys(reads).map((f) => f.slice(s.dir.length + 1).replaceAll("\\", "/")).sort(), ["calls/1/out/vol_by_minute.png", "export.json", "report.json", "report.md"]);
    assert.ok(Object.values(reads).every((n) => n === 1), JSON.stringify(reads));
  } finally { s.done(); }
});

test("F-005 (US-4, D2): --record fails, writing nothing, on a digest mismatch or a missing --expect", () => {
  const s = sandbox();
  try {
    runExport(s.dir);
    refuses(s, { dir: s.dir, expect: "0".repeat(64) }, /digest/);
    refuses(s, { dir: s.dir }, /--expect/);
    refuses(s, { dir: s.dir, expect: "not-a-digest" }, /--expect/);
  } finally { s.done(); }
});

test("F-005 (US-4, D2): --record fails, writing nothing, on a symlink, FIFO or directory where a file is expected", { skip: process.platform === "win32" && "no FIFOs or unprivileged symlinks on Windows" }, () => {
  const s = sandbox();
  try {
    let expect = runExport(s.dir);
    rmSync(join(s.dir, "report.md"));
    symlinkSync(join(s.base, "elsewhere.md"), join(s.dir, "report.md"));
    writeFileSync(join(s.base, "elsewhere.md"), runFiles()["report.md"]);
    refuses(s, { dir: s.dir, expect }, /report\.md.*symlink/);
    expect = runExport(s.dir);
    execFileSync("mkfifo", [join(s.dir, "pipe")]);
    refuses(s, { dir: s.dir, expect }, /pipe.*not a regular file/);
    expect = runExport(s.dir);
    rmSync(join(s.dir, "report.md"));
    mkdirSync(join(s.dir, "report.md"));
    refuses(s, { dir: s.dir, expect }, /report\.md/);
    expect = runExport(s.dir);
    rmSync(s.dir, { recursive: true });
    mkdirSync(join(s.base, "real"));
    runExport(join(s.base, "real"));
    symlinkSync(join(s.base, "real"), s.dir);
    refuses(s, { dir: s.dir, expect }, /symlink/);
  } finally { s.done(); }
});

test("F-005 (US-4, D2): --record fails, writing nothing, on each export.json contract failure", () => {
  const s = sandbox();
  try {
    const cases = [
      ["an extra file", () => { const d = runExport(s.dir); writeFileSync(join(s.dir, "notes.txt"), "x"); return d; }, /notes\.txt.*not listed/],
      ["a missing file", () => { const d = runExport(s.dir); rmSync(join(s.dir, "report.md")); return d; }, /report\.md.*missing/],
      ["a sha256 mismatch", () => runExport(s.dir, { edit: (x) => { x.files[1].sha256 = "0".repeat(64); } }), /report\.json.*sha256/],
      ["a bytes mismatch", () => runExport(s.dir, { edit: (x) => { x.files[1].bytes += 1; } }), /report\.json.*bytes/],
      ["unsorted files", () => runExport(s.dir, { edit: (x) => { x.files.reverse(); } }), /sorted/],
      ["duplicate files", () => runExport(s.dir, { edit: (x) => { x.files.splice(1, 0, x.files[1]); } }), /duplicate/],
      ["a wrong kind", () => runExport(s.dir, { edit: (x) => { x.kind = "scorecard"; } }), /kind/],
      ["an export_version major other than 1", () => runExport(s.dir, { edit: (x) => { x.export_version = "2.0.0"; } }), /export_version/],
      ["another tool", () => runExport(s.dir, { edit: (x) => { x.tool.name = "other-agent"; } }), /tool\.name/],
      ["exported_at without Z", () => runExport(s.dir, { edit: (x) => { x.exported_at = "2026-11-11T15:04:05+00:00"; } }), /exported_at/],
      ["an unknown key", () => runExport(s.dir, { edit: (x) => { x.checked = true; } }), /export\.json.*checked/],
      ["export.json not JSON", () => runExport(s.dir, { raw: "{" }), /export\.json/],
      ["no export.json", () => { runExport(s.dir); rmSync(join(s.dir, "export.json")); return "0".repeat(64); }, /export\.json/],
      ["an id that doesn't match the folder's report", () => runExport(s.dir, { id: "20261111T143000Z-ffffff", edit: (x) => { x.id = "20261111T143000Z-ffffff"; } }), /run_id/],
      ["a bad run id pattern", () => runExport(s.dir, { edit: (x) => { x.id = "run-1"; } }), /id/],
      ["a bad figure path", () => runExport(s.dir, { files: { "calls/0/out/x.png": png(), "report.json": reportWith((d) => { d.figures = ["calls/0/out/x.png"]; }) } }), /figure/],
      ["a figure report.json doesn't name", () => runExport(s.dir, { files: { "calls/2/out/extra.png": png() } }), /calls\/2\/out\/extra\.png/],
      ["a figure report.json names that isn't there", () => runExport(s.dir, { files: { "report.json": reportWith((d) => { d.figures.push("calls/2/out/gone.png"); }) } }), /calls\/2\/out\/gone\.png/],
      ["a failed PNG check", () => runExport(s.dir, { files: { "calls/1/out/vol_by_minute.png": png({ extra: [chunk("tEXt", Buffer.from("k\0v"))] }) } }), /PNG|tEXt/],
      ["report.md with image syntax", () => runExport(s.dir, { files: { "report.md": "# Research report\n\n![a](calls/1/out/x.png)\n" } }), /report\.md.*image/],
      ["report.md not UTF-8", () => runExport(s.dir, { files: { "report.md": Buffer.from([0x23, 0x20, 0xff, 0x0a]) } }), /report\.md.*UTF-8/],
    ];
    for (const [what, make, pattern] of cases) {
      const expect = make();
      try { refuses(s, { dir: s.dir, expect }, pattern); } catch (e) { e.message = `${what}: ${e.message}`; throw e; }
    }
  } finally { s.done(); }
});

test("F-005 (D3): patterns and limits — 20 figures, 204,800 bytes and 1,048,576 bytes per run pass; one more of each fails", () => {
  const s = sandbox();
  try {
    const figs = (sizes) => {
      const paths = sizes.map((_, i) => `calls/${i + 1}/out/f${i}.png`);
      return { ...Object.fromEntries(paths.map((p, i) => [p, sizes[i] ? pngOfSize(sizes[i]) : png()])), "report.json": reportWith((d) => { d.figures = paths; }), "calls/1/out/vol_by_minute.png": undefined };
    };
    const exp = (files) => { const f = { ...runFiles(), ...files }; for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k]; return writeExport(s.dir, { files: f }); };
    const ok = (files, what) => { const expect = exp(files); const r = record({ root: s.root, dir: s.dir, expect, today: TODAY }); assert.deepEqual(r.errors, [], what); rmSync(join(s.root, "projects"), { recursive: true }); };
    ok(figs(Array(20).fill(0)), "20 figures");
    ok(figs([204_800]), "a figure of 204,800 bytes");
    ok(figs([...Array(5).fill(204_800), 24_576]), "1,048,576 bytes of figures");
    refuses(s, { dir: s.dir, expect: exp(figs(Array(21).fill(0))) }, /at most 20/);
    refuses(s, { dir: s.dir, expect: exp(figs([204_801])) }, /204,?801.*204,?800|over 204,?800/);
    refuses(s, { dir: s.dir, expect: exp(figs([...Array(5).fill(204_800), 24_577])) }, /1,?048,?577/);
  } finally { s.done(); }
});

test("F-005 (US-4, D2): --record fails, writing nothing, when the export would fail a build check: gate, scan, employer denylist, fields, enums", () => {
  const s = sandbox();
  try {
    const cases = [
      ["D6 gate", { "report.json": reportWith((d) => { d.dataset.visibility = "private"; }) }, /D6/],
      ["scan rule in report.md", { "report.md": "# Research report\n\nRead from /home/someone/data.\n" }, /report\.md.*home_path/],
      ["scan rule in a report.json value", { "report.json": reportWith((d) => { d.summary.text = "Used key AKIA" + "A".repeat(16) + "."; }) }, /report\.json.*key_aws/],
      ["scan rule in a report.json key only (escaped in the raw text)", { "report.json": dump(report()).replace('"answer"', '"\\u007e/notes": 1,\n  "answer"') }, /report\.json.*tilde_home/],
      ["employer in report.md", { "report.md": "# Research report\n\nAs the CEO said.\n" }, /report\.md.*employer/],
      ["employer in report.json", { "report.json": reportWith((d) => { d.question = "What would a fintech do?"; }) }, /report\.json.*employer/],
      ["a field check", { "report.json": reportWith((d) => { delete d.question; }) }, /question/],
      ["summary.author human", { "report.json": reportWith((d) => { d.summary.author = "human"; }) }, /summary\.author/],
    ];
    for (const [field, value] of [["status", "paused"], ["review.outcome", "skipped"], ["tag", "survivorship"], ["stop_reason", "out_of_time"], ["models.harness", "autogen"], ["summary.author", "editor"]]) {
      cases.push([`enum ${field}`, { "report.json": reportWith((d) => {
        if (field === "status") d.status = value;
        else if (field === "review.outcome") d.review.outcome = value;
        else if (field === "tag") d.review.open_issues[0].tag = value;
        else if (field === "stop_reason") { d.status = "failed"; d.stop_reason = value; }
        else if (field === "models.harness") d.models.harness = value;
        else d.summary.author = value;
      }) }, new RegExp(field.replace(".", "\\."))]);
    }
    for (const [what, files, pattern] of cases) {
      const expect = runExport(s.dir, { files });
      try { refuses(s, { dir: s.dir, expect }, pattern); } catch (e) { e.message = `${what}: ${e.message}`; throw e; }
    }
  } finally { s.done(); }
});

test("F-005 (US-4): .denylist.local — a term in the export fails --record; inside a longer word it passes; a comment is not a term; comments-only behaves as absent", () => {
  const s = sandbox();
  try {
    const expect = runExport(s.dir, { files: { "report.md": "# Research report\n\nBuilt with Zorblaxian tools, not the old one.\n" } });
    writeFileSync(join(s.root, ".denylist.local"), "# Zorblax Ltd\n\nold one\n");
    refuses(s, { dir: s.dir, expect }, /\.denylist\.local/);
    writeFileSync(join(s.root, ".denylist.local"), "zorblax\n# old one\n");
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect, today: TODAY }).errors, [], "inside a longer word, and comment text, pass");
    const withTerms = snapshot(s.root);
    rmSync(join(s.root, "projects"), { recursive: true });
    writeFileSync(join(s.root, ".denylist.local"), "# only comments\n\n   \n");
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect, today: TODAY }).errors, []);
    const commentsOnly = snapshot(s.root);
    rmSync(join(s.root, "projects"), { recursive: true });
    rmSync(join(s.root, ".denylist.local"));
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect, today: TODAY }).errors, []);
    const absent = snapshot(s.root);
    delete withTerms[".denylist.local"]; delete commentsOnly[".denylist.local"];
    assert.deepEqual(commentsOnly, absent, "a comments-only file gives the same outputs as no file");
    assert.deepEqual(withTerms, absent);
  } finally { s.done(); }
});

test("F-005 (US-4): .denylist.local — a term in report.json fails --record, matched case-insensitively", () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, ".denylist.local"), "zorblax\n");
    refuses(s, { dir: s.dir, expect: runExport(s.dir, { files: { "report.json": reportWith((d) => { d.plan.method = "As done at ZORBLAX."; }) } }) }, /report\.json.*\.denylist\.local/);
  } finally { s.done(); }
});

test("F-005 (US-4, D2): --record refuses a run id already in the manifest", () => {
  const s = sandbox();
  try {
    const expect = runExport(s.dir);
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect, today: TODAY }).errors, []);
    refuses(s, { dir: s.dir, expect }, /already published/);
  } finally { s.done(); }
});

test("F-005 (D10): --record refuses a ninth run", () => {
  const s = sandbox();
  try {
    for (let i = 0; i < 9; i++) {
      const id = `20261111T14300${i}Z-a1b2c3`;
      const expect = runExport(s.dir, { id, files: { "report.json": reportWith((d) => { d.run_id = id; }) } });
      if (i < 8) { assert.deepEqual(record({ root: s.root, dir: s.dir, expect, today: TODAY }).errors, [], `run ${i}`); writeAlt(s.root); }
      else refuses(s, { dir: s.dir, expect }, /9 runs.*at most 8/);
    }
  } finally { s.done(); }
});

test("F-005 (D3): --record --replace keeps alt text and role only for unchanged figures, empties changed and new ones, removes dropped figures, and updates digest and date", () => {
  const s = sandbox();
  try {
    const keep = png({ width: 2, height: 2 }), change = png({ width: 3, height: 3 }), drop = png({ width: 5, height: 5 });
    const files = (figs) => ({ "report.json": reportWith((d) => { d.figures = Object.keys(figs); }), "report.md": runFiles()["report.md"], ...figs });
    const first = writeExport(s.dir, { files: files({ "calls/1/out/keep.png": keep, "calls/1/out/change.png": change, "calls/2/out/drop.png": drop }) });
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect: first, today: "2026-11-12" }).errors, []);
    const m = manifestOf(s.root);
    m.runs[RUN_ID].alt = { "calls/1/out/keep.png": "Kept", "calls/1/out/change.png": "Changed", "calls/2/out/drop.png": "Dropped" };
    m.runs[RUN_ID].role = "trap_caught";
    writeFileSync(join(s.root, MANIFEST), JSON.stringify(m, null, 2) + "\n");
    const second = writeExport(s.dir, { files: files({ "calls/1/out/keep.png": keep, "calls/1/out/change.png": png({ width: 3, height: 4 }), "calls/3/out/new.png": png() }), version: "0.2.0" });
    refuses(s, { dir: s.dir, expect: second, today: "2026-11-20" }, /already published.*--replace/);
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect: second, today: "2026-11-20", replace: true }).errors, []);
    const run = manifestOf(s.root).runs[RUN_ID];
    assert.deepEqual(run.alt, { "calls/1/out/keep.png": "Kept", "calls/1/out/change.png": "", "calls/3/out/new.png": "" });
    assert.equal(run.role, "trap_caught");
    assert.equal(run.checked, "2026-11-20");
    assert.equal(run.export_digest, second);
    assert.equal(run.tool_version, "0.2.0");
    const base = join(s.root, "projects/research-agent/runs", RUN_ID);
    assert.deepEqual(Object.keys(readTree(base)).sort(), ["calls/1/out/change.png", "calls/1/out/keep.png", "calls/3/out/new.png", "report.json", "report.md"]);
    assert.ok(!existsSync(join(base, "calls/2")), "the emptied directory is removed");
  } finally { s.done(); }
});

test("F-005 (D3): --record-scorecard records the scorecard with the same checks, and replaces the published one", () => {
  const s = sandbox();
  try {
    const sc = (f, id = EVAL_ID) => writeExport(s.dir, { kind: "scorecard", id, files: { "scorecard.json": dump(edit(scorecard(), f)) } });
    let expect = sc(() => {});
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect, kind: "scorecard", today: TODAY }).errors, []);
    assert.ok(readFileSync(join(s.root, "projects/research-agent/scorecard/scorecard.json")).equals(scorecardFiles()["scorecard.json"]));
    assert.ok(!existsSync(join(s.root, "projects/research-agent/scorecard/export.json")));
    assert.deepEqual(manifestOf(s.root).scorecard, { eval_id: EVAL_ID, checked: TODAY, export_digest: expect, tool_version: "0.1.0", exported_at: "2026-11-11T15:04:05Z", files: { "scorecard.json": sha(scorecardFiles()["scorecard.json"]) } });
    // The same checks: digest, kind, id pattern, types, gate, dropped field, scan, employer.
    refuses(s, { dir: s.dir, expect: "0".repeat(64), kind: "scorecard" }, /digest/);
    refuses(s, { dir: s.dir, expect: runExport(s.dir), kind: "scorecard" }, /kind/);
    refuses(s, { dir: s.dir, expect: sc((d) => { d.eval_id = "eval-1"; }, "eval-1"), kind: "scorecard" }, /id/);
    refuses(s, { dir: s.dir, expect: sc((d) => { d.k = "2"; }), kind: "scorecard" }, /scorecard\.json: k/);
    refuses(s, { dir: s.dir, expect: sc((d) => { d.runs[0].dataset.licence = "Licensed"; }), kind: "scorecard" }, /D6/);
    refuses(s, { dir: s.dir, expect: sc((d) => { d.fingerprint.sha256 = "0".repeat(64); }), kind: "scorecard" }, /fingerprint\.sha256/);
    refuses(s, { dir: s.dir, expect: sc((d) => { d.fingerprint.config.models.analyst = "~/models/x"; }), kind: "scorecard" }, /scorecard\.json.*tilde_home/);
    refuses(s, { dir: s.dir, expect: sc((d) => { d.fingerprint.config.models.critic = "fintech-model"; }), kind: "scorecard" }, /scorecard\.json.*employer/);
    refuses(s, { dir: s.dir, expect: sc((d) => { d.scorecard_version = "2.0.0"; }), kind: "scorecard" }, /scorecard_version/);
    // A newer scorecard replaces the old one.
    const next = "eval-20261112T090000Z";
    expect = sc((d) => { d.eval_id = next; d.k = 3; d.questions.forEach((q) => { q.n_repeats = q.n_repeats; }); }, next);
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect, kind: "scorecard", today: "2026-11-13" }).errors, []);
    assert.equal(manifestOf(s.root).scorecard.eval_id, next);
    assert.equal(JSON.parse(readFileSync(join(s.root, "projects/research-agent/scorecard/scorecard.json"), "utf8")).k, 3);
  } finally { s.done(); }
});

test("F-005 (US-4): node build.mjs --record <dir> --expect <digest> records, and exits 1 writing nothing on a failure", () => {
  const s = sandbox();
  try {
    const expect = runExport(s.dir);
    const cli = (args) => { try { return { code: 0, out: execFileSync(process.execPath, [join(ROOT, "build.mjs"), ...args], { cwd: s.root, encoding: "utf8", stdio: "pipe" }) }; } catch (e) { return { code: e.status, out: e.stderr }; } };
    const bad = cli(["--record", s.dir, "--expect", "0".repeat(64)]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /digest/);
    assert.ok(!existsSync(join(s.root, "projects")));
    assert.equal(cli(["--record", s.dir]).code, 1, "--expect is required");
    const ok = cli(["--record", s.dir, "--expect", expect]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, new RegExp(RUN_ID));
    assert.ok(existsSync(join(s.root, "projects/research-agent/runs", RUN_ID, "report.json")));
    writeAlt(s.root);
    const sdir = join(s.base, "sc");
    const sexp = writeExport(sdir, { kind: "scorecard", id: EVAL_ID, files: scorecardFiles() });
    const r = cli(["--record-scorecard", sdir, "--expect", sexp]);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(s.root, "projects/research-agent/scorecard/scorecard.json")));
  } finally { s.done(); }
});

test("F-005 (US-4): --record runs the build's checks on the whole would-be tree: a run still missing its alt text blocks the next record", () => {
  const s = sandbox();
  try {
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect: runExport(s.dir), today: TODAY }).errors, []);
    const id = "20261112T090000Z-0f0f0f";
    refuses(s, { dir: s.dir, expect: runExport(s.dir, { id, files: { "report.json": reportWith((d) => { d.run_id = id; }) } }) }, /alt for calls\/1\/out\/vol_by_minute\.png is empty/);
  } finally { s.done(); }
});

// ---- The build: the manifest governs runs/ and scorecard/, and every contract check runs ----
import { build } from "../build.mjs";

const NOW = Date.parse("2026-11-12T12:00:00Z");
// A scratch copy of the site's inputs with the fixture run and scorecard recorded and alt text
// written, as the owner would leave it before `npm run build`.
function publishedSite() {
  const s = sandbox();
  for (const f of ["content.json", "cv.json", "build-state.json", "writing", "public"]) cpSync(join(ROOT, f), join(s.root, f), { recursive: true });
  assert.deepEqual(record({ root: s.root, dir: s.dir, expect: runExport(s.dir), today: TODAY }).errors, []);
  writeAlt(s.root);
  const sdir = join(s.base, "sc");
  assert.deepEqual(record({ root: s.root, dir: sdir, expect: writeExport(sdir, { kind: "scorecard", id: EVAL_ID, files: scorecardFiles() }), kind: "scorecard", today: TODAY }).errors, []);
  s.run = join(s.root, "projects/research-agent/runs", RUN_ID);
  return s;
}
const editManifest = (s, f) => { const m = manifestOf(s.root); f(m); writeFileSync(join(s.root, MANIFEST), JSON.stringify(m, null, 2) + "\n"); };
// Replace a published file and update its hash in the manifest, as a re-record would.
const republish = (s, f, bytes) => {
  writeFileSync(join(s.run, f), bytes);
  editManifest(s, (m) => { m.runs[RUN_ID].files[f] = sha(Buffer.from(bytes)); });
};
// A build (and --check) must fail naming `pattern`, and the build must write nothing.
function buildFails(s, pattern) {
  const before = snapshot(s.root);
  for (const check of [true, false]) {
    const r = build({ root: s.root, check, now: NOW });
    assert.ok(r.errors.some((e) => pattern.test(e)), `check=${check}: expected ${pattern}, got:\n${r.errors.join("\n")}`);
  }
  assert.deepEqual(snapshot(s.root), before, "the build wrote nothing");
}

test("F-005 (US-4, D3): a recorded run and scorecard, with alt text written, pass the build and --check", () => {
  const s = publishedSite();
  try {
    assert.deepEqual(build({ root: s.root, check: true, now: NOW }).errors, []);
    assert.deepEqual(build({ root: s.root, now: NOW }).errors, []);
  } finally { s.done(); }
});

test("F-005 (US-4, D3): the build fails, writing nothing, on each manifest case under runs/ and scorecard/", () => {
  const cases = [
    ["a file not in the manifest", (s) => writeFileSync(join(s.run, "notes.md"), "x"), /notes\.md is not in the manifest/],
    ["a file directly under runs/", (s) => writeFileSync(join(s.root, "projects/research-agent/runs/stray.md"), "x"), /runs\/stray\.md is not in the manifest/],
    ["a run directory not in the manifest", (s) => cpSync(s.run, join(s.root, "projects/research-agent/runs/20261112T090000Z-0f0f0f"), { recursive: true }), /20261112T090000Z-0f0f0f\/report\.json is not in the manifest/],
    ["a scorecard file not in the manifest", (s) => writeFileSync(join(s.root, "projects/research-agent/scorecard/old.json"), "{}"), /scorecard\/old\.json is not in the manifest/],
    ["a scorecard with no manifest entry", (s) => editManifest(s, (m) => { delete m.scorecard; }), /scorecard\/scorecard\.json is not in the manifest/],
    ["a listed file missing", (s) => rmSync(join(s.run, "report.md")), /report\.md is listed in the manifest but missing/],
    ["a hash differs", (s) => writeFileSync(join(s.run, "report.md"), "# Research report\n\nEdited after the read.\n"), /report\.md does not match its sha256/],
    ["a scorecard hash differs", (s) => writeFileSync(join(s.root, "projects/research-agent/scorecard/scorecard.json"), dump(edit(scorecard(), (d) => { d.k = 3; }))), /scorecard\.json does not match its sha256/],
    ["a missing alt entry", (s) => editManifest(s, (m) => { m.runs[RUN_ID].alt = {}; }), /alt has no entry for calls\/1\/out\/vol_by_minute\.png/],
    ["an empty alt text", (s) => editManifest(s, (m) => { m.runs[RUN_ID].alt["calls/1/out/vol_by_minute.png"] = " "; }), /alt for calls\/1\/out\/vol_by_minute\.png is empty/],
    ["an alt entry for a path that isn't a listed figure", (s) => editManifest(s, (m) => { m.runs[RUN_ID].alt["calls/9/out/other.png"] = "Other"; }), /alt names calls\/9\/out\/other\.png/],
    ["report.json names a figure that isn't present", (s) => republish(s, "report.json", reportWith((d) => { d.figures.push("calls/2/out/gone.png"); })), /calls\/2\/out\/gone\.png is named in report\.json but not present/],
    ["a present figure report.json doesn't name", (s) => { mkdirSync(join(s.run, "calls/2/out"), { recursive: true }); republish(s, "calls/2/out/extra.png", png()); editManifest(s, (m) => { m.runs[RUN_ID].alt["calls/2/out/extra.png"] = "Extra"; }); }, /calls\/2\/out\/extra\.png is not a figure report\.json names/],
    ["a role not in Enumerations", (s) => editManifest(s, (m) => { m.runs[RUN_ID].role = "best_run"; }), /role must be one of/],
    ["an unknown top-level key", (s) => editManifest(s, (m) => { m.approved = true; }), /unknown key "approved"/],
    ["an unknown run key", (s) => editManifest(s, (m) => { m.runs[RUN_ID].reviewer = "me"; }), /unknown key "reviewer"/],
    ["an unknown scorecard key", (s) => editManifest(s, (m) => { m.scorecard.note = "x"; }), /unknown key "note"/],
    ["run_id differing from its directory name", (s) => { const id = "20261112T090000Z-0f0f0f"; rmSync(s.run, { recursive: true, force: true }); cpSync(join(s.base, "export"), join(s.root, "projects/research-agent/runs", id), { recursive: true }); rmSync(join(s.root, "projects/research-agent/runs", id, "export.json")); editManifest(s, (m) => { m.runs[id] = m.runs[RUN_ID]; delete m.runs[RUN_ID]; }); }, /run_id is not 20261112T090000Z-0f0f0f/],
    ["a symlink under runs/", (s) => { if (process.platform !== "win32") { rmSync(join(s.run, "report.md")); symlinkSync(join(s.base, "export/report.md"), join(s.run, "report.md")); } else throw new Error("skip"); }, /report\.md is a symlink/],
  ];
  for (const [what, make, pattern] of cases) {
    if (what === "a symlink under runs/" && process.platform === "win32") continue;
    const s = publishedSite();
    try { make(s); buildFails(s, pattern); } catch (e) { e.message = `${what}: ${e.message}`; throw e; } finally { s.done(); }
  }
});

test("F-005 (D3): an export.json anywhere under projects/ or public/ fails the build", () => {
  for (const where of ["projects/research-agent/runs/" + RUN_ID + "/export.json", "projects/export.json", "public/projects/export.json"]) {
    const s = publishedSite();
    try {
      mkdirSync(join(s.root, where, ".."), { recursive: true });
      writeFileSync(join(s.root, where), "{}");
      buildFails(s, /export\.json is never committed/);
    } finally { s.done(); }
  }
});

test("F-005 (D3): an unknown value in each enumerated field fails the build (report, scorecard and manifest)", () => {
  const cases = {
    status: (d) => { d.status = "paused"; },
    "review.outcome": (d) => { d.review.outcome = "skipped"; },
    "review.open_issues[0].tag": (d) => { d.review.open_issues[0].tag = "survivorship"; },
    stop_reason: (d) => { d.status = "failed"; d.stop_reason = "out_of_time"; },
    "models.harness": (d) => { d.models.harness = "autogen"; },
    "summary.author": (d) => { d.summary.author = "editor"; },
  };
  for (const [field, f] of Object.entries(cases)) {
    const s = publishedSite();
    try { republish(s, "report.json", reportWith(f)); buildFails(s, new RegExp(field.replace(/[.[\]]/g, "\\$&"))); } finally { s.done(); }
  }
  const scCases = {
    "runs[0].status": (d) => { d.runs[0].status = "paused"; },
    "runs[0].models.harness": (d) => { d.runs[0].models.harness = "autogen"; },
    "fingerprint.config.harness": (d) => { d.fingerprint.config.harness = "autogen"; },
    "questions[0].other_issues": (d) => { d.questions[0].other_issues = { survivorship: 1 }; },
  };
  for (const [field, f] of Object.entries(scCases)) {
    const s = publishedSite();
    try {
      const b = dump(edit(scorecard(), f));
      writeFileSync(join(s.root, "projects/research-agent/scorecard/scorecard.json"), b);
      editManifest(s, (m) => { m.scorecard.files["scorecard.json"] = sha(Buffer.from(b)); });
      buildFails(s, new RegExp(field.replace(/[.[\]]/g, "\\$&")));
    } finally { s.done(); }
  }
  const s = publishedSite();
  try { editManifest(s, (m) => { m.runs[RUN_ID].role = "favourite"; }); buildFails(s, /role/); } finally { s.done(); }
});

test("F-005 (US-4, D6): the build fails on a committed run or scorecard that fails the synthetic-only gate", () => {
  let s = publishedSite();
  try { republish(s, "report.json", reportWith((d) => { d.dataset.source = "synthetic:research_agent.data.synth seed=1 "; })); buildFails(s, /D6/); } finally { s.done(); }
  s = publishedSite();
  try {
    const b = dump(edit(scorecard(), (d) => { d.runs[0].dataset.visibility = "private"; }));
    writeFileSync(join(s.root, "projects/research-agent/scorecard/scorecard.json"), b);
    editManifest(s, (m) => { m.scorecard.files["scorecard.json"] = sha(Buffer.from(b)); });
    buildFails(s, /D6/);
  } finally { s.done(); }
});

test("F-005 (US-4): the build fails on a committed file that hits the output scan, the employer denylist, or a JSON key only", () => {
  const cases = [
    ["report.md", "# Research report\n\nSee C:\\Users\\someone\\x.\n", /report\.md matches output scan rule windows_user_path/],
    ["report.md", "# Research report\n\nThe company asked for it.\n", /report\.md names an employer/],
    ["report.json", dump(report()).replace('"answer"', '"\\u002fhome/someone": 1,\n  "answer"'), /report\.json matches output scan rule home_path/],
  ];
  for (const [f, body, pattern] of cases) {
    const s = publishedSite();
    try { republish(s, f, body); buildFails(s, pattern); } finally { s.done(); }
  }
  const s = publishedSite();
  try { editManifest(s, (m) => { m.runs[RUN_ID].alt["calls/1/out/vol_by_minute.png"] = "Chart from data/cache/x"; }); buildFails(s, /published\.json matches output scan rule data_cache/); } finally { s.done(); }
});

test("F-005 (US-4): .denylist.local fails the local build on a term in exported text, an alt text or a role; absent or comments-only, the build runs as in CI", () => {
  let s = publishedSite();
  try {
    writeFileSync(join(s.root, ".denylist.local"), "zorblax\n");
    assert.deepEqual(build({ root: s.root, check: true, now: NOW }).errors, [], "no term present");
    republish(s, "report.md", "# Research report\n\nAs we did at Zorblax.\n");
    buildFails(s, /report\.md matches a term in \.denylist\.local/);
  } finally { s.done(); }
  s = publishedSite();
  try {
    writeFileSync(join(s.root, ".denylist.local"), "zorblax\n");
    editManifest(s, (m) => { m.runs[RUN_ID].alt["calls/1/out/vol_by_minute.png"] = "A Zorblax chart."; });
    buildFails(s, /published\.json matches a term in \.denylist\.local/);
    editManifest(s, (m) => { m.runs[RUN_ID].alt["calls/1/out/vol_by_minute.png"] = "A Zorblaxian chart."; });
    assert.deepEqual(build({ root: s.root, check: true, now: NOW }).errors, [], "inside a longer word");
    writeFileSync(join(s.root, ".denylist.local"), "trap_caught\n");
    editManifest(s, (m) => { m.runs[RUN_ID].role = "trap_caught"; });
    buildFails(s, /published\.json matches a term in \.denylist\.local/);
  } finally { s.done(); }
  s = publishedSite();
  try {
    republish(s, "report.md", "# Research report\n\nAs we did at Zorblax.\n");
    const absent = build({ root: s.root, now: NOW });
    assert.deepEqual(absent.errors, [], "absent: as in CI");
    const after = snapshot(s.root);
    writeFileSync(join(s.root, ".denylist.local"), "# zorblax\n\n  \n");
    const comments = build({ root: s.root, now: NOW });
    assert.deepEqual(comments.errors, []);
    assert.deepEqual(comments.stale, [], "nothing differs from the build without the file");
    const withFile = snapshot(s.root); delete withFile[".denylist.local"];
    assert.deepEqual(withFile, after, "a comments-only file behaves exactly as an absent one");
  } finally { s.done(); }
});

test("F-005 (US-4, D2): --record reports a missing or unparseable report.json as a check failure, writing nothing", () => {
  const s = sandbox();
  try {
    refuses(s, { dir: s.dir, expect: runExport(s.dir, { files: { "report.json": "{ not json" } }) }, /report\.json is not valid JSON/);
    const files = runFiles(); delete files["report.json"];
    refuses(s, { dir: s.dir, expect: writeExport(s.dir, { files }) }, /report\.json is missing/);
  } finally { s.done(); }
});

test("F-005 (D3): --record keeps an unknown key already in published.json, so the check refuses it rather than dropping it", () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.root, "projects/research-agent"), { recursive: true });
    writeFileSync(join(s.root, MANIFEST), JSON.stringify({ manifest_version: "1.0.0", runs: {}, approved: true }));
    refuses(s, { dir: s.dir, expect: runExport(s.dir) }, /unknown key "approved"/);
  } finally { s.done(); }
});

test("F-005 (D2, D4): an injected write failure during --record --replace restores the published run and manifest byte for byte", () => {
  const s = sandbox();
  try {
    assert.deepEqual(record({ root: s.root, dir: s.dir, expect: runExport(s.dir), today: TODAY }).errors, []);
    writeAlt(s.root);
    const before = snapshot(s.root);
    const expect = writeExport(s.dir, { files: { "report.md": runFiles()["report.md"], "calls/2/out/other.png": png(), "report.json": reportWith((d) => { d.figures = ["calls/2/out/other.png"]; }) } });
    let n = 0;
    const io = { renameSync: (a, b) => { if (++n === 2) throw new Error("injected"); return renameSync(a, b); } };
    assert.throws(() => record({ root: s.root, dir: s.dir, expect, today: TODAY, replace: true, io }), (e) => e.writePhase && e.rolledBack);
    assert.deepEqual(snapshot(s.root), before);
    assert.ok(existsSync(join(s.root, "projects/research-agent/runs", RUN_ID, "calls/1/out")), "the removed directory is recreated");
  } finally { s.done(); }
});

// ---- Review fixes: duplicate JSON keys (what is published is the raw file, not JSON.parse's view) ----
import { parseJson } from "../lib/projects.mjs";

test("F-005 (US-4, D3): parseJson refuses a duplicate key at any depth, and accepts the same key in different objects", () => {
  assert.deepEqual(parseJson('{"a": {"b": 1}, "c": [{"b": 2}, {"b": "\\"b\\""}]}'), { a: { b: 1 }, c: [{ b: 2 }, { b: '"b"' }] });
  assert.throws(() => parseJson('{"a": 1, "a": 2}'), /duplicate key "a"/);
  assert.throws(() => parseJson('{"x": {"a": 1, "b": {}, "a": 2}}'), /duplicate key "a"/);
  assert.throws(() => parseJson('[{"k": 1}, {"k": 1, "\\u006b": 2}]'), /duplicate key "k"/, "an escaped spelling is the same key");
  assert.throws(() => parseJson('{"a": 1,'), SyntaxError);
  assert.deepEqual(Object.keys(parseJson('{"__proto__": 1}')), ["__proto__"], "__proto__ is an ordinary own key");
});

const REAL = '{"licence": "Licensed", "name": "real-feed", "source": "vendor:feed", "visibility": "private"}';
test("F-005 (US-4, D6): a report.json with a real dataset followed by a synthetic one is refused by --record and by the build", () => {
  const twice = dump(report()).replace('"dataset": {', `"dataset": ${REAL},\n  "dataset": {`);
  assert.equal(JSON.parse(twice).dataset.visibility, "public", "JSON.parse alone would see only the synthetic one");
  const s = sandbox();
  try { refuses(s, { dir: s.dir, expect: runExport(s.dir, { files: { "report.json": twice } }) }, /report\.json.*duplicate key "dataset"/); } finally { s.done(); }
  const b = publishedSite();
  try { republish(b, "report.json", twice); buildFails(b, /report\.json.*duplicate key "dataset"/); } finally { b.done(); }
});

test("F-005 (US-4, D6): a scorecard with a duplicate runs[].dataset is refused by --record-scorecard and by the build", () => {
  const text = dump(scorecard());
  const i = text.indexOf('"dataset": {');
  const twice = text.slice(0, i) + `"dataset": ${REAL},\n      ` + text.slice(i);
  const s = sandbox();
  try { refuses(s, { dir: s.dir, kind: "scorecard", expect: writeExport(s.dir, { kind: "scorecard", id: EVAL_ID, files: { "scorecard.json": twice } }) }, /scorecard\.json.*duplicate key "dataset"/); } finally { s.done(); }
  const b = publishedSite();
  try {
    writeFileSync(join(b.root, "projects/research-agent/scorecard/scorecard.json"), twice);
    editManifest(b, (m) => { m.scorecard.files["scorecard.json"] = sha(Buffer.from(twice)); });
    buildFails(b, /scorecard\.json.*duplicate key "dataset"/);
  } finally { b.done(); }
});

test("F-005 (US-4, D3): a duplicate key in export.json or published.json is refused", () => {
  const s = sandbox();
  try {
    const raw = readFileSync(join(FIXTURES, "run/export.json"), "utf8").replace('"kind": "run"', '"kind": "scorecard",\n  "kind": "run"');
    refuses(s, { dir: s.dir, expect: runExport(s.dir, { raw }) }, /export\.json.*duplicate key "kind"/);
  } finally { s.done(); }
  const b = publishedSite();
  try {
    const m = readFileSync(join(b.root, MANIFEST), "utf8");
    writeFileSync(join(b.root, MANIFEST), m.replace('"role"', '"x"').replace(/"checked": "([^"]+)"/, '"checked": "2026-01-01",\n      "checked": "$1"'));
    buildFails(b, /published\.json.*duplicate key "checked"/);
  } finally { b.done(); }
});

// ---- Review fixes: denylist case folding and whitespace, and the \s gap in SCAN_RULES ----
test("F-005 (US-4): .denylist.local folds case as Python's casefold does for ß and ligatures, both ways", () => {
  assert.equal(denylistHit("Built at STRAßE works", parseDenylist("strasse")), true, "ß in the text, ss in the term");
  assert.equal(denylistHit("Built at Strasse works", parseDenylist("straße")), true, "ß in the term, ss in the text");
  assert.equal(denylistHit("the ﬁnch tooling", parseDenylist("finch")), true, "a ligature in the text");
  assert.equal(denylistHit("the FINCH tooling", parseDenylist("ﬁnch")), true, "a ligature in the term");
  assert.equal(denylistHit("Straßenbahn", parseDenylist("strasse")), false, "still not inside a longer word");
});

test("F-005 (US-4): .denylist.local lines are stripped of Python's whitespace set, and not of U+FEFF", () => {
  assert.deepEqual(parseDenylist("\x1c\x1dzorblax\x1e\x1f\n\x85acme\u3000\n\u00a0# comment"), ["zorblax", "acme"]);
  assert.deepEqual(parseDenylist("\ufeffzorblax"), ["\ufeffzorblax"], "Python's strip() keeps U+FEFF");
});

test("F-005 (US-4): Python's \\s includes \\x1c-\\x1f and \\x85, which JavaScript's lacks: those prefixes still hit", () => {
  for (const c of ["\x1c", "\x1d", "\x1e", "\x1f", "\x85"]) {
    assert.ok(scanHits(`x${c}/home/someone`).includes("home_path"), `home_path after U+${c.charCodeAt(0).toString(16)}`);
    assert.ok(scanHits(`x${c}~/notes`).includes("tilde_home"), `tilde_home after U+${c.charCodeAt(0).toString(16)}`);
    assert.ok(scanHits(`x${c}C:\\Users\\x`).includes("windows_user_path"));
  }
});
