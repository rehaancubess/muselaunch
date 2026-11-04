import { join } from "node:path";
import type { RegionPath } from "@muselaunch/contracts";
import { AppError, type JobContext } from "@muselaunch/platform";
import { deleteMetaFile, runSam, uploadMetaFile, type SamResult } from "@muselaunch/providers";
import { countVideoFrames, ffmpeg } from "./ffmpeg";
import { samFrameSize, type FrameSize } from "./masks";
import { callCtx } from "./util";

/**
 * Follow regions of real footage with SAM 3.1 (box prompts + video propagation) so overlays that were
 * placed on ONE still — a privacy blur over an API key, a focus zoom on a button — move with the
 * content when the screen scrolls or animates.
 *
 * - The stretch of the recording is cut to a small clip (TRACK_FPS, short edge TRACK_SHORT_EDGE px):
 *   SAM bills per frame, and 10 samples/s are plenty for smooth, interpolated motion.
 * - Each region becomes one object prompt (a box on the frame it was measured on); SAM propagates it
 *   forward and backward through the clip.
 * - SAM drives MOTION only: each output keeps the region's own size (the generous box Muse Spark drew)
 *   and moves/scales it with the tracked object. Frames where SAM lost the object hold the last known
 *   position (a blur never jumps away from what it hides).
 * - A track is only returned when SAM found the object where the prompt said it was and kept it for
 *   most of the clip; otherwise `null` (callers keep the static region — never less coverage).
 */

export const TRACK_FPS = 10;
export const TRACK_SHORT_EDGE = 540;
/** Longest stretch tracked in one call (walkthrough segments are ≤ 15 s). */
export const MAX_TRACK_SEC = 20;
/** Fraction of frames where SAM must see the object for its track to be used. */
export const MIN_TRACK_COVERAGE = 0.5;

export interface RegionToTrack {
  /** Fractions (0–1) of the source frame. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Seconds into the source where the region was measured. */
  anchorSec: number;
}

export interface TrackResult {
  /** One per input region: a path in source seconds, or null when the region could not be followed. */
  paths: (RegionPath | null)[];
  /** Why each null path was rejected (for logs/run steps). */
  reasons: (string | null)[];
  frames: number;
  model?: string;
}

type Box = { x: number; y: number; w: number; h: number };

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Even target size with the given short edge (never upscaled). */
export function clipSize(src: FrameSize, shortEdge = TRACK_SHORT_EDGE): FrameSize {
  const k = Math.min(1, shortEdge / Math.max(1, Math.min(src.width, src.height)));
  return { width: Math.max(2, Math.round((src.width * k) / 2) * 2), height: Math.max(2, Math.round((src.height * k) / 2) * 2) };
}

function overlap(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (!inter) return 0;
  // Either box mostly inside the other counts (SAM may pick the text inside a generous box, or the card around it).
  return Math.max(inter / Math.max(1e-9, a.w * a.h), inter / Math.max(1e-9, b.w * b.h));
}

/**
 * Turn SAM detections (clip pixels) into a path for one prompted region. Pure; exported for tests.
 * `boxes[f]` = the object's box on clip frame f (fractions), or undefined when not detected.
 */
export function pathFromBoxes(region: Box, anchorFrame: number, boxes: (Box | undefined)[], startSec: number, fps = TRACK_FPS): { path: RegionPath | null; reason: string | null } {
  const n = boxes.length;
  if (!n) return { path: null, reason: "no frames" };
  const seen = boxes.filter(Boolean).length;
  if (seen / n < MIN_TRACK_COVERAGE) return { path: null, reason: `tracked on ${Math.round((seen / n) * 100)}% of frames` };
  // The anchor detection: on the prompt frame (or the nearest frame within ±2).
  let anchor: Box | undefined;
  for (let d = 0; d <= 2 && !anchor; d++) anchor = boxes[anchorFrame - d] ?? boxes[anchorFrame + d];
  if (!anchor) return { path: null, reason: "not found on the prompted frame" };
  if (overlap(region, anchor) < 0.3) return { path: null, reason: "SAM followed something else than the region" };
  const ax = anchor.x + anchor.w / 2;
  const ay = anchor.y + anchor.h / 2;
  const aa = Math.max(1e-9, anchor.w * anchor.h);
  // Motion per frame (dx, dy, scale) relative to the anchor; gaps hold the nearest known motion.
  const motion: ({ dx: number; dy: number; s: number } | undefined)[] = boxes.map((b) => (b ? { dx: b.x + b.w / 2 - ax, dy: b.y + b.h / 2 - ay, s: clamp(Math.sqrt((b.w * b.h) / aa), 0.6, 1.6) } : undefined));
  let last = motion.find(Boolean)!;
  const held = motion.map((m) => (m ? (last = m) : last));
  // Centered moving average (3 frames) removes SAM jitter without inventing motion (ends stay as measured).
  const smooth = held.map((h, i) => {
    if (i === 0 || i === held.length - 1) return h;
    let dx = 0;
    let dy = 0;
    let s = 0;
    let k = 0;
    for (let j = i - 1; j <= i + 1; j++) {
      const m = held[j];
      if (!m) continue;
      dx += m.dx;
      dy += m.dy;
      s += m.s;
      k++;
    }
    return { dx: dx / k, dy: dy / k, s: s / k };
  });
  const cx0 = region.x + region.w / 2;
  const cy0 = region.y + region.h / 2;
  const points = smooth.map((m, f) => {
    const w = region.w * m.s;
    const h = region.h * m.s;
    const x0 = cx0 + m.dx - w / 2;
    const y0 = cy0 + m.dy - h / 2;
    const x = clamp(x0, 0, 1);
    const y = clamp(y0, 0, 1);
    return { t: r3(startSec + f / fps), x: r4(x), y: r4(y), w: r4(clamp(x0 + w, 0, 1) - x), h: r4(clamp(y0 + h, 0, 1) - y) };
  });
  // Drop samples that add nothing (static stretches), keep the ends.
  const out: RegionPath = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const prev = out[out.length - 1];
    const next = points[i + 1];
    const moved = !prev || Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) + Math.abs(p.w - prev.w) + Math.abs(p.h - prev.h) > 0.002;
    if (i === 0 || i === points.length - 1 || moved || (next && Math.abs(next.x - p.x) + Math.abs(next.y - p.y) > 0.002)) out.push(p);
  }
  if (out.length < 2) out.push({ ...out[0]!, t: r3(startSec + (n - 1) / fps) });
  return { path: out.slice(0, 300), reason: null };
}

/** Per-object boxes on each clip frame (fractions), from SAM output in SAM's pixel space. */
export function boxesByObject(result: SamResult, frameCount: number, size: FrameSize): Map<string, (Box | undefined)[]> {
  const sam = samFrameSize(result.rawOutput) ?? size;
  const out = new Map<string, (Box | undefined)[]>();
  for (const d of result.detections) {
    if (d.frame < 0 || d.frame >= frameCount) continue;
    const arr = out.get(d.objectId) ?? Array.from<Box | undefined>({ length: frameCount });
    const b = d.bounds;
    const box = { x: b.left / sam.width, y: b.top / sam.height, w: (b.right - b.left) / sam.width, h: (b.bottom - b.top) / sam.height };
    if (box.w > 0 && box.h > 0) arr[d.frame] = box;
    out.set(d.objectId, arr);
  }
  return out;
}

/**
 * Track regions of `src` (a local video file) between startSec and endSec. One SAM 3.1 call for all
 * regions. Throws provider errors (callers decide whether tracking is optional).
 */
export async function trackRegions(
  ctx: JobContext,
  input: { src: string; dir: string; size: FrameSize; startSec: number; endSec: number; regions: RegionToTrack[]; task: string },
): Promise<TrackResult> {
  const regions = input.regions.slice(0, 8);
  if (!regions.length) return { paths: [], reasons: [], frames: 0 };
  const start = Math.max(0, input.startSec);
  const dur = Math.min(MAX_TRACK_SEC, Math.max(0.3, input.endSec - start));
  const size = clipSize(input.size);
  const clip = join(input.dir, `track-${Math.round(start * 1000)}-${Math.random().toString(36).slice(2, 8)}.mp4`);
  await ffmpeg(
    ["-ss", start.toFixed(3), "-i", input.src, "-t", dur.toFixed(3), "-an", "-vf", `fps=${TRACK_FPS},scale=${size.width}:${size.height},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", clip],
    { signal: ctx.signal },
  );
  const frameCount = (await countVideoFrames(clip, { signal: ctx.signal })) ?? Math.max(1, Math.round(dur * TRACK_FPS));
  const px = (v: number, max: number) => clamp(Math.floor(v * max), 0, max - 1);
  const objects = regions.map((r, i) => {
    const frame = clamp(Math.round((r.anchorSec - start) * TRACK_FPS), 0, frameCount - 1);
    const left = px(r.x, size.width);
    const top = px(r.y, size.height);
    const right = clamp(Math.ceil((r.x + r.w) * size.width), left + 1, size.width);
    const bottom = clamp(Math.ceil((r.y + r.h) * size.height), top + 1, size.height);
    return { id: i + 1, prompts: [{ frame, box: { left, top, right, bottom } }] };
  });
  const cc = callCtx(ctx, input.task);
  let fileId: string | undefined;
  let result: SamResult;
  try {
    fileId = (await uploadMetaFile(ctx.platform, cc, { localPath: clip, filename: "track.mp4", mimeType: "video/mp4", expiresAfterSec: 3600 })).id;
    ctx.throwIfCancelled();
    result = await runSam(ctx.platform, cc, { media: { kind: "video", fileId }, prompt: { kind: "objects", options: { size, objects } }, propagation: "both", frameCount, timeoutMs: 180_000 });
  } finally {
    if (fileId) await deleteMetaFile(ctx.platform, fileId);
  }
  if (result.outcome.status !== "completed" && !result.detections.length) throw new AppError("PROVIDER_ERROR", "SAM 3.1 tracking ended without output", { retryable: true });
  const boxes = boxesByObject(result, frameCount, size);
  const paths: (RegionPath | null)[] = [];
  const reasons: (string | null)[] = [];
  regions.forEach((r, i) => {
    const b = boxes.get(String(i + 1));
    if (!b) {
      paths.push(null);
      reasons.push("SAM returned nothing for this region");
      return;
    }
    const { path, reason } = pathFromBoxes(r, objects[i]!.prompts[0]!.frame, b, start);
    paths.push(path);
    reasons.push(reason);
  });
  return { paths, reasons, frames: frameCount, model: result.model };
}
