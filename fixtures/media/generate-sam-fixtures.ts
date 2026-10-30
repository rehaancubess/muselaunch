/**
 * Generates SYNTHETIC SAM 3.1 fixtures in the documented wire format
 * (https://dev.meta.ai/docs/sam/reading-segmentation): `<Nf>id<|box;…;w;h;c|><|mask;x=0;y=0;c;data=H,W,!payload|>`.
 * Mask payloads are produced with the encoder shipped inside Meta's `@meta-sam/parser` (the same
 * codec its decoder validates), so parsing exercises the real decoder. These are NOT live outputs.
 *
 *   pnpm tsx fixtures/media/generate-sam-fixtures.ts
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../packages/providers/package.json"));
const parserIndex = require.resolve("@meta-sam/parser");
const { encodeSegmentationMask } = (await import(pathToFileURL(join(dirname(parserIndex), "mask-codec.js")).href)) as {
  encodeSegmentationMask: (raster: Uint8Array, width: number, height: number) => { payload: string };
};

/** Solid rectangle with rounded-off corners (so the mask is not trivially a box). */
function rectMask(w: number, h: number): Uint8Array {
  const r = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) r[y * w + x] = (x < 2 || x >= w - 2) && (y < 2 || y >= h - 2) ? 0 : 1;
  return r;
}

function record(id: number, x1: number, y1: number, w: number, h: number, frameW: number, frameH: number, c: number) {
  const { payload } = encodeSegmentationMask(rectMask(w, h), w, h);
  return `${id}<|box;x1=${x1};y1=${y1};x2=${x1 + w - 1};y2=${y1 + h - 1};w=${frameW};h=${frameH};c=${c}|><|mask;x=0;y=0;c=${c};data=${h},${w},${payload}|>`;
}

const LABEL = "SYNTHETIC fixture in the documented SAM 3.1 output format (masks encoded with @meta-sam/parser's codec). Not a live API response.";

// Video: 160x120 @10fps, 20 frames. Object 0 = red 40x60 box at x=10+3i, y=30 (matches the test clip).
// Object 1 = small 16x16 box at the top-right, visible only in frames 0-4.
{
  const W = 160, H = 120;
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) {
    const recs = [record(0, 10 + 3 * i, 30, 40, 60, W, H, 0.96)];
    if (i < 5) recs.push(record(1, 130, 8, 16, 16, W, H, 0.61));
    lines.push(`<${i}f>${recs.join(",")}`);
  }
  writeFileSync(join(here, "sam-video-moving-box.json"), JSON.stringify({ fixture: true, label: LABEL, media: "video", width: W, height: H, fps: 10, frames: 20, prompt: "red box", rawOutput: `${lines.join("\n")}\n` }, null, 2));
}

// Image: 96x64, one object 40x30 at (20,16).
{
  const W = 96, H = 64;
  writeFileSync(join(here, "sam-image-box.json"), JSON.stringify({ fixture: true, label: LABEL, media: "image", width: W, height: H, prompt: "red box", rawOutput: `<0f>${record(0, 20, 16, 40, 30, W, H, 0.92)}\n` }, null, 2));
}

// Box-prompt refinement result (one object, id from the request = 1) for the same clip.
{
  const W = 160, H = 120;
  const lines = Array.from({ length: 20 }, (_, i) => `<${i}f>${record(1, 10 + 3 * i, 30, 40, 60, W, H, 0.99)}`);
  writeFileSync(join(here, "sam-video-box-prompt.json"), JSON.stringify({ fixture: true, label: LABEL, media: "video", width: W, height: H, fps: 10, frames: 20, prompt: "box", rawOutput: `${lines.join("\n")}\n` }, null, 2));
}
// Clip analysis: 320x240 @10fps, 30 frames (see makeTestClip in packages/media/src/testing.ts).
// "person": one 80x140 subject moving right 4 px/frame, visible in all frames.
// "phone": object 0 = 24x40 phone moving diagonally (+5,+3 px/frame), visible frames 5–24;
//          object 1 = 20x30 static second phone at (270,10), visible in all frames.
{
  const W = 320, H = 240;
  const person = Array.from({ length: 30 }, (_, i) => `<${i}f>${record(0, 20 + 4 * i, 60, 80, 140, W, H, 0.97)}`);
  writeFileSync(join(here, "sam-clip-person.json"), JSON.stringify({ fixture: true, label: LABEL, media: "video", width: W, height: H, fps: 10, frames: 30, prompt: "person", rawOutput: `${person.join("\n")}\n` }, null, 2));
  const phone = Array.from({ length: 30 }, (_, i) => {
    const recs = [];
    if (i >= 5 && i <= 24) recs.push(record(0, 40 + 5 * i, 30 + 3 * i, 24, 40, W, H, 0.9));
    recs.push(record(1, 270, 10, 20, 30, W, H, 0.55));
    return `<${i}f>${recs.join(",")}`;
  });
  writeFileSync(join(here, "sam-clip-phone.json"), JSON.stringify({ fixture: true, label: LABEL, media: "video", width: W, height: H, fps: 10, frames: 30, prompt: "phone", rawOutput: `${phone.join("\n")}\n` }, null, 2));
}
// Store screenshot (designed marketing image), 393x852 frame (iPhone points; the dev fixture image is 3x):
// headline area on top, a phone whose screen is 243x552 at (75,259) with rounded corners (radius ≈30 px).
// "phone screen": object 0 = the headline block (landscape, high confidence: must NOT be chosen),
// object 1 = the phone screen. "headline only": just the headline block (no plausible screen → fallback).
{
  const W = 393, H = 852;
  /** Low-res raster (≈1/4 of the box) of a rounded rectangle. */
  const rounded = (w: number, h: number, r: number) => {
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dx = x < r ? r - x - 0.5 : x >= w - r ? x + 0.5 - (w - r) : 0;
        const dy = y < r ? r - y - 0.5 : y >= h - r ? y + 0.5 - (h - r) : 0;
        m[y * w + x] = dx && dy && Math.hypot(dx, dy) > r ? 0 : 1;
      }
    return m;
  };
  const rec = (id: number, x1: number, y1: number, bw: number, bh: number, raster: Uint8Array, rw: number, rh: number, c: number) => {
    const { payload } = encodeSegmentationMask(raster, rw, rh);
    return `${id}<|box;x1=${x1};y1=${y1};x2=${x1 + bw - 1};y2=${y1 + bh - 1};w=${W};h=${H};c=${c}|><|mask;x=0;y=0;c=${c};data=${rh},${rw},${payload}|>`;
  };
  const headline = rec(0, 40, 70, 313, 110, rectMask(40, 14), 40, 14, 0.97);
  const screen = rec(1, 75, 259, 243, 552, rounded(61, 138, 8), 61, 138, 0.88);
  writeFileSync(join(here, "sam-image-phone-screen.json"), JSON.stringify({ fixture: true, label: LABEL, media: "image", width: W, height: H, prompt: "phone screen", rawOutput: `<0f>${headline},${screen}\n` }, null, 2));
  writeFileSync(join(here, "sam-image-headline-only.json"), JSON.stringify({ fixture: true, label: LABEL, media: "image", width: W, height: H, prompt: "phone screen", rawOutput: `<0f>${headline}\n` }, null, 2));
}
console.log("wrote SAM fixtures");
