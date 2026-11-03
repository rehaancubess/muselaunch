/**
 * Results ("See what is working") on the phone: the three numbers, the daily chart's geometry (gaps
 * stay gaps), the best post's line and the one tip (only from a test with enough data or a
 * recommendation grounded in measured numbers, never as a cause). Ported from
 * apps/web/src/features/results/results-lines.ts and insights/simple-lines.ts (keep them in step);
 * tested in results-lines.test.ts. Nothing is estimated: a number that isn't measured says so.
 */
import type { Experiment, ExperimentResult, GrowthRecommendation, InsightMetric, MetricSourceValue, MissingMetric, ResultsSeries, ResultsSummary } from "../api/types";

const DAY = 86_400_000;
export const RESULTS_MIN_CHART_DAYS = 3;

export type RangeKey = "7" | "28" | "90";
export const RANGES: { value: RangeKey; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "28", label: "28 days" },
  { value: "90", label: "90 days" },
];

export function rangeQuery(range: RangeKey, now = Date.now()): { from: string; to: string } {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(now - (Number(range) - 1) * DAY), to: iso(now) };
}

// ---------------------------------------------------------------------------
// Numbers and where they come from
// ---------------------------------------------------------------------------

/** 386, 4.2K, 12.4K, 1.2M (no Intl compact notation needed). */
export function shortNumber(v: number): string {
  const a = Math.abs(v);
  const fmt = (x: number, unit: string) => `${(Math.round(x * 10) / 10).toString().replace(/\.0$/, "")}${unit}`;
  if (a >= 1e9) return fmt(v / 1e9, "B");
  if (a >= 1e6) return fmt(v / 1e6, "M");
  if (a >= 1e3) return fmt(v / 1e3, "K");
  return String(Math.round(v * 100) / 100);
}
export const fullNumber = (v: number) => {
  const [int, dec] = String(Math.round(v * 100) / 100).split(".");
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${dec ? `.${dec}` : ""}`;
};

export const isMeasured = (m: Pick<InsightMetric, "value" | "byCurrency">) => m.value !== null || Boolean(m.byCurrency?.length);

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

type SourceLike = Pick<MetricSourceValue, "source" | "label" | "imported" | "observationCount">;

export function plainSource(m: { sources: SourceLike[] }): string | null {
  const s = m.sources.find((x) => x.observationCount > 0) ?? m.sources[0];
  if (!s) return null;
  if (s.source === "tracked_link") return "From your MuseLaunch links";
  if (s.source === "manual") return "Typed in by you";
  if (s.source === "csv_import") return "From a file you imported";
  const base = (s.label.split(" · ")[0] ?? s.label).replace(/\s*\(API\)$/, "").trim();
  return s.imported ? `From ${article(base)} ${base} file you imported` : `From ${base}`;
}

const lowerFrom = (s: string) => (/^(From|Typed) /.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

export function sourcesPhrase(sources: SourceLike[]): string | null {
  const phrases = [...new Set(sources.filter((s) => s.observationCount > 0).map((s) => plainSource({ sources: [s] })!))];
  if (!phrases.length) return plainSource({ sources });
  if (phrases.length === 1) return phrases[0]!;
  if (phrases.length === 2) return `${phrases[0]} and ${lowerFrom(phrases[1]!)}`;
  return `${phrases[0]} and ${phrases.length - 1} other sources`;
}

const SOCIAL = ["views", "impressions", "reach", "likes", "comments", "shares", "saves", "followers_gained", "profile_visits"];

export function scopeLine(m: Pick<InsightMetric, "metric" | "attribution">): string | null {
  if (m.attribution !== "aggregate") return null;
  return SOCIAL.includes(m.metric) ? "Total for your whole account" : "Total for your whole app";
}

export type Tile = {
  key: "views" | "clicks" | "posts";
  label: string;
  /** null = not measured yet (never shown as 0). */
  value: number | null;
  source: string | null;
  scope: string | null;
  /** What would measure it, in words (the phone points to the web for it). */
  missing: string | null;
};

function missingViews(m: Pick<MissingMetric, "action"> | undefined): string {
  if (m?.action === "publish_post") return "Post your first video to start counting";
  if (m?.action === "widen_range") return "Nothing in this range: try 90 days";
  return "Connect YouTube or add your numbers on the web";
}

/** Views, Link clicks, Posts published: measured values only, each with its source. */
export function tiles(metrics: Pick<InsightMetric, "metric" | "value" | "byCurrency" | "sources" | "attribution">[], missing: Pick<MissingMetric, "metric" | "action">[], posts: ResultsSummary["postsPublished"] | null): Tile[] {
  const find = (name: "views" | "clicks") => metrics.find((m) => m.metric === name && isMeasured(m));
  const views = find("views");
  const clicks = find("clicks");
  return [
    views
      ? { key: "views", label: "Views", value: views.value, source: sourcesPhrase(views.sources), scope: scopeLine({ metric: "views", attribution: views.attribution }), missing: null }
      : { key: "views", label: "Views", value: null, source: null, scope: null, missing: missingViews(missing.find((m) => m.metric === "views")) },
    clicks
      ? { key: "clicks", label: "Link clicks", value: clicks.value, source: sourcesPhrase(clicks.sources), scope: null, missing: null }
      : { key: "clicks", label: "Link clicks", value: null, source: null, scope: null, missing: "Posts with a tracked link count clicks" },
    posts ? { key: "posts", label: "Posts published", value: posts.value, source: "From your MuseLaunch posts", scope: null, missing: null } : { key: "posts", label: "Posts published", value: null, source: null, scope: null, missing: null },
  ];
}

export const nothingYet = (t: Tile[]) => t.every((x) => x.value === null || (x.key === "posts" && x.value === 0));

export function coverageLine(metrics: Pick<InsightMetric, "metric" | "value" | "byCurrency" | "coverage">[]): string | null {
  const ms = metrics.filter((m) => (m.metric === "views" || m.metric === "clicks") && isMeasured(m));
  const partial = ms.map((m) => m.coverage).filter((c): c is NonNullable<InsightMetric["coverage"]> => Boolean(c && c.daysWithData < c.daysInRange));
  if (!partial.length) return null;
  const first = partial[0]!;
  const same = partial.length === ms.length && partial.every((c) => c.daysWithData === first.daysWithData && c.daysInRange === first.daysInRange);
  if (same) return `${partial.length === 1 ? "This number covers" : "These numbers cover"} ${first.daysWithData} of the ${first.daysInRange} days. Days without numbers count as unknown, not zero.`;
  return "Some of these numbers cover only part of the range. Days without numbers count as unknown, not zero.";
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

export type ChartBox = { width: number; height: number; pad: { l: number; r: number; t: number; b: number } };

export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => v <= s * p + 1e-9)!;
  return f * p;
}

export type ChartModel = {
  max: number;
  baseline: number;
  y: (v: number) => number;
  lines: string[];
  areas: string[];
  dots: { i: number; x: number; y: number }[];
  ticks: { i: number; x: number; label: string }[];
};

export const shortDate = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

const SPARSE_DAYS = 10;

/** Lines only through consecutive measured days: a day without a number is a gap, never a 0. */
export function chartModel(points: ResultsSeries["points"], box: ChartBox): ChartModel {
  const { width, height, pad } = box;
  const n = points.length;
  const innerW = width - pad.l - pad.r;
  const baseline = height - pad.b;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value ?? 0)));
  const xs = points.map((_, i) => (n <= 1 ? pad.l + innerW / 2 : pad.l + (i * innerW) / (n - 1)));
  const y = (v: number) => pad.t + (baseline - pad.t) * (1 - v / max);
  const r = (v: number) => Math.round(v * 10) / 10;
  const runs: number[][] = [];
  let cur: number[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push(i);
  });
  if (cur.length) runs.push(cur);
  const lines = runs.filter((run) => run.length > 1).map((run) => run.map((i, k) => `${k ? "L" : "M"}${r(xs[i]!)},${r(y(points[i]!.value!))}`).join(" "));
  const areas = runs
    .filter((run) => run.length > 1)
    .map((run) => `M${r(xs[run[0]!]!)},${r(baseline)} ${run.map((i) => `L${r(xs[i]!)},${r(y(points[i]!.value!))}`).join(" ")} L${r(xs[run.at(-1)!]!)},${r(baseline)} Z`);
  const measured = runs.flat();
  const dotted = measured.length <= SPARSE_DAYS ? measured : runs.filter((run) => run.length === 1).flat();
  const dots = dotted.map((i) => ({ i, x: r(xs[i]!), y: r(y(points[i]!.value!)) }));
  const tickIdx = n <= 1 ? [0] : n <= 7 ? points.map((_, i) => i) : [...new Set([0, Math.round((n - 1) / 2), n - 1])];
  const ticks = n ? tickIdx.map((i) => ({ i, x: r(xs[i]!), label: shortDate(points[i]!.date) })) : [];
  return { max, baseline, y, lines, areas, dots, ticks };
}

export function chartHiddenLine(series: ResultsSeries | null, rangeDays: number): string | null {
  if (!series) return null;
  if (series.measuredDays >= RESULTS_MIN_CHART_DAYS) return null;
  const what = series.metric === "views" ? "views" : "link clicks";
  const have = series.measuredDays === 0 ? "no day" : series.measuredDays === 1 ? "only 1 day" : `only ${series.measuredDays} days`;
  return `A daily chart appears once ${what} are measured on at least ${RESULTS_MIN_CHART_DAYS} days. There’s ${have} with a number in the last ${rangeDays} days so far.`;
}

export function chartCaption(series: ResultsSeries): string {
  const what = series.metric === "views" ? "Views per day" : "Link clicks per day";
  const from = sourcesPhrase(series.sources);
  return from ? `${what} · ${from}` : what;
}

export function chartFootnote(series: ResultsSeries): string | null {
  const parts: string[] = [];
  if (series.points.some((p) => p.value === null)) parts.push("Days without a number are left blank, not counted as zero.");
  if (series.multiDayLeftOut) parts.push(`${series.multiDayLeftOut === 1 ? "1 number covers" : `${series.multiDayLeftOut} numbers cover`} several days at once, so ${series.multiDayLeftOut === 1 ? "it isn’t" : "they aren’t"} on the chart.`);
  return parts.length ? parts.join(" ") : null;
}

// ---------------------------------------------------------------------------
// Best post and the tip
// ---------------------------------------------------------------------------

export function bestPostLine(b: Pick<NonNullable<ResultsSummary["bestPost"]>, "metric" | "comparedPosts" | "tiedWith" | "sources">): string {
  const what = b.metric === "views" ? "views" : "link clicks";
  const line = b.comparedPosts === 1 ? `Your only post with ${what} measured so far` : b.tiedWith ? `Tied for the most ${what} of your ${b.comparedPosts} posts with numbers` : `Most ${what} of your ${b.comparedPosts} posts with numbers`;
  const from = sourcesPhrase(b.sources);
  return `${line}${from ? ` · ${from}` : ""}.`;
}

export type Tip = { title: string; body: string; basis: string; caution: string | null; from: "test" | "recommendation" };

const METRIC_WORDS: Record<string, string> = { clicks: "link clicks", views: "views", installs: "installs", trials_started: "free trials", new_subscriptions: "new subscribers", likes: "likes", shares: "shares", saves: "saves", comments: "comments", followers_gained: "new followers", watch_time_sec: "watch time" };
const wordsFor = (metric: string) => METRIC_WORDS[metric] ?? metric.replace(/_/g, " ");
/** Wording that claims a cause; a tip with it is not shown. */
const CAUSAL = /\b(caused|causes|because of|led to|leads to|drove|drives|driving|resulted in|results in|due to|thanks to|is why|will (?:get|bring|increase|boost|double|grow))\b/i;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, "")}…`);
const firstParagraph = (text: string) => (text.split(/\n\s*\n/).find((p) => p.trim()) ?? "").replace(/\s+/g, " ").trim();

export function tipFromTest(exp: Pick<Experiment, "title" | "primaryMetric" | "variants"> | null | undefined, result: Pick<ExperimentResult, "confidence" | "measured" | "perVariant"> | null | undefined): Tip | null {
  if (!exp || !result || result.confidence === "insufficient_data") return null;
  const measured = result.measured.find((m) => m.text.trim() && m.observationIds.length && !CAUSAL.test(m.text));
  if (!measured) return null;
  const rows = result.perVariant.filter((v) => v.key !== "baseline").map((v) => ({ key: v.key, value: v.metrics.find((m) => m.metric === exp.primaryMetric)?.value ?? null }));
  if (rows.length < 2 || rows.some((r) => r.value === null)) return null;
  const max = Math.max(...rows.map((r) => r.value!));
  const leaders = rows.filter((r) => r.value === max);
  if (max <= 0 || leaders.length !== 1) return null;
  const leader = exp.variants.find((v) => v.key === leaders[0]!.key);
  if (!leader) return null;
  const words = wordsFor(exp.primaryMetric);
  const total = rows.reduce((s, r) => s + r.value!, 0);
  const posts = exp.variants.reduce((s, v) => s + v.publicationIds.length, 0);
  return {
    title: `“${leader.label.trim()}” got the most ${words}`,
    body: measured.text.trim(),
    basis: `From your test “${exp.title}”: ${posts ? `${posts} post${posts === 1 ? "" : "s"}, ` : ""}${fullNumber(total)} ${words} in all.`,
    caution: result.confidence === "low" ? "A small sample, so treat it as a hint, not a rule." : null,
    from: "test",
  };
}

export function tipFromRecommendation(rec: Pick<GrowthRecommendation, "title" | "rationale" | "status" | "confidence" | "basedOn"> | null | undefined): Tip | null {
  if (!rec || rec.status !== "new" || rec.confidence === "low") return null;
  const evidence = rec.basedOn.observationIds.length + rec.basedOn.resultIds.length;
  if (evidence < 3) return null;
  const body = firstParagraph(rec.rationale);
  if (!body || CAUSAL.test(rec.title) || CAUSAL.test(body)) return null;
  return { title: rec.title, body: clip(body, 220), basis: `Muse’s suggestion, based on ${evidence} of your measured numbers${rec.basedOn.resultIds.length ? " and test results" : ""}.`, caution: null, from: "recommendation" };
}

export function pickTip(test: { exp: Parameters<typeof tipFromTest>[0]; result: Parameters<typeof tipFromTest>[1] } | null, recs: Parameters<typeof tipFromRecommendation>[0][]): Tip | null {
  return tipFromTest(test?.exp, test?.result) ?? recs.map(tipFromRecommendation).find(Boolean) ?? null;
}

export function latestTestWithResult<E extends Pick<Experiment, "lastResultId" | "status" | "updatedAt">>(items: E[]): E | undefined {
  return [...items].filter((e) => e.lastResultId && e.status !== "abandoned").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
