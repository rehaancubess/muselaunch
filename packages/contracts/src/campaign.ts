import { z } from "zod";
import { AspectRatio, BaseEntity, Channel, Id, IsoDateTime, Locale, RegionPath } from "./common";
import { TEMPLATE_IDS } from "./composition";
import { CreateRunState } from "./create-run";
import { MusicMood } from "./sound";

export const CampaignGoal = z.enum([
  "awareness",
  "launch",
  "installs",
  "subscriptions",
  "feature_announcement",
  "engagement",
  "retention",
  "community",
  "other",
]);
export type CampaignGoal = z.infer<typeof CampaignGoal>;

export const CampaignStatus = z.enum([
  "planning",
  "concepts_ready",
  "producing",
  "review",
  "approved",
  "scheduled",
  "live",
  "completed",
  "archived",
]);

export const DeliverableKind = z.enum([
  "short_video",
  "app_demo",
  "feature_promo",
  "launch_announcement",
  "app_trailer",
  "screenshot_graphic",
  "carousel",
  "static_ad",
  "thumbnail",
  "product_hunt_assets",
  "caption_pack",
  "outreach_pack",
]);
export type DeliverableKind = z.infer<typeof DeliverableKind>;

export const Deliverable = z.object({
  kind: DeliverableKind,
  channel: Channel.optional(),
  aspectRatio: AspectRatio.default("9:16"),
  durationSec: z.number().positive().max(180).optional(),
  count: z.number().int().min(1).max(10).default(1),
});
export type Deliverable = z.infer<typeof Deliverable>;

/** Where a campaign was started when that changes how it's made (see `Campaign.origin`). */
export const CampaignOrigin = z.enum(["create"]);
export type CampaignOrigin = z.infer<typeof CampaignOrigin>;

export const Campaign = BaseEntity.extend({
  appId: Id,
  name: z.string().min(1).max(160),
  goal: CampaignGoal,
  status: CampaignStatus.default("planning"),
  /** The user's original request, verbatim. */
  request: z.string().max(4000).optional(),
  channels: z.array(Channel).default([]),
  briefId: Id.optional(),
  selectedVariantIds: z.array(Id).default([]),
  opportunityIds: z.array(Id).default([]),
  /** Deliverables the user asked for (copied into the brief by concept generation). */
  deliverables: z.array(Deliverable).default([]),
  experimentId: Id.optional(),
  creditCap: z.number().int().positive().optional(),
  strategyRunId: Id.optional(),
  coverAssetId: Id.optional(),
  /**
   * `create`: started from Create ("Generate video"): ONE video in the format and length stored in
   * `deliverables[0]`. Create moves it along the same steps a person would (the best-fitting idea →
   * plan → editable video → brand check → final render) and asks the person when a step needs them.
   * Absent: a campaign planned by hand (Make), from Discover or by Autopilot.
   */
  origin: CampaignOrigin.optional(),
  /** origin "create": what only the server's Create runner knows (its decision, waits, approvals). See create-run.ts. */
  createRun: CreateRunState.optional(),
});
export type Campaign = z.infer<typeof Campaign>;

export const SuccessMetric = z.object({
  metric: z.string().max(80),
  target: z.string().max(120).optional(),
  measurement: z.string().max(500).optional(),
});

export const CampaignBrief = BaseEntity.extend({
  appId: Id,
  campaignId: Id,
  version: z.number().int().min(1),
  goal: CampaignGoal,
  audience: z.object({
    segmentIds: z.array(Id).default([]),
    description: z.string().max(1500),
  }),
  channels: z.array(Channel).min(1),
  angle: z.string().max(1000),
  usp: z.string().max(1000),
  approvedClaimIds: z.array(Id).default([]),
  cta: z.string().max(200),
  deliverables: z.array(Deliverable).min(1),
  targetDurationsSec: z.array(z.number().positive().max(180)).default([15]),
  brandStyle: z.string().max(1000).optional(),
  visualDirection: z.string().max(1500).optional(),
  budgetCapCredits: z.number().int().positive().optional(),
  successMetric: SuccessMetric,
  locales: z.array(Locale).default(["en"]),
  status: z.enum(["draft", "approved"]).default("draft"),
});
export type CampaignBrief = z.infer<typeof CampaignBrief>;

export const AngleType = z.enum([
  "emotional_problem",
  "practical_demo",
  "founder_story",
  "comparison",
  "tutorial",
  "social_proof",
  "launch_hype",
  "behind_the_scenes",
  "other",
]);
export type AngleType = z.infer<typeof AngleType>;

export const DirectionPacing = z.enum(["punchy", "steady", "slow-burn"]);
export type DirectionPacing = z.infer<typeof DirectionPacing>;

/**
 * Muse Wonder's creative direction for one video (Growth Autopilot, `pick_variants`): how the concept
 * should look, move and sound. The storyboard writer (Muse Spark) works to it; the music mood is
 * applied as chosen. Additive and optional: concepts produced by hand have none.
 */
export const CreativeDirection = z.object({
  /** How the first seconds stop the scroll. */
  hookApproach: z.string().min(1).max(600),
  pacing: DirectionPacing,
  /** The visual idea that runs through the whole video. */
  visualMotif: z.string().min(1).max(600),
  /** Up to 3 templates the video should feature (allowlisted; object-aware ones only with presenter footage). */
  signatureShots: z.array(z.enum(TEMPLATE_IDS)).max(3).default([]),
  musicMood: MusicMood,
  /** What to stay away from in this video. */
  avoid: z.string().max(400).optional(),
  /** Why this direction suits the concept and what it tests. */
  why: z.string().max(800).default(""),
  /** The model that actually directed (e.g. muse-wonder-1.0) and its run. */
  model: z.string().max(120),
  runId: Id.optional(),
  directedAt: IsoDateTime.optional(),
});
export type CreativeDirection = z.infer<typeof CreativeDirection>;

/** A strategically distinct campaign concept (not a copy variant). */
export const CampaignVariant = BaseEntity.extend({
  appId: Id,
  campaignId: Id,
  title: z.string().min(1).max(160),
  angleType: AngleType,
  hook: z.string().max(400),
  audience: z.string().max(600),
  keyMessage: z.string().max(800),
  rationale: z.string().max(2000),
  /** Evidence: research findings / opportunities this concept builds on. */
  findingIds: z.array(Id).default([]),
  claimIds: z.array(Id).default([]),
  scriptOutline: z.array(z.string().max(400)).max(12).default([]),
  channels: z.array(Channel).default([]),
  hypothesis: z.string().max(600),
  successMetric: SuccessMetric,
  status: z.enum(["proposed", "selected", "rejected", "produced"]).default("proposed"),
  storyboardId: Id.optional(),
  compositionIds: z.array(Id).default([]),
  /** Glimmer-retrieved preference ids that influenced this concept. */
  memoryRefs: z.array(Id).default([]),
  generatedByRunId: Id.optional(),
  /** Video length chosen for this concept (seconds): the founder's choice, else Spark's pick in AUTO_VIDEO_DURATION. */
  targetDurationSec: z.number().positive().max(180).optional(),
  /** Muse Wonder's creative direction (Growth Autopilot); the storyboard follows it. */
  creativeDirection: CreativeDirection.optional(),
});
export type CampaignVariant = z.infer<typeof CampaignVariant>;

/** Videos default to 30–60 s; each concept gets its own length in this range unless the founder picks one (15 s still allowed). */
export const AUTO_VIDEO_DURATION = { min: 30, max: 60 } as const;

export const ScenePurpose = z.enum(["hook", "problem", "demo", "feature", "proof", "founder", "transition", "cta", "other"]);

export const AssetHint = z.object({
  kind: z.enum(["screenshot", "app_recording", "founder_clip", "generated_image", "stock_video", "stock_image", "logo", "none"]),
  assetId: Id.optional(),
  /** A walkthrough RecordingSegment to play (assetId is then its recording). */
  segmentId: Id.optional(),
  /** For generated/stock: the prompt or query. Generated media must never depict the app UI. */
  query: z.string().max(500).optional(),
  featureId: Id.optional(),
  /** Set by storyboard.resolve_media when no stock/generated media could be attached: why (shown in the Studio). */
  unresolved: z.string().max(300).optional(),
});

export const StoryboardScene = z.object({
  id: Id,
  order: z.number().int().nonnegative(),
  purpose: ScenePurpose,
  durationSec: z.number().positive().max(60),
  onScreenText: z.string().max(300).default(""),
  narration: z.string().max(800).default(""),
  visual: z.string().max(1000),
  /** Template from the allowlisted catalog (see compositions/TEMPLATE_IDS). */
  template: z.string().max(60),
  assets: z.array(AssetHint).max(6).default([]),
  claimIds: z.array(Id).default([]),
  /** focus-zoom / tap-demo: the region to push in on (fractions of the real screenshot / recording frame shown). */
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).optional(),
  /** What to focus on when no box was given (resolved to `focus` with SAM 3.1 on the real image). */
  focusQuery: z.string().max(120).optional(),
  /**
   * Walkthrough segments: `focus` tracked through the footage by SAM 3.1 (storyboard.resolve_media),
   * so the zoom and ring follow the element as it moves. Fractions of the recording frame; `t` =
   * seconds into the recording.
   */
  focusPath: RegionPath.optional(),
});
export type StoryboardScene = z.infer<typeof StoryboardScene>;

export const Storyboard = BaseEntity.extend({
  appId: Id,
  campaignId: Id,
  variantId: Id,
  title: z.string().max(200),
  aspectRatio: AspectRatio,
  targetDurationSec: z.number().positive().max(180),
  scenes: z.array(StoryboardScene).min(1).max(20),
  voiceover: z
    .object({ source: z.enum(["none", "founder_recording", "tts"]), assetId: Id.optional(), script: z.string().max(4000).optional() })
    .default({ source: "none" }),
  music: z.object({ mood: z.string().max(120).optional(), assetId: Id.optional() }).default({}),
  /** Headline typeface Muse Spark picked for this video (one of the bundled faces; the brand kit's own font wins). */
  typeface: z.string().max(60).optional(),
  generatedByRunId: Id.optional(),
});
export type Storyboard = z.infer<typeof Storyboard>;

export const CopyItemKind = z.enum([
  "caption",
  "title",
  "hashtags",
  "cta",
  "description",
  "thread",
  "first_comment",
  "outreach_pitch",
  "product_hunt_tagline",
  "product_hunt_description",
  "maker_comment",
]);

/**
 * What kind of problem the fact check found in a piece of copy:
 * - unsupported: a product statement no confirmed fact or listing evidence backs (the person can
 *   remove it, or confirm it as a fact);
 * - figure: a number, multiplier or superlative that isn't in the confirmed facts or listing;
 * - prohibited: something the founder asked never to say (can only be removed);
 * - limit: longer than the channel allows (not a fact problem).
 */
export const CopyIssueKind = z.enum(["unsupported", "figure", "prohibited", "limit"]);
export type CopyIssueKind = z.infer<typeof CopyIssueKind>;

export const CopyValidationIssue = z.object({
  itemId: Id,
  issue: z.string().max(500),
  kind: CopyIssueKind.optional(),
  /** The exact words in the copy that aren't backed (e.g. "racing, bowling"). */
  quote: z.string().max(300).optional(),
  /** Just the unsupported things, in plain words (e.g. ["racing", "bowling"]). */
  terms: z.array(z.string().max(80)).max(8).optional(),
  /** The product fact the copy asserts, as a sentence a founder could confirm. */
  statement: z.string().max(500).optional(),
});
export type CopyValidationIssue = z.infer<typeof CopyValidationIssue>;

export const CopyPack = BaseEntity.extend({
  appId: Id,
  campaignId: Id,
  variantId: Id.optional(),
  channel: Channel,
  locale: Locale.default("en"),
  items: z.array(z.object({ id: Id, kind: CopyItemKind, text: z.string().max(5000), claimIds: z.array(Id).default([]) })).max(40),
  /** Result of the claim validator over every item. */
  validation: z.object({ ok: z.boolean(), issues: z.array(CopyValidationIssue).default([]), checkedAt: IsoDateTime }).optional(),
  /** The pack this one rewrites (a fact-check fix: "Remove it"). */
  revisionOf: Id.optional(),
  generatedByRunId: Id.optional(),
});
export type CopyPack = z.infer<typeof CopyPack>;
