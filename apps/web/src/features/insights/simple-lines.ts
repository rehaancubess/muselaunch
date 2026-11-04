/**
 * Plain-TS choices and wording behind "How it's going" (the simple Insights page): which measured
 * numbers to show, where each one comes from, what's working (only from a test with enough data,
 * never as a cause) and the one next step. No React here (unit-tested in simple-lines.test.ts).
 */
import type { Experiment, ExperimentResult, InsightMetric, MetricName, MetricSourceValue, MissingMetric } from "@muselaunch/contracts";

/** Big numbers in the order people care about: did they see it, click it, install it, pay. */
export const BIG_NUMBER_ORDER: MetricName[] = ["views", "clicks", "installs", "trials_started", "new_subscriptions", "revenue", "active_subscriptions"];

const PLAIN_LABEL: Partial<Record<MetricName, string>> = {
  views: "Views",
  clicks: "Link clicks",
  installs: "Installs",
  trials_started: "Free trials started",
  new_subscriptions: "New subscribers",
  revenue: "Revenue",
  active_subscriptions: "Paying subscribers",
};

export const plainMetricLabel = (m: Pick<InsightMetric, "metric" | "label">) => PLAIN_LABEL[m.metric] ?? m.label;

/** A metric with a real value for the range (a measured 0 counts; "not measured" doesn't). */
export const isMeasured = (m: Pick<InsightMetric, "value" | "byCurrency">) => m.value !== null || Boolean(m.byCurrency?.length);

/** Up to `max` measured numbers, in BIG_NUMBER_ORDER. Never fills a gap with an estimate. */
export function bigNumbers<M extends Pick<InsightMetric, "metric" | "value" | "byCurrency">>(metrics: M[], max = 3): M[] {
  return BIG_NUMBER_ORDER.map((name) => metrics.find((m) => m.metric === name)).filter((m): m is M => Boolean(m && isMeasured(m))).slice(0, max);
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** Where a number comes from, in a few words ("From YouTube", "From a file you imported"). */
export function plainSource(m: { sources: Pick<MetricSourceValue, "source" | "label" | "imported" | "observationCount">[] }): string | null {
  const s = m.sources.find((x) => x.observationCount > 0) ?? m.sources[0];
  if (!s) return null;
  if (s.source === "tracked_link") return "From your MuseLaunch links";
  if (s.source === "manual") return "Typed in by you";
  if (s.source === "csv_import") return "From a file you imported";
  const base = (s.label.split(" · ")[0] ?? s.label).replace(/\s*\(API\)$/, "").trim();
  return s.imported ? `From ${article(base)} ${base} file you imported` : `From ${base}`;
}

/** Change on the period before, only when both periods were measured. Never says why it changed. */
export function changeLine(m: Pick<InsightMetric, "comparison">, rangeDays: number): string | null {
  const c = m.comparison;
  if (!c || c.value === null || c.deltaPct === null) return null;
  const before = `the ${rangeDays} days before`;
  if (c.deltaPct === 0) return `Same as ${before}`;
  return `${c.deltaPct > 0 ? "Up" : "Down"} ${Math.abs(c.deltaPct)}% on ${before}`;
}

const SOCIAL: MetricName[] = ["views", "impressions", "reach", "likes", "comments", "shares", "saves", "followers_gained", "profile_visits"];

/** Account-wide totals say so: they aren't credited to any one video (Details has the attribution). */
export function scopeLine(m: Pick<InsightMetric, "metric" | "attribution">): string | null {
  if (m.attribution !== "aggregate") return null;
  return SOCIAL.includes(m.metric) ? "Total for your whole account" : "Total for your whole app";
}

/** One note under the numbers when some of them only cover part of the range. */
export function coverageNote(metrics: Pick<InsightMetric, "coverage">[]): string | null {
  const partial = metrics.map((m) => m.coverage).filter((c): c is NonNullable<InsightMetric["coverage"]> => Boolean(c && c.daysWithData < c.daysInRange));
  if (!partial.length) return null;
  const first = partial[0]!;
  const same = partial.length === metrics.length && partial.every((c) => c.daysWithData === first.daysWithData && c.daysInRange === first.daysInRange);
  if (same) return `${partial.length === 1 ? "This number covers" : "These numbers cover"} ${first.daysWithData} of the ${first.daysInRange} days. Days without numbers count as unknown, not zero.`;
  return "Some of these numbers cover only part of the range. Days without numbers count as unknown, not zero.";
}

/** A recommendation's first paragraph (the rest, e.g. its caveats, stays on Details). */
export function firstParagraph(text: string): string {
  return (text.split(/\n\s*\n/).find((p) => p.trim()) ?? "").replace(/\s+/g, " ").trim();
}

/** The one next step when nothing is measured yet. */
export type NextStep = "post_video" | "connect_youtube" | "add_numbers";

export function nextStep(missing: Pick<MissingMetric, "metric" | "action">[], youtube: "connected" | "can_connect" | "unavailable"): NextStep {
  if (missing.some((m) => m.metric === "views" && m.action === "publish_post")) return "post_video";
  if (youtube === "can_connect") return "connect_youtube";
  return "add_numbers";
}

/** "What's working": one or two plain sentences from the latest test with enough data. */
export type WorkingLine = { text: string; maybe: string | null; basis: string; testTitle: string };

const metricWords = (metric: string) => (PLAIN_LABEL[metric as MetricName] ?? metric.replace(/_/g, " ")).toLowerCase();

export function workingLine(exp: Pick<Experiment, "title" | "primaryMetric"> | null | undefined, result: Pick<ExperimentResult, "confidence" | "measured" | "hypotheses" | "perVariant"> | null | undefined): WorkingLine | null {
  if (!exp || !result) return null;
  if (result.confidence === "insufficient_data") return null;
  const measured = result.measured.find((m) => m.text.trim() && m.observationIds.length);
  if (!measured) return null;
  let total = 0;
  let any = false;
  for (const v of result.perVariant) {
    if (v.key === "baseline") continue; // the "before" numbers aren't part of the test's sample
    for (const x of v.metrics) {
      if (x.metric === exp.primaryMetric && x.value !== null) {
        total += x.value;
        any = true;
      }
    }
  }
  const ids = new Set(result.measured.flatMap((m) => m.observationIds));
  const basis = any && total > 0 ? `Measured on ${new Intl.NumberFormat("en-US").format(total)} ${metricWords(exp.primaryMetric)}` : `Measured on ${ids.size} number${ids.size === 1 ? "" : "s"} you have`;
  const why = result.hypotheses.find((h) => h.trim());
  // The model's reasons are guesses: said as one, next to the measured sentence, never merged into it.
  return { text: measured.text.trim(), maybe: why ? `A possible reason (not measured): ${why.trim()}` : null, basis, testTitle: exp.title };
}
