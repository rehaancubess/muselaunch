import { open, readFile, stat } from "node:fs/promises";
import { ffmpeg } from "./ffmpeg";

/**
 * Frame-level helpers for walkthrough breakdown and screenshot work (FFmpeg only, no image library):
 * - sampled frame changes (share of pixels that changed between samples) → shot detection;
 * - single-frame extraction (keyframes), downscaled JPEGs and tiny grayscale thumbnails.
 */

/** Samples per second used for shot detection, and the tiny RGB frame they are compared at. */
export const SAMPLE_FPS = 6;
const SAMPLE_W = 54;
const SAMPLE_H = 96;
/** A pixel "changed" when any channel moved by more than this (0–255). */
const PIXEL_DELTA = 24;

export interface FrameChanges {
  fps: number;
  /** Sample times (s); sample i is at i / fps. */
  times: number[];
  /** change[i] = share of pixels (0–1) that changed from sample i−1 to i; change[0] = 0. */
  change: number[];
}

/**
 * Decode the video once at `fps` into tiny RGB frames (written to `scratch`) and measure how much of the
 * picture changes between consecutive samples. Streams the file in chunks (≈15 KB per sample).
 */
export async function sampleFrameChanges(input: string, scratch: string, opts: { fps?: number; signal?: AbortSignal } = {}): Promise<FrameChanges> {
  const fps = opts.fps ?? SAMPLE_FPS;
  await ffmpeg(["-i", input, "-an", "-sn", "-vf", `fps=${fps},scale=${SAMPLE_W}:${SAMPLE_H}:flags=area,format=rgb24`, "-f", "rawvideo", scratch], { signal: opts.signal, timeoutMs: 30 * 60_000 });
  const frameBytes = SAMPLE_W * SAMPLE_H * 3;
  const total = Math.floor((await stat(scratch)).size / frameBytes);
  const change: number[] = [];
  const fh = await open(scratch, "r");
  try {
    const batch = 64;
    const buf = Buffer.alloc(frameBytes * batch);
    let prev: Buffer | null = null;
    for (let read = 0; read < total; ) {
      const n = Math.min(batch, total - read);
      await fh.read(buf, 0, n * frameBytes, read * frameBytes);
      for (let k = 0; k < n; k++) {
        const cur = buf.subarray(k * frameBytes, (k + 1) * frameBytes);
        change.push(prev ? changedShare(prev, cur) : 0);
        prev = Buffer.from(cur);
      }
      read += n;
    }
  } finally {
    await fh.close();
  }
  return { fps, times: change.map((_, i) => Math.round((i / fps) * 1000) / 1000), change };
}

function changedShare(a: Buffer, b: Buffer): number {
  let changed = 0;
  const px = a.length / 3;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i]! - b[i]!) > PIXEL_DELTA || Math.abs(a[i + 1]! - b[i + 1]!) > PIXEL_DELTA || Math.abs(a[i + 2]! - b[i + 2]!) > PIXEL_DELTA) changed++;
  }
  return changed / px;
}

export interface Shot {
  startSec: number;
  endSec: number;
  /** Long stretch of continuous change (scrolling, an animation or video in the app). */
  motion: boolean;
}

export const SHOT_RULES = {
  /** A sample with at least this share of changed pixels is part of a change. */
  changeThreshold: 0.04,
  /** Changes up to this long are transitions between shots (excluded); longer ones are motion shots. */
  maxTransitionSec: 1.0,
  /** Shots shorter than this are merged into a neighbour. */
  minShotSec: 0.8,
  /** Shots longer than this are split at the calmest moments. */
  maxShotSec: 8,
  /** How far from an even split point to look for a calm moment. */
  splitSearchSec: 1.5,
  /** Hard cap (very fast tapping): the shortest shots are merged until it fits. */
  maxShots: 120,
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Shots from sampled frame changes. A run of changing samples ≤ maxTransitionSec is a cut: the
 * previous shot ends on the last unchanged sample and the next starts once the picture settles
 * (transition frames belong to neither). Longer runs become their own "motion" shots. Then micro-shots
 * are merged into the following shot, long shots are split at their calmest sample near even split
 * points, and the count is capped.
 */
export function detectShots(d: FrameChanges, durationSec: number, rules = SHOT_RULES): Shot[] {
  const n = d.change.length;
  const t = (i: number) => d.times[i] ?? i / d.fps;
  const spans: Shot[] = [];
  const push = (startSec: number, endSec: number, motion: boolean) => {
    const end = Math.min(endSec, durationSec);
    if (end - startSec >= 0.05) spans.push({ startSec: r3(Math.max(0, startSec)), endSec: r3(end), motion });
  };
  let shotStart = 0;
  for (let i = 1; i < n; i++) {
    if (d.change[i]! < rules.changeThreshold) continue;
    let j = i;
    while (j + 1 < n && d.change[j + 1]! >= rules.changeThreshold) j++;
    const runStart = t(i - 1);
    const runEnd = t(j);
    push(shotStart, runStart, false);
    if (runEnd - runStart > rules.maxTransitionSec) push(runStart, runEnd, true);
    shotStart = runEnd;
    i = j;
  }
  push(shotStart, durationSec, false);
  if (!spans.length && durationSec > 0) spans.push({ startSec: 0, endSec: r3(durationSec), motion: false });

  // Micro-shots → merged into the next shot (the transient leads into it), or the previous one at the end.
  const merged: Shot[] = [];
  let carry: Shot | null = null;
  for (const s of spans) {
    const cur: Shot = carry ? { startSec: carry.startSec, endSec: s.endSec, motion: carry.motion || s.motion } : { ...s };
    carry = null;
    if (cur.endSec - cur.startSec < rules.minShotSec) carry = cur;
    else merged.push(cur);
  }
  if (carry) {
    const last = merged[merged.length - 1];
    if (last) merged[merged.length - 1] = { startSec: last.startSec, endSec: carry.endSec, motion: last.motion || carry.motion };
    else merged.push(carry);
  }

  // Long shots → split at the calmest sample near each even split point.
  const out: Shot[] = [];
  for (const s of merged) {
    const len = s.endSec - s.startSec;
    if (len <= rules.maxShotSec) {
      out.push(s);
      continue;
    }
    const parts = Math.ceil(len / rules.maxShotSec);
    let from = s.startSec;
    for (let k = 1; k < parts; k++) {
      const target = s.startSec + (k * len) / parts;
      const lo = Math.max(from + rules.minShotSec, target - rules.splitSearchSec);
      const hi = Math.min(s.endSec - rules.minShotSec, target + rules.splitSearchSec);
      let best = target;
      let bestScore = Infinity;
      for (let i = Math.max(0, Math.floor(lo * d.fps)); i < n && t(i) <= hi; i++) {
        if (t(i) < lo) continue;
        const score = d.change[i]! + (d.change[i + 1] ?? 0) + Math.abs(t(i) - target) * 1e-4;
        if (score < bestScore) {
          bestScore = score;
          best = t(i);
        }
      }
      if (best - from < rules.minShotSec || s.endSec - best < rules.minShotSec) continue;
      out.push({ startSec: r3(from), endSec: r3(best), motion: s.motion });
      from = best;
    }
    out.push({ startSec: r3(from), endSec: s.endSec, motion: s.motion });
  }

  // Cap: merge the shortest shot with its shorter neighbour.
  while (out.length > rules.maxShots) {
    let k = 0;
    for (let i = 1; i < out.length; i++) if (out[i]!.endSec - out[i]!.startSec < out[k]!.endSec - out[k]!.startSec) k = i;
    const left = out[k - 1];
    const right = out[k + 1];
    const withLeft = left && (!right || left.endSec - left.startSec <= right.endSec - right.startSec);
    const a = withLeft ? k - 1 : k;
    const x = out[a]!;
    const y = out[a + 1]!;
    out.splice(a, 2, { startSec: x.startSec, endSec: y.endSec, motion: x.motion || y.motion });
  }
  return out;
}

/** Times to sample stills from a shot: the middle, or a third and two thirds in for longer shots. */
export function keyframeTimes(s: Pick<Shot, "startSec" | "endSec">, twoFramesFromSec = 4): number[] {
  const len = s.endSec - s.startSec;
  if (len < twoFramesFromSec) return [r3(s.startSec + len / 2)];
  return [r3(s.startSec + len / 3), r3(s.startSec + (2 * len) / 3)];
}

/** One still as JPEG, short edge ≤ `shortEdge` px (accurate seek). */
export async function extractFrame(input: string, atSec: number, out: string, opts: { shortEdge?: number; signal?: AbortSignal } = {}): Promise<void> {
  const e = opts.shortEdge ?? 540;
  const scale = `scale='if(gt(iw,ih),-2,min(${e},iw))':'if(gt(iw,ih),min(${e},ih),-2)'`;
  await ffmpeg(["-ss", Math.max(0, atSec).toFixed(3), "-i", input, "-frames:v", "1", "-an", "-vf", scale, "-q:v", "4", out], { signal: opts.signal, timeoutMs: 120_000 });
  const ok = await stat(out).then((s) => s.size > 0).catch(() => false);
  // Seeking to the very end can yield no frame: step back once.
  if (!ok && atSec > 0.5) await extractFrame(input, atSec - 0.5, out, opts);
}

/** Downscaled JPEG copy of an image (long edge ≤ maxEdge), for model inputs. */
export async function downscaleImage(input: string, out: string, maxEdge: number, opts: { quality?: number; signal?: AbortSignal } = {}): Promise<void> {
  const scale = `scale='if(gte(iw,ih),min(${maxEdge},iw),-2)':'if(gte(iw,ih),-2,min(${maxEdge},ih))'`;
  await ffmpeg(["-i", input, "-frames:v", "1", "-vf", `${scale},format=yuvj444p`, "-q:v", String(opts.quality ?? 3), out], { signal: opts.signal, timeoutMs: 120_000 });
}

/** Tiny grayscale raster (w×h bytes, aspect not kept) for cheap image statistics. */
export async function grayThumbnail(input: string, scratch: string, w: number, h: number, signal?: AbortSignal): Promise<Buffer> {
  await ffmpeg(["-i", input, "-frames:v", "1", "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", scratch], { signal, timeoutMs: 60_000 });
  const buf = await readFile(scratch);
  return buf.subarray(0, w * h);
}

/** Run async work over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
