import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AspectRatio, MediaAsset, StockItem, Storyboard, StoryboardScene } from "@muselaunch/contracts";
import { AppError, toAppError, workspaceKey, type JobContext, type JobResult } from "@muselaunch/platform";
import {
  findStock,
  getStockDetail,
  guardImagePrompt,
  meterExternal,
  orientationFor,
  resolveImageProvider,
  STOCK_ADAPTERS,
  stockKey,
  stockProvidersFor,
  type ImageSize,
} from "@muselaunch/providers";
import { ffmpeg, probeMedia, type MediaProbe } from "./ffmpeg";
import { storeGeneratedImages } from "./images";
import { makePoster } from "./probe";
import { callCtx, derivedId, EXT_BY_MIME, mediaDeps, sha256, withWorkdir } from "./util";

/**
 * `storyboard.resolve_media`: lifestyle b-roll for a storyboard. Every scene hint of kind
 * stock_video / stock_image / generated_image without an asset gets one:
 *  - stock: the best result across configured providers (Pexels, Pixabay, Openverse) by relevance,
 *    orientation and length; downloaded into workspace storage (no hotlinking), videos trimmed to the
 *    scene + 1 s, ≤1080p, no audio; stored with provider, attribution, source and terms URLs.
 *  - generated_image: the image provider chosen by `chooseImageProvider` (labelled
 *    `ai_generated_image`; the prompt guard keeps app UI out of generated images).
 * The chosen asset id is written back into the hint. Nothing is faked: with no provider, no result
 * or not enough credits the hint stays empty with the reason (`hint.unresolved` + job output), and
 * the builder uses a template without media. Then `composition.build` is enqueued.
 * Stock and generated media are never product truth.
 */

export const BROLL_KINDS = ["stock_video", "stock_image", "generated_image"] as const;
type BrollKind = (typeof BROLL_KINDS)[number];
const isBroll = (k: string): k is BrollKind => (BROLL_KINDS as readonly string[]).includes(k);

const MAX_BYTES = { image: 25 * 1024 * 1024, video: 200 * 1024 * 1024 } as const;
/** Candidates tried per hint when a download or decode fails. */
const MAX_TRIES = 3;
const MAX_IMAGE_EDGE = 2160;
const BROLL_FPS = 30;

type Hint = StoryboardScene["assets"][number];

export interface BrollTarget {
  scene: StoryboardScene;
  hintIndex: number;
  hint: Hint & { kind: BrollKind; query: string };
}

export interface BrollOutcome {
  sceneId: string;
  sceneOrder: number;
  hintIndex: number;
  requestedKind: BrollKind;
  /** Final kind (a stock_video hint becomes stock_image when only photos are available). */
  kind: BrollKind;
  query: string;
  assetId?: string;
  provider?: string;
  reused?: boolean;
  /** Why nothing was attached. */
  unresolved?: string;
  /** Something the user should know about an attached asset (e.g. a photo instead of a clip). */
  note?: string;
  credits: number;
}

/** Hints that still need media (no asset yet, with a query). */
export function brollTargets(sb: Pick<Storyboard, "scenes">): BrollTarget[] {
  const out: BrollTarget[] = [];
  for (const scene of [...sb.scenes].sort((a, b) => a.order - b.order)) {
    scene.assets.forEach((hint, hintIndex) => {
      if (isBroll(hint.kind) && !hint.assetId && hint.query?.trim()) out.push({ scene, hintIndex, hint: hint as BrollTarget["hint"] });
    });
  }
  return out;
}

export function imageSizeFor(aspect: AspectRatio): ImageSize {
  return aspect === "16:9" ? "1536x1024" : aspect === "1:1" ? "1024x1024" : "1024x1536";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function resolveMediaHandler(ctx: JobContext<"storyboard.resolve_media">): Promise<JobResult> {
  const { appId, storyboardId, compositionId } = ctx.payload;
  await ctx.progress(2, "loading storyboard");
  const sb = await ctx.ws.collection("storyboards").getOrThrow(storyboardId);
  if (sb.appId !== appId) throw new AppError("BAD_REQUEST", "Storyboard belongs to another app", { retryable: false });

  const targets = brollTargets(sb);
  let outcomes: BrollOutcome[] = [];
  const warnings: string[] = [];
  if (targets.length) {
    try {
      outcomes = await resolveTargets(ctx, sb, targets);
    } catch (raw) {
      const err = toAppError(raw);
      if (err.code === "CANCELLED" || ctx.signal.aborted) throw err;
      // B-roll never blocks the video: record why and build without it.
      ctx.log.warn({ err: { code: err.code, message: err.message } }, "b-roll resolution stopped");
      warnings.push(`B-roll lookup stopped: ${err.opts.userMessage ?? err.message}`);
    }
    await writeBack(ctx, storyboardId, outcomes);
  }
  for (const o of outcomes) {
    if (o.note) warnings.push(`Scene ${o.sceneOrder + 1}: ${o.note}`);
    if (o.unresolved) warnings.push(`Scene ${o.sceneOrder + 1}: ${o.unresolved}`);
  }

  ctx.throwIfCancelled();
  await ctx.progress(95, "queueing composition build");
  const build = await ctx.enqueue("composition.build", { appId, storyboardId, compositionId }, { idempotencyKey: `composition.build:${storyboardId}`, credits: { operation: "composition.build" } });
  const attached = outcomes.filter((o) => o.assetId);
  return {
    refs: [{ entity: "storyboards", id: storyboardId }, ...[...new Set(attached.map((o) => o.assetId!))].map((id) => ({ entity: "mediaAssets" as const, id }))],
    data: {
      compositionId,
      buildJobId: build.id,
      hints: targets.length,
      resolved: attached.map((o) => ({ sceneId: o.sceneId, kind: o.kind, assetId: o.assetId, provider: o.provider, reused: o.reused ?? false })),
      unresolved: outcomes.filter((o) => !o.assetId).map((o) => ({ sceneId: o.sceneId, kind: o.kind, query: o.query, reason: o.unresolved })),
      warnings,
      creditsCharged: outcomes.reduce((n, o) => n + o.credits, 0),
    },
  };
}

interface ResolveState {
  /** usedKey(item) → asset id (dedupe: each scene gets a different clip when possible). */
  used: Map<string, string>;
  country: string | undefined;
}

/** Short, label-safe identity of a stock item (labels are ≤60 chars). */
export const usedKey = (item: Pick<StockItem, "provider" | "kind" | "id">) => sha256(stockKey(item)).slice(0, 20);
const ITEM_LABEL = "stockitem:";

async function resolveTargets(ctx: JobContext, sb: Storyboard, targets: BrollTarget[]): Promise<BrollOutcome[]> {
  const state: ResolveState = { used: new Map(), country: await requesterCountry(ctx) };
  // Items attached earlier (e.g. a previous partial run) count as used.
  const earlier = sb.scenes.flatMap((s) => s.assets.map((h) => h.assetId)).filter((x): x is string => Boolean(x));
  for (const a of await ctx.ws.collection("mediaAssets").getMany(earlier)) {
    const key = a.labels.find((l) => l.startsWith(ITEM_LABEL))?.slice(ITEM_LABEL.length);
    if (key) state.used.set(key, a.id);
  }
  const out: BrollOutcome[] = [];
  for (const [i, t] of targets.entries()) {
    ctx.throwIfCancelled();
    await ctx.progress(5 + Math.round((i / targets.length) * 85), "finding b-roll", `Scene ${t.scene.order + 1}: ${clip(t.hint.query, 80)}`);
    const base: BrollOutcome = { sceneId: t.scene.id, sceneOrder: t.scene.order, hintIndex: t.hintIndex, requestedKind: t.hint.kind, kind: t.hint.kind, query: t.hint.query, credits: 0 };
    try {
      const r = t.hint.kind === "generated_image" ? await resolveGenerated(ctx, sb, t, state) : await resolveStock(ctx, sb, t, state);
      const o: BrollOutcome = { ...base, ...r };
      out.push(o);
      if (o.assetId) await ctx.log_event(`Scene ${o.sceneOrder + 1}: ${o.reused ? "reused" : "added"} ${o.kind === "generated_image" ? "AI image" : o.kind === "stock_video" ? "stock clip" : "stock photo"} (${o.provider})`, { entity: "mediaAssets", id: o.assetId });
    } catch (raw) {
      const err = toAppError(raw);
      if (err.code === "CANCELLED" || ctx.signal.aborted) throw err;
      out.push({ ...base, unresolved: reasonFor(err) });
    }
  }
  return out;
}

/** Short, user-facing reason for a hint left without media. */
export function reasonFor(err: AppError): string {
  const msg = err.opts.userMessage ?? err.message;
  if (err.code === "INSUFFICIENT_CREDITS") return clip(`Not enough credits for b-roll. ${msg}`, 300);
  if (err.code === "PROVIDER_NOT_CONFIGURED") return clip(msg, 300);
  if (err.code === "RATE_LIMITED") return "The stock provider is rate-limiting requests. Try again in a few minutes.";
  return clip(`Couldn't add b-roll: ${msg}`, 300);
}

async function requesterCountry(ctx: JobContext): Promise<string | undefined> {
  try {
    return (await ctx.db.top("users").get(ctx.requestedBy))?.country ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hold credits for one paid item, run it, then charge exactly that (or give it back on failure).
 * Reservation keys derive from the job + asset so a redelivered job never holds twice.
 */
async function charged<T>(ctx: JobContext, key: string, credits: number, operation: string, fn: () => Promise<T>): Promise<{ value: T; credits: number }> {
  if (credits <= 0) return { value: await fn(), credits: 0 };
  const credit = ctx.platform.credits;
  // B-roll is optional: never spend the credits the composition build (queued next) needs.
  const keep = credit.estimate("composition.build").credits;
  const { available } = await credit.balance(ctx.workspaceId);
  if (available - credits < keep) {
    throw new AppError("INSUFFICIENT_CREDITS", `B-roll needs ${credits} credits; ${available} available and ${keep} kept for the build`, {
      userMessage: `This needs ${credits} credit${credits === 1 ? "" : "s"} and only ${Math.max(0, available - keep)} can be spent without holding up the video.`,
    });
  }
  const r = await credit.reserve(ctx.workspaceId, credits, { operation, idempotencyKey: `broll:${ctx.job.id}:${key}`, actor: ctx.requestedBy, jobId: ctx.job.id });
  try {
    const value = await fn();
    await credit.settle(ctx.workspaceId, r.reservationId, r.credits, { actor: ctx.actor, reason: `Storyboard b-roll (${operation})` });
    return { value, credits: r.credits };
  } catch (err) {
    await credit.release(ctx.workspaceId, r.reservationId, { actor: ctx.actor, reason: "B-roll item failed" }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

async function resolveStock(ctx: JobContext, sb: Storyboard, t: BrollTarget, state: ResolveState): Promise<Partial<BrollOutcome>> {
  const p = ctx.platform;
  let kind: "image" | "video" = t.hint.kind === "stock_video" ? "video" : "image";
  let note: string | undefined;
  if (kind === "video" && !stockProvidersFor(p, "video").length) {
    // Openverse has photos only; a photo (with motion in the template) beats an empty scene.
    kind = "image";
    note = "Stock video needs a Pexels or Pixabay API key on this deployment, so a stock photo was used instead.";
  }
  const found = await findStock(p, callCtx(ctx, "stock.search"), { query: t.hint.query, kind, orientation: orientationFor(sb.aspectRatio), minDurationSec: t.scene.durationSec }, { fetch: mediaDeps(p).fetch });
  const finalKind = kind === "video" ? "stock_video" : "stock_image";
  if (!found.candidates.length) {
    const failed = found.errors.length ? ` (${found.errors.map((e) => `${STOCK_ADAPTERS[e.provider].label}: ${e.message}`).join("; ")})` : "";
    const what = `no stock ${kind === "video" ? "clip" : "photo"} matched “${clip(t.hint.query, 60)}”${failed}.`;
    return { unresolved: clip(note ? `Stock video needs a Pexels or Pixabay API key on this deployment, and ${what}` : what.charAt(0).toUpperCase() + what.slice(1), 300) };
  }
  // Dedupe within the storyboard: each scene gets its own clip; one already used is reused only when nothing else matched.
  const fresh = found.candidates.filter((c) => !state.used.has(usedKey(c.item)));
  if (!fresh.length) {
    const best = found.candidates[0]!.item;
    return { kind: finalKind, assetId: state.used.get(usedKey(best))!, provider: STOCK_ADAPTERS[best.provider].label, reused: true, credits: 0, note };
  }
  let last: AppError | undefined;
  for (const cand of fresh.slice(0, MAX_TRIES)) {
    try {
      const r = await importBroll(ctx, sb, cand.item, t.scene.durationSec);
      state.used.set(usedKey(cand.item), r.asset.id);
      return { kind: finalKind, assetId: r.asset.id, provider: STOCK_ADAPTERS[cand.item.provider].label, credits: r.credits, reused: r.reused, note };
    } catch (raw) {
      const err = toAppError(raw);
      if (err.code === "CANCELLED" || err.code === "INSUFFICIENT_CREDITS" || ctx.signal.aborted) throw err;
      ctx.log.warn({ err: { code: err.code, message: err.message }, item: stockKey(cand.item) }, "b-roll candidate failed; trying the next one");
      last = err;
    }
  }
  throw last ?? new AppError("PROVIDER_ERROR", "No usable stock result");
}

/**
 * Download one stock item into workspace storage as a ready MediaAsset (video trimmed to
 * `sceneSec + 1` s, ≤1080p, no audio; images ≤2160 px). Deterministic id per item + app + length,
 * so re-runs and other storyboards of the app reuse it without downloading or charging again.
 */
export async function importBroll(ctx: JobContext, sb: Pick<Storyboard, "appId" | "campaignId">, item: StockItem, sceneSec: number): Promise<{ asset: MediaAsset; credits: number; reused: boolean }> {
  const p = ctx.platform;
  const deps = mediaDeps(p);
  const repo = ctx.ws.collection("mediaAssets");
  const maxSec = item.kind === "video" ? Math.ceil(sceneSec + 1) : 0;
  const id = derivedId("ast", "broll", item.provider, item.kind, item.id, sb.appId, String(maxSec));
  const existing = await repo.get(id);
  if (existing?.status === "ready") return { asset: existing, credits: 0, reused: true };

  const price = p.credits.estimate("media.stock_download").credits;
  const { value: asset, credits } = await charged(ctx, id, price, "media.stock_download", async () => {
    // Licence, attribution and file URL come from the provider again, server-side.
    const detail = await getStockDetail(p, item.provider, item.id, item.kind, { fetch: deps.fetch });
    const { value: file } = await meterExternal(p, callCtx(ctx, "stock.download"), { provider: "stock", model: item.provider, operation: "http", estimatedUsd: 0 }, async () => {
      const res = await deps.download(detail.downloadUrl, { maxBytes: MAX_BYTES[item.kind], timeoutMs: 120_000, accept: [`${item.kind}/`, "application/octet-stream", "binary/octet-stream"] });
      return { value: res, usage: { costUsdEstimate: 0 }, trace: { request: { provider: item.provider, id: item.id, kind: item.kind, url: detail.downloadUrl }, response: { bytes: res.body.length, contentType: res.contentType } } };
    });
    if (!file.body.length) throw new AppError("PROVIDER_ERROR", "Stock download was empty");
    ctx.throwIfCancelled();
    return withWorkdir(async (dir) => {
      const src = join(dir, "source");
      await writeFile(src, file.body);
      const prepared = item.kind === "video" ? await prepareVideo(ctx, dir, src, maxSec) : await prepareImage(ctx, dir, src);
      const key = workspaceKey(ctx.workspaceId, "stock", id, `${item.provider}-${item.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}.${EXT_BY_MIME[prepared.mimeType] ?? "bin"}`);
      const { bytes } = await p.storage.uploadFile(prepared.path, key, { contentType: prepared.mimeType });
      const d = detail.item;
      const license: MediaAsset["license"] = {
        type: d.license.type,
        provider: STOCK_ADAPTERS[item.provider].label,
        attribution: d.license.attribution,
        sourceUrl: d.pageUrl,
        termsUrl: d.license.url,
        restrictions: `${d.license.name}${d.license.attributionRequired ? " — attribution required" : ""}`.slice(0, 1000),
      };
      let posterAssetId: string | undefined;
      if (item.kind === "video") {
        posterAssetId = `${id}-poster`;
        const posterFile = join(dir, "poster.jpg");
        await makePoster(prepared.path, posterFile, prepared.info.durationSec, ctx.signal);
        const posterKey = workspaceKey(ctx.workspaceId, "stock", id, "poster.jpg");
        const poster = await p.storage.uploadFile(posterFile, posterKey, { contentType: "image/jpeg" });
        const pInfo = await probeMedia(posterFile);
        await repo.createIfAbsent(
          { id: posterAssetId, appId: sb.appId, campaignId: sb.campaignId, kind: "image", role: "thumbnail", origin: "derived", storagePath: posterKey, mimeType: "image/jpeg", bytes: poster.bytes, width: pInfo.width, height: pInfo.height, status: "ready", labels: ["poster"], isProductTruth: false, derivedFromAssetId: id, license, title: d.title ? `${d.title} (poster)`.slice(0, 200) : undefined },
          { actor: ctx.actor },
        );
      }
      const fields = {
        appId: sb.appId,
        campaignId: sb.campaignId,
        kind: item.kind,
        role: item.kind === "video" ? ("stock_video" as const) : ("stock_image" as const),
        origin: "stock" as const,
        storagePath: key,
        mimeType: prepared.mimeType,
        bytes,
        sha256: sha256(file.body),
        width: prepared.info.displayWidth ?? prepared.info.width,
        height: prepared.info.displayHeight ?? prepared.info.height,
        durationSec: item.kind === "video" ? prepared.info.durationSec : undefined,
        fps: item.kind === "video" ? prepared.info.fps : undefined,
        hasAudio: item.kind === "video" ? false : undefined,
        status: "ready" as const,
        title: (d.title ?? `${STOCK_ADAPTERS[item.provider].label} ${item.kind}`).slice(0, 200),
        labels: ["broll", `stock:${item.provider}`, `${ITEM_LABEL}${usedKey(item)}`],
        sourceLabel: "stock",
        isProductTruth: false,
        license,
        posterAssetId,
      };
      const prior = await repo.get(id);
      return prior ? repo.update(id, fields, { actor: ctx.actor }) : (await repo.createIfAbsent({ id, ...fields }, { actor: ctx.actor })).entity;
    });
  });
  return { asset, credits, reused: false };
}

/** Even-sized box that fits within 1080p for the clip's orientation (never upscales). */
export const VIDEO_SCALE = "scale='if(gte(iw,ih),min(1920,iw),min(1080,iw))':'if(gte(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";

/** Trim to `maxSec`, ≤1080p, H.264/yuv420p CFR ≤30 fps, no audio, faststart. */
export async function trimBrollVideo(input: string, output: string, maxSec: number, info: Pick<MediaProbe, "fps">, signal?: AbortSignal): Promise<void> {
  const fps = Math.min(BROLL_FPS, Math.round(info.fps ?? BROLL_FPS)) || BROLL_FPS;
  await ffmpeg(
    [
      "-i", input,
      "-t", String(maxSec),
      "-map", "0:v:0", "-an",
      "-vf", `${VIDEO_SCALE},fps=${fps},format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high",
      "-movflags", "+faststart",
      "-map_metadata", "-1",
      output,
    ],
    { signal, timeoutMs: 10 * 60_000 },
  );
}

async function prepareVideo(ctx: JobContext, dir: string, src: string, maxSec: number): Promise<{ path: string; mimeType: string; info: MediaProbe }> {
  const info = await probeMedia(src, { signal: ctx.signal });
  if (!info.hasVideo) throw new AppError("BAD_REQUEST", "Stock file has no playable video", { retryable: false });
  const out = join(dir, "clip.mp4");
  await trimBrollVideo(src, out, maxSec, info, ctx.signal);
  return { path: out, mimeType: "video/mp4", info: await probeMedia(out, { signal: ctx.signal }) };
}

const IMAGE_MIME_BY_CODEC: Record<string, string> = { mjpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

async function prepareImage(ctx: JobContext, dir: string, src: string): Promise<{ path: string; mimeType: string; info: MediaProbe }> {
  const info = await probeMedia(src, { signal: ctx.signal });
  if (info.kind !== "image" || !info.width || !info.height) throw new AppError("BAD_REQUEST", "Stock file is not a readable image", { retryable: false });
  // The bytes decide the type (servers often send application/octet-stream).
  const mime = IMAGE_MIME_BY_CODEC[info.videoCodec ?? ""];
  if (mime && Math.max(info.width, info.height) <= MAX_IMAGE_EDGE) return { path: src, mimeType: mime, info };
  // Oversized, or a format the renderer shouldn't rely on (GIF, TIFF…): one ≤2160 px JPEG frame.
  const out = join(dir, "image.jpg");
  await ffmpeg(["-i", src, "-frames:v", "1", "-vf", `scale='if(gte(iw,ih),min(${MAX_IMAGE_EDGE},iw),-2)':'if(gte(iw,ih),-2,min(${MAX_IMAGE_EDGE},ih))',format=yuvj420p`, "-q:v", "3", out], { signal: ctx.signal });
  return { path: out, mimeType: "image/jpeg", info: await probeMedia(out, { signal: ctx.signal }) };
}

// ---------------------------------------------------------------------------
// Generated stills
// ---------------------------------------------------------------------------

async function resolveGenerated(ctx: JobContext, sb: Storyboard, t: BrollTarget, state: ResolveState): Promise<Partial<BrollOutcome>> {
  const p = ctx.platform;
  const guard = guardImagePrompt(t.hint.query);
  if (!guard.ok) return { unresolved: guard.userMessage };
  const size = imageSizeFor(sb.aspectRatio);
  // Same prompt twice in one storyboard → one image (no second charge).
  const id = derivedId("ast", "broll-gen", sb.id, t.hint.query.trim().toLowerCase().replace(/\s+/g, " "), size);
  const repo = ctx.ws.collection("mediaAssets");
  const existing = await repo.get(id);
  if (existing?.status === "ready") return { assetId: existing.id, provider: existing.license?.provider ?? existing.generation?.provider, reused: true, credits: 0 };

  const { provider, choice } = resolveImageProvider(p, state.country, { fetch: mediaDeps(p).fetch });
  const price = p.credits.estimate("media.image_generate", { count: 1 }).credits;
  const { value: asset, credits } = await charged(ctx, id, price, "media.image_generate", async () => {
    const result = await provider.generate(callCtx(ctx, "image.generate"), { prompt: guard.prompt, n: 1, size });
    if (!result.images.length) throw new AppError("PROVIDER_ERROR", `${choice.label} returned no image`);
    const [a] = await storeGeneratedImages(ctx, { ids: [id], result, choice, provider, prompt: t.hint.query, size, appId: sb.appId, campaignId: sb.campaignId, labels: ["broll"] });
    return a!;
  });
  return { assetId: asset.id, provider: choice.label, credits };
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

/** Merge outcomes into the CURRENT storyboard (only the hints this job looked at, matched by scene/index/kind/query). */
async function writeBack(ctx: JobContext, storyboardId: string, outcomes: BrollOutcome[]): Promise<void> {
  if (!outcomes.length) return;
  const repo = ctx.ws.collection("storyboards");
  const fresh = await repo.getOrThrow(storyboardId);
  const byKey = new Map(outcomes.map((o) => [`${o.sceneId}#${o.hintIndex}`, o]));
  let changed = false;
  const scenes = fresh.scenes.map((s) => ({
    ...s,
    assets: s.assets.map((h, j): Hint => {
      const o = byKey.get(`${s.id}#${j}`);
      if (!o || h.assetId || h.kind !== o.requestedKind || (h.query ?? "") !== o.query) return h;
      const { unresolved: _prev, ...rest } = h;
      changed = true;
      return o.assetId ? { ...rest, kind: o.kind, assetId: o.assetId } : { ...rest, unresolved: o.unresolved ?? "No media found." };
    }),
  }));
  if (changed) await repo.update(storyboardId, { scenes }, { actor: ctx.actor });
}
