import type { Platform } from "@muselaunch/platform";
import { RC_OVERVIEW_METRICS, RevenueCatClient, parseChartPoints, parsePeriodDays } from "@muselaunch/providers";
import { saveLive } from "./_save";

/**
 * RevenueCat API v2 live check (module F): one overview call and one daily revenue chart call
 * with your own project. Skips (without failing) when REVENUECAT_SECRET_KEY / REVENUECAT_PROJECT_ID
 * are not set. Redacted responses are saved to fixtures/live/ to confirm the parsers.
 */
export async function run(_p: Platform): Promise<string> {
  const secretKey = process.env.REVENUECAT_SECRET_KEY;
  const projectId = process.env.REVENUECAT_PROJECT_ID;
  if (!secretKey || !projectId) return "SKIPPED: set REVENUECAT_SECRET_KEY (v2 secret key with charts_metrics:overview:read + charts_metrics:charts:read) and REVENUECAT_PROJECT_ID to run";
  const currency = process.env.REVENUECAT_CURRENCY ?? "USD";
  const rc = new RevenueCatClient({ secretKey });
  const overview = await rc.overview(projectId, { currency });
  saveLive("revenuecat-overview", overview.data);
  const mapped = overview.data.metrics.filter((m) => RC_OVERVIEW_METRICS[m.id] && parsePeriodDays(m.period) !== null).map((m) => `${m.id}=${m.value}${m.unit === "$" ? ` ${overview.data.currency ?? currency}` : ""} (${m.period})`);
  const unmapped = overview.data.metrics.filter((m) => !RC_OVERVIEW_METRICS[m.id]).map((m) => m.id);
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86_400_000);
  const chart = await rc.chart(projectId, "revenue", { resolution: "0", startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), currency });
  saveLive("revenuecat-chart-revenue", chart.data);
  const parsed = parseChartPoints(chart.data, /revenue/i);
  return `overview: ${mapped.join(", ") || "no mapped metrics"}${unmapped.length ? ` | unmapped: ${unmapped.join(", ")}` : ""} | revenue chart: resolution=${chart.data.resolution} points=${parsed.points.length} incomplete=${parsed.skippedIncomplete} unrecognised=${parsed.unrecognised}`;
}
