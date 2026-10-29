import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ConnectedAccount, Publication } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { FakeFetch } from "../publishing/fake-fetch";
import { socialInsightsAdapter } from "./social";
import { createYouTubeInsightsAdapter, parseIsoDuration, parseYouTubeChannelInput, YouTubeDataClient, youtubeVideoIdFromUrl, YT_ANALYTICS_SCOPE, type YouTubeCall } from "./youtube";

/** Documented response shapes with synthetic values (fixtures/analytics/youtube-data-api.json). Not live data. */
// biome-ignore lint/suspicious/noExplicitAny: fixture JSON
const fx = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../fixtures/analytics/youtube-data-api.json", import.meta.url)), "utf8")) as Record<string, any>;
const KEY = "AIzaFIXTURE_NOT_A_REAL_KEY_000000000000";
const asFetch = (f: FakeFetch) => f.fetch as unknown as typeof fetch;

describe("parseYouTubeChannelInput", () => {
  it("accepts channel links, handles, ids and video links", () => {
    expect(parseYouTubeChannelInput("UCFIXTUREfocus0000000001")).toEqual({ kind: "id", value: "UCFIXTUREfocus0000000001" });
    expect(parseYouTubeChannelInput("@fixturefocus")).toEqual({ kind: "handle", value: "@fixturefocus" });
    expect(parseYouTubeChannelInput("fixturefocus")).toEqual({ kind: "handle", value: "@fixturefocus" });
    expect(parseYouTubeChannelInput("https://www.youtube.com/@fixturefocus/videos")).toEqual({ kind: "handle", value: "@fixturefocus" });
    expect(parseYouTubeChannelInput("youtube.com/channel/UCFIXTUREfocus0000000001")).toEqual({ kind: "id", value: "UCFIXTUREfocus0000000001" });
    expect(parseYouTubeChannelInput("https://m.youtube.com/user/FixtureLegacy")).toEqual({ kind: "username", value: "FixtureLegacy" });
    expect(parseYouTubeChannelInput("https://www.youtube.com/c/FixtureFocus")).toEqual({ kind: "handle", value: "@FixtureFocus", fromCustomUrl: true });
    expect(parseYouTubeChannelInput("https://youtu.be/FXvid000001?t=3")).toEqual({ kind: "video", value: "FXvid000001" });
    expect(parseYouTubeChannelInput("https://www.youtube.com/shorts/FXvid000002")).toEqual({ kind: "video", value: "FXvid000002" });
    expect(parseYouTubeChannelInput("https://www.youtube.com/watch?v=FXvid000003&list=x")).toEqual({ kind: "video", value: "FXvid000003" });
  });

  it("rejects other sites, playlists and junk with a plain message", () => {
    for (const bad of ["https://vimeo.com/fixture", "https://www.youtube.com/playlist?list=PL1", "https://evil.example/@fixturefocus", "hi", "@a", "not a channel at all!"]) {
      let caught: unknown;
      try {
        parseYouTubeChannelInput(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught, bad).toMatchObject({ code: "BAD_REQUEST", opts: { userMessage: expect.stringContaining("YouTube channel link") } });
    }
  });

  it("reads video ids and ISO 8601 durations", () => {
    expect(youtubeVideoIdFromUrl("https://www.youtube.com/watch?v=FXvid000001")).toBe("FXvid000001");
    expect(youtubeVideoIdFromUrl("https://example.com/watch?v=FXvid000001")).toBeNull();
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("PT12M4S")).toBe(724);
    expect(parseIsoDuration("PT1H2M")).toBe(3720);
    expect(parseIsoDuration("P1DT2H")).toBe(93_600);
    expect(parseIsoDuration("P0D")).toBe(0);
    expect(parseIsoDuration("nonsense")).toBeNull();
  });
});

describe("YouTubeDataClient", () => {
  it("sends the key as a header (never in the URL), reads the documented shapes and reports quota units", async () => {
    const f = new FakeFetch()
      .on("GET", "https://www.googleapis.com/youtube/v3/channels", { json: fx.channels })
      .on("GET", "https://www.googleapis.com/youtube/v3/playlistItems", { json: fx.playlistItems })
      .on("GET", "https://www.googleapis.com/youtube/v3/videos", { json: fx.videos });
    const calls: YouTubeCall[] = [];
    const yt = new YouTubeDataClient({ apiKey: KEY, fetch: asFetch(f), onCall: (c) => calls.push(c) });
    const ch = await yt.channel({ kind: "handle", value: "@fixturefocus" });
    expect(ch?.contentDetails?.relatedPlaylists?.uploads).toBe("UUFIXTUREfocus0000000001");
    const ids = await yt.playlistVideos("UUFIXTUREfocus0000000001", 50);
    expect(ids).toHaveLength(12);
    const vids = await yt.videos(ids.map((i) => i.videoId));
    expect(vids).toHaveLength(11);
    expect(f.requests.every((r) => !r.url.includes(KEY) && r.headers["x-goog-api-key"] === KEY && !r.headers.authorization)).toBe(true);
    expect(new URL(f.requests[0]!.url).searchParams.get("forHandle")).toBe("@fixturefocus");
    expect(new URL(f.requests[0]!.url).searchParams.get("part")).toBe("snippet,contentDetails,statistics");
    expect(new URL(f.requests[1]!.url).searchParams.get("maxResults")).toBe("50");
    expect(new URL(f.requests[2]!.url).searchParams.get("id")?.split(",")).toHaveLength(12);
    expect(calls.map((c) => [c.method, c.units, c.status])).toEqual([
      ["channels.list", 1, "ok"],
      ["playlistItems.list", 1, "ok"],
      ["videos.list", 1, "ok"],
    ]);
  });

  it("maps Google errors to honest codes without echoing the key", async () => {
    const quota = new FakeFetch().on("GET", "https://www.googleapis.com/youtube/v3/channels", { status: 403, json: fx.errors.quotaExceeded });
    const err1 = await new YouTubeDataClient({ apiKey: KEY, fetch: asFetch(quota) }).channel({ kind: "id", value: fx.channelId }).catch((e) => e);
    expect(err1).toMatchObject({ code: "RATE_LIMITED", retryable: false, opts: { userMessage: expect.stringContaining("quota") } });
    const bad = new FakeFetch().on("GET", "https://www.googleapis.com/youtube/v3/channels", { status: 400, json: fx.errors.keyInvalid });
    const err2 = await new YouTubeDataClient({ apiKey: KEY, fetch: asFetch(bad) }).channel({ kind: "id", value: fx.channelId }).catch((e) => e);
    expect(err2).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED", retryable: false });
    expect(JSON.stringify({ m: err2.message, i: err2.toInfo() })).not.toContain(KEY);
    const down = new FakeFetch().on("GET", "https://www.googleapis.com/youtube/v3/channels", { status: 503, json: { error: { code: 503, message: "backend error" } } });
    expect(await new YouTubeDataClient({ apiKey: KEY, fetch: asFetch(down) }).channel({ kind: "id", value: fx.channelId }).catch((e) => e)).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(() => new YouTubeDataClient({})).toThrow(/YOUTUBE_API_KEY/);
  });

  it("returns null for an unknown channel (empty items)", async () => {
    const f = new FakeFetch().on("GET", "https://www.googleapis.com/youtube/v3/channels", { json: fx.channelsEmpty });
    expect(await new YouTubeDataClient({ apiKey: KEY, fetch: asFetch(f) }).channel({ kind: "handle", value: "@nobody-here" })).toBeNull();
  });
});

describe("YouTube social insights adapter", () => {
  const account = (scopes: string[]): ConnectedAccount => ({
    id: "acc_yt",
    workspaceId: "ws1",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    createdBy: "alice",
    appId: "app1",
    provider: "youtube",
    purposes: ["publishing", "analytics"],
    externalAccountId: fx.channelId,
    displayName: "Fixture Focus Apps",
    scopes,
    status: "connected",
    capabilities: ["publish_video", "read_insights"],
    limitations: [],
    connectedBy: "alice",
  });
  const pub: Publication = {
    id: "pub_1",
    workspaceId: "ws1",
    createdAt: "2026-10-27T15:00:00.000Z",
    updatedAt: "2026-10-27T15:00:00.000Z",
    createdBy: "job:1",
    appId: "app1",
    campaignId: "cpg_1",
    scheduledPostId: "pst_1",
    channel: "youtube",
    mode: "api",
    remoteId: "FXvid000001",
    remoteUrl: "https://www.youtube.com/watch?v=FXvid000001",
    publishedAt: "2026-10-27T15:00:00.000Z",
  };
  const oneVideo = { ...fx.videos, items: [fx.videos.items[0]] };

  it("is registered for YouTube", () => {
    expect(socialInsightsAdapter("youtube")?.provider).toBe("youtube");
  });

  it("reads Data API stats and YouTube Analytics metrics, each with the platform's definition", async () => {
    const f = new FakeFetch().on("GET", "https://www.googleapis.com/youtube/v3/videos", { json: oneVideo }).on("GET", "https://youtubeanalytics.googleapis.com/v2/reports", { json: fx.analyticsReport });
    const reqs: string[] = [];
    const out = await createYouTubeInsightsAdapter().fetchPostInsights({ account: account([YT_ANALYTICS_SCOPE]), accessToken: "ya29.FIXTURE", publication: pub, fetch: asFetch(f), onRequest: (r) => reqs.push(`${r.method}:${r.quotaUnits ?? 0}`) });
    const by = Object.fromEntries(out.map((i) => [i.metric, i]));
    expect(by.views?.value).toBe(15400);
    expect(by.likes?.value).toBe(820);
    expect(by.comments?.value).toBe(64);
    expect(by.watch_time_sec?.value).toBe(2310 * 60);
    expect(by.avg_view_duration_sec?.value).toBe(94);
    expect(by.shares?.value).toBe(9);
    expect(by.followers_gained?.value).toBe(4);
    expect(out.every((i) => i.definition.startsWith("YouTube ") && i.windowStart === "2026-10-27T15:00:00.000Z")).toBe(true);
    expect(by.views!.definition).toContain("statistics.viewCount");
    expect(by.watch_time_sec!.definition).toContain("estimatedMinutesWatched");
    const report = new URL(f.calls("GET", "https://youtubeanalytics.googleapis.com/v2/reports")[0]!.url);
    expect(Object.fromEntries(report.searchParams)).toMatchObject({ ids: "channel==MINE", startDate: "2026-10-27", metrics: "views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained", filters: "video==FXvid000001" });
    expect(f.requests.every((r) => r.headers.authorization === "Bearer ya29.FIXTURE" && !r.headers["x-goog-api-key"])).toBe(true);
    expect(reqs).toEqual(["videos.list:1", "reports.query:0"]);
  });

  it("without the analytics scope: Data API numbers only, with a note to reconnect", async () => {
    const f = new FakeFetch().on("GET", "https://www.googleapis.com/youtube/v3/videos", { json: oneVideo });
    const notes: string[] = [];
    const out = await createYouTubeInsightsAdapter().fetchPostInsights({ account: account([]), accessToken: "t", publication: pub, fetch: asFetch(f), onNote: (n) => notes.push(n) });
    expect(out.map((i) => i.metric).sort()).toEqual(["comments", "likes", "views"]);
    expect(notes.join(" ")).toMatch(/reconnect YouTube/i);
    expect(f.calls("GET", "https://youtubeanalytics.googleapis.com")).toHaveLength(0);
  });

  it("an insufficient-scope answer from YouTube Analytics is a note, not a failure", async () => {
    const f = new FakeFetch().on("GET", "https://www.googleapis.com/youtube/v3/videos", { json: oneVideo }).on("GET", "https://youtubeanalytics.googleapis.com/v2/reports", { status: 403, json: fx.errors.insufficientScope });
    const notes: string[] = [];
    const out = await createYouTubeInsightsAdapter().fetchPostInsights({ account: account([YT_ANALYTICS_SCOPE]), accessToken: "t", publication: pub, fetch: asFetch(f), onNote: (n) => notes.push(n) });
    expect(out).toHaveLength(3);
    expect(notes.join(" ")).toMatch(/YouTube Analytics wasn't available/);
  });

  it("refuses videos on another channel and reports deleted videos", async () => {
    const other = { ...oneVideo, items: [{ ...fx.videos.items[0], snippet: { ...fx.videos.items[0].snippet, channelId: "UCsomeoneElse0000000000x" } }] };
    const f1 = new FakeFetch().on("GET", "https://www.googleapis.com/youtube/v3/videos", { json: other });
    await expect(createYouTubeInsightsAdapter().fetchPostInsights({ account: account([]), accessToken: "t", publication: pub, fetch: asFetch(f1) })).rejects.toMatchObject({ code: "BAD_REQUEST", opts: { details: { otherChannel: true } } });
    const f2 = new FakeFetch().on("GET", "https://www.googleapis.com/youtube/v3/videos", { json: { ...fx.videos, items: [] } });
    await expect(createYouTubeInsightsAdapter().fetchPostInsights({ account: account([]), accessToken: "t", publication: pub, fetch: asFetch(f2) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
