/**
 * Spark fixes the video before you see it (job `video.autofix`). After the storyboard pipeline builds
 * a new video and its first preview render finishes, Muse Spark watches the preview (`video.review`);
 * the scenes it flags get the same scene-scoped fix the Studio's "Fix these scenes" proposes
 * (`composition.edit`), applied automatically; the fixed version is re-rendered and watched again.
 *
 *   render.preview ✓ → video.autofix(preview) → video.review
 *   video.review ✓   → video.autofix(review)  → composition.edit (autoApply) … or stop
 *   composition.edit ✓ (this loop's patch) → video.autofix(edit) → render.preview → …
 *
 * Bounded and honest:
 * - at most AUTOFIX_MAX_ROUNDS fix rounds per video; it stops early when the review is clean, when the
 *   fix didn't raise Spark's score, or when a person edited the video meanwhile (only the build's
 *   version 1 and versions this loop made are ever touched);
 * - a round starts only when the workspace can pay for all of it (edit + preview render + review);
 * - videos a Growth Autopilot runs are left alone (its own watch stage reviews and fixes them);
 * - Settings → Video checks turns it off (`settings.videoReview.autoFix`, on by default);
 * - every decision is a step of one agent run per video and an event on the job; a review that
 *   failed or couldn't run ends the loop and is never treated as a pass.
 * Steps chain from job-status hooks with deterministic idempotency keys, so a redelivered job or a
 * repeated hook never starts a step twice.
 */
import { DEFAULT_VIDEO_REVIEW_SETTINGS, WorkspaceVideoReviewSettings, type Composition, type Job, type JobType, type VideoReview, type Workspace } from "@muselaunch/contracts";
import { totalDuration } from "@muselaunch/compositions";
import { getVersion } from "@muselaunch/compositions/store";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, toAppError, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { chooseTextModel } from "@muselaunch/providers";
import { RunRecorder } from "../runs";
import { clip, hashId } from "../util";
import { markFixRequested, renderForVersion, requestVideoReview, videoFixPlan, videoReviewLine, videoReviewsFor } from "./video-review";

/** Automatic fix rounds per video (each: edit → preview render → review). */
export const AUTOFIX_MAX_ROUNDS = 2;

/** This loop's patch for fix round `round` (1-based) of a composition. */
export const autofixPatchId = (compositionId: string, round: number) => hashId("cpt", compositionId, "autofix", round);
/** One agent run per video holds every step of its automatic check. */
export const autofixRunId = (compositionId: string) => hashId("run", compositionId, "autofix");

/** Workspace setting (absent = on). */
export function videoReviewSettings(ws: Pick<Workspace, "settings"> | null | undefined): WorkspaceVideoReviewSettings {
  const parsed = WorkspaceVideoReviewSettings.safeParse((ws?.settings as { videoReview?: unknown } | undefined)?.videoReview ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_VIDEO_REVIEW_SETTINGS };
}

/** Credits one round needs: the scene edit, the preview render of the fixed version and Spark's review of it. */
export function autofixRoundCredits(p: Platform, durationSec: number): { edit: number; preview: number; review: number; total: number } {
  const edit = p.credits.estimate("composition.edit").credits;
  const preview = p.credits.estimate("render.preview", { durationSec }).credits;
  const review = p.credits.estimate("video.review").credits;
  return { edit, preview, review, total: edit + preview + review };
}

/** Which fix round made `patchId` (1..AUTOFIX_MAX_ROUNDS), or null when it isn't this loop's patch. */
export function autofixRoundOfPatch(compositionId: string, patchId: string | undefined): number | null {
  if (!patchId) return null;
  for (let r = 1; r <= AUTOFIX_MAX_ROUNDS; r++) if (patchId === autofixPatchId(compositionId, r)) return r;
  return null;
}

/**
 * The loop round that produced `version`: 0 for the storyboard build's version 1 of an original video
 * (not an aspect/audience/hook copy), r for a version this loop's round-r patch made, null otherwise
 * (a person's edit, a revert, an AI edit someone asked for).
 */
export async function autofixRoundOf(ws: WorkspaceDb, comp: Pick<Composition, "id" | "storyboardId" | "derivedFromCompositionId">, version: number): Promise<number | null> {
  if (version === 1) return comp.storyboardId && !comp.derivedFromCompositionId ? 0 : null;
  const ver = await getVersion(ws, comp.id, version).catch(() => null);
  if (!ver || ver.source !== "ai_edit") return null;
  return autofixRoundOfPatch(comp.id, ver.patchId);
}

/** A Growth Autopilot that runs this video (its watch stage reviews and fixes it), if any. */
export async function autopilotOwning(ws: WorkspaceDb, comp: Pick<Composition, "id" | "appId" | "campaignId">): Promise<string | null> {
  const aps = (await ws.collection("autopilots").list({ where: [["appId", "==", comp.appId]], limit: 100 })).items;
  const owner = aps.find((ap) => ap.compositionIds.includes(comp.id) || (comp.campaignId !== undefined && ap.campaignId === comp.campaignId));
  return owner?.id ?? null;
}

// ---------------------------------------------------------------------------
// Job handler
// ---------------------------------------------------------------------------

type Ctx = JobContext<"video.autofix">;

interface Loop {
  ctx: Ctx;
  comp: Composition;
  rec: RunRecorder;
}

async function note(l: Loop, title: string, output?: unknown): Promise<void> {
  await l.rec.step({ kind: "decision", title: clip(title, 300), output: output ?? {} });
  await l.ctx.log_event(clip(title, 500), { entity: "compositions", id: l.comp.id });
}

/** End the loop with a visible reason. */
async function stop(l: Loop, why: string, data: Record<string, unknown>, output?: unknown): Promise<JobResult> {
  await note(l, why, output);
  await l.rec.finish("succeeded", { outputRefs: [{ entity: "compositions", id: l.comp.id }] });
  return { refs: [{ entity: "compositions", id: l.comp.id }, { entity: "agentRuns", id: l.rec.id }], data: { stopped: true, ...data }, creditsUsed: 0 };
}

const reviewer = (p: Platform, r?: Pick<VideoReview, "reviewer">) => r?.reviewer.label ?? chooseTextModel(p, "video.review").name;

export async function videoAutofixHandler(ctx: Ctx): Promise<JobResult> {
  const p = ctx.platform;
  const ws = ctx.ws;
  const { appId, compositionId, trigger } = ctx.payload;
  const comp = await ws.collection("compositions").getOrThrow(compositionId);
  if (comp.appId !== appId) throw new AppError("BAD_REQUEST", "Composition belongs to another app", { retryable: false });
  const workspace = await p.db.top("workspaces").get(ctx.workspaceId);
  const quiet = (reason: string) => ({ refs: [], data: { skipped: reason }, creditsUsed: 0 });
  // Cheap, silent exits first (nothing for a person to know: the check never started for this version).
  if (comp.kind !== "video") return quiet("not a video");
  if (trigger === "preview" && (!ctx.payload.version || (await autofixRoundOf(ws, comp, ctx.payload.version)) === null)) return quiet("not a version this check makes");
  if (trigger === "review") {
    const r = ctx.payload.reviewId ? await ws.collection("videoReviews").get(ctx.payload.reviewId) : null;
    if (!r || r.compositionId !== comp.id || (await autofixRoundOf(ws, comp, r.version)) === null) return quiet("not a review this check asked for");
  }
  const owner = await autopilotOwning(ws, comp);
  if (owner) return quiet(`Growth Autopilot ${owner} reviews this video`);
  if (!videoReviewSettings(workspace).autoFix) {
    // Switched off while a check was going on: say where it stopped.
    const run = await ws.collection("agentRuns").get(autofixRunId(comp.id));
    if (run?.status === "running") {
      const rec = await RunRecorder.start(ctx, { id: run.id, kind: "video_review", model: run.model, goal: run.goal, appId });
      return stop({ ctx, comp, rec }, "Automatic video checks were turned off in Settings: the check stops here.", { reason: "off" });
    }
    return quiet("off in settings");
  }

  const planned = chooseTextModel(p, "video.review");
  const rec = await RunRecorder.start(ctx, {
    id: autofixRunId(comp.id),
    kind: "video_review",
    model: planned.model,
    goal: clip(`Check "${comp.title}" before you see it: ${planned.name} watches the preview and fixes the scenes it flags (at most ${AUTOFIX_MAX_ROUNDS} rounds)`, 4000),
    appId,
  });
  const l: Loop = { ctx, comp, rec };
  try {
    if (trigger === "preview") return await onPreview(l);
    if (trigger === "review") return await onReview(l);
    return await onEdit(l);
  } catch (raw) {
    const err = toAppError(raw);
    const final = err.code === "CANCELLED" || !err.retryable || ctx.job.attempts >= ctx.job.maxAttempts;
    if (final) {
      await rec.step({ kind: "decision", title: clip(`Automatic check stopped: ${err.opts.userMessage ?? err.message}`, 300), status: "failed", output: { code: err.code } }).catch(() => {});
      await rec.finish(err.code === "CANCELLED" ? "cancelled" : "failed", { error: err.toInfo() }).catch(() => {});
    }
    throw err;
  }
}

/** Credits for a round, or a visible stop when the workspace can't pay for all of it. */
async function affordRound(l: Loop, durationSec: number, what: string): Promise<JobResult | null> {
  const p = l.ctx.platform;
  const need = autofixRoundCredits(p, durationSec);
  const { available } = await p.credits.balance(l.ctx.workspaceId);
  if (available >= need.total) return null;
  return stop(l, `Not enough credits for ${what} (${need.total} needed: edit ${need.edit} + preview ${need.preview} + review ${need.review}; ${available} available). The video is left as it is.`, { reason: "credits", needed: need.total, available }, need);
}

/** A preview finished: Spark watches it (round 0 = the build's version; r = the version round r made). */
async function onPreview(l: Loop): Promise<JobResult> {
  const { ctx, comp } = l;
  const p = ctx.platform;
  const version = ctx.payload.version!;
  const round = (await autofixRoundOf(ctx.ws, comp, version))!;
  const fresh = await ctx.ws.collection("compositions").getOrThrow(comp.id);
  if (fresh.currentVersion !== version) return stop(l, `“${comp.title}” changed after this preview (now v${fresh.currentVersion}), so Spark leaves it to you.`, { reason: "edited", version, currentVersion: fresh.currentVersion });
  let render: Awaited<ReturnType<typeof renderForVersion>>;
  try {
    render = await renderForVersion(ctx.ws, fresh, version, ctx.payload.renderAssetId);
  } catch (raw) {
    const err = toAppError(raw);
    return stop(l, `Spark couldn't find the preview of v${version} to watch (${err.opts.userMessage ?? err.message}).`, { reason: "no_render" });
  }
  // The review is part of the round that made this version (round 0: before any fix), so it needs a whole round's credits.
  const short = await affordRound(l, Math.round(totalDuration(render.doc)), round === 0 ? "Spark's automatic check" : `checking fix round ${round}`);
  if (short) return short;
  const { review, job, reused } = await requestVideoReview(p, ctx.workspaceId, {
    compositionId: comp.id,
    version,
    renderAssetId: render.asset.id,
    actor: ctx.actor,
    requestedFrom: "autofix",
    idempotencyKey: `video.autofix:review:${comp.id}:v${version}`,
    parentJobId: ctx.job.id,
  });
  // Someone already asked Spark to watch this exact render (Studio): use that review, never pay twice.
  if (reused && review.requestedFrom !== "autofix") {
    if (review.status === "succeeded") return onReview(l, review);
    return stop(l, `A review of this preview is already running (asked from the ${review.requestedFrom}); its findings will be in the Studio, so the automatic check stops here.`, { reason: "review_in_progress", reviewId: review.id });
  }
  await note(l, round === 0 ? `${reviewer(p)} is watching the preview of “${comp.title}” before you see it` : `${reviewer(p)} is watching the fixed preview (v${version}, after round ${round})`, { reviewId: review.id, jobId: job?.id, version, round });
  return { refs: [{ entity: "videoReviews", id: review.id }, { entity: "agentRuns", id: l.rec.id }], data: { round, version, reviewId: review.id, reviewJobId: job?.id }, creditsUsed: 0 };
}

/** Spark watched a preview: fix what it flagged, or stop (clean, no better, edited, cap, credits). */
async function onReview(l: Loop, given?: VideoReview): Promise<JobResult> {
  const { ctx, comp } = l;
  const p = ctx.platform;
  const review = given ?? (await ctx.ws.collection("videoReviews").getOrThrow(ctx.payload.reviewId!));
  const reviewId = review.id;
  const who = reviewer(p, review);
  if (review.status !== "succeeded") return stop(l, `${who} couldn't watch v${review.version} (${review.error ?? review.status}). Not counted as a pass: the video is left as it is.`, { reason: "review_failed", reviewId });
  const round = (await autofixRoundOf(ctx.ws, comp, review.version))!;
  const line = videoReviewLine(review);
  const fresh = await ctx.ws.collection("compositions").getOrThrow(comp.id);
  if (fresh.currentVersion !== review.version) return stop(l, `${who} watched v${review.version} (${line}), but “${comp.title}” was edited since (now v${fresh.currentVersion}), so nothing is fixed automatically.`, { reason: "edited", reviewId, currentVersion: fresh.currentVersion });

  // Did the last fix help? (Compared with Spark's review of the version it fixed.)
  if (round > 0) {
    const patch = await ctx.ws.collection("compositionPatches").get(autofixPatchId(comp.id, round));
    const before = patch ? (await videoReviewsFor(ctx.ws, comp.id)).find((r) => r.version === patch.baseVersion && r.status === "succeeded" && r.requestedFrom === "autofix") : undefined;
    if (before?.score !== undefined && review.score !== undefined && review.score <= before.score) {
      return stop(l, `Round ${round} didn't raise ${who}'s score (${before.score} → ${review.score}/10), so the check stops here. Version ${patch!.baseVersion} is in the history if you prefer it.`, { reason: "no_improvement", reviewId, before: before.score, after: review.score, round });
    }
  }

  const { doc } = await getVersion(ctx.ws, comp.id, review.version);
  const plan = videoFixPlan(review, doc);
  const open = review.findings.filter((f) => (f.severity === "blocker" || f.severity === "warn") && !f.resolution);
  if (!plan) {
    if (!open.length) return stop(l, `${who} watched v${review.version}: ${line}. Review clean: no fixes needed.`, { reason: "clean", reviewId, score: review.score, round });
    return stop(l, `${who} watched v${review.version}: ${line}. What's left is about the whole video, not one scene, so it's listed in the Studio for you.`, { reason: "whole_video", reviewId, round });
  }
  if (round >= AUTOFIX_MAX_ROUNDS) {
    return stop(l, `${who} watched v${review.version}: ${line}. That was the last automatic round (${AUTOFIX_MAX_ROUNDS}); the remaining ${plan.findings.length} finding(s) are in the Studio for you.`, { reason: "cap", reviewId, round });
  }
  const short = await affordRound(l, Math.round(totalDuration(doc)), `fix round ${round + 1}`);
  if (short) return short;

  const next = round + 1;
  const patchId = autofixPatchId(comp.id, next);
  await ctx.ws.collection("compositionPatches").createIfAbsent(
    { id: patchId, compositionId: comp.id, baseVersion: review.version, ops: [], summary: "Generating fix…", source: "ai", instruction: plan.instruction, affectedSceneIds: plan.sceneIds, status: "proposed", validationErrors: [], memoryRefs: [] },
    { actor: ctx.actor },
  );
  let job: Job;
  try {
    job = await ctx.enqueue(
      "composition.edit",
      { appId: comp.appId, compositionId: comp.id, baseVersion: review.version, instruction: plan.instruction, sceneIds: plan.sceneIds, patchId, autoApply: true },
      { appId: comp.appId, idempotencyKey: `video.autofix:edit:${patchId}`, credits: { operation: "composition.edit" } },
    );
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code !== "INSUFFICIENT_CREDITS" && err.code !== "QUOTA_EXCEEDED") throw err;
    await ctx.ws.collection("compositionPatches").update(patchId, { status: "rejected", summary: "Not started", validationErrors: [clip(err.opts.userMessage ?? err.message, 500)] }, { actor: ctx.actor }).catch(() => {});
    return stop(l, `Couldn't start fix round ${next}: ${err.opts.userMessage ?? err.message}`, { reason: err.code === "QUOTA_EXCEEDED" ? "quota" : "credits", reviewId });
  }
  await markFixRequested(ctx.ws, review, plan.findings.map((f) => f.id), patchId, ctx.actor);
  const scenes = plan.sceneIds.length;
  await note(l, `${who} watched the preview (${line}) and is fixing ${scenes} scene${scenes === 1 ? "" : "s"} (round ${next} of ${AUTOFIX_MAX_ROUNDS})`, { reviewId, patchId, jobId: job.id, findings: plan.findings.map((f) => `${f.severity} ${f.check}${f.sceneId ? ` ${f.sceneId}` : ""}: ${clip(f.issue, 160)}`) });
  return { refs: [{ entity: "compositionPatches", id: patchId }, { entity: "agentRuns", id: l.rec.id }], data: { round: next, patchId, editJobId: job.id, scenes }, creditsUsed: 0 };
}

/** The fix applied: render the fixed version's preview (its completion brings the check back). */
async function onEdit(l: Loop): Promise<JobResult> {
  const { ctx, comp } = l;
  const patchId = ctx.payload.patchId;
  const round = autofixRoundOfPatch(comp.id, patchId);
  if (!patchId || round === null) throw new AppError("BAD_REQUEST", "video.autofix(edit) needs one of this check's patches", { retryable: false });
  const patch = await ctx.ws.collection("compositionPatches").getOrThrow(patchId);
  if (patch.compositionId !== comp.id) throw new AppError("BAD_REQUEST", "This patch belongs to another video", { retryable: false });
  if (patch.status !== "applied" || !patch.resultVersion) {
    const why = patch.validationErrors[0] ?? (patch.status === "invalid" ? "the edit didn't pass validation" : `the patch is ${patch.status}`);
    return stop(l, `Fix round ${round} wasn't applied (${clip(why, 200)}). The video is left as it was; Spark's findings are in the Studio.`, { reason: "not_applied", patchId, status: patch.status });
  }
  const fresh = await ctx.ws.collection("compositions").getOrThrow(comp.id);
  if (fresh.currentVersion !== patch.resultVersion) return stop(l, `Spark's fix applied as v${patch.resultVersion}, but the video was edited since (now v${fresh.currentVersion}): no more automatic fixes.`, { reason: "edited", patchId });
  const job = await ctx.enqueue("render.preview", { appId: comp.appId, compositionId: comp.id, version: patch.resultVersion }, { appId: comp.appId, idempotencyKey: `render.preview:${comp.id}:v${patch.resultVersion}` });
  await note(l, `Fix round ${round} applied as v${patch.resultVersion}: ${clip(patch.summary, 200)}. Rendering the preview so Spark can watch it again.`, { patchId, version: patch.resultVersion, previewJobId: job.id });
  return { refs: [{ entity: "compositionPatches", id: patchId }, { entity: "agentRuns", id: l.rec.id }], data: { round, version: patch.resultVersion, previewJobId: job.id }, creditsUsed: 0 };
}

// ---------------------------------------------------------------------------
// Chaining (job-status hook)
// ---------------------------------------------------------------------------

/** Job types whose completion moves the check along. */
export const AUTOFIX_TRIGGER_JOBS: ReadonlySet<JobType> = new Set(["render.preview", "video.review", "composition.edit"]);

/**
 * The next `video.autofix` step for a job that just succeeded, or null. Cheap filters only (the step
 * itself re-checks everything): the setting, an original video built from a storyboard, a version this
 * check makes, a review it asked for, a patch it made.
 */
export async function autofixStepFor(p: Platform, workspaceId: string, job: Pick<Job, "id" | "type" | "appId" | "payload" | "output">): Promise<{ payload: { appId: string; compositionId: string; trigger: "preview" | "review" | "edit"; version?: number; renderAssetId?: string; reviewId?: string; patchId?: string }; key: string } | null> {
  if (!AUTOFIX_TRIGGER_JOBS.has(job.type) || !job.appId) return null;
  const pl = job.payload as { compositionId?: unknown; version?: unknown; reviewId?: unknown; patchId?: unknown };
  const compositionId = typeof pl.compositionId === "string" ? pl.compositionId : undefined;
  if (!compositionId) return null;
  const ws = p.db.ws(workspaceId);
  if (job.type === "composition.edit") {
    const patchId = typeof pl.patchId === "string" ? pl.patchId : undefined;
    if (autofixRoundOfPatch(compositionId, patchId) === null) return null;
    return { payload: { appId: job.appId, compositionId, trigger: "edit", patchId }, key: `video.autofix:edit-done:${patchId}` };
  }
  if (job.type === "video.review") {
    const reviewId = typeof pl.reviewId === "string" ? pl.reviewId : undefined;
    const review = reviewId ? await ws.collection("videoReviews").get(reviewId) : null;
    if (!review || review.requestedFrom !== "autofix" || review.compositionId !== compositionId) return null;
    return { payload: { appId: job.appId, compositionId, trigger: "review", reviewId: review.id }, key: `video.autofix:reviewed:${review.id}` };
  }
  // render.preview
  const version = typeof pl.version === "number" ? pl.version : undefined;
  if (!version) return null;
  const workspace = await p.db.top("workspaces").get(workspaceId);
  if (!videoReviewSettings(workspace).autoFix) return null;
  const comp = await ws.collection("compositions").get(compositionId);
  if (!comp || comp.appId !== job.appId || comp.kind !== "video") return null;
  if ((await autofixRoundOf(ws, comp, version)) === null) return null;
  const assetId = (job.output?.data as { assetId?: unknown } | undefined)?.assetId;
  return { payload: { appId: job.appId, compositionId, trigger: "preview", version, ...(typeof assetId === "string" ? { renderAssetId: assetId } : {}) }, key: `video.autofix:preview:${compositionId}:v${version}` };
}

const installed = new WeakSet<Platform>();

/**
 * Move the check along as its jobs finish (install in every process that runs jobs, BEFORE hooks that
 * act on a finished preview, e.g. the Create runner: they then see the check is still running).
 */
export function installVideoAutofixHooks(p: Platform): () => void {
  if (installed.has(p)) return () => {};
  installed.add(p);
  const off = p.jobs.addHooks({
    onStatus: async ({ workspaceId, job, to }) => {
      if (to !== "succeeded" || !AUTOFIX_TRIGGER_JOBS.has(job.type)) return;
      const next = await autofixStepFor(p, workspaceId, job).catch((err) => {
        p.log.warn({ err, jobId: job.id }, "automatic video check: next step lookup failed");
        return null;
      });
      if (!next) return;
      await p.jobs.create(workspaceId, "video.autofix", next.payload, { actor: job.createdBy, appId: job.appId, idempotencyKey: next.key, parentJobId: job.id });
    },
  });
  return () => {
    installed.delete(p);
    off();
  };
}
