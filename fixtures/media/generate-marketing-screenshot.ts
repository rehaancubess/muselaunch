/**
 * Generates `fixtures/render/screenshot-marketing.png`: a SYNTHETIC designed store screenshot for fixture
 * mode (headline on a purple background, the fixture app's "Today" screen inside a drawn phone). Its
 * geometry is sam-image-phone-screen.json at 3x (393x852 → 1179x2556): the screen is 729x1656 at (225,777).
 *
 *   pnpm tsx fixtures/media/generate-marketing-screenshot.ts
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../packages/agents/package.json"));
const sharp = require("sharp") as typeof import("sharp");

const W = 1179;
const H = 2556;
const screen = { x: 225, y: 777, w: 729, h: 1656, r: 90 };
const bezel = 27;

const shot = await sharp(join(here, "../render/screenshot-today.png")).resize(screen.w, screen.h, { fit: "cover", position: "top" }).png().toBuffer();
const roundedScreen = await sharp(shot)
  .composite([{ input: Buffer.from(`<svg width="${screen.w}" height="${screen.h}"><rect width="${screen.w}" height="${screen.h}" rx="${screen.r}" ry="${screen.r}"/></svg>`), blend: "dest-in" }])
  .png()
  .toBuffer();

const background = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6E6CF0"/><stop offset="1" stop-color="#4B49C8"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <text x="${W / 2}" y="330" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="112" font-weight="700" fill="#ffffff">Plan your</text>
  <text x="${W / 2}" y="460" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="112" font-weight="700" fill="#ffffff">focus day</text>
  <text x="${W / 2}" y="580" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="52" fill="#E4E3FF">Calm blocks, one glance</text>
  <rect x="${screen.x - bezel}" y="${screen.y - bezel}" width="${screen.w + 2 * bezel}" height="${screen.h + 2 * bezel}" rx="${screen.r + bezel}" ry="${screen.r + bezel}" fill="#111114"/>
</svg>`;

await sharp(Buffer.from(background))
  .composite([{ input: roundedScreen, left: screen.x, top: screen.y }])
  .png({ compressionLevel: 9 })
  .toFile(join(here, "../render/screenshot-marketing.png"));
console.log("wrote fixtures/render/screenshot-marketing.png (synthetic fixture)");
