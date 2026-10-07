// npm run cv: prints public/cv.html to public/cv.pdf (A4, at most two pages) with headless
// Chromium, then records every generated file's hashes in designs/images.json. Run `npm run build`
// first so cv.html is current. Needs Playwright's headless shell for the pinned playwright-core
// (`npx playwright-core install chromium-headless-shell`); on WSL without system libraries, set
// LD_LIBRARY_PATH as docs/02 describes.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { MANIFEST, currentHashes, pdfPageCount, CV_MAX_PAGES } from "../lib/images.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pub = join(root, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

// The page loads its fonts from /fonts/…, so serve public/ over HTTP rather than file://.
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(pub, path === "/cv" ? "cv.html" : path);
  if (!file.startsWith(pub) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/cv`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, tagged: true });
  const pages = pdfPageCount(pdf);
  if (pages < 1 || pages > CV_MAX_PAGES) throw new Error(`cv.pdf has ${pages} pages (allowed 1–${CV_MAX_PAGES}); shorten cv.json and rerun`);
  writeFileSync(join(pub, "cv.pdf"), pdf);
  console.log(`cv.pdf ${pdf.length} bytes, ${pages} page(s)`);
} finally {
  await browser.close();
  server.close();
}
writeFileSync(join(root, MANIFEST), JSON.stringify(currentHashes(root), null, 2) + "\n");
console.log(`wrote ${MANIFEST}`);
