// Builds public/og-card.jpg (1200x630) for link previews, in the site's technical-drawing style.
//   npm run images   (or: node designs/og/make-card.cjs, after the icons)
// Fonts come only from designs/og/fonts/ (IBM Plex, OFL): fontconfig is pointed at a config that
// lists that folder alone, so installed system fonts can never change the result (review R53).
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = path.join(__dirname, "../..");
const fcDir = fs.mkdtempSync(path.join(os.tmpdir(), "og-fontconfig-"));
fs.writeFileSync(path.join(fcDir, "fonts.conf"), `<?xml version="1.0"?>
<fontconfig><dir>${path.join(__dirname, "fonts")}</dir><cachedir>${path.join(fcDir, "cache")}</cachedir></fontconfig>
`);
process.env.FONTCONFIG_FILE = path.join(fcDir, "fonts.conf"); // must be set before sharp loads
const sharp = require("sharp");
const c = JSON.parse(fs.readFileSync(path.join(root, "content.json"), "utf8"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const W = 1200, H = 630, P = 420, PX = 72, PY = 105;
const bg = "#0c0e11", ink = "#e7e9ec", muted = "#9aa3ae", line = "#262b33", signal = "#ffb547";

// Wrap the tagline at ~42 characters per line.
const words = c.person.tagline.split(" ");
const lines = [];
for (const w of words) { const l = lines.at(-1); if (l && (l + " " + w).length <= 42) lines[lines.length - 1] = l + " " + w; else lines.push(w); }

const grid = [];
for (let x = 0; x <= W; x += 30) grid.push(`<path d="M${x} 0V${H}"/>`);
for (let y = 0; y <= H; y += 30) grid.push(`<path d="M0 ${y}H${W}"/>`);
const corner = (x, y, dx, dy) => `<path d="M${x} ${y + 22 * dy}V${y}H${x + 22 * dx}"/>`;
const TX = PX + P + 64;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <g stroke="#ffffff" stroke-opacity="0.035" stroke-width="1">${grid.join("")}</g>
  <rect x="24.5" y="24.5" width="${W - 49}" height="${H - 49}" fill="none" stroke="${line}"/>
  <g fill="none" stroke="${signal}" stroke-width="3">
    ${corner(PX - 14, PY - 14, 1, 1)}${corner(PX + P + 14, PY - 14, -1, 1)}${corner(PX - 14, PY + P + 14, 1, -1)}${corner(PX + P + 14, PY + P + 14, -1, -1)}
  </g>
  <text x="${PX}" y="${PY + P + 48}" font-family="IBM Plex Mono" font-size="17" letter-spacing="2" fill="${muted}">FIG. 01 — P. VIEIRA</text>
  <rect x="${TX}" y="138" width="12" height="12" fill="${signal}"/>
  <text x="${TX + 26}" y="150" font-family="IBM Plex Mono" font-size="19" letter-spacing="3" fill="${muted}">PROFILE</text>
  <text x="${TX - 4}" y="238" font-family="IBM Plex Sans" font-weight="600" font-size="74" fill="${ink}">${esc(c.person.name)}</text>
  <text x="${TX}" y="292" font-family="IBM Plex Mono" font-size="28" fill="${signal}">${esc(c.person.headline)} · London</text>
  ${lines.map((l, i) => `<text x="${TX}" y="${362 + i * 38}" font-family="IBM Plex Sans" font-size="27" fill="${ink}" fill-opacity="0.86">${esc(l)}</text>`).join("\n  ")}
  <text x="${TX}" y="${H - 64}" font-family="IBM Plex Mono" font-weight="500" font-size="24" letter-spacing="1" fill="${ink}">patrickjv.com</text>
</svg>`;

(async () => {
  const photo = await sharp(path.join(root, "public/photo.webp")).resize(P, P).toBuffer();
  const icon = await sharp(path.join(root, "public/icon-192.png")).resize(64, 64).toBuffer();
  const out = path.join(root, "public/og-card.jpg");
  await sharp(Buffer.from(svg)).composite([{ input: photo, left: PX, top: PY }, { input: icon, left: W - 64 - 64, top: H - 64 - 52 }]).jpeg({ quality: 86, mozjpeg: true }).toFile(out);
  console.log("og-card.jpg", fs.statSync(out).size, "bytes;", lines.length, "tagline lines");
  fs.rmSync(fcDir, { recursive: true, force: true });
})();
