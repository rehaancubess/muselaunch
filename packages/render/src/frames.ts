/**
 * Frames for Spark's video review (Node only, FFmpeg): which instants of a rendered MP4 to look at,
 * and extracting them as small JPEGs. Template-agnostic: the plan only needs scene spans.
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@muselaunch/platform";
import { probe } from "./media";
import { ffmpegBin } from "./producer";

/** At most this many frames per review (prompt size and cost). */
export const REVIEW_FRAME_LIMIT = 16;
/** Scenes at least this long get two extra samples (early + late) when the limit allows. */
export const LONG_SCENE_SEC = 4;
/** Frames are scaled so their shorter side is about this many pixels. */
export const REVIEW_FRAME_SHORT_SIDE = 540;

export interface SceneSpan {
  id: string;
  startSec: number;
  durationSec: number;
}

export interface FramePlanItem {
  /** "f1", "f2"… in time order. */
  ref: string;
  atSec: number;
  sceneId?: string;
  kind: "first" | "mid" | "early" | "late";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Scene containing time `t` (the last scene for t at or past the end). */
export function sceneAtTime(scenes: SceneSpan[], t: number): SceneSpan | undefined {
  return scenes.find((s) => t >= s.startSec && t < s.startSec + s.durationSec) ?? (t >= 0 ? scenes[scenes.length - 1] : undefined);
}

/**
 * Which frames to review: the very first frame, every scene's mid-point, plus an early and a late
 * frame of each long scene (longest first) while the limit allows. With more scenes than the limit,
 * mid-points are sampled evenly (first and last scene always kept).
 */
export function planReviewFrames(scenes: SceneSpan[], opts: { totalSec?: number; max?: number; longSceneSec?: number; fps?: number } = {}): FramePlanItem[] {
  if (!scenes.length) return [];
  const max = Math.max(2, Math.min(REVIEW_FRAME_LIMIT, opts.max ?? REVIEW_FRAME_LIMIT));
  const total = opts.totalSec ?? scenes.reduce((n, s) => Math.max(n, s.startSec + s.durationSec), 0);
  const last = Math.max(0, total - 1 / (opts.fps ?? 30));
  const clamp = (t: number) => round2(Math.min(last, Math.max(0, t)));
  const items: Omit<FramePlanItem, "ref">[] = [{ atSec: 0, sceneId: scenes[0]!.id, kind: "first" }];

  let mids = scenes;
  if (mids.length > max - 1) {
    const n = max - 1;
    const idx = [...new Set(Array.from({ length: n }, (_, k) => Math.round((k * (scenes.length - 1)) / Math.max(1, n - 1))))];
    mids = idx.map((i) => scenes[i]!);
  }
  for (const s of mids) items.push({ atSec: clamp(s.startSec + s.durationSec / 2), sceneId: s.id, kind: "mid" });

  let room = max - items.length;
  const long = scenes.filter((s) => s.durationSec >= (opts.longSceneSec ?? LONG_SCENE_SEC)).sort((a, b) => b.durationSec - a.durationSec || a.startSec - b.startSec);
  for (const s of long) {
    if (room < 2) break;
    items.push({ atSec: clamp(s.startSec + s.durationSec * 0.2), sceneId: s.id, kind: "early" });
    items.push({ atSec: clamp(s.startSec + s.durationSec * 0.8), sceneId: s.id, kind: "late" });
    room -= 2;
  }

  const sorted = items.sort((a, b) => a.atSec - b.atSec);
  const out: Omit<FramePlanItem, "ref">[] = [];
  for (const it of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.atSec - it.atSec) < 0.08) continue; // same instant (very short scene)
    out.push(it);
  }
  return out.slice(0, max).map((it, i) => ({ ref: `f${i + 1}`, ...it }));
}

function ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin(), args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, signal }, (err, _stdout, stderr) => {
      if (err) reject(new AppError("PROVIDER_ERROR", `ffmpeg failed: ${String(stderr || err.message).slice(-600)}`, { retryable: false, cause: err, userMessage: "MuseLaunch couldn't read frames from this render. Render it again and retry." }));
      else resolve();
    });
  });
}

async function nonEmpty(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/** Even pixel size of the frame after scaling the shorter side to `shortSide` (never upscaled). */
export function scaledSize(width: number | undefined, height: number | undefined, shortSide = REVIEW_FRAME_SHORT_SIDE): { width?: number; height?: number; vf: string } {
  if (!width || !height) return { vf: `scale=${shortSide}:-2` };
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (width <= height) {
    const w = even(Math.min(shortSide, width));
    return { width: w, height: even((height * w) / width), vf: `scale=${w}:-2` };
  }
  const h = even(Math.min(shortSide, height));
  return { width: even((width * h) / height), height: h, vf: `scale=-2:${h}` };
}

export interface ExtractedFrame extends FramePlanItem {
  path: string;
  width?: number;
  height?: number;
}

/**
 * Extract the planned frames from a local MP4 as JPEGs (shorter side ≈540 px) into `outDir`.
 * Times are clamped to the real duration; a seek that lands past the last frame is retried slightly
 * earlier. Throws PROVIDER_ERROR when FFmpeg can't decode the file.
 */
export async function extractReviewFrames(
  videoPath: string,
  plan: FramePlanItem[],
  outDir: string,
  opts: { shortSide?: number; signal?: AbortSignal } = {},
): Promise<{ frames: ExtractedFrame[]; durationSec?: number; width?: number; height?: number }> {
  await mkdir(outDir, { recursive: true });
  const info = await probe(videoPath, opts.signal).catch((err) => {
    throw new AppError("PROVIDER_ERROR", `Not a readable video: ${(err as Error).message}`.slice(0, 800), { retryable: false, cause: err, userMessage: "MuseLaunch couldn't read this render. Render it again and retry." });
  });
  const size = scaledSize(info.width, info.height, opts.shortSide);
  const end = info.durationSec ? Math.max(0, info.durationSec - 0.05) : undefined;
  const frames: ExtractedFrame[] = [];
  for (const f of plan) {
    const out = join(outDir, `${f.ref}.jpg`);
    const at = end !== undefined ? Math.min(f.atSec, end) : f.atSec;
    for (const t of [at, Math.max(0, at - 0.25), Math.max(0, at - 1)]) {
      await ffmpeg(["-y", "-loglevel", "error", "-ss", t.toFixed(3), "-i", videoPath, "-frames:v", "1", "-vf", size.vf, "-q:v", "3", out], opts.signal);
      if (await nonEmpty(out)) break;
    }
    if (!(await nonEmpty(out))) throw new AppError("PROVIDER_ERROR", `No frame decoded at ${at.toFixed(2)}s`, { retryable: false, userMessage: "MuseLaunch couldn't read frames from this render. Render it again and retry." });
    frames.push({ ...f, atSec: round2(at), path: out, width: size.width, height: size.height });
  }
  return { frames, durationSec: info.durationSec, width: info.width, height: info.height };
}

/** Deterministic id of a render output (`ast_r_<key>`), so a review can find a version's render. */
export { renderAssetId } from "./keys";
