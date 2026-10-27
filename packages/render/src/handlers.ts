/**
 * Render-module job handlers: composition.build, render.preview, render.final,
 * composition.variants, package.export. All idempotent (deterministic ids / cache keys).
 */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AspectRatio,
  type ClipAnalysis,
  type Claim,
  type Composition,
  type CompositionDoc,
  type CompositionVersion,
  type MediaAsset,
  type Segmentation,
} from "@muselaunch/contracts";
import { adaptToAspect, buildFromStoryboard, collectAssetRefs, compileToHtml, docHash, lintDoc, type LintIssue } from "@muselaunch/compositions";
import { ensureNodeCompileRuntime } from "@muselaunch/compositions/node";
import { createComposition, getVersion } from "@muselaunch/compositions/store";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, assertKeyInWorkspace, workspaceKey, type HandlerRegistry, type JobContext, type ObjectStorage } from "@muselaunch/platform";
import { exportPackage } from "./package";
import { extFor, extractFrame, probe, sha256File, shortHash, toJpeg } from "./media";
import { PREVIEW_SCALE, renderCacheKey } from "./keys";
import { renderProject } from "./producer";
import { loadTracksFor, segmentationAssetIds } from "./tracks";

const PREVIEW_TIMEOUT_MS = Number(process.env.RENDER_PREVIEW_TIMEOUT_MS ?? 8 * 60_000);
const FINAL_TIMEOUT_MS = Number(process.env.RENDER_FINAL_TIMEOUT_MS ?? 25 * 60_000);
const READY = new Set(["ready", "uploaded"]);

// ---------------------------------------------------------------------------
// Loading helpers (always through the job's workspace — tenant-scoped)
// ---------------------------------------------------------------------------

async function listAll<T>(fetchPage: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>, cap = 1000): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await fetchPage(cursor);
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && out.length < cap);
  return out;
}

export async function loadAppAssets(ws: WorkspaceDb, appId: string): Promise<MediaAsset[]> {
  return listAll((cursor) => ws.collection("mediaAssets").list({ where: [["appId", "==", appId]], limit: 200, cursor }));
}

export async function loadAppClipAnalyses(ws: WorkspaceDb, appId: string): Promise<ClipAnalysis[]> {
  return (await listAll((cursor) => ws.collection("clipAnalyses").list({ where: [["appId", "==", appId]], limit: 100, cursor }), 300)).filter((a) => a.status === "succeeded" || a.status === "partial");
}

export async function loadAppSegmentations(ws: WorkspaceDb, appId: string): Promise<Segmentation[]> {
  return listAll((cursor) => ws.collection("segmentations").list({ where: [["appId", "==", appId]], limit: 200, cursor }));
}

/** Assets + segmentations a doc needs (ids resolved in this workspace only). */
export async function loadDocMedia(ws: WorkspaceDb, doc: CompositionDoc, storage?: ObjectStorage) {
  const refs = collectAssetRefs(doc);
  const segs = (await ws.collection("segmentations").getMany(refs.segmentationIds)) as Segmentation[];
  const cutouts = segmentationAssetIds(segs);
  const assets = (await ws.collection("mediaAssets").getMany([...new Set([...refs.assetIds, ...cutouts])])) as MediaAsset[];
  const tracks = storage ? await loadTracksFor(storage, ws, segs) : {};
  return { refs, segs, assets, tracks };
}

async function loadClaims(ws: WorkspaceDb, doc: CompositionDoc): Promise<Record<string, Claim>> {
  const ids = [...new Set(doc.scenes.flatMap((s) => s.layers.flatMap((l) => (l.type === "text" ? l.claimIds : []))))];
  if (!ids.length) return {};
  const claims = (await ws.collection("claims").getMany(ids)) as Claim[];
  return Object.fromEntries(claims.map((c) => [c.id, c]));
}

export async function lintForRender(ws: WorkspaceDb, doc: CompositionDoc, storage?: ObjectStorage): Promise<LintIssue[]> {
  const { assets, segs, tracks } = await loadDocMedia(ws, doc, storage);
  return lintDoc(doc, {
    assets: Object.fromEntries(assets.map((a) => [a.id, a])),
    claims: await loadClaims(ws, doc),
    segmentations: Object.fromEntries(segs.map((s) => [s.id, s])),
    tracks: storage ? tracks : undefined,
  });
}

// ---------------------------------------------------------------------------
// composition.build
// ---------------------------------------------------------------------------

async function compositionBuild(ctx: JobContext<"composition.build">) {
  const { appId, storyboardId, compositionId } = ctx.payload;
  await ctx.progress(5, "loading storyboard");
  const storyboard = await ctx.ws.collection("storyboards").getOrThrow(storyboardId);
  if (storyboard.appId !== appId) throw new AppError("BAD_REQUEST", "Storyboard belongs to another app");
  const app = await ctx.ws.collection("apps").getOrThrow(appId);
  const brand = await ctx.ws.collection("brandProfiles").get(app.brandProfileId ?? appId);
  const assets = await loadAppAssets(ctx.ws, appId);
  // Explicit hints may reference assets not tagged with the app id.
  const hinted = storyboard.scenes.flatMap((s) => s.assets.map((h) => h.assetId)).filter((x): x is string => !!x && !assets.some((a) => a.id === x));
  if (hinted.length) assets.push(...((await ctx.ws.collection("mediaAssets").getMany(hinted)) as MediaAsset[]));
  const segmentations = await loadAppSegmentations(ctx.ws, appId);
  ctx.throwIfCancelled();

  await ctx.progress(30, "building composition");
  const existing = await ctx.ws.collection("compositions").get(compositionId);
  let composition: Composition;
  let version: CompositionVersion;
  if (existing) {
    composition = existing;
    version = await getVersion(ctx.ws, compositionId, existing.currentVersion);
  } else {
    const clipAnalyses = await loadAppClipAnalyses(ctx.ws, appId);
    const doc = buildFromStoryboard({ storyboard, app, brand, assets, segmentations, clipAnalyses });
    ({ composition, version } = await createComposition(
      ctx.ws,
      { id: compositionId, appId, campaignId: storyboard.campaignId, variantId: storyboard.variantId, storyboardId, title: storyboard.title, doc },
      ctx.actor,
    ));
  }
  await ctx.progress(60, "checking composition");
  const lint = await lintForRender(ctx.ws, version.doc, ctx.platform.storage);

  // Link back to the concept/variant (idempotent set-add).
  const variant = await ctx.ws.collection("campaignVariants").get(storyboard.variantId);
  if (variant && !variant.compositionIds.includes(compositionId)) {
    await ctx.ws.collection("campaignVariants").update(variant.id, { compositionIds: [...variant.compositionIds, compositionId], status: variant.status === "selected" ? "produced" : variant.status }, { actor: ctx.actor });
  }
  await ctx.log_event(`Composition ${compositionId} v${version.version} ready (${lint.filter((i) => i.level === "error").length} errors, ${lint.filter((i) => i.level === "warning").length} warnings)`, { entity: "compositions", id: compositionId });

  await ctx.progress(80, "queueing preview");
  const preview = await ctx.enqueue("render.preview", { appId, compositionId, version: version.version }, { idempotencyKey: `render.preview:${compositionId}:v${version.version}` });
  return {
    refs: [
      { entity: "compositions", id: compositionId },
      { entity: "compositionVersions", id: version.id },
    ],
    data: { lint, previewJobId: preview.id },
  };
}

// ---------------------------------------------------------------------------
// render.preview / render.final
// ---------------------------------------------------------------------------

type Quality = "preview" | "final";


async function downloadMedia(ctx: JobContext, dir: string, assets: MediaAsset[]): Promise<Record<string, string>> {
  const p = ctx.platform;
  const urls: Record<string, string> = {};
  await mkdir(join(dir, "assets"), { recursive: true });
  for (const a of assets) {
    ctx.throwIfCancelled();
    assertKeyInWorkspace(ctx.workspaceId, a.storagePath);
    const rel = `assets/${a.id}.${extFor(a.mimeType, a.storagePath)}`;
    try {
      await p.storage.downloadToFile(a.storagePath, join(dir, rel));
    } catch (err) {
      throw new AppError("VALIDATION_FAILED", `Media ${a.id} could not be read from storage`, { cause: err, userMessage: "One of the media files in this video is missing. Re-upload it and try again." });
    }
    urls[a.id] = rel;
  }
  return urls;
}

async function setStatus(ctx: JobContext, compositionId: string, patch: Partial<Composition>) {
  try {
    await ctx.ws.collection("compositions").update(compositionId, patch, { actor: ctx.actor });
  } catch (err) {
    ctx.log.warn({ err, compositionId }, "composition status update failed");
  }
}

async function render(ctx: JobContext<"render.preview"> | JobContext<"render.final">, quality: Quality) {
  ensureNodeCompileRuntime();
  const p = ctx.platform;
  const wid = ctx.workspaceId;
  const { compositionId, version } = ctx.payload;
  const format = quality === "final" ? ((ctx.payload as { format?: string }).format ?? "mp4") : "mp4";
  const comp = await ctx.ws.collection("compositions").getOrThrow(compositionId);
  if (comp.appId !== ctx.payload.appId) throw new AppError("BAD_REQUEST", "Composition belongs to another app");
  const ver = await getVersion(ctx.ws, compositionId, version);
  const doc = ver.doc;
  const still = doc.kind !== "video" || format !== "mp4";
  const hash = docHash(doc);
  const cacheKey = renderCacheKey(hash, quality, format);

  // ---- cache: identical doc + quality already rendered -------------------------------------
  const cachedId = `ast_r_${cacheKey}`;
  const cached = await ctx.ws.collection("mediaAssets").get(cachedId);
  if (cached && cached.status === "ready" && (await p.storage.stat(cached.storagePath))) {
    await ctx.progress(100, "reused cached render");
    await finish(ctx, comp, version, quality, cached.id, cached.posterAssetId);
    const frames = still ? await stillSiblings(ctx.ws, cachedId) : [];
    return { refs: [{ entity: "mediaAssets", id: cached.id }, ...frames.map((id) => ({ entity: "mediaAssets", id }))], data: { cached: true, assetId: cached.id }, creditsUsed: 0 };
  }

  // ---- lint gate ------------------------------------------------------------------------------
  const { assets, segs, refs, tracks } = await loadDocMedia(ctx.ws, doc, p.storage);
  const byId = Object.fromEntries(assets.map((a) => [a.id, a]));
  const missing = refs.assetIds.filter((id) => !byId[id] || !READY.has(byId[id]!.status));
  if (missing.length) throw new AppError("VALIDATION_FAILED", `Media not available: ${missing.join(", ")}`, { userMessage: "Some media in this video is missing or still uploading.", details: { missing } });
  if (quality === "final") {
    const errors = lintDoc(doc, { assets: byId, claims: await loadClaims(ctx.ws, doc), segmentations: Object.fromEntries(segs.map((s) => [s.id, s])), tracks }).filter((i) => i.level === "error");
    if (errors.length) throw new AppError("VALIDATION_FAILED", `Composition has ${errors.length} blocking issue(s): ${errors.map((e) => e.message).slice(0, 3).join("; ")}`, { userMessage: "Fix the flagged issues in the editor before the final render.", details: { issues: errors } });
  }

  await setStatus(ctx, compositionId, { status: "rendering" });
  const dir = await mkdtemp(join(tmpdir(), `ml-render-${quality}-`));
  try {
    await ctx.progress(4, "fetching media");
    const urls = await downloadMedia(ctx, dir, assets);
    const fps = quality === "preview" ? Math.min(doc.fps, 24) : doc.fps;
    const compiled = compileToHtml(doc, {
      assetUrl: (id) => urls[id] ?? `assets/${id}`,
      mode: "render",
      gsapSource: "inline",
      scale: quality === "preview" ? PREVIEW_SCALE : 1,
      segmentations: Object.fromEntries(segs.map((s) => [s.id, s])),
      tracks,
      assetKinds: Object.fromEntries(assets.map((a) => [a.id, a.kind])),
      assetHasAudio: Object.fromEntries(assets.filter((a) => a.hasAudio !== undefined).map((a) => [a.id, a.hasAudio!])),
      still,
      sceneSlotSec: still ? 0.2 : undefined,
    });
    await writeFile(join(dir, "index.html"), compiled.html);
    ctx.throwIfCancelled();

    const outPath = join(dir, still ? "frames" : "out.mp4");
    await ctx.progress(10, quality === "preview" ? "rendering preview" : "rendering video");
    await renderProject({
      projectDir: dir,
      outputPath: outPath,
      fps: still ? 30 : fps,
      quality: quality === "preview" ? "draft" : "high",
      format: still ? "png-sequence" : "mp4",
      signal: ctx.signal,
      timeoutMs: quality === "preview" ? PREVIEW_TIMEOUT_MS : FINAL_TIMEOUT_MS,
      onProgress: (pct, msg) => ctx.progress(10 + pct * 0.78, quality === "preview" ? "rendering preview" : "rendering video", msg),
    });
    ctx.throwIfCancelled();
    await ctx.progress(90, "saving");

    if (still) return await saveStills(ctx, comp, ver, compiled.scenes, dir, outPath, cacheKey, format === "jpeg" ? "jpeg" : "png", quality);

    // ---- verify output ----------------------------------------------------------------------
    const info = await probe(outPath, ctx.signal);
    if (!info.durationSec || Math.abs(info.durationSec - compiled.durationSec) > 0.25) {
      throw new AppError("PROVIDER_ERROR", `Rendered duration ${info.durationSec}s does not match ${compiled.durationSec}s`, { retryable: true });
    }
    const posterTime = compiled.scenes[1] ? compiled.scenes[1].start + Math.min(2, (compiled.scenes[1].end - compiled.scenes[1].start) * 0.7) : compiled.durationSec * 0.4;
    const posterPath = join(dir, "poster.jpg");
    await extractFrame(outPath, Math.min(posterTime, compiled.durationSec - 0.1), posterPath, { width: quality === "preview" ? undefined : 720, signal: ctx.signal });

    const base = `v${version}-${quality}`;
    const posterKey = workspaceKey(wid, "renders", compositionId, `${base}-${cacheKey.slice(0, 8)}.jpg`);
    const videoKey = workspaceKey(wid, "renders", compositionId, `${base}-${cacheKey.slice(0, 8)}.mp4`);
    await p.storage.uploadFile(posterPath, posterKey, { contentType: "image/jpeg" });
    const { bytes } = await p.storage.uploadFile(outPath, videoKey, { contentType: "video/mp4" });
    const posterInfo = await stat(posterPath);
    const posterId = `ast_t_${cacheKey}`;
    await ctx.ws.collection("mediaAssets").createIfAbsent(
      {
        id: posterId,
        appId: comp.appId,
        campaignId: comp.campaignId,
        kind: "image",
        role: "thumbnail",
        origin: "render",
        storagePath: posterKey,
        mimeType: "image/jpeg",
        bytes: posterInfo.size,
        status: "ready",
        title: `${comp.title} (poster)`.slice(0, 200),
        labels: ["render-poster"],
        isProductTruth: false,
        license: { type: "owned" },
        derivedFromAssetId: cachedId,
        render: { compositionId, version, quality },
      },
      { actor: ctx.actor },
    );
    const { entity: asset } = await ctx.ws.collection("mediaAssets").createIfAbsent(
      {
        id: cachedId,
        appId: comp.appId,
        campaignId: comp.campaignId,
        kind: "video",
        role: quality === "final" ? "render" : "preview",
        origin: "render",
        storagePath: videoKey,
        mimeType: "video/mp4",
        bytes,
        sha256: await sha256File(outPath),
        width: info.width,
        height: info.height,
        durationSec: info.durationSec,
        fps: info.fps,
        hasAudio: info.hasAudio,
        status: "ready",
        title: `${comp.title} — v${version} ${quality}`.slice(0, 200),
        labels: [`doc:${hash.slice(0, 40)}`, `${doc.aspectRatio}`],
        isProductTruth: false,
        license: { type: "owned" },
        posterAssetId: posterId,
        render: { compositionId, version, quality },
      },
      { actor: ctx.actor },
    );
    await finish(ctx, comp, version, quality, asset.id, posterId);
    const creditsUsed = quality === "final" ? p.credits.estimate("render.final", { durationSec: info.durationSec }).credits : (ctx.job.reservation?.credits ?? 0);
    return {
      refs: [
        { entity: "mediaAssets", id: asset.id },
        { entity: "mediaAssets", id: posterId },
      ],
      data: { assetId: asset.id, posterAssetId: posterId, durationSec: info.durationSec, width: info.width, height: info.height, bytes },
      creditsUsed: ctx.job.reservation ? Math.min(creditsUsed, ctx.job.reservation.credits) : creditsUsed,
    };
  } catch (err) {
    await setStatus(ctx, compositionId, { status: quality === "final" ? "failed" : comp.status === "rendering" ? "draft" : comp.status });
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function finish(ctx: JobContext, comp: Composition, version: number, quality: Quality, assetId: string, posterId?: string) {
  const fresh = await ctx.ws.collection("compositions").getOrThrow(comp.id);
  const isCurrent = fresh.currentVersion === version;
  const keepFinal = quality === "preview" && fresh.lastRender?.quality === "final" && fresh.lastRender.version === version;
  await ctx.ws.collection("compositions").update(
    comp.id,
    {
      status: isCurrent ? (fresh.approvedVersion === version ? "approved" : "rendered") : fresh.status === "rendering" ? "draft" : fresh.status,
      lastRender: keepFinal ? fresh.lastRender : { jobId: ctx.job.id, version, quality, assetId, at: new Date().toISOString() },
      thumbnailAssetId: posterId ?? fresh.thumbnailAssetId,
    },
    { actor: ctx.actor },
  );
}

async function stillSiblings(ws: WorkspaceDb, firstId: string): Promise<string[]> {
  const ids = Array.from({ length: 30 }, (_, i) => `${firstId}_${i + 2}`);
  return (await ws.collection("mediaAssets").getMany(ids)).map((a) => a.id);
}

async function saveStills(
  ctx: JobContext,
  comp: Composition,
  ver: CompositionVersion,
  scenes: { id: string; start: number; end: number }[],
  dir: string,
  framesDir: string,
  cacheKey: string,
  fmt: "png" | "jpeg",
  quality: Quality,
) {
  const p = ctx.platform;
  const files = (await readdir(framesDir)).filter((f) => f.endsWith(".png")).sort();
  if (!files.length) throw new AppError("PROVIDER_ERROR", "Render produced no frames", { retryable: true });
  const refs: { entity: string; id: string }[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i]!;
    const idx = Math.min(files.length - 1, Math.round(((s.start + s.end) / 2) * 30));
    let src = join(framesDir, files[idx]!);
    if (fmt === "jpeg") {
      const jpg = join(dir, `slide-${i + 1}.jpg`);
      await toJpeg(src, jpg, ctx.signal);
      src = jpg;
    }
    const ext = fmt === "jpeg" ? "jpg" : "png";
    const key = workspaceKey(ctx.workspaceId, "renders", comp.id, `v${ver.version}-${quality}-${cacheKey.slice(0, 8)}-slide${i + 1}.${ext}`);
    const { bytes } = await p.storage.uploadFile(src, key, { contentType: fmt === "jpeg" ? "image/jpeg" : "image/png" });
    const id = i === 0 ? `ast_r_${cacheKey}` : `ast_r_${cacheKey}_${i + 1}`;
    await ctx.ws.collection("mediaAssets").createIfAbsent(
      {
        id,
        appId: comp.appId,
        campaignId: comp.campaignId,
        kind: "image",
        role: quality === "final" ? "render" : "preview",
        origin: "render",
        storagePath: key,
        mimeType: fmt === "jpeg" ? "image/jpeg" : "image/png",
        bytes,
        width: ver.doc.width,
        height: ver.doc.height,
        status: "ready",
        title: `${comp.title} — slide ${i + 1}`.slice(0, 200),
        labels: [`doc:${docHash(ver.doc).slice(0, 40)}`, `slide:${i + 1}`],
        isProductTruth: false,
        license: { type: "owned" },
        render: { compositionId: comp.id, version: ver.version, quality },
      },
      { actor: ctx.actor },
    );
    refs.push({ entity: "mediaAssets", id });
  }
  await finish(ctx, comp, ver.version, quality, refs[0]!.id, refs[0]!.id);
  const credits = quality === "final" ? Math.max(1, Math.ceil(scenes.length / 4)) : 0;
  return { refs, data: { slides: refs.length }, creditsUsed: ctx.job.reservation ? Math.min(credits, ctx.job.reservation.credits) : credits };
}

// ---------------------------------------------------------------------------
// composition.variants
// ---------------------------------------------------------------------------

export function variantId(compositionId: string, target: string, mode: "aspect" | "audience" | "hooks"): string {
  if (mode === "aspect") return `${compositionId}_${target.replace(":", "x")}`.slice(0, 120);
  return `${compositionId}_${mode === "hooks" ? "hook" : "aud"}_${shortHash(target.toLowerCase().trim(), 10)}`.slice(0, 120);
}

/** Distinct opening strategies used when the user asks for "N hooks" without writing briefs. */
export const DEFAULT_HOOK_BRIEFS = [
  "Lead with the outcome: show the finished result in the first second, then reveal how.",
  "Open with a sharp question the audience is already asking themselves.",
  "Pattern interrupt: an unexpected line or visual that stops the scroll, then pay it off.",
  "Name the frustration in the audience's own words, then show the app solving it.",
  "Make a direct, specific promise of what they'll get in the next few seconds (verified claims only).",
];

export function hookBriefs(targets: string[]): string[] {
  if (targets.length === 1 && /^[1-5]$/.test(targets[0]!.trim())) return DEFAULT_HOOK_BRIEFS.slice(0, Number(targets[0]));
  return targets.map((t) => t.trim()).filter(Boolean);
}

/** Latest usable clip analyses for the clips a doc shows (object-aware context for Spark). */
async function clipAnalysesForDoc(ws: WorkspaceDb, doc: CompositionDoc): Promise<string[]> {
  const ids: string[] = [];
  const clipIds = [...new Set(doc.scenes.flatMap((s) => s.layers.flatMap((l) => (l.type === "video" ? [l.assetId] : []))))];
  for (const id of clipIds.slice(0, 4)) {
    const page = await ws.collection("clipAnalyses").list({ where: [["sourceAssetId", "==", id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 5 });
    const a = page.items.find((x) => x.status === "succeeded" || x.status === "partial");
    if (a) ids.push(a.id);
  }
  return ids.slice(0, 4);
}

async function compositionVariants(ctx: JobContext<"composition.variants">) {
  const { appId, compositionId, mode, targets } = ctx.payload;
  const comp = await ctx.ws.collection("compositions").getOrThrow(compositionId);
  if (comp.appId !== appId) throw new AppError("BAD_REQUEST", "Composition belongs to another app");
  const ver = await getVersion(ctx.ws, compositionId, comp.currentVersion);
  const refs: { entity: string; id: string }[] = [];
  const jobs: string[] = [];
  if (mode === "hooks") return hookVariants(ctx, comp, ver);
  for (const [i, target] of targets.entries()) {
    ctx.throwIfCancelled();
    await ctx.progress(10 + (i / targets.length) * 80, mode === "aspect" ? `re-laying out ${target}` : `adapting for audience ${i + 1}`);
    const id = variantId(compositionId, target, mode);
    if (mode === "aspect") {
      const ar = AspectRatio.safeParse(target);
      if (!ar.success) throw new AppError("BAD_REQUEST", `Unknown aspect ratio "${target}"`);
      if (ar.data === ver.doc.aspectRatio) continue;
      let rebuilt: CompositionDoc | undefined;
      if (comp.storyboardId) {
        const sb = await ctx.ws.collection("storyboards").get(comp.storyboardId);
        if (sb) {
          const app = await ctx.ws.collection("apps").getOrThrow(appId);
          const brand = await ctx.ws.collection("brandProfiles").get(app.brandProfileId ?? appId);
          rebuilt = buildFromStoryboard({ storyboard: sb, app, brand, assets: await loadAppAssets(ctx.ws, appId), segmentations: await loadAppSegmentations(ctx.ws, appId), clipAnalyses: await loadAppClipAnalyses(ctx.ws, appId), aspectRatio: ar.data, kind: ver.doc.kind });
        }
      }
      const doc = adaptToAspect(ver.doc, ar.data, rebuilt);
      await createComposition(ctx.ws, { id, appId, campaignId: comp.campaignId, variantId: comp.variantId, storyboardId: comp.storyboardId, title: `${comp.title} (${ar.data})`, doc, derivedFromCompositionId: compositionId }, ctx.actor);
      const j = await ctx.enqueue("render.preview", { appId, compositionId: id, version: 1 }, { idempotencyKey: `render.preview:${id}:v1` });
      jobs.push(j.id);
    } else {
      const doc = { ...ver.doc, title: `${ver.doc.title} — ${target}`.slice(0, 200) };
      await createComposition(ctx.ws, { id, appId, campaignId: comp.campaignId, variantId: comp.variantId, storyboardId: comp.storyboardId, title: `${comp.title} — ${target}`.slice(0, 200), doc, derivedFromCompositionId: compositionId }, ctx.actor);
      // AI rewrite for the audience goes through module B's composition.edit (Spark → validated patch).
      const patchId = `pch_${shortHash(`${id}:audience:${target}`, 20)}`;
      const instruction = `Adapt this video for this audience: "${target}". Rewrite the on-screen text (headlines, labels, CTA) so it speaks to them, using only verified claims. Keep the scenes, media, layout and timing.`;
      await ctx.ws.collection("compositionPatches").createIfAbsent(
        { id: patchId, compositionId: id, baseVersion: 1, ops: [], summary: `Audience variant: ${target}`.slice(0, 1000), source: "ai", instruction, affectedSceneIds: [], status: "proposed", validationErrors: [], memoryRefs: [] },
        { actor: ctx.actor },
      );
      const j = await ctx.enqueue("composition.edit", { appId, compositionId: id, baseVersion: 1, instruction, sceneIds: [], patchId }, { idempotencyKey: `composition.edit:${patchId}` });
      jobs.push(j.id);
      refs.push({ entity: "compositionPatches", id: patchId });
    }
    refs.push({ entity: "compositions", id });
  }
  return { refs, data: { jobIds: jobs } };
}

/**
 * N hook variants: each is a copy of the composition whose OPENING scene module B's composition.edit
 * rewrites with Spark (autoApply), with the clip analyses as object-aware context. Other scenes stay
 * byte-identical, so the variants are a clean A/B/C test of the hook.
 */
async function hookVariants(ctx: JobContext<"composition.variants">, comp: Composition, ver: CompositionVersion) {
  const { appId, compositionId } = ctx.payload;
  const briefs = hookBriefs(ctx.payload.targets);
  if (!briefs.length) throw new AppError("BAD_REQUEST", "No hook briefs given");
  const opening = ver.doc.scenes[0]!;
  const clipAnalysisIds = await clipAnalysesForDoc(ctx.ws, ver.doc);
  const refs: { entity: string; id: string }[] = [];
  const hooks: { compositionId: string; brief: string; patchId: string; jobId: string }[] = [];
  for (const [i, brief] of briefs.entries()) {
    ctx.throwIfCancelled();
    await ctx.progress(10 + (i / briefs.length) * 80, `hook ${i + 1} of ${briefs.length}`);
    const id = variantId(compositionId, brief, "hooks");
    const doc = { ...ver.doc, title: `${ver.doc.title} — Hook ${i + 1}`.slice(0, 200) };
    await createComposition(ctx.ws, { id, appId, campaignId: comp.campaignId, variantId: comp.variantId, storyboardId: comp.storyboardId, title: `${comp.title} — Hook ${i + 1}`.slice(0, 200), doc, derivedFromCompositionId: compositionId }, ctx.actor);
    const patchId = `pch_${shortHash(`${id}:hook:${brief}`, 20)}`;
    const instruction = [
      `Rewrite ONLY the opening scene ("${opening.name}") as a new hook that grabs viewers in the first 1.5 seconds.`,
      `Hook brief: ${brief}`,
      "You may change that scene's on-screen text, its timing and motion, and object-aware effects on the presenter clip (spotlight, glow, anchored callouts, app behind the presenter).",
      "Keep every other scene, all media and the brand look unchanged. Use only verified claims.",
    ].join("\n");
    await ctx.ws.collection("compositionPatches").createIfAbsent(
      { id: patchId, compositionId: id, baseVersion: 1, ops: [], summary: `Hook ${i + 1}: ${brief}`.slice(0, 1000), source: "ai", instruction, affectedSceneIds: [opening.id], status: "proposed", validationErrors: [], memoryRefs: [] },
      { actor: ctx.actor },
    );
    const job = await ctx.enqueue(
      "composition.edit",
      { appId, compositionId: id, baseVersion: 1, instruction: instruction.slice(0, 2000), sceneIds: [opening.id], patchId, autoApply: true, clipAnalysisIds },
      { idempotencyKey: `composition.edit:${patchId}` },
    );
    hooks.push({ compositionId: id, brief, patchId, jobId: job.id });
    refs.push({ entity: "compositions", id }, { entity: "compositionPatches", id: patchId });
  }
  return { refs, data: { hooks, jobIds: hooks.map((h) => h.jobId), openingSceneId: opening.id, clipAnalysisIds } };
}

// ---------------------------------------------------------------------------

export const handlers: HandlerRegistry = {
  "composition.build": compositionBuild,
  "render.preview": (ctx) => render(ctx, "preview"),
  "render.final": (ctx) => render(ctx, "final"),
  "composition.variants": compositionVariants,
  "package.export": exportPackage,
};
