import type { ConnectedAccount, MetricName, Publication } from "@muselaunch/contracts";

/**
 * Social insights adapter interface (module F reads, module E owns the OAuth connections).
 * An adapter is registered per provider (YouTube: ./youtube.ts). Providers without one report
 * social metrics as "not connected" (users can import or enter numbers manually, labelled as such).
 */
export interface SocialPostInsight {
  metric: Extract<
    MetricName,
    "impressions" | "views" | "reach" | "watch_time_sec" | "likes" | "comments" | "shares" | "saves" | "profile_visits" | "followers_gained" | "clicks" | "avg_view_duration_sec"
  >;
  value: number;
  /** The platform's own definition, shown next to the number. */
  definition: string;
  windowStart: string;
  windowEnd: string;
  apiRequestId?: string;
}

/** One HTTP call an adapter made (metered by the caller: usage row + quota units). */
export interface SocialInsightsRequest {
  api: string;
  method: string;
  status: "ok" | "error";
  ms: number;
  /** Provider quota units (YouTube Data API: 1 per list call). */
  quotaUnits?: number;
  errorCode?: string;
}

export interface SocialInsightsAdapter {
  readonly provider: ConnectedAccount["provider"];
  /** Fetch per-post insights for a publication made through this account. */
  fetchPostInsights(input: {
    account: ConnectedAccount;
    accessToken: string;
    publication: Publication;
    signal?: AbortSignal;
    /** Injected fetch (tests use recorded/documented responses). */
    fetch?: typeof fetch;
    /** Called once per HTTP request so the caller can meter it. */
    onRequest?: (r: SocialInsightsRequest) => void;
    /** Honest notes about what couldn't be fetched (missing scope, no data yet). */
    onNote?: (note: string) => void;
  }): Promise<SocialPostInsight[]>;
}

const registry = new Map<string, SocialInsightsAdapter>();

export function registerSocialInsightsAdapter(adapter: SocialInsightsAdapter): void {
  registry.set(adapter.provider, adapter);
}

export function socialInsightsAdapter(provider: string): SocialInsightsAdapter | undefined {
  return registry.get(provider);
}
