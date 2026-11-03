/**
 * Create ("What would you like to make?"): the plain-TS choices behind the page. No React and no
 * "@/" imports here (unit-tested in plan.test.ts).
 *
 *  - The three starting points (Promote my app / Show a feature / Use a suggested idea), the prompt
 *    each one suggests, and the deep-link query (?kind=&prompt=&idea=).
 *  - Formats (Instagram Reel, TikTok, YouTube Short = 9:16; Square post = 1:1; YouTube video = 16:9)
 *    and lengths (15–60 s, clamped to the plan's maxVideoSec).
 *  - The request "Generate video" sends: an existing campaign request (POST /apps/:appId/campaigns)
 *    for ONE video, marked origin "create", with the format and length in its one deliverable.
 *  - Where a Create run stands, read only from stored records (campaign, ideas, videos, jobs, final
 *    renders): which plain step it's on, how far along, and the one step a person would click next
 *    (use the best-fitting idea → plan it; finish it with a final render). Nothing is guessed: a job
 *    that failed says so, and a decision (credits, plan limits, the brand check) waits for the person.
 */
import type { AspectRatio, Campaign, CampaignGoal, CampaignVariant, Channel, Composition, Deliverable, DeliverableKind, Job, MediaAsset } from "@muselaunch/contracts";

// ---------------------------------------------------------------------------
// Starting points and prompts
// ---------------------------------------------------------------------------

export type CreateKind = "promote" | "feature" | "idea";
export const CREATE_KINDS: CreateKind[] = ["promote", "feature", "idea"];
export const KIND_LABEL: Record<CreateKind, string> = { promote: "Promote my app", feature: "Show a feature", idea: "Use a suggested idea" };

export const isCreateKind = (v: string | null | undefined): v is CreateKind => v === "promote" || v === "feature" || v === "idea";

/** The prompt a person needs before "Generate video" (a sentence, not a word). */
export const MIN_PROMPT = 8;
export const MAX_PROMPT = 4000;

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const noStop = (s: string) => s.replace(/[\s.!?…]+$/, "");

/** First sentence of a text (up to `max` characters, cut at a word). */
export function firstSentence(text: string | null | undefined, max = 180): string {
  const t = squash(text);
  if (!t) return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1]! : t;
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max * 0.6))).replace(/[,;:\s]+$/, "")}…`;
}

/** Lower-case the first letter unless the first word looks like a name or acronym (iOS, AI, TikTok…). */
function lowerFirst(s: string): string {
  const word = s.split(/\s/)[0] ?? "";
  if (word.length > 1 && (word === word.toUpperCase() || /[A-Z]/.test(word.slice(1)))) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Words that follow a plural noun, not a verb ("Timers for…", "Reminders that…", "Widgets on…"). */
const AFTER_NOUN = new Set(["that", "which", "who", "for", "with", "to", "in", "on", "of", "and", "or", "from", "by", "at", "across", "per", "like", "are", "were"]);

/**
 * A sentence that starts with what something does: "Blocks distractions", "Helps you…", "Turns…".
 * Not a plural noun ("Timers for any task", "Reminders that…"), "Glass…", or the name's own word.
 */
const startsWithVerb = (line: string, name = "") => {
  const [w = "", next = ""] = line.split(/\s+/);
  if (!/^[A-Z][a-z]+s$/.test(w) || /(ss|us|is)$/.test(w)) return false;
  if (AFTER_NOUN.has(next.toLowerCase().replace(/[^a-z]/g, ""))) return false;
  return !name.toLowerCase().split(/\s+/).includes(w.toLowerCase());
};

/** The app's short name: a store title without its subtitle ("Tidy Timer: Focus & Pomodoro" → "Tidy Timer"). */
export function shortName(appName: string | null | undefined): string {
  const name = squash(appName);
  const head = name.split(/\s*:\s+|\s+[-–—|]\s+/)[0]?.trim() ?? "";
  return head.length >= 2 ? head : name;
}

/** "Promote my app": a starting suggestion from About your app (one-liner, else tagline). */
export function promotePrompt(appName: string, about: { oneLiner?: string | null; tagline?: string | null } = {}): string {
  const name = shortName(appName) || "my app";
  const line = noStop(firstSentence(about.oneLiner) || firstSentence(about.tagline));
  if (!line) return `Introduce ${name} and what makes it worth trying.`;
  // "Tidy Timer turns…" → "Show why Tidy Timer turns…"; "Helps you…" → "Introduce Tidy Timer, which helps you…".
  if (line.toLowerCase().startsWith(name.toLowerCase())) return `Show why ${line}.`;
  if (startsWithVerb(line, name)) return `Introduce ${name}, which ${lowerFirst(line)}.`;
  return `Introduce ${name}: ${lowerFirst(line)}.`;
}

/**
 * "Show a feature": "Show how Focus Mode blocks distracting apps." from the feature's name and the
 * first sentence of its description when that reads as what it does ("Blocks…", "Keeps…").
 */
export function featurePrompt(feature: { name: string; description?: string | null }): string {
  const name = squash(feature.name) || "this feature";
  const line = noStop(firstSentence(feature.description));
  if (line && startsWithVerb(line, name)) return `Show how ${name} ${lowerFirst(line)}.`;
  return line ? `Show ${name} in action: ${lowerFirst(line)}.` : `Show ${name} in action.`;
}

/** "Use a suggested idea": the idea's title and the angle Muse proposed. */
export function ideaPrompt(idea: { title: string; proposedAngle?: string | null; summary?: string | null }): string {
  const title = noStop(squash(idea.title));
  const angle = noStop(firstSentence(idea.proposedAngle) || (squash(idea.summary) !== squash(idea.title) ? firstSentence(idea.summary) : ""));
  return angle ? `${title}. ${angle}.` : `${title}.`;
}

/** What other pages may prefill (routes.app().create({ kind, prompt, ideaId })). */
export interface CreatePrefill {
  kind: CreateKind | null;
  prompt: string;
  ideaId: string | null;
}

export function readPrefill(get: (k: string) => string | null): CreatePrefill {
  const raw = get("kind");
  const ideaId = squash(get("idea")).slice(0, 128) || null;
  const kind = isCreateKind(raw) ? raw : ideaId ? "idea" : null;
  return { kind, prompt: (get("prompt") ?? "").trim().slice(0, MAX_PROMPT), ideaId: kind === "idea" ? ideaId : null };
}

// ---------------------------------------------------------------------------
// Format and length
// ---------------------------------------------------------------------------

export type FormatId = "instagram_reel" | "tiktok" | "youtube_short" | "square_post" | "youtube_video";

export interface VideoFormat {
  id: FormatId;
  label: string;
  channel: Channel;
  aspectRatio: AspectRatio;
}

export const FORMATS: VideoFormat[] = [
  { id: "instagram_reel", label: "Instagram Reel", channel: "instagram", aspectRatio: "9:16" },
  { id: "tiktok", label: "TikTok", channel: "tiktok", aspectRatio: "9:16" },
  { id: "youtube_short", label: "YouTube Short", channel: "youtube", aspectRatio: "9:16" },
  { id: "square_post", label: "Square post", channel: "instagram", aspectRatio: "1:1" },
  { id: "youtube_video", label: "YouTube video", channel: "youtube", aspectRatio: "16:9" },
];

export const formatById = (id: string | null | undefined): VideoFormat => FORMATS.find((f) => f.id === id) ?? FORMATS[0]!;

/** The first place the person said they post (Where do you post?), else an Instagram Reel. */
export function defaultFormat(postTo: readonly string[] | null | undefined): VideoFormat {
  for (const c of postTo ?? []) {
    if (c === "tiktok") return formatById("tiktok");
    if (c === "youtube") return formatById("youtube_short");
    if (c === "instagram") return formatById("instagram_reel");
  }
  return FORMATS[0]!;
}

export const LENGTHS = [15, 20, 30, 45, 60] as const;
export const DEFAULT_LENGTH = 20;

/** The lengths the plan allows (always at least the shortest). */
export function lengthOptions(maxVideoSec: number | null | undefined): number[] {
  const max = maxVideoSec && maxVideoSec > 0 ? maxVideoSec : 60;
  const ok = LENGTHS.filter((s) => s <= max);
  return ok.length ? [...ok] : [LENGTHS[0]];
}

/** A length the plan allows: the one asked for, else the longest allowed below it (else the shortest). */
export function clampLength(sec: number | null | undefined, maxVideoSec: number | null | undefined): number {
  const opts = lengthOptions(maxVideoSec);
  const want = typeof sec === "number" && Number.isFinite(sec) ? sec : DEFAULT_LENGTH;
  return [...opts].reverse().find((s) => s <= want) ?? opts[0]!;
}

/** "0:20" */
export function clock(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// The request "Generate video" sends
// ---------------------------------------------------------------------------

const GOAL: Record<CreateKind, CampaignGoal> = { promote: "awareness", feature: "feature_announcement", idea: "awareness" };
const DELIVERABLE: Record<CreateKind, DeliverableKind> = { promote: "short_video", feature: "feature_promo", idea: "short_video" };

export interface GenerateInput {
  kind: CreateKind;
  prompt: string;
  format: VideoFormat;
  lengthSec: number;
  ideaId?: string | null;
}

/** Body of POST /apps/:appId/campaigns for one video (the API's CreateCampaignRequest). */
export function campaignRequest(input: GenerateInput) {
  const deliverable: Deliverable = { kind: DELIVERABLE[input.kind], channel: input.format.channel, aspectRatio: input.format.aspectRatio, durationSec: input.lengthSec, count: 1 };
  return {
    request: input.prompt.trim().slice(0, MAX_PROMPT),
    goal: GOAL[input.kind],
    channels: [input.format.channel],
    deliverables: [deliverable],
    opportunityIds: input.kind === "idea" && input.ideaId ? [input.ideaId] : [],
    // The fewest ideas Muse writes; Create uses the one that fits best and keeps the others.
    conceptCount: 3,
    origin: "create" as const,
  };
}

/** The estimates "Generate video" adds up (POST /estimate per step, the operations the jobs reserve). */
export function estimateSteps(lengthSec: number, opts: { aiVoice?: boolean } = {}): { key: string; label: string; operation: string; params: Record<string, unknown> }[] {
  return [
    { key: "idea", label: "Writing the idea (Muse Spark)", operation: "campaign.generate_concepts", params: {} },
    { key: "plan", label: "Planning the video (Muse Spark)", operation: "storyboard.generate", params: { targetDurationSec: lengthSec } },
    { key: "make", label: "Making the editable video", operation: "composition.build", params: {} },
    // AI voice is on by default; it's only charged when the plan has narration and a voice is made.
    ...(opts.aiVoice ? [{ key: "voice", label: "AI voice, if the video has narration", operation: "media.voiceover", params: { source: "tts", chars: lengthSec * 15, durationSec: lengthSec } }] : []),
    { key: "finish", label: `Final video (${lengthSec} s)`, operation: "render.final", params: { durationSec: lengthSec } },
  ];
}

export function sumCredits(lines: { credits: number }[]): number {
  return lines.reduce((n, l) => n + Math.max(0, l.credits), 0);
}

// ---------------------------------------------------------------------------
// Real footage
// ---------------------------------------------------------------------------

/** Real app media a video plan can show (the same rule Autopilot uses): a screenshot or screen recording marked as the real app. */
export function hasRealFootage(assets: Pick<MediaAsset, "role" | "isProductTruth" | "status">[]): boolean {
  return assets.some((a) => a.isProductTruth && (a.role === "screenshot" || a.role === "app_recording") && (a.status === "ready" || a.status === "uploaded" || a.status === "processing"));
}

// ---------------------------------------------------------------------------
// Which idea a Create run uses
// ---------------------------------------------------------------------------

type VariantLike = Pick<CampaignVariant, "id" | "status" | "angleType" | "title">;

/** What a Create campaign was asked for (its one deliverable). */
export function runSettings(campaign: Pick<Campaign, "deliverables" | "goal">): { kind: CreateKind; aspectRatio: AspectRatio; lengthSec?: number; channel?: Channel } {
  const d = campaign.deliverables[0];
  const kind: CreateKind = d?.kind === "feature_promo" || campaign.goal === "feature_announcement" ? "feature" : "promote";
  return { kind, aspectRatio: d?.aspectRatio ?? "9:16", lengthSec: d?.durationSec, channel: d?.channel };
}

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

// ---------------------------------------------------------------------------
// Where a Create run stands
// ---------------------------------------------------------------------------

export type StepKey = "idea" | "plan" | "make" | "check" | "finish";
export const STEPS: StepKey[] = ["idea", "plan", "make", "check", "finish"];
export const STEP_LABEL: Record<StepKey, string> = {
  idea: "Writing the idea",
  plan: "Planning the video",
  make: "Making it",
  check: "Checking facts and brand",
  finish: "Finishing",
};
/** Overall progress where each step starts (the last one ends at 100). */
const STEP_START: Record<StepKey, number> = { idea: 0, plan: 20, make: 45, check: 75, finish: 80 };
const STEP_END: Record<StepKey, number> = { idea: 20, plan: 45, make: 75, check: 80, finish: 100 };

/** A step the page takes on the person's behalf (what they'd click on the campaign page). */
export type NextStep =
  | { kind: "produce"; variantId: string; select: boolean; aspectRatio: AspectRatio; targetDurationSec?: number }
  | { kind: "final"; compositionId: string; version: number };

/** Something that stopped a run, read from stored records (a decision problem comes from the action instead). */
export type RunFailure = { step: StepKey; message: string; jobId?: string; retry: boolean };

export interface RunView {
  campaignId: string;
  step: StepKey | "done";
  /** 0–100 over the whole run. */
  pct: number;
  /** The running job's own words ("rendering video"), when it has some. */
  detail?: string;
  /** A job of this run is queued or running. */
  working: boolean;
  next: NextStep | null;
  failure: RunFailure | null;
  /** Older than a day and not finished, nothing running: not continued without the person. */
  stale: boolean;
  variantId?: string;
  ideaTitle?: string;
  ideaCount: number;
  compositionId?: string;
  finalAssetId?: string;
}

type JobLike = Pick<Job, "id" | "type" | "status" | "payload" | "progress" | "parentJobId" | "error" | "createdAt"> & Partial<Pick<Job, "output">>;
type CompLike = Pick<Composition, "id" | "status" | "currentVersion" | "lastRender" | "variantId" | "createdAt">;
type FinalLike = { id: string; render?: { compositionId: string; quality: string; version: number } | null; status: string; kind?: string };

export interface RunInput {
  campaign: Pick<Campaign, "id" | "status" | "deliverables" | "goal" | "createdAt">;
  variants: (VariantLike & Partial<Pick<CampaignVariant, "compositionIds">>)[];
  compositions: CompLike[];
  /** The app's recent jobs (newest first). */
  jobs: JobLike[];
  /** The app's final render assets. */
  finals: FinalLike[];
  /** Screenshot checks or a walkthrough being cut right now (plans wait for that real footage). */
  footageBusy?: boolean;
  now: number;
}

export const RUN_STALE_MS = 24 * 3_600_000;

const isActive = (j: Pick<Job, "status"> | null | undefined) => Boolean(j && (j.status === "queued" || j.status === "running"));
const newest = <T extends { createdAt: string }>(xs: T[]) => [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
const jobPct = (j: JobLike | undefined) => (j && isActive(j) ? Math.max(0, Math.min(100, j.progress?.pct ?? 0)) / 100 : 0);
const within = (step: StepKey, frac: number) => Math.round(STEP_START[step] + (STEP_END[step] - STEP_START[step]) * Math.max(0, Math.min(1, frac)));
const failText = (j: JobLike, fallback: string) => j.error?.userMessage ?? j.error?.message ?? fallback;
/** The running job's step in its own plain words ("rendering video"), not its technical detail ("Streaming frame 322/600"). */
const detailOf = (j: JobLike | undefined) => {
  if (!j || !isActive(j)) return undefined;
  const stage = j.progress?.stage;
  return stage && !["queued", "running", "starting", "done"].includes(stage) ? stage : undefined;
};

/** The newest final render of a composition, if it's ready. */
export function finalFor(finals: FinalLike[], compositionId: string): FinalLike | undefined {
  return finals.find((a) => a.render?.compositionId === compositionId && a.render.quality === "final" && a.status === "ready" && (a.kind ?? "video") === "video");
}

export function runView(input: RunInput): RunView {
  const { campaign, variants, jobs } = input;
  const settings = runSettings(campaign);
  const mine = (type: Job["type"], match: (p: Record<string, unknown>) => boolean) => newest(jobs.filter((j) => j.type === type && match(j.payload)));
  const childOf = (parent: JobLike | undefined, type: Job["type"]) => (parent ? newest(jobs.filter((j) => j.parentJobId === parent.id && j.type === type)) : undefined);
  const old = input.now - Date.parse(campaign.createdAt) > RUN_STALE_MS;
  const base: Pick<RunView, "campaignId" | "ideaCount" | "stale" | "failure" | "next" | "working"> = { campaignId: campaign.id, ideaCount: variants.length, stale: false, failure: null, next: null, working: false };

  const done = (step: StepKey | "done", rest: Partial<RunView>): RunView => {
    const view: RunView = { ...base, step, pct: step === "done" ? 100 : STEP_START[step], ...rest };
    // A run nobody touched for a day doesn't carry on (and spend) by itself.
    if (step !== "done" && !view.working && old) return { ...view, next: null, stale: !view.failure };
    return view;
  };

  // 1. Writing the idea (Muse Spark concepts).
  const concepts = mine("campaign.generate_concepts", (p) => p.campaignId === campaign.id);
  const chosen = pickVariant(variants, settings.kind);
  if (!chosen) {
    if (isActive(concepts)) return done("idea", { working: true, pct: within("idea", jobPct(concepts)), detail: detailOf(concepts) });
    if (concepts?.status === "failed") return done("idea", { failure: { step: "idea", message: failText(concepts, "Muse couldn’t write the idea."), jobId: concepts.id, retry: true } });
    if (concepts?.status === "cancelled") return done("idea", { failure: { step: "idea", message: "Writing the idea was stopped.", jobId: concepts.id, retry: true } });
    if (variants.length) return done("idea", { failure: { step: "idea", message: "Every idea was set aside.", retry: false } });
    // The ideas are saved with the campaign (it leaves "planning"): a campaign past planning without any means none came.
    if (campaign.status !== "planning") return done("idea", { failure: { step: "idea", message: "Muse didn’t come up with an idea this time.", retry: false } });
    // The job finished but the campaign read is a moment older, or the job isn't in the recent list yet: on its way.
    return done("idea", { working: !old });
  }
  const idea = { variantId: chosen.id, ideaTitle: chosen.title };

  // 2. Planning the video (storyboard) → 3. Making it (b-roll → editable video → preview).
  const comp = newest(input.compositions.filter((c) => c.variantId === chosen.id || (chosen.compositionIds ?? []).includes(c.id))) ?? newest(input.compositions);
  const board = mine("storyboard.generate", (p) => p.campaignId === campaign.id && (p.variantId === chosen.id || !p.variantId));
  if (!comp) {
    if (!board) {
      if (input.footageBusy) return done("plan", { ...idea, detail: "Getting your app’s screens ready first" });
      return done("plan", { ...idea, next: { kind: "produce", variantId: chosen.id, select: chosen.status === "proposed", aspectRatio: settings.aspectRatio, targetDurationSec: settings.lengthSec } });
    }
    if (isActive(board)) return done("plan", { ...idea, working: true, pct: within("plan", jobPct(board)), detail: detailOf(board) });
    if (board.status !== "succeeded") return done("plan", { ...idea, failure: { step: "plan", message: board.status === "cancelled" ? "Planning the video was stopped." : failText(board, "Muse couldn’t plan the video."), jobId: board.id, retry: true } });
    const media = childOf(board, "storyboard.resolve_media");
    const build = childOf(board, "composition.build") ?? childOf(media, "composition.build");
    for (const [j, what] of [
      [media, "Finding the extra footage failed."],
      [build, "Making the video failed."],
    ] as const) {
      if (j && !isActive(j) && j.status !== "succeeded") return done("make", { ...idea, failure: { step: "make", message: j.status === "cancelled" ? "Making the video was stopped." : failText(j, what), jobId: j.id, retry: true } });
    }
    const running = isActive(build) ? build : isActive(media) ? media : undefined;
    const frac = isActive(build) ? 0.25 + 0.5 * jobPct(build) : isActive(media) ? 0.25 * jobPct(media) : 0;
    return done("make", { ...idea, working: true, pct: within("make", frac), detail: detailOf(running) });
  }
  const made = { ...idea, compositionId: comp.id };

  // Finished: a ready final render of this video.
  const final = finalFor(input.finals, comp.id);
  if (final) return done("done", { ...made, finalAssetId: final.id });

  // 5. Finishing (final render).
  const finalJob = mine("render.final", (p) => p.compositionId === comp.id);
  if (isActive(finalJob)) return done("finish", { ...made, working: true, pct: within("finish", jobPct(finalJob)), detail: detailOf(finalJob) });
  if (finalJob?.status === "succeeded") {
    // The render finished (the video's records may be a moment behind the job).
    const assetId = (finalJob.output?.data as { assetId?: string } | undefined)?.assetId ?? (comp.lastRender?.quality === "final" ? comp.lastRender.assetId : undefined);
    return done("done", { ...made, finalAssetId: assetId });
  }
  if (finalJob && (finalJob.status === "failed" || finalJob.status === "cancelled")) {
    return done("finish", { ...made, failure: { step: "finish", message: finalJob.status === "cancelled" ? "The final video was stopped." : failText(finalJob, "The final video didn’t finish."), jobId: finalJob.id, retry: true } });
  }

  // Still making the preview: wait for it (the person would see the video before finishing it). The
  // video's record can show up before its preview job does, so a video that was never previewed waits too.
  const preview = mine("render.preview", (p) => p.compositionId === comp.id);
  if (isActive(preview)) return done("make", { ...made, working: true, pct: within("make", 0.75 + 0.25 * jobPct(preview)), detail: detailOf(preview) });
  const previewed = Boolean(preview) || Boolean(comp.lastRender) || comp.status === "rendered" || comp.status === "approved" || comp.status === "failed";
  if (!previewed && !old) return done("make", { ...made, working: true, pct: within("make", 0.75) });

  // 4. Checking facts and brand, then the final render (one request: the render route checks both first).
  return done("check", { ...made, next: { kind: "final", compositionId: comp.id, version: comp.currentVersion } });
}

/** Overall progress of a step that's done (for the step list): before, current, after. */
export function stepState(view: Pick<RunView, "step" | "failure">, step: StepKey): "done" | "current" | "failed" | "todo" {
  if (view.step === "done") return "done";
  const at = STEPS.indexOf(view.step);
  const i = STEPS.indexOf(step);
  if (i < at) return "done";
  if (i > at) return "todo";
  return view.failure ? "failed" : "current";
}

// ---------------------------------------------------------------------------
// When an action needs the person
// ---------------------------------------------------------------------------

/** A step Create tried that needs the person (or a moment). `wait`: try again by itself shortly. */
export type ActionProblem =
  | { kind: "credits"; message: string }
  | { kind: "limit"; message: string; wait: boolean }
  | { kind: "brand"; message: string; canOverride: boolean }
  | { kind: "fix"; message: string }
  | { kind: "spend"; credits: number; shown: number }
  | { kind: "busy"; message: string }
  | { kind: "error"; message: string };

type ErrorLike = { status?: number; code?: string; userMessage?: string; message?: string; details?: Record<string, unknown> };

/** An API error from a Create step, in plain words, and whether it's a decision or a short wait. */
export function problemFromError(err: ErrorLike): ActionProblem {
  const msg = err.userMessage ?? err.message ?? "That didn’t work.";
  const d = err.details ?? {};
  switch (err.code) {
    case "INSUFFICIENT_CREDITS":
      return { kind: "credits", message: msg };
    case "QUOTA_EXCEEDED":
      // Too many tasks at once clears by itself; a daily limit or the monthly allowance doesn't.
      return { kind: "limit", message: msg, wait: d.quota === "concurrentJobs" };
    case "APPROVAL_REQUIRED":
      if (d.reason === "brand_review_blocked") {
        const review = d.review as { blocking?: { message?: string }[]; summary?: string } | undefined;
        return { kind: "brand", message: review?.blocking?.[0]?.message ?? review?.summary ?? msg, canOverride: d.requiresOverride === true };
      }
      return { kind: "error", message: msg };
    case "VALIDATION_FAILED": {
      const issues = (d.issues as { message?: string }[] | undefined) ?? [];
      return { kind: "fix", message: issues[0]?.message ? `${msg} ${issues[0].message}` : msg };
    }
    case "CONFLICT":
      if (d.reason === "brand_review_running") return { kind: "busy", message: msg };
      return { kind: "error", message: msg };
    case "NETWORK":
    case "RATE_LIMITED":
      return { kind: "busy", message: msg };
    default:
      return (err.status ?? 0) >= 500 ? { kind: "busy", message: msg } : { kind: "error", message: msg };
  }
}

/** Problems that clear on their own: the page tries the step again after a pause. */
export const isWait = (p: ActionProblem) => p.kind === "busy" || (p.kind === "limit" && p.wait);

/** The final render costs more than the line "Generate video" showed (the video came out longer): ask first. */
export function overspend(finalCredits: number, shownFinalCredits: number | null | undefined): { credits: number; shown: number } | null {
  if (shownFinalCredits == null || !Number.isFinite(shownFinalCredits)) return null;
  return finalCredits > shownFinalCredits ? { credits: finalCredits, shown: shownFinalCredits } : null;
}

// ---------------------------------------------------------------------------
// Your content
// ---------------------------------------------------------------------------

export interface FinishedVideo {
  compositionId: string;
  assetId: string;
  posterAssetId?: string;
  campaignId?: string;
  title: string;
  durationSec?: number;
  width?: number;
  height?: number;
  renderedAt: string;
}

type RenderAsset = Pick<MediaAsset, "id" | "kind" | "role" | "status" | "posterAssetId" | "campaignId" | "durationSec" | "width" | "height" | "createdAt" | "title"> & { render?: { compositionId: string; version: number; quality: string } | null };

/** Newest final video per composition, newest first (a newer render of the same video replaces the older). */
export function finishedVideos(assets: RenderAsset[], titles: Map<string, string> | Record<string, string> = {}, max = 12): FinishedVideo[] {
  const name = (id: string) => (titles instanceof Map ? titles.get(id) : titles[id]);
  const seen = new Set<string>();
  const out: FinishedVideo[] = [];
  for (const a of [...assets].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
    const cid = a.render?.compositionId;
    if (!cid || a.role !== "render" || a.render?.quality !== "final" || a.kind !== "video" || a.status !== "ready" || seen.has(cid)) continue;
    seen.add(cid);
    out.push({
      compositionId: cid,
      assetId: a.id,
      posterAssetId: a.posterAssetId,
      campaignId: a.campaignId,
      title: name(cid) ?? (a.title ?? "Video").replace(/\s+—\s+v\d+\s+final$/, ""),
      durationSec: a.durationSec,
      width: a.width,
      height: a.height,
      renderedAt: a.createdAt,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** Where a person posts a finished video by default: the channel its format was made for. */
export function channelFor(campaign: Pick<Campaign, "channels" | "deliverables"> | null | undefined): Channel | undefined {
  return campaign?.deliverables[0]?.channel ?? campaign?.channels[0];
}
