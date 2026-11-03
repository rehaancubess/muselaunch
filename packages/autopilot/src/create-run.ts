/**
 * Create runs, the pure part (no I/O; unit-tested in create-run.test.ts): where a run stands, read
 * only from stored records (campaign, ideas, videos, jobs, final renders), the one step the server
 * takes next, and what a refused step means (a decision for the person, or a short wait).
 * The I/O (taking steps, storing decisions, the read model) is in create-runner.ts.
 */
import type { AspectRatio, Campaign, CampaignVariant, Channel, Composition, CreateDecisionKind, CreateRunFailure, CreateRunStage, Job } from "@muselaunch/contracts";

export type CreateKind = "promote" | "feature";
type Step = Exclude<CreateRunStage, "done">;

/** What a Create campaign was asked for (its one deliverable). */
export function runSettings(campaign: Pick<Campaign, "deliverables" | "goal">): { kind: CreateKind; aspectRatio: AspectRatio; lengthSec?: number; channel?: Channel } {
  const d = campaign.deliverables[0];
  const kind: CreateKind = d?.kind === "feature_promo" || campaign.goal === "feature_announcement" ? "feature" : "promote";
  return { kind, aspectRatio: d?.aspectRatio ?? "9:16", lengthSec: d?.durationSec, channel: d?.channel };
}

type VariantLike = Pick<CampaignVariant, "id" | "status" | "angleType" | "title">;

/**
 * The idea a Create run makes: the one already picked, else (for "Show a feature") the first demo or
 * tutorial idea, else the first idea Muse wrote (it lists its strongest first). Set-aside ideas never.
 */
export function pickVariant<V extends VariantLike>(variants: V[], kind: CreateKind): V | null {
  const live = variants.filter((v) => v.status !== "rejected");
  const chosen = live.find((v) => v.status === "selected" || v.status === "produced");
  if (chosen) return chosen;
  if (kind === "feature") {
    const demo = live.find((v) => v.angleType === "practical_demo" || v.angleType === "tutorial");
    if (demo) return demo;
  }
  return live[0] ?? null;
}

/** The step the server takes for the person (what they'd click on the campaign page / in the Studio). */
export type NextStep =
  | { kind: "produce"; variantId: string; select: boolean; aspectRatio: AspectRatio; targetDurationSec?: number }
  | { kind: "final"; compositionId: string; version: number };

/** One key per step: a decision, an approval or an override belongs to exactly this step. */
export const stepKeyOf = (n: NextStep) => (n.kind === "produce" ? `produce:${n.variantId}` : `final:${n.compositionId}:v${n.version}`);

/** Overall progress where each step starts (the last one ends at 100). */
const STEP_START: Record<Step, number> = { idea: 0, plan: 20, make: 45, check: 75, finish: 80 };
const STEP_END: Record<Step, number> = { idea: 20, plan: 45, make: 75, check: 80, finish: 100 };

export interface Derived {
  stage: CreateRunStage;
  /** 0–100 over the whole run. */
  pct: number;
  /** The running job's own words ("rendering video"), when it has some. */
  detail?: string;
  /** A job of this run is queued or running (or its records are a moment behind a finished one). */
  working: boolean;
  /** The step to take now (null: nothing to take, e.g. a job is running or the run is done). */
  next: NextStep | null;
  failure: CreateRunFailure | null;
  variantId?: string;
  ideaTitle?: string;
  ideaCount: number;
  compositionId?: string;
  finalAssetId?: string;
  /** Newest change to any job of this run (ms), for "nobody moved it for a day". */
  lastActivity: number;
}

export type JobLike = Pick<Job, "id" | "type" | "status" | "payload" | "progress" | "parentJobId" | "error" | "createdAt"> & Partial<Pick<Job, "output" | "updatedAt">>;
type CompLike = Pick<Composition, "id" | "status" | "currentVersion" | "lastRender" | "variantId" | "createdAt">;
export type FinalLike = { id: string; render?: { compositionId: string; quality: string; version: number } | null; status: string; kind?: string; role?: string };

export interface RunInput {
  campaign: Pick<Campaign, "id" | "status" | "deliverables" | "goal" | "createdAt">;
  variants: (VariantLike & Partial<Pick<CampaignVariant, "compositionIds">>)[];
  compositions: CompLike[];
  /** The app's recent jobs plus the run's own (any order). */
  jobs: JobLike[];
  /** Final render assets (of this campaign). */
  finals: FinalLike[];
  /** Screenshot checks or a walkthrough being cut right now (plans wait for that real footage). */
  footageBusy?: boolean;
}

const isActive = (j: Pick<Job, "status"> | null | undefined) => Boolean(j && (j.status === "queued" || j.status === "running"));
const newest = <T extends { createdAt: string }>(xs: T[]) => [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
const jobPct = (j: JobLike | undefined) => (j && isActive(j) ? Math.max(0, Math.min(100, j.progress?.pct ?? 0)) / 100 : 0);
const within = (step: Step, frac: number) => Math.round(STEP_START[step] + (STEP_END[step] - STEP_START[step]) * Math.max(0, Math.min(1, frac)));
const failText = (j: JobLike, fallback: string) => j.error?.userMessage ?? j.error?.message ?? fallback;
/** The running job's step in its own plain words ("rendering video"), not its technical detail. */
const detailOf = (j: JobLike | undefined) => {
  if (!j || !isActive(j)) return undefined;
  const stage = j.progress?.stage;
  return stage && !["queued", "running", "starting", "done", "retrying"].includes(stage) ? stage.slice(0, 200) : undefined;
};

/** The newest final render of a composition, if it's ready. */
export function finalFor(finals: FinalLike[], compositionId: string): FinalLike | undefined {
  return finals.find((a) => a.render?.compositionId === compositionId && a.render.quality === "final" && a.status === "ready" && (a.kind ?? "video") === "video" && (a.role ?? "render") === "render");
}

export function deriveRun(input: RunInput): Derived {
  const { campaign, variants } = input;
  const jobs = dedupe(input.jobs);
  const settings = runSettings(campaign);
  const mine = (type: Job["type"], match: (p: Record<string, unknown>) => boolean) => newest(jobs.filter((j) => j.type === type && match(j.payload)));
  /** A job, or the newest retry of it ("Try again" runs a failed job as a new one whose parent is the old one). */
  const latest = (j: JobLike | undefined): JobLike | undefined => {
    let cur = j;
    for (let i = 0; cur && i < 10; i++) {
      const again = newest(jobs.filter((x) => x.parentJobId === cur!.id && x.type === cur!.type));
      if (!again) break;
      cur = again;
    }
    return cur;
  };
  const childOf = (parent: JobLike | undefined, type: Job["type"]) => (parent ? latest(newest(jobs.filter((j) => j.parentJobId === parent.id && j.type === type))) : undefined);
  const touched: JobLike[] = [];
  const track = <T extends JobLike | undefined>(j: T) => (j && touched.push(j), j);
  const base = { ideaCount: variants.length, failure: null, next: null, working: false };
  const result = (stage: CreateRunStage, rest: Partial<Derived>): Derived => ({
    ...base,
    stage,
    pct: stage === "done" ? 100 : STEP_START[stage],
    ...rest,
    lastActivity: Math.max(Date.parse(campaign.createdAt), ...touched.map((j) => Date.parse(j.updatedAt ?? j.createdAt))),
  });
  const failed = (stage: Step, j: JobLike, stopped: string, fallback: string, extra: Partial<Derived> = {}) =>
    result(stage, { ...extra, failure: { stage, message: j.status === "cancelled" ? stopped : failText(j, fallback), jobId: j.id, canRetry: true } });

  // 1. Writing the idea (Muse Spark concepts). The idea being made is the one its plan is for (whoever
  // started it); before that, the best-fitting one.
  const concepts = track(mine("campaign.generate_concepts", (p) => p.campaignId === campaign.id));
  const planned = mine("storyboard.generate", (p) => p.campaignId === campaign.id);
  const chosen = variants.find((v) => v.id === planned?.payload.variantId && v.status !== "rejected") ?? pickVariant(variants, settings.kind);
  if (!chosen) {
    if (isActive(concepts)) return result("idea", { working: true, pct: within("idea", jobPct(concepts)), detail: detailOf(concepts) });
    if (concepts && (concepts.status === "failed" || concepts.status === "cancelled")) return failed("idea", concepts, "Writing the idea was stopped.", "Muse couldn’t write the idea.");
    if (variants.length) return result("idea", { failure: { stage: "idea", message: "Every idea was set aside.", canRetry: false } });
    // The ideas are saved with the campaign (it leaves "planning"): a campaign past planning without any means none came.
    if (campaign.status !== "planning") return result("idea", { failure: { stage: "idea", message: "Muse didn’t come up with an idea this time.", canRetry: false } });
    // The job finished but the ideas aren't readable yet, or the job isn't in the list yet: on its way.
    return result("idea", { working: true });
  }
  const idea = { variantId: chosen.id, ideaTitle: chosen.title };

  // 2. Planning the video (storyboard) → 3. Making it (b-roll → editable video → preview).
  const comp = newest(input.compositions.filter((c) => c.variantId === chosen.id || (chosen.compositionIds ?? []).includes(c.id)));
  const board = track(mine("storyboard.generate", (p) => p.campaignId === campaign.id && (p.variantId === chosen.id || !p.variantId)));
  const media = track(childOf(board, "storyboard.resolve_media"));
  const build = track(childOf(board, "composition.build") ?? childOf(media, "composition.build"));
  if (!comp) {
    if (!board) {
      if (input.footageBusy) return result("plan", { ...idea, working: true, detail: "Getting your app’s screens ready first" });
      return result("plan", { ...idea, next: { kind: "produce", variantId: chosen.id, select: chosen.status === "proposed", aspectRatio: settings.aspectRatio, targetDurationSec: settings.lengthSec } });
    }
    if (isActive(board)) return result("plan", { ...idea, working: true, pct: within("plan", jobPct(board)), detail: detailOf(board) });
    if (board.status !== "succeeded") return failed("plan", board, "Planning the video was stopped.", "Muse couldn’t plan the video.", idea);
    for (const [j, what] of [
      [media, "Finding the extra footage failed."],
      [build, "Making the video failed."],
    ] as const) {
      if (j && !isActive(j) && j.status !== "succeeded") return failed("make", j, "Making the video was stopped.", what, idea);
    }
    const running = isActive(build) ? build : isActive(media) ? media : undefined;
    const frac = isActive(build) ? 0.25 + 0.5 * jobPct(build) : isActive(media) ? 0.25 * jobPct(media) : 0;
    return result("make", { ...idea, working: true, pct: within("make", frac), detail: detailOf(running) });
  }
  const made = { ...idea, compositionId: comp.id };

  // Finished: a ready final render of this video.
  const final = finalFor(input.finals, comp.id);
  const finalJob = track(latest(mine("render.final", (p) => p.compositionId === comp.id)));
  if (final) return result("done", { ...made, finalAssetId: final.id });

  // 5. Finishing (final render).
  if (isActive(finalJob)) return result("finish", { ...made, working: true, pct: within("finish", jobPct(finalJob)), detail: detailOf(finalJob) });
  if (finalJob?.status === "succeeded") {
    // The render finished (the video's records may be a moment behind the job).
    const assetId = (finalJob.output?.data as { assetId?: string } | undefined)?.assetId ?? (comp.lastRender?.quality === "final" ? comp.lastRender.assetId : undefined);
    return result("done", { ...made, finalAssetId: assetId });
  }
  if (finalJob && (finalJob.status === "failed" || finalJob.status === "cancelled")) return failed("finish", finalJob, "The final video was stopped.", "The final video didn’t finish.", made);

  // Still making the video or its preview: wait for it (the person would see the video before
  // finishing it). The build queues the preview before it finishes, so once neither runs, none is coming.
  const preview = track(latest(mine("render.preview", (p) => p.compositionId === comp.id)));
  if (isActive(build)) return result("make", { ...made, working: true, pct: within("make", 0.25 + 0.5 * jobPct(build)), detail: detailOf(build) });
  if (isActive(preview)) return result("make", { ...made, working: true, pct: within("make", 0.75 + 0.25 * jobPct(preview)), detail: detailOf(preview) });

  // 4. Checking facts and brand, then the final render (the same checks the render route makes).
  return result("check", { ...made, next: { kind: "final", compositionId: comp.id, version: comp.currentVersion } });
}

function dedupe(jobs: JobLike[]): JobLike[] {
  const seen = new Map<string, JobLike>();
  for (const j of jobs) seen.set(j.id, j);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// When a step is refused
// ---------------------------------------------------------------------------

/**
 * A refused step: a decision for the person, or a passing problem the server waits out (`glitch`: an
 * unexpected error, waited out a few times before it becomes a decision; the rest wait until they clear).
 */
export type StepProblem = { wait: true; reason: string; glitch?: boolean } | { wait: false; kind: CreateDecisionKind; message: string; canOverride?: boolean; reviewId?: string; credits?: number };

type ErrorLike = { status?: number; code?: string; retryable?: boolean; userMessage?: string; message?: string; details?: Record<string, unknown> };

/** An error from a Create step, in plain words, and whether it's a decision or a short wait. */
export function problemFromError(err: ErrorLike): StepProblem {
  const msg = err.userMessage ?? err.message ?? "That didn’t work.";
  const d = err.details ?? {};
  switch (err.code) {
    case "INSUFFICIENT_CREDITS":
      return { wait: false, kind: "credits", message: msg, credits: typeof d.required === "number" ? d.required : undefined };
    case "QUOTA_EXCEEDED":
      // Too many tasks at once clears by itself; a daily limit or the monthly allowance doesn't.
      return d.quota === "concurrentJobs" ? { wait: true, reason: msg } : { wait: false, kind: "limit", message: msg };
    case "APPROVAL_REQUIRED":
      if (d.reason === "brand_review_blocked") {
        const review = d.review as { id?: string; blocking?: { message?: string }[]; summary?: string } | undefined;
        return { wait: false, kind: "brand", message: review?.blocking?.[0]?.message ?? review?.summary ?? msg, canOverride: d.requiresOverride === true, reviewId: review?.id };
      }
      return { wait: false, kind: "error", message: msg };
    case "VALIDATION_FAILED": {
      const issues = (d.issues as { message?: string }[] | undefined) ?? [];
      return { wait: false, kind: "fix", message: issues[0]?.message ? `${msg} ${issues[0].message}` : msg };
    }
    case "CONFLICT":
      if (d.reason === "brand_review_running") return { wait: true, reason: msg };
      return { wait: false, kind: "error", message: msg };
    case "FORBIDDEN":
      return { wait: false, kind: "permission", message: msg };
    case "RATE_LIMITED":
    case "PROVIDER_UNAVAILABLE":
    case "SPEND_CEILING":
    case "TIMEOUT":
      return { wait: true, reason: msg, glitch: true };
    default:
      return err.retryable || (err.status ?? 0) >= 500 ? { wait: true, reason: msg, glitch: true } : { wait: false, kind: "error", message: msg };
  }
}

/** The final render costs more than the line "Generate video" showed (the video came out longer): ask first. */
export function overspend(finalCredits: number, shownFinalCredits: number | null | undefined): { credits: number; shown: number } | null {
  if (shownFinalCredits == null || !Number.isFinite(shownFinalCredits)) return null;
  return finalCredits > shownFinalCredits ? { credits: finalCredits, shown: shownFinalCredits } : null;
}

/** Backoff for passing problems: 15 s, 30 s, 1 min, 2 min, 4 min, then every 5 min. */
export const waitMs = (waits: number) => Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, Math.min(waits, 10)));
/** Unexpected errors in a row before the run asks the person (Try again) instead of waiting again. */
export const MAX_GLITCH_WAITS = 5;
