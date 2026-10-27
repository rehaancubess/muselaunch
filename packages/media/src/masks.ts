import { decodeMaskToRaster, type SamDetection, type SamResult } from "@muselaunch/providers";
import { ffmpeg, ffmpegWriter } from "./ffmpeg";

/**
 * Turn SAM detections into frame-aligned grayscale mattes and alpha cutouts with FFmpeg.
 * SAM supplies geometry only; the actual compositing of cutouts happens in HyperFrames (module C).
 */

export interface FrameSize {
  width: number;
  height: number;
}

/** Source frame size SAM reported (`w`/`h` on box tokens), used to rescale if it differs from ours. */
export function samFrameSize(rawOutput: string): FrameSize | undefined {
  const m = /<\|box;([^|]*)\|>/.exec(rawOutput);
  if (!m) return undefined;
  const fields = new Map(m[1]!.split(";").map((kv) => kv.split("=").map((s) => s.trim()) as [string, string]));
  const width = Number(fields.get("w"));
  const height = Number(fields.get("h"));
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Paint one detection into a full-frame 8-bit matte (255 = subject). The raster covers the record's
 * half-open `bounds`; it is scaled nearest-neighbour if its size differs, and everything is clipped.
 * Returns the number of newly set pixels.
 */
export function paintDetection(frame: Uint8Array, size: FrameSize, det: SamDetection, sam?: FrameSize): number {
  const raster = decodeMaskToRaster(det.mask);
  const mw = det.mask.width;
  const mh = det.mask.height;
  const sx = sam && sam.width !== size.width ? size.width / sam.width : 1;
  const sy = sam && sam.height !== size.height ? size.height / sam.height : 1;
  const left = Math.round(det.bounds.left * sx);
  const top = Math.round(det.bounds.top * sy);
  const bw = Math.max(1, Math.round((det.bounds.right - det.bounds.left) * sx));
  const bh = Math.max(1, Math.round((det.bounds.bottom - det.bounds.top) * sy));
  let painted = 0;
  for (let y = 0; y < bh; y++) {
    const fy = top + y;
    if (fy < 0 || fy >= size.height) continue;
    const row = Math.min(mh - 1, Math.floor((y * mh) / bh)) * mw;
    const base = fy * size.width;
    for (let x = 0; x < bw; x++) {
      const fx = left + x;
      if (fx < 0 || fx >= size.width) continue;
      if (raster[row + Math.min(mw - 1, Math.floor((x * mw) / bw))] && frame[base + fx] === 0) {
        frame[base + fx] = 255;
        painted++;
      }
    }
  }
  return painted;
}

export function selectDetections(result: SamResult, objectIds: string[]): SamDetection[] {
  if (!objectIds.length) return result.detections;
  const keep = new Set(objectIds);
  return result.detections.filter((d) => keep.has(d.objectId));
}

export function groupByFrame(dets: SamDetection[]): Map<number, SamDetection[]> {
  const m = new Map<number, SamDetection[]>();
  for (const d of dets) {
    const list = m.get(d.frame);
    if (list) list.push(d);
    else m.set(d.frame, [d]);
  }
  return m;
}

/**
 * Tracking-quality heuristic (0..1) from per-frame mask coverage:
 * presence (share of frames with a mask) × smoothness (1 − mean relative coverage change between
 * consecutive frames) × fragmentation penalty (number of separate visible runs). Below 0.5 the
 * compositor falls back to unmasked footage.
 */
export function trackingQuality(coverage: number[]): number {
  const n = coverage.length;
  if (!n) return 0;
  const present = coverage.filter((c) => c > 0).length;
  if (!present) return 0;
  if (n === 1) return 1;
  const presence = present / n;
  let changes = 0;
  let pairs = 0;
  let runs = 0;
  for (let i = 0; i < n; i++) {
    const c = coverage[i]!;
    if (c > 0 && (i === 0 || coverage[i - 1] === 0)) runs++;
    if (i > 0 && c > 0 && coverage[i - 1]! > 0) {
      changes += Math.abs(c - coverage[i - 1]!) / Math.max(c, coverage[i - 1]!);
      pairs++;
    }
  }
  const smoothness = pairs ? 1 - Math.min(1, (changes / pairs) * 2) : 0.5;
  const fragmentation = Math.min(1, (runs - 1) / 5);
  const q = presence * (0.5 + 0.5 * smoothness) * (1 - 0.5 * fragmentation);
  return Math.round(Math.max(0, Math.min(1, q)) * 1000) / 1000;
}

export interface MatteStats {
  coverage: number[];
  framesWithMask: number;
}

/** Image: write a single grayscale PNG matte. */
export async function writeImageMatte(out: string, size: FrameSize, dets: SamDetection[], sam?: FrameSize, signal?: AbortSignal): Promise<MatteStats> {
  const frame = new Uint8Array(size.width * size.height);
  let painted = 0;
  for (const d of dets) painted += paintDetection(frame, size, d, sam);
  const w = ffmpegWriter(["-f", "rawvideo", "-pix_fmt", "gray", "-s", `${size.width}x${size.height}`, "-i", "pipe:0", "-frames:v", "1", "-pix_fmt", "gray", out], { signal });
  await w.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
  await w.end();
  const cov = painted / (size.width * size.height);
  return { coverage: [cov], framesWithMask: painted ? 1 : 0 };
}

/**
 * Video: stream one matte frame per source frame (CFR, same fps and frame count as the source) into
 * an H.264 MP4 whose luma is the matte. Frames without detections are black.
 */
export async function writeVideoMatte(
  out: string,
  size: FrameSize,
  fps: number,
  frameCount: number,
  dets: SamDetection[],
  opts: { sam?: FrameSize; signal?: AbortSignal; onFrame?: (i: number) => void } = {},
): Promise<MatteStats> {
  const byFrame = groupByFrame(dets);
  const w = ffmpegWriter(
    ["-f", "rawvideo", "-pix_fmt", "gray", "-s", `${size.width}x${size.height}`, "-r", String(fps), "-i", "pipe:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { signal: opts.signal },
  );
  const frame = new Uint8Array(size.width * size.height);
  const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const coverage: number[] = [];
  let framesWithMask = 0;
  try {
    for (let i = 0; i < frameCount; i++) {
      frame.fill(0);
      let painted = 0;
      for (const d of byFrame.get(i) ?? []) painted += paintDetection(frame, size, d, opts.sam);
      coverage.push(painted / frame.length);
      if (painted) framesWithMask++;
      await w.write(buf);
      if (i % 30 === 0) opts.onFrame?.(i);
    }
  } finally {
    await w.end();
  }
  return { coverage, framesWithMask };
}

/** VP9-alpha WebM of the subject only (alpha from the matte), audio kept as Opus. */
export async function writeVideoCutout(source: string, matte: string, out: string, opts: { hasAudio: boolean; signal?: AbortSignal; fast?: boolean }): Promise<void> {
  await ffmpeg(
    [
      "-i", source,
      "-i", matte,
      "-filter_complex", "[0:v]setpts=PTS-STARTPTS,format=yuv420p[s];[1:v]setpts=PTS-STARTPTS,format=gray,gblur=sigma=0.7[a];[s][a]alphamerge,format=yuva420p[v]",
      "-map", "[v]",
      ...(opts.hasAudio ? ["-map", "0:a:0", "-c:a", "libopus", "-b:a", "96k"] : ["-an"]),
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
      "-b:v", "0", "-crf", "30", "-row-mt", "1",
      "-deadline", opts.fast ? "realtime" : "good", "-cpu-used", opts.fast ? "8" : "4",
      "-shortest",
      out,
    ],
    { signal: opts.signal, timeoutMs: 60 * 60_000 },
  );
}

/** PNG of the subject only (RGBA). */
export async function writeImageCutout(source: string, matte: string, out: string, signal?: AbortSignal): Promise<void> {
  await ffmpeg(["-i", source, "-i", matte, "-filter_complex", "[0:v]format=rgba[s];[1:v]format=gray,gblur=sigma=0.6[a];[s][a]alphamerge[v]", "-map", "[v]", "-frames:v", "1", out], { signal });
}

const previewSize = (size: FrameSize, maxH: number) => {
  const h = Math.min(maxH, size.height) & ~1;
  const w = Math.max(2, Math.round((size.width * h) / size.height / 2) * 2);
  return { w, h };
};

/** Selection preview: subject at full brightness, background dimmed (for the mask selection UI). */
export async function writePreview(source: string, matte: string, out: string, size: FrameSize, kind: "image" | "video", signal?: AbortSignal): Promise<void> {
  const { w, h } = previewSize(size, kind === "video" ? 480 : 720);
  const graph =
    `[0:v]setpts=PTS-STARTPTS,scale=${w}:${h},format=gbrp,split[o][d];` +
    `[d]lutrgb=r='val*0.28':g='val*0.30':b='val*0.38+40'[dim];` +
    `[1:v]setpts=PTS-STARTPTS,scale=${w}:${h},format=gray,format=gbrp[m];` +
    `[dim][o][m]maskedmerge,format=${kind === "video" ? "yuv420p" : "rgb24"}[v]`;
  const enc = kind === "video" ? ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-movflags", "+faststart"] : ["-frames:v", "1", "-q:v", "3"];
  await ffmpeg(["-i", source, "-i", matte, "-filter_complex", graph, "-map", "[v]", ...enc, out], { signal });
}
