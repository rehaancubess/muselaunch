// Synthetic presenter fixture: ONE deterministic motion model shared by the HTML scene
// (rendered to presenter.mp4 + per-object alpha cutouts) and the ground-truth tracks JSON.
// This stands in for a real founder clip + SAM output in automated render tests.
export const W = 720;
export const H = 1280;
export const FPS = 30;
export const DURATION = 6;

const TAU = Math.PI * 2;
export function pose(t) {
  const sway = 10 * Math.sin((TAU * t) / 3.4);
  const nod = 4 * Math.sin((TAU * t) / 1.7 + 0.4);
  // Phone path: raised toward camera, drifting right and up, then settling.
  const px = 486 + 40 * Math.sin((TAU * t) / 4.6) + sway * 0.6;
  const py = 772 - 54 * Math.sin((TAU * t) / 3.9 + 0.5);
  return {
    sway,
    head: { cx: 312 + sway, cy: 352 + nod, rx: 66, ry: 84 },
    torso: { x: 96 + sway * 0.8, y: 520, w: 420, h: 820 },
    neck: { x: 282 + sway, y: 418 + nod * 0.5, w: 62, h: 120 },
    phone: { x: px - 84, y: py - 172, w: 168, h: 344, r: 26 },
    // Forearm from the elbow (low right of the torso) to the phone's lower-left grip.
    elbow: { x: 432 + sway * 0.8, y: 1040 },
    grip: { x: px - 60, y: py + 168 },
  };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function union(boxes) {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function norm(b) {
  const x0 = clamp(b.x, 0, W);
  const y0 = clamp(b.y, 0, H);
  const x1 = clamp(b.x + b.w, 0, W);
  const y1 = clamp(b.y + b.h, 0, H);
  return { x: +(x0 / W).toFixed(4), y: +(y0 / H).toFixed(4), w: +((x1 - x0) / W).toFixed(4), h: +((y1 - y0) / H).toFixed(4) };
}

export function boxes(t) {
  const p = pose(t);
  const head = { x: p.head.cx - p.head.rx, y: p.head.cy - p.head.ry - 18, w: p.head.rx * 2, h: p.head.ry * 2 + 18 };
  const arm = union([
    { x: p.elbow.x - 40, y: p.elbow.y - 40, w: 80, h: 80 },
    { x: p.grip.x - 46, y: p.grip.y - 60, w: 120, h: 110 },
  ]);
  return { person: norm(union([head, p.torso, arm])), phone: norm(p.phone) };
}

export function tracksFor(object) {
  const frameCount = Math.round(DURATION * FPS);
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const t = i / FPS;
    const b = boxes(t)[object];
    frames.push({ t: +t.toFixed(4), visible: true, bbox: b, centroid: { x: +(b.x + b.w / 2).toFixed(4), y: +(b.y + b.h / 2).toFixed(4) }, area: +(b.w * b.h * 0.8).toFixed(4), score: 0.97 });
  }
  return { fps: FPS, frameCount, width: W, height: H, tracks: [{ objectId: "0", label: object, frames }] };
}
