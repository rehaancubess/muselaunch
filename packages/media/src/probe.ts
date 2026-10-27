import { open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaAsset } from "@muselaunch/contracts";
import { AppError, workspaceKey, type JobContext } from "@muselaunch/platform";
import { countVideoFrames, ffmpeg, probeMedia, type MediaProbe } from "./ffmpeg";
import { sha256File, withWorkdir } from "./util";

/**
 * `media.probe`: metadata (ffprobe), content hash, browser/render-safe normalisation and a poster.
 *
 * - HEIC/HEIF → PNG (heic-convert; pure JS, handles iPhone grid images).
 * - Video → H.264/yuv420p MP4 (`-preset veryfast`, CFR, rotation applied, ≤1920 long edge, AAC)
 *   unless it already is one; MOV/H.264 without rotation/VFR is only remuxed. SAM accepts
 *   MP4/MOV H.264/H.265 only (no WebM/VP9), and frame-aligned mattes need CFR without rotation.
 * - `sha256` is the hash of the ORIGINAL upload (stable identity for caches across re-encodes).
 * The original upload object is kept; `storagePath` points at the normalised file.
 */

export const MAX_LONG_EDGE = 1920;

export function needsVideoNormalisation(info: MediaProbe, mimeType: string): { transcode: boolean; remux: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (info.videoCodec !== "h264") reasons.push(`codec ${info.videoCodec ?? "unknown"}`);
  if (info.pixFmt && info.pixFmt !== "yuv420p" && info.pixFmt !== "yuvj420p") reasons.push(`pix_fmt ${info.pixFmt}`);
  if (info.rotation) reasons.push(`rotation ${info.rotation}`);
  if (info.vfr) reasons.push("variable frame rate");
  if (Math.max(info.displayWidth ?? 0, info.displayHeight ?? 0) > MAX_LONG_EDGE) reasons.push("resolution above 1080p");
  if ((info.width ?? 0) % 2 || (info.height ?? 0) % 2) reasons.push("odd dimensions");
  if (info.hasAudio && info.audioCodec && !["aac", "mp3"].includes(info.audioCodec)) reasons.push(`audio ${info.audioCodec}`);
  const transcode = reasons.length > 0;
  const isMp4 = mimeType === "video/mp4" && /mp4/.test(info.container);
  return { transcode, remux: !transcode && !isMp4, reasons };
}

/** Normalise a video file to H.264 MP4 (CFR at the source's average rate, capped at 60 fps). */
export async function transcodeToMp4(input: string, output: string, info: MediaProbe, signal?: AbortSignal): Promise<void> {
  const fps = Math.min(60, Math.round((info.fps ?? 30) * 1000) / 1000) || 30;
  const scale = `scale='if(gte(iw,ih),min(${MAX_LONG_EDGE},iw),-2)':'if(gte(iw,ih),-2,min(${MAX_LONG_EDGE},ih))',scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  await ffmpeg(
    [
      "-i", input,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `${scale},format=yuv420p`,
      "-fps_mode", "cfr", "-r", String(fps),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-profile:v", "high",
      "-c:a", "aac", "-b:a", "160k", "-ac", "2",
      "-movflags", "+faststart",
      "-map_metadata", "-1",
      output,
    ],
    { signal, timeoutMs: 60 * 60_000 },
  );
}

export async function remuxToMp4(input: string, output: string, signal?: AbortSignal): Promise<void> {
  await ffmpeg(["-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", output], { signal });
}

/** Poster JPEG (≤720px wide) from ~1s in (or a third of short clips). */
export async function makePoster(input: string, output: string, durationSec: number | undefined, signal?: AbortSignal): Promise<void> {
  const at = Math.max(0, Math.min(1, (durationSec ?? 0) / 3));
  await ffmpeg(["-ss", at.toFixed(3), "-i", input, "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-q:v", "3", output], { signal });
}

const isHeic = (asset: MediaAsset, head: Buffer) =>
  /image\/hei[cf]/.test(asset.mimeType) || /^ftyp(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)/.test(head.subarray(4, 12).toString("latin1"));

export async function convertHeicToPng(input: string, output: string): Promise<void> {
  const { default: convert } = await import("heic-convert");
  const png = await convert({ buffer: await readFile(input), format: "PNG" });
  await writeFile(output, png instanceof ArrayBuffer ? new Uint8Array(png) : png);
}

export async function probeHandler(ctx: JobContext<"media.probe">) {
  const repo = ctx.ws.collection("mediaAssets");
  const asset = await repo.getOrThrow(ctx.payload.assetId);
  if (asset.status === "ready") return { refs: [{ entity: "mediaAssets", id: asset.id }], data: { alreadyReady: true } };
  if (asset.status === "pending_upload" || asset.status === "deleted") throw new AppError("CONFLICT", `Asset is ${asset.status}`, { retryable: false });
  await repo.update(asset.id, { status: "processing", error: undefined }, { actor: ctx.actor });
  try {
    const result = await withWorkdir((dir) => probeInto(ctx, asset, dir));
    return { refs: [{ entity: "mediaAssets", id: asset.id }, ...(result.posterAssetId ? [{ entity: "mediaAssets", id: result.posterAssetId }] : [])], data: result };
  } catch (err) {
    const e = err instanceof AppError ? err : new AppError("INTERNAL", (err as Error).message, { retryable: false });
    if (!e.retryable || e.code === "CANCELLED") await repo.update(asset.id, { status: "failed", error: e.message.slice(0, 1000) }, { actor: ctx.actor }).catch(() => {});
    throw e;
  }
}

async function probeInto(ctx: JobContext, asset: MediaAsset, dir: string) {
  const p = ctx.platform;
  const repo = ctx.ws.collection("mediaAssets");
  const src = join(dir, "source");
  await ctx.progress(5, "downloading");
  await p.storage.downloadToFile(asset.storagePath, src);
  const originalHash = await sha256File(src);
  const head = Buffer.alloc(16);
  const fh = await open(src, "r");
  await fh.read(head, 0, 16, 0).finally(() => fh.close());
  ctx.throwIfCancelled();

  const patch: Partial<MediaAsset> = { sha256: originalHash };
  const labels = new Set(asset.labels);
  let posterAssetId: string | undefined;
  let normalized: string | undefined;

  if (asset.kind === "image") {
    let file = src;
    if (isHeic(asset, head)) {
      await ctx.progress(30, "converting HEIC");
      const out = join(dir, "normalized.png");
      await convertHeicToPng(src, out);
      const key = workspaceKey(ctx.workspaceId, "media", asset.id, "normalized.png");
      const { bytes } = await p.storage.uploadFile(out, key, { contentType: "image/png" });
      Object.assign(patch, { storagePath: key, mimeType: "image/png", bytes });
      labels.add("normalized");
      normalized = "heic→png";
      file = out;
    }
    if (asset.mimeType !== "image/svg+xml") {
      const info = await probeMedia(file, { signal: ctx.signal });
      if (info.kind === "unknown" || !info.width || !info.height) throw new AppError("BAD_REQUEST", "Unreadable image", { retryable: false, userMessage: "We couldn't read that image. Try PNG or JPEG." });
      Object.assign(patch, { width: info.displayWidth ?? info.width, height: info.displayHeight ?? info.height });
    }
  } else if (asset.kind === "video") {
    await ctx.progress(15, "probing");
    let info = await probeMedia(src, { signal: ctx.signal });
    if (!info.hasVideo) throw new AppError("BAD_REQUEST", "No video stream found", { retryable: false, userMessage: "That file has no playable video." });
    const plan = needsVideoNormalisation(info, asset.mimeType);
    let file = src;
    if (plan.transcode || plan.remux) {
      await ctx.progress(30, plan.transcode ? "converting video" : "repackaging video", plan.reasons.join(", ") || undefined);
      const out = join(dir, "normalized.mp4");
      if (plan.transcode) await transcodeToMp4(src, out, info, ctx.signal);
      else await remuxToMp4(src, out, ctx.signal);
      const key = workspaceKey(ctx.workspaceId, "media", asset.id, "normalized.mp4");
      const { bytes } = await p.storage.uploadFile(out, key, { contentType: "video/mp4" });
      Object.assign(patch, { storagePath: key, mimeType: "video/mp4", bytes });
      labels.add("normalized");
      normalized = plan.transcode ? `transcoded (${plan.reasons.join(", ")})` : "remuxed to mp4";
      file = out;
      info = await probeMedia(out, { signal: ctx.signal });
    }
    const frameCount = info.frameCount ?? (await countVideoFrames(file, { signal: ctx.signal }));
    Object.assign(patch, { width: info.displayWidth, height: info.displayHeight, durationSec: info.durationSec, fps: info.fps, hasAudio: info.hasAudio });
    await ctx.progress(80, "making poster");
    const posterFile = join(dir, "poster.jpg");
    await makePoster(file, posterFile, info.durationSec, ctx.signal);
    posterAssetId = `${asset.id}-poster`;
    const posterKey = workspaceKey(ctx.workspaceId, "media", asset.id, "poster.jpg");
    const { bytes } = await p.storage.uploadFile(posterFile, posterKey, { contentType: "image/jpeg" });
    const posterInfo = await probeMedia(posterFile);
    await repo.createIfAbsent(
      {
        id: posterAssetId,
        appId: asset.appId,
        campaignId: asset.campaignId,
        kind: "image",
        role: "thumbnail",
        origin: "derived",
        storagePath: posterKey,
        mimeType: "image/jpeg",
        bytes,
        width: posterInfo.width,
        height: posterInfo.height,
        status: "ready",
        labels: ["poster"],
        isProductTruth: false,
        derivedFromAssetId: asset.id,
        license: asset.license,
        title: asset.title ? `${asset.title} (poster)` : undefined,
      },
      { actor: ctx.actor },
    );
    patch.posterAssetId = posterAssetId;
    if (!frameCount) ctx.log.warn({ assetId: asset.id }, "could not count video frames");
  } else if (asset.kind === "audio") {
    const info = await probeMedia(src, { signal: ctx.signal });
    if (!info.hasAudio) throw new AppError("BAD_REQUEST", "No audio stream found", { retryable: false, userMessage: "That file has no audio we can read." });
    Object.assign(patch, { durationSec: info.durationSec, hasAudio: true });
  }

  const fileStat = patch.bytes === undefined ? await stat(src) : undefined;
  await repo.update(asset.id, { ...patch, bytes: patch.bytes ?? fileStat?.size ?? asset.bytes, labels: [...labels].slice(0, 30), status: "ready", error: undefined }, { actor: ctx.actor });
  await ctx.progress(100, "ready");
  return { sha256: originalHash, normalized, posterAssetId };
}
