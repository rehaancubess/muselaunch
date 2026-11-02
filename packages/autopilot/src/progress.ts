/**
 * The run in plain steps, for the first-run progress screen ("paste a link, get videos") and the
 * Autopilot views. Everything is read from real state: the loop's stage and status, the jobs it is
 * waiting on (with their own progress), and counts of what was actually produced. A fact that
 * hasn't been measured yet is left out; nothing here estimates or animates progress.
 */
import {
  AUTOPILOT_PROGRESS_STEPS,
  modelDisplayName,
  type Autopilot,
  type AutopilotFinishedVideo,
  type AutopilotProgress,
  type AutopilotProgressStep,
  type AutopilotProgressStepKey,
  type AutopilotStage,
  type BrandReview,
  type Composition,
  type Job,
  type ModelUsageEvent,
} from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import type { Platform } from "@muselaunch/platform";
import { realAppMedia } from "./defaults";
import { isTerminalJob, reasonText, STAGE_ORDER, tagOf } from "./state";

type Step = AutopilotProgressStep;
type State = Step["state"];

/** Which plain step each loop stage belongs to (understand is split into read/learn below). */
const STAGE_STEP: Record<Exclude<AutopilotStage, "understand">, AutopilotProgressStepKey | null> = {
  research: "research",
  select_audience: "research",
  hypothesis: "research",
  plan_creative: "ideas",
  produce: "make",
  verify: "check",
  render: "finish",
  schedule: "ready",
  measure: null,
  learn: null,
  done: null,
};

function currentState(status: Autopilot["status"]): State {
  switch (status) {
    case "running":
    case "waiting_on_jobs":
      return "active";
    case "awaiting_user":
      return "needs_you";
    case "paused":
      return "paused";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return "done";
  }
}

/** Models and labelled external services, as people know them (order: the Meta models first). */
const MODEL_ORDER = ["Muse Wonder", "Muse Spark", "Muse Spark Open", "SAM 3.1", "Muse Voice Transcribe", "Muse Image", "Muse Glimmer"];

function usageName(u: Pick<ModelUsageEvent, "provider" | "model" | "operation">): string | null {
  if (u.provider === "baseten") return "Muse Spark Open";
  if (u.provider === "glimmer") return "Muse Glimmer";
  if (u.provider === "meta") {
    const m = u.model.toLowerCase();
    if (m.includes("sam")) return "SAM 3.1";
    if (m.includes("voice")) return "Muse Voice Transcribe";
    if (m.includes("image")) return "Muse Image";
    const name = modelDisplayName(u.model, { short: true });
    return name.startsWith("Muse") ? name : null;
  }
  if (u.provider === "openai" || u.provider === "tts") return u.operation === "tts" || u.provider === "tts" ? "OpenAI TTS (external AI voice)" : modelDisplayName(u.model);
  return null;
}

/** Distinct models that made metered calls for this app since the run started. */
async function madeWith(ws: WorkspaceDb, ap: Autopilot): Promise<string[]> {
  const page = await ws.collection("modelUsage").list({ where: [["appId", "==", ap.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  const names = new Set<string>();
  for (const u of page.items) {
    if (u.createdAt < ap.createdAt || u.status !== "ok") continue;
    const n = usageName(u);
    if (n) names.add(n);
  }
  const rank = (n: string) => (MODEL_ORDER.includes(n) ? MODEL_ORDER.indexOf(n) : MODEL_ORDER.length);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Live view of the jobs a step is waiting on: their own progress, never a made-up figure. */
function liveOf(jobs: Job[], reason?: string): Step["live"] {
  if (!jobs.length) return reason ? { message: reason.slice(0, 300), done: 0, total: 0 } : undefined;
  const done = jobs.filter(isTerminalJob).length;
  const running = jobs.filter((j) => j.status === "running");
  const open = jobs.filter((j) => !isTerminalJob(j));
  const pct = open.length && running.length ? Math.round(open.reduce((n, j) => n + (j.status === "running" ? (j.progress?.pct ?? 0) : 0), 0) / open.length) : undefined;
  const message = running.find((j) => j.progress?.message)?.progress?.message ?? reason;
  return { message: message?.slice(0, 300), pct: pct === undefined ? undefined : Math.max(0, Math.min(100, pct)), done, total: jobs.length };
}

/** Newest review per video (any version). */
function latestReviews(reviews: BrandReview[]): BrandReview[] {
  const by = new Map<string, BrandReview>();
  for (const r of reviews) {
    const prev = by.get(r.subject.id);
    if (!prev || (r.subjectVersion ?? 0) >= (prev.subjectVersion ?? 0)) by.set(r.subject.id, r);
  }
  return [...by.values()];
}

export interface ProgressInput {
  autopilot: Autopilot;
  /** Every job the loop delegated or waits on (full documents). */
  jobs: Job[];
  reviews: BrandReview[];
  compositions: Composition[];
}

type Media = Omit<AutopilotProgress["media"], "ask">;

/** Run states in which asking for footage still helps (the run hasn't ended). */
const ASKING: readonly Autopilot["status"][] = ["running", "waiting_on_jobs", "awaiting_user", "paused"];

/**
 * Whether the screen should ask for a screen recording: "waiting" while the run is stopped at the
 * `produce:media` decision; "early" when the app has no real footage at all once its link has been
 * read (a website gives no screenshots) and the videos aren't made yet; otherwise null.
 */
export function mediaAsk(ap: Pick<Autopilot, "status" | "stage" | "waitingOn" | "compositionIds">, media: Media, opts: { importDone: boolean }): AutopilotProgress["media"]["ask"] {
  if (ap.status === "awaiting_user" && tagOf(ap.waitingOn.reason) === "produce:media") return "waiting";
  if (media.screenshots + media.recordings > 0) return null;
  // A store listing's screenshots are still being saved: don't ask before they had a chance.
  if (!opts.importDone) return null;
  if (!ASKING.includes(ap.status) || ap.compositionIds.length) return null;
  return STAGE_ORDER.indexOf(ap.stage) <= STAGE_ORDER.indexOf("produce") ? "early" : null;
}

/** Facts that change slowly (where the app came from, screenshots saved, App DNA counts, models used, real footage). */
interface Settled {
  source: AutopilotProgress["source"];
  screenshots?: number;
  learn?: Step["facts"];
  madeWith: string[];
  media: Media;
  /** The app's link has been read (or there is nothing to read). */
  importDone: boolean;
}

/**
 * GET /autopilots/:id is polled every few seconds while a run works; these reads (usage events,
 * claims, assets) are cached per run state for a few seconds instead of re-read on every poll.
 * The key includes the run's updatedAt, so every step the loop takes recomputes them.
 */
const settledCache = new Map<string, { at: number; value: Settled }>();
const SETTLED_TTL_MS = 15_000;

async function settledFacts(ws: WorkspaceDb, ap: Autopilot, importJob: Job | null): Promise<Settled> {
  const key = `${ap.workspaceId}:${ap.id}:${ap.updatedAt}`;
  const hit = settledCache.get(key);
  if (hit && Date.now() - hit.at < SETTLED_TTL_MS) return hit.value;
  const [app, dna, made, media] = await Promise.all([ws.collection("apps").get(ap.appId), ws.collection("brandProfiles").get(ap.appId), madeWith(ws, ap), realAppMedia(ws, ap.appId)]);
  const importId = app?.lastImportId ?? (importJob?.payload as { importId?: string } | undefined)?.importId;
  const imp = importId ? await ws.collection("appImports").get(importId) : null;
  const kinds = imp?.sources.map((s) => s.kind) ?? [];
  const value: Settled = {
    source: kinds.includes("app_store") ? "app_store" : kinds.includes("google_play") ? "google_play" : kinds.includes("website") ? "website" : kinds.length ? "description" : null,
    madeWith: made,
    media,
    importDone: !imp || ["analyzing", "succeeded", "partial", "failed"].includes(imp.status),
  };
  // Screenshots are saved before the import moves on to analysis.
  if (imp?.importedAssetIds.length && ["analyzing", "succeeded", "partial"].includes(imp.status)) {
    const assets = await ws.collection("mediaAssets").getMany(imp.importedAssetIds.slice(0, 40));
    value.screenshots = assets.filter((a) => a.role === "screenshot").length;
  }
  if (dna) {
    const verified = await ws.collection("claims").list({ where: [["appId", "==", ap.appId], ["state", "==", "verified"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
    value.learn = { features: dna.features.length, audiences: dna.audiences.length, facts: verified.items.length };
  }
  if (settledCache.size > 500) settledCache.delete(settledCache.keys().next().value!);
  settledCache.set(key, { at: Date.now(), value });
  return value;
}

export async function autopilotProgress(p: Platform, workspaceId: string, input: ProgressInput): Promise<AutopilotProgress> {
  const ws = p.db.ws(workspaceId);
  const ap = input.autopilot;
  // The app's own import/analysis jobs only matter while the run is still learning the app.
  const appJobs = ap.stage === "understand" ? (await ws.collection("jobs").list({ where: [["appId", "==", ap.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 })).items : [];
  const importJob = appJobs.find((j) => j.type === "app.import") ?? null;
  const analyzeJob = appJobs.find((j) => j.type === "app.analyze") ?? null;
  const [settled, research, waiting] = await Promise.all([
    settledFacts(ws, ap, importJob),
    ap.researchRunId ? ws.collection("researchRuns").get(ap.researchRunId) : Promise.resolve(null),
    ws.collection("jobs").getMany(ap.waitingOn.jobIds),
  ]);
  const { source } = settled;
  const reason = reasonText(ap.waitingOn.reason) || undefined;

  // Where the run is now.
  let cur: number;
  if (ap.stage === "understand") {
    const reading = !settled.learn && importJob && (!isTerminalJob(importJob) || (importJob.status !== "succeeded" && ap.status === "failed"));
    cur = AUTOPILOT_PROGRESS_STEPS.indexOf(reading ? "read" : "learn");
  } else {
    const key = STAGE_STEP[ap.stage];
    cur = key ? AUTOPILOT_PROGRESS_STEPS.indexOf(key) : AUTOPILOT_PROGRESS_STEPS.length;
  }
  if (ap.status === "completed") cur = AUTOPILOT_PROGRESS_STEPS.length;
  const nowState = currentState(ap.status);

  // Facts, from what exists.
  const facts: Record<AutopilotProgressStepKey, Step["facts"]> = { read: {}, learn: {}, research: {}, ideas: {}, make: {}, check: {}, finish: {}, ready: {} };
  if (settled.screenshots !== undefined) facts.read.screenshots = settled.screenshots;
  if (settled.learn) facts.learn = settled.learn;
  if (research && (research.status === "succeeded" || research.status === "partial")) facts.research.findings = research.findingCount ?? 0;
  if (ap.campaignId && AUTOPILOT_PROGRESS_STEPS.indexOf("ideas") <= cur) {
    const variants = await ws.collection("campaignVariants").list({ where: [["campaignId", "==", ap.campaignId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 });
    const ideas = variants.items.filter((v) => v.status !== "rejected").length;
    if (ideas) facts.ideas.ideas = ideas;
    if (ap.variantIds.length) facts.ideas.picked = ap.variantIds.length;
  }
  if (ap.compositionIds.length) facts.make.videos = ap.compositionIds.length;
  const reviews = latestReviews(input.reviews.filter((r) => r.subject.entity === "compositions" && ap.compositionIds.includes(r.subject.id)));
  const terminal = reviews.filter((r) => ["passed", "warnings", "blocked"].includes(r.status));
  if (terminal.length) {
    facts.check = {
      passed: terminal.filter((r) => r.status === "passed").length,
      withNotes: terminal.filter((r) => r.status === "warnings").length,
      blocked: terminal.filter((r) => r.status === "blocked").length,
    };
    const fixes = ap.log.filter((e) => e.kind === "action" && e.summary.startsWith("Fix round") && e.summary.includes(`(iteration ${ap.iteration})`)).length;
    if (fixes) facts.check.fixed = fixes;
  }

  // Finished videos: the newest succeeded final render of each of this iteration's videos.
  const finals = input.jobs
    .filter((j) => j.type === "render.final" && j.status === "succeeded")
    .map((j) => {
      const data = (j.output?.data ?? {}) as { assetId?: string; posterAssetId?: string; durationSec?: number };
      // The render handler's first output ref is the MP4 itself (data.assetId names it too).
      const out = { ...data, assetId: data.assetId ?? j.output?.refs.find((r) => r.entity === "mediaAssets")?.id };
      return { j, pl: j.payload as { compositionId?: string; version?: number }, out };
    })
    .filter((x) => x.pl.compositionId && ap.compositionIds.includes(x.pl.compositionId) && x.out.assetId);
  const newest = new Map<string, (typeof finals)[number]>();
  for (const x of finals) {
    const prev = newest.get(x.pl.compositionId!);
    if (!prev || (x.pl.version ?? 0) >= (prev.pl.version ?? 0)) newest.set(x.pl.compositionId!, x);
  }
  const compById = new Map(input.compositions.map((c) => [c.id, c]));
  const videos: AutopilotFinishedVideo[] = [...newest.values()]
    .sort((a, b) => (a.j.finishedAt ?? a.j.updatedAt).localeCompare(b.j.finishedAt ?? b.j.updatedAt))
    .map((x) => {
      const c = compById.get(x.pl.compositionId!);
      return {
        compositionId: x.pl.compositionId!,
        title: c?.title ?? "Video",
        version: x.pl.version ?? c?.currentVersion ?? 1,
        assetId: x.out.assetId!,
        posterAssetId: x.out.posterAssetId,
        aspectRatio: c?.aspectRatio ?? "9:16",
        durationSec: typeof x.out.durationSec === "number" ? Math.round(x.out.durationSec * 10) / 10 : undefined,
        renderedAt: x.j.finishedAt,
      };
    });
  if (videos.length) facts.finish.rendered = videos.length;
  if (ap.scheduledPostIds.length) facts.ready.posts = ap.scheduledPostIds.length;

  const steps: Step[] = AUTOPILOT_PROGRESS_STEPS.map((key, i) => {
    let state: State = i < cur ? "done" : i > cur ? "pending" : nowState;
    if (key === "read" && !source) state = "skipped";
    let live: Step["live"];
    if (i === cur && (state === "active" || state === "failed")) {
      if (key === "read" && importJob) live = liveOf([importJob]);
      else if (key === "learn" && analyzeJob && !isTerminalJob(analyzeJob)) live = liveOf([analyzeJob]);
      else live = liveOf(waiting, reason);
    }
    return { key, state, facts: facts[key], ...(live ? { live } : {}) };
  });
  return { source, steps, videos, madeWith: settled.madeWith, media: { ...settled.media, ask: mediaAsk(ap, settled.media, { importDone: settled.importDone }) } };
}
