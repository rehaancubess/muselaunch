/** FFmpeg/ffprobe helpers and media utilities for render jobs (Node only). */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { AppError } from "@muselaunch/platform";
import { ffmpegBin, ffprobeBin } from "./producer";

function run(bin: string, args: string[], timeoutMs = 120_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (err) reject(new AppError("PROVIDER_ERROR", `${bin.split(/[\\/]/).pop()} failed: ${String(stderr || err.message).slice(-600)}`, { retryable: false, cause: err }));
      else resolve(String(stdout));
    });
  });
}

export interface ProbeResult {
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
}

export async function probe(path: string, signal?: AbortSignal): Promise<ProbeResult> {
  const out = await run(ffprobeBin(), ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", path], 60_000, signal);
  const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const [num, den] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationSec: j.format?.duration ? Number(j.format.duration) : undefined,
    width: v?.width,
    height: v?.height,
    fps: num && den ? num / den : undefined,
    hasAudio: !!j.streams?.some((s) => s.codec_type === "audio"),
  };
}

/** Extract one frame as JPEG/PNG (by extension). */
export async function extractFrame(video: string, atSec: number, out: string, opts: { width?: number; signal?: AbortSignal } = {}): Promise<void> {
  const vf = opts.width ? ["-vf", `scale=${opts.width}:-2`] : [];
  await run(ffmpegBin(), ["-y", "-loglevel", "error", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1", ...vf, ...(out.endsWith(".jpg") ? ["-q:v", "3"] : []), out], 60_000, opts.signal);
}

/** Convert an image (e.g. PNG frame) to JPEG. */
export async function toJpeg(input: string, out: string, signal?: AbortSignal): Promise<void> {
  await run(ffmpegBin(), ["-y", "-loglevel", "error", "-i", input, "-q:v", "2", out], 60_000, signal);
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
};

export function extFor(mime: string, storagePath: string): string {
  const fromPath = /\.([A-Za-z0-9]{2,5})$/.exec(storagePath)?.[1]?.toLowerCase();
  return EXT[mime.toLowerCase()] ?? fromPath ?? "bin";
}

export const shortHash = (s: string, n = 20) => createHash("sha256").update(s).digest("hex").slice(0, n);

/** Seconds → SRT timestamp. */
export function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (v: number, n = 2) => String(v).padStart(n, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function toSrt(cues: { startSec: number; endSec: number; text: string }[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.startSec)} --> ${srtTime(c.endSec)}\n${c.text}\n`).join("\n");
}
