// npm run images: regenerates the icons, then the share card (which embeds icon-192.png), then
// records every input and output hash in designs/images.json (review R53).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST, currentHashes } from "../lib/images.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (...args) => execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });
run("designs/favicon/make-icons.cjs", "designs/favicon/chosen.svg");
run("designs/og/make-card.cjs");
writeFileSync(join(root, MANIFEST), JSON.stringify(currentHashes(root), null, 2) + "\n");
console.log(`wrote ${MANIFEST}`);
