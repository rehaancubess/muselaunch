import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaAsset, Segmentation } from "@muselaunch/contracts";
import { AppError, workspaceKey, type JobContext } from "@muselaunch/platform";
import { deleteMetaFile, parseSamOutput, runSam, uploadMetaFile, type BuildObjectPromptOptions, type SamPrompt, type SamResult } from "@muselaunch/providers";
import { countVideoFrames, probeMedia } from "./ffmpeg";
import { samFrameSize, selectDetections, trackingQuality, writeImageCutout, writeImageMatte, writePreview, writeVideoCutout, writeVideoMatte, type FrameSize } from "./masks";
import { callCtx, derivedId, EXT_BY_MIME, inheritFrom, usageEventIdsForJob, withWorkdir } from "./util";

/** SAM 3.1 video limit per request (≈10 min). */
export const SAM_MAX_FRAMES = 15_000;
/** Below this, compositing falls back to unmasked footage (MaskUse.fallback). */
export const LOW_QUALITY_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Corrections (box / point prompts) ⇄ compact strings stored in Segmentation.corrections[].value
// ---------------------------------------------------------------------------

export type GeometryCorrection =
  | { kind: "box"; frame: number; box: { x: number; y: number; w: number; h: number } }
  | { kind: "point"; frame: number; points: { x: number; y: number; label: "positive" | "negative" }[] };

const f4 = (n: number) => (Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000).toString();

export function encodeCorrection(c: GeometryCorrection): string {
  if (c.kind === "box") return `f=${c.frame};b=${[c.box.x, c.box.y, c.box.w, c.box.h].map(f4).join(",")}`;
  return `f=${c.frame};p=${c.points.map((p) => `${f4(p.x)},${f4(p.y)},${p.label === "negative" ? "-" : "+"}`).join("|")}`;
}

export function decodeCorrection(kind: "box" | "point", value: string): GeometryCorrection | null {
  const frame = Number(/(?:^|;)f=(\d+)/.exec(value)?.[1] ?? 0);
  if (kind === "box") {
    const m = /(?:^|;)b=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(value);
    if (!m) return null;
    return { kind, frame, box: { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } };
  }
  const m = /(?:^|;)p=(.+)$/.exec(value);
  if (!m) return null;
  const points = m[1]!
    .split("|")
    .map((s) => s.split(","))
    .filter((a) => a.length === 3)
    .map(([x, y, l]) => ({ x: Number(x), y: Number(y), label: l === "-" ? ("negative" as const) : ("positive" as const) }));
  return points.length ? { kind, frame, points } : null;
}

/** Concept prompt, or box/point object prompt when geometry corrections exist after the last prompt change. */
export function samPromptFor(seg: Pick<Segmentation, "prompt" | "corrections" | "mediaType">, size: FrameSize): SamPrompt {
  const lastPrompt = seg.corrections.map((c) => c.kind).lastIndexOf("prompt");
  const geometry = seg.corrections
    .slice(lastPrompt + 1)
    .filter((c) => c.kind === "box" || c.kind === "point")
    .map((c) => decodeCorrection(c.kind as "box" | "point", c.value))
    .filter((c): c is GeometryCorrection => Boolean(c));
  if (!geometry.length) return { kind: "text", text: seg.prompt };
  const byFrame = new Map<number, { box?: { left: number; top: number; right: number; bottom: number }; points: { x: number; y: number; label: "positive" | "negative" }[] }>();
  const px = (v: number, max: number) => Math.min(max - 1, Math.max(0, Math.round(v * max)));
  for (const g of geometry) {
    const frame = seg.mediaType === "image" ? 0 : g.frame;
    const entry = byFrame.get(frame) ?? { points: [] };
    if (g.kind === "box") {
      const left = px(g.box.x, size.width);
      const top = px(g.box.y, size.height);
      entry.box = { left, top, right: Math.max(left + 1, Math.min(size.width, Math.round((g.box.x + g.box.w) * size.width))), bottom: Math.max(top + 1, Math.min(size.height, Math.round((g.box.y + g.box.h) * size.height))) };
    } else {
      for (const p of g.points) entry.points.push({ x: px(p.x, size.width), y: px(p.y, size.height), label: p.label });
    }
    byFrame.set(frame, entry);
  }
  const options: BuildObjectPromptOptions = {
    size: { width: size.width, height: size.height },
    objects: [{ id: 1, prompts: [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([frame, e]) => ({ frame, ...(e.box ? { box: e.box } : {}), ...(e.points.length ? { points: e.points.slice(0, 16) } : {}) })) }],
  };
  return { kind: "objects", options };
}

/** Object list for the selection UI (all detections, regardless of the current selection). */
export function objectsFromResult(result: SamResult, label: string, size: FrameSize): Segmentation["objects"] {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return result.objectIds.slice(0, 16).map((objectId) => {
    const dets = result.detections.filter((d) => d.objectId === objectId);
    const first = dets.reduce((a, b) => (b.frame < a.frame ? b : a), dets[0]!);
    const scores = dets.map((d) => d.confidence).filter((c): c is number => typeof c === "number");
    return {
      objectId,
      label: result.objectIds.length > 1 ? `${label} ${Number(objectId) + 1 || objectId}`.slice(0, 80) : label.slice(0, 80),
      score: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000 : undefined,
      bbox: {
        x: clamp(first.bounds.left / size.width),
        y: clamp(first.bounds.top / size.height),
        w: clamp((first.bounds.right - first.bounds.left) / size.width),
        h: clamp((first.bounds.bottom - first.bounds.top) / size.height),
      },
      framesTracked: new Set(dets.map((d) => d.frame)).size,
    };
  });
}

interface StoredSamOutput {
  model: string;
  media: "image" | "video";
  prompt: unknown;
  width: number;
  height: number;
  fps?: number;
  frameCount: number;
  rawOutput: string;
  createdAt: string;
}

export async function segmentHandler(ctx: JobContext<"media.segment">) {
  const segRepo = ctx.ws.collection("segmentations");
  const seg = await segRepo.getOrThrow(ctx.payload.segmentationId);
  const refs = (s: Segmentation) => [{ entity: "segmentations", id: s.id }, ...[s.maskAssetId, s.cutoutAssetId, s.previewAssetId].filter(Boolean).map((id) => ({ entity: "mediaAssets", id: id! }))];
  if (seg.status === "succeeded") return { refs: refs(seg), data: { alreadyDone: true }, creditsUsed: 0 };
  const source = await ctx.ws.collection("mediaAssets").getOrThrow(seg.sourceAssetId);
  if (source.status !== "ready") throw new AppError("CONFLICT", `Source asset is ${source.status}`, { retryable: false, userMessage: "The video is still processing. Try again in a moment." });
  await segRepo.update(seg.id, { status: "running", error: undefined }, { actor: ctx.actor });
  try {
    return await withWorkdir((dir) => runSegmentation(ctx, seg, source, dir));
  } catch (err) {
    const e = err instanceof AppError ? err : new AppError("INTERNAL", (err as Error).message, { retryable: false, cause: err });
    if (!e.retryable || e.code === "CANCELLED") {
      const usageEventIds = await usageEventIdsForJob(ctx).catch(() => []);
      await segRepo.update(seg.id, { status: "failed", error: e.message.slice(0, 1000), usageEventIds: [...new Set([...seg.usageEventIds, ...usageEventIds])].slice(-200) }, { actor: ctx.actor }).catch(() => {});
    }
    throw e;
  }
}

async function runSegmentation(ctx: JobContext<"media.segment">, seg: Segmentation, source: MediaAsset, dir: string) {
  const p = ctx.platform;
  const assets = ctx.ws.collection("mediaAssets");
  const segRepo = ctx.ws.collection("segmentations");
  const isVideo = seg.mediaType === "video";
  const src = join(dir, `source.${EXT_BY_MIME[source.mimeType] ?? "bin"}`);
  await ctx.progress(3, "preparing");
  await p.storage.downloadToFile(source.storagePath, src);
  const info = await probeMedia(src, { signal: ctx.signal });
  const size: FrameSize = { width: info.displayWidth ?? source.width ?? 0, height: info.displayHeight ?? source.height ?? 0 };
  if (!size.width || !size.height) throw new AppError("BAD_REQUEST", "Could not read media dimensions", { retryable: false });
  const fps = isVideo ? (info.fps ?? source.fps ?? 30) : undefined;
  const frameCount = isVideo ? (info.frameCount ?? (await countVideoFrames(src, { signal: ctx.signal })) ?? Math.round((info.durationSec ?? 0) * fps!)) : 1;
  if (isVideo && frameCount > SAM_MAX_FRAMES) throw new AppError("BAD_REQUEST", `Video has ${frameCount} frames; SAM accepts up to ${SAM_MAX_FRAMES}`, { retryable: false, userMessage: "That clip is too long to track (max ~10 minutes). Trim it first." });

  // 1) SAM output: reuse the stored raw output (object re-selection, retries) or call SAM once.
  let stored: StoredSamOutput | undefined;
  let usedSam = false;
  if (seg.outputAssetId) {
    const out = await assets.get(seg.outputAssetId);
    if (out && out.status === "ready") stored = JSON.parse((await p.storage.get(out.storagePath)).toString("utf8")) as StoredSamOutput;
  }
  let outputAssetId = seg.outputAssetId;
  if (!stored) {
    const prompt = samPromptFor(seg, size);
    await ctx.progress(8, isVideo ? "uploading to SAM" : "segmenting");
    const cc = callCtx(ctx, "media.segment");
    let fileId: string | undefined;
    try {
      const media = isVideo
        ? { kind: "video" as const, fileId: (fileId = (await uploadMetaFile(p, cc, { localPath: src, filename: "source.mp4", mimeType: "video/mp4", expiresAfterSec: 6 * 3600 })).id) }
        : { kind: "image" as const, imageUrl: `data:${source.mimeType};base64,${(await readFile(src)).toString("base64")}` };
      ctx.throwIfCancelled();
      await ctx.progress(12, "segmenting");
      const result = await runSam(p, cc, {
        media,
        prompt,
        frameCount,
        onFrames: (n) => void ctx.progress(12 + Math.min(48, (48 * n) / Math.max(1, frameCount)), "tracking", `${n}/${frameCount} frames`),
      });
      stored = { model: result.model, media: seg.mediaType, prompt: prompt.kind === "text" ? { text: prompt.text } : prompt.options, width: size.width, height: size.height, fps, frameCount, rawOutput: result.rawOutput, createdAt: new Date().toISOString() };
      usedSam = true;
    } finally {
      if (fileId) await deleteMetaFile(p, fileId);
    }
    // Persist immediately so a retry (or later object re-selection) never pays for SAM again.
    outputAssetId = derivedId("ast", seg.id, ctx.job.id, "sam");
    const key = workspaceKey(ctx.workspaceId, "media", source.id, "sam", `${outputAssetId}.json`);
    const { bytes, sha256 } = await p.storage.put(key, JSON.stringify(stored), { contentType: "application/json" });
    await assets.createIfAbsent(
      { id: outputAssetId, ...inheritFrom(source), kind: "json", role: "mask", origin: "derived", storagePath: key, mimeType: "application/json", bytes, sha256, status: "ready", labels: ["sam_output"], sourceLabel: "sam_output", isProductTruth: false, title: `SAM output: ${seg.prompt}`.slice(0, 200) },
      { actor: ctx.actor },
    );
    await segRepo.update(seg.id, { outputAssetId }, { actor: ctx.actor });
  }
  ctx.throwIfCancelled();

  const result = parseSamOutput(stored.rawOutput, stored.media, stored.model);
  const objects = objectsFromResult(result, seg.corrections.some((c) => c.kind === "box" || c.kind === "point") ? `${seg.prompt} (refined)` : seg.prompt, size);
  const dets = selectDetections(result, seg.selectedObjectIds);
  const sam = samFrameSize(stored.rawOutput);
  const usageEventIds = [...new Set([...seg.usageEventIds, ...(await usageEventIdsForJob(ctx))])].slice(-200);
  const previous = [seg.maskAssetId, seg.cutoutAssetId, seg.previewAssetId].filter((x): x is string => Boolean(x));

  if (!dets.length) {
    const updated = await segRepo.update(
      seg.id,
      { status: "succeeded", objects, maskAssetId: undefined, cutoutAssetId: undefined, previewAssetId: undefined, frameCount: isVideo ? frameCount : undefined, fps, trackingQuality: 0, usageEventIds, outputAssetId, error: undefined },
      { actor: ctx.actor },
    );
    await retire(ctx, seg.id, previous);
    await ctx.log_event(`No “${seg.prompt}” found`);
    return { refs: [{ entity: "segmentations", id: updated.id }], data: { matches: 0, usedSam }, creditsUsed: usedSam ? undefined : 0 };
  }

  // 2) Matte → cutout → preview.
  const ids = { matte: derivedId("ast", seg.id, ctx.job.id, "matte"), cutout: derivedId("ast", seg.id, ctx.job.id, "cutout"), preview: derivedId("ast", seg.id, ctx.job.id, "preview") };
  const files = isVideo
    ? { matte: join(dir, "matte.mp4"), cutout: join(dir, "cutout.webm"), preview: join(dir, "preview.mp4") }
    : { matte: join(dir, "matte.png"), cutout: join(dir, "cutout.png"), preview: join(dir, "preview.jpg") };
  let coverage: number[];
  if (isVideo) {
    await ctx.progress(62, "building matte");
    ({ coverage } = await writeVideoMatte(files.matte, size, fps!, frameCount, dets, { sam, signal: ctx.signal, onFrame: (i) => void ctx.progress(62 + (18 * i) / frameCount, "building matte") }));
    await ctx.progress(82, "rendering cutout");
    await writeVideoCutout(src, files.matte, files.cutout, { hasAudio: info.hasAudio, signal: ctx.signal, fast: p.cfg.NODE_ENV === "test" });
  } else {
    ({ coverage } = await writeImageMatte(files.matte, size, dets, sam, ctx.signal));
    await writeImageCutout(src, files.matte, files.cutout, ctx.signal);
  }
  await ctx.progress(92, "rendering preview");
  await writePreview(src, files.matte, files.preview, size, isVideo ? "video" : "image", ctx.signal);

  const scores = dets.map((d) => d.confidence).filter((c): c is number => typeof c === "number");
  const quality = isVideo ? trackingQuality(coverage) : scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000 : 1;
  const common = { ...inheritFrom(source), origin: "derived" as const, status: "ready" as const, width: size.width, height: size.height, durationSec: isVideo ? source.durationSec : undefined, fps };
  const put = async (id: string, file: string, name: string, contentType: string) => {
    const key = workspaceKey(ctx.workspaceId, "media", source.id, "seg", seg.id, `${id}-${name}`);
    const { bytes } = await p.storage.uploadFile(file, key, { contentType });
    return { key, bytes };
  };
  const matte = await put(ids.matte, files.matte, isVideo ? "matte.mp4" : "matte.png", isVideo ? "video/mp4" : "image/png");
  const cutout = await put(ids.cutout, files.cutout, isVideo ? "cutout.webm" : "cutout.png", isVideo ? "video/webm" : "image/png");
  const preview = await put(ids.preview, files.preview, isVideo ? "preview.mp4" : "preview.jpg", isVideo ? "video/mp4" : "image/jpeg");
  const title = `“${seg.prompt}”`.slice(0, 120);
  await assets.createIfAbsent(
    { id: ids.matte, ...common, kind: "mask", role: "mask", storagePath: matte.key, mimeType: isVideo ? "video/mp4" : "image/png", bytes: matte.bytes, hasAudio: false, labels: ["sam_matte", `segmentation:${seg.id}`], sourceLabel: "sam_matte", isProductTruth: false, title: `Matte ${title}` },
    { actor: ctx.actor },
  );
  await assets.createIfAbsent(
    {
      id: ids.cutout,
      ...common,
      kind: isVideo ? "video" : "image",
      role: "other",
      storagePath: cutout.key,
      mimeType: isVideo ? "video/webm" : "image/png",
      bytes: cutout.bytes,
      hasAudio: isVideo ? info.hasAudio : undefined,
      labels: ["sam_cutout", "alpha", `segmentation:${seg.id}`],
      sourceLabel: "sam_cutout",
      // Same real pixels as the source, only masked: keeps the source's product-truth status.
      isProductTruth: source.isProductTruth,
      title: `Cutout ${title}`,
      posterAssetId: source.posterAssetId,
    },
    { actor: ctx.actor },
  );
  await assets.createIfAbsent(
    { id: ids.preview, ...common, kind: isVideo ? "video" : "image", role: "preview", storagePath: preview.key, mimeType: isVideo ? "video/mp4" : "image/jpeg", bytes: preview.bytes, hasAudio: false, width: undefined, height: undefined, labels: ["sam_preview", `segmentation:${seg.id}`], sourceLabel: "sam_preview", isProductTruth: false, title: `Selection preview ${title}` },
    { actor: ctx.actor },
  );
  const updated = await segRepo.update(
    seg.id,
    {
      status: "succeeded",
      objects,
      maskAssetId: ids.matte,
      cutoutAssetId: ids.cutout,
      previewAssetId: ids.preview,
      frameCount: isVideo ? frameCount : undefined,
      fps,
      trackingQuality: quality,
      usageEventIds,
      outputAssetId,
      error: undefined,
    },
    { actor: ctx.actor },
  );
  await retire(ctx, seg.id, previous.filter((id) => !Object.values(ids).includes(id)));
  await ctx.progress(100, "done");
  return {
    refs: [{ entity: "segmentations", id: seg.id }, ...Object.values(ids).map((id) => ({ entity: "mediaAssets", id }))],
    data: { trackingQuality: quality, lowQuality: quality < LOW_QUALITY_THRESHOLD, objects: updated.objects.length, framesWithMask: coverage.filter((c) => c > 0).length, frameCount, usedSam },
    // Re-selecting objects from stored SAM output costs nothing.
    creditsUsed: usedSam ? undefined : 0,
  };
}

/**
 * Remove superseded matte/cutout/preview objects (a newer run replaced them). Only assets this
 * segmentation created are removed: reused results share the original segmentation's assets.
 */
async function retire(ctx: JobContext, segId: string, assetIds: string[]) {
  const repo = ctx.ws.collection("mediaAssets");
  for (const id of assetIds) {
    try {
      const a = await repo.get(id);
      if (!a || a.status === "deleted" || !a.labels.includes(`segmentation:${segId}`)) continue;
      await ctx.platform.storage.delete(a.storagePath);
      await repo.update(id, { status: "deleted" }, { actor: ctx.actor });
    } catch (err) {
      ctx.log.warn({ err, id }, "failed to retire superseded segmentation asset");
    }
  }
}
