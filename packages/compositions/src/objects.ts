/**
 * Object-aware compositing (SAM tracks → HyperFrames). Pure functions:
 * - map normalised source-clip coordinates to composition pixels through the layer that shows the clip,
 * - smooth + downsample per-frame tracks into deterministic GSAP keyframes,
 * - render effect layers (spotlight, outline-glow, focus-blur, highlight-ring, follow-arrow, screen-insert),
 * - anchor any layer to a tracked object.
 * When a track is missing or unreliable every feature falls back to a static, honest result.
 */
import type { Layer, ObjectAnchor, Scene, Segmentation, TracksFile } from "@muselaunch/contracts";

export type SegmentationInfo = Pick<Segmentation, "status" | "cutoutAssetId" | "trackingQuality" | "mediaType"> &
  Partial<Pick<Segmentation, "sourceAssetId" | "tracksAssetId" | "objectOutputs" | "maskAssetId">>;

type Track = TracksFile["tracks"][number];

/** Minimum fraction of visible frames for a track to drive motion/effects. */
export const MIN_TRACK_QUALITY = 0.5;
/** GSAP keyframe rate for tracked motion (smoothed, so 12/s reads as continuous). */
export const TRACK_SAMPLE_HZ = 12;

export interface ClipMapping {
  /** Displayed clip rect in composition pixels (after object-fit). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Source clip time at the start of the scene, and playback rate. */
  srcAt: (sceneT: number) => number;
  /** Layer that shows the clip (null = assumed full-frame cover). */
  layerId: string | null;
  trimInSec: number;
  rate: number;
  layerStart: number;
  /** Visible clip window in composition px (the layer box). */
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  fit: "cover" | "contain";
}

export interface TrackSample {
  /** Composition time (seconds, absolute). */
  t: number;
  visible: boolean;
  /** Object bbox and centroid in composition pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

/** Find how the segmentation's source clip is displayed in this scene. */
export function clipMapping(scene: Scene, seg: SegmentationInfo | undefined, tracks: TracksFile | undefined, W: number, H: number): ClipMapping {
  const src = seg?.sourceAssetId;
  // Masked copies reference the source asset too (the cutout swap happens at compile time).
  const shows = (l: Layer) => l.type === "video" && !l.hidden && src !== undefined && l.assetId === src;
  // Prefer the unmasked base clip; a masked copy has the same geometry.
  const candidates = scene.layers.filter(shows) as Extract<Layer, { type: "video" }>[];
  const base = candidates.find((l) => !l.mask) ?? candidates[0];
  const bx = base ? base.box.x * W : 0;
  const by = base ? base.box.y * H : 0;
  const bw = base ? base.box.w * W : W;
  const bh = base ? base.box.h * H : H;
  const fit = base?.fit ?? "cover";
  const sw = tracks?.width ?? W;
  const sh = tracks?.height ?? H;
  const scale = fit === "cover" ? Math.max(bw / sw, bh / sh) : Math.min(bw / sw, bh / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const trimInSec = base?.trimInSec ?? 0;
  const rate = base?.playbackRate ?? 1;
  const layerStart = base?.timing.start ?? 0;
  return {
    x: bx + (bw - dw) / 2,
    y: by + (bh - dh) / 2,
    w: dw,
    h: dh,
    srcAt: (sceneT) => trimInSec + Math.max(0, sceneT - layerStart) * rate,
    layerId: base?.id ?? null,
    trimInSec,
    rate,
    layerStart,
    boxX: bx,
    boxY: by,
    boxW: bw,
    boxH: bh,
    fit,
  };
}

export function trackQuality(track: Track): number {
  if (!track.frames.length) return 0;
  return track.frames.filter((f) => f.visible && f.bbox).length / track.frames.length;
}

export function findTrack(tracks: TracksFile | undefined, objectId: string): Track | undefined {
  return tracks?.tracks.find((t) => t.objectId === objectId);
}

/** Track usable for motion/effects? (segmentation succeeded, object present, quality ≥ threshold) */
export function trackUsable(seg: SegmentationInfo | undefined, tracks: TracksFile | undefined, objectId: string): { ok: boolean; reason?: string; track?: Track } {
  if (!seg) return { ok: false, reason: "segmentation not found" };
  if (seg.status !== "succeeded") return { ok: false, reason: `segmentation is ${seg.status}` };
  if (!tracks) return { ok: false, reason: "no tracks for this segmentation" };
  const track = findTrack(tracks, objectId);
  if (!track) return { ok: false, reason: `object ${objectId} is not in the tracks` };
  const q = trackQuality(track);
  if (q < MIN_TRACK_QUALITY) return { ok: false, reason: `tracking quality ${Math.round(q * 100)}% is too low` };
  return { ok: true, track };
}

/** Centered moving average over visible neighbours (removes SAM jitter without inventing positions). */
function smoothed(track: Track, window: number) {
  const fr = track.frames;
  const half = Math.max(0, Math.floor(window / 2));
  return fr.map((f, i) => {
    if (!f.visible || !f.bbox) return { visible: false as const };
    let n = 0;
    let x = 0;
    let y = 0;
    let w = 0;
    let h = 0;
    let cx = 0;
    let cy = 0;
    for (let k = i - half; k <= i + half; k++) {
      const g = fr[k];
      if (!g || !g.visible || !g.bbox) continue;
      n++;
      x += g.bbox.x;
      y += g.bbox.y;
      w += g.bbox.w;
      h += g.bbox.h;
      cx += g.centroid?.x ?? g.bbox.x + g.bbox.w / 2;
      cy += g.centroid?.y ?? g.bbox.y + g.bbox.h / 2;
    }
    return { visible: true as const, x: x / n, y: y / n, w: w / n, h: h / n, cx: cx / n, cy: cy / n };
  });
}

/**
 * Sample a track over a composition time window. Source time follows the clip layer
 * (trim + playback rate); positions are mapped into composition pixels.
 */
export function sampleTrack(track: Track, fps: number, map: ClipMapping, sceneStart: number, win: { start: number; end: number }, smoothFrames: number): TrackSample[] {
  const sm = smoothed(track, smoothFrames);
  const out: TrackSample[] = [];
  const step = 1 / TRACK_SAMPLE_HZ;
  const n = Math.max(1, Math.ceil((win.end - win.start) / step));
  for (let i = 0; i <= n; i++) {
    const t = Math.min(win.end, win.start + i * step);
    const srcT = map.srcAt(t - sceneStart);
    const idx = Math.max(0, Math.min(sm.length - 1, Math.round(srcT * fps)));
    const f = sm[idx];
    if (!f || !f.visible) {
      out.push({ t, visible: false, x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 });
      continue;
    }
    out.push({
      t,
      visible: true,
      x: map.x + f.x * map.w,
      y: map.y + f.y * map.h,
      w: f.w * map.w,
      h: f.h * map.h,
      cx: map.x + f.cx * map.w,
      cy: map.y + f.cy * map.h,
    });
  }
  return out;
}

/** Hold last known position across gaps (whenLost: "hold"). */
export function holdGaps(samples: TrackSample[]): TrackSample[] {
  let last: TrackSample | null = null;
  const firstVisible = samples.find((s) => s.visible) ?? null;
  return samples.map((s) => {
    if (s.visible) {
      last = s;
      return s;
    }
    const ref = last ?? firstVisible;
    return ref ? { ...ref, t: s.t, visible: true } : s;
  });
}

export function anchorPoint(s: TrackSample, point: ObjectAnchor["point"]): { x: number; y: number } {
  const l = s.x;
  const r = s.x + s.w;
  const t = s.y;
  const b = s.y + s.h;
  switch (point) {
    case "center":
      return { x: s.cx, y: s.cy };
    case "top":
      return { x: s.cx, y: t };
    case "bottom":
      return { x: s.cx, y: b };
    case "left":
      return { x: l, y: s.cy };
    case "right":
      return { x: r, y: s.cy };
    case "top-left":
      return { x: l, y: t };
    case "top-right":
      return { x: r, y: t };
    case "bottom-left":
      return { x: l, y: b };
    case "bottom-right":
      return { x: r, y: b };
  }
}

const n2 = (v: number) => Math.round(v * 100) / 100;
const n3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * GSAP statements that drive an element along samples. `props(s)` returns the tweened values for a
 * visible sample. Invisible stretches fade the element out (autoAlpha) and back in.
 */
export function trackTweens(sel: string, samples: TrackSample[], props: (s: TrackSample) => Record<string, number | string>, opts: { fadeLost: boolean }): string[] {
  const out: string[] = [];
  if (!samples.length) return out;
  const firstVisible = samples.find((s) => s.visible);
  if (!firstVisible) return out;
  const fmt = (o: Record<string, number | string | boolean>) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? n2(v) : v])));
  out.push(`tl.set(${sel}, ${fmt({ ...props(firstVisible), ...(opts.fadeLost ? { autoAlpha: samples[0]!.visible ? 1 : 0 } : {}) })}, ${n3(samples[0]!.t)});`);
  let prev = samples[0]!;
  let prevVisible = prev.visible;
  let lastVisible = prev.visible ? prev : firstVisible;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.visible) {
      if (lastVisible && prevVisible) {
        out.push(`tl.fromTo(${sel}, ${fmt(props(lastVisible))}, ${fmt({ ...props(s), duration: n3(s.t - prev.t), ease: "none", immediateRender: false })}, ${n3(prev.t)});`);
      } else {
        out.push(`tl.set(${sel}, ${fmt(props(s))}, ${n3(s.t)});`);
      }
      if (opts.fadeLost && !prevVisible) out.push(`tl.to(${sel}, {autoAlpha:1, duration:0.15, ease:"none"}, ${n3(s.t)});`);
      lastVisible = s;
    } else if (prevVisible && opts.fadeLost) {
      out.push(`tl.to(${sel}, {autoAlpha:0, duration:0.15, ease:"none"}, ${n3(prev.t)});`);
    }
    prevVisible = s.visible;
    prev = s;
  }
  return out;
}
