import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { AppError } from "@muselaunch/platform";

/**
 * FFmpeg/FFprobe resolution: `FFMPEG_PATH` / `FFPROBE_PATH` env → bundled npm binaries
 * (`ffmpeg-static`, `@ffprobe-installer/ffprobe`; optional deps so Windows/macOS dev machines need
 * no system install) → `ffmpeg`/`ffprobe` on PATH.
 */
const require = createRequire(import.meta.url);

function fromPackage(name: string, pick: (mod: unknown) => unknown): string | undefined {
  try {
    const path = pick(require(name));
    return typeof path === "string" && existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

let ffmpegBin: string | undefined;
let ffprobeBin: string | undefined;

export function ffmpegPath(): string {
  ffmpegBin ??= process.env.FFMPEG_PATH || fromPackage("ffmpeg-static", (m) => (typeof m === "string" ? m : (m as { default?: string })?.default)) || "ffmpeg";
  return ffmpegBin;
}

export function ffprobePath(): string {
  ffprobeBin ??= process.env.FFPROBE_PATH || fromPackage("@ffprobe-installer/ffprobe", (m) => (m as { path?: string })?.path) || "ffprobe";
  return ffprobeBin;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Bytes/stream piped to stdin (pass `pipe:0` / `-` as an input in args). */
  stdin?: Readable;
  timeoutMs?: number;
}

function run(bin: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    let settled = false;
    const finish = (e?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (e) reject(e);
      else resolve({ stdout: Buffer.concat(out), stderr: err });
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(new AppError("CANCELLED", "Media processing cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new AppError("TIMEOUT", `${bin.split(/[\\/]/).pop()} timed out`, { retryable: true }));
    }, opts.timeoutMs ?? 20 * 60_000);
    timer.unref?.();
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 64_000) err = err.slice(-32_000);
    });
    child.on("error", (e) =>
      finish(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? new AppError("PROVIDER_NOT_CONFIGURED", `${bin} not found. Install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH.`, { retryable: false })
          : e,
      ),
    );
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new AppError("INTERNAL", `${bin.split(/[\\/]/).pop()} exited with ${code}: ${err.trim().split("\n").slice(-4).join(" | ")}`, { retryable: false }));
    });
    if (opts.stdin && child.stdin) {
      child.stdin.on("error", () => {}); // EPIPE when ffmpeg exits early; the exit code reports the real error
      opts.stdin.pipe(child.stdin);
    }
  });
}

/** Run ffmpeg with safe defaults (`-hide_banner -loglevel error -y`). */
export async function ffmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  const { stderr } = await run(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...(opts.stdin ? [] : ["-nostdin"]), ...args], opts);
  return stderr;
}

/** Spawn ffmpeg with a writable stdin for streaming raw frames. Resolves when ffmpeg exits. */
export function ffmpegWriter(args: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const child = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let err = "";
  child.stderr.on("data", (d: Buffer) => {
    err += d.toString();
    if (err.length > 64_000) err = err.slice(-32_000);
  });
  child.stdin.on("error", () => {});
  const onAbort = () => child.kill("SIGKILL");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30 * 60_000);
  timer.unref?.();
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", (e) =>
      reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new AppError("PROVIDER_NOT_CONFIGURED", "ffmpeg not found. Install FFmpeg or set FFMPEG_PATH.") : e),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) reject(new AppError("CANCELLED", "Media processing cancelled"));
      else if (code === 0) resolve();
      else reject(new AppError("INTERNAL", `ffmpeg exited with ${code}: ${err.trim().split("\n").slice(-4).join(" | ")}`));
    });
  });
  return {
    /** Write one chunk honouring backpressure. */
    async write(buf: Buffer): Promise<void> {
      if (!child.stdin.write(buf)) await new Promise<void>((r) => child.stdin.once("drain", () => r()));
    },
    async end(): Promise<void> {
      child.stdin.end();
      await done;
    },
    done,
  };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
  disposition?: { attached_pic?: number };
}
interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
}

export interface MediaProbe {
  kind: "image" | "video" | "audio" | "unknown";
  container: string;
  /** Coded size. */
  width?: number;
  height?: number;
  /** Size as displayed (rotation applied). */
  displayWidth?: number;
  displayHeight?: number;
  rotation: number;
  durationSec?: number;
  fps?: number;
  /** r_frame_rate differs from avg_frame_rate: variable frame rate. */
  vfr: boolean;
  frameCount?: number;
  videoCodec?: string;
  pixFmt?: string;
  audioCodec?: string;
  hasAudio: boolean;
  hasVideo: boolean;
  alphaMode?: boolean;
}

const rate = (r?: string): number | undefined => {
  if (!r) return undefined;
  const [n, d] = r.split("/").map(Number);
  if (!n || !d) return undefined;
  return n / d;
};

const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "gif", "bmp", "tiff", "jpegls", "hevc", "av1", "heif"]);

export async function ffprobeJson(path: string, extra: string[] = [], opts: RunOptions = {}): Promise<FfprobeJson> {
  const { stdout } = await run(ffprobePath(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...extra, path], { timeoutMs: 120_000, ...opts });
  return JSON.parse(stdout.toString("utf8")) as FfprobeJson;
}

export async function probeMedia(path: string, opts: RunOptions = {}): Promise<MediaProbe> {
  let json: FfprobeJson;
  try {
    json = await ffprobeJson(path, [], opts);
  } catch (err) {
    if (err instanceof AppError && err.code === "PROVIDER_NOT_CONFIGURED") throw err;
    return { kind: "unknown", container: "unknown", rotation: 0, vfr: false, hasAudio: false, hasVideo: false };
  }
  const streams = json.streams ?? [];
  const container = json.format?.format_name ?? "unknown";
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const duration = Number(json.format?.duration ?? v?.duration ?? a?.duration);
  const isImageContainer = /image2|png_pipe|jpeg_pipe|webp_pipe|gif|bmp_pipe|tiff_pipe|heif|svg/.test(container) || (container.includes("mov") && /heic|heif|avif/.test(container));
  const stillImage = Boolean(v) && (isImageContainer || (!a && (!Number.isFinite(duration) || duration === 0) && IMAGE_CODECS.has(v!.codec_name ?? "")));
  const rotationRaw = v?.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation ?? Number(v?.tags?.rotate ?? 0);
  const rotation = ((Math.round(rotationRaw) % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  const fps = rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate);
  const rFps = rate(v?.r_frame_rate);
  const vfr = Boolean(fps && rFps && Math.abs(fps - rFps) / rFps > 0.01);
  const nb = Number(v?.nb_frames);
  return {
    kind: stillImage ? "image" : v ? "video" : a ? "audio" : "unknown",
    container,
    width: v?.width,
    height: v?.height,
    displayWidth: swap ? v?.height : v?.width,
    displayHeight: swap ? v?.width : v?.height,
    rotation,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    fps: stillImage ? undefined : fps,
    vfr: stillImage ? false : vfr,
    frameCount: Number.isFinite(nb) && nb > 0 ? nb : undefined,
    videoCodec: v?.codec_name,
    pixFmt: v?.pix_fmt,
    audioCodec: a?.codec_name,
    hasAudio: Boolean(a),
    hasVideo: Boolean(v) && !stillImage,
    alphaMode: v?.tags?.alpha_mode === "1" || v?.tags?.ALPHA_MODE === "1",
  };
}

/** Exact video frame count (packet count; no decode). */
export async function countVideoFrames(path: string, opts: RunOptions = {}): Promise<number | undefined> {
  const { stdout } = await run(ffprobePath(), ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path], { timeoutMs: 300_000, ...opts });
  const n = Number(stdout.toString().trim().split(/[\s,]/)[0]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
