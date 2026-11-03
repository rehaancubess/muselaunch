/**
 * Create ("What would you like to make?"): the plain-TS choices behind the page. No React and no
 * "@/" imports here (unit-tested in plan.test.ts).
 *
 *  - The three starting points (Promote my app / Show a feature / Use a suggested idea), the prompt
 *    each one suggests, and the deep-link query (?kind=&prompt=&idea=&make=).
 *  - "Make a…": Video · Post · Carousel · More (Thumbnail, App Store / Google Play screenshots, Text
 *    post), and the choice each one needs: a video's format (Instagram Reel, TikTok, YouTube Short =
 *    9:16; Square video = 1:1; YouTube video = 16:9) and length (15–60 s, clamped to the plan's
 *    maxVideoSec); where a post or carousel goes, its shape (4:5 or 1:1) and slide count; which store.
 *  - The request "Generate …" sends: an existing campaign request (POST /apps/:appId/campaigns) for
 *    ONE piece, marked origin "create", with what to make in its one deliverable.
 *  - Where a Create run stands is the SERVER's read model (GET /apps/:appId/create-runs, contracts
 *    CreateRunView): the server takes every step and records any decision it needs from the person
 *    (packages/autopilot/src/create-runner.ts). Here only the plain step list for showing it.
 */
import {
  TEXT_POST_CHANNELS,
  TEXT_POST_LIMITS,
  clampSlides,
  slideLimits,
  stillAspect,
  type AspectRatio,
  type CampaignGoal,
  type Channel,
  type CreateRunStage,
  type CreateRunView,
  type Deliverable,
  type DeliverableKind,
  type MediaAsset,
  type OutputFormat,
  type StoreTarget,
} from "@muselaunch/contracts";

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

/**
 * What other pages may prefill (routes.app().create({ kind, prompt, ideaId, make, store })); `runId`
 * (?run=) opens one run (Needs you → Open it); `make` (?make=carousel, ?make=store_screenshots&store=android)
 * picks what to make.
 */
export interface CreatePrefill {
  kind: CreateKind | null;
  prompt: string;
  ideaId: string | null;
  runId: string | null;
  make: MakeFormat | null;
  store: StoreTarget | null;
}

export function readPrefill(get: (k: string) => string | null): CreatePrefill {
  const raw = get("kind");
  const ideaId = squash(get("idea")).slice(0, 128) || null;
  const kind = isCreateKind(raw) ? raw : ideaId ? "idea" : null;
  const runId = /^[A-Za-z0-9_-]{1,128}$/.test(get("run") ?? "") ? get("run") : null;
  const m = readMake(get("make"));
  const st = get("store");
  const store = st === "ios" || st === "android" ? st : m.store;
  return { kind, prompt: (get("prompt") ?? "").trim().slice(0, MAX_PROMPT), ideaId: kind === "idea" ? ideaId : null, runId, make: m.make, store: m.make === "store_screenshots" ? (store ?? "ios") : null };
}

// ---------------------------------------------------------------------------
// What to make ("Make a…")
// ---------------------------------------------------------------------------

/** A Create run makes one of these: a video, a still format (stills.ts) or a text post. */
export type MakeFormat = OutputFormat | "text_post";
export const MAKE_FORMATS: MakeFormat[] = ["video", "post", "carousel", "thumbnail", "store_screenshots", "text_post"];
export const isMakeFormat = (v: string | null | undefined): v is MakeFormat => MAKE_FORMATS.includes(v as MakeFormat);

/** ?make= values, with the store spelled out for links ("app_store_screenshots", "google_play_screenshots"). */
export function readMake(raw: string | null | undefined): { make: MakeFormat | null; store: StoreTarget | null } {
  const v = squash(raw).toLowerCase().replace(/-/g, "_");
  if (v === "app_store" || v === "app_store_screenshots" || v === "ios_screenshots") return { make: "store_screenshots", store: "ios" };
  if (v === "google_play" || v === "google_play_screenshots" || v === "play_screenshots" || v === "android_screenshots") return { make: "store_screenshots", store: "android" };
  if (v === "text") return { make: "text_post", store: null };
  return isMakeFormat(v) ? { make: v, store: null } : { make: null, store: null };
}

/** The three big choices; everything else is under More. */
export const MAIN_MAKES = ["video", "post", "carousel"] as const satisfies readonly MakeFormat[];
export const MORE_MAKES: { make: MakeFormat; store?: StoreTarget; label: string; hint: string }[] = [
  { make: "thumbnail", label: "Thumbnail", hint: "YouTube" },
  { make: "store_screenshots", store: "ios", label: "App Store screenshots", hint: "iPhone" },
  { make: "store_screenshots", store: "android", label: "Google Play screenshots", hint: "Android" },
  { make: "text_post", label: "Text post", hint: "No images" },
];

/** "Carousel", "App Store screenshots": what the chosen thing is called on the page. */
export function makeLabel(make: MakeFormat, store?: StoreTarget | null): string {
  switch (make) {
    case "video":
      return "Video";
    case "post":
      return "Post";
    case "carousel":
      return "Carousel";
    case "thumbnail":
      return "Thumbnail";
    case "store_screenshots":
      return store === "android" ? "Google Play screenshots" : "App Store screenshots";
    case "text_post":
      return "Text post";
  }
}

/** The word in sentences ("Making your carousel", "Your screenshots are ready"). */
export function makeNoun(make: MakeFormat | null | undefined): { noun: string; plural: boolean } {
  switch (make ?? "video") {
    case "store_screenshots":
      return { noun: "screenshots", plural: true };
    case "text_post":
    case "post":
      return { noun: "post", plural: false };
    case "carousel":
      return { noun: "carousel", plural: false };
    case "thumbnail":
      return { noun: "thumbnail", plural: false };
    default:
      return { noun: "video", plural: false };
  }
}

/** "Generate carousel" (the button says what it makes). */
export function generateLabel(make: MakeFormat): string {
  return make === "text_post" ? "Generate post" : make === "store_screenshots" ? "Generate screenshots" : `Generate ${makeNoun(make).noun}`;
}

/** The make's shape for slides: a carousel or a store set has several; a post or a thumbnail one. */
export const isSlideSet = (make: MakeFormat | null | undefined) => make === "carousel" || make === "store_screenshots";
export const isStillMake = (make: MakeFormat | null | undefined) => !!make && make !== "video" && make !== "text_post";

/** Where a single-image post can go (feed images), where a carousel can go, where a text post can go. */
export const POST_CHANNELS = ["instagram", "facebook", "linkedin", "x", "threads"] as const satisfies readonly Channel[];
export const CAROUSEL_CHANNELS = ["instagram", "linkedin", "facebook", "threads"] as const satisfies readonly Channel[];
export { TEXT_POST_CHANNELS, TEXT_POST_LIMITS };

export function channelsFor(make: MakeFormat): readonly Channel[] {
  return make === "post" ? POST_CHANNELS : make === "carousel" ? CAROUSEL_CHANNELS : make === "text_post" ? TEXT_POST_CHANNELS : make === "thumbnail" ? ["youtube"] : [];
}

/** The first place the person said they post that fits, else the first the format can go. */
export function defaultWhere(make: MakeFormat, postTo: readonly string[] | null | undefined): Channel {
  const ok = channelsFor(make);
  return (postTo ?? []).find((c): c is Channel => ok.includes(c as Channel)) ?? ok[0] ?? "instagram";
}

export type Shape = "4:5" | "1:1";
export const SHAPES: { value: Shape; label: string }[] = [
  { value: "4:5", label: "Portrait 4:5" },
  { value: "1:1", label: "Square 1:1" },
];

/** Slide counts the format allows (carousel 3–10; App Store 3–10; Google Play 3–8). */
export function slideOptions(make: MakeFormat, store?: StoreTarget | null): number[] {
  if (!isSlideSet(make)) return [];
  const l = slideLimits(make as OutputFormat, store);
  return Array.from({ length: l.max - l.min + 1 }, (_, i) => l.min + i);
}

/** The store's frame in pixels (a fixed size each store accepts). */
export const STORE_FRAME: Record<StoreTarget, { width: number; height: number; label: string }> = {
  ios: { width: 1290, height: 2796, label: "App Store" },
  android: { width: 1080, height: 1920, label: "Google Play" },
};

/**
 * Store slides only show real screens: when the app has fewer real screenshots than slides, some
 * slides repeat a screen. Plain words for that, or null when there are enough.
 */
export function screensHint(realScreens: number, slides: number): string | null {
  if (realScreens >= slides) return null;
  if (realScreens === 0) return "There are no real screenshots of your app yet. Store slides only show real screens, so add a few first.";
  return `You have ${realScreens} real screenshot${realScreens === 1 ? "" : "s"}, so some of the ${slides} slides will show the same screen. Store slides only show real screens; add more for variety.`;
}

// ---------------------------------------------------------------------------
// Video format and length
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
  // id kept for old links; it is a 1:1 video (a "post" is a still now).
  { id: "square_post", label: "Square video", channel: "instagram", aspectRatio: "1:1" },
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
// The request "Generate …" sends
// ---------------------------------------------------------------------------

const GOAL: Record<CreateKind, CampaignGoal> = { promote: "awareness", feature: "feature_announcement", idea: "awareness" };
const DELIVERABLE: Record<CreateKind, DeliverableKind> = { promote: "short_video", feature: "feature_promo", idea: "short_video" };
/** Each still format's deliverable kind (stills.ts formatOfDeliverable maps them back). */
const STILL_DELIVERABLE: Record<Exclude<MakeFormat, "video">, DeliverableKind> = { post: "static_ad", carousel: "carousel", thumbnail: "thumbnail", store_screenshots: "store_screenshots", text_post: "text_post" };
const STORE_CHANNEL: Record<StoreTarget, Channel> = { ios: "app_store", android: "google_play" };

export interface GenerateInput {
  kind: CreateKind;
  prompt: string;
  /** What to make (absent = a video, as before stills). */
  make?: MakeFormat;
  /** Video: the format and length. */
  format: VideoFormat;
  lengthSec: number;
  /** Post, carousel, text post: where it goes. */
  channel?: Channel;
  /** Post, carousel: the frame. */
  shape?: Shape;
  /** Carousel, store set: how many slides (clamped to what the format allows). */
  slides?: number;
  store?: StoreTarget;
  ideaId?: string | null;
}

/** The one deliverable Create asks for (the API's Deliverable; text posts have no frame). */
export type CreateDeliverable = Pick<Deliverable, "kind" | "count"> & Partial<Pick<Deliverable, "channel" | "aspectRatio" | "durationSec" | "slides" | "store">>;

export function deliverableFor(input: Omit<GenerateInput, "prompt" | "ideaId">): CreateDeliverable {
  const make = input.make ?? "video";
  if (make === "video") return { kind: DELIVERABLE[input.kind], channel: input.format.channel, aspectRatio: input.format.aspectRatio, durationSec: input.lengthSec, count: 1 };
  const kind = STILL_DELIVERABLE[make];
  switch (make) {
    case "post":
      return { kind, channel: input.channel ?? "instagram", aspectRatio: stillAspect("post", input.shape), count: 1 };
    case "carousel":
      return { kind, channel: input.channel ?? "instagram", aspectRatio: stillAspect("carousel", input.shape), slides: clampSlides("carousel", input.slides), count: 1 };
    case "thumbnail":
      return { kind, channel: "youtube", aspectRatio: stillAspect("thumbnail", null), count: 1 };
    case "store_screenshots": {
      const store = input.store ?? "ios";
      return { kind, channel: STORE_CHANNEL[store], aspectRatio: stillAspect("store_screenshots", null, store), slides: clampSlides("store_screenshots", input.slides, store), store, count: 1 };
    }
    case "text_post":
      return { kind, channel: TEXT_POST_CHANNELS.includes(input.channel as never) ? input.channel : "x", count: 1 };
  }
}

/** Body of POST /apps/:appId/campaigns for one piece (the API's CreateCampaignRequest). */
export function campaignRequest(input: GenerateInput) {
  const deliverable = deliverableFor(input);
  return {
    request: input.prompt.trim().slice(0, MAX_PROMPT),
    goal: GOAL[input.kind],
    channels: [deliverable.channel ?? input.format.channel],
    deliverables: [deliverable],
    opportunityIds: input.kind === "idea" && input.ideaId ? [input.ideaId] : [],
    // The fewest ideas Muse writes; Create uses the one that fits best and keeps the others.
    conceptCount: 3,
    origin: "create" as const,
  };
}

export interface EstimateStep {
  key: string;
  label: string;
  operation: string;
  params: Record<string, unknown>;
  /**
   * What the job holds when the server reserves a fixed amount instead of pricing `operation` +
   * `params` (the final render of stills: one credit per started 4 slides, the same formula as
   * POST /compositions/:id/render and the Create runner). The page shows this amount as is; when
   * POST /estimate can price the step itself, drop `amount` and the page asks the server.
   */
  amount?: number;
}

/** Credits the final render of stills holds (apps/api compositions render route, packages/render saveStills). */
export const stillFinalCredits = (slides: number) => Math.max(1, Math.ceil(slides / 4));

/**
 * The estimates "Generate …" adds up (POST /estimate per step, the operations the jobs reserve):
 *  - video: the idea, the plan (by length), the editable video, AI voice when on, the final render (by length);
 *  - stills: the idea, the plan (by slides), the editable slides, the final images (by slides);
 *  - text post: the idea, then Muse writes the post (copy.generate, checked against the app's facts).
 */
export function estimateSteps(lengthSec: number, opts: { aiVoice?: boolean; make?: MakeFormat; slides?: number; store?: StoreTarget | null } = {}): EstimateStep[] {
  const make = opts.make ?? "video";
  const idea: EstimateStep = { key: "idea", label: "Writing the idea (Muse Spark)", operation: "campaign.generate_concepts", params: {} };
  if (make === "text_post") return [idea, { key: "write", label: "Writing the post and checking its facts (Muse Spark)", operation: "copy.generate", params: {} }];
  if (make !== "video") {
    const slides = clampSlides(make, opts.slides, opts.store);
    const many = isSlideSet(make);
    return [
      idea,
      { key: "plan", label: many ? `Planning ${slides} slides (Muse Spark)` : "Planning the image (Muse Spark)", operation: "storyboard.generate", params: { format: make, slides, ...(make === "store_screenshots" ? { store: opts.store ?? "ios" } : {}) } },
      { key: "make", label: many ? "Making the editable slides" : "Making the editable image", operation: "composition.build", params: {} },
      { key: "finish", label: many ? `Final images (${slides} slides)` : "Final image", operation: "render.final", params: { format: make, slides }, amount: stillFinalCredits(slides) },
    ];
  }
  return [
    idea,
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

/** What a run makes (runs started before stills have no `output`: a video). */
export const runMake = (run: Pick<CreateRunView, "format"> | null | undefined): MakeFormat => run?.format.output ?? "video";

/**
 * The steps a run shows, in plain words for what it makes. A text post has three (the idea, the
 * post, the facts); stills and videos have five.
 */
export function stepsFor(make: MakeFormat): { key: StepKey; label: string }[] {
  if (make === "text_post")
    return [
      { key: "idea", label: "Writing the idea" },
      { key: "plan", label: "Writing the post" },
      { key: "check", label: "Checking facts" },
    ];
  if (make === "video") return STEPS.map((key) => ({ key, label: STEP_LABEL[key] }));
  const many = isSlideSet(make);
  return [
    { key: "idea", label: "Writing the idea" },
    { key: "plan", label: many ? "Planning the slides" : "Planning the image" },
    { key: "make", label: `Making the ${makeNoun(make).noun}` },
    { key: "check", label: "Checking facts and brand" },
    { key: "finish", label: "Finishing" },
  ];
}

/** The label of the step a run is at, in its own words ("Making the carousel"). */
export function stageLabel(make: MakeFormat, stage: CreateRunStage): string {
  const steps = stepsFor(make);
  const at = shownStage(steps, stage);
  return steps.find((s) => s.key === at)?.label ?? STEP_LABEL[stage as StepKey] ?? "A step";
}

/** The shown step a stage belongs to (a text post shows no make/finish: those count as its nearest earlier step). */
function shownStage(steps: { key: StepKey }[], stage: CreateRunStage): StepKey | "done" {
  if (stage === "done") return "done";
  const at = STEPS.indexOf(stage);
  let out: StepKey = steps[0]!.key;
  for (const s of steps) if (STEPS.indexOf(s.key) <= at) out = s.key;
  return out;
}

/** A step of the list: before, the current one (or where it failed), after. `steps`: the run's shown steps (default all five). */
export function stepState(run: Pick<CreateRunView, "stage" | "status">, step: StepKey, steps: { key: StepKey }[] = STEPS.map((key) => ({ key }))): "done" | "current" | "failed" | "todo" {
  if (run.stage === "done" || run.status === "done") return "done";
  const cur = shownStage(steps, run.stage);
  const at = STEPS.indexOf(cur as StepKey);
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

/** One finished set of stills (a post, a carousel, a thumbnail or a store set): its final images in order. */
export interface FinishedStills {
  compositionId: string;
  /** Slide 1 first (the cover). */
  assetIds: string[];
  campaignId?: string;
  title: string;
  width?: number;
  height?: number;
  version?: number;
  renderedAt: string;
}

/** Slide number of a still render (label `slide:<n>`; else the `_<n>` suffix of `ast_r_<key>_<n>`; slide 1 has none). */
function slideNo(a: { id: string; labels?: string[] }): number {
  const l = (a.labels ?? []).find((x) => x.startsWith("slide:"));
  const n = l ? Number(l.slice(6)) : NaN;
  if (Number.isFinite(n) && n >= 1) return n;
  const m = /^ast_r_[0-9a-f]+_(\d{1,2})$/.exec(a.id);
  return m ? Number(m[1]) : 1;
}

type StillAsset = RenderAsset & { labels?: string[] };

/**
 * Newest finished stills per composition, newest first: a final render of a still doc is one image
 * per slide (render worker: `ast_r_<key>` for slide 1, `ast_r_<key>_<n>` for slide n, label
 * `slide:<n>`). Slides are grouped by composition and version (the newest image per slide number);
 * a newer version replaces the older; a set without its slide 1 is skipped.
 */
export function finishedStills(assets: StillAsset[], titles: Map<string, string> | Record<string, string> = {}, max = 12): FinishedStills[] {
  const name = (id: string) => (titles instanceof Map ? titles.get(id) : titles[id]);
  const sets = new Map<string, Map<number, StillAsset>>();
  for (const a of [...assets].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
    if (a.kind !== "image" || a.role !== "render" || a.render?.quality !== "final" || a.status !== "ready" || !a.render.compositionId) continue;
    const key = `${a.render.compositionId}\u0000${a.render.version}`;
    const set = sets.get(key) ?? new Map<number, StillAsset>();
    const n = slideNo(a);
    if (!set.has(n)) set.set(n, a);
    sets.set(key, set);
  }
  const ordered = [...sets.values()]
    .filter((x) => x.has(1))
    .sort((x, y) => (y.get(1)!.render!.version - x.get(1)!.render!.version) || y.get(1)!.createdAt.localeCompare(x.get(1)!.createdAt));
  const seen = new Set<string>();
  const out: FinishedStills[] = [];
  for (const slides of ordered) {
    const first = slides.get(1)!;
    const cid = first.render!.compositionId;
    if (seen.has(cid)) continue;
    seen.add(cid);
    const ids: string[] = [];
    for (let n = 1; slides.has(n); n++) ids.push(slides.get(n)!.id);
    out.push({
      compositionId: cid,
      assetIds: ids,
      campaignId: first.campaignId,
      title: name(cid) ?? (first.title ?? "Post").replace(/\s+—\s+slide\s+\d+$/, "").replace(/\s+—\s+v\d+\s+final$/, ""),
      width: first.width,
      height: first.height,
      version: first.render?.version,
      renderedAt: first.createdAt,
    });
  }
  return out.sort((a, b) => b.renderedAt.localeCompare(a.renderedAt)).slice(0, max);
}

/** A finished text post (from its Create run: nothing is rendered). */
export interface FinishedText {
  campaignId: string;
  copyPackId: string;
  channel: Channel;
  text: string;
  ok: boolean;
  title: string;
  at: string;
}

/** Everything in "Your content", one list. */
export type ContentItem = ({ type: "video" } & FinishedVideo) | ({ type: "stills" } & FinishedStills) | ({ type: "text" } & FinishedText);

export const contentKey = (c: ContentItem) => (c.type === "text" ? `text:${c.campaignId}` : `${c.type}:${c.compositionId}`);
const contentAt = (c: ContentItem) => (c.type === "text" ? c.at : c.renderedAt);

/** Finished text posts of the runs (done, with the post Muse wrote). */
export function finishedTexts(runs: Pick<CreateRunView, "campaignId" | "status" | "text" | "ideaTitle" | "name" | "createdAt">[]): FinishedText[] {
  return runs.flatMap((r) => (r.status === "done" && r.text ? [{ campaignId: r.campaignId, copyPackId: r.text.copyPackId, channel: r.text.channel, text: r.text.text, ok: r.text.ok, title: r.ideaTitle ?? r.name, at: r.createdAt }] : []));
}

/** Videos, stills and text posts, newest first, capped. */
export function finishedContent(parts: { videos?: FinishedVideo[]; stills?: FinishedStills[]; texts?: FinishedText[] }, max = 12): ContentItem[] {
  const all: ContentItem[] = [...(parts.videos ?? []).map((v) => ({ type: "video" as const, ...v })), ...(parts.stills ?? []).map((v) => ({ type: "stills" as const, ...v })), ...(parts.texts ?? []).map((v) => ({ type: "text" as const, ...v }))];
  return all.sort((a, b) => contentAt(b).localeCompare(contentAt(a))).slice(0, max);
}

/** "Carousel · 6" for a tile: what a set of stills is, from its frame and slide count. */
export function stillsBadge(s: Pick<FinishedStills, "assetIds" | "width" | "height">): string {
  const n = s.assetIds.length;
  const store = s.width && s.height && ((s.width === 1290 && s.height === 2796) || (s.width === 1080 && s.height === 1920));
  if (n > 1) return store ? `Screenshots · ${n}` : `Carousel · ${n}`;
  return s.width && s.height && s.width > s.height ? "Thumbnail" : "Post";
}

/** Tailwind aspect class for a frame (every shape MuseLaunch makes). */
export function aspectClass(ar: AspectRatio | string | null | undefined): string {
  switch (ar) {
    case "16:9":
      return "aspect-video";
    case "1:1":
      return "aspect-square";
    case "4:5":
      return "aspect-[4/5]";
    case "9:19.5":
      return "aspect-[1290/2796]";
    default:
      return "aspect-[9/16]";
  }
}

/** The frame of a width × height ("4:5"), for picking the aspect class of a finished still. */
export function aspectOf(width?: number, height?: number): AspectRatio | null {
  if (!width || !height) return null;
  const r = width / height;
  const near = (x: number) => Math.abs(r - x) < 0.02;
  if (near(16 / 9)) return "16:9";
  if (near(1)) return "1:1";
  if (near(4 / 5)) return "4:5";
  if (near(1290 / 2796)) return "9:19.5";
  if (near(9 / 16)) return "9:16";
  return null;
}

/** Where Muse's copy puts the app's link until the post's tracked link fills it (contracts APP_LINK_TOKEN). */
export const LINK_TOKEN = "[APP_LINK]";
/** Characters a tracked link takes outside X (https://<host>/r/<slug>, about 30). */
const LINK_CHARS = 30;

/** Characters a text post uses vs its channel's limit (X counts links as 23, like the server; the link token counts as a link). */
export function textCount(text: string, channel: Channel): { used: number; limit: number | null; over: boolean } {
  const limit = (TEXT_POST_LIMITS as Partial<Record<Channel, number>>)[channel] ?? null;
  let used = 0;
  const links = text.split(LINK_TOKEN).length - 1;
  text = text.split(LINK_TOKEN).join("");
  used += links * (channel === "x" ? 23 : LINK_CHARS);
  if (channel === "x") {
    const rest = text.replace(/https?:\/\/\S+/g, () => {
      used += 23;
      return "";
    });
    for (const ch of rest) {
      const cp = ch.codePointAt(0)!;
      used += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
    }
  } else used += [...text].length;
  return { used, limit, over: limit !== null && used > limit };
}

/** Where a person posts a finished video by default: the channel its format was made for. */
export function channelFor(run: Pick<CreateRunView, "format"> | null | undefined): Channel | undefined {
  return run?.format.channel;
}
