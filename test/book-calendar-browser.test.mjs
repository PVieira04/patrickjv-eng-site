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
    assert.equal(await page.evaluate(() => document.activeElement.name), "time", "Tab moves from the grid into the time list");
    for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowDown"); // radio group: moves to and checks the next time
    const kb = await page.evaluate(() => {
      const box = document.getElementById("times").getBoundingClientRect(), input = document.activeElement;
      const row = document.querySelector('label[for="' + input.id + '"]').getBoundingClientRect();
      return { checked: input.checked, value: input.value, label: document.querySelector('label[for="' + input.id + '"]').textContent, scrolled: document.getElementById("times").scrollTop, inView: row.top >= box.top - 0.5 && row.bottom <= box.bottom + 0.5 };
    });
    assert.ok(kb.checked, "arrow keys check the time they move to");
    assert.equal(kb.label, "12:30", "the ninth free time on 2 November");
    assert.ok(kb.scrolled > 0, "the list scrolled to follow the keyboard");
    assert.ok(kb.inView, "the focused time is fully in view in the list");
    const ring = await page.evaluate(() => getComputedStyle(document.querySelector('label[for="' + document.activeElement.id + '"]')).outlineStyle);
    assert.notEqual(ring, "none", "the focused time shows a focus ring");
    assert.equal(await page.isVisible("#details"), true, "choosing a time opens the details form");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Ada Lovelace");
    await page.keyboard.press("Tab");
    await page.keyboard.type("ada@example.com");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /Check your inbox/.test(document.getElementById("status").textContent));
    const [post] = site.posts;
    assert.equal(post.type, "consultation");
    assert.equal(post.name, "Ada Lovelace");
    assert.equal(post.start, kb.value);
    assert.match(post.start, /^2026-11-02T12:30/);
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

// F-003 4a–4c: the times are start times only, in one column, in a box of bounded height that
// scrolls (and fades at the bottom while more lie below), and goes back to the top for a new day.
test("Chromium /book: the times are a single-column list of start times that scrolls in a bounded box, at 360 px and on desktop (light and dark)", { skip }, async () => {
  for (const width of [360, 1280]) for (const scheme of ["light", "dark"]) {
    const { page, problems, done } = await open({ width, scheme });
    const at = `${width} px ${scheme}`;
    try {
      await page.click("#types input");
      await page.waitForSelector("#days button");
      await page.click("#days button:not([aria-disabled=true])"); // Monday 26 October, 21 free times
      const m = await page.evaluate(() => {
        const list = document.getElementById("times"), cs = getComputedStyle(list), box = list.getBoundingClientRect();
        const rows = [...list.querySelectorAll("label")].map((l) => { const r = l.getBoundingClientRect(); return { text: l.textContent, left: r.left, width: r.width, top: r.top, height: r.height }; });
        return { rows, overflowY: cs.overflowY, overscroll: cs.overscrollBehaviorY, maxHeight: cs.maxHeight, client: list.clientHeight, scroll: list.scrollHeight, more: list.getAttribute("data-more"), mask: cs.maskImage || cs.webkitMaskImage, left: box.left, right: box.right, pageScroll: document.documentElement.scrollWidth, pageClient: document.documentElement.clientWidth, inDialog: !!list.closest("dialog, [role=dialog], [aria-modal]") };
      });
      assert.equal(m.rows.length, 21, at);
      assert.ok(m.rows.every((r) => /^\d\d:\d\d$/.test(r.text)), `${at}: labels are start times only (${m.rows[0].text})`);
      assert.ok(m.rows.every((r) => r.left === m.rows[0].left && r.width === m.rows[0].width), `${at}: one column`);
      assert.ok(m.rows.every((r, i) => i === 0 || r.top >= m.rows[i - 1].top + m.rows[i - 1].height), `${at}: one time per row, top to bottom`);
      assert.ok(m.rows[0].width >= m.right - m.left - 16, `${at}: rows run the full width of the list`);
      assert.ok(m.rows.every((r) => r.height >= 44), `${at}: rows at least 44 px tall`);
      assert.equal(m.overflowY, "auto", at);
      assert.equal(m.overscroll, "contain", at);
      assert.notEqual(m.maxHeight, "none", `${at}: the list has a bounded height`);
      const visibleRows = m.client / (m.rows[1].top - m.rows[0].top);
      assert.ok(visibleRows >= 5 && visibleRows <= 6.5, `${at}: about 5–6 rows visible (${visibleRows.toFixed(2)})`);
      assert.ok(m.scroll > m.client, `${at}: 21 times overflow the box, so it scrolls`);
      assert.equal(m.more, "true", `${at}: more below, so the bottom edge fades`);
      assert.match(m.mask, /gradient/, `${at}: the fade is a mask gradient`);
      assert.equal(m.inDialog, false, `${at}: inline, not in a dialog`);
      assert.ok(m.pageScroll <= m.pageClient, `${at}: page scrolls sideways (${m.pageScroll} > ${m.pageClient})`);
      if (width === 360) assert.ok(m.left >= 16 && m.right <= 360 - 16, `${at}: list inside the 16 px gutter (${m.left}–${m.right})`);
      // Scrolled to the end, there is nothing more below: no fade.
      await page.evaluate(() => { const l = document.getElementById("times"); l.scrollTop = l.scrollHeight; });
      await page.waitForFunction(() => document.getElementById("times").getAttribute("data-more") === "false");
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("times")).maskImage), "none", `${at}: no fade at the end`);
      // Partway down, then another day: the list starts again at the top.
      await page.evaluate(() => { document.getElementById("times").scrollTop = 120; });
      await page.click("#days button[aria-pressed=false]");
      assert.equal(await page.evaluate(() => document.getElementById("times").scrollTop), 0, `${at}: a new day starts at the top`);
      assert.equal(await page.getAttribute("#times", "data-more"), "true", at);
      // Choosing a time still opens the details form.
      await page.click("#times label >> nth=3");
      assert.equal(await page.isVisible("#details"), true, at);
      assert.deepEqual(problems, [], at);
    } finally { await done(); }
  }
});
