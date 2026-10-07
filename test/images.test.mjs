// Drift guard for the generated images (review R53): designs/images.json must match the current
// inputs and outputs, so a changed input without `npm run images`, or a hand-edited image, fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST, currentHashes, imageDrift, pdfPageCount, CV_MAX_PAGES } from "../lib/images.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const recorded = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));

// A scratch copy of just what the image sets read, to mutate safely.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "images-test-"));
  for (const p of ["package.json", "content.json", "designs/favicon", "designs/og", "designs/make-cv-pdf.mjs", "public"]) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  return dir;
}

test("designs/images.json matches the current inputs and outputs", () => {
  assert.deepEqual(imageDrift(recorded, currentHashes(ROOT)), []);
});

test("a changed card input (the tagline) is reported; an unrelated content.json edit is not", () => {
  const dir = scratch();
  try {
    const c = JSON.parse(readFileSync(join(dir, "content.json"), "utf8"));
    c.faq = [...c.faq, { q: "unrelated", a: "edit" }];
    writeFileSync(join(dir, "content.json"), JSON.stringify(c));
    assert.deepEqual(imageDrift(recorded, currentHashes(dir)), [], "an edit outside person.{name,headline,tagline} must not invalidate the card");
    c.person.tagline += " (changed)";
    writeFileSync(join(dir, "content.json"), JSON.stringify(c));
    const errors = imageDrift(recorded, currentHashes(dir));
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.match(errors[0], /^card: input content\.json person\.\{name,headline,tagline\} changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a changed icon source invalidates the icons; a font or sharp change invalidates the card", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "designs/favicon/chosen.svg"), readFileSync(join(dir, "designs/favicon/chosen.svg"), "utf8") + "\n");
    writeFileSync(join(dir, "designs/og/fonts/IBMPlexSans-SemiBold.ttf"), "not a font");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.devDependencies.sharp = "0.0.0";
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    const errors = imageDrift(recorded, currentHashes(dir)).join("\n");
    assert.match(errors, /icons: input designs\/favicon\/chosen\.svg changed/);
    assert.match(errors, /card: input designs\/og\/fonts\/IBMPlexSans-SemiBold\.ttf changed/);
    assert.match(errors, /icons: input sharp \(package\.json\) changed/);
    assert.match(errors, /card: input sharp \(package\.json\) changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a hand-edited output, or a missing set, is reported", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "public/og-card.jpg"), Buffer.concat([readFileSync(join(dir, "public/og-card.jpg")), Buffer.from([0])]));
    assert.match(imageDrift(recorded, currentHashes(dir)).join("\n"), /card: public\/og-card\.jpg differs from what npm run images generated/);
    const { card, ...withoutCard } = recorded;
    assert.match(imageDrift(withoutCard, currentHashes(ROOT)).join("\n"), /card: not in designs\/images\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cv.pdf, as committed, has 1 to 2 pages (counted in the file), and the CV page changing invalidates it", () => {
  const pages = pdfPageCount(readFileSync(join(ROOT, "public/cv.pdf")));
  assert.ok(pages >= 1 && pages <= CV_MAX_PAGES, `cv.pdf has ${pages} pages`);
  // The counter itself: page objects only, not the /Pages tree root.
  assert.equal(pdfPageCount(Buffer.from("<< /Type /Pages >> << /Type /Page >> << /Type/Page /X 1 >> << /Type /Page >>")), 3);
  const dir = scratch();
  try {
    writeFileSync(join(dir, "public/cv.html"), readFileSync(join(dir, "public/cv.html"), "utf8").replace("</main>", "<p>x</p></main>"));
    assert.match(imageDrift(recorded, currentHashes(dir)).join("\n"), /cv: input public\/cv\.html changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
