import { AppError } from "@muselaunch/platform";
import { registerSocialInsightsAdapter, type SocialInsightsAdapter, type SocialInsightsRequest, type SocialPostInsight } from "./social";

/**
 * YouTube Data API v3 (public channel/video data) and YouTube Analytics API v2 (owner-only per-video
 * metrics). Owner: module F.
 *
 * Data API (https://developers.google.com/youtube/v3/docs), API key or OAuth bearer:
 * - GET /channels?part=snippet,contentDetails,statistics&forHandle=@x | id=UC… | forUsername=…  (1 unit)
 * - GET /playlistItems?part=contentDetails&playlistId=<uploads>&maxResults≤50                 (1 unit)
 * - GET /videos?part=snippet,contentDetails,statistics,liveStreamingDetails&id=a,b,…(≤50)      (1 unit)
 *   statistics.* are strings (uint64); likeCount is absent when likes are hidden, commentCount when
 *   comments are off; contentDetails.duration is ISO 8601 (PT1M3S, P1DT2H, P0D for live).
 * Analytics API (https://developers.google.com/youtube/analytics/reference/reports/query), OAuth
 * scope yt-analytics.readonly: GET /v2/reports?ids=channel==MINE&startDate&endDate&metrics&filters=video==ID
 * → `{ kind: "youtubeAnalytics#resultTable", columnHeaders: [{ name, columnType, dataType }], rows: [[…]] }`.
 *
 * The API key is sent in the `x-goog-api-key` header (Google's documented alternative to `?key=`), so
 * it never appears in a URL, log line or error message.
 */

export const YOUTUBE_DATA_API_BASE = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_ANALYTICS_REPORTS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";
export const YT_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const YT_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";
/** Documented quota cost of channels.list, playlistItems.list and videos.list. */
export const YOUTUBE_LIST_UNITS = 1;
export const YOUTUBE_DATA_MODEL = "youtube-data-api-v3";
export const YOUTUBE_ANALYTICS_MODEL = "youtube-analytics-api-v2";

// ---------------------------------------------------------------------------
// Input parsing (channel URL, @handle, channel id, video URL)
// ---------------------------------------------------------------------------

export type YouTubeChannelRef =
  | { kind: "id"; value: string }
  | { kind: "handle"; value: string; fromCustomUrl?: boolean }
  | { kind: "username"; value: string }
  | { kind: "video"; value: string };

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HANDLE = /^[\p{L}\p{N}._-]{3,30}$/u;
const YT_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com"];

const badInput = (why: string) =>
  new AppError("BAD_REQUEST", `Not a YouTube channel reference: ${why}`, { retryable: false, userMessage: "Paste a YouTube channel link, an @handle or a channel ID (starts with UC)." });

/** Video id from a YouTube URL (watch?v=, youtu.be/, /shorts/, /live/, /embed/), else null. */
export function youtubeVideoIdFromUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (!YT_HOSTS.includes(host)) return null;
  const segs = u.pathname.split("/").filter(Boolean);
  const id = host === "youtu.be" ? segs[0] : segs[0] === "watch" ? u.searchParams.get("v") : ["shorts", "live", "embed", "v"].includes(segs[0] ?? "") ? segs[1] : null;
  return id && VIDEO_ID.test(id) ? id : null;
}

/** Parse what a user pasted. Throws BAD_REQUEST (with a plain userMessage) when it isn't usable. */
export function parseYouTubeChannelInput(raw: string): YouTubeChannelRef {
  const s = raw.trim().replace(/^<|>$/g, "");
  if (!s) throw badInput("empty");
  if (CHANNEL_ID.test(s)) return { kind: "id", value: s };
  if (s.startsWith("@")) {
    const h = s.slice(1);
    if (!HANDLE.test(h)) throw badInput("invalid handle");
    return { kind: "handle", value: `@${h}` };
  }
  const looksLikeUrl = /^https?:\/\//i.test(s) || /^(www\.|m\.)?(youtube\.com|youtu\.be)\b/i.test(s);
  if (looksLikeUrl) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      throw badInput("invalid URL");
    }
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
    if (!YT_HOSTS.includes(host)) throw badInput("not a youtube.com link");
    const video = youtubeVideoIdFromUrl(u.toString());
    if (video) return { kind: "video", value: video };
    const segs = u.pathname.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
    const first = segs[0] ?? "";
    if (first.startsWith("@") && HANDLE.test(first.slice(1))) return { kind: "handle", value: first };
    if (first === "channel" && segs[1] && CHANNEL_ID.test(segs[1])) return { kind: "id", value: segs[1] };
    if (first === "user" && segs[1] && /^[A-Za-z0-9._-]{1,100}$/.test(segs[1])) return { kind: "username", value: segs[1] };
    // Legacy custom URLs (/c/name) have no API lookup; most now resolve as handles.
    if (first === "c" && segs[1] && HANDLE.test(segs[1])) return { kind: "handle", value: `@${segs[1]}`, fromCustomUrl: true };
    if (first === "playlist") throw badInput("playlist link");
    throw badInput("unrecognised YouTube link");
  }
  if (HANDLE.test(s)) return { kind: "handle", value: `@${s}` };
  throw badInput("unrecognised input");
}

// ---------------------------------------------------------------------------
// Response shapes (documented fields we read)
// ---------------------------------------------------------------------------

export interface YtChannelResource {
  id: string;
  snippet?: { title?: string; description?: string; customUrl?: string; publishedAt?: string; country?: string; thumbnails?: Record<string, { url?: string }> };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
  statistics?: { viewCount?: string; subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string };
}

export interface YtPlaylistItem {
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}

export interface YtVideoResource {
  id: string;
  etag?: string;
  snippet?: { publishedAt?: string; channelId?: string; title?: string; liveBroadcastContent?: string };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  liveStreamingDetails?: { actualStartTime?: string; actualEndTime?: string; scheduledStartTime?: string };
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; errors?: { reason?: string; message?: string; domain?: string }[]; details?: { "@type"?: string; reason?: string }[] };
}

/** uint64-as-string → number (null when absent or not a finite non-negative number). */
export function ytCount(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** ISO 8601 duration (PT1H2M3S, P1DT2H, P0D) → whole seconds, or null when unparseable. */
export function parseIsoDuration(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m || s.trim() === "P" || s.trim().endsWith("T")) return null;
  const [, w, d, h, min, sec] = m;
  return Math.round(Number(w ?? 0) * 604_800 + Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(sec ?? 0));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Map Google error envelopes to AppError with plain user messages. Never includes the URL or key. */
export function mapYouTubeError(status: number, body: GoogleErrorBody | null, api: "YouTube Data API" | "YouTube Analytics API", method: string, auth: "key" | "oauth"): AppError {
  const e = body?.error;
  const reasons = [...(e?.errors ?? []).map((x) => x.reason), ...(e?.details ?? []).map((x) => x.reason)].filter((x): x is string => Boolean(x));
  const has = (...r: string[]) => reasons.some((x) => r.includes(x));
  const msg = `${api} ${method} failed (${status}${reasons.length ? ` ${reasons.join(",")}` : ""}): ${(e?.message ?? "").slice(0, 300)}`;
  const details = { provider: "youtube", api, method, status, reasons };
  if (has("quotaExceeded", "dailyLimitExceeded", "dailyLimitExceededUnreg")) {
    return new AppError("RATE_LIMITED", msg, { retryable: false, details, userMessage: "MuseLaunch has used today's YouTube API quota. It resets at midnight Pacific Time; try again after that." });
  }
  if (status === 429 || has("rateLimitExceeded", "userRateLimitExceeded")) return new AppError("RATE_LIMITED", msg, { retryable: true, details, userMessage: "YouTube is rate-limiting requests. MuseLaunch will retry shortly." });
  if (status >= 500) return new AppError("PROVIDER_UNAVAILABLE", msg, { retryable: true, details, userMessage: "YouTube is temporarily unavailable. MuseLaunch will retry." });
  if (auth === "key" && (has("keyInvalid", "API_KEY_INVALID", "keyExpired", "API_KEY_EXPIRED") || (status === 400 && /api key/i.test(e?.message ?? "")))) {
    return new AppError("PROVIDER_NOT_CONFIGURED", msg, { retryable: false, details, userMessage: "YouTube rejected this deployment's API key (YOUTUBE_API_KEY). Ask the operator to check it." });
  }
  if (has("accessNotConfigured", "SERVICE_DISABLED")) {
    return new AppError("PROVIDER_NOT_CONFIGURED", msg, { retryable: false, details, userMessage: `The ${api} isn't enabled in this deployment's Google Cloud project.` });
  }
  if (has("API_KEY_SERVICE_BLOCKED", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED", "API_KEY_ANDROID_APP_BLOCKED", "API_KEY_IOS_APP_BLOCKED", "ipRefererBlocked")) {
    return new AppError("PROVIDER_NOT_CONFIGURED", msg, { retryable: false, details, userMessage: "The YouTube API key's restrictions block this server. Ask the operator to allow the YouTube Data API v3 for it." });
  }
  if (has("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientScope")) {
    return new AppError("PROVIDER_ERROR", msg, { retryable: false, details: { ...details, missingScope: true }, userMessage: "The YouTube connection is missing a permission. Reconnect YouTube and allow all requested access." });
  }
  if (status === 401) {
    return auth === "oauth"
      ? new AppError("PROVIDER_ERROR", msg, { retryable: false, details: { ...details, reconnect: true }, userMessage: "YouTube rejected the saved connection. Please reconnect YouTube." })
      : new AppError("PROVIDER_NOT_CONFIGURED", msg, { retryable: false, details, userMessage: "YouTube rejected this deployment's API key (YOUTUBE_API_KEY)." });
  }
  if (status === 404 || has("channelNotFound", "videoNotFound", "playlistNotFound")) return new AppError("NOT_FOUND", msg, { retryable: false, details, userMessage: "YouTube couldn't find that channel or video." });
  if (status === 403) return new AppError("PROVIDER_ERROR", msg, { retryable: false, details, userMessage: `YouTube refused this request (${reasons[0] ?? "forbidden"}).` });
  return new AppError("PROVIDER_ERROR", msg, { retryable: false, details });
}

// ---------------------------------------------------------------------------
// Data API client
// ---------------------------------------------------------------------------

export interface YouTubeCall {
  api: "YouTube Data API" | "YouTube Analytics API";
  method: string;
  units: number;
  status: "ok" | "error";
  ms: number;
  errorCode?: string;
}

export interface YouTubeClientOptions {
  /** Public data: API key (sent as x-goog-api-key). */
  apiKey?: string;
  /** Owner data: OAuth access token. */
  accessToken?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called after every request (metering: usage rows + quota units). */
  onCall?: (c: YouTubeCall) => void;
}

export class YouTubeDataClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: YouTubeClientOptions) {
    if (!opts.apiKey && !opts.accessToken) throw new AppError("PROVIDER_NOT_CONFIGURED", "YouTube API key missing (YOUTUBE_API_KEY)", { retryable: false, userMessage: "YouTube analysis isn't set up on this deployment yet (YOUTUBE_API_KEY is missing)." });
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private get auth(): "key" | "oauth" {
    return this.opts.accessToken ? "oauth" : "key";
  }

  /** GET a Google JSON endpoint; maps errors; reports the call for metering. */
  async request<T>(api: YouTubeCall["api"], url: string, method: string, query: Record<string, string | undefined>, units: number): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.opts.accessToken) headers.authorization = `Bearer ${this.opts.accessToken}`;
    else headers["x-goog-api-key"] = this.opts.apiKey!;
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 20_000);
    const signal = this.opts.signal ? AbortSignal.any([this.opts.signal, timeout]) : timeout;
    const started = Date.now();
    const report = (status: "ok" | "error", errorCode?: string) => this.opts.onCall?.({ api, method, units, status, ms: Date.now() - started, errorCode });
    let res: Response;
    try {
      res = await this.fetchImpl(u.toString(), { method: "GET", headers, signal, redirect: "manual" });
    } catch (err) {
      if (this.opts.signal?.aborted) {
        report("error", "CANCELLED");
        throw new AppError("CANCELLED", `${api} ${method} cancelled`);
      }
      const timedOut = timeout.aborted;
      report("error", timedOut ? "TIMEOUT" : "PROVIDER_UNAVAILABLE");
      throw new AppError(timedOut ? "TIMEOUT" : "PROVIDER_UNAVAILABLE", `${api} ${method}: ${timedOut ? "timed out" : `network error (${(err as Error).message})`}`, { retryable: true, details: { provider: "youtube", api, method } });
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = mapYouTubeError(res.status, json as GoogleErrorBody | null, api, method, this.auth);
      report("error", err.code);
      throw err;
    }
    if (json === null || typeof json !== "object") {
      report("error", "PROVIDER_ERROR");
      throw new AppError("PROVIDER_ERROR", `${api} ${method}: expected JSON`, { retryable: false });
    }
    report("ok");
    return json as T;
  }

  /** channels.list for one channel reference (null when YouTube has no such channel). */
  async channel(ref: Exclude<YouTubeChannelRef, { kind: "video" }> | { kind: "id"; value: string }): Promise<YtChannelResource | null> {
    const filter = ref.kind === "id" ? { id: ref.value } : ref.kind === "handle" ? { forHandle: ref.value } : { forUsername: ref.value };
    const res = await this.request<{ items?: YtChannelResource[] }>("YouTube Data API", `${YOUTUBE_DATA_API_BASE}/channels`, "channels.list", { part: "snippet,contentDetails,statistics", ...filter, maxResults: "1" }, YOUTUBE_LIST_UNITS);
    return res.items?.[0] ?? null;
  }

  /** playlistItems.list: the newest `max` (≤50) video ids of a playlist (one page). */
  async playlistVideos(playlistId: string, max: number): Promise<{ videoId: string; videoPublishedAt?: string }[]> {
    const res = await this.request<{ items?: YtPlaylistItem[] }>("YouTube Data API", `${YOUTUBE_DATA_API_BASE}/playlistItems`, "playlistItems.list", { part: "contentDetails", playlistId, maxResults: String(Math.min(50, Math.max(1, max))) }, YOUTUBE_LIST_UNITS);
    return (res.items ?? []).map((i) => ({ videoId: i.contentDetails?.videoId ?? "", videoPublishedAt: i.contentDetails?.videoPublishedAt })).filter((i) => VIDEO_ID.test(i.videoId));
  }

  /** videos.list for up to 50 ids. */
  async videos(ids: string[], parts = "snippet,contentDetails,statistics,liveStreamingDetails"): Promise<YtVideoResource[]> {
    const list = [...new Set(ids.filter((id) => VIDEO_ID.test(id)))].slice(0, 50);
    if (!list.length) return [];
    const res = await this.request<{ items?: YtVideoResource[] }>("YouTube Data API", `${YOUTUBE_DATA_API_BASE}/videos`, "videos.list", { part: parts, id: list.join(","), maxResults: "50" }, YOUTUBE_LIST_UNITS);
    return res.items ?? [];
  }

  /** YouTube Analytics reports.query, one row of totals for a single video (OAuth + yt-analytics.readonly). */
  async videoReport(videoId: string, startDate: string, endDate: string, metrics: string[]): Promise<Record<string, number> | null> {
    const res = await this.request<{ columnHeaders?: { name?: string }[]; rows?: unknown[][] }>(
      "YouTube Analytics API",
      YOUTUBE_ANALYTICS_REPORTS_URL,
      "reports.query",
      { ids: "channel==MINE", startDate, endDate, metrics: metrics.join(","), filters: `video==${videoId}` },
      0,
    );
    const row = res.rows?.[0];
    if (!row || !res.columnHeaders?.length) return null;
    const out: Record<string, number> = {};
    res.columnHeaders.forEach((h, i) => {
      const v = row[i];
      if (h.name && typeof v === "number" && Number.isFinite(v)) out[h.name] = v;
    });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Social insights adapter (videos MuseLaunch published to a connected channel)
// ---------------------------------------------------------------------------

const DATA_DEFS = {
  views: "YouTube Data API statistics.viewCount: the number of times the video has been viewed. Lifetime total at fetch time.",
  likes: "YouTube Data API statistics.likeCount: the number of users who have indicated that they liked the video. Lifetime total at fetch time.",
  comments: "YouTube Data API statistics.commentCount: the number of comments for the video. Lifetime total at fetch time.",
} as const;

const ANALYTICS_METRICS = ["views", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "shares", "subscribersGained"] as const;

/** Analytics metrics stored as observations. views/likes/comments come from the Data API instead (lifetime, not delayed), so a post never has two values for one metric. */
const ANALYTICS_MAP: { name: (typeof ANALYTICS_METRICS)[number]; metric: SocialPostInsight["metric"]; scale: number; def: string }[] = [
  { name: "estimatedMinutesWatched", metric: "watch_time_sec", scale: 60, def: "YouTube Analytics estimatedMinutesWatched: the number of minutes that users watched the video (shown in seconds)." },
  { name: "averageViewDuration", metric: "avg_view_duration_sec", scale: 1, def: "YouTube Analytics averageViewDuration: the average length, in seconds, of video playbacks." },
  { name: "shares", metric: "shares", scale: 1, def: "YouTube Analytics shares: the number of times that users shared the video through the Share button." },
  { name: "subscribersGained", metric: "followers_gained", scale: 1, def: "YouTube Analytics subscribersGained: the number of times that users subscribed to the channel, in the report filtered to this video." },
];

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function createYouTubeInsightsAdapter(defaultFetch?: typeof fetch): SocialInsightsAdapter {
  return {
    provider: "youtube",
    async fetchPostInsights({ account, accessToken, publication, signal, fetch: f, onRequest, onNote }) {
      const videoId = (publication.remoteId && VIDEO_ID.test(publication.remoteId) ? publication.remoteId : null) ?? youtubeVideoIdFromUrl(publication.remoteUrl);
      if (!videoId) throw new AppError("BAD_REQUEST", `Publication ${publication.id} has no YouTube video id`, { retryable: false, userMessage: "This post has no YouTube video link to read stats from." });
      const onCall = (c: YouTubeCall) => onRequest?.({ api: c.api, method: c.method, status: c.status, ms: c.ms, quotaUnits: c.units || undefined, errorCode: c.errorCode } satisfies SocialInsightsRequest);
      const yt = new YouTubeDataClient({ accessToken, fetch: f ?? defaultFetch, signal, onCall });
      const [video] = await yt.videos([videoId], "snippet,statistics");
      if (!video) throw new AppError("NOT_FOUND", `YouTube video ${videoId} not found`, { retryable: false, userMessage: "YouTube no longer returns this video (deleted, private or not visible to the connected account)." });
      if (account.externalAccountId && video.snippet?.channelId && video.snippet.channelId !== account.externalAccountId) {
        throw new AppError("BAD_REQUEST", `Video ${videoId} belongs to channel ${video.snippet.channelId}, not ${account.externalAccountId}`, { retryable: false, details: { otherChannel: true }, userMessage: "This video isn't on the connected YouTube channel." });
      }
      const fetchedAt = Date.now();
      const startMs = Date.parse(video.snippet?.publishedAt ?? publication.publishedAt);
      const windowStart = new Date(Number.isFinite(startMs) && startMs < fetchedAt ? startMs : fetchedAt - 1000).toISOString();
      const windowEnd = new Date(fetchedAt).toISOString();
      const out: SocialPostInsight[] = [];
      for (const metric of ["views", "likes", "comments"] as const) {
        const raw = metric === "views" ? video.statistics?.viewCount : metric === "likes" ? video.statistics?.likeCount : video.statistics?.commentCount;
        const value = ytCount(raw);
        if (value === null) {
          if (metric !== "views") onNote?.(`${metric === "likes" ? "Likes are hidden" : "Comments are off"} on video ${videoId}; not reported.`);
          continue;
        }
        out.push({ metric, value, definition: DATA_DEFS[metric], windowStart, windowEnd, apiRequestId: video.etag ? `etag:${video.etag}`.slice(0, 200) : undefined });
      }
      if (!account.scopes.includes(YT_ANALYTICS_SCOPE)) {
        onNote?.("Watch time, average view duration, shares and subscribers need YouTube Analytics access: reconnect YouTube to grant it.");
        return out;
      }
      const startDate = isoDate(Date.parse(windowStart));
      const endDate = isoDate(fetchedAt);
      let report: Record<string, number> | null;
      try {
        report = await yt.videoReport(videoId, startDate, endDate, [...ANALYTICS_METRICS]);
      } catch (raw) {
        const err = raw instanceof AppError ? raw : new AppError("PROVIDER_ERROR", String(raw));
        if ((err.opts.details as { missingScope?: boolean } | undefined)?.missingScope || err.code === "PROVIDER_NOT_CONFIGURED") {
          onNote?.(`YouTube Analytics wasn't available for video ${videoId}: ${err.toInfo().userMessage ?? err.message}`.slice(0, 300));
          return out;
        }
        throw err;
      }
      if (!report) {
        onNote?.(`YouTube Analytics has no data yet for video ${videoId} (${startDate} to ${endDate}); it usually lags by a few days.`);
        return out;
      }
      for (const m of ANALYTICS_MAP) {
        const v = report[m.name];
        if (v === undefined) continue;
        out.push({ metric: m.metric, value: Math.round(v * m.scale * 100) / 100, definition: `${m.def} Report range ${startDate} to ${endDate}; YouTube Analytics data can lag by a few days.`, windowStart, windowEnd });
      }
      return out;
    },
  };
}

registerSocialInsightsAdapter(createYouTubeInsightsAdapter());
