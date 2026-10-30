import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job, MediaAsset } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, toAppError, workspaceKey, type JobContext, type Platform } from "@muselaunch/platform";
import { decodeMaskToRaster, generateJson, imagePart, runSam, type InputPart, type SamDetection } from "@muselaunch/providers";
import { z } from "zod";
import { ffmpeg, ffmpegWriter, probeMedia } from "./ffmpeg";
import { downscaleImage, grayThumbnail } from "./frames";
import { samFrameSize, type FrameSize } from "./masks";
import { callCtx, derivedId, EXT_BY_MIME, withWorkdir } from "./util";

/**
 * Screen cut-outs (`media.extract_ui`). Store screenshots are often designed marketing images (headline,
 * their own device frame, background). Placed inside our iPhone frame they become frame-in-frame with
 * tiny text. This job:
 * 1. asks Muse Spark (multimodal, ≤8 images per call) whether each screenshot is the raw app screen or
 *    a designed store image (`screenshotKind`); a pixel heuristic (plain side margins) is passed as a hint
 *    only — Spark decides;
 * 2. for store images, runs SAM 3.1 image segmentation ("phone screen", then "smartphone display", then
 *    "screen"), picks the detection that is plausibly a phone screen (portrait, big enough, most
 *    confident) and crops it (small inset, rounded corners from the mask) into a derived product-truth
 *    asset with `sourceLabel: "sam_ui_crop"`. Idempotent: originals that already have a cut-out are skipped.
 */

export const UI_SCREEN_PROMPTS = ["phone screen", "smartphone display", "screen"];
/** A plausible phone screen: portrait aspect (w/h) and share of the image. */
export const SCREEN_ASPECT = { min: 0.42, max: 0.6 };
export const SCREEN_MIN_AREA = 0.15;
const CLASSIFY_PER_CALL = 8;
/** Plain side margins at least this wide (share of width) suggest a device frame on a designed background. */
const FRAME_MARGIN_HINT = 0.08;

export const isUiCrop = (a: MediaAsset) => a.sourceLabel === "sam_ui_crop";
/** Real screenshots of the app this job looks at (not cut-outs, not generated). */
export const isOriginalScreenshot = (a: MediaAsset) =>
  a.role === "screenshot" && a.kind === "image" && a.isProductTruth && !a.generation && !isUiCrop(a) && a.status === "ready" && a.mimeType !== "image/svg+xml";

export async function appScreenshots(ws: WorkspaceDb, appId: string): Promise<{ originals: MediaAsset[]; crops: Map<string, MediaAsset> }> {
  const items = (await ws.collection("mediaAssets").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items;
  const crops = new Map<string, MediaAsset>();
  for (const a of items) if (isUiCrop(a) && a.derivedFromAssetId && a.status === "ready") crops.set(a.derivedFromAssetId, a);
  return { originals: items.filter(isOriginalScreenshot), crops };
}

/** Screenshots that still need work: not yet classified, or a store image without a cut-out. */
export function pendingScreens(originals: MediaAsset[], crops: Map<string, MediaAsset>, assetIds?: string[]): MediaAsset[] {
  const only = assetIds?.length ? new Set(assetIds) : null;
  return originals.filter((a) => (!only || only.has(a.id)) && (!a.screenshotKind || (a.screenshotKind === "marketing" && !crops.has(a.id))));
}

export function estimateUiExtraction(p: Platform, pending: number): number {
  return pending * (p.credits.prices["media.extract_ui_per_image"] ?? 2);
}

export async function requestUiExtraction(
  p: Platform,
  wid: string,
  input: { appId: string; assetIds?: string[]; actor: string; idempotencyKey?: string },
): Promise<{ job: Job | null; pending: number; credits: number }> {
  const ws = p.db.ws(wid);
  await ws.collection("apps").getOrThrow(input.appId);
  const { originals, crops } = await appScreenshots(ws, input.appId);
  if (input.assetIds?.length) {
    const known = new Set(originals.map((a) => a.id));
    const missing = input.assetIds.filter((id) => !known.has(id));
    if (missing.length) throw new AppError("NOT_FOUND", `Not a screenshot of this app: ${missing.slice(0, 3).join(", ")}`, { userMessage: "Choose real screenshots of this app." });
  }
  const pending = pendingScreens(originals, crops, input.assetIds);
  if (!pending.length) return { job: null, pending: 0, credits: 0 };
  const credits = estimateUiExtraction(p, pending.length);
  const job = await p.jobs.create(wid, "media.extract_ui", { appId: input.appId, assetIds: input.assetIds }, {
    actor: input.actor,
    appId: input.appId,
    idempotencyKey: input.idempotencyKey ?? `extract_ui:${input.appId}:${pending.map((a) => a.id).sort().join(",")}`.slice(0, 200),
    credits: { operation: "media.extract_ui", amount: credits },
  });
  return { job, pending: pending.length, credits };
}

// ---------------------------------------------------------------------------
// Heuristic hint (pixel statistics; never decides on its own)
// ---------------------------------------------------------------------------

const HW = 48;
const HH = 96;

/**
 * Share of the width that is plain (flat or smoothly shaded) on BOTH sides, measured on the lower 60 %
 * of the image (below a typical headline). Designed store images usually show a device on a plain or
 * gradient background; raw screen captures have content near the edges.
 */
export function plainSideMargin(gray: Buffer, w = HW, h = HH): number {
  const y0 = Math.floor(h * 0.3);
  const y1 = Math.floor(h * 0.9);
  const flat = (x: number) => {
    for (let y = y0; y < y1; y++) {
      const v = gray[y * w + x]!;
      if (y > y0 && Math.abs(v - gray[(y - 1) * w + x]!) > 4) return false;
      if (x > 0 && Math.abs(v - gray[y * w + x - 1]!) > 4) return false;
      if (x < w - 1 && Math.abs(v - gray[y * w + x + 1]!) > 4) return false;
    }
    return true;
  };
  let left = 0;
  while (left < w / 2 && flat(left)) left++;
  let right = 0;
  while (right < w / 2 && flat(w - 1 - right)) right++;
  return Math.min(left, right) / w;
}

export function marginHint(margin: number): string {
  const pct = Math.round(margin * 100);
  return margin >= FRAME_MARGIN_HINT
    ? `plain side margins ≈${pct}% of the width (typical of a device frame on a designed background)`
    : `content reaches the side edges (plain margin ≈${pct}%), typical of a raw screen capture`;
}

// ---------------------------------------------------------------------------
// Muse Spark classification
// ---------------------------------------------------------------------------

export const ScreenshotKinds = z.object({
  images: z
    .array(
      z.object({
        assetId: z.string().max(128).describe("The asset id given for the image"),
        kind: z.enum(["raw_ui", "marketing"]),
        reason: z.string().max(300).optional(),
      }),
    )
    .max(CLASSIFY_PER_CALL),
});

const CLASSIFY_INSTRUCTIONS = `You are Muse Spark sorting an app's store screenshots for MuseLaunch's video editor. For each attached image decide:
- raw_ui: the image IS the app's screen exactly as captured on the device: edge-to-edge app UI (often with the status bar), no added headline, decorative background or device frame.
- marketing: a designed store image: a headline or caption added around the UI, a drawn device frame or bezel, a decorative or gradient background, several screens composed together, or the UI shown smaller inside the canvas.
The heuristic note for each image comes from simple pixel statistics and may be wrong: decide from what you see. Use the exact asset id given for each image.`;

interface Classified {
  kind: "raw_ui" | "marketing";
  reason?: string;
}

async function classifyBatch(ctx: JobContext, app: { name: string }, batch: { asset: MediaAsset; jpeg: Buffer; hint: string }[]): Promise<Map<string, Classified>> {
  const parts: InputPart[] = batch.map((b) => imagePart({ bytes: b.jpeg, mimeType: "image/jpeg" }));
  const text = [
    `App: ${app.name}`,
    "",
    "Images attached, in order:",
    ...batch.map((b, i) => `Image ${i + 1}: asset ${b.asset.id} — ${JSON.stringify((b.asset.title ?? b.asset.originalFilename ?? "screenshot").slice(0, 120))}, ${b.asset.width ?? "?"}×${b.asset.height ?? "?"} px. Heuristic: ${b.hint}`),
    "",
    "Return one entry per image.",
  ].join("\n");
  const out = await generateJson(ctx.platform, {
    ctx: callCtx(ctx, "media.extract_ui.classify"),
    model: "spark",
    instructions: CLASSIFY_INSTRUCTIONS,
    input: [{ type: "input_text", text }, ...parts],
    schema: ScreenshotKinds,
    schemaName: "ScreenshotKinds",
    maxOutputTokens: 1500,
    reasoningEffort: "low",
    cacheKey: "media.screenshot_kinds",
  });
  const ids = new Set(batch.map((b) => b.asset.id));
  const res = new Map<string, Classified>();
  for (const x of out.data.images) if (ids.has(x.assetId) && !res.has(x.assetId)) res.set(x.assetId, { kind: x.kind, reason: x.reason });
  return res;
}

// ---------------------------------------------------------------------------
// SAM 3.1 screen detection + crop
// ---------------------------------------------------------------------------

export interface ScreenPick {
  det: SamDetection;
  /** Box in image pixels (half-open). */
  box: { left: number; top: number; right: number; bottom: number };
  aspect: number;
  area: number;
  confidence: number;
}

/** The detection that is plausibly a phone screen (portrait, ≥15 % of the image, most confident). */
export function pickPhoneScreen(dets: SamDetection[], image: FrameSize, sam?: FrameSize): ScreenPick | null {
  const sx = sam && sam.width !== image.width ? image.width / sam.width : 1;
  const sy = sam && sam.height !== image.height ? image.height / sam.height : 1;
  let best: ScreenPick | null = null;
  for (const det of dets) {
    const box = {
      left: Math.max(0, Math.round(det.bounds.left * sx)),
      top: Math.max(0, Math.round(det.bounds.top * sy)),
      right: Math.min(image.width, Math.round(det.bounds.right * sx)),
      bottom: Math.min(image.height, Math.round(det.bounds.bottom * sy)),
    };
    const w = box.right - box.left;
    const h = box.bottom - box.top;
    if (w <= 0 || h <= 0) continue;
    const aspect = w / h;
    const area = (w * h) / (image.width * image.height);
    if (aspect < SCREEN_ASPECT.min || aspect > SCREEN_ASPECT.max || area < SCREEN_MIN_AREA) continue;
    const confidence = det.confidence ?? 0;
    if (!best || confidence > best.confidence || (confidence === best.confidence && area > best.area)) best = { det, box, aspect, area, confidence };
  }
  return best;
}

/** Corner radius (image px) estimated from where the mask's top row and left column begin. */
export function cornerRadius(det: SamDetection, boxW: number, boxH: number): number {
  const raster = decodeMaskToRaster(det.mask);
  const mw = det.mask.width;
  const mh = det.mask.height;
  if (!mw || !mh) return 0;
  let x0 = 0;
  while (x0 < mw / 2 && !raster[x0]) x0++;
  let y0 = 0;
  while (y0 < mh / 2 && !raster[y0 * mw]) y0++;
  const r = Math.max((x0 * boxW) / mw, (y0 * boxH) / mh);
  return Math.min(r, 0.15 * Math.min(boxW, boxH));
}

/** Anti-aliased rounded-rectangle alpha (w×h gray bytes). */
export function roundedAlpha(w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h).fill(255);
  if (r < 1) return out;
  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 < r ? r - (y + 0.5) : y + 0.5 > h - r ? y + 0.5 - (h - r) : 0;
    if (!dy) continue;
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 < r ? r - (x + 0.5) : x + 0.5 > w - r ? x + 0.5 - (w - r) : 0;
      if (!dx) continue;
      const a = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(dx, dy)));
      out[y * w + x] = Math.round(a * 255);
    }
  }
  return out;
}

async function cropScreen(src: string, out: string, pick: ScreenPick, dir: string, signal?: AbortSignal): Promise<{ width: number; height: number; radius: number }> {
  const bw = pick.box.right - pick.box.left;
  const bh = pick.box.bottom - pick.box.top;
  // Small inset so no bezel/background pixels remain at the edges.
  const inset = Math.max(2, Math.round(Math.min(bw, bh) * 0.006));
  const x = pick.box.left + inset;
  const y = pick.box.top + inset;
  const w = Math.max(2, bw - 2 * inset);
  const h = Math.max(2, bh - 2 * inset);
  const radius = Math.max(0, Math.round(cornerRadius(pick.det, bw, bh) - inset));
  const matte = join(dir, `${Math.random().toString(36).slice(2)}-alpha.png`);
  const writer = ffmpegWriter(["-f", "rawvideo", "-pix_fmt", "gray", "-s", `${w}x${h}`, "-i", "pipe:0", "-frames:v", "1", "-pix_fmt", "gray", matte], { signal });
  const alpha = roundedAlpha(w, h, radius);
  await writer.write(Buffer.from(alpha.buffer, alpha.byteOffset, alpha.byteLength));
  await writer.end();
  await ffmpeg(["-i", src, "-i", matte, "-filter_complex", `[0:v]crop=${w}:${h}:${x}:${y},format=rgba[s];[1:v]format=gray[a];[s][a]alphamerge[v]`, "-map", "[v]", "-frames:v", "1", out], { signal });
  return { width: w, height: h, radius };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function extractUiHandler(ctx: JobContext<"media.extract_ui">) {
  const result = await withWorkdir((dir) => runExtraction(ctx, dir));
  await ctx.progress(100, "done");
  return result;
}

async function runExtraction(ctx: JobContext<"media.extract_ui">, dir: string) {
  const p = ctx.platform;
  const ws = ctx.ws;
  const appId = ctx.payload.appId;
  const app = await ws.collection("apps").getOrThrow(appId);
  const assets = ws.collection("mediaAssets");
  const { originals, crops } = await appScreenshots(ws, appId);
  const pending = pendingScreens(originals, crops, ctx.payload.assetIds);
  const price = p.credits.prices["media.extract_ui_per_image"] ?? 2;
  if (!pending.length) return { refs: [], data: { classified: 0, cutOut: 0, alreadyDone: true }, creditsUsed: 0 };

  // Local copies (original for cropping, small JPEG for Spark and SAM).
  await ctx.progress(4, "reading screenshots");
  const local = new Map<string, { src: string; small: string; size: FrameSize; smallSize: FrameSize }>();
  for (const a of pending) {
    ctx.throwIfCancelled();
    const src = join(dir, `${a.id}.${EXT_BY_MIME[a.mimeType] ?? "img"}`);
    await p.storage.downloadToFile(a.storagePath, src);
    const info = await probeMedia(src, { signal: ctx.signal });
    const width = info.displayWidth ?? info.width ?? a.width;
    const height = info.displayHeight ?? info.height ?? a.height;
    if (!width || !height) continue;
    const small = join(dir, `${a.id}-small.jpg`);
    await downscaleImage(src, small, 1600, { signal: ctx.signal });
    const s = await probeMedia(small, { signal: ctx.signal });
    local.set(a.id, { src, small, size: { width, height }, smallSize: { width: s.width ?? width, height: s.height ?? height } });
  }
  const processed = new Set<string>();

  // 1) Muse Spark: raw UI or designed store image.
  const toClassify = pending.filter((a) => !a.screenshotKind && local.has(a.id));
  const kinds = new Map<string, "raw_ui" | "marketing">(pending.filter((a) => a.screenshotKind).map((a) => [a.id, a.screenshotKind!]));
  const reasons: Record<string, string> = {};
  for (let i = 0; i < toClassify.length; i += CLASSIFY_PER_CALL) {
    ctx.throwIfCancelled();
    await ctx.progress(10 + (40 * i) / toClassify.length, "checking screenshots", `${i}/${toClassify.length}`);
    const batch = [];
    for (const a of toClassify.slice(i, i + CLASSIFY_PER_CALL)) {
      const l = local.get(a.id)!;
      const thumb = join(dir, `${a.id}-classify.jpg`);
      await downscaleImage(l.small, thumb, 768, { quality: 4, signal: ctx.signal });
      const gray = await grayThumbnail(l.src, join(dir, `${a.id}.gray`), HW, HH, ctx.signal);
      batch.push({ asset: a, jpeg: await readFile(thumb), hint: marginHint(plainSideMargin(gray)) });
    }
    const res = await classifyBatch(ctx, app, batch);
    for (const b of batch) {
      const c = res.get(b.asset.id);
      if (!c) continue; // not answered: stays unclassified (retried next run), never guessed
      kinds.set(b.asset.id, c.kind);
      if (c.reason) reasons[b.asset.id] = c.reason.slice(0, 200);
      processed.add(b.asset.id);
      await assets.update(b.asset.id, { screenshotKind: c.kind }, { actor: ctx.actor });
    }
  }

  // 2) SAM 3.1: cut the app screen out of store images.
  const toCut = pending.filter((a) => kinds.get(a.id) === "marketing" && !crops.has(a.id) && local.has(a.id));
  const refs: { entity: string; id: string }[] = [];
  const noScreen: string[] = [];
  const failed: string[] = [];
  let firstError: AppError | undefined;
  for (const [i, a] of toCut.entries()) {
    ctx.throwIfCancelled();
    await ctx.progress(50 + (45 * i) / toCut.length, "cutting out app screens", `${i + 1}/${toCut.length}`);
    const l = local.get(a.id)!;
    processed.add(a.id);
    try {
      const imageUrl = `data:image/jpeg;base64,${(await readFile(l.small)).toString("base64")}`;
      let pick: ScreenPick | null = null;
      let prompt = "";
      for (const text of UI_SCREEN_PROMPTS) {
        const result = await runSam(p, callCtx(ctx, "media.extract_ui"), { media: { kind: "image", imageUrl }, prompt: { kind: "text", text } });
        // Boxes are in the pixels SAM saw (the downscaled copy): scale them to the original.
        pick = pickPhoneScreen(result.detections, l.size, samFrameSize(result.rawOutput) ?? l.smallSize);
        prompt = text;
        if (pick) break;
      }
      if (!pick) {
        noScreen.push(a.id);
        await ctx.log_event(`No phone screen found in “${(a.title ?? a.id).slice(0, 80)}”; it stays a full-screen image`);
        continue;
      }
      const id = derivedId("ast", a.id, "sam_ui_crop");
      const file = join(dir, `${id}.png`);
      const cut = await cropScreen(l.src, file, pick, dir, ctx.signal);
      const key = workspaceKey(ctx.workspaceId, "media", a.id, `${id}-ui-crop.png`);
      const { bytes } = await p.storage.uploadFile(file, key, { contentType: "image/png" });
      await assets.createIfAbsent(
        {
          id,
          appId,
          campaignId: a.campaignId,
          kind: "image",
          role: "screenshot",
          origin: "derived",
          storagePath: key,
          mimeType: "image/png",
          bytes,
          width: cut.width,
          height: cut.height,
          status: "ready",
          title: `${(a.title ?? a.originalFilename ?? "Screenshot").slice(0, 150)} — app screen (cut out by SAM 3.1)`,
          labels: ["sam_ui_crop", `prompt:${prompt}`.slice(0, 60)],
          isProductTruth: true,
          sourceLabel: "sam_ui_crop",
          derivedFromAssetId: a.id,
          screenshotKind: "raw_ui",
          license: a.license,
        },
        { actor: ctx.actor },
      );
      refs.push({ entity: "mediaAssets", id });
    } catch (raw) {
      const e = toAppError(raw);
      if (e.code === "CANCELLED") throw e;
      firstError ??= e;
      failed.push(a.id);
      ctx.log.warn({ code: e.code, assetId: a.id }, "screen cut-out failed");
      await ctx.log_event(`Screen cut-out failed for “${(a.title ?? a.id).slice(0, 80)}”: ${e.opts.userMessage ?? e.message}`.slice(0, 500));
    }
  }
  // Nothing worked at all: fail visibly (retryable provider errors are redelivered).
  if (firstError && !refs.length && failed.length === toCut.length && !toClassify.length) throw firstError;

  const reserved = ctx.job.reservation?.credits ?? 0;
  return {
    refs: [...refs, ...[...kinds.keys()].map((id) => ({ entity: "mediaAssets", id }))],
    data: {
      classified: toClassify.filter((a) => kinds.has(a.id)).length,
      marketing: [...kinds.values()].filter((k) => k === "marketing").length,
      cutOut: refs.length,
      noScreenFound: noScreen,
      failed,
      reasons,
    },
    // Charge per screenshot actually checked or cut out (unanswered ones are retried for free).
    creditsUsed: Math.min(reserved, processed.size * price),
  };
}
