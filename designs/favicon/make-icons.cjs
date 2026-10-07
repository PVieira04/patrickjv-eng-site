// Turns the chosen favicon SVG into every icon file the site serves:
//   npm run images   (or: node designs/favicon/make-icons.cjs designs/favicon/chosen.svg)
// Writes public/favicon.svg, favicon.ico (16/32/48 PNGs in an ICO container), icon-192.png,
// icon-512.png and apple-touch-icon.png (180, full-bleed: iOS rounds the corners itself).
// sharp is a pinned devDependency (review R53).
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const src = process.argv[2];
const out = path.join(__dirname, "../../public");
const svg = fs.readFileSync(src, "utf8");
const png = (s, px) => sharp(Buffer.from(s), { density: Math.ceil((72 * px) / 64) * 2 }).resize(px, px).png().toBuffer();

// ICO with embedded PNGs (supported by every current browser).
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ px, buf }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(px >= 256 ? 0 : px, e); header.writeUInt8(px >= 256 ? 0 : px, e + 1);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(buf.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.buf)]);
}

(async () => {
  fs.writeFileSync(path.join(out, "favicon.svg"), svg);
  const sizes = await Promise.all([16, 32, 48].map(async (px) => ({ px, buf: await png(svg, px) })));
  fs.writeFileSync(path.join(out, "favicon.ico"), ico(sizes));
  fs.writeFileSync(path.join(out, "icon-192.png"), await png(svg, 192));
  fs.writeFileSync(path.join(out, "icon-512.png"), await png(svg, 512));
  // Apple touch icon: no rounded corners or transparency (square the background rect).
  const fullBleed = svg.replace(/(<rect class="bg"[^>]*?)\s+rx="[^"]*"/, "$1");
  fs.writeFileSync(path.join(out, "apple-touch-icon.png"), await sharp(await png(fullBleed, 180)).flatten({ background: "#0c0e11" }).png().toBuffer());
  for (const f of ["favicon.svg", "favicon.ico", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]) console.log(f, fs.statSync(path.join(out, f)).size, "bytes");
})();
