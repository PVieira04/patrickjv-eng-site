// The generated images (icons and share card) and everything they are made from. `npm run images`
// regenerates them and records designs/images.json; test/images.test.mjs fails when an input has
// changed since (regenerate) or an output no longer matches what was generated (hand-edited). Only
// hashes are compared, so CI never needs to run sharp (review R53).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST = "designs/images.json";
export const CV_MAX_PAGES = 2;

// Pages in a PDF, counted from the bytes: page objects are "/Type /Page" (the tree root is
// "/Type /Pages"). Chromium writes page dictionaries uncompressed; a PDF that hides them in
// compressed object streams counts 0, which the callers treat as a failure.
export function pdfPageCount(buf) {
  return (Buffer.from(buf).toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Each input is a file, or a named value derived from one (only the content.json fields the card
// draws, so unrelated copy edits do not invalidate it). Tool versions (sharp, playwright-core) are
// deliberately not inputs: a Dependabot bump can't run `npm run images`, and the committed images
// stay correct after one. They're regenerated with the current tools when what they draw changes.
export function imageSets(root) {
  const file = (p) => [p, () => readFileSync(join(root, p))];
  const fonts = readdirSync(join(root, "designs/og/fonts")).sort().map((f) => file(`designs/og/fonts/${f}`));
  return {
    icons: {
      inputs: [file("designs/favicon/chosen.svg"), file("designs/favicon/make-icons.cjs")],
      outputs: ["public/favicon.svg", "public/favicon.ico", "public/icon-192.png", "public/icon-512.png", "public/apple-touch-icon.png"],
    },
    card: {
      inputs: [
        file("designs/og/make-card.cjs"),
        ["content.json person.{name,headline,tagline}", () => {
          const { name, headline, tagline } = JSON.parse(readFileSync(join(root, "content.json"), "utf8")).person;
          return JSON.stringify({ name, headline, tagline });
        }],
        file("public/photo.webp"),
        file("public/icon-192.png"),
        ...fonts,
      ],
      outputs: ["public/og-card.jpg"],
    },
    // The PDF is not byte-reproducible (Chromium stamps a creation date), so it is pinned by its
    // inputs; regenerating writes a new output hash with them.
    cv: {
      inputs: [
        file("public/cv.html"), file("designs/make-cv-pdf.mjs"),
        ...readdirSync(join(root, "public/fonts")).filter((f) => f.endsWith(".woff2")).sort().map((f) => file(`public/fonts/${f}`)),
      ],
      outputs: ["public/cv.pdf"],
    },
  };
}

// { set: { inputs: { name: sha256 }, outputs: { path: sha256 } } }
export function currentHashes(root) {
  const out = {};
  for (const [name, set] of Object.entries(imageSets(root))) {
    out[name] = {
      inputs: Object.fromEntries(set.inputs.map(([k, read]) => [k, sha256(read())])),
      outputs: Object.fromEntries(set.outputs.map((p) => [p, sha256(readFileSync(join(root, p)))])),
    };
  }
  return out;
}

// Human-readable differences between the recorded manifest and the files now.
export function imageDrift(recorded, now) {
  const errors = [];
  for (const [name, set] of Object.entries(now)) {
    const rec = recorded?.[name];
    if (!rec) { errors.push(`${name}: not in ${MANIFEST} (run npm run images)`); continue; }
    for (const kind of ["inputs", "outputs"]) {
      const keys = new Set([...Object.keys(set[kind]), ...Object.keys(rec[kind] ?? {})]);
      for (const k of keys) {
        if (set[kind][k] === rec[kind]?.[k]) continue;
        errors.push(kind === "inputs"
          ? `${name}: input ${k} changed since the images were generated (run npm run images)`
          : `${name}: ${k} differs from what npm run images generated (hand-edited? run npm run images)`);
      }
    }
  }
  return errors;
}
