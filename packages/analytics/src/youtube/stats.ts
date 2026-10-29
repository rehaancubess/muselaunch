import type { YouTubeChannelStats, YouTubeGroupStat, YouTubeKeyFinding, YouTubeLengthGroup, YouTubeTitlePattern, YouTubeVideoStat } from "@muselaunch/contracts";
import { parseIsoDuration, ytCount, type YtVideoResource } from "@muselaunch/providers";

/**
 * Deterministic statistics over a channel's recent uploads. Pure functions: every number here is
 * copied from the YouTube Data API response or computed from those numbers (no AI, no estimates).
 */

export const SHORT_MAX_SEC = 60;
export const MID_MAX_SEC = 180;
/** Groups smaller than this are shown but never used for a "pattern" statement. */
export const MIN_GROUP = 3;
const DAY_MS = 86_400_000;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export function lengthGroupOf(durationSec: number | null, wasLive: boolean): YouTubeLengthGroup {
  if (wasLive) return "live";
  if (durationSec === null || durationSec === 0) return "unknown";
  if (durationSec <= SHORT_MAX_SEC) return "short";
  if (durationSec <= MID_MAX_SEC) return "mid";
  return "long";
}

export const LENGTH_LABEL: Record<YouTubeLengthGroup, string> = {
  short: "60 s or less",
  mid: "61 s to 3 min",
  long: "Over 3 min",
  live: "Past live streams",
  unknown: "Length unknown",
};

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_LABEL: Record<(typeof WEEKDAYS)[number], string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
const WEEK_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export interface NormalizedVideos {
  videos: YouTubeVideoStat[];
  excluded: { videoId: string; reason: string }[];
}

/** API resources → per-video stats (order kept: newest first, as the uploads playlist returns them). */
export function normalizeVideos(items: YtVideoResource[], order: string[], fetchedAtMs: number): NormalizedVideos {
  const byId = new Map(items.map((v) => [v.id, v]));
  const videos: YouTubeVideoStat[] = [];
  const excluded: NormalizedVideos["excluded"] = [];
  for (const id of order) {
    const v = byId.get(id);
    if (!v) {
      excluded.push({ videoId: id, reason: "Not returned by videos.list (private, deleted or not public)" });
      continue;
    }
    const live = v.snippet?.liveBroadcastContent;
    if (live === "upcoming" || live === "live") {
      excluded.push({ videoId: id, reason: live === "upcoming" ? "Scheduled premiere or stream (not published yet)" : "Live right now (numbers still changing)" });
      continue;
    }
    const publishedMs = Date.parse(v.snippet?.publishedAt ?? "");
    const views = ytCount(v.statistics?.viewCount);
    if (!Number.isFinite(publishedMs) || views === null) {
      excluded.push({ videoId: id, reason: views === null ? "No public view count" : "No publish date" });
      continue;
    }
    const likes = ytCount(v.statistics?.likeCount);
    const comments = ytCount(v.statistics?.commentCount);
    const durationSec = parseIsoDuration(v.contentDetails?.duration);
    const ageDays = Math.max(0, Math.floor((fetchedAtMs - publishedMs) / DAY_MS));
    videos.push({
      videoId: id,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      title: (v.snippet?.title ?? "").slice(0, 300),
      publishedAt: new Date(publishedMs).toISOString(),
      durationSec,
      lengthGroup: lengthGroupOf(durationSec, Boolean(v.liveStreamingDetails?.actualStartTime)),
      views,
      likes,
      comments,
      engagementRate: likes !== null && comments !== null && views > 0 ? r4((likes + comments) / views) : null,
      ageDays,
      viewsPerDay: r1(views / Math.max(ageDays, 1)),
      vsMedian: null,
    });
  }
  return { videos, excluded };
}

function group(key: string, label: string, vids: YouTubeVideoStat[]): YouTubeGroupStat {
  const er = median(vids.map((v) => v.engagementRate).filter((x): x is number => x !== null));
  const mv = median(vids.map((v) => v.views ?? NaN));
  const mpd = median(vids.map((v) => v.viewsPerDay ?? NaN));
  return {
    key,
    label,
    videos: vids.length,
    medianViews: mv === null ? null : r1(mv),
    medianViewsPerDay: mpd === null ? null : r1(mpd),
    medianEngagementRate: er === null ? null : r4(er),
    videoIds: vids.map((v) => v.videoId).slice(0, 50),
  };
}

export const TITLE_PATTERNS: { key: string; label: string; phrase: string; test: (t: string) => boolean }[] = [
  { key: "question", label: "Asks a question", phrase: "asks a question", test: (t) => t.includes("?") },
  { key: "number", label: "Contains a number", phrase: "contains a number", test: (t) => /\d/.test(t) },
  { key: "howto", label: "Says “how to”", phrase: "says “how to”", test: (t) => /\bhow to\b/i.test(t) },
  { key: "first_person", label: "First person (I, my, we)", phrase: "is in the first person (I, my, we)", test: (t) => /\b(i|i'm|i’m|my|me|we|our)\b/i.test(t) },
  { key: "caps", label: "Has an ALL-CAPS word", phrase: "has an ALL-CAPS word", test: (t) => /\b[A-Z]{3,}\b/.test(t) },
  { key: "emoji", label: "Has an emoji", phrase: "has an emoji", test: (t) => /\p{Extended_Pictographic}/u.test(t) },
  { key: "long", label: "Over 60 characters", phrase: "is over 60 characters long", test: (t) => [...t].length > 60 },
];

/** Stats over normalised videos. Mutates `videos[].vsMedian` (needs the median first). */
export function computeChannelStats(videos: YouTubeVideoStat[], excluded: NormalizedVideos["excluded"], fetchedAtIso: string): YouTubeChannelStats {
  const n = videos.length;
  const medRaw = median(videos.map((v) => v.views ?? NaN));
  const medViews = medRaw === null ? null : r1(medRaw);
  for (const v of videos) v.vsMedian = medViews && v.views !== null ? r2(v.views / medViews) : null;
  const times = videos.map((v) => Date.parse(v.publishedAt)).sort((a, b) => a - b);

  const byLength = (["short", "mid", "long", "live", "unknown"] as const).map((g) => group(`length:${g}`, LENGTH_LABEL[g], videos.filter((v) => v.lengthGroup === g))).filter((g) => g.videos > 0);
  const byWeekday = WEEK_ORDER.map((d) => group(`weekday:${d}`, WEEKDAY_LABEL[d], videos.filter((v) => WEEKDAYS[new Date(v.publishedAt).getUTCDay()] === d))).filter((g) => g.videos > 0);
  const byHour = [0, 4, 8, 12, 16, 20]
    .map((h) => group(`hour:${String(h).padStart(2, "0")}`, `${String(h).padStart(2, "0")}:00–${String(h + 3).padStart(2, "0")}:59 UTC`, videos.filter((v) => Math.floor(new Date(v.publishedAt).getUTCHours() / 4) * 4 === h)))
    .filter((g) => g.videos > 0);
  const titlePatterns: YouTubeTitlePattern[] = TITLE_PATTERNS.map((p) => {
    const w = videos.filter((v) => p.test(v.title));
    const wo = videos.filter((v) => !p.test(v.title));
    return { key: `title:${p.key}`, label: p.label, with: group(`title:${p.key}`, p.label, w), without: group(`title:not_${p.key}`, `Not: ${p.label.toLowerCase()}`, wo) };
  }).filter((p) => p.with.videos > 0 && p.without.videos > 0);

  const gaps = times.slice(1).map((t, i) => (t - times[i]!) / DAY_MS);
  const spanDays = times.length >= 2 ? (times.at(-1)! - times[0]!) / DAY_MS : 0;
  const likesVisible = videos.filter((v) => v.likes !== null);
  const commentsOn = videos.filter((v) => v.comments !== null);
  const engagement = videos.map((v) => v.engagementRate).filter((x): x is number => x !== null);
  const byViews = [...videos].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const byPace = [...videos].sort((a, b) => (b.viewsPerDay ?? 0) - (a.viewsPerDay ?? 0));

  const notes = [
    `From the YouTube Data API: the ${n} most recent public uploads, fetched ${fetchedAtIso.slice(0, 16).replace("T", " ")} UTC.`,
    "Views, likes and comments are lifetime totals at fetch time, so older uploads have had longer to collect them. Views per day evens this out a little.",
    "YouTube's API doesn't say which uploads are Shorts, so uploads are grouped by length only (Shorts can be up to 3 minutes).",
    "Posting days and times are in UTC.",
    `Groups with fewer than ${MIN_GROUP} videos are too small to compare.`,
    "These are patterns in public numbers, not causes: topic, thumbnail, promotion and timing all mix together.",
  ];
  if (n > 0 && n < 10) notes.splice(1, 0, `Small sample (${n} videos): differences can easily be chance.`);
  if (videos.length - likesVisible.length > 0) notes.push(`${videos.length - likesVisible.length} video(s) hide their like count; likes and engagement leave them out.`);

  return {
    videosAnalyzed: n,
    excluded: excluded.slice(0, 50),
    window: times.length ? { firstPublishedAt: new Date(times[0]!).toISOString(), lastPublishedAt: new Date(times.at(-1)!).toISOString() } : null,
    totals: {
      views: videos.reduce((s, v) => s + (v.views ?? 0), 0),
      likes: likesVisible.reduce((s, v) => s + (v.likes ?? 0), 0),
      comments: commentsOn.reduce((s, v) => s + (v.comments ?? 0), 0),
      videosWithHiddenLikes: videos.length - likesVisible.length,
      videosWithCommentsOff: videos.length - commentsOn.length,
    },
    medians: {
      views: medViews,
      likes: likesVisible.length ? r1(median(likesVisible.map((v) => v.likes!))!) : null,
      comments: commentsOn.length ? r1(median(commentsOn.map((v) => v.comments!))!) : null,
      engagementRate: engagement.length ? r4(median(engagement)!) : null,
      viewsPerDay: n ? r1(median(videos.map((v) => v.viewsPerDay ?? NaN))!) : null,
    },
    meanViews: n ? r1(videos.reduce((s, v) => s + (v.views ?? 0), 0) / n) : null,
    topByViews: byViews.slice(0, 5).map((v) => v.videoId),
    topByViewsPerDay: byPace.slice(0, 5).map((v) => v.videoId),
    byLength,
    byWeekday,
    byHour,
    titlePatterns,
    cadence: {
      uploadsPerWeek: times.length >= 2 && spanDays > 0 ? r1((times.length / Math.max(spanDays, 1)) * 7) : null,
      medianDaysBetween: gaps.length ? r1(median(gaps)!) : null,
    },
    notes,
  };
}

const fmt = (n: number | null) => (n === null ? "n/a" : new Intl.NumberFormat("en-US", { maximumFractionDigits: n < 100 ? 1 : 0 }).format(n));
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const quote = (t: string) => `“${t.length > 70 ? `${t.slice(0, 67)}…` : t}”`;

/**
 * Measured statements written by MuseLaunch from the stats (no AI). Each cites the API and fetch time;
 * these become sourced research findings that Discover and Growth Autopilot can use.
 */
export function keyFindings(channelTitle: string, videos: YouTubeVideoStat[], stats: YouTubeChannelStats, fetchedAtIso: string): YouTubeKeyFinding[] {
  const out: YouTubeKeyFinding[] = [];
  const n = stats.videosAnalyzed;
  if (!n) return out;
  const src = `(YouTube Data API, ${n} most recent public uploads, fetched ${day(fetchedAtIso)})`;
  const byId = new Map(videos.map((v) => [v.videoId, v]));
  const best = (ids: string[]) => [...ids].sort((a, b) => (byId.get(b)?.views ?? 0) - (byId.get(a)?.views ?? 0))[0];

  const lengths = stats.byLength.filter((g) => g.key !== "length:unknown" && g.videos >= MIN_GROUP && g.medianViews !== null);
  if (lengths.length >= 2) {
    const parts = lengths.map((g) => `${g.label.toLowerCase()} (${g.videos} videos): median ${fmt(g.medianViews)} views`);
    out.push({ key: "length", statement: `${channelTitle} by video length ${src}: ${parts.join("; ")}. Views are lifetime totals, so older uploads have had longer to collect them.`, videoIds: lengths.map((g) => best(g.videoIds)).filter((x): x is string => Boolean(x)) });
  } else {
    const main = stats.byLength.find((g) => g.videos / n >= 0.7 && g.key !== "length:unknown");
    if (main) out.push({ key: "length", statement: `${channelTitle} mostly posts videos of ${main.label.toLowerCase()}: ${main.videos} of ${n} recent uploads, median ${fmt(main.medianViews)} views ${src}.`, videoIds: [best(main.videoIds)].filter((x): x is string => Boolean(x)) });
  }

  const top = stats.topByViews.slice(0, 3).map((id) => byId.get(id)).filter((v): v is YouTubeVideoStat => Boolean(v));
  if (top.length >= 2 && stats.medians.views !== null) {
    out.push({
      key: "top",
      statement: `${channelTitle}'s most-viewed recent uploads ${src}: ${top.map((v) => `${quote(v.title)} (${fmt(v.views)} views, ${LENGTH_LABEL[v.lengthGroup].toLowerCase()})`).join(", ")}. The median upload had ${fmt(stats.medians.views)} views.`,
      videoIds: top.map((v) => v.videoId),
    });
  }

  const patterns = stats.titlePatterns
    .filter((p) => p.with.videos >= MIN_GROUP && p.without.videos >= MIN_GROUP && p.with.medianViews && p.without.medianViews)
    .map((p) => ({ p, ratio: Math.max(p.with.medianViews!, p.without.medianViews!) / Math.min(p.with.medianViews!, p.without.medianViews!) }))
    .filter((x) => x.ratio >= 1.3)
    .sort((a, b) => b.ratio - a.ratio);
  const pick = patterns[0];
  if (pick) {
    const phrase = TITLE_PATTERNS.find((t) => `title:${t.key}` === pick.p.key)?.phrase ?? pick.p.label.toLowerCase();
    out.push({
      key: "titles",
      statement: `On ${channelTitle}, uploads whose title ${phrase} (${pick.p.with.videos} videos) had a median of ${fmt(pick.p.with.medianViews)} views, against ${fmt(pick.p.without.medianViews)} for the other ${pick.p.without.videos} ${src}.`,
      videoIds: [best(pick.p.with.videoIds)].filter((x): x is string => Boolean(x)),
    });
  }

  if (stats.window && stats.cadence.uploadsPerWeek !== null && n >= 3) {
    const topDay = [...stats.byWeekday].sort((a, b) => b.videos - a.videos)[0];
    out.push({
      key: "cadence",
      statement: `${channelTitle} published ${n} videos between ${day(stats.window.firstPublishedAt)} and ${day(stats.window.lastPublishedAt)} (about ${fmt(stats.cadence.uploadsPerWeek)} a week)${topDay && topDay.videos >= MIN_GROUP ? `; the most common upload day was ${topDay.label} (UTC, ${topDay.videos} videos)` : ""}. Source: YouTube Data API, fetched ${day(fetchedAtIso)}.`,
      videoIds: [],
    });
  }
  return out;
}
