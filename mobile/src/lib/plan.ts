/**
 * Create ("What would you like to make?") on the phone: the same choices and request as the web's
 * Create page, and where a run stands, read only from stored records. Ported from
 * apps/web/src/features/create/plan.ts (keep the two in step); tested in plan.test.ts.
 *
 * The phone only starts a run (POST /apps/:appId/campaigns, origin "create") and shows its progress:
 * MuseLaunch carries the run to the finished video on the server. Nothing is guessed: a job that
 * failed says so, and a run nobody touched for a day doesn't carry on by itself.
 */
import type { AspectRatio, Campaign, CampaignGoal, CampaignVariant, Channel, Composition, CreateRunStatus, CreateRunView, Deliverable, DeliverableKind, FeedItem, Job, MediaAsset, SourceRef } from "../api/types";

// ---------------------------------------------------------------------------
// Starting points and prompts
// ---------------------------------------------------------------------------

export type CreateKind = "promote" | "feature" | "idea";
export const CREATE_KINDS: CreateKind[] = ["promote", "feature", "idea"];
export const KIND_LABEL: Record<CreateKind, string> = { promote: "Promote my app", feature: "Show a feature", idea: "Use a suggested idea" };

/** The prompt a person needs before "Generate video" (a sentence, not a word). */
export const MIN_PROMPT = 8;
export const MAX_PROMPT = 4000;

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const noStop = (s: string) => s.replace(/[\s.!?…]+$/, "");

export function firstSentence(text: string | null | undefined, max = 180): string {
  const t = squash(text);
  if (!t) return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1]! : t;
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max * 0.6))).replace(/[,;:\s]+$/, "")}…`;
}

function lowerFirst(s: string): string {
  const word = s.split(/\s/)[0] ?? "";
  if (word.length > 1 && (word === word.toUpperCase() || /[A-Z]/.test(word.slice(1)))) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

const AFTER_NOUN = new Set(["that", "which", "who", "for", "with", "to", "in", "on", "of", "and", "or", "from", "by", "at", "across", "per", "like", "are", "were"]);

const startsWithVerb = (line: string, name = "") => {
  const [w = "", next = ""] = line.split(/\s+/);
  if (!/^[A-Z][a-z]+s$/.test(w) || /(ss|us|is)$/.test(w)) return false;
  if (AFTER_NOUN.has(next.toLowerCase().replace(/[^a-z]/g, ""))) return false;
  return !name.toLowerCase().split(/\s+/).includes(w.toLowerCase());
};

/** "Tidy Timer: Focus & Pomodoro" → "Tidy Timer". */
export function shortName(appName: string | null | undefined): string {
  const name = squash(appName);
  const head = name.split(/\s*:\s+|\s+[-–—|]\s+/)[0]?.trim() ?? "";
  return head.length >= 2 ? head : name;
}

export function promotePrompt(appName: string, about: { oneLiner?: string | null; tagline?: string | null } = {}): string {
  const name = shortName(appName) || "my app";
  const line = noStop(firstSentence(about.oneLiner) || firstSentence(about.tagline));
  if (!line) return `Introduce ${name} and what makes it worth trying.`;
  if (line.toLowerCase().startsWith(name.toLowerCase())) return `Show why ${line}.`;
  if (startsWithVerb(line, name)) return `Introduce ${name}, which ${lowerFirst(line)}.`;
  return `Introduce ${name}: ${lowerFirst(line)}.`;
}

export function featurePrompt(feature: { name: string; description?: string | null }): string {
  const name = squash(feature.name) || "this feature";
  const line = noStop(firstSentence(feature.description));
  if (line && startsWithVerb(line, name)) return `Show how ${name} ${lowerFirst(line)}.`;
  return line ? `Show ${name} in action: ${lowerFirst(line)}.` : `Show ${name} in action.`;
}

export function ideaPrompt(idea: { title: string; proposedAngle?: string | null; summary?: string | null }): string {
  const title = noStop(squash(idea.title));
  const angle = noStop(firstSentence(idea.proposedAngle) || (squash(idea.summary) !== squash(idea.title) ? firstSentence(idea.summary) : ""));
  return angle ? `${title}. ${angle}.` : `${title}.`;
}

// ---------------------------------------------------------------------------
// Ideas (Discover's picks, each with its real source)
// ---------------------------------------------------------------------------

export function primarySource(item: Pick<FeedItem, "sources">): SourceRef | undefined {
  return item.sources.find((s) => s.url && s.kind !== "model_inference") ?? item.sources.find((s) => s.kind !== "model_inference");
}

export function siteName(source: Pick<SourceRef, "url" | "publisher" | "title">): string {
  if (source.publisher?.trim()) return source.publisher.trim();
  const host = source.url ? /^https?:\/\/(?:www\.)?([^/?#:]+)/i.exec(source.url)?.[1] : undefined;
  return host ?? (source.title?.trim() || "Source");
}

/** The best few ideas for this app: Muse's ideas with a real source, not waved away; unused first. */
export function topIdeas(items: FeedItem[], max = 3): FeedItem[] {
  const ideas = items.filter((i) => i.type === "opportunity" && i.status !== "dismissed" && primarySource(i));
  return [...ideas.filter((i) => i.status !== "used"), ...ideas.filter((i) => i.status === "used")].slice(0, max);
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

export function defaultFormat(postTo: readonly string[] | null | undefined): VideoFormat {
  for (const c of postTo ?? []) {
    if (c === "tiktok") return formatById("tiktok");
    if (c === "youtube") return formatById("youtube_short");
    if (c === "instagram") return formatById("instagram_reel");
  }
  return FORMATS[0]!;
}

// ---------------------------------------------------------------------------
// What to make: a video, or stills / a text post (the web's Create offers the same; the server's
// rules are packages/contracts/src/stills.ts)
// ---------------------------------------------------------------------------

export type MakeId = "video" | "post" | "carousel" | "thumbnail" | "app_store" | "google_play" | "text_post";

export interface Make {
  id: MakeId;
  label: string;
  /** For "Generate …" and messages. */
  noun: string;
  /** Where it can go (the first is the default); empty = a fixed place. */
  channels: Channel[];
  /** Slides: min / max / default (null = one image or no image). */
  slides: { min: number; max: number; def: number } | null;
}

export const MAKES: Make[] = [
  { id: "video", label: "Video", noun: "video", channels: [], slides: null },
  { id: "post", label: "Post", noun: "post", channels: ["instagram", "facebook", "linkedin", "x", "threads"], slides: null },
  { id: "carousel", label: "Carousel", noun: "carousel", channels: ["instagram", "linkedin", "facebook", "threads"], slides: { min: 3, max: 10, def: 6 } },
  { id: "thumbnail", label: "Thumbnail", noun: "thumbnail", channels: ["youtube"], slides: null },
  { id: "app_store", label: "App Store screenshots", noun: "screenshots", channels: ["app_store"], slides: { min: 3, max: 10, def: 6 } },
  { id: "google_play", label: "Google Play screenshots", noun: "screenshots", channels: ["google_play"], slides: { min: 3, max: 8, def: 6 } },
  { id: "text_post", label: "Text post", noun: "post", channels: ["x", "threads", "linkedin", "reddit", "facebook"], slides: null },
];

export const makeById = (id: string | null | undefined): Make => MAKES.find((m) => m.id === id) ?? MAKES[0]!;

/** A slide count the choice allows (the default when nothing was picked). */
export function clampSlideCount(make: Make, n: number | null | undefined): number {
  if (!make.slides) return 1;
  if (typeof n !== "number" || !Number.isFinite(n)) return make.slides.def;
  return Math.max(make.slides.min, Math.min(make.slides.max, Math.round(n)));
}

export interface StillInput {
  kind: CreateKind;
  prompt: string;
  make: Make;
  channel: Channel;
  slides: number;
  ideaId?: string | null;
}

/** Body of POST /apps/:appId/campaigns for one still piece or text post (the web sends the same). */
export function stillCampaignRequest(input: StillInput) {
  const m = input.make;
  const slides = clampSlideCount(m, input.slides);
  let deliverable: Deliverable;
  switch (m.id) {
    case "post":
      deliverable = { kind: "static_ad", channel: input.channel, aspectRatio: "4:5", count: 1 };
      break;
    case "carousel":
      deliverable = { kind: "carousel", channel: input.channel, aspectRatio: "4:5", count: 1, slides };
      break;
    case "thumbnail":
      deliverable = { kind: "thumbnail", channel: "youtube", aspectRatio: "16:9", count: 1 };
      break;
    case "app_store":
      deliverable = { kind: "store_screenshots", channel: "app_store", aspectRatio: "9:19.5", count: 1, slides, store: "ios" };
      break;
    case "google_play":
      deliverable = { kind: "store_screenshots", channel: "google_play", aspectRatio: "9:16", count: 1, slides, store: "android" };
      break;
    default:
      deliverable = { kind: "text_post", channel: input.channel, aspectRatio: "9:16", count: 1 };
  }
  return {
    request: input.prompt.trim().slice(0, MAX_PROMPT),
    goal: GOAL[input.kind],
    channels: [deliverable.channel ?? input.channel],
    deliverables: [deliverable],
    opportunityIds: input.kind === "idea" && input.ideaId ? [input.ideaId] : [],
    conceptCount: 3,
    origin: "create" as const,
  };
}

/** The estimates "Generate …" adds up for stills and text posts (the server prices each step the same way). */
export function stillEstimateSteps(make: Make, slides: number): { key: string; label: string; operation: string; params: Record<string, unknown> }[] {
  const n = clampSlideCount(make, slides);
  if (make.id === "text_post")
    return [
      { key: "idea", label: "Writing the idea (Muse Spark)", operation: "campaign.generate_concepts", params: {} },
      { key: "post", label: "Writing the post (Muse Spark)", operation: "copy.generate", params: {} },
    ];
  const format = make.id === "app_store" || make.id === "google_play" ? "store_screenshots" : make.id;
  const plan: Record<string, unknown> = format === "post" || format === "thumbnail" ? { format } : { format, slides: n, ...(format === "store_screenshots" ? { store: make.id === "google_play" ? "android" : "ios" } : {}) };
  const one = !make.slides;
  return [
    { key: "idea", label: "Writing the idea (Muse Spark)", operation: "campaign.generate_concepts", params: {} },
    { key: "plan", label: one ? "Planning the image (Muse Spark)" : "Planning the slides (Muse Spark)", operation: "storyboard.generate", params: plan },
    { key: "make", label: "Making it, editable", operation: "composition.build", params: {} },
    { key: "finish", label: one ? "Final image" : `Final slides (${n})`, operation: "render.final", params: { slides: one ? 1 : n } },
  ];
}

export const LENGTHS = [15, 20, 30, 45, 60] as const;
export const DEFAULT_LENGTH = 20;

export function lengthOptions(maxVideoSec: number | null | undefined): number[] {
  const max = maxVideoSec && maxVideoSec > 0 ? maxVideoSec : 60;
  const ok = LENGTHS.filter((s) => s <= max);
  return ok.length ? [...ok] : [LENGTHS[0]];
}

export function clampLength(sec: number | null | undefined, maxVideoSec: number | null | undefined): number {
  const opts = lengthOptions(maxVideoSec);
  const want = typeof sec === "number" && Number.isFinite(sec) ? sec : DEFAULT_LENGTH;
  return [...opts].reverse().find((s) => s <= want) ?? opts[0]!;
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

/** Body of POST /apps/:appId/campaigns for one video (the API's CreateCampaignRequest), as the web sends it. */
export function campaignRequest(input: GenerateInput) {
  const deliverable: Deliverable = { kind: DELIVERABLE[input.kind], channel: input.format.channel, aspectRatio: input.format.aspectRatio, durationSec: input.lengthSec, count: 1 };
  return {
    request: input.prompt.trim().slice(0, MAX_PROMPT),
    goal: GOAL[input.kind],
    channels: [input.format.channel],
    deliverables: [deliverable],
    opportunityIds: input.kind === "idea" && input.ideaId ? [input.ideaId] : [],
    conceptCount: 3,
    origin: "create" as const,
  };
}

/** The estimates "Generate video" adds up (POST /estimate per step: the operations the jobs reserve). */
export function estimateSteps(lengthSec: number, opts: { aiVoice?: boolean } = {}): { key: string; label: string; operation: string; params: Record<string, unknown> }[] {
  return [
    { key: "idea", label: "Writing the idea (Muse Spark)", operation: "campaign.generate_concepts", params: {} },
    { key: "plan", label: "Planning the video (Muse Spark)", operation: "storyboard.generate", params: { targetDurationSec: lengthSec } },
    { key: "make", label: "Making the editable video", operation: "composition.build", params: {} },
    ...(opts.aiVoice ? [{ key: "voice", label: "AI voice, if the video has narration", operation: "media.voiceover", params: { source: "tts", chars: lengthSec * 15, durationSec: lengthSec } }] : []),
    { key: "finish", label: `Final video (${lengthSec} s)`, operation: "render.final", params: { durationSec: lengthSec } },
  ];
}

export const sumCredits = (lines: { credits: number }[]) => lines.reduce((n, l) => n + Math.max(0, l.credits), 0);

export function hasRealFootage(assets: Pick<MediaAsset, "role" | "isProductTruth" | "status">[]): boolean {
  return assets.some((a) => a.isProductTruth && (a.role === "screenshot" || a.role === "app_recording") && (a.status === "ready" || a.status === "uploaded" || a.status === "processing"));
}

// ---------------------------------------------------------------------------
// Where a Create run stands
// ---------------------------------------------------------------------------

type VariantLike = Pick<CampaignVariant, "id" | "status" | "angleType" | "title">;

export function runSettings(campaign: Pick<Campaign, "deliverables" | "goal">): { kind: CreateKind; aspectRatio: AspectRatio; lengthSec?: number; channel?: Channel } {
  const d = campaign.deliverables[0];
  const kind: CreateKind = d?.kind === "feature_promo" || campaign.goal === "feature_announcement" ? "feature" : "promote";
  return { kind, aspectRatio: d?.aspectRatio ?? "9:16", lengthSec: d?.durationSec, channel: d?.channel };
}

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

export type StepKey = "idea" | "plan" | "make" | "check" | "finish";
export const STEPS: StepKey[] = ["idea", "plan", "make", "check", "finish"];
export const STEP_LABEL: Record<StepKey, string> = { idea: "Writing the idea", plan: "Planning the video", make: "Making it", check: "Checking facts and brand", finish: "Finishing" };
const STEP_START: Record<StepKey, number> = { idea: 0, plan: 20, make: 45, check: 75, finish: 80 };
const STEP_END: Record<StepKey, number> = { idea: 20, plan: 45, make: 75, check: 80, finish: 100 };

export type NextStep = { kind: "produce"; variantId: string; select: boolean; aspectRatio: AspectRatio; targetDurationSec?: number } | { kind: "final"; compositionId: string; version: number };
export type RunFailure = { step: StepKey; message: string; jobId?: string; retry: boolean };

export interface RunView {
  campaignId: string;
  step: StepKey | "done";
  pct: number;
  detail?: string;
  working: boolean;
  next: NextStep | null;
  failure: RunFailure | null;
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
  jobs: JobLike[];
  finals: FinalLike[];
  footageBusy?: boolean;
  now: number;
}

export const RUN_STALE_MS = 24 * 3_600_000;

const isActive = (j: Pick<Job, "status"> | null | undefined) => Boolean(j && (j.status === "queued" || j.status === "running"));
const newest = <T extends { createdAt: string }>(xs: T[]) => [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
const jobPct = (j: JobLike | undefined) => (j && isActive(j) ? Math.max(0, Math.min(100, j.progress?.pct ?? 0)) / 100 : 0);
const within = (step: StepKey, frac: number) => Math.round(STEP_START[step] + (STEP_END[step] - STEP_START[step]) * Math.max(0, Math.min(1, frac)));
const failText = (j: JobLike, fallback: string) => j.error?.userMessage ?? j.error?.message ?? fallback;
const detailOf = (j: JobLike | undefined) => {
  if (!j || !isActive(j)) return undefined;
  const stage = j.progress?.stage;
  return stage && !["queued", "running", "starting", "done"].includes(stage) ? stage : undefined;
};

export function finalFor(finals: FinalLike[], compositionId: string): FinalLike | undefined {
  return finals.find((a) => a.render?.compositionId === compositionId && a.render.quality === "final" && a.status === "ready" && (a.kind ?? "video") === "video");
}

export function runView(input: RunInput): RunView {
  const { campaign, variants, jobs } = input;
  const settings = runSettings(campaign);
  const mine = (type: string, match: (p: Record<string, unknown>) => boolean) => newest(jobs.filter((j) => j.type === type && match(j.payload)));
  const childOf = (parent: JobLike | undefined, type: string) => (parent ? newest(jobs.filter((j) => j.parentJobId === parent.id && j.type === type)) : undefined);
  const old = input.now - Date.parse(campaign.createdAt) > RUN_STALE_MS;
  const base: Pick<RunView, "campaignId" | "ideaCount" | "stale" | "failure" | "next" | "working"> = { campaignId: campaign.id, ideaCount: variants.length, stale: false, failure: null, next: null, working: false };

  const done = (step: StepKey | "done", rest: Partial<RunView>): RunView => {
    const view: RunView = { ...base, step, pct: step === "done" ? 100 : STEP_START[step], ...rest };
    if (step !== "done" && !view.working && old) return { ...view, next: null, stale: !view.failure };
    return view;
  };

  const concepts = mine("campaign.generate_concepts", (p) => p.campaignId === campaign.id);
  const chosen = pickVariant(variants, settings.kind);
  if (!chosen) {
    if (isActive(concepts)) return done("idea", { working: true, pct: within("idea", jobPct(concepts)), detail: detailOf(concepts) });
    if (concepts?.status === "failed") return done("idea", { failure: { step: "idea", message: failText(concepts, "Muse couldn’t write the idea."), jobId: concepts.id, retry: true } });
    if (concepts?.status === "cancelled") return done("idea", { failure: { step: "idea", message: "Writing the idea was stopped.", jobId: concepts.id, retry: true } });
    if (variants.length) return done("idea", { failure: { step: "idea", message: "Every idea was set aside.", retry: false } });
    if (campaign.status !== "planning") return done("idea", { failure: { step: "idea", message: "Muse didn’t come up with an idea this time.", retry: false } });
    return done("idea", { working: !old });
  }
  const idea = { variantId: chosen.id, ideaTitle: chosen.title };

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

  const final = finalFor(input.finals, comp.id);
  if (final) return done("done", { ...made, finalAssetId: final.id });

  const finalJob = mine("render.final", (p) => p.compositionId === comp.id);
  if (isActive(finalJob)) return done("finish", { ...made, working: true, pct: within("finish", jobPct(finalJob)), detail: detailOf(finalJob) });
  if (finalJob?.status === "succeeded") {
    const assetId = (finalJob.output?.data as { assetId?: string } | undefined)?.assetId ?? (comp.lastRender?.quality === "final" ? comp.lastRender.assetId : undefined);
    return done("done", { ...made, finalAssetId: assetId });
  }
  if (finalJob && (finalJob.status === "failed" || finalJob.status === "cancelled")) {
    return done("finish", { ...made, failure: { step: "finish", message: finalJob.status === "cancelled" ? "The final video was stopped." : failText(finalJob, "The final video didn’t finish."), jobId: finalJob.id, retry: true } });
  }

  const preview = mine("render.preview", (p) => p.compositionId === comp.id);
  if (isActive(preview)) return done("make", { ...made, working: true, pct: within("make", 0.75 + 0.25 * jobPct(preview)), detail: detailOf(preview) });
  const previewed = Boolean(preview) || Boolean(comp.lastRender) || comp.status === "rendered" || comp.status === "approved" || comp.status === "failed";
  if (!previewed && !old) return done("make", { ...made, working: true, pct: within("make", 0.75) });

  return done("check", { ...made, next: { kind: "final", compositionId: comp.id, version: comp.currentVersion } });
}

export function stepState(view: Pick<RunView, "step" | "failure">, step: StepKey): "done" | "current" | "failed" | "todo" {
  if (view.step === "done") return "done";
  const at = STEPS.indexOf(view.step);
  const i = STEPS.indexOf(step);
  if (i < at) return "done";
  if (i > at) return "todo";
  return view.failure ? "failed" : "current";
}

// ---------------------------------------------------------------------------
// What the phone shows for a run
// ---------------------------------------------------------------------------

/**
 * One run card, from the server's read model (GET /apps/:appId/create-runs, the server takes every
 * step) or, on an API that predates it, from stored records (runView above). The phone never takes a
 * run's steps itself; it only answers the decisions the server stops at.
 */
export interface RunDisplay {
  campaignId: string;
  title: string;
  stage: StepKey | "done";
  status: CreateRunStatus;
  pct: number;
  line: string;
  videoAssetId?: string;
  /** What it makes, in plain words ("video", "carousel", "post", "thumbnail", "store screenshots", "text post"). */
  noun: string;
  /** Finished stills: slide images in order (first = cover). */
  stillAssetIds?: string[];
  /** Finished text post: the text and where it goes. */
  text?: { text: string; channel: Channel; ok: boolean };
  /** What the phone can do about it (only actions the server offers; Brand-check overrides stay on the web). */
  action: { kind: "retry" | "approve_spend"; label: string; stepKey?: string } | null;
}

const OUTPUT_NOUN: Record<string, string> = { video: "video", post: "post", carousel: "carousel", thumbnail: "thumbnail", store_screenshots: "store screenshots", text_post: "text post" };

/** "carousel" for a carousel run; "video" for runs started before stills (no `output`). */
export function outputNoun(output: string | null | undefined): string {
  return OUTPUT_NOUN[output ?? "video"] ?? "video";
}

/** Step names for what the run makes ("Planning the slides", "Writing the post"). */
export function stepLabelFor(step: StepKey, output: string | null | undefined): string {
  const o = output ?? "video";
  if (o === "video") return STEP_LABEL[step];
  if (o === "text_post") return ({ idea: "Writing the idea", plan: "Writing the post", make: "Writing the post", check: "Checking facts", finish: "Finishing" } as Record<StepKey, string>)[step];
  return ({ idea: "Writing the idea", plan: o === "thumbnail" || o === "post" ? "Planning the image" : "Planning the slides", make: "Making it", check: "Checking facts and brand", finish: "Finishing" } as Record<StepKey, string>)[step];
}

export function displayFromServer(v: CreateRunView): RunDisplay {
  const noun = outputNoun(v.format.output);
  const title = v.ideaTitle || firstSentence(v.request, 90) || v.name || `Your ${noun}`;
  const stage = v.stage;
  const slides = v.stills?.assetIds.length ?? 0;
  let line: string;
  if (v.status === "done") line = slides > 1 ? `Your ${noun} is ready · ${slides} slides` : noun === "store screenshots" ? "Your store screenshots are ready" : `Your ${noun} is ready`;
  else if (v.status === "needs_you") line = v.decision?.message ?? `This ${noun} needs a decision.`;
  else if (v.status === "failed") line = v.failure?.message ?? "A step didn’t finish.";
  else if (v.status === "waiting") line = v.wait?.reason ?? "Waiting a moment, then it carries on by itself.";
  else if (v.status === "stopped") line = "Stopped. Continue it whenever you like.";
  else line = stage === "done" ? "Finishing up" : `${stepLabelFor(stage, v.format.output)}${v.detail ? ` · ${v.detail}` : ""}`;
  let action: RunDisplay["action"] = null;
  if (v.decision?.kind === "spend" && v.actions.includes("approve_spend")) action = { kind: "approve_spend", label: `Finish it · ${v.decision.credits ?? "?"} credits`, stepKey: v.decision.stepKey };
  else if (v.decision?.kind === "brand") action = null;
  else if ((v.status === "failed" || v.status === "needs_you" || v.status === "stopped") && v.actions.includes("retry")) action = { kind: "retry", label: v.status === "stopped" || v.decision?.kind === "resume" ? "Continue" : "Try again" };
  return {
    campaignId: v.campaignId,
    title,
    stage,
    status: v.status,
    pct: v.pct,
    line,
    videoAssetId: v.video?.assetId,
    noun,
    stillAssetIds: v.stills?.assetIds.length ? v.stills.assetIds : undefined,
    text: v.text ? { text: v.text.text, channel: v.text.channel, ok: v.text.ok } : undefined,
    action,
  };
}

export function displayFromRecords(campaign: Pick<Campaign, "id" | "request" | "name">, view: RunView): RunDisplay {
  const status: CreateRunStatus = view.step === "done" ? "done" : view.failure ? "failed" : view.stale ? "stopped" : "working";
  return {
    campaignId: campaign.id,
    title: view.ideaTitle || firstSentence(campaign.request, 90) || campaign.name || "Your video",
    stage: view.step,
    status,
    pct: view.pct,
    line: runLine(view),
    videoAssetId: view.finalAssetId,
    noun: "video",
    action: null,
  };
}

/** The five steps' states for a card. */
export function stepStateOf(d: Pick<RunDisplay, "stage" | "status">, step: StepKey): "done" | "current" | "failed" | "todo" {
  if (d.stage === "done" || d.status === "done") return "done";
  const at = STEPS.indexOf(d.stage);
  const i = STEPS.indexOf(step);
  if (i < at) return "done";
  if (i > at) return "todo";
  return d.status === "failed" || d.status === "needs_you" ? "failed" : "current";
}

/**
 * The run's one line on the phone (stored-records view). When the next step waits with nothing
 * running, MuseLaunch picks it up on the server, or the person continues on the web.
 */
export function runLine(view: RunView): string {
  if (view.step === "done") return "Your video is ready";
  if (view.failure) return view.failure.message;
  if (view.stale) return "Left for over a day, so it didn’t carry on by itself. Continue it on the web.";
  const step = STEP_LABEL[view.step];
  if (view.working) return `${step}${view.detail ? ` · ${view.detail}` : ""}`;
  return view.detail ?? `Up next: ${step.toLowerCase()}`;
}
