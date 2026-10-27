/**
 * Thin, guarded wrapper around `@hyperframes/producer`: binary resolution (Chrome, FFmpeg,
 * ffprobe), a process-wide concurrency limit, a wall-clock timeout and cancellation.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { AppError } from "@muselaunch/platform";

const require = createRequire(import.meta.url);

export interface RenderProjectOptions {
  projectDir: string;
  outputPath: string;
  fps: number;
  quality: "draft" | "standard" | "high";
  format?: "mp4" | "png-sequence" | "webm";
  signal?: AbortSignal;
  timeoutMs?: number;
  workers?: number;
  crf?: number;
  onProgress?: (pct: number, message: string) => void | Promise<void>;
}

function onPath(name: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

let binariesResolved = false;
/**
 * HyperFrames reads HYPERFRAMES_FFMPEG_PATH / HYPERFRAMES_FFPROBE_PATH, then PATH.
 * We map our FFMPEG_PATH / FFPROBE_PATH, and fall back to the `ffmpeg-static` binary
 * (no system install needed, e.g. on Windows) when nothing is on PATH.
 */
export function resolveFfmpegBinaries(): { ffmpeg?: string; ffprobe?: string } {
  if (!binariesResolved) {
    binariesResolved = true;
    if (!process.env.HYPERFRAMES_FFMPEG_PATH) {
      if (process.env.FFMPEG_PATH) process.env.HYPERFRAMES_FFMPEG_PATH = process.env.FFMPEG_PATH;
      else if (!onPath("ffmpeg")) {
        try {
          const p = require("ffmpeg-static") as unknown as string | null;
          if (p && existsSync(p)) process.env.HYPERFRAMES_FFMPEG_PATH = p;
        } catch {
          /* optional */
        }
      }
    }
    if (!process.env.HYPERFRAMES_FFPROBE_PATH && process.env.FFPROBE_PATH) process.env.HYPERFRAMES_FFPROBE_PATH = process.env.FFPROBE_PATH;
  }
  return { ffmpeg: process.env.HYPERFRAMES_FFMPEG_PATH || (onPath("ffmpeg") ? "ffmpeg" : undefined), ffprobe: process.env.HYPERFRAMES_FFPROBE_PATH || (onPath("ffprobe") ? "ffprobe" : undefined) };
}

export function ffmpegBin(): string {
  return resolveFfmpegBinaries().ffmpeg ?? "ffmpeg";
}
export function ffprobeBin(): string {
  return resolveFfmpegBinaries().ffprobe ?? "ffprobe";
}

/** Chrome for rendering: explicit env, else HyperFrames' own resolution (managed / puppeteer cache). */
export function chromePath(): string | undefined {
  const p = process.env.RENDER_CHROME_PATH || process.env.PRODUCER_HEADLESS_SHELL_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  return p && existsSync(p) ? p : undefined;
}

// --- concurrency --------------------------------------------------------------------------------

const MAX_CONCURRENT = Math.max(1, Number(process.env.RENDER_CONCURRENCY ?? 1) || 1);
let active = 0;
const waiters: (() => void)[] = [];

async function acquire(signal?: AbortSignal): Promise<() => void> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = waiters.indexOf(go);
        if (i >= 0) waiters.splice(i, 1);
        reject(new AppError("CANCELLED", "Render cancelled while queued"));
      };
      waiters.push(go);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    waiters.shift()?.();
  };
}

export const renderSlots = () => ({ active, queued: waiters.length, max: MAX_CONCURRENT });

/** Render a HyperFrames project directory. Throws AppError (CANCELLED / TIMEOUT / PROVIDER_ERROR). */
export async function renderProject(o: RenderProjectOptions): Promise<{ durationSec?: number; framesRendered?: number; outcome?: string; warnings: number }> {
  resolveFfmpegBinaries();
  const release = await acquire(o.signal);
  const ac = new AbortController();
  const timeoutMs = o.timeoutMs ?? 15 * 60_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  const onAbort = () => ac.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) ac.abort();
  try {
    const producer = await import("@hyperframes/producer");
    const chrome = chromePath();
    const quietLogger = {
      level: "warn",
      error: (...a: unknown[]) => console.error("[hyperframes]", ...a),
      warn: () => {},
      info: () => {},
      debug: () => {},
    };
    const job = producer.createRenderJob({
      fps: o.fps,
      quality: o.quality,
      format: o.format ?? "mp4",
      workers: o.workers ?? Math.max(1, Number(process.env.RENDER_WORKERS ?? 1) || 1),
      strictness: "best-effort",
      hdrMode: "force-sdr",
      crf: o.crf,
      maxRenderMs: timeoutMs,
      ...(chrome ? { producerConfig: producer.resolveConfig({ chromePath: chrome }) } : {}),
      logger: quietLogger as never,
    } as never);
    let lastPct = -1;
    await producer.executeRenderJob(
      job,
      o.projectDir,
      o.outputPath,
      async (j, message) => {
        const pct = Math.round(j.progress);
        if (pct !== lastPct) {
          lastPct = pct;
          await o.onProgress?.(pct, message);
        }
      },
      ac.signal,
    );
    if (job.status === "failed") throw new AppError("PROVIDER_ERROR", `HyperFrames render failed: ${job.error ?? "unknown error"}`, { retryable: true });
    return { durationSec: job.duration, framesRendered: job.framesRendered, outcome: job.outcome, warnings: job.warnings.length };
  } catch (err) {
    if (timedOut) throw new AppError("TIMEOUT", `Render exceeded ${Math.round(timeoutMs / 1000)}s`, { retryable: false });
    if (o.signal?.aborted) throw new AppError("CANCELLED", "Render cancelled");
    if (err instanceof AppError) throw err;
    const name = (err as Error)?.name;
    if (name === "RenderCancelledError") throw new AppError("CANCELLED", "Render cancelled");
    throw new AppError("PROVIDER_ERROR", `HyperFrames render failed: ${(err as Error)?.message ?? String(err)}`, { retryable: true, cause: err });
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    release();
  }
}
