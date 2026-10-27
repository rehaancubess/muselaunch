import { z } from "zod";
import { AspectRatio, BaseEntity, Channel, Id, IsoDateTime, Locale } from "./common";

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
});
export type CampaignVariant = z.infer<typeof CampaignVariant>;

export const ScenePurpose = z.enum(["hook", "problem", "demo", "feature", "proof", "founder", "transition", "cta", "other"]);

export const AssetHint = z.object({
  kind: z.enum(["screenshot", "app_recording", "founder_clip", "generated_image", "stock_video", "stock_image", "logo", "none"]),
  assetId: Id.optional(),
  /** For generated/stock: the prompt or query. Generated media must never depict the app UI. */
  query: z.string().max(500).optional(),
  featureId: Id.optional(),
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

export const CopyPack = BaseEntity.extend({
  appId: Id,
  campaignId: Id,
  variantId: Id.optional(),
  channel: Channel,
  locale: Locale.default("en"),
  items: z.array(z.object({ id: Id, kind: CopyItemKind, text: z.string().max(5000), claimIds: z.array(Id).default([]) })).max(40),
  /** Result of the claim validator over every item. */
  validation: z
    .object({ ok: z.boolean(), issues: z.array(z.object({ itemId: Id, issue: z.string().max(500) })).default([]), checkedAt: IsoDateTime })
    .optional(),
  generatedByRunId: Id.optional(),
});
export type CopyPack = z.infer<typeof CopyPack>;
