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
  /** Average playback length of ONE post (YouTube Analytics averageViewDuration). Never added across posts. */
  "avg_view_duration_sec",
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
      /** How to read dates like 03/04/2026 when the file is ambiguous. */
      dateFormat: z.enum(["auto", "YMD", "MDY", "DMY"]).optional(),
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

// ---------------------------------------------------------------------------
// YouTube channel analysis (module F). Public data via the YouTube Data API v3; every number is
// copied from (or computed only from) the API response stored with its fetch time and video URLs.
// ---------------------------------------------------------------------------

/** Whose channel it is, from the founder's point of view (changes how the AI reads it). */
export const YouTubeChannelRelation = z.enum(["mine", "competitor", "creator", "inspiration"]);
export type YouTubeChannelRelation = z.infer<typeof YouTubeChannelRelation>;

export const AnalyzeYouTubeChannelRequest = z.object({
  /** Channel URL, @handle, channel id (UC…) or a video URL from the channel. */
  channel: z.string().trim().min(2).max(300),
  relation: YouTubeChannelRelation.default("competitor"),
  /** Most recent uploads to read (one playlistItems page). */
  maxVideos: z.number().int().min(5).max(50).default(50),
});
export type AnalyzeYouTubeChannelRequest = z.infer<typeof AnalyzeYouTubeChannelRequest>;

/** Length groups. The API has no "is a Short" flag, so uploads are grouped by duration only. */
export const YouTubeLengthGroup = z.enum(["short", "mid", "long", "live", "unknown"]);
export type YouTubeLengthGroup = z.infer<typeof YouTubeLengthGroup>;

export const YouTubeVideoStat = z.object({
  videoId: z.string().min(1).max(64),
  url: HttpUrl,
  title: z.string().max(300),
  publishedAt: IsoDateTime,
  durationSec: z.number().int().nonnegative().nullable(),
  lengthGroup: YouTubeLengthGroup,
  /** statistics.viewCount (lifetime, at fetch time). */
  views: z.number().int().nonnegative().nullable(),
  /** statistics.likeCount; null when the creator hides likes. */
  likes: z.number().int().nonnegative().nullable(),
  /** statistics.commentCount; null when comments are off. */
  comments: z.number().int().nonnegative().nullable(),
  /** (likes + comments) / views, computed; null when any of them is missing or views is 0. */
  engagementRate: z.number().nonnegative().nullable(),
  /** Whole days between publishing and the fetch. */
  ageDays: z.number().nonnegative(),
  /** views / max(ageDays, 1), computed. */
  viewsPerDay: z.number().nonnegative().nullable(),
  /** views / the channel's median views in this sample, computed. */
  vsMedian: z.number().nonnegative().nullable(),
});
export type YouTubeVideoStat = z.infer<typeof YouTubeVideoStat>;

export const YouTubeGroupStat = z.object({
  key: z.string().max(40),
  label: z.string().max(80),
  videos: z.number().int().nonnegative(),
  medianViews: z.number().nullable(),
  medianViewsPerDay: z.number().nullable(),
  medianEngagementRate: z.number().nullable(),
  videoIds: z.array(z.string().max(64)).max(50),
});
export type YouTubeGroupStat = z.infer<typeof YouTubeGroupStat>;

export const YouTubeTitlePattern = z.object({
  key: z.string().max(40),
  label: z.string().max(80),
  with: YouTubeGroupStat,
  without: YouTubeGroupStat,
});
export type YouTubeTitlePattern = z.infer<typeof YouTubeTitlePattern>;

/** Deterministic statistics over the analysed uploads (no AI involved). */
export const YouTubeChannelStats = z.object({
  videosAnalyzed: z.number().int().nonnegative(),
  /** Uploads returned by the API but left out of the numbers (e.g. upcoming premieres, no stats). */
  excluded: z.array(z.object({ videoId: z.string().max(64), reason: z.string().max(200) })).max(50),
  window: z.object({ firstPublishedAt: IsoDateTime, lastPublishedAt: IsoDateTime }).nullable(),
  totals: z.object({ views: z.number().nonnegative(), likes: z.number().nonnegative(), comments: z.number().nonnegative(), videosWithHiddenLikes: z.number().int().nonnegative(), videosWithCommentsOff: z.number().int().nonnegative() }),
  medians: z.object({ views: z.number().nullable(), likes: z.number().nullable(), comments: z.number().nullable(), engagementRate: z.number().nullable(), viewsPerDay: z.number().nullable() }),
  meanViews: z.number().nullable(),
  topByViews: z.array(z.string().max(64)).max(10),
  topByViewsPerDay: z.array(z.string().max(64)).max(10),
  byLength: z.array(YouTubeGroupStat).max(5),
  /** Day of week posted (UTC). */
  byWeekday: z.array(YouTubeGroupStat).max(7),
  /** Time of day posted (UTC, 4-hour blocks). */
  byHour: z.array(YouTubeGroupStat).max(6),
  titlePatterns: z.array(YouTubeTitlePattern).max(8),
  cadence: z.object({ uploadsPerWeek: z.number().nullable(), medianDaysBetween: z.number().nullable() }),
  /** Plain-language caveats shown with the numbers. */
  notes: z.array(z.string().max(400)).max(12),
});
export type YouTubeChannelStats = z.infer<typeof YouTubeChannelStats>;

/** Measured statements MuseLaunch writes from the stats (no AI): saved as sourced research findings. */
export const YouTubeKeyFinding = z.object({
  key: z.string().max(40),
  statement: z.string().max(1500),
  videoIds: z.array(z.string().max(64)).max(10),
  findingId: Id.optional(),
});
export type YouTubeKeyFinding = z.infer<typeof YouTubeKeyFinding>;

/** The text model's reading of the stats. Always shown as interpretation, never as measured fact. */
export const YouTubeInterpretation = z.object({
  status: z.enum(["ready", "unavailable", "failed"]),
  /** Model id that wrote it (display with modelDisplayName); absent when no model ran. */
  model: z.string().max(80).optional(),
  provider: z.string().max(40).optional(),
  summary: z.string().max(2000).default(""),
  findingNotes: z.array(z.object({ key: z.string().max(40), interpretation: z.string().max(800) })).max(8).default([]),
  hooksToTest: z.array(z.object({ hook: z.string().max(200), angle: z.string().max(500), videoIds: z.array(z.string().max(64)).max(3).default([]) })).max(5).default([]),
  formatsToTest: z.array(z.object({ format: z.string().max(160), why: z.string().max(500), statKeys: z.array(z.string().max(40)).max(4).default([]) })).max(4).default([]),
  cautions: z.array(z.string().max(400)).max(10).default([]),
  /** Server-side checks: model text with numbers that aren't in the data is dropped, never shown. */
  validation: z.object({ droppedSentences: z.number().int().nonnegative(), droppedItems: z.number().int().nonnegative(), unknownVideoIds: z.number().int().nonnegative(), notes: z.array(z.string().max(300)).max(10) }).default({ droppedSentences: 0, droppedItems: 0, unknownVideoIds: 0, notes: [] }),
  /** Why there is no interpretation (not configured, spend ceiling, model error). */
  error: z.string().max(500).optional(),
  generatedAt: IsoDateTime.optional(),
});
export type YouTubeInterpretation = z.infer<typeof YouTubeInterpretation>;

/** One analysed channel per app (re-analysing replaces it). */
export const YouTubeChannelAnalysis = BaseEntity.extend({
  appId: Id,
  /** What the user pasted. */
  input: z.string().max(300),
  relation: YouTubeChannelRelation,
  /** True when the channel is the one connected for publishing in this workspace. */
  connectedChannel: z.boolean().default(false),
  channel: z.object({
    id: z.string().max(64),
    title: z.string().max(200),
    handle: z.string().max(120).optional(),
    url: HttpUrl,
    publishedAt: IsoDateTime.optional(),
    country: z.string().max(8).optional(),
    thumbnailUrl: HttpUrl.optional(),
    /** statistics.subscriberCount (YouTube rounds public counts); null when hidden. */
    subscriberCount: z.number().int().nonnegative().nullable(),
    viewCount: z.number().int().nonnegative().nullable(),
    videoCount: z.number().int().nonnegative().nullable(),
    uploadsPlaylistId: z.string().max(64).optional(),
  }),
  /** When the YouTube API responses were fetched. */
  fetchedAt: IsoDateTime,
  videos: z.array(YouTubeVideoStat).max(50),
  stats: YouTubeChannelStats,
  keyFindings: z.array(YouTubeKeyFinding).max(8).default([]),
  interpretation: YouTubeInterpretation,
  /** Where the numbers come from (channel page + API, with fetch time). */
  sources: z.array(SourceRef).max(60).default([]),
  /** YouTube Data API quota units used by the fetch (free, but limited per project per day). */
  quota: z.object({ units: z.number().int().nonnegative(), calls: z.array(z.object({ method: z.string().max(60), units: z.number().int().nonnegative() })).max(10) }),
  /** Brand-memory items written (only for the founder's own channel). */
  memoryIds: z.array(Id).max(5).default([]),
  jobId: Id.optional(),
});
export type YouTubeChannelAnalysis = z.infer<typeof YouTubeChannelAnalysis>;
