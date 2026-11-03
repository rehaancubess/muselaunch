import type { AttributionLink, MetricObservation, Publication, ResultsBestPost, ResultsMetric, ResultsQuery, ResultsSeries, ResultsSource, ResultsSummary } from "@muselaunch/contracts";
import { RESULTS_MIN_CHART_DAYS } from "@muselaunch/contracts";
import { nowIso, type WorkspaceDb } from "@muselaunch/db";
import type { Platform } from "@muselaunch/platform";
import { computeMetric, loadObservations, resolveRange, type Range } from "./insights";
import { METRIC_INFO, SOURCE_PRIORITY } from "./metrics";
import { DAY_MS, isoDay, utcDayStart } from "./observations";

/**
 * Results ("See what is working"): the parts the overview can't give.
 * - a daily series of the main metric, built only from numbers that cover one UTC day (a weekly
 *   total or a post's lifetime count is never split into days; a day without a number is a gap);
 * - posts published in the range (MuseLaunch's own publication records);
 * - the post with the most of the main metric measured for it (per-post numbers only, never an
 *   account total credited to a post).
 * Every day and every post goes through computeMetric, so source priority and de-duplication are
 * the same as on the overview.
 */

const ms = (iso: string) => Date.parse(iso);
const MAIN: ResultsMetric[] = ["views", "clicks"];

/** A window inside one UTC day (zero-length snapshots count as their day). */
export function isSingleDay(o: Pick<MetricObservation, "windowStart" | "windowEnd">): boolean {
  const s = ms(o.windowStart);
  const e = Math.max(s, ms(o.windowEnd) - 1);
  return utcDayStart(s) === utcDayStart(e);
}

function mergeSources(into: Map<string, ResultsSource>, add: ResultsSource[]) {
  for (const s of add) {
    const cur = into.get(s.source);
    if (cur) into.set(s.source, { ...cur, imported: cur.imported || s.imported, observationCount: cur.observationCount + s.observationCount });
    else into.set(s.source, { ...s });
  }
}

const sortedSources = (m: Map<string, ResultsSource>) => [...m.values()].sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] || b.observationCount - a.observationCount);

const LINK_SOURCE: ResultsSource = { source: "tracked_link", label: "MuseLaunch tracked links", imported: false, observationCount: 0 };

/**
 * One point per UTC day of the range. Clicks only: a day with a MuseLaunch tracked link live and no
 * click recorded is a measured 0 (the redirect counts every click), as on the overview. Nothing
 * else is ever filled in. Days after `now` are left empty.
 */
export function dailySeries(metric: ResultsMetric, all: MetricObservation[], r: Range, opts: { links?: Pick<AttributionLink, "createdAt">[]; now?: number } = {}): ResultsSeries {
  const now = opts.now ?? Date.now();
  const relevant = all.filter((o) => o.metric === metric && ms(o.windowStart) >= r.from && ms(o.windowEnd) <= r.to);
  const byDay = new Map<number, MetricObservation[]>();
  let multiDayLeftOut = 0;
  for (const o of relevant) {
    if (!isSingleDay(o)) {
      multiDayLeftOut++;
      continue;
    }
    const d = utcDayStart(ms(o.windowStart));
    byDay.set(d, [...(byDay.get(d) ?? []), o]);
  }
  const linkStarts = (opts.links ?? []).map((l) => ms(l.createdAt)).filter(Number.isFinite);
  const sources = new Map<string, ResultsSource>();
  const points: ResultsSeries["points"] = [];
  let measuredDays = 0;
  for (let d = utcDayStart(r.from); d < r.to; d += DAY_MS) {
    const day: Range = { from: Math.max(d, r.from), to: Math.min(d + DAY_MS, r.to) };
    const m = computeMetric(metric, byDay.get(d) ?? [], day, {});
    let value = m.value;
    if (value !== null) mergeSources(sources, m.sources.map((s) => ({ source: s.source, label: s.label, imported: s.imported, observationCount: s.observationCount })));
    else if (metric === "clicks" && d <= now && linkStarts.some((t) => t < day.to)) {
      value = 0;
      mergeSources(sources, [LINK_SOURCE]);
    }
    if (value !== null) measuredDays++;
    points.push({ date: isoDay(d), value });
  }
  return { metric, label: METRIC_INFO[metric].label, points, measuredDays, sources: sortedSources(sources), multiDayLeftOut };
}

/** Views, else link clicks: the first with enough days to draw, else the first with any day at all. */
export function pickSeries(views: ResultsSeries, clicks: ResultsSeries): ResultsSeries | null {
  return [views, clicks].find((s) => s.measuredDays >= RESULTS_MIN_CHART_DAYS) ?? [views, clicks].find((s) => s.measuredDays > 0) ?? null;
}

/** A number of the post's own: reported by the platform for it, its tracked link, or user-level attribution. */
const PER_POST = new Set<MetricObservation["attribution"]>(["platform_reported", "link", "direct"]);

export type BestPostPick = Pick<ResultsBestPost, "metric" | "label" | "value" | "sources" | "attribution" | "comparedPosts" | "tiedWith" | "observationIds"> & { publicationId: string };

/**
 * The post with the most views measured for it in the range (else link clicks). Only posts in
 * `published` (this app's publications → publishedAt) count. Nothing above 0 → null (no "best" of
 * zeros). On a tie the newest post is shown and the tie is reported.
 */
export function pickBestPost(all: MetricObservation[], r: Range, published: Map<string, string>): BestPostPick | null {
  for (const metric of MAIN) {
    const byPost = new Map<string, MetricObservation[]>();
    for (const o of all) {
      if (o.metric !== metric || !o.publicationId || !PER_POST.has(o.attribution) || !published.has(o.publicationId)) continue;
      byPost.set(o.publicationId, [...(byPost.get(o.publicationId) ?? []), o]);
    }
    const rows = [...byPost.entries()]
      .map(([publicationId, obs]) => ({ publicationId, m: computeMetric(metric, obs, r, {}) }))
      .filter((x): x is typeof x & { m: { value: number } } => x.m.value !== null);
    if (!rows.length) continue;
    const max = Math.max(...rows.map((x) => x.m.value));
    if (max <= 0) continue;
    const top = rows.filter((x) => x.m.value === max).sort((a, b) => published.get(b.publicationId)!.localeCompare(published.get(a.publicationId)!));
    const best = top[0]!;
    return {
      publicationId: best.publicationId,
      metric,
      label: METRIC_INFO[metric].label,
      value: best.m.value,
      sources: best.m.sources.filter((s) => s.observationCount > 0).map((s) => ({ source: s.source, label: s.label, imported: s.imported, observationCount: s.observationCount })),
      attribution: best.m.attribution,
      comparedPosts: rows.length,
      tiedWith: top.length - 1,
      observationIds: best.m.observationIds,
    };
  }
  return null;
}

/** Posts published (or marked as posted) inside the range, from MuseLaunch's own records. */
export function countPublished(pubs: Pick<Publication, "publishedAt" | "mode">[], r: Range): ResultsSummary["postsPublished"] {
  const inside = pubs.filter((p) => ms(p.publishedAt) >= r.from && ms(p.publishedAt) < r.to);
  const api = inside.filter((p) => p.mode === "api").length;
  return { value: inside.length, api, manual: inside.length - api };
}

/** A post's name for people: its title, else the first line of its caption. */
export function postTitle(post: { title?: string; caption: string } | null, channelLabel: string): string {
  const t = post?.title?.trim();
  if (t) return t.slice(0, 120);
  const line = (post?.caption ?? "").split("\n").map((x) => x.trim()).find(Boolean) ?? "";
  if (!line) return `${channelLabel} post`;
  return line.length > 90 ? `${line.slice(0, 88).replace(/\s+\S*$/, "")}…` : line;
}

async function listPublications(ws: WorkspaceDb, appId: string, cap = 2000): Promise<Publication[]> {
  const out: Publication[] = [];
  let cursor: string | null = null;
  do {
    const page = await ws.collection("publications").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 500, cursor });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && out.length < cap);
  return out;
}

const CHANNEL_WORD: Record<string, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", x: "X" };

export async function resultsSummary(p: Platform, workspaceId: string, appId: string, q: ResultsQuery, now = Date.now()): Promise<ResultsSummary> {
  const ws = p.db.ws(workspaceId);
  await ws.collection("apps").getOrThrow(appId);
  const r = resolveRange(q, now);
  const [{ items }, pubs, links] = await Promise.all([
    loadObservations(ws, appId, r.from, r.to),
    listPublications(ws, appId),
    ws.collection("attributionLinks").list({ where: [["appId", "==", appId]], limit: 500 }),
  ]);
  const views = dailySeries("views", items, r, { now });
  const clicks = dailySeries("clicks", items, r, { links: links.items, now });

  const published = new Map(pubs.map((x) => [x.id, x.publishedAt]));
  const pick = pickBestPost(items, r, published);
  let bestPost: ResultsBestPost | null = null;
  if (pick) {
    const pub = pubs.find((x) => x.id === pick.publicationId)!;
    const post = await ws.collection("scheduledPosts").get(pub.scheduledPostId);
    let thumbnailAssetId = post?.thumbnailAssetId;
    if (!thumbnailAssetId && post?.assetIds[0]) {
      const first = await ws.collection("mediaAssets").get(post.assetIds[0]);
      thumbnailAssetId = first?.kind === "image" ? first.id : first?.posterAssetId;
    }
    const { publicationId, ...rest } = pick;
    bestPost = {
      ...rest,
      publicationId,
      scheduledPostId: pub.scheduledPostId,
      channel: pub.channel,
      title: postTitle(post, CHANNEL_WORD[pub.channel] ?? "Your"),
      thumbnailAssetId,
      remoteUrl: pub.remoteUrl,
      publishedAt: pub.publishedAt,
    };
  }
  return {
    appId,
    range: { from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString(), timezone: "UTC" },
    series: pickSeries(views, clicks),
    postsPublished: countPublished(pubs, r),
    bestPost,
    generatedAt: nowIso(),
  };
}
