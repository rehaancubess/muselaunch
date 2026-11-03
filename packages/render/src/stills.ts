/**
 * Still renders (posts, carousels, thumbnails, store screenshot sets): which kind of still a doc is,
 * how its slides are encoded, and the encoding itself (FFmpeg; Node only).
 *
 * Encoding follows the still's kind, whatever `render.final.format` says (the API route and the
 * Create runner send "png" for any still):
 *   - post / carousel / thumbnail → JPEG (quality ≈ 92, sRGB, 4:4:4). Instagram's API takes JPEG only;
 *     YouTube thumbnails must be ≤ 2 MB, so a bigger one is re-encoded at lower quality until it fits.
 *   - store screenshot set → PNG, 24-bit RGB with NO alpha (flattened on an opaque background):
 *     App Store Connect rejects PNGs with alpha; Google Play takes 24-bit PNG ≤ 8 MB.
 *   - an explicit "jpeg" request is honoured for every kind (the stores accept JPEG too).
 * Preview renders are cheap: half-size JPEG at a lower quality for every kind.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import type { CompositionDoc, Storyboard } from "@muselaunch/contracts";
import { AppError } from "@muselaunch/platform";
import { renderAssetId } from "./keys";
import { ffmpegBin, ffprobeBin } from "./producer";

export type StillKind = "post" | "carousel" | "thumbnail" | "store_ios" | "store_android";
export type StillEncoding = "jpeg" | "png";

/** Largest file each kind may be (YouTube thumbnails 2 MB; Instagram 8 MB; Google Play 8 MB; App Store well above). */
export const STILL_MAX_BYTES: Record<StillKind, number> = {
  post: 8 * 1024 * 1024,
  carousel: 8 * 1024 * 1024,
  thumbnail: 2 * 1024 * 1024,
  store_ios: 8 * 1024 * 1024,
  store_android: 8 * 1024 * 1024,
};

/** Final JPEG quality ladder (≈ IJG 92 first; lower steps only when a size limit needs them). */
const JPEG_QSCALE = [3, 4, 5, 7, 9, 12, 16];
const PREVIEW_QSCALE = 6;

/**
 * The encoding a `render.final` of this doc produces. Still docs: by their kind (an explicit "jpeg" is
 * kept; "png" is what callers send for any still and means "the right image file"). A video doc
 * captured as stills (an explicit png/jpeg request) keeps the requested encoding.
 */
export function finalStillEncoding(doc: Pick<CompositionDoc, "kind" | "aspectRatio" | "scenes">, requested: string, storyboard?: Pick<Storyboard, "format" | "store"> | null): StillEncoding {
  if (doc.kind === "video") return requested === "jpeg" ? "jpeg" : "png";
  return stillEncoding(stillKindOf(doc, storyboard), requested);
}

/**
 * What kind of still a doc is: from its storyboard when known (format + store), else from the doc
 * (a store-screenshot slide or the App Store frame → a store set; a 16:9 single still → a thumbnail).
 */
export function stillKindOf(doc: Pick<CompositionDoc, "kind" | "aspectRatio" | "scenes">, storyboard?: Pick<Storyboard, "format" | "store"> | null): StillKind {
  const f = storyboard?.format;
  if (f === "store_screenshots") return storyboard?.store === "android" || (!storyboard?.store && doc.aspectRatio === "9:16") ? "store_android" : "store_ios";
  if (f === "thumbnail") return "thumbnail";
  if (f === "post") return "post";
  if (f === "carousel") return "carousel";
  if (doc.aspectRatio === "9:19.5") return "store_ios";
  if (doc.scenes.some((s) => s.template === "store-screenshot")) return doc.aspectRatio === "9:16" ? "store_android" : "store_ios";
  if (doc.scenes.some((s) => s.template === "thumbnail-bold") || (doc.kind === "static" && doc.aspectRatio === "16:9")) return "thumbnail";
  return doc.kind === "static" ? "post" : "carousel";
}

export const isStoreKind = (k: StillKind) => k === "store_ios" || k === "store_android";

/** The encoding of a final still render (see the module comment). */
export function stillEncoding(kind: StillKind, requested?: string | null): StillEncoding {
  if (requested === "jpeg") return "jpeg";
  return isStoreKind(kind) ? "png" : "jpeg";
}

function run(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (err) reject(new AppError("PROVIDER_ERROR", `${bin.split(/[\\/]/).pop()} failed: ${String(stderr || err.message).slice(-600)}`, { retryable: false, cause: err }));
      else resolve(String(stdout));
    });
  });
}

export interface ImageInfo {
  width?: number;
  height?: number;
  /** FFmpeg pixel format (rgb24 = 24-bit, no alpha; rgba = with alpha; yuvj444p/yuvj420p = JPEG). */
  pixFmt?: string;
  codec?: string;
}

export async function imageInfo(path: string, signal?: AbortSignal): Promise<ImageInfo> {
  const out = await run(ffprobeBin(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt,codec_name", "-of", "json", path], signal);
  const s = (JSON.parse(out) as { streams?: { width?: number; height?: number; pix_fmt?: string; codec_name?: string }[] }).streams?.[0];
  return { width: s?.width, height: s?.height, pixFmt: s?.pix_fmt, codec: s?.codec_name };
}

/** Pixel formats that carry an alpha channel (or may: a palette PNG can hold transparency). */
export const hasAlpha = (pixFmt: string | undefined) => !!pixFmt && /^(rgba|bgra|argb|abgr|ya8|ya16|rgba64|bgra64|gbrap|yuva|pal8)/.test(pixFmt);

export interface EncodedStill {
  path: string;
  bytes: number;
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png";
  /** JPEG: the FFmpeg qscale used (lower = better). */
  qscale?: number;
}

/**
 * Encode one captured frame. JPEG: sRGB, full-range 4:4:4, the best quality on the ladder that keeps
 * the file within `maxBytes`. PNG: flattened onto `background` (an opaque colour) and written as
 * 24-bit RGB, so the file never carries an alpha channel.
 */
export async function encodeStill(
  src: string,
  out: string,
  o: { encoding: StillEncoding; maxBytes: number; preview?: boolean; background?: string; signal?: AbortSignal },
): Promise<EncodedStill> {
  const info = await imageInfo(src, o.signal);
  if (!info.width || !info.height) throw new AppError("PROVIDER_ERROR", "Rendered slide frame is unreadable", { retryable: true });
  const W = info.width;
  const H = info.height;
  const bg = /^#[0-9a-fA-F]{6}$/.test(o.background ?? "") ? o.background!.slice(1) : "FFFFFF";
  // Flatten any transparency onto an opaque background first (Chrome frames are opaque already; this is a guarantee).
  const flatten = `color=c=0x${bg}:s=${W}x${H}[bg];[0:v]format=rgba[fg];[bg][fg]overlay=shortest=1:format=auto`;
  if (o.encoding === "png") {
    await run(ffmpegBin(), ["-y", "-loglevel", "error", "-i", src, "-filter_complex", `${flatten},format=rgb24`, "-frames:v", "1", "-update", "1", "-pix_fmt", "rgb24", "-compression_level", "9", out], o.signal);
    const bytes = (await stat(out)).size;
    if (bytes > o.maxBytes) throw new AppError("PROVIDER_ERROR", `Slide PNG is ${(bytes / 1048576).toFixed(1)} MB, over the store's ${(o.maxBytes / 1048576).toFixed(0)} MB limit`, { retryable: false, userMessage: "A slide came out larger than the store accepts. Try a render in JPEG." });
    return { path: out, bytes, width: W, height: H, mimeType: "image/png" };
  }
  const ladder = o.preview ? [PREVIEW_QSCALE, 10, 16] : JPEG_QSCALE;
  let bytes = 0;
  for (const q of ladder) {
    await run(ffmpegBin(), ["-y", "-loglevel", "error", "-i", src, "-filter_complex", `${flatten},format=yuvj444p`, "-frames:v", "1", "-update", "1", "-q:v", String(q), "-color_range", "pc", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", out], o.signal);
    bytes = (await stat(out)).size;
    if (bytes <= o.maxBytes) return { path: out, bytes, width: W, height: H, mimeType: "image/jpeg", qscale: q };
  }
  throw new AppError("PROVIDER_ERROR", `Slide JPEG is ${(bytes / 1048576).toFixed(1)} MB even at low quality (limit ${(o.maxBytes / 1048576).toFixed(0)} MB)`, { retryable: false, userMessage: "A slide came out larger than the platform accepts." });
}

/**
 * Asset id of slide 1 of a doc's still render (`ast_r_<key>`; slide n is `${id}_${n}`). Final renders
 * are keyed by the encoding they produce, so callers look up a still by the doc, not by a guessed format.
 */
export function stillRenderAssetId(docHashValue: string, quality: "preview" | "final", encoding: StillEncoding): string {
  return renderAssetId(docHashValue, quality, quality === "preview" ? "jpeg" : encoding);
}
