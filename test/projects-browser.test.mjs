// F-005: the built /projects pages in headless Chromium, under their real CSP from the generated
// _headers. Covers what the string tests cannot: no CSP violation, same-origin requests only, no
// horizontal scroll at phone width (and at 320 px with 200 % text) on a run page with a wide table,
// a long code line, a long unbroken string and a wide figure, and the scroll regions reachable by
// Tab and scrolled by the arrow keys. Skipped where Chromium is not installed (as the /book tests).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "../build.mjs";
import { headersFor } from "./book-fake-server.mjs";
import { report, dump, sha, png, clearRecorded, scorecardFiles } from "./projects-helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const browser = await chromium.launch().catch(() => null);
const skip = browser ? false : "headless Chromium could not be launched (not installed, or missing libraries)";

// A scratch site with one synthetic run whose report stresses the layout, built.
const ID = "20261111T143000Z-a1b2c3";
const base = mkdtempSync(join(tmpdir(), "site-browser-"));
const root = join(base, "site");
const PUBLIC = join(root, "public");
let server, origin;
if (browser) {
  mkdirSync(root);
  for (const f of ["content.json", "cv.json", "build-state.json", "writing", "public", "projects"]) cpSync(join(ROOT, f), join(root, f), { recursive: true });
  clearRecorded(root);
  const cols = Array.from({ length: 12 }, (_, i) => `column_${i + 1}`);
  const md = [
    "# Report", "", "A wide table:", "",
    `| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, `| ${cols.map((_, i) => `value_${i}_0.123456`).join(" | ")} |`, "",
    "```python", `print("${"x".repeat(200)}")`, "```", "",
    "An unbroken string: " + "y".repeat(300), "",
  ].join("\n");
  const fig = "calls/1/out/wide.png";
  const doc = report();
  doc.figures = [fig];
  const files = { "report.json": Buffer.from(dump(doc)), "report.md": Buffer.from(md), [fig]: png({ width: 2000, height: 40 }) };
  for (const [f, b] of Object.entries(files)) { mkdirSync(dirname(join(root, "projects/research-agent/runs", ID, f)), { recursive: true }); writeFileSync(join(root, "projects/research-agent/runs", ID, f), b); }
  const card = scorecardFiles()["scorecard.json"];
  mkdirSync(join(root, "projects/research-agent/scorecard"), { recursive: true });
  writeFileSync(join(root, "projects/research-agent/scorecard/scorecard.json"), card);
  writeFileSync(join(root, "projects/research-agent/published.json"), JSON.stringify({ manifest_version: "1.0.0", runs: { [ID]: {
    checked: "2026-11-12", export_digest: "a".repeat(64), tool_version: "0.1.0", exported_at: "2026-11-11T15:04:05Z",
    files: Object.fromEntries(Object.entries(files).sort().map(([f, b]) => [f, sha(b)])), alt: { [fig]: "A wide synthetic chart." },
  } }, scorecard: { eval_id: "eval-20261111T150000Z", checked: "2026-11-12", export_digest: "b".repeat(64), tool_version: "0.1.0", exported_at: "2026-11-11T15:04:05Z", files: { "scorecard.json": sha(card) } } }, null, 2));
  const r = build({ root, today: "2026-11-12", now: Date.parse("2026-11-12T12:00:00Z") });
  if (r.errors.length) throw new Error(r.errors.join("\n"));

  // Serves public/ as the asset server does for these paths: "/x/" -> x/index.html, "/x" -> x.html,
  // with the exact _headers rule's headers (the CSP among them).
  const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8", ".json": "application/json" };
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const file = [path.endsWith("/") ? path + "index.html" : path, path + ".html"].map((p) => join(PUBLIC, p)).find((f) => existsSync(f) && statSync(f).isFile());
    if (!file) { res.writeHead(404); return res.end(); }
    let rule = {};
    try { rule = headersFor(path, PUBLIC); } catch { /* no exact rule: figures, fonts' own rules aside */ }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...rule });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
}
after(async () => { await browser?.close(); await new Promise((r) => (server ? server.close(r) : r())); rmSync(base, { recursive: true, force: true }); });

async function open(path, { width = 360, text = 1 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, locale: "en-GB", colorScheme: "light", reducedMotion: "reduce" });
  const page = await context.newPage();
  const problems = [], foreign = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("request", (r) => { if (new URL(r.url()).origin !== origin) foreign.push(r.url()); });
  const res = await page.goto(origin + path, { waitUntil: "load" });
  assert.match(res.headers()["content-security-policy"] ?? "", /^default-src 'none'.*style-src 'sha256-/, `${path} is served with its CSP`);
  if (text !== 1) await page.evaluate((t) => { document.documentElement.style.fontSize = `${t * 100}%`; }, text);
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))));
  return { page, problems, foreign, done: () => context.close() };
}
// How far the page scrolls sideways (0 or less: not at all), and the elements sticking out.
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const sticking = (page) => page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => !e.closest(".scroll") && e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).map((e) => `<${e.tagName.toLowerCase()} class="${e.className.baseVal ?? e.className}"> ${Math.round(e.getBoundingClientRect().right)}px`).slice(0, 6).join(", "));

test("Chromium /projects: every page loads under its real CSP with no violation, only same-origin requests, and no horizontal scroll at 360 px", { skip }, async () => {
  for (const path of ["/projects/", "/projects/research-agent", `/projects/research-agent/runs/${ID}/`]) {
    const { page, problems, foreign, done } = await open(path);
    try {
      assert.deepEqual(problems, [], `${path}: no CSP violation or error`);
      assert.deepEqual(foreign, [], `${path}: same-origin requests only`);
      assert.ok(await overflow(page) <= 0, `${path}: no horizontal scroll (${await sticking(page)})`);
      if (path.includes("/runs/")) assert.equal(await page.evaluate(() => document.querySelector("img").naturalWidth), 2000, "the figure loaded (img-src 'self')");
    } finally { await done(); }
  }
});

test("Chromium /projects: a run page with a 12-column table, a 200-character code line, a 300-character string and a 2,000-pixel figure doesn't scroll sideways at 320 px with 200 % text", { skip }, async () => {
  const { page, problems, done } = await open(`/projects/research-agent/runs/${ID}/`, { width: 320, text: 2 });
  try {
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), "32px", "text at 200 %");
    assert.ok(await overflow(page) <= 0, `no horizontal scroll (${await sticking(page)})`);
    const img = await page.evaluate(() => document.querySelector("img").getBoundingClientRect().width);
    assert.ok(img <= 320, "the figure scales down");
    assert.deepEqual(problems, []);
  } finally { await done(); }
});

test("Chromium /projects: the table and code-block wrappers are each reachable by Tab and scroll with the arrow keys", { skip }, async () => {
  const { page, done } = await open(`/projects/research-agent/runs/${ID}/`);
  try {
    for (const label of ["Table 1", "Code 1"]) {
      let found = false;
      for (let i = 0; i < 40 && !found; i++) {
        await page.keyboard.press("Tab");
        found = await page.evaluate((l) => document.activeElement?.getAttribute("aria-label") === l, label);
      }
      assert.ok(found, `${label} is reachable by Tab`);
      const before = await page.evaluate(() => document.activeElement.scrollLeft);
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
      await page.waitForFunction((b) => document.activeElement.scrollLeft > b, before);
      assert.ok(await page.evaluate(() => document.activeElement.scrollWidth > document.activeElement.clientWidth), `${label} overflows its wrapper, not the page`);
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none", `${label} shows a focus ring`);
    }
  } finally { await done(); }
});

test("Chromium /projects: at 400 px the scorecard stacks, each value labelled with its column and the table roles kept", { skip }, async () => {
  const { page, done } = await open("/projects/research-agent", { width: 400 });
  try {
    const got = await page.evaluate(() => {
      const t = document.querySelector("table.scorecard-stack");
      const head = t.querySelector("thead").getBoundingClientRect();
      const cells = [...t.querySelectorAll("tbody td")];
      return {
        headHidden: head.width <= 1 && head.height <= 1,
        stacked: getComputedStyle(cells[0]).display !== "table-cell",
        labels: cells.map((td) => { const b = getComputedStyle(td, "::before"); return b.display !== "none" && b.content === JSON.stringify(td.dataset.label); }),
        roles: [t.getAttribute("role"), cells[0].getAttribute("role"), t.querySelector("tbody th").getAttribute("role")],
      };
    });
    assert.ok(got.headHidden, "the header row is visually hidden");
    assert.ok(got.stacked, "the cells stack");
    assert.ok(got.labels.length > 0 && got.labels.every(Boolean), "every value shows its column name");
    assert.deepEqual(got.roles, ["table", "cell", "rowheader"]);
    assert.ok(await overflow(page) <= 0, `no horizontal scroll (${await sticking(page)})`);
  } finally { await done(); }
  const wide = await open("/projects/research-agent", { width: 1000 });
  try {
    assert.equal(await wide.page.evaluate(() => getComputedStyle(document.querySelector("table.scorecard-stack td")).display), "table-cell", "a table when wide");
  } finally { await wide.done(); }
});
