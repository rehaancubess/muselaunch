/**
 * Generates SYNTHETIC SAM 3.1 outputs for the presenter fixture clip
 * (fixtures/render/presenter/presenter.mp4, 720x1280 @30fps, 6 s): what SAM would return for the
 * prompts "person" and "phone". Silhouettes are rasterised from the same motion model that drew the
 * clip (fixtures/render/presenter/motion.mjs), at half resolution, and encoded with the codec inside
 * Meta's `@meta-sam/parser`, so fixture mode exercises the real decoder, tracks, mattes and cutouts.
 * These are NOT live outputs; dev-fixture uses them when a clip is analysed for person/phone.
 *
 *   pnpm tsx fixtures/media/generate-presenter-sam.ts
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
type Pose = {
  head: { cx: number; cy: number; rx: number; ry: number };
  torso: { x: number; y: number; w: number; h: number };
  neck: { x: number; y: number; w: number; h: number };
  phone: { x: number; y: number; w: number; h: number; r: number };
  elbow: { x: number; y: number };
  grip: { x: number; y: number };
};
const motion = (await import(pathToFileURL(join(here, "../render/presenter/motion.mjs")).href)) as { W: number; H: number; FPS: number; DURATION: number; pose: (t: number) => Pose };

const S = 0.5; // SAM frame = half the clip's resolution
const FW = Math.round(motion.W * S);
const FH = Math.round(motion.H * S);
const FRAMES = Math.round(motion.DURATION * motion.FPS);

type Test = (x: number, y: number) => boolean; // clip-space pixel centre
const rrect = (x: number, y: number, w: number, h: number, r: number): Test => (px, py) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};
const ellipse = (cx: number, cy: number, rx: number, ry: number): Test => (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
const capsule = (ax: number, ay: number, bx: number, by: number, r: number): Test => (px, py) => {
  const dx = bx - ax, dy = by - ay;
  const k = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return (px - (ax + k * dx)) ** 2 + (py - (ay + k * dy)) ** 2 <= r * r;
};

function shapes(t: number): { person: Test; phone: Test } {
  const p = motion.pose(t);
  const ph = rrect(p.phone.x, p.phone.y, p.phone.w, p.phone.h, p.phone.r);
  const body: Test[] = [
    rrect(p.torso.x, p.torso.y, p.torso.w, p.torso.h, 120),
    rrect(p.neck.x, p.neck.y, p.neck.w, p.neck.h, 26),
    ellipse(p.head.cx, p.head.cy, p.head.rx, p.head.ry),
    rrect(p.head.cx - p.head.rx - 6, p.head.cy - p.head.ry - 18, p.head.rx * 2 + 12, p.head.ry * 0.95, 30),
    ellipse(p.head.cx - p.head.rx - 2, p.head.cy + 7, 10, 17),
  ];
  // Arm, hand and fingers are in front of the phone; the body behind it is occluded.
  const front: Test[] = [
    capsule(p.elbow.x, p.elbow.y, p.grip.x, p.grip.y, 48),
    rrect(p.grip.x - 56, p.grip.y - 60, 96, 118, 44),
    rrect(p.phone.x - 22, p.phone.y + p.phone.h * 0.6, 40, 22, 11),
    rrect(p.phone.x - 24, p.phone.y + p.phone.h * 0.6 + 27, 42, 22, 11),
    rrect(p.phone.x - 22, p.phone.y + p.phone.h * 0.6 + 54, 38, 22, 11),
    rrect(p.phone.x + p.phone.w - 20, p.phone.y + p.phone.h * 0.7, 30, 68, 15),
  ];
  return {
    person: (x, y) => front.some((f) => f(x, y)) || (!ph(x, y) && body.some((f) => f(x, y))),
    phone: (x, y) => ph(x, y) && !front.some((f) => f(x, y)),
  };
}

/** Rasterise a shape at SAM resolution; returns the record for this frame or null when empty. */
function record(id: number, test: Test, c: number): string | null {
  let x0 = FW, y0 = FH, x1 = -1, y1 = -1;
  const full = new Uint8Array(FW * FH);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      if (!test((x + 0.5) / S, (y + 0.5) / S)) continue;
      full[y * FW + x] = 1;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const raster = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) raster.set(full.subarray((y0 + y) * FW + x0, (y0 + y) * FW + x0 + w), y * w);
  const { payload } = encodeSegmentationMask(raster, w, h);
  return `${id}<|box;x1=${x0};y1=${y0};x2=${x1};y2=${y1};w=${FW};h=${FH};c=${c}|><|mask;x=0;y=0;c=${c};data=${h},${w},${payload}|>`;
}

const LABEL = "SYNTHETIC fixture in the documented SAM 3.1 output format for the presenter test clip (silhouettes rasterised from its motion model; masks encoded with @meta-sam/parser's codec). Not a live API response.";
for (const prompt of ["person", "phone"] as const) {
  const lines: string[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const rec = record(0, shapes(i / motion.FPS)[prompt], prompt === "person" ? 0.97 : 0.93);
    if (rec) lines.push(`<${i}f>${rec}`);
  }
  const file = join(here, `sam-presenter-${prompt}.json`);
  writeFileSync(file, JSON.stringify({ fixture: true, label: LABEL, media: "video", clip: "fixtures/render/presenter/presenter.mp4", width: FW, height: FH, fps: motion.FPS, frames: FRAMES, prompt, rawOutput: `${lines.join("\n")}\n` }, null, 2));
  console.log(`wrote ${file}`);
}
