import type { ConnectedAccount, MetricName, Publication } from "@muselaunch/contracts";

/**
 * Social insights adapter interface (module F reads, module E owns the OAuth connections).
 * Implementations live next to E's publishing adapters once platform app review is granted.
 * Until then no adapter is registered and Insights reports social metrics as "not connected"
 * (users can import or enter numbers manually, labelled as such).
 */
export interface SocialPostInsight {
  metric: Extract<MetricName, "impressions" | "views" | "reach" | "watch_time_sec" | "likes" | "comments" | "shares" | "saves" | "profile_visits" | "followers_gained" | "clicks">;
  value: number;
  /** The platform's own definition, shown next to the number. */
  definition: string;
  windowStart: string;
  windowEnd: string;
  apiRequestId?: string;
}

export interface SocialInsightsAdapter {
  readonly provider: ConnectedAccount["provider"];
  /** Fetch per-post insights for a publication made through this account. */
  fetchPostInsights(input: { account: ConnectedAccount; accessToken: string; publication: Publication; signal?: AbortSignal }): Promise<SocialPostInsight[]>;
}

const registry = new Map<string, SocialInsightsAdapter>();

export function registerSocialInsightsAdapter(adapter: SocialInsightsAdapter): void {
  registry.set(adapter.provider, adapter);
}

export function socialInsightsAdapter(provider: string): SocialInsightsAdapter | undefined {
  return registry.get(provider);
}
