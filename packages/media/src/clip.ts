import { join } from "node:path";
import type { ClipAnalysis, Job, MediaAsset, Segmentation, Transcript } from "@muselaunch/contracts";
import { AppError, type JobContext, type Platform } from "@muselaunch/platform";
import { normaliseConceptPrompt } from "@muselaunch/providers";
import { countVideoFrames, probeMedia } from "./ffmpeg";
import { runSegmentationSafely, SAM_MAX_FRAMES, MAX_OBJECT_OUTPUTS } from "./segment";
import { ensureConsent, findOrCreateSegmentation, findOrCreateTranscript, lookupSegmentation, lookupTranscript, PERSON_PROMPT } from "./service";
import { loadTracks, meanBbox, presenceRanges, trackQuality } from "./tracks";
import { runTranscriptionSafely } from "./transcribe";
import { EXT_BY_MIME, usageEventIdsForJob, withWorkdir } from "./util";

/**
 * Clip analysis (`media.analyze_clip`): SAM 3.1 on several prompts (person, phone…) for one real
 * clip → per-object tracks, cutouts and mattes, plus a Muse Voice transcript. Spark's effects
 * director and the HyperFrames compiler read the result. Everything reuses the content-hash caches,
 * so analysing the same clip again costs nothing. Partial failures are reported per prompt; tracks
 * are never invented.
 */

export const DEFAULT_CLIP_PROMPTS = ["person", "phone"];

function normalisePrompts(prompts: string[]): string[] {
  const out = [...new Set(prompts.map((x) => normaliseConceptPrompt(x).slice(0, 60)).filter(Boolean))];
  if (!out.length) throw new AppError("BAD_REQUEST", "No prompts", { userMessage: "Name at least one thing to track, e.g. “person” or “phone”." });
  return out.slice(0, 6);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

/** Credits a clip analysis would reserve now (cached prompts / transcript cost nothing). */
export async function estimateClipAnalysis(p: Platform, wid: string, asset: MediaAsset, prompts: string[], transcribe: boolean): Promise<{ credits: number; breakdown: { label: string; credits: number }[] }> {
  const breakdown: { label: string; credits: number }[] = [];
  for (const prompt of prompts) {
    const { mine, same } = await lookupSegmentation(p, wid, asset, prompt);
    const cached = Boolean((mine && mine.status !== "failed") || same);
    const c = cached ? 0 : p.credits.estimate("media.segment", { mediaType: "video", durationSec: asset.durationSec ?? 0 }).credits;
    breakdown.push({ label: `Track “${prompt}”${cached ? " (reused)" : ""}`, credits: c });
  }
  if (transcribe && asset.hasAudio !== false) {
    const { exact, prior } = await lookupTranscript(p, wid, asset, "captions");
    const cached = Boolean((exact && exact.status !== "failed") || prior);
    breakdown.push({ label: `Transcript${cached ? " (reused)" : ""}`, credits: cached ? 0 : p.credits.estimate("media.transcribe", { durationSec: asset.durationSec ?? 60 }).credits });
  }
  return { credits: breakdown.reduce((a, b) => a + b.credits, 0), breakdown };
}

export async function requestClipAnalysis(
  p: Platform,
  wid: string,
  input: { asset: MediaAsset; prompts?: string[]; transcribe?: boolean; consent?: { scope: string }; actor: string; idempotencyKey?: string },
): Promise<{ analysis: ClipAnalysis; job: Job | null; reused: boolean }> {
  let asset = input.asset;
  if (asset.status === "deleted") throw new AppError("NOT_FOUND", "Asset not found");
  if (asset.status !== "ready") throw new AppError("CONFLICT", `Asset is ${asset.status}`, { userMessage: "This clip is still processing. Try again in a moment." });
  if (asset.kind !== "video") throw new AppError("BAD_REQUEST", "Clip analysis needs a video", { userMessage: "Choose a video clip to analyse." });
  if ((asset.durationSec ?? 0) * (asset.fps ?? 30) > SAM_MAX_FRAMES) throw new AppError("BAD_REQUEST", "Video too long for SAM", { userMessage: "That clip is too long to track (max ~10 minutes). Trim it first." });
  const prompts = normalisePrompts(input.prompts ?? DEFAULT_CLIP_PROMPTS);
  const transcribe = input.transcribe ?? true;
  if (PERSON_PROMPT.test(prompts.join(" ")) || asset.role === "founder_clip" || (transcribe && asset.hasAudio !== false)) {
    asset = await ensureConsent(p, wid, asset, input.consent, input.actor, "analysing a recording of a person");
  }
  const repo = p.db.ws(wid).collection("clipAnalyses");
  const existing = (await repo.list({ where: [["sourceAssetId", "==", asset.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 30 })).items.find(
    (a) => sameSet(a.prompts, prompts) && a.transcribe === transcribe && (a.status === "succeeded" || a.status === "queued" || a.status === "running"),
  );
  if (existing?.status === "succeeded") return { analysis: existing, job: null, reused: true };
  if (existing && existing.jobId) {
    const job = await p.jobs.get(wid, existing.jobId);
    if (job) return { analysis: existing, job, reused: false };
  }
  const estimate = await estimateClipAnalysis(p, wid, asset, prompts, transcribe);
  const analysis = await repo.create({ appId: asset.appId, sourceAssetId: asset.id, status: "queued", prompts, transcribe, segmentationIds: {}, durationSec: asset.durationSec, objects: [] }, { actor: input.actor });
  const job = await p.jobs.create(wid, "media.analyze_clip", { clipAnalysisId: analysis.id }, {
    actor: input.actor,
    appId: asset.appId,
    idempotencyKey: input.idempotencyKey ?? `cla:${analysis.id}`,
    credits: estimate.credits > 0 ? { operation: "media.analyze_clip", amount: estimate.credits } : undefined,
  });
  const withJob = await repo.update(analysis.id, { jobId: job.id }, { actor: input.actor });
  return { analysis: withJob, job, reused: false };
}

/** Wait for a segmentation another job is producing (bounded; honours cancellation). */
async function waitForSegmentation(ctx: JobContext, id: string, timeoutMs = 10 * 60_000): Promise<Segmentation> {
  const repo = ctx.ws.collection("segmentations");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await repo.getOrThrow(id);
    if (s.status === "succeeded" || s.status === "failed") return s;
    ctx.throwIfCancelled();
    if (Date.now() > deadline) throw new AppError("TIMEOUT", "Timed out waiting for an in-flight segmentation", { retryable: true });
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const hasOutputs = (s: Segmentation) =>
  s.status === "succeeded" && Boolean(s.tracksAssetId) && s.objects.slice(0, MAX_OBJECT_OUTPUTS).every((o) => s.objectOutputs?.[o.objectId]?.cutoutAssetId);

export async function analyzeClipHandler(ctx: JobContext<"media.analyze_clip">) {
  const repo = ctx.ws.collection("clipAnalyses");
  const a = await repo.getOrThrow(ctx.payload.clipAnalysisId);
  if (a.status === "succeeded" || a.status === "partial") return { refs: [{ entity: "clipAnalyses", id: a.id }], data: { alreadyDone: true, status: a.status }, creditsUsed: 0 };
  const asset = await ctx.ws.collection("mediaAssets").getOrThrow(a.sourceAssetId);
  if (asset.status !== "ready") throw new AppError("CONFLICT", `Source asset is ${asset.status}`, { retryable: false });
  await repo.update(a.id, { status: "running", error: undefined, jobId: ctx.job.id }, { actor: ctx.actor });
  try {
    return await withWorkdir((dir) => runAnalysis(ctx, a, asset, dir));
  } catch (err) {
    const e = err instanceof AppError ? err : new AppError("INTERNAL", (err as Error).message, { retryable: false, cause: err });
    if (!e.retryable || e.code === "CANCELLED") await repo.update(a.id, { status: "failed", error: (e.opts.userMessage ?? e.message).slice(0, 1000) }, { actor: ctx.actor }).catch(() => {});
    throw e;
  }
}

async function runAnalysis(ctx: JobContext<"media.analyze_clip">, a: ClipAnalysis, asset: MediaAsset, dir: string) {
  const p = ctx.platform;
  const repo = ctx.ws.collection("clipAnalyses");
  const src = join(dir, `source.${EXT_BY_MIME[asset.mimeType] ?? "bin"}`);
  await ctx.progress(2, "preparing clip");
  await p.storage.downloadToFile(asset.storagePath, src);
  const info = await probeMedia(src, { signal: ctx.signal });
  if (!info.frameCount) info.frameCount = await countVideoFrames(src, { signal: ctx.signal });
  const fps = info.fps ?? asset.fps ?? 30;
  const wantTranscript = a.transcribe && info.hasAudio;
  const span = wantTranscript ? 80 : 95;
  const per = span / a.prompts.length;
  const errors: string[] = [];
  let firstError: AppError | undefined;
  const segmentationIds: Record<string, string> = {};
  const done: { prompt: string; seg: Segmentation }[] = [];
  let charged = 0;

  for (const [i, prompt] of a.prompts.entries()) {
    ctx.throwIfCancelled();
    const base = 2 + i * per;
    await ctx.progress(base, "tracking", `“${prompt}” (${i + 1}/${a.prompts.length})`);
    try {
      let { seg } = await findOrCreateSegmentation(p, ctx.workspaceId, asset, prompt, ctx.actor);
      // Another job is producing it (e.g. a MaskSelector request): wait rather than pay twice.
      // A queued/running one untouched for 15 min is treated as orphaned and run here.
      if ((seg.status === "queued" || seg.status === "running") && Date.now() - Date.parse(seg.updatedAt) < 15 * 60_000 && seg.createdBy !== ctx.actor) {
        seg = await waitForSegmentation(ctx, seg.id);
        if (seg.status === "failed") seg = (await findOrCreateSegmentation(p, ctx.workspaceId, asset, prompt, ctx.actor)).seg;
      }
      segmentationIds[prompt] = seg.id;
      if (!hasOutputs(seg)) {
        const before = new Set(await usageEventIdsForJob(ctx));
        const r = await runSegmentationSafely(ctx, seg, asset, dir, {
          progress: (pct, stage, msg) => ctx.progress(base + (per * pct) / 100, stage, `“${prompt}”${msg ? ` · ${msg}` : ""}`),
          usageBefore: before,
          local: { file: src, info },
        });
        seg = r.seg;
        if (r.usedSam) charged += p.credits.estimate("media.segment", { mediaType: "video", durationSec: asset.durationSec ?? 0 }).credits;
      }
      done.push({ prompt, seg });
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError("INTERNAL", (err as Error).message);
      if (e.code === "CANCELLED") throw e;
      ctx.log.warn({ prompt, code: e.code }, "clip analysis prompt failed");
      firstError ??= e;
      errors.push(`“${prompt}”: ${e.opts.userMessage ?? e.message}`.slice(0, 300));
    }
  }

  // Objects from the stored tracks (exactly what SAM returned; nothing interpolated).
  const objects: ClipAnalysis["objects"] = [];
  for (const { prompt, seg } of done) {
    const tracks = await loadTracks(p, ctx.ws, seg.id);
    if (!tracks) continue;
    for (const track of tracks.tracks) {
      objects.push({
        key: `${prompt.slice(0, 40)}:${track.objectId}`.slice(0, 60),
        label: track.label,
        segmentationId: seg.id,
        objectId: track.objectId,
        trackingQuality: trackQuality(track),
        presence: presenceRanges(track, tracks.fps || fps),
        meanBbox: meanBbox(track),
      });
    }
  }

  // Transcript (captions purpose; reused when the same audio was transcribed before).
  let transcriptId: string | undefined;
  if (wantTranscript) {
    await ctx.progress(82, "transcribing");
    try {
      let { seg: t } = await findOrCreateTranscript(p, ctx.workspaceId, asset, "captions", ctx.actor);
      if (t.status !== "succeeded") {
        const before = new Set(await usageEventIdsForJob(ctx));
        const r = await runTranscriptionSafely(ctx, t, asset, dir, { progress: (pct, stage, msg) => ctx.progress(82 + (16 * pct) / 100, stage, msg), usageBefore: before, localFile: src });
        t = r.transcript as Transcript;
        charged += p.credits.estimate("media.transcribe", { durationSec: asset.durationSec ?? 60 }).credits;
      }
      transcriptId = t.id;
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError("INTERNAL", (err as Error).message);
      if (e.code === "CANCELLED") throw e;
      errors.push(`Transcript: ${e.opts.userMessage ?? e.message}`.slice(0, 300));
    }
  } else if (a.transcribe && !info.hasAudio) {
    await ctx.log_event("Clip has no audio track; transcript skipped");
  }

  const status: ClipAnalysis["status"] = !done.length ? "failed" : errors.length ? "partial" : "succeeded";
  // Nothing worked: fail visibly with the provider's own error (retryable ones are redelivered).
  if (status === "failed" && firstError?.retryable) throw firstError;
  const updated = await repo.update(
    a.id,
    { status, segmentationIds, objects: objects.slice(0, 100), transcriptId, durationSec: info.durationSec ?? asset.durationSec, error: errors.length ? errors.join(" · ").slice(0, 1000) : undefined },
    { actor: ctx.actor },
  );
  if (status === "failed") throw new AppError(firstError?.code ?? "PROVIDER_ERROR", `Clip analysis failed: ${errors.join(" · ")}`.slice(0, 1000), { retryable: false, userMessage: firstError?.opts.userMessage ?? errors[0] ?? "Clip analysis failed." });
  await ctx.progress(100, "done");
  const reserved = ctx.job.reservation?.credits ?? 0;
  return {
    refs: [{ entity: "clipAnalyses", id: a.id }, ...Object.values(segmentationIds).map((id) => ({ entity: "segmentations", id })), ...(transcriptId ? [{ entity: "transcripts", id: transcriptId }] : [])],
    data: { status, objects: updated.objects.length, errors, partial: status === "partial" },
    // Charge only for work actually done (cached prompts/transcripts are free).
    creditsUsed: Math.min(reserved, charged),
  };
}
