// F-003: the built /book page in headless Chromium, under its real CSP, against a fake booking API.
// Covers what the VM tests cannot: real focus and keyboard handling, CSP (the inline script and
// style must run under their hashes), and layout at phone width. Skipped where Chromium is not
// installed (CI runs `npm ci --ignore-scripts`; locally: `npx playwright-core install
// chromium-headless-shell`, and on WSL the LD_LIBRARY_PATH in docs/05).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startBookServer } from "./book-fake-server.mjs";

const browser = await chromium.launch().catch(() => null);
const skip = browser ? false : "headless Chromium could not be launched (not installed, or missing libraries)";
after(async () => { await browser?.close(); });

async function open({ width = 360, scheme = "light" } = {}) {
  const site = await startBookServer();
  const context = await browser.newContext({ viewport: { width, height: 800 }, locale: "en-GB", timezoneId: "Europe/London", colorScheme: scheme, reducedMotion: "reduce" });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.goto(site.url + "/book");
  await page.waitForSelector("#types input");
  return { site, page, problems, done: async () => { await context.close(); await site.close(); } };
}
const focused = (page) => page.evaluate(() => document.activeElement.getAttribute("aria-label") || document.activeElement.id || document.activeElement.value);

test("Chromium /book: a booking made by keyboard alone, through the calendar, under the real CSP", { skip }, async () => {
  const { site, page, problems, done } = await open();
  try {
    await page.focus("#types input");
    await page.keyboard.press("Space");
    await page.waitForSelector("#days button");
    assert.equal(await page.textContent("#cal-month"), "October 2026");
    await page.keyboard.press("Tab");
    assert.equal(await focused(page), "Next month", "two months: Tab reaches the next-month button (previous is disabled)");
    await page.keyboard.press("Tab");
    assert.equal(await focused(page), "Monday 26 October, 21 free times", "then the grid, on the first free day");
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.notEqual(outline, "none", "focus is visible");
    await page.keyboard.press("ArrowRight");
    assert.equal(await focused(page), "Tuesday 27 October, 22 free times");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    assert.equal(await focused(page), "Sunday 1 November, no free times", "arrows cross into November");
    assert.equal(await page.textContent("#cal-month"), "November 2026");
    await page.keyboard.press("Enter");
    assert.equal(await page.isVisible("#time-set"), false, "an unavailable day does nothing");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    assert.equal(await page.getAttribute("#days button[aria-pressed=true]", "aria-label"), "Monday 2 November, 22 free times");
    assert.equal(await page.textContent("#time-legend"), "Time on Monday 2 November");
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowRight"); // radio group: moves to and checks the second time
    assert.equal(await page.isVisible("#details"), true);
    await page.keyboard.press("Tab");
    await page.keyboard.type("Ada Lovelace");
    await page.keyboard.press("Tab");
    await page.keyboard.type("ada@example.com");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /Check your inbox/.test(document.getElementById("status").textContent));
    const [post] = site.posts;
    assert.equal(post.type, "consultation");
    assert.equal(post.name, "Ada Lovelace");
    assert.match(post.start, /^2026-11-02T10:/);
    assert.deepEqual(problems, [], "no console errors (CSP violations are logged as errors)");
  } finally { await done(); }
});

test("Chromium /book: no horizontal scroll at 360 px, the grid fills the gutter, cells are at least 44 px tall (light and dark)", { skip }, async () => {
  for (const scheme of ["light", "dark"]) {
    const { page, problems, done } = await open({ scheme });
    try {
      await page.click("#types input");
      await page.waitForSelector("#days button");
      await page.click("#days button:not([aria-disabled=true])");
      const m = await page.evaluate(() => {
        const grid = document.getElementById("days").getBoundingClientRect();
        const cell = document.querySelector("#days button").getBoundingClientRect();
        return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, left: grid.left, right: grid.right, cellH: cell.height };
      });
      assert.ok(m.scroll <= m.client, `${scheme}: page scrolls sideways (${m.scroll} > ${m.client})`);
      assert.ok(m.left >= 16 && m.right <= 360 - 16, `${scheme}: grid inside the 16 px gutter (${m.left}–${m.right})`);
      assert.ok(m.cellH >= 44, `${scheme}: day cells ${m.cellH} px tall`);
      assert.deepEqual(problems, []);
    } finally { await done(); }
  }
});
