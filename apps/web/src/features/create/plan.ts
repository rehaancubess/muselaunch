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
 *  - Where a Create run stands is the SERVER's read model (GET /apps/:appId/create-runs, contracts
 *    CreateRunView): the server takes every step and records any decision it needs from the person
 *    (packages/autopilot/src/create-runner.ts). Here only the plain step list for showing it.
 */
import type { AspectRatio, CampaignGoal, Channel, CreateRunStage, CreateRunView, Deliverable, DeliverableKind, MediaAsset } from "@muselaunch/contracts";

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

/** What other pages may prefill (routes.app().create({ kind, prompt, ideaId })); `runId` (?run=) opens one run (Needs you → Open it). */
export interface CreatePrefill {
  kind: CreateKind | null;
  prompt: string;
  ideaId: string | null;
  runId: string | null;
}

export function readPrefill(get: (k: string) => string | null): CreatePrefill {
  const raw = get("kind");
  const ideaId = squash(get("idea")).slice(0, 128) || null;
  const kind = isCreateKind(raw) ? raw : ideaId ? "idea" : null;
  const runId = /^[A-Za-z0-9_-]{1,128}$/.test(get("run") ?? "") ? get("run") : null;
  return { kind, prompt: (get("prompt") ?? "").trim().slice(0, MAX_PROMPT), ideaId: kind === "idea" ? ideaId : null, runId };
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
// Where a Create run stands (the server's read model)
// ---------------------------------------------------------------------------

export type StepKey = Exclude<CreateRunStage, "done">;
export const STEPS: StepKey[] = ["idea", "plan", "make", "check", "finish"];
export const STEP_LABEL: Record<StepKey, string> = {
  idea: "Writing the idea",
  plan: "Planning the video",
  make: "Making it",
  check: "Checking facts and brand",
  finish: "Finishing",
};

/** A step of the list: before, the current one (or where it failed), after. */
export function stepState(run: Pick<CreateRunView, "stage" | "status">, step: StepKey): "done" | "current" | "failed" | "todo" {
  if (run.stage === "done" || run.status === "done") return "done";
  const at = STEPS.indexOf(run.stage);
  const i = STEPS.indexOf(step);
  if (i < at) return "done";
  if (i > at) return "todo";
  return run.status === "failed" ? "failed" : "current";
}

/** The run waits for the person: a decision, a failed step, or it was left unfinished. */
export const needsPerson = (run: Pick<CreateRunView, "status">) => run.status === "needs_you" || run.status === "failed" || run.status === "stopped";

/** The run is still moving by itself (a job runs, or the server tries again shortly). */
export const isMoving = (run: Pick<CreateRunView, "status">) => run.status === "working" || run.status === "waiting";

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
export function channelFor(run: Pick<CreateRunView, "format"> | null | undefined): Channel | undefined {
  return run?.format.channel;
}
