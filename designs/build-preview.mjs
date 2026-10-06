// Copies the six candidates into preview/1..6 in random order and writes a gallery page.
// The mapping goes to mapping.json, which is NOT inside preview/ and is never deployed.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
const ids = ["claude-a", "claude-b", "claude-c", "codex-1", "codex-2", "codex-3"];
for (const id of ids) if (!existsSync(`${id}/index.html`)) throw new Error(`missing ${id}/index.html`);
const order = [...ids].sort(() => Math.random() - 0.5);
rmSync("preview", { recursive: true, force: true });
order.forEach((id, i) => {
  mkdirSync(`preview/${i + 1}`, { recursive: true });
  // Strip identifying comments/meta generators so the source tool isn't obvious.
  const html = readFileSync(`${id}/index.html`, "utf8").replace(/<meta name="generator"[^>]*>/gi, "");
  writeFileSync(`preview/${i + 1}/index.html`, html);
});
const cards = order.map((_, i) => `<li><a href="/${i + 1}/">Design ${i + 1}</a></li>`).join("\n");
writeFileSync("preview/index.html", `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Design candidates</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 16px;background:#fff;color:#111}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}a{color:#9cf}}li{margin:.6rem 0;font-size:1.25rem}</style></head>
<body><h1>patrickjv.com — six candidates</h1><p>Numbered in random order. Open each on desktop and on your phone.</p><ol style="list-style:none;padding:0">${cards}</ol></body></html>\n`);
writeFileSync("preview/robots.txt", "User-agent: *\nDisallow: /\n");
writeFileSync("mapping.json", JSON.stringify(Object.fromEntries(order.map((id, i) => [i + 1, id])), null, 2) + "\n");
console.log("built preview/1..6 (mapping in mapping.json)");
