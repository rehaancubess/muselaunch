/**
 * After the final renders, Muse Spark watches each video (`video.review`). Blockers get ONE
 * scene-scoped fix round through the existing AI edit path (`composition.edit`, auto-applied inside the
 * run) and one final re-render; otherwise the loop goes on to the post drafts. A review that fails or
 * can't run (Spark unavailable) is logged as such and never counted as a pass.
 *
 * Sub-phases of the `render` stage (waitingOn tags): render:watch → render:fix → render:rerender.
 */
import { ensureVideoReview, markFixRequested, videoFixPlan, videoReviewLine, videoReviewsFor } from "@muselaunch/agents";
import { totalDuration } from "@muselaunch/compositions";
import { getVersion } from "@muselaunch/compositions/store";
import type { Composition, EntityRef, Job, VideoReview } from "@muselaunch/contracts";
import { chooseTextModel, type TextRoute } from "@muselaunch/providers";
import { hashId, isTerminalJob, type LoopEnv, type LogEntry, type Outcome } from "./state";

/** Automatic fix rounds after Spark's review, per video and iteration. Never more than one. */
export const VIDEO_FIX_ROUNDS = 1;

export const WATCH_TAGS = ["render:watch", "render:fix", "render:rerender", "render:rerender:approve"] as const;
export const isWatchTag = (tag?: string) => (WATCH_TAGS as readonly string[]).includes(tag ?? "");

interface WatchStep {
  phase: "enter" | "resume" | "approved";
  tag?: string;
  approved: boolean;
}

/** Same render gate the render stage uses (Brand Guardian + missing media), injected to avoid an import cycle. */
export type RenderableFn = (env: LoopEnv, comps: Composition[]) => Promise<{ plan: { id: string; title: string; version: number; durationSec: number; credits: number }[]; excluded: { compositionId: string; why: string }[] }>;

const ref = (entity: string, id: string): EntityRef => ({ entity, id });
const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ""));
const jobError = (j: Job) => j.error?.userMessage ?? j.error?.message ?? j.status;

function engine(env: LoopEnv, route: TextRoute | "video.review"): string {
  const c = chooseTextModel(env.p, route);
  return c.engine === "muse-spark-open" ? "Muse Spark Open (open weights via Baseten)" : c.name;
}

/** Log once: re-entering a sub-phase (after a budget approval or a retry) doesn't repeat entries. */
function noteOnce(env: LoopEnv, kind: LogEntry["kind"], summary: string, refs: EntityRef[] = []): void {
  const key = (rs: EntityRef[]) => rs.map((r) => `${r.entity}/${r.id}`).join(",");
  if (env.fullLog.some((e) => e.kind === kind && e.summary === clip(summary, 1200) && key(e.refs) === key(refs.slice(0, 20)))) return;
  env.note(kind, summary, refs);
}

/** Jobs this loop delegated of one type (log order). */
async function delegatedJobs(env: LoopEnv, type: Job["type"]): Promise<Job[]> {
  const ids = [...new Set(env.fullLog.flatMap((e) => e.refs.filter((r) => r.entity === "jobs").map((r) => r.id)))];
  return (await env.ws.collection("jobs").getMany(ids)).filter((j) => j.type === type);
}

interface Rendered {
  comp: Composition;
  version: number;
  assetId: string;
  job: Job;
}

/** The newest successful MP4 final render of each of the loop's videos. */
async function finalRenders(env: LoopEnv): Promise<Rendered[]> {
  const jobs = (await delegatedJobs(env, "render.final")).filter((j) => j.status === "succeeded" && env.ap.compositionIds.includes((j.payload as { compositionId: string }).compositionId));
  const comps = new Map((await env.ws.collection("compositions").getMany(env.ap.compositionIds)).map((c) => [c.id, c]));
  const best = new Map<string, Rendered>();
  for (const j of jobs) {
    const pl = j.payload as { compositionId: string; version: number; format?: string };
    if ((pl.format ?? "mp4") !== "mp4") continue;
    const d = j.output?.data as { assetId?: string } | undefined;
    const assetId = d?.assetId ?? j.output?.refs.find((r) => r.entity === "mediaAssets")?.id;
    const comp = comps.get(pl.compositionId);
    if (!assetId || !comp) continue;
    const prev = best.get(comp.id);
    if (!prev || pl.version >= prev.version) best.set(comp.id, { comp, version: pl.version, assetId, job: j });
  }
  return [...best.values()];
}

/** Newest review of exactly this render (finished ones first). */
async function reviewOfRender(env: LoopEnv, r: Rendered): Promise<VideoReview | undefined> {
  const all = (await videoReviewsFor(env.ws, r.comp.id)).filter((x) => x.version === r.version && x.renderAssetId === r.assetId);
  return all.find((x) => x.status === "succeeded") ?? all[0];
}

const fixPatchId = (env: LoopEnv, compositionId: string) => hashId("pch", env.ap.id, env.iteration, compositionId, "video-fix");

// ---------------------------------------------------------------------------
// 1. Final renders done → Spark watches them
// ---------------------------------------------------------------------------

export async function watchRenders(env: LoopEnv, step: WatchStep): Promise<Outcome> {
  const renders = await finalRenders(env);
  if (!renders.length) return { kind: "advance", to: "schedule" };
  const gate = await env.budgetGate(env.estimate("video.review") * renders.length, `Spark video review${renders.length === 1 ? "" : "s"} (${renders.length})`, step.approved);
  if (gate) return gate;
  const who = engine(env, "video.review");
  const waitIds: string[] = [];
  for (const r of renders) {
    const { review } = await ensureVideoReview(env.ws, { appId: env.appId, compositionId: r.comp.id, version: r.version, renderAssetId: r.assetId, renderQuality: "final", requestedFrom: "autopilot" }, env.ctx.actor);
    if (review.status === "succeeded") {
      noteOnce(env, "observation", `Using ${who}'s existing review of the “${r.comp.title}” v${r.version} render.`, [ref("videoReviews", review.id), ref("compositions", r.comp.id)]);
      continue;
    }
    // Already being watched (e.g. someone pressed Review with Spark in the Studio): wait for that job.
    const inflight = review.jobId ? await env.ws.collection("jobs").get(review.jobId) : null;
    if (inflight && !isTerminalJob(inflight) && !inflight.idempotencyKey.startsWith(`autopilot:${env.ap.id}:`)) {
      waitIds.push(inflight.id);
      continue;
    }
    const job = await env.delegate(
      "video.review",
      { appId: env.appId, compositionId: r.comp.id, version: r.version, renderAssetId: r.assetId, reviewId: review.id },
      {
        key: `watch:${r.comp.id}:v${r.version}`,
        label: `Asked ${who} to watch the final render of “${r.comp.title}” v${r.version}: hook readability, legibility, device frames, blank frames, repetition, pacing, CTA, brand fit and honesty.`,
        credits: { operation: "video.review" },
      },
    );
    if (review.jobId !== job.id) await env.ws.collection("videoReviews").update(review.id, { jobId: job.id }, { actor: env.ctx.actor });
    waitIds.push(job.id);
  }
  return { kind: "wait", jobIds: waitIds, tag: "render:watch", reason: `${who} is watching ${renders.length} rendered video${renders.length === 1 ? "" : "s"}` };
}

// ---------------------------------------------------------------------------
// 2. Reviews done → blockers get one scene-scoped fix round
// ---------------------------------------------------------------------------

async function afterWatch(env: LoopEnv, step: WatchStep): Promise<Outcome> {
  const renders = await finalRenders(env);
  const who = engine(env, "video.review");
  const fixable: { r: Rendered; review: VideoReview; plan: NonNullable<ReturnType<typeof videoFixPlan>>; durationSec: number }[] = [];
  let reviewed = 0;
  let blocked = 0;
  for (const r of renders) {
    const review = await reviewOfRender(env, r);
    if (!review || review.status !== "succeeded") {
      const job = review?.jobId ? await env.ws.collection("jobs").get(review.jobId) : null;
      const why = review?.error ?? (job ? jobError(job) : review ? review.status : "no review");
      noteOnce(
        env,
        "verification",
        `${who} couldn't watch “${r.comp.title}” v${r.version} (${clip(why, 200)}). Not counted as a pass: it goes on unreviewed. Open it in the Studio and choose Review with Spark.`,
        [ref("compositions", r.comp.id), ...(review ? [ref("videoReviews", review.id)] : [])],
      );
      continue;
    }
    reviewed++;
    noteOnce(
      env,
      "verification",
      `${review.reviewer.label ?? who} watched “${r.comp.title}” v${r.version} (${review.frames.length} frames): ${videoReviewLine(review)}. ${clip(review.summary, 360)}`,
      [ref("videoReviews", review.id), ref("compositions", r.comp.id), ...(review.agentRunId ? [ref("agentRuns", review.agentRunId)] : [])],
    );
    const blockers = review.findings.filter((f) => f.severity === "blocker");
    if (!blockers.length) continue;
    blocked++;
    if (await env.ws.collection("compositionPatches").get(fixPatchId(env, r.comp.id))) {
      noteOnce(env, "observation", `“${r.comp.title}” already had its automatic fix round in this iteration (at most ${VIDEO_FIX_ROUNDS}); its remaining blocker(s) are left for you in the Studio.`, [ref("compositions", r.comp.id), ref("videoReviews", review.id)]);
      continue;
    }
    const comp = await env.ws.collection("compositions").getOrThrow(r.comp.id);
    if (comp.currentVersion !== review.version) {
      noteOnce(env, "observation", `“${comp.title}” changed after the render (now v${comp.currentVersion}), so Spark's findings on v${review.version} aren't fixed automatically.`, [ref("compositions", comp.id), ref("videoReviews", review.id)]);
      continue;
    }
    const { doc } = await getVersion(env.ws, comp.id, review.version);
    const plan = videoFixPlan(review, doc, { severities: ["blocker"] });
    if (!plan) {
      noteOnce(env, "observation", `Spark's blocker(s) in “${comp.title}” are about the whole video, not one scene, so there's no automatic scene fix. Fix it in the Studio.`, [ref("compositions", comp.id), ref("videoReviews", review.id)]);
      continue;
    }
    fixable.push({ r: { ...r, comp }, review, plan, durationSec: Math.round(totalDuration(doc)) });
  }

  if (!fixable.length) {
    const summary = !reviewed
      ? "Going on to the post drafts without Spark's review (it didn't run). Nothing is marked as reviewed."
      : blocked
        ? `Going on to the post drafts: Spark's remaining blocker(s) can't be fixed automatically and are listed in the Studio. Every post still waits for your approval.`
        : `No blockers in Spark's review${reviewed < renders.length ? " of the videos it could watch" : ""}: going on to the post drafts.`;
    noteOnce(env, "decision", summary);
    return { kind: "advance", to: "schedule" };
  }

  // Budget for the whole round: the scene edit plus the re-render (priced at the current length).
  const credits = fixable.reduce((n, x) => n + env.estimate("composition.edit") + env.estimate("render.final", { durationSec: x.durationSec }), 0);
  const gate = await env.budgetGate(credits, `one Spark fix round and re-render (${fixable.length} video${fixable.length === 1 ? "" : "s"})`, step.approved);
  if (gate) return gate;

  const editor = engine(env, "composition.edit.scoped");
  const waitIds: string[] = [];
  for (const { r, review, plan } of fixable) {
    const patchId = fixPatchId(env, r.comp.id);
    await env.ws.collection("compositionPatches").createIfAbsent(
      { id: patchId, compositionId: r.comp.id, baseVersion: review.version, ops: [], summary: "Generating fix…", source: "ai", instruction: plan.instruction, affectedSceneIds: plan.sceneIds, status: "proposed", validationErrors: [], memoryRefs: [] },
      { actor: env.ctx.actor },
    );
    const job = await env.delegate(
      "composition.edit",
      { appId: env.appId, compositionId: r.comp.id, baseVersion: review.version, instruction: plan.instruction, sceneIds: plan.sceneIds, patchId, autoApply: true },
      {
        key: `video-fix:${r.comp.id}`,
        label: `Video fix (iteration ${env.iteration}): asked ${editor} for a scene-scoped fix of the ${plan.findings.length} blocker(s) Spark saw in “${r.comp.title}” v${review.version} (${plan.findings.map((f) => f.check.replace(/_/g, " ")).join(", ")}).`,
        credits: { operation: "composition.edit" },
      },
    );
    await markFixRequested(env.ws, review, plan.findings.map((f) => f.id), patchId, env.ctx.actor);
    waitIds.push(job.id);
  }
  env.note(
    "decision",
    `Spark found blockers in ${fixable.length} video${fixable.length === 1 ? "" : "s"}: one scene-scoped fix round, then one final re-render (never more than ${VIDEO_FIX_ROUNDS} round).`,
    fixable.flatMap((x) => [ref("videoReviews", x.review.id), ref("compositionPatches", fixPatchId(env, x.r.comp.id))]),
  );
  return { kind: "wait", jobIds: waitIds, tag: "render:fix", reason: `Fixing ${fixable.length} video${fixable.length === 1 ? "" : "s"} from Spark's review` };
}

// ---------------------------------------------------------------------------
// 3. Fixes applied → one final re-render
// ---------------------------------------------------------------------------

async function afterFix(env: LoopEnv, step: WatchStep, renderable: RenderableFn): Promise<Outcome> {
  const comps = await env.ws.collection("compositions").getMany(env.ap.compositionIds);
  const fixed: Composition[] = [];
  for (const c of comps) {
    const patch = await env.ws.collection("compositionPatches").get(fixPatchId(env, c.id));
    if (!patch) continue;
    if (patch.status === "applied" && patch.resultVersion) {
      noteOnce(env, "observation", `Spark's fix for “${c.title}” applied as v${patch.resultVersion}: ${clip(patch.summary, 200)}`, [ref("compositionPatches", patch.id), ref("compositions", c.id)]);
      fixed.push(c);
    } else {
      noteOnce(
        env,
        "observation",
        `Spark's fix for “${c.title}” wasn't applied (${patch.status}${patch.validationErrors.length ? `: ${clip(patch.validationErrors[0], 160)}` : ""}). Its post uses the reviewed v${patch.baseVersion} render; fix it in the Studio.`,
        [ref("compositionPatches", patch.id), ref("compositions", c.id)],
      );
    }
  }
  if (!fixed.length) return { kind: "advance", to: "schedule" };
  const { plan, excluded } = await renderable(env, fixed);
  for (const x of excluded) noteOnce(env, "verification", `Not re-rendered after the fix: ${x.why}. Its post uses the earlier render.`, [ref("compositions", x.compositionId)]);
  if (!plan.length) return { kind: "advance", to: "schedule" };
  const total = plan.reduce((n, x) => n + x.credits, 0);
  const approved = step.phase === "approved" && step.tag === "render:rerender:approve";
  const gate = await env.budgetGate(total, `re-render of ${plan.length} fixed video${plan.length === 1 ? "" : "s"}`, step.approved && !approved);
  if (gate) return gate;
  if (!approved && total > env.ap.budget.autoApproveCredits) {
    return env.checkpoint("spend", `Re-render ${plan.length} video${plan.length === 1 ? "" : "s"} fixed from Spark's review for ≈${total} credits? (Auto-approve limit: ${env.ap.budget.autoApproveCredits} credits.) Reject to keep the earlier renders.`, total, "render:rerender:approve", `Re-render after Spark's fix needs your OK (≈${total} credits)`);
  }
  const waitIds: string[] = [];
  for (const x of plan) {
    const job = await env.delegate(
      "render.final",
      { appId: env.appId, compositionId: x.id, version: x.version, format: "mp4" },
      { key: `render:${x.id}:v${x.version}`, label: `Video fix (iteration ${env.iteration}): final re-render of “${x.title}” v${x.version} (${x.durationSec}s) after Spark's fix, Brand Guardian gate passed.`, credits: { operation: "render.final", params: { durationSec: x.durationSec } } },
    );
    waitIds.push(job.id);
  }
  return { kind: "wait", jobIds: waitIds, tag: "render:rerender", reason: `Re-rendering ${plan.length} fixed video${plan.length === 1 ? "" : "s"}` };
}

// ---------------------------------------------------------------------------
// 4. Re-render done → posts
// ---------------------------------------------------------------------------

async function afterRerender(env: LoopEnv): Promise<Outcome> {
  const jobs = await env.jobs();
  const comps = new Map((await env.ws.collection("compositions").getMany(env.ap.compositionIds)).map((c) => [c.id, c]));
  for (const j of jobs) {
    const { compositionId, version } = j.payload as { compositionId: string; version: number };
    const title = comps.get(compositionId)?.title ?? compositionId;
    if (j.status === "succeeded")
      noteOnce(env, "observation", `Re-rendered “${title}” v${version} after Spark's fix. It isn't reviewed again automatically (one fix round at most); choose Review with Spark in the Studio to check it.`, [ref("compositions", compositionId), ref("jobs", j.id)]);
    else noteOnce(env, "error", `Re-render of “${title}” v${version} failed: ${jobError(j)}. Its post uses the earlier render.`, [ref("jobs", j.id)]);
  }
  return { kind: "advance", to: "schedule" };
}

/** Route a render-stage sub-phase that belongs to Spark's review. */
export async function watchStep(env: LoopEnv, step: WatchStep, renderable: RenderableFn): Promise<Outcome> {
  if (step.tag === "render:watch") return afterWatch(env, step);
  if (step.tag === "render:fix" || step.tag === "render:rerender:approve") return afterFix(env, step, renderable);
  if (step.tag === "render:rerender") return afterRerender(env);
  return { kind: "advance", to: "schedule" };
}
