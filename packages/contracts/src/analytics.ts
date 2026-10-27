import { z } from "zod";
import { BaseEntity, Channel, HttpUrl, Id, IsoDateTime, SourceRef } from "./common";

export const MetricSource = z.enum([
  "revenuecat",
  "app_store_connect",
  "google_play_console",
  "instagram",
  "facebook",
  "youtube",
  "tiktok",
  "linkedin",
  "x",
  "tracked_link",
  "csv_import",
  "manual",
]);
export type MetricSource = z.infer<typeof MetricSource>;

export const MetricName = z.enum([
  "impressions",
  "views",
  "reach",
  "watch_time_sec",
  "likes",
  "comments",
  "shares",
  "saves",
  "followers_gained",
  "profile_visits",
  "clicks",
  "store_page_views",
  "installs",
  "trials_started",
  "trial_conversions",
  "new_subscriptions",
  "active_subscriptions",
  "churned_subscriptions",
  "revenue",
  "mrr",
  "ad_spend",
  "content_cost",
]);
export type MetricName = z.infer<typeof MetricName>;

/**
 * How strongly an observation can be tied to a campaign/publication.
 * - platform_reported: the platform reports it for that exact post
 * - link: measured via our tracked link/UTM
 * - direct: user-level attribution from the source (e.g. RevenueCat with campaign attribute)
 * - aggregate: account-level number in the window, no per-campaign attribution
 * - none: unattributed
 */
export const AttributionLevel = z.enum(["platform_reported", "link", "direct", "aggregate", "none"]);
export type AttributionLevel = z.infer<typeof AttributionLevel>;

export const MetricObservation = BaseEntity.extend({
  appId: Id,
  campaignId: Id.optional(),
  publicationId: Id.optional(),
  experimentId: Id.optional(),
  variantKey: z.string().max(80).optional(),
  source: MetricSource,
  connectionId: Id.optional(),
  externalAccountId: z.string().max(200).optional(),
  metric: MetricName,
  /** Source's own definition (e.g. "RevenueCat: new paid subscriptions, excludes trials"). */
  metricDefinition: z.string().max(500),
  value: z.number(),
  unit: z.enum(["count", "currency", "seconds", "percent"]),
  currency: z.string().length(3).optional(),
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  timezone: z.string().max(64).default("UTC"),
  channel: Channel.optional(),
  attribution: AttributionLevel,
  provenance: z.object({
    imported: z.boolean(),
    importId: Id.optional(),
    apiRequestId: z.string().max(200).optional(),
    fetchedAt: IsoDateTime,
    rawRowRef: z.string().max(300).optional(),
  }),
  /** Dedup key: source+account+metric+window+scope. */
  dedupKey: z.string().max(256),
});
export type MetricObservation = z.infer<typeof MetricObservation>;

export const AttributionLink = BaseEntity.extend({
  appId: Id,
  campaignId: Id,
  publicationId: Id.optional(),
  scheduledPostId: Id.optional(),
  slug: z.string().min(4).max(40),
  destinationUrl: HttpUrl,
  utm: z.object({ source: z.string().max(80), medium: z.string().max(80), campaign: z.string().max(120), content: z.string().max(120).optional() }),
  clickCount: z.number().int().nonnegative().default(0),
  lastClickAt: IsoDateTime.optional(),
  active: z.boolean().default(true),
});
export type AttributionLink = z.infer<typeof AttributionLink>;

export const ImportBatch = BaseEntity.extend({
  appId: Id,
  kind: z.enum(["csv", "manual"]),
  filename: z.string().max(260).optional(),
  assetId: Id.optional(),
  rowCount: z.number().int().nonnegative(),
  acceptedCount: z.number().int().nonnegative(),
  rejected: z.array(z.object({ row: z.number().int(), reason: z.string().max(300) })).default([]),
  mapping: z.record(z.string(), z.string()).default({}),
  status: z.enum(["parsed", "committed", "failed"]),
});
export type ImportBatch = z.infer<typeof ImportBatch>;

export const Experiment = BaseEntity.extend({
  appId: Id,
  campaignId: Id.optional(),
  title: z.string().max(200),
  hypothesis: z.string().max(1000),
  baseline: z.object({ description: z.string().max(1000), observationIds: z.array(Id).default([]) }),
  variants: z
    .array(z.object({ key: z.string().max(80), label: z.string().max(160), variantId: Id.optional(), publicationIds: z.array(Id).default([]), isControl: z.boolean().default(false) }))
    .min(1)
    .max(8),
  primaryMetric: z.string().max(80),
  secondaryMetrics: z.array(z.string().max(80)).default([]),
  launchWindow: z.object({ start: IsoDateTime.optional(), end: IsoDateTime.optional() }).default({}),
  status: z.enum(["proposed", "running", "analyzing", "concluded", "abandoned"]),
  decision: z.string().max(1000).optional(),
  proposedByRecommendationId: Id.optional(),
  nextExperimentId: Id.optional(),
});
export type Experiment = z.infer<typeof Experiment>;

export const ExperimentResult = BaseEntity.extend({
  appId: Id,
  experimentId: Id,
  summary: z.string().max(3000),
  perVariant: z.array(
    z.object({
      key: z.string().max(80),
      metrics: z.array(z.object({ metric: z.string().max(80), value: z.number().nullable(), observationIds: z.array(Id).default([]), note: z.string().max(300).optional() })),
    }),
  ),
  /** Directly measured statements, each backed by observation ids. */
  measured: z.array(z.object({ text: z.string().max(600), observationIds: z.array(Id).min(1) })).default([]),
  /** Explicitly labelled interpretations; never phrased as proven causation. */
  hypotheses: z.array(z.string().max(600)).default([]),
  limitations: z.array(z.string().max(600)).default([]),
  confidence: z.enum(["insufficient_data", "low", "medium", "high"]),
  analyzedByRunId: Id.optional(),
});
export type ExperimentResult = z.infer<typeof ExperimentResult>;

export const GrowthRecommendation = BaseEntity.extend({
  appId: Id,
  title: z.string().max(200),
  rationale: z.string().max(3000),
  kind: z.enum(["next_experiment", "content", "channel", "audience", "creator", "stop_doing", "other"]),
  basedOn: z.object({
    observationIds: z.array(Id).default([]),
    resultIds: z.array(Id).default([]),
    findingIds: z.array(Id).default([]),
    preferenceIds: z.array(Id).default([]),
    sources: z.array(SourceRef).default([]),
  }),
  proposedExperiment: z
    .object({ title: z.string().max(200), hypothesis: z.string().max(1000), primaryMetric: z.string().max(80), variants: z.array(z.string().max(200)).max(6) })
    .optional(),
  confidence: z.enum(["low", "medium", "high"]),
  status: z.enum(["new", "accepted", "dismissed", "done"]).default("new"),
  /** True when Glimmer-retrieved memory changed this recommendation. */
  usedMemory: z.boolean().default(false),
  generatedByRunId: Id.optional(),
});
export type GrowthRecommendation = z.infer<typeof GrowthRecommendation>;
