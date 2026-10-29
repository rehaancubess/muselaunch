import { readFileSync } from "node:fs";
import { handlers as analyticsHandlers, installAnalyticsHooks, installYouTubeFetch, youtubeAnalysisIdFor } from "@muselaunch/analytics";
import { createTestPlatform } from "@muselaunch/platform";
import { installMetaClient, MetaClient, YT_ANALYTICS_SCOPE } from "@muselaunch/providers";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app";

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

/**
 * YouTube analytics through the API and the job runner. YouTube and Meta answer from documented
 * response shapes with synthetic values (fixtures/analytics/youtube-data-api.json): never live calls.
 */
const fx = JSON.parse(readFileSync(new URL("../../../../fixtures/analytics/youtube-data-api.json", import.meta.url), "utf8")) as Record<string, J>;
const KEY = "AIzaFIXTURE_TEST_KEY_NOT_REAL_0000000000";

type Scenario = { channels?: "ok" | "empty" | "quota"; videos?: J; analytics?: J };

/** Fake Google APIs: checks auth, records calls, answers with the documented fixtures. */
function fakeYouTube(s: Scenario = {}) {
  const calls: { path: string; query: Record<string, string>; auth: string | null; key: string | null }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    calls.push({ path: url.host + url.pathname, query: Object.fromEntries(url.searchParams), auth: h.get("authorization"), key: h.get("x-goog-api-key") });
    if (!h.get("authorization") && h.get("x-goog-api-key") !== KEY) return json(fx.errors.keyInvalid, 400);
    if (url.pathname === "/youtube/v3/channels") return s.channels === "quota" ? json(fx.errors.quotaExceeded, 403) : json(s.channels === "empty" ? fx.channelsEmpty : fx.channels);
    if (url.pathname === "/youtube/v3/playlistItems") return json(fx.playlistItems);
    if (url.pathname === "/youtube/v3/videos") {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      const all = s.videos ?? fx.videos;
      return json({ ...all, items: all.items.filter((v: J) => ids.includes(v.id)) });
    }
    if (url.host === "youtubeanalytics.googleapis.com") return json(s.analytics ?? fx.analyticsReport);
    return json({ error: { code: 404, message: "not found" } }, 404);
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** Fake Meta Responses API returning one structured output (documented shape). */
function fakeMeta(text: string) {
  const requests: J[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const body = { id: `resp_fixture_${requests.length}`, model: requests.at(-1).model, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 1200, output_tokens: 300 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, requests };
}

const INTERPRETATION = {
  summary: "Uploads of 60 s or less had a median of 15,400 views on this channel. A focus app could get 47,000 views with the same format. Short screen demos may be worth testing for Focusly.",
  findingNotes: [{ key: "length", interpretation: "Short demos may suit a planning app; this is a correlation in public counts, not proof." }],
  hooksToTest: [{ hook: "Plan your whole week before your coffee cools", angle: "Fast weekly planning for busy freelancers.", videoIds: ["FXvid000001", "BADid000000"] }],
  formatsToTest: [{ format: "Under-60-second screen demo", why: "The short group had the higher median views.", statKeys: ["length:short"] }],
  cautions: ["Only 10 recent uploads were analysed."],
};

function client(app: ReturnType<typeof buildApp>, uid: string) {
  const auth = { authorization: `Bearer dev:${uid}:${uid}@example.com` };
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as J };
  };
  return { get: (path: string) => send("GET", path), post: (path: string, body?: unknown) => send("POST", path, body ?? {}) };
}

async function setup(opts: { key?: boolean; scenario?: Scenario; meta?: string | null } = {}) {
  const p = createTestPlatform(opts.key === false ? {} : { YOUTUBE_API_KEY: KEY }, { "app.import": async () => ({}), "media.probe": async () => ({}), ...analyticsHandlers });
  installAnalyticsHooks(p);
  const yt = fakeYouTube(opts.scenario);
  installYouTubeFetch(p, yt.f);
  const meta = opts.meta === null ? null : fakeMeta(opts.meta ?? JSON.stringify(INTERPRETATION));
  if (meta) installMetaClient(p, new MetaClient(p, { fetch: meta.f, apiKey: "test-key" }));
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  const wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id as string;
  const wsB = (await bob.post("/v1/workspaces", { name: "Bob Apps" })).body.workspace.id as string;
  const appId = (await alice.post(`/v1/workspaces/${wsA}/apps`, { name: "Focusly" })).body.app.id as string;
  await p.inline!.drain();
  const A = `/v1/workspaces/${wsA}`;
  return { p, yt, meta, alice, bob, wsA, wsB, appId, A };
}

const jobOf = async (ctx: Awaited<ReturnType<typeof setup>>, id: string) => (await ctx.alice.get(`${ctx.A}/jobs/${id}`)).body.job;

describe("YouTube channel analysis (public data)", () => {
  it("fetches the channel, computes stats from the API numbers, labels and grounds the AI reading, meters quota and saves sourced findings", async () => {
    const ctx = await setup();
    const before = (await ctx.alice.get(`${ctx.A}/billing/credits`)).body.balance.available;
    const res = await ctx.alice.post(`${ctx.A}/apps/${ctx.appId}/youtube/analyze`, { channel: "https://www.youtube.com/@fixturefocus", relation: "competitor" });
    expect(res.status).toBe(202);
    expect(res.body.job.type).toBe("analytics.youtube_channel");
    await ctx.p.inline!.drain();
    const job = await jobOf(ctx, res.body.job.id);
    expect(job.status).toBe("succeeded");
    expect(job.creditsCharged).toBe(5);
    expect((await ctx.alice.get(`${ctx.A}/billing/credits`)).body.balance.available).toBe(before - 5);

    // Three Data API list calls (3 quota units), key in the header only.
    expect(ctx.yt.calls.map((c) => c.path)).toEqual(["www.googleapis.com/youtube/v3/channels", "www.googleapis.com/youtube/v3/playlistItems", "www.googleapis.com/youtube/v3/videos"]);
    expect(ctx.yt.calls[0]!.query).toMatchObject({ forHandle: "@fixturefocus", part: "snippet,contentDetails,statistics" });
    expect(ctx.yt.calls.every((c) => c.key === KEY && !JSON.stringify(c.query).includes(KEY))).toBe(true);

    const list = await ctx.alice.get(`${ctx.A}/apps/${ctx.appId}/youtube/analyses`);
    expect(list.body).toMatchObject({ configured: true, items: [{ channel: { title: "Fixture Focus Apps", handle: "@fixturefocus" }, videosAnalyzed: 10, medianViews: 8100, interpretation: { status: "ready", model: "muse-spark-1.3" } }] });
    const id = list.body.items[0].id;
    expect(id).toBe(youtubeAnalysisIdFor(ctx.appId, fx.channelId));
    const a = (await ctx.alice.get(`${ctx.A}/youtube-analyses/${id}`)).body.analysis;
    expect(a.channel).toMatchObject({ id: fx.channelId, url: "https://www.youtube.com/@fixturefocus", subscriberCount: 12_400, videoCount: 212 });
    expect(a.quota).toEqual({ units: 3, calls: [{ method: "channels.list", units: 1 }, { method: "playlistItems.list", units: 1 }, { method: "videos.list", units: 1 }] });
    expect(a.stats.videosAnalyzed).toBe(10);
    expect(a.stats.excluded.map((e: J) => e.videoId)).toEqual(["FXvid000011", "FXvid000012"]);
    expect(a.videos[0]).toMatchObject({ videoId: "FXvid000001", url: "https://www.youtube.com/watch?v=FXvid000001", views: 15_400 });
    expect(a.sources[0]).toMatchObject({ kind: "api", url: "https://www.youtube.com/@fixturefocus", publisher: "YouTube Data API v3", retrievedAt: a.fetchedAt });
    expect(a.sources).toHaveLength(11);

    // Interpretation: labelled with the engine that ran; invented numbers and unknown videos removed.
    const i = a.interpretation;
    expect(i).toMatchObject({ status: "ready", model: "muse-spark-1.3", provider: "meta" });
    expect(i.summary).toBe("Uploads of 60 s or less had a median of 15,400 views on this channel. Short screen demos may be worth testing for Focusly.");
    expect(i.hooksToTest[0].videoIds).toEqual(["FXvid000001"]);
    expect(i.validation).toMatchObject({ droppedSentences: 1, unknownVideoIds: 1 });
    const prompt = JSON.stringify(ctx.meta!.requests[0]);
    expect(prompt).toContain("Focusly");
    expect(prompt).toContain("a COMPETITOR's channel");
    expect(prompt).toContain("untrusted_content");
    expect(ctx.meta!.requests[0].text.format.name).toBe("YouTubeChannelInterpretation");

    // Measured key findings → sourced research findings (Discover feed, Growth Autopilot).
    expect(a.keyFindings.map((f: J) => f.key)).toEqual(["length", "top", "titles", "cadence"]);
    const findings = (await ctx.p.db.ws(ctx.wsA).collection("researchFindings").list({ where: [["appId", "==", ctx.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items;
    expect(findings).toHaveLength(4);
    const length = findings.find((f) => f.statement.includes("by video length"))!;
    expect(length).toMatchObject({ kind: "format", runId: id, channels: ["youtube"] });
    expect(length.statement).toContain("median 15,400 views");
    expect(length.interpretation).toMatch(/^Interpretation \(muse-spark-1\.3, not measured\): /);
    expect(length.evidence[0]).toMatchObject({ kind: "api", url: "https://www.youtube.com/@fixturefocus" });
    const feed = await ctx.alice.get(`${ctx.A}/apps/${ctx.appId}/discover/feed`);
    expect(feed.status).toBe(200);
    expect(feed.body.items.some((x: J) => x.refId === length.id && x.type === "finding")).toBe(true);

    // Metering: one usage row per YouTube call (cost 0, quota units) plus the model call.
    const usage = (await ctx.p.db.ws(ctx.wsA).collection("modelUsage").list({ where: [["jobId", "==", job.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items;
    const ytRows = usage.filter((u) => u.model === "youtube-data-api-v3");
    expect(ytRows.map((u) => [u.task, u.quotaUnits, u.costUsdEstimate, u.provider]).sort()).toEqual([
      ["analytics.youtube.channels.list", 1, 0, "analytics"],
      ["analytics.youtube.playlistItems.list", 1, 0, "analytics"],
      ["analytics.youtube.videos.list", 1, 0, "analytics"],
    ]);
    expect(usage.some((u) => u.provider === "meta" && u.task === "analytics.youtube_channel")).toBe(true);

    // The key never leaves the server.
    const stored = JSON.stringify([a, job, usage, findings, list.body]);
    expect(stored).not.toContain(KEY);

    // Re-analysing replaces the same document and findings (no duplicates).
    await ctx.alice.post(`${ctx.A}/apps/${ctx.appId}/youtube/analyze`, { channel: "UCFIXTUREfocus0000000001" });
    await ctx.p.inline!.drain();
    expect((await ctx.alice.get(`${ctx.A}/apps/${ctx.appId}/youtube/analyses`)).body.items).toHaveLength(1);
    expect((await ctx.p.db.ws(ctx.wsA).collection("researchFindings").list({ where: [["appId", "==", ctx.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items).toHaveLength(4);
  });

  it("fails honestly: missing key, bad link, unknown channel, quota used up", async () => {
    const noKey = await setup({ key: false });
    const r1 = await noKey.alice.post(`${noKey.A}/apps/${noKey.appId}/youtube/analyze`, { channel: "@fixturefocus" });
    expect(r1.status).toBe(503);
    expect(r1.body.error).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED", userMessage: expect.stringContaining("YOUTUBE_API_KEY") });
    expect((await noKey.alice.get(`${noKey.A}/apps/${noKey.appId}/youtube/analyses`)).body).toMatchObject({ configured: false, items: [] });
    expect(noKey.yt.calls).toHaveLength(0);

    const ctx = await setup({ scenario: { channels: "empty" } });
    const bad = await ctx.alice.post(`${ctx.A}/apps/${ctx.appId}/youtube/analyze`, { channel: "https://vimeo.com/fixture" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.userMessage).toMatch(/YouTube channel link/);

    const before = (await ctx.alice.get(`${ctx.A}/billing/credits`)).body.balance.available;
    const nf = await ctx.alice.post(`${ctx.A}/apps/${ctx.appId}/youtube/analyze`, { channel: "@nobody-here" });
    await ctx.p.inline!.drain();
    const job = await jobOf(ctx, nf.body.job.id);
    expect(job).toMatchObject({ status: "failed", error: { code: "NOT_FOUND", userMessage: expect.stringContaining("@nobody-here") } });
    expect(job.attempts).toBe(1); // not retried
    expect((await ctx.alice.get(`${ctx.A}/billing/credits`)).body.balance.available).toBe(before);
    expect(ctx.meta!.requests).toHaveLength(0);

    const quota = await setup({ scenario: { channels: "quota" } });
    const q = await quota.alice.post(`${quota.A}/apps/${quota.appId}/youtube/analyze`, { channel: "@fixturefocus" });
    await quota.p.inline!.drain();
    expect(await jobOf(quota, q.body.job.id)).toMatchObject({ status: "failed", attempts: 1, error: { code: "RATE_LIMITED", userMessage: expect.stringContaining("quota") } });
  });

  it("without a text model the numbers are still saved, nothing is charged and the missing interpretation is explained", async () => {
    const ctx = await setup({ meta: null });
    const res = await ctx.alice.post(`${ctx.A}/apps/${ctx.appId}/youtube/analyze`, { channel: "https://youtu.be/FXvid000001", relation: "mine" });
    await ctx.p.inline!.drain();
    const job = await jobOf(ctx, res.body.job.id);
    expect(job).toMatchObject({ status: "succeeded", creditsCharged: 0 });
    // A video link resolves to its channel (one extra videos.list call).
    expect(ctx.yt.calls.map((c) => c.path.split("/").pop())).toEqual(["videos", "channels", "playlistItems", "videos"]);
    const a = (await ctx.alice.get(`${ctx.A}/youtube-analyses/${job.output.data.analysisId}`)).body.analysis;
    expect(a.stats.videosAnalyzed).toBe(10);
    expect(a.interpretation).toMatchObject({ status: "unavailable", error: expect.stringContaining("No text model") });
    // The founder's own channel: the measured pattern is remembered as a lesson (labelled as correlation).
    expect(a.memoryIds).toHaveLength(1);
    const pref = await ctx.p.db.ws(ctx.wsA).collection("brandPreferences").get(a.memoryIds[0]);
    expect(pref).toMatchObject({ kind: "lesson", appId: ctx.appId, source: { type: "agent", ref: { entity: "youtubeAnalyses", id: a.id } } });
    expect(pref!.text).toContain("not proof of cause");
  });

  it("is tenant-isolated", async () => {
    const ctx = await setup();
    const res = await ctx.alice.post(`${ctx.A}/apps/${ctx.appId}/youtube/analyze`, { channel: "@fixturefocus" });
    await ctx.p.inline!.drain();
    const id = (await jobOf(ctx, res.body.job.id)).output.data.analysisId;
    expect((await ctx.bob.get(`/v1/workspaces/${ctx.wsB}/youtube-analyses/${id}`)).status).toBe(404);
    expect((await ctx.bob.get(`${ctx.A}/youtube-analyses/${id}`)).status).toBe(404);
    expect((await ctx.bob.post(`${ctx.A}/apps/${ctx.appId}/youtube/analyze`, { channel: "@fixturefocus" })).status).toBe(404);
    expect((await ctx.bob.get(`/v1/workspaces/${ctx.wsB}/apps/${ctx.appId}/youtube/analyses`)).status).toBe(404);
  });
});

describe("YouTube insights for posts MuseLaunch published", () => {
  async function connected(scopes: string[], opts: { appScoped?: boolean; scenario?: Scenario } = {}) {
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const v1 = { ...fx.videos.items[0], snippet: { ...fx.videos.items[0].snippet, publishedAt: recent } };
    const v6 = { ...fx.videos.items[5], snippet: { ...fx.videos.items[5].snippet, channelId: "UCsomeoneElse0000000000x" } };
    const ctx = await setup({ scenario: { videos: { ...fx.videos, items: [v1, v6] }, ...opts.scenario } });
    const ws = ctx.p.db.ws(ctx.wsA);
    const accId = "acc_ytfixture";
    await ctx.p.secrets.put(ctx.wsA, `tok_${accId}`, "oauth_youtube", { accessToken: "ya29.FIXTURE_SYNC_TOKEN", refreshToken: "1//FIXTURE_REFRESH", expiresAt: Date.now() + 3_600_000, scope: scopes });
    await ws.collection("connectedAccounts").create(
      { id: accId, appId: opts.appScoped === false ? undefined : ctx.appId, provider: "youtube", purposes: ["publishing", "analytics"], externalAccountId: fx.channelId, displayName: "Fixture Focus Apps", scopes, status: "connected", capabilities: ["publish_video", "read_insights"], secretId: `tok_${accId}`, connectedBy: "alice" },
      { actor: "alice" },
    );
    const campaign = await ws.collection("campaigns").create({ appId: ctx.appId, name: "Launch", goal: "awareness", status: "planning", channels: ["youtube"] }, { actor: "alice" });
    const pub = await ws.collection("publications").create({ appId: ctx.appId, campaignId: campaign.id, scheduledPostId: "pst_fixture1", channel: "youtube", mode: "api", remoteId: "FXvid000001", remoteUrl: "https://www.youtube.com/watch?v=FXvid000001", publishedAt: recent }, { actor: "alice" });
    const other = await ws.collection("publications").create({ appId: ctx.appId, campaignId: campaign.id, scheduledPostId: "pst_fixture6", channel: "youtube", mode: "manual_confirmed", remoteUrl: "https://youtu.be/FXvid000006", publishedAt: recent }, { actor: "alice" });
    return { ...ctx, accId, pubId: pub.id, otherId: other.id, campaignId: campaign.id };
  }

  it("syncs per-post stats with the platform's definitions; YouTube Analytics adds watch time, shares and subscribers", async () => {
    const ctx = await connected([YT_ANALYTICS_SCOPE]);
    const conns = await ctx.alice.get(`${ctx.A}/apps/${ctx.appId}/analytics/connections`);
    expect(conns.body.items.map((c: J) => c.provider)).toContain("youtube");
    const sync = await ctx.alice.post(`${ctx.A}/analytics/connections/${ctx.accId}/sync`);
    expect(sync.status).toBe(202);
    await ctx.p.inline!.drain();
    const job = await jobOf(ctx, sync.body.job.id);
    expect(job.status).toBe("succeeded");
    expect(job.output.data.skipped).toEqual([{ publicationId: ctx.otherId, reason: expect.stringContaining("isn't on the connected YouTube channel") }]);
    expect(ctx.yt.calls.every((c) => c.auth === "Bearer ya29.FIXTURE_SYNC_TOKEN")).toBe(true);

    const obs = (await ctx.alice.get(`${ctx.A}/apps/${ctx.appId}/observations?source=youtube`)).body.items as J[];
    const by = Object.fromEntries(obs.map((o) => [o.metric, o]));
    expect(Object.keys(by).sort()).toEqual(["avg_view_duration_sec", "comments", "followers_gained", "likes", "shares", "views", "watch_time_sec"]);
    expect(by.views).toMatchObject({ value: 15_400, source: "youtube", channel: "youtube", attribution: "platform_reported", publicationId: ctx.pubId, campaignId: ctx.campaignId, connectionId: ctx.accId, unit: "count", provenance: { imported: false } });
    expect(by.views.metricDefinition).toContain("statistics.viewCount");
    expect(by.watch_time_sec).toMatchObject({ value: 2310 * 60, unit: "seconds" });
    expect(by.avg_view_duration_sec).toMatchObject({ value: 94, unit: "seconds" });
    expect(by.followers_gained.metricDefinition).toContain("subscribersGained");

    // Re-sync replaces values (one lifetime-to-date value per post and metric), never adds them up.
    await ctx.alice.post(`${ctx.A}/analytics/connections/${ctx.accId}/sync`, {});
    await ctx.p.inline!.drain();
    const again = (await ctx.alice.get(`${ctx.A}/apps/${ctx.appId}/observations?source=youtube`)).body.items as J[];
    expect(again.map((o) => o.id).sort()).toEqual(obs.map((o) => o.id).sort());

    const overview = (await ctx.alice.get(`${ctx.A}/apps/${ctx.appId}/insights/overview`)).body;
    const views = overview.metrics.find((m: J) => m.metric === "views");
    expect(views).toMatchObject({ value: 15_400, attribution: "platform_reported", sources: [{ source: "youtube", label: "YouTube (API)" }] });
    const usage = (await ctx.p.db.ws(ctx.wsA).collection("modelUsage").list({ where: [["jobId", "==", job.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items;
    expect(usage.filter((u) => u.model === "youtube-data-api-v3").every((u) => u.quotaUnits === 1)).toBe(true);
    expect(usage.some((u) => u.model === "youtube-analytics-api-v2")).toBe(true);
    expect(JSON.stringify([obs, usage, job])).not.toContain("FIXTURE_SYNC_TOKEN");
  });

  it("without yt-analytics.readonly: public stats only, and the connection says how to get more", async () => {
    const ctx = await connected([], { appScoped: false });
    // A workspace-wide connection syncs the app named by the caller.
    expect((await ctx.alice.post(`${ctx.A}/analytics/connections/${ctx.accId}/sync`)).status).toBe(400);
    const sync = await ctx.alice.post(`${ctx.A}/analytics/connections/${ctx.accId}/sync`, { appId: ctx.appId });
    expect(sync.status).toBe(202);
    await ctx.p.inline!.drain();
    expect((await jobOf(ctx, sync.body.job.id)).status).toBe("succeeded");
    const obs = (await ctx.alice.get(`${ctx.A}/apps/${ctx.appId}/observations?source=youtube`)).body.items as J[];
    expect(obs.map((o) => o.metric).sort()).toEqual(["comments", "likes", "views"]);
    expect(ctx.yt.calls.some((c) => c.path.startsWith("youtubeanalytics"))).toBe(false);
    const acc = await ctx.p.db.ws(ctx.wsA).collection("connectedAccounts").get(ctx.accId);
    expect(acc!.lastError).toMatch(/reconnect YouTube/i);
    // OAuth accounts are disconnected (and revoked) from Connections, not from the analytics route.
    expect((await ctx.alice.get(`${ctx.A}/apps/${ctx.appId}/analytics/connections`)).body.items.some((c: J) => c.id === ctx.accId)).toBe(true);
  });
});
