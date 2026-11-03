// Draws the app icon, Android adaptive icon layers, splash image, favicon and notification icon
// from the MuseLaunch logo (graphite gradient rounded square, white four-point sparkle).
// The PNGs are committed; run this only to change them. It uses sharp from the monorepo:
//   pnpm install            (at the repo root, once)
//   node mobile/scripts/make-icons.mjs
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "assets");
const require = createRequire(join(here, "..", "..", "packages", "agents", "package.json"));
const sharp = require("sharp");

const SPARKLE = "M16 6C17.2 12 20 14.8 26 16 20 17.2 17.2 20 16 26 14.8 20 12 17.2 6 16 12 14.8 14.8 12 16 6Z";
const GRADIENT = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1.2"><stop offset="0" stop-color="#5a5a60"/><stop offset=".52" stop-color="#1d1d1f"/><stop offset="1" stop-color="#000000"/></linearGradient></defs>`;
const sparkle = (scale, fill = "#fff") => `<path d="${SPARKLE}" fill="${fill}" transform="translate(16 16) scale(${scale}) translate(-16 -16)"/>`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`;

const files = {
  // iOS / store icon: full bleed (iOS rounds the corners), no transparency.
  "icon.png": [svg(`${GRADIENT}<rect width="32" height="32" fill="url(#g)"/>${sparkle(0.86)}`), 1024],
  // Android adaptive icon: gradient background layer + sparkle inside the 66% safe zone.
  "adaptive-icon-background.png": [svg(`${GRADIENT}<rect width="32" height="32" fill="url(#g)"/>`), 1024],
  "adaptive-icon.png": [svg(sparkle(0.72)), 1024],
  "adaptive-icon-monochrome.png": [svg(sparkle(0.72)), 1024],
  // Splash: the logo itself, on white.
  "splash-icon.png": [svg(`${GRADIENT}<rect width="32" height="32" rx="9" fill="url(#g)"/>${sparkle(1)}`), 1024],
  "favicon.png": [svg(`${GRADIENT}<rect width="32" height="32" rx="9" fill="url(#g)"/>${sparkle(1)}`), 96],
  // Android notification icon: white on transparent (Android tints it with the brand colour).
  "notification-icon.png": [svg(sparkle(1.25)), 96],
};

mkdirSync(assets, { recursive: true });
for (const [name, [source, size]] of Object.entries(files)) {
  await sharp(Buffer.from(source), { density: (72 * size) / 32 })
    .resize(size, size)
    .png()
    .toFile(join(assets, name));
  console.log(`assets/${name} (${size}×${size})`);
}
