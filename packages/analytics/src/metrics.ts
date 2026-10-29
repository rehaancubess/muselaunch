import type { AttributionLevel, MetricName, MetricObservation, MetricSource } from "@muselaunch/contracts";

export type MetricUnit = MetricObservation["unit"];

/**
 * - flow: additive per window (installs per day) → sum of non-overlapping windows
 * - stock: point-in-time level (active subscriptions) → latest snapshot
 * - unique: de-duplicated counts (reach) → not additive across windows
 * - average: a per-post average (average view duration) → never added; shown only for a single post
 */
export type MetricKind = "flow" | "stock" | "unique" | "average";

export const METRIC_INFO: Record<MetricName, { label: string; unit: MetricUnit; kind: MetricKind; social?: boolean }> = {
  impressions: { label: "Impressions", unit: "count", kind: "flow", social: true },
  views: { label: "Views", unit: "count", kind: "flow", social: true },
  reach: { label: "Reach", unit: "count", kind: "unique", social: true },
  watch_time_sec: { label: "Watch time", unit: "seconds", kind: "flow", social: true },
  likes: { label: "Likes", unit: "count", kind: "flow", social: true },
  comments: { label: "Comments", unit: "count", kind: "flow", social: true },
  shares: { label: "Shares", unit: "count", kind: "flow", social: true },
  saves: { label: "Saves", unit: "count", kind: "flow", social: true },
  followers_gained: { label: "Followers gained", unit: "count", kind: "flow", social: true },
  profile_visits: { label: "Profile visits", unit: "count", kind: "flow", social: true },
  clicks: { label: "Link clicks", unit: "count", kind: "flow" },
  store_page_views: { label: "Store page views", unit: "count", kind: "flow" },
  installs: { label: "Installs", unit: "count", kind: "flow" },
  trials_started: { label: "Trials started", unit: "count", kind: "flow" },
  trial_conversions: { label: "Trial conversions", unit: "count", kind: "flow" },
  new_subscriptions: { label: "New subscriptions", unit: "count", kind: "flow" },
  active_subscriptions: { label: "Active subscriptions", unit: "count", kind: "stock" },
  churned_subscriptions: { label: "Churned subscriptions", unit: "count", kind: "flow" },
  revenue: { label: "Revenue", unit: "currency", kind: "flow" },
  mrr: { label: "MRR", unit: "currency", kind: "stock" },
  ad_spend: { label: "Ad spend", unit: "currency", kind: "flow" },
  content_cost: { label: "Content cost", unit: "currency", kind: "flow" },
  active_trials: { label: "Active trials", unit: "count", kind: "stock" },
  new_customers: { label: "New customers (RevenueCat)", unit: "count", kind: "flow" },
  active_customers: { label: "Active customers (RevenueCat)", unit: "count", kind: "unique" },
  transactions: { label: "Transactions", unit: "count", kind: "flow" },
  avg_view_duration_sec: { label: "Average view duration", unit: "seconds", kind: "average", social: true },
};

/** Metrics shown on the Insights overview, in display order. */
export const OVERVIEW_METRICS: MetricName[] = ["views", "clicks", "installs", "trials_started", "new_subscriptions", "revenue", "active_subscriptions", "mrr", "active_trials", "ad_spend"];

/** Funnel order (spec: views → clicks → installs → trials → subscriptions → revenue). */
export const FUNNEL_METRICS: MetricName[] = ["views", "clicks", "installs", "trials_started", "new_subscriptions", "revenue"];

export const SOURCE_LABEL: Record<MetricSource, string> = {
  revenuecat: "RevenueCat",
  app_store_connect: "App Store Connect",
  google_play_console: "Google Play Console",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  x: "X",
  tracked_link: "MuseLaunch tracked links",
  csv_import: "CSV import",
  manual: "Manual entry",
};

/** Lower = preferred when two sources report the same metric for the same scope. */
export const SOURCE_PRIORITY: Record<MetricSource, number> = {
  revenuecat: 0,
  app_store_connect: 1,
  google_play_console: 1,
  instagram: 2,
  facebook: 2,
  youtube: 2,
  tiktok: 2,
  linkedin: 2,
  x: 2,
  tracked_link: 3,
  csv_import: 5,
  manual: 6,
};

/** Strength order for attribution (weakest first). */
export const ATTRIBUTION_STRENGTH: Record<AttributionLevel, number> = { none: 0, aggregate: 1, platform_reported: 2, link: 3, direct: 4 };

export function weakestAttribution(levels: AttributionLevel[]): AttributionLevel | null {
  if (!levels.length) return null;
  return levels.reduce((a, b) => (ATTRIBUTION_STRENGTH[b] < ATTRIBUTION_STRENGTH[a] ? b : a));
}

/** Human label for where a number came from, including the Imported/Manual flag. */
export function sourceLabel(o: Pick<MetricObservation, "source" | "provenance">): string {
  const base = SOURCE_LABEL[o.source];
  if (o.source === "manual") return "Manual entry";
  if (o.source === "csv_import") return "Imported CSV";
  if (o.source === "tracked_link") return base;
  return o.provenance.imported ? `${base} · Imported CSV` : `${base} (API)`;
}

export function isMetricName(x: string): x is MetricName {
  return x in METRIC_INFO;
}

export const CLICK_DEFINITION = "MuseLaunch tracked link: redirects through /r/<slug> per UTC day. Excludes known link-preview bots and rapid repeats; not unique visitors (no cookies or IPs are stored).";
