import { AppError } from "@muselaunch/platform";

/**
 * RevenueCat Developer API v2 (owner: module F).
 * Docs: https://www.revenuecat.com/docs/api-v2 — base `https://api.revenuecat.com/v2`,
 * `Authorization: Bearer <secret API key v2>`. Charts & Metrics are rate limited to 25 req/min;
 * 429 responses carry `Retry-After` and a `backoff_ms` body field. Error bodies:
 * `{ type, param, message, retryable, doc_url }`.
 *
 * Endpoints used:
 * - GET /projects/{project_id}/metrics/overview?currency=  (permission charts_metrics:overview:read)
 * - GET /projects/{project_id}/charts/{chart_name}?resolution=&start_date=&end_date=&currency=  (charts_metrics:charts:read)
 * - GET /projects (project_configuration:projects:read) — optional, only for a display name
 */

export const REVENUECAT_BASE_URL = "https://api.revenuecat.com/v2";

export interface RcOverviewMetric {
  object: "overview_metric";
  id: string;
  name: string;
  description?: string;
  unit?: string;
  /** ISO-8601 duration: "P0D" = point-in-time, "P28D" = trailing 28 days. */
  period: string;
  value: number;
  last_updated_at?: number | null;
  last_updated_at_iso8601?: string | null;
}

export interface RcOverview {
  object: "overview_metrics";
  metrics: RcOverviewMetric[];
  currency?: string;
}

/** Documented point shape (RevenueCat ai-toolkit): `{cohort, measure, value, incomplete, segment?}`. */
export interface RcChartPoint {
  cohort: number;
  measure: number;
  value: number | null;
  incomplete?: boolean;
  segment?: number;
}

export interface RcChart {
  object: "chart_data";
  category?: string;
  display_name?: string;
  description?: string;
  documentation_link?: string;
  resolution?: string;
  yaxis_currency?: string;
  last_computed_at?: number;
  start_date?: number | string;
  end_date?: number | string;
  values: (RcChartPoint | number[])[];
  measures?: { display_name?: string; unit?: string; description?: string }[];
  segments?: { display_name?: string; is_total?: boolean }[];
  summary?: Record<string, unknown>;
}

export interface RcProject {
  object: "project";
  id: string;
  name: string;
  created_at?: number;
}

export interface RcResponse<T> {
  data: T;
  requestId?: string;
  rateLimit?: { usage?: number; limit?: number };
}

export interface RevenueCatClientOptions {
  secretKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** Max automatic retries on 429/5xx (honours Retry-After). */
  maxRetries?: number;
  signal?: AbortSignal;
}

interface RcErrorBody {
  type?: string;
  param?: string;
  message?: string;
  retryable?: boolean;
  doc_url?: string;
  backoff_ms?: number;
}

/** Map documented RevenueCat errors to AppError with user-safe messages (never echoes the key). */
export function mapRevenueCatError(status: number, body: RcErrorBody, path: string): AppError {
  const details = { provider: "revenuecat", status, type: body.type, param: body.param, path: path.replace(/projects\/[^/]+/, "projects/:id") };
  const msg = body.message?.slice(0, 300) ?? `HTTP ${status}`;
  if (status === 401) {
    return new AppError("PROVIDER_NOT_CONFIGURED", `RevenueCat rejected the API key: ${msg}`, { details, retryable: false, userMessage: "RevenueCat rejected this key. Use a v2 secret API key." });
  }
  if (status === 403) {
    return new AppError("PROVIDER_NOT_CONFIGURED", `RevenueCat key lacks permission: ${msg}`, {
      details,
      retryable: false,
      userMessage: "This RevenueCat key doesn't have the Charts & Metrics read permissions (charts_metrics:overview:read, charts_metrics:charts:read).",
    });
  }
  if (status === 404) return new AppError("NOT_FOUND", `RevenueCat resource not found: ${msg}`, { details, retryable: false, userMessage: "RevenueCat couldn't find that project. Check the project ID." });
  if (status === 400 || status === 422) return new AppError("PROVIDER_ERROR", `RevenueCat rejected the request: ${msg}`, { details, retryable: false });
  if (status === 429) return new AppError("RATE_LIMITED", "RevenueCat rate limit reached", { details: { ...details, backoffMs: body.backoff_ms }, retryable: true });
  if (status === 423) return new AppError("PROVIDER_UNAVAILABLE", `RevenueCat resource locked: ${msg}`, { details, retryable: true });
  if (status >= 500) return new AppError("PROVIDER_UNAVAILABLE", `RevenueCat unavailable (${status})`, { details, retryable: true });
  return new AppError("PROVIDER_ERROR", `RevenueCat error ${status}: ${msg}`, { details, retryable: Boolean(body.retryable) });
}

export class RevenueCatClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  constructor(private readonly opts: RevenueCatClientOptions) {
    if (!opts.secretKey) throw new AppError("PROVIDER_NOT_CONFIGURED", "RevenueCat secret key missing");
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseUrl = (opts.baseUrl ?? REVENUECAT_BASE_URL).replace(/\/$/, "");
  }

  async request<T>(path: string, query: Record<string, string | undefined> = {}): Promise<RcResponse<T>> {
    const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined)).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const maxRetries = this.opts.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
      const signal = this.opts.signal ? AbortSignal.any([this.opts.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${this.opts.secretKey}`, accept: "application/json" }, signal });
      } catch (err) {
        if (this.opts.signal?.aborted) throw new AppError("CANCELLED", "RevenueCat request cancelled", { cause: err });
        if (attempt < maxRetries) {
          await sleep(500 * 2 ** attempt, this.opts.signal);
          continue;
        }
        throw new AppError("PROVIDER_UNAVAILABLE", `RevenueCat unreachable: ${(err as Error).message}`, { retryable: true, cause: err });
      }
      const text = await res.text();
      if (res.ok) {
        let data: T;
        try {
          data = JSON.parse(text) as T;
        } catch {
          throw new AppError("PROVIDER_ERROR", "RevenueCat returned invalid JSON", { retryable: true });
        }
        const usage = Number(res.headers.get("revenuecat-rate-limit-current-usage") ?? NaN);
        const limit = Number(res.headers.get("revenuecat-rate-limit-current-limit") ?? NaN);
        return {
          data,
          requestId: res.headers.get("x-request-id") ?? res.headers.get("x-revenuecat-request-id") ?? undefined,
          rateLimit: { usage: Number.isFinite(usage) ? usage : undefined, limit: Number.isFinite(limit) ? limit : undefined },
        };
      }
      let body: RcErrorBody = {};
      try {
        body = JSON.parse(text) as RcErrorBody;
      } catch {
        body = { message: text.slice(0, 200) };
      }
      const err = mapRevenueCatError(res.status, body, path);
      if (err.retryable && attempt < maxRetries) {
        const retryAfterSec = Number(res.headers.get("retry-after") ?? 0);
        const wait = Math.max(body.backoff_ms ?? 0, retryAfterSec * 1000, 500 * 2 ** attempt);
        if (wait <= 30_000) {
          await sleep(wait, this.opts.signal);
          continue;
        }
      }
      throw err;
    }
  }

  overview(projectId: string, opts: { currency?: string } = {}) {
    return this.request<RcOverview>(`/projects/${encodeURIComponent(projectId)}/metrics/overview`, { currency: opts.currency });
  }

  /** Chart data. `resolution` takes a resolution id from the options endpoint ("0" = day in RevenueCat's documented example). */
  chart(projectId: string, chartName: string, opts: { resolution?: string; startDate?: string; endDate?: string; currency?: string; realtime?: boolean } = {}) {
    return this.request<RcChart>(`/projects/${encodeURIComponent(projectId)}/charts/${encodeURIComponent(chartName)}`, {
      resolution: opts.resolution,
      start_date: opts.startDate,
      end_date: opts.endDate,
      currency: opts.currency,
      realtime: opts.realtime === undefined ? undefined : String(opts.realtime),
    });
  }

  listProjects() {
    return this.request<{ object: "list"; items: RcProject[]; next_page?: string | null }>(`/projects`, { limit: "100" });
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new AppError("CANCELLED", "Cancelled"));
    });
  });
}

/**
 * Overview metric catalog. Definitions paraphrase RevenueCat's dashboard docs
 * (https://www.revenuecat.com/docs/dashboard-and-metrics/overview). Metrics with ids not
 * listed here are skipped and reported as unmapped — never guessed.
 */
export const RC_OVERVIEW_METRICS: Record<string, { metric: "active_trials" | "active_subscriptions" | "mrr" | "revenue" | "new_customers" | "active_customers" | "transactions"; unit: "count" | "currency"; definition: string }> = {
  active_trials: {
    metric: "active_trials",
    unit: "count",
    definition: "RevenueCat Active Trials: free trials currently active (cancelled or in grace period count until they convert or expire). Point-in-time snapshot.",
  },
  active_subscriptions: {
    metric: "active_subscriptions",
    unit: "count",
    definition: "RevenueCat Active Subscriptions: paid subscriptions currently active (cancelled or in grace period count until expiry); excludes free trials. Point-in-time snapshot.",
  },
  mrr: { metric: "mrr", unit: "currency", definition: "RevenueCat MRR: current monthly recurring revenue, normalised to a monthly amount. Point-in-time snapshot." },
  revenue: { metric: "revenue", unit: "currency", definition: "RevenueCat Revenue (overview): gross revenue before store fees and taxes over the reported trailing window." },
  new_customers: {
    metric: "new_customers",
    unit: "count",
    definition: "RevenueCat New Customers: App User IDs created in the trailing window (aliases counted once). Not the same as store downloads.",
  },
  active_users: { metric: "active_customers", unit: "count", definition: "RevenueCat Active Customers: App User IDs that contacted RevenueCat in the trailing window." },
  num_tx_last_28_days: { metric: "transactions", unit: "count", definition: "RevenueCat transactions in the trailing window." },
};

/** Daily charts pulled during sync (chart name → our metric). Definitions prefer the chart's own description. */
export const RC_DAILY_CHARTS: { chart: string; metric: "revenue" | "trials_started" | "new_subscriptions" | "new_customers"; unit: "count" | "currency"; measureHint: RegExp; fallbackDefinition: string }[] = [
  { chart: "revenue", metric: "revenue", unit: "currency", measureHint: /revenue/i, fallbackDefinition: "RevenueCat Revenue chart: revenue per UTC day (RevenueCat's default revenue type)." },
  { chart: "trials_new", metric: "trials_started", unit: "count", measureHint: /trial/i, fallbackDefinition: "RevenueCat New Trials chart: free trials started per UTC day." },
  { chart: "actives_new", metric: "new_subscriptions", unit: "count", measureHint: /.*/, fallbackDefinition: "RevenueCat New Paid Subscriptions chart: new paid subscriptions per UTC day, as defined by RevenueCat." },
  { chart: "customers_new", metric: "new_customers", unit: "count", measureHint: /customer/i, fallbackDefinition: "RevenueCat New Customers chart: App User IDs created per UTC day." },
];

/** Parse an ISO-8601 day/week duration ("P0D", "P28D", "P1W"). Returns days or null if unsupported. */
export function parsePeriodDays(period: string): number | null {
  const m = /^P(?:(\d+)W|(\d+)D)$/.exec(period.trim());
  if (!m) return null;
  return m[1] ? Number(m[1]) * 7 : Number(m[2]);
}

/** RevenueCat timestamps: seconds or milliseconds. */
export function rcTimestampMs(ts: number): number {
  return ts < 1e11 ? ts * 1000 : ts;
}

export interface ParsedChartPoint {
  startMs: number;
  value: number;
}

/**
 * Extract complete per-period points for one measure. Supports the documented object form
 * `{cohort, measure, value, incomplete}`; the array form `[timestamp, v0, v1, …]` is accepted only
 * when the first element is a plausible Unix timestamp. Incomplete periods are skipped (never shown
 * as if they were full days).
 */
export function parseChartPoints(chart: RcChart, measureHint: RegExp): { points: ParsedChartPoint[]; measureIndex: number; skippedIncomplete: number; unrecognised: number } {
  const measures = chart.measures ?? [];
  let measureIndex = measures.findIndex((m) => measureHint.test(m.display_name ?? ""));
  if (measureIndex < 0) measureIndex = 0;
  const totalSegment = chart.segments?.findIndex((s) => s.is_total);
  const points: ParsedChartPoint[] = [];
  let skippedIncomplete = 0;
  let unrecognised = 0;
  for (const v of chart.values ?? []) {
    if (Array.isArray(v)) {
      const [ts, ...rest] = v;
      const plausible = typeof ts === "number" && ((ts > 1e9 && ts < 1e10) || (ts > 1e12 && ts < 1e13));
      const value = rest[measureIndex];
      if (!plausible || typeof value !== "number") {
        unrecognised++;
        continue;
      }
      points.push({ startMs: rcTimestampMs(ts), value });
      continue;
    }
    if (!v || typeof v !== "object" || typeof v.cohort !== "number") {
      unrecognised++;
      continue;
    }
    if (v.measure !== measureIndex) continue;
    if (v.segment !== undefined && totalSegment !== undefined && totalSegment >= 0 && v.segment !== totalSegment) continue;
    if (v.incomplete) {
      skippedIncomplete++;
      continue;
    }
    if (typeof v.value !== "number" || !Number.isFinite(v.value)) continue;
    points.push({ startMs: rcTimestampMs(v.cohort), value: v.value });
  }
  return { points, measureIndex, skippedIncomplete, unrecognised };
}
