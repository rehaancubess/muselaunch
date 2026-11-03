/**
 * Plain-TS choices and wording behind Results ("See what is working"): the three numbers and what
 * would measure a missing one, the daily chart's geometry (gaps stay gaps), the one tip (only from
 * a test with enough data or a recommendation grounded in measured numbers, never as a cause) and
 * the ideas card. No React here (unit-tested in results-lines.test.ts).
 */
import type { Experiment, ExperimentResult, GrowthRecommendation, InsightMetric, MissingMetric, ResultsSeries, ResultsSummary } from "@muselaunch/contracts";
import { RESULTS_MIN_CHART_DAYS } from "@muselaunch/contracts";
import { topPicks, type FeedItem } from "../discover/picks";
import { coverageNote, firstParagraph, isMeasured, plainSource, scopeLine } from "../insights/simple-lines";

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

export type RangeKey = "7" | "28" | "90";
export const RANGES: { value: RangeKey; label: string }[] = [
  { value: "7", label: "Last 7 days" },
  { value: "28", label: "Last 28 days" },
  { value: "90", label: "Last 90 days" },
];
export const isRangeKey = (v: unknown): v is RangeKey => v === "7" || v === "28" || v === "90";

/** Whole UTC days ending today (today included), as the overview reads them. */
export function rangeQuery(range: RangeKey, now = Date.now()): { from: string; to: string } {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(now - (Number(range) - 1) * DAY), to: iso(now) };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const exact = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** 386, 4.2K, 12.4K, 1.2M (the exact number goes in the label next to it). */
export const shortNumber = (v: number) => (Math.abs(v) >= 1000 ? compact.format(v) : exact.format(v));
export const fullNumber = (v: number) => exact.format(v);

export type TileAction =
  | { kind: "home"; label: string }
  | { kind: "connect_youtube"; label: string }
  | { kind: "widen"; label: string }
  | { kind: "sources"; label: string; focus: "manual" | "csv" | "links" };

export type Tile = {
  key: "views" | "clicks" | "posts";
  label: string;
  /** null = not measured yet (never shown as 0). */
  value: number | null;
  /** Where it comes from, in a few words. */
  source: string | null;
  /** e.g. "Total for your whole account" (aggregate numbers aren't credited to a post). */
  scope: string | null;
  /** The one thing that would measure it (only when it isn't measured). */
  action: TileAction | null;
};

export type YouTubeState = "connected" | "can_connect" | "unavailable";

function viewsAction(m: Pick<MissingMetric, "action"> | undefined, youtube: YouTubeState, range: RangeKey): TileAction {
  if (m?.action === "publish_post") return { kind: "home", label: "Post your first video" };
  if (m?.action === "widen_range" && range !== "90") return { kind: "widen", label: "Show 90 days" };
  if (youtube === "can_connect") return { kind: "connect_youtube", label: "Connect YouTube" };
  return { kind: "sources", label: "Add your numbers", focus: "manual" };
}

/** Views, Link clicks, Posts published: measured values only, each with its source, else the one action. */
export function tiles(
  metrics: Pick<InsightMetric, "metric" | "value" | "byCurrency" | "sources" | "attribution">[],
  missing: Pick<MissingMetric, "metric" | "action">[],
  posts: ResultsSummary["postsPublished"] | null,
  youtube: YouTubeState,
  range: RangeKey,
): Tile[] {
  const find = (name: "views" | "clicks") => metrics.find((m) => m.metric === name && isMeasured(m));
  const views = find("views");
  const clicks = find("clicks");
  return [
    views
      ? { key: "views", label: "Views", value: views.value, source: plainSource(views), scope: scopeLine({ metric: "views", attribution: views.attribution }), action: null }
      : { key: "views", label: "Views", value: null, source: null, scope: null, action: viewsAction(missing.find((m) => m.metric === "views"), youtube, range) },
    clicks
      ? { key: "clicks", label: "Link clicks", value: clicks.value, source: plainSource(clicks), scope: null, action: null }
      : { key: "clicks", label: "Link clicks", value: null, source: null, scope: null, action: { kind: "sources", label: "Add a tracked link", focus: "links" } },
    posts
      ? { key: "posts", label: "Posts published", value: posts.value, source: "From your MuseLaunch posts", scope: null, action: null }
      : { key: "posts", label: "Posts published", value: null, source: null, scope: null, action: null },
  ];
}

/** One note under the numbers when views or link clicks only cover part of the range. */
export function coverageLine(metrics: Pick<InsightMetric, "metric" | "value" | "byCurrency" | "coverage">[]): string | null {
  return coverageNote(metrics.filter((m) => (m.metric === "views" || m.metric === "clicks") && isMeasured(m)));
}

/** Nothing measured and nothing posted in the range: the page explains itself instead of showing empty tiles. */
export const nothingYet = (t: Tile[]) => t.every((x) => x.value === null || (x.key === "posts" && x.value === 0));

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

export type ChartBox = { width: number; height: number; pad: { l: number; r: number; t: number; b: number } };

/** The smallest "round" number ≥ v (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ), so the top gridline reads cleanly. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => v <= s * p + 1e-9)!;
  return f * p;
}

export type ChartModel = {
  max: number;
  /** x of every day (measured or not), for the hover crosshair. */
  xs: number[];
  y: (v: number) => number;
  baseline: number;
  /** One line per run of consecutive measured days: a missing day breaks the line. */
  lines: string[];
  areas: string[];
  /** Measured days with no measured neighbour (a 1-day run has no line to show it). */
  dots: { i: number; x: number; y: number }[];
  ticks: { i: number; x: number; label: string }[];
};

export const shortDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

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
  const dots = runs.filter((run) => run.length === 1).map(([i]) => ({ i: i!, x: r(xs[i!]!), y: r(y(points[i!]!.value!)) }));
  const tickIdx = n <= 1 ? [0] : n <= 7 ? points.map((_, i) => i) : [...new Set([0, Math.round((n - 1) / 2), n - 1])];
  const ticks = n ? tickIdx.map((i) => ({ i, x: r(xs[i]!), label: shortDate(points[i]!.date) })) : [];
  return { max, xs, y, baseline, lines, areas, dots, ticks };
}

/** Why there's no chart (one line), or null when it can be drawn. */
export function chartHiddenLine(series: ResultsSeries | null, rangeDays: number): string | null {
  if (!series) return null;
  if (series.measuredDays >= RESULTS_MIN_CHART_DAYS) return null;
  const what = series.metric === "views" ? "views" : "link clicks";
  const have = series.measuredDays === 0 ? "no day" : series.measuredDays === 1 ? "only 1 day" : `only ${series.measuredDays} days`;
  return `A daily chart appears once ${what} are measured on at least ${RESULTS_MIN_CHART_DAYS} days. There’s ${have} with a number in the last ${rangeDays} days so far.`;
}

/** The plain caption over the chart: what it shows and where the numbers come from. */
export function chartCaption(series: ResultsSeries): string {
  const what = series.metric === "views" ? "Views per day" : "Link clicks per day";
  const from = plainSource({ sources: series.sources });
  return from ? `${what} · ${from}` : what;
}

/** Said under the chart when something isn't on it: gaps, and numbers that cover several days. */
export function chartFootnote(series: ResultsSeries): string | null {
  const gaps = series.points.some((p) => p.value === null);
  const parts: string[] = [];
  if (gaps) parts.push("Days without a number are left blank, not counted as zero.");
  if (series.multiDayLeftOut) parts.push(`${series.multiDayLeftOut === 1 ? "1 number covers" : `${series.multiDayLeftOut} numbers cover`} several days at once, so ${series.multiDayLeftOut === 1 ? "it isn’t" : "they aren’t"} on the chart.`);
  return parts.length ? parts.join(" ") : null;
}

// ---------------------------------------------------------------------------
// Best post
// ---------------------------------------------------------------------------

/** "Most views of your 5 posts with numbers · From YouTube.", honest about ties and a single post. */
export function bestPostLine(b: Pick<NonNullable<ResultsSummary["bestPost"]>, "metric" | "comparedPosts" | "tiedWith" | "sources">): string {
  const what = b.metric === "views" ? "views" : "link clicks";
  const line = b.comparedPosts === 1 ? `Your only post with ${what} measured so far` : b.tiedWith ? `Tied for the most ${what} of your ${b.comparedPosts} posts with numbers` : `Most ${what} of your ${b.comparedPosts} posts with numbers`;
  const from = plainSource({ sources: b.sources });
  return `${line}${from ? ` · ${from}` : ""}.`;
}

// ---------------------------------------------------------------------------
// The tip
// ---------------------------------------------------------------------------

export type Tip = {
  title: string;
  body: string;
  /** Where it comes from and the sample size, e.g. "From your test “…”: 6 posts, 230 link clicks in all." */
  basis: string;
  /** Said when the sample is small. */
  caution: string | null;
  kind: "feature" | "promote" | "idea";
  prompt: string;
  button: string;
  from: "test" | "recommendation";
};

const METRIC_WORDS: Record<string, string> = { clicks: "link clicks", views: "views", installs: "installs", trials_started: "free trials", new_subscriptions: "new subscribers", likes: "likes", shares: "shares", saves: "saves", comments: "comments", followers_gained: "new followers", watch_time_sec: "watch time" };
const wordsFor = (metric: string) => METRIC_WORDS[metric] ?? metric.replace(/_/g, " ");
const FEATURE = /\b(feature|demo|walk-?through|how[- ]to|tutorial|show(s|ing)?)\b/i;
/** Wording that claims a cause; a tip with it is not shown (tests and Muse only measure what went together). */
const CAUSAL = /\b(caused|causes|because of|led to|leads to|drove|drives|driving|resulted in|results in|due to|thanks to|is why|will (?:get|bring|increase|boost|double|grow))\b/i;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, "")}…`);

/**
 * From the latest test with enough data: the version with the most of the test's main number,
 * when every version has it measured and one is clearly ahead. Its measured sentence is the body;
 * the sample (posts and total) is always said. Model confidence "insufficient_data" → no tip.
 */
export function tipFromTest(
  exp: Pick<Experiment, "title" | "primaryMetric" | "variants"> | null | undefined,
  result: Pick<ExperimentResult, "confidence" | "measured" | "perVariant"> | null | undefined,
): Tip | null {
  if (!exp || !result || result.confidence === "insufficient_data") return null;
  const measured = result.measured.find((m) => m.text.trim() && m.observationIds.length && !CAUSAL.test(m.text));
  if (!measured) return null;
  const rows = result.perVariant
    .filter((v) => v.key !== "baseline")
    .map((v) => ({ key: v.key, value: v.metrics.find((m) => m.metric === exp.primaryMetric)?.value ?? null }));
  if (rows.length < 2 || rows.some((r) => r.value === null)) return null;
  const max = Math.max(...rows.map((r) => r.value!));
  const leaders = rows.filter((r) => r.value === max);
  if (max <= 0 || leaders.length !== 1) return null;
  const leader = exp.variants.find((v) => v.key === leaders[0]!.key);
  if (!leader) return null;
  const words = wordsFor(exp.primaryMetric);
  const total = rows.reduce((s, r) => s + r.value!, 0);
  const posts = exp.variants.reduce((s, v) => s + v.publicationIds.length, 0);
  const label = leader.label.trim();
  const kind = FEATURE.test(label) ? "feature" : "promote";
  return {
    title: `“${label}” got the most ${words}`,
    body: measured.text.trim(),
    basis: `From your test “${exp.title}”: ${posts ? `${posts} post${posts === 1 ? "" : "s"}, ` : ""}${fullNumber(total)} ${words} in all.`,
    caution: result.confidence === "low" ? "A small sample, so treat it as a hint, not a rule." : null,
    kind,
    prompt: `Another post like “${label}” (it got the most ${words} in my test “${exp.title}”)`,
    button: kind === "feature" ? "Create a feature demo" : "Make another like it",
    from: "test",
  };
}

/** A recommendation from Muse's analysis job, only when it rests on several measured numbers and isn't low confidence. */
export function tipFromRecommendation(rec: Pick<GrowthRecommendation, "title" | "rationale" | "status" | "confidence" | "basedOn" | "proposedExperiment"> | null | undefined): Tip | null {
  if (!rec || rec.status !== "new" || rec.confidence === "low") return null;
  const evidence = rec.basedOn.observationIds.length + rec.basedOn.resultIds.length;
  if (evidence < 3) return null;
  const body = firstParagraph(rec.rationale);
  if (!body || CAUSAL.test(rec.title) || CAUSAL.test(body)) return null;
  const kind = FEATURE.test(`${rec.title} ${body}`) ? "feature" : "promote";
  const versions = rec.proposedExperiment?.variants.length ? `: ${rec.proposedExperiment.variants.join(" vs ")}` : "";
  return {
    title: rec.title,
    body: clip(body, 220),
    basis: `Muse’s suggestion, based on ${evidence} of your measured numbers${rec.basedOn.resultIds.length ? " and test results" : ""}.`,
    caution: null,
    kind,
    prompt: `${rec.title}${versions}`,
    button: kind === "feature" ? "Create a feature demo" : "Try it",
    from: "recommendation",
  };
}

export function pickTip(test: { exp: Parameters<typeof tipFromTest>[0]; result: Parameters<typeof tipFromTest>[1] } | null, recs: Parameters<typeof tipFromRecommendation>[0][]): Tip | null {
  return tipFromTest(test?.exp, test?.result) ?? recs.map(tipFromRecommendation).find(Boolean) ?? null;
}

/** The latest test that has a result (the one "What's working" reads too). */
export function latestTestWithResult<E extends Pick<Experiment, "lastResultId" | "status" | "updatedAt">>(items: E[]): E | undefined {
  return [...items].filter((e) => e.lastResultId && e.status !== "abandoned").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

// ---------------------------------------------------------------------------
// What Muse found
// ---------------------------------------------------------------------------

/** The top 1–2 ideas not used yet, each with a real source; "this week" only when they were all found in the last 7 days. */
export function weekIdeas(items: FeedItem[], now = Date.now(), max = 2): { items: FeedItem[]; thisWeek: boolean } {
  const picks = topPicks(items, items.length).filter((i) => i.status !== "used").slice(0, max);
  const thisWeek = picks.length > 0 && picks.every((i) => now - Date.parse(i.retrievedAt) <= 7 * DAY);
  return { items: picks, thisWeek };
}
