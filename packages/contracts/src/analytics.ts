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
  /** RevenueCat overview: active free trials (point-in-time). */
  "active_trials",
  /** RevenueCat overview: new App User IDs created in the window (not store downloads). */
  "new_customers",
  /** RevenueCat overview: App User IDs that contacted RevenueCat in the window. */
  "active_customers",
  /** Store/RevenueCat transactions count in the window. */
  "transactions",
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
  /** Human (non-bot) redirects only. Link-preview crawlers are counted separately in `uaClassCounts.bot`. */
  clickCount: z.number().int().nonnegative().default(0),
  lastClickAt: IsoDateTime.optional(),
  active: z.boolean().default(true),
  /** Which of the app's own destinations this is; `other` requires `destinationConfirmedBy`. */
  destinationKind: z.enum(["ios", "android", "website", "other"]).optional(),
  /** Actor who explicitly confirmed a destination that is not one of the app's own URLs. */
  destinationConfirmedBy: z.string().max(160).optional(),
  /** Final URL the public redirect sends people to (destination + UTM/referrer params). */
  redirectUrl: HttpUrl.optional(),
  channel: Channel.optional(),
  /** Coarse user-agent classes only (no IPs, no raw user agents): mobile/desktop/bot/other. */
  uaClassCounts: z.record(z.string(), z.number().int().nonnegative()).default({}),
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
  /** Detected file format (preset) used for parsing. */
  detectedFormat: z.enum(["generic_long", "generic_wide", "app_store_sales", "play_installs", "manual"]).optional(),
  /** Header row as found in the file. */
  columns: z.array(z.string().max(200)).max(200).default([]),
  /** Import options chosen at preview/commit time. */
  options: z
    .object({
      source: MetricSource.optional(),
      timezone: z.string().max(64).optional(),
      currency: z.string().length(3).optional(),
      channel: Channel.optional(),
      campaignId: Id.optional(),
      attribution: z.enum(["aggregate", "platform_reported", "none"]).optional(),
      /** Free-text definition the user gives for the numbers (shown next to every value). */
      definitionNote: z.string().max(300).optional(),
    })
    .default({}),
  /** First parsed rows (normalised), for the mapping preview. */
  preview: z
    .array(z.object({ row: z.number().int(), date: z.string().max(40), metric: z.string().max(80), value: z.number(), currency: z.string().max(3).optional(), channel: z.string().max(40).optional() }))
    .max(50)
    .default([]),
  committedAt: IsoDateTime.optional(),
  /** Observations written on commit (after dedup by window/metric). */
  observationCount: z.number().int().nonnegative().optional(),
  error: z.string().max(1000).optional(),
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
  lastResultId: Id.optional(),
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
  /** Model that wrote the interpretation; absent when no model was called (e.g. insufficient data). */
  model: z.string().max(80).optional(),
  /** Server-side checks applied to the model output before it was stored. */
  validation: z
    .object({
      droppedMeasured: z.number().int().nonnegative().default(0),
      movedToHypotheses: z.number().int().nonnegative().default(0),
      confidenceCapped: z.boolean().default(false),
      notes: z.array(z.string().max(400)).max(20).default([]),
    })
    .optional(),
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
  /** Models used: Spark interprets results, Wonder proposes the next experiment. */
  models: z.object({ interpret: z.string().max(80).optional(), propose: z.string().max(80).optional() }).optional(),
  /** Experiment created when the recommendation was accepted. */
  experimentId: Id.optional(),
  dismissReason: z.string().max(500).optional(),
});
export type GrowthRecommendation = z.infer<typeof GrowthRecommendation>;

// ---------------------------------------------------------------------------
// API shapes (module F). Shared with the web Insights UI.
// ---------------------------------------------------------------------------

export const ImportOptions = ImportBatch.shape.options;
export type ImportOptions = z.infer<typeof ImportOptions>;
export const ImportFormat = z.enum(["generic_long", "generic_wide", "app_store_sales", "play_installs"]);
export type ImportFormat = z.infer<typeof ImportFormat>;

export const ConnectRevenueCatRequest = z.object({
  appId: Id,
  /** RevenueCat secret API key v2 (needs charts_metrics:overview:read and charts_metrics:charts:read). Stored encrypted. */
  secretKey: z.string().min(8).max(400),
  projectId: z.string().min(1).max(255),
  currency: z.string().length(3).default("USD"),
});
export type ConnectRevenueCatRequest = z.infer<typeof ConnectRevenueCatRequest>;

export const CreateImportRequest = z.object({
  /** Uploaded `document` asset (text/csv or text/plain TSV). */
  assetId: Id,
  /** Override format detection. */
  format: ImportFormat.optional(),
  /** Column → target (`date`, `metric`, `value`, `currency`, `channel`, `metric:<MetricName>`, `ignore`). */
  mapping: z.record(z.string(), z.string()).optional(),
  options: ImportOptions.optional(),
});
export type CreateImportRequest = z.infer<typeof CreateImportRequest>;

export const CommitImportRequest = z.object({
  mapping: z.record(z.string(), z.string()).optional(),
  options: ImportOptions.optional(),
});

export const ManualObservationRequest = z.object({
  metric: MetricName,
  value: z.number().finite(),
  unit: z.enum(["count", "currency", "seconds", "percent"]).optional(),
  currency: z.string().length(3).optional(),
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  timezone: z.string().max(64).default("UTC"),
  channel: Channel.optional(),
  campaignId: Id.optional(),
  publicationId: Id.optional(),
  experimentId: Id.optional(),
  variantKey: z.string().max(80).optional(),
  /** Manual numbers can never claim link/direct attribution. */
  attribution: z.enum(["aggregate", "platform_reported", "none"]).default("aggregate"),
  /** Where the number comes from, in the user's words (e.g. "Instagram app insights, reel views"). */
  definition: z.string().min(3).max(300),
});
export type ManualObservationRequest = z.infer<typeof ManualObservationRequest>;

export const CreateTrackedLinkRequest = z.object({
  /** One of the app's own destinations. */
  destination: z.enum(["ios", "android", "website"]).optional(),
  /** Explicit URL. Must be one of the app's own URLs unless `confirmExternalDestination` is true. */
  destinationUrl: HttpUrl.optional(),
  confirmExternalDestination: z.boolean().default(false),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/, "4–40 lowercase letters, digits or dashes")
    .optional(),
  utm: z.object({ source: z.string().min(1).max(80), medium: z.string().min(1).max(80), campaign: z.string().max(120).optional(), content: z.string().max(120).optional() }),
  channel: Channel.optional(),
  publicationId: Id.optional(),
  scheduledPostId: Id.optional(),
});
export type CreateTrackedLinkRequest = z.infer<typeof CreateTrackedLinkRequest>;

const ExperimentVariantInput = z.object({ key: z.string().min(1).max(80), label: z.string().min(1).max(160), variantId: Id.optional(), publicationIds: z.array(Id).max(50).default([]), isControl: z.boolean().default(false) });

export const CreateExperimentRequest = z.object({
  campaignId: Id.optional(),
  title: z.string().min(1).max(200),
  hypothesis: z.string().min(1).max(1000),
  baseline: z.object({ description: z.string().max(1000), observationIds: z.array(Id).max(100).default([]) }).default({ description: "", observationIds: [] }),
  variants: z.array(ExperimentVariantInput).min(1).max(8),
  primaryMetric: MetricName,
  secondaryMetrics: z.array(MetricName).max(6).default([]),
  launchWindow: z.object({ start: IsoDateTime.optional(), end: IsoDateTime.optional() }).default({}),
  status: z.enum(["proposed", "running"]).default("proposed"),
});
export type CreateExperimentRequest = z.infer<typeof CreateExperimentRequest>;

export const UpdateExperimentRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  hypothesis: z.string().min(1).max(1000).optional(),
  variants: z.array(ExperimentVariantInput).min(1).max(8).optional(),
  secondaryMetrics: z.array(MetricName).max(6).optional(),
  launchWindow: z.object({ start: IsoDateTime.optional(), end: IsoDateTime.optional() }).optional(),
  status: z.enum(["proposed", "running", "concluded", "abandoned"]).optional(),
  /** The human decision; recorded as a lesson in brand memory when the experiment is concluded. */
  decision: z.string().max(1000).optional(),
});

export const InsightsQuery = z.object({
  /** ISO date (YYYY-MM-DD) or datetime; default: 28 days before `to`. */
  from: z.string().max(40).optional(),
  /** ISO date (inclusive, whole UTC day) or datetime; default: now. */
  to: z.string().max(40).optional(),
  compare: z.enum(["prev", "none"]).default("prev"),
  channel: Channel.optional(),
  campaignId: Id.optional(),
});
export type InsightsQuery = z.infer<typeof InsightsQuery>;

export const MetricSourceValue = z.object({
  source: MetricSource,
  /** e.g. "RevenueCat (API)", "App Store Connect · Imported CSV", "Manual entry", "MuseLaunch tracked links". */
  label: z.string(),
  imported: z.boolean(),
  attribution: AttributionLevel,
  value: z.number().nullable(),
  currency: z.string().optional(),
  observationCount: z.number().int().nonnegative(),
  definitions: z.array(z.string()),
  lastFetchedAt: IsoDateTime.optional(),
});
export type MetricSourceValue = z.infer<typeof MetricSourceValue>;

export const InsightMetric = z.object({
  metric: MetricName,
  label: z.string(),
  unit: z.enum(["count", "currency", "seconds", "percent"]),
  currency: z.string().optional(),
  /** null = not measured for this range/filter (never a guessed 0). */
  value: z.number().nullable(),
  /** sum of non-overlapping windows inside the range, or latest snapshot for stock metrics. */
  aggregation: z.enum(["sum", "latest", "none"]),
  sources: z.array(MetricSourceValue),
  /** Weakest attribution level among contributing observations. */
  attribution: AttributionLevel.nullable(),
  imported: z.boolean(),
  definition: z.string(),
  window: z.object({ start: IsoDateTime, end: IsoDateTime }).nullable(),
  coverage: z.object({ daysWithData: z.number().int(), daysInRange: z.number().int() }).nullable(),
  observationIds: z.array(Id),
  comparison: z.object({ value: z.number().nullable(), delta: z.number().nullable(), deltaPct: z.number().nullable() }).nullable(),
  byCurrency: z.array(z.object({ currency: z.string(), value: z.number() })).optional(),
  notes: z.array(z.string()),
});
export type InsightMetric = z.infer<typeof InsightMetric>;

export const MissingMetric = z.object({
  metric: MetricName,
  label: z.string(),
  reason: z.string(),
  action: z.enum(["connect_revenuecat", "import_csv", "enter_manually", "create_tracked_link", "publish_post", "connect_social", "sync_now", "widen_range", "none"]),
});
export type MissingMetric = z.infer<typeof MissingMetric>;

export const FunnelStep = z.object({
  metric: MetricName,
  label: z.string(),
  value: z.number().nullable(),
  sourceLabel: z.string().nullable(),
  attribution: AttributionLevel.nullable(),
  imported: z.boolean(),
  /** Only computed when both steps are measured in the same scope; otherwise null with a note. */
  conversionFromPrevious: z.number().nullable(),
  conversionNote: z.string().optional(),
});
export type FunnelStep = z.infer<typeof FunnelStep>;

export const CostOutcome = z.object({
  costs: z.object({
    contentUsd: z.object({ value: z.number(), definition: z.string(), calls: z.number().int() }),
    creditsConsumed: z.object({ value: z.number().int(), definition: z.string() }),
    adSpend: z.array(z.object({ currency: z.string(), value: z.number(), imported: z.boolean(), observationIds: z.array(Id) })).nullable(),
  }),
  outcomes: z.array(z.object({ metric: MetricName, value: z.number().nullable(), currency: z.string().optional(), attribution: AttributionLevel.nullable(), sourceLabel: z.string().nullable() })),
  /** Cost ratios are only shown when outcome and cost share a measured scope. */
  ratios: z.array(z.object({ label: z.string(), value: z.number(), currency: z.string().optional(), basis: z.string() })),
  unknowns: z.array(z.string()),
});
export type CostOutcome = z.infer<typeof CostOutcome>;

export const InsightsOverview = z.object({
  appId: Id,
  range: z.object({ from: IsoDateTime, to: IsoDateTime, timezone: z.literal("UTC") }),
  comparisonRange: z.object({ from: IsoDateTime, to: IsoDateTime }).nullable(),
  filters: z.object({ channel: Channel.optional(), campaignId: Id.optional() }),
  metrics: z.array(InsightMetric),
  missing: z.array(MissingMetric),
  funnel: z.array(FunnelStep),
  cost: CostOutcome,
  connections: z.array(z.object({ id: Id, provider: z.string(), status: z.string(), lastSyncAt: IsoDateTime.optional(), lastError: z.string().optional() })),
  /** Plain-language guardrails the UI must show next to the numbers. */
  disclaimers: z.array(z.string()),
  generatedAt: IsoDateTime,
});
export type InsightsOverview = z.infer<typeof InsightsOverview>;
