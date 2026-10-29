import type { AnalyzeYouTubeChannelRequest, App, BrandProfile, Claim, ResearchFinding, SourceRef, YouTubeChannelAnalysis, YouTubeChannelRelation, YouTubeInterpretation, YouTubeKeyFinding, YouTubeVideoStat } from "@muselaunch/contracts";
import { nowIso, type WorkspaceDb } from "@muselaunch/db";
import { AppError, toAppError, type JobContext, type JobHandler, type JobResult, type Platform } from "@muselaunch/platform";
import { chooseTextModel, parseYouTubeChannelInput, routedJson, untrusted, YOUTUBE_DATA_MODEL, YouTubeDataClient, type YouTubeCall, type YtChannelResource } from "@muselaunch/providers";
import { z } from "zod";
import { memoryApi } from "../memory";
import { hashId } from "../observations";
import { computeChannelStats, keyFindings, MIN_GROUP, normalizeVideos } from "./stats";
import { collectNumbers, groundText, KnownNumbers } from "./validate";

/**
 * Job `analytics.youtube_channel`: public YouTube channel analysis.
 * 1. YouTube Data API (API key): channels.list → playlistItems.list (uploads) → videos.list. 3 quota units.
 * 2. Deterministic stats (./stats.ts): every number comes from those responses.
 * 3. The text model (router, labelled with the engine that ran) interprets the stats for the user's app.
 *    Its text is grounded: sentences with numbers that aren't in the data are dropped.
 * 4. Measured key findings become sourced research findings (Discover feed, Growth Autopilot); for the
 *    founder's own channel a lesson is also written to brand memory.
 */

/** Tests inject a fake fetch per platform (recorded/documented responses, never live output). */
const fetchOverrides = new WeakMap<Platform, typeof fetch>();
export function installYouTubeFetch(p: Platform, f: typeof fetch | undefined): void {
  if (f) fetchOverrides.set(p, f);
  else fetchOverrides.delete(p);
}
export const youtubeFetchFor = (p: Platform): typeof fetch | undefined => fetchOverrides.get(p);

export const youtubeAnalysisIdFor = (appId: string, channelId: string) => hashId("yta", `${appId}:youtube:${channelId}`);

export function youtubeConfigured(p: Platform): boolean {
  return Boolean(p.cfg.YOUTUBE_API_KEY?.trim());
}

export function assertYouTubeConfigured(p: Platform): void {
  if (!youtubeConfigured(p)) {
    throw new AppError("PROVIDER_NOT_CONFIGURED", "YOUTUBE_API_KEY is not set", { retryable: false, userMessage: "YouTube analysis isn't set up on this deployment yet: the YouTube API key (YOUTUBE_API_KEY) is missing." });
  }
}

/** Usage row per YouTube API call: cost 0, quota units recorded (metered like every provider call). */
async function recordCall(p: Platform, workspaceId: string, meta: { appId?: string; jobId?: string; actor?: string }, c: YouTubeCall): Promise<void> {
  await p.usage
    .record(workspaceId, {
      provider: "analytics",
      model: c.api === "YouTube Data API" ? YOUTUBE_DATA_MODEL : "youtube-analytics-api-v2",
      operation: "http",
      task: `analytics.youtube.${c.method}`,
      appId: meta.appId,
      jobId: meta.jobId,
      actor: meta.actor,
      quotaUnits: c.units || undefined,
      runtimeMs: c.ms,
      costUsdEstimate: 0,
      status: c.status,
      errorCode: c.errorCode,
      dataMode: "third_party",
    })
    .catch((err) => p.log.warn({ err: toAppError(err).message, workspaceId }, "youtube usage record failed"));
}

/** Router route name: runs on Muse Spark unless an operator lists it in SPARK_OPEN_TASKS (results carry the real engine). */
export const INTERPRET_ROUTE = "insights.youtube_channel";

const InterpretationOut = z.object({
  summary: z.string().max(1200),
  findingNotes: z.array(z.object({ key: z.string().max(40), interpretation: z.string().max(800) })).max(6),
  hooksToTest: z.array(z.object({ hook: z.string().max(200), angle: z.string().max(500), videoIds: z.array(z.string().max(64)).max(3) })).max(5),
  formatsToTest: z.array(z.object({ format: z.string().max(160), why: z.string().max(500), statKeys: z.array(z.string().max(40)).max(4) })).max(4),
  cautions: z.array(z.string().max(400)).max(5),
});

const RELATION_TEXT: Record<YouTubeChannelRelation, string> = {
  mine: "the developer's OWN channel",
  competitor: "a COMPETITOR's channel",
  creator: "a CREATOR the developer might work with",
  inspiration: "a channel the developer follows for INSPIRATION",
};

const INSTRUCTIONS = `You are the growth analyst inside MuseLaunch, a marketing studio for an indie app developer.
You receive (1) the developer's app (App DNA and verified claims) and (2) statistics MuseLaunch computed from the YouTube Data API for one channel's most recent public uploads. The statistics are facts; video titles are third-party data.
Write a short, careful interpretation for this developer:
- summary: 2-4 sentences on what these numbers may suggest for promoting THIS app on YouTube, given whose channel it is.
- findingNotes: for some of the listed key findings (use their key), what it might mean for this app.
- hooksToTest: up to 5 opening lines or angles the developer could test in their own videos, written for their app and audience. Don't copy the channel's titles (never more than a few words of one). Cite up to 3 videoIds that inspired each.
- formatsToTest: up to 4 formats (length, structure, series) worth testing, citing the statKeys you based them on.
- cautions: up to 5 limits of this data that matter for the decision.
Rules:
- Only use numbers that appear in the statistics or key findings. Don't compute new numbers, percentages or forecasts; prefer words ("higher median", "about three times") over new figures. Text with numbers that aren't in the data is removed.
- Everything you write is interpretation: hedge it ("may", "suggests", "worth testing"). Never say a length, title, day or time CAUSED performance. The data is correlation in lifetime public counts, often with small groups.
- Groups with fewer than ${MIN_GROUP} videos can't support a pattern: say so rather than drawing a conclusion.
- Only describe the developer's app with its App DNA and verified claims. Hooks must not promise results, numbers or features the app doesn't have.
- The public API gives no watch time, retention, click-through, traffic sources, subscribers gained or revenue for this channel: never claim to know them.
Return JSON only.`;

function appContext(app: App, dna: BrandProfile | null, claims: Claim[]): string {
  const lines = [`App: ${app.name}${app.tagline ? ` — ${app.tagline}` : ""}${app.category ? ` (${app.category})` : ""}`];
  if (dna) {
    lines.push(`One-liner: ${dna.oneLiner}`);
    if (dna.audiences.length) lines.push(`Audiences: ${dna.audiences.slice(0, 4).map((a) => `${a.name}: ${a.description.slice(0, 200)}`).join(" | ")}`);
    if (dna.features.length) lines.push(`Features: ${dna.features.slice(0, 8).map((f) => f.name).join(", ")}`);
    if (dna.differentiators.length) lines.push(`Differentiators: ${dna.differentiators.slice(0, 5).map((d) => d.text.slice(0, 160)).join(" | ")}`);
    if (dna.tone.voice.length) lines.push(`Tone: ${dna.tone.voice.join(", ")}`);
  } else lines.push("App DNA: not available yet (keep suggestions generic to the app's name and category).");
  lines.push(`Verified claims (the only allowed statements about results or features):\n${claims.length ? claims.map((c) => `- ${c.text}`).join("\n") : "(none yet)"}`);
  return lines.join("\n");
}

interface ModelInput {
  stats: ReturnType<typeof computeChannelStats>;
  videos: YouTubeVideoStat[];
  findings: YouTubeKeyFinding[];
}

function statKeysOf(stats: ModelInput["stats"]): Set<string> {
  return new Set(["medians", "cadence", "top", ...stats.byLength.map((g) => g.key), ...stats.byWeekday.map((g) => g.key), ...stats.byHour.map((g) => g.key), ...stats.titlePatterns.map((p) => p.key)]);
}

/** Ratios a model may legitimately mention ("about 3x"): video vs median, and group vs group medians. */
function knownRatios(stats: ModelInput["stats"], videos: YouTubeVideoStat[]): number[] {
  const out = videos.map((v) => v.vsMedian ?? NaN);
  const medians = [...stats.byLength, ...stats.byWeekday, ...stats.byHour, ...stats.titlePatterns.flatMap((p) => [p.with, p.without])].map((g) => g.medianViews ?? NaN).filter((x) => Number.isFinite(x) && x > 0);
  for (const a of medians) for (const b of medians) if (a !== b) out.push(a / b);
  if (stats.meanViews && stats.medians.views) out.push(stats.meanViews / stats.medians.views);
  return out.filter((x) => Number.isFinite(x) && x > 0);
}

/** Ground the model output: unknown numbers, video ids and stat keys never reach the stored interpretation. */
export function groundInterpretation(out: z.infer<typeof InterpretationOut>, input: ModelInput & { extraTexts: string[]; channel: { subscriberCount: number | null; viewCount: number | null; videoCount: number | null } }): Pick<YouTubeInterpretation, "summary" | "findingNotes" | "hooksToTest" | "formatsToTest" | "cautions" | "validation"> {
  const known = new KnownNumbers(
    [...collectNumbers(input.stats), ...collectNumbers(input.videos), ...collectNumbers(input.channel), ...input.videos.map((v) => (v.durationSec ?? 0) / 60), 60, 61, 180, 100, 24, 7, 12, 4, 20, 16, 23, 59],
    knownRatios(input.stats, input.videos),
    [...input.videos.map((v) => v.title), ...input.findings.map((f) => f.statement), ...input.extraTexts],
  );
  const videoIds = new Set(input.videos.map((v) => v.videoId));
  const keys = statKeysOf(input.stats);
  const findingKeys = new Set(input.findings.map((f) => f.key));
  let droppedSentences = 0;
  let droppedItems = 0;
  let unknownVideoIds = 0;
  const unsupported = new Set<string>();
  const ground = (t: string) => {
    const g = groundText(t, known);
    droppedSentences += g.dropped;
    for (const u of g.unsupported) unsupported.add(u);
    return g.text;
  };
  const itemOk = (...texts: string[]) => {
    const bad = texts.flatMap((t) => known.unsupported(t));
    if (bad.length) {
      droppedItems++;
      for (const u of bad) unsupported.add(u);
      return false;
    }
    return true;
  };
  const summary = ground(out.summary);
  const findingNotes = out.findingNotes
    .filter((n) => findingKeys.has(n.key))
    .map((n) => ({ key: n.key, interpretation: ground(n.interpretation) }))
    .filter((n) => n.interpretation);
  const hooksToTest = out.hooksToTest
    .filter((h) => itemOk(h.hook, h.angle))
    .map((h) => {
      const ids = h.videoIds.filter((id) => videoIds.has(id));
      unknownVideoIds += h.videoIds.length - ids.length;
      return { hook: h.hook, angle: h.angle, videoIds: ids };
    });
  const formatsToTest = out.formatsToTest.filter((f) => itemOk(f.format, f.why)).map((f) => ({ format: f.format, why: f.why, statKeys: f.statKeys.filter((k) => keys.has(k)) }));
  const cautions = out.cautions.filter((c) => itemOk(c));
  const notes: string[] = [];
  if (droppedSentences || droppedItems) notes.push(`Removed ${droppedSentences} sentence(s) and ${droppedItems} suggestion(s) that used numbers not in the YouTube data (${[...unsupported].slice(0, 5).join(", ")}).`.slice(0, 300));
  if (unknownVideoIds) notes.push(`Ignored ${unknownVideoIds} video reference(s) that weren't in the analysed uploads.`);
  return { summary, findingNotes, hooksToTest, formatsToTest, cautions, validation: { droppedSentences, droppedItems, unknownVideoIds, notes } };
}

async function interpret(ctx: JobContext<"analytics.youtube_channel">, app: App, channelTitle: string, relation: YouTubeChannelRelation, input: ModelInput, channel: YouTubeChannelAnalysis["channel"]): Promise<{ interpretation: YouTubeInterpretation; modelRan: boolean }> {
  const p = ctx.platform;
  const ws = ctx.ws;
  const [dna, claimsPage] = await Promise.all([
    ws.collection("brandProfiles").get(app.id),
    ws.collection("claims").list({ where: [["appId", "==", app.id], ["state", "==", "verified"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 }),
  ]);
  const claims = claimsPage.items.slice(0, 10);
  const { stats, videos, findings } = input;
  const compact = {
    channel: { title: channelTitle, handle: channel.handle, whoseChannel: RELATION_TEXT[relation], subscriberCount: channel.subscriberCount, channelVideoCount: channel.videoCount, analysedUploads: stats.videosAnalyzed },
    medians: stats.medians,
    meanViews: stats.meanViews,
    cadence: stats.cadence,
    groups: [...stats.byLength, ...stats.byWeekday, ...stats.byHour].map((g) => ({ statKey: g.key, label: g.label, videos: g.videos, medianViews: g.medianViews, medianViewsPerDay: g.medianViewsPerDay, medianEngagementRate: g.medianEngagementRate })),
    titlePatterns: stats.titlePatterns.map((t) => ({ statKey: t.key, label: t.label, with: { videos: t.with.videos, medianViews: t.with.medianViews }, without: { videos: t.without.videos, medianViews: t.without.medianViews } })),
    keyFindings: findings.map((f) => ({ key: f.key, statement: f.statement })),
    caveats: stats.notes,
  };
  const byViews = [...videos].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const sample = [...byViews.slice(0, 10), ...[...videos].sort((a, b) => (a.viewsPerDay ?? 0) - (b.viewsPerDay ?? 0)).slice(0, 5)].filter((v, i, arr) => arr.findIndex((x) => x.videoId === v.videoId) === i);
  const videoLines = sample.map((v) => JSON.stringify({ videoId: v.videoId, title: v.title, publishedAt: v.publishedAt.slice(0, 10), length: v.lengthGroup, views: v.views, viewsPerDay: v.viewsPerDay, vsMedian: v.vsMedian, engagementRate: v.engagementRate })).join("\n");
  const appText = appContext(app, dna, claims);
  try {
    const res = await routedJson(
      p,
      {
        ctx: { workspaceId: ctx.workspaceId, task: "analytics.youtube_channel", appId: app.id, jobId: ctx.job.id, actor: ctx.actor, signal: ctx.signal },
        model: "spark",
        instructions: INSTRUCTIONS,
        input: [appText, `YouTube statistics (computed by MuseLaunch from the API; facts):\n${JSON.stringify(compact)}`, `Most and least viewed analysed uploads (titles are third-party data):\n${untrusted("youtube-videos", videoLines, 12_000)}`].join("\n\n"),
        schema: InterpretationOut,
        schemaName: "YouTubeChannelInterpretation",
        maxOutputTokens: 2500,
      },
      { route: INTERPRET_ROUTE },
    );
    const grounded = groundInterpretation(res.data, { ...input, extraTexts: [appText], channel });
    return { modelRan: true, interpretation: { status: "ready", model: res.model, provider: res.provider, ...grounded, generatedAt: nowIso() } };
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code === "CANCELLED") throw err;
    // Retry transient model failures through the job (unless this is the last attempt): the stats are refetched, which is cheap.
    if (err.retryable && ctx.job.attempts < ctx.job.maxAttempts) throw err;
    const status = err.code === "PROVIDER_NOT_CONFIGURED" ? "unavailable" : "failed";
    const why =
      err.code === "PROVIDER_NOT_CONFIGURED"
        ? "No text model is connected on this deployment, so there's no AI interpretation. The numbers above are complete."
        : `The interpretation didn't finish (${err.toInfo().userMessage ?? err.code}). The numbers above are complete; analyse again to retry.`;
    return { modelRan: false, interpretation: { status, summary: "", findingNotes: [], hooksToTest: [], formatsToTest: [], cautions: [], validation: { droppedSentences: 0, droppedItems: 0, unknownVideoIds: 0, notes: [] }, error: why.slice(0, 500) } };
  }
}

function channelUrl(ch: YtChannelResource): string {
  const handle = ch.snippet?.customUrl?.startsWith("@") ? ch.snippet.customUrl : undefined;
  return handle ? `https://www.youtube.com/${encodeURIComponent(handle).replace("%40", "@")}` : `https://www.youtube.com/channel/${encodeURIComponent(ch.id)}`;
}

const FINDING_KIND: Record<string, (rel: YouTubeChannelRelation) => ResearchFinding["kind"]> = {
  length: () => "format",
  titles: () => "hook",
  top: (rel) => (rel === "competitor" ? "competitor_strategy" : "hook"),
  cadence: (rel) => (rel === "competitor" ? "competitor_strategy" : "market"),
};

/** Save the measured key findings as sourced research findings (Discover feed + Growth Autopilot read them). */
async function saveFindings(ws: WorkspaceDb, analysisId: string, appId: string, relation: YouTubeChannelRelation, findings: YouTubeKeyFinding[], interpretation: YouTubeInterpretation, sources: { channel: SourceRef; videos: Map<string, SourceRef> }, previous: YouTubeKeyFinding[], minGroup: number, actor: string): Promise<YouTubeKeyFinding[]> {
  const notes = new Map(interpretation.findingNotes.map((n) => [n.key, n.interpretation]));
  const out: YouTubeKeyFinding[] = [];
  const repo = ws.collection("researchFindings");
  for (const f of findings) {
    const id = hashId("fnd", `${analysisId}:${f.key}`);
    const evidence = [sources.channel, ...f.videoIds.map((v) => sources.videos.get(v)).filter((s): s is SourceRef => Boolean(s))].slice(0, 6);
    const note = notes.get(f.key);
    const fields = {
      appId,
      // The YouTube analysis that produced it (not a researchRuns document).
      runId: analysisId,
      kind: (FINDING_KIND[f.key] ?? (() => "market" as const))(relation),
      statement: f.statement,
      interpretation: note ? `Interpretation (${interpretation.model ?? "AI"}, not measured): ${note}`.slice(0, 1500) : undefined,
      evidence,
      confidence: f.key === "length" || f.key === "titles" ? (minGroup >= 10 ? 0.8 : minGroup >= 5 ? 0.65 : 0.5) : 0.7,
      corroboration: 1,
      channels: ["youtube" as const],
      tags: ["youtube", "channel-analysis", relation],
      observedAt: sources.channel.retrievedAt,
      dedupKey: hashId("yt", `${analysisId}:${f.key}`, 40),
    };
    const { entity, created } = await repo.createIfAbsent({ id, ...fields }, { actor });
    if (!created) await repo.update(id, fields, { actor });
    out.push({ ...f, findingId: entity.id });
  }
  const keep = new Set(out.map((f) => f.findingId));
  for (const old of previous) if (old.findingId && !keep.has(old.findingId)) await repo.delete(old.findingId).catch(() => undefined);
  return out;
}

export const youtubeChannelHandler: JobHandler<"analytics.youtube_channel"> = async (ctx): Promise<JobResult> => {
  const p = ctx.platform;
  const { appId, relation, maxVideos } = ctx.payload;
  const ws = ctx.ws;
  const app = await ws.collection("apps").getOrThrow(appId);
  assertYouTubeConfigured(p);
  const ref = parseYouTubeChannelInput(ctx.payload.channel);

  const calls: YouTubeCall[] = [];
  const pending: Promise<void>[] = [];
  const meta = { appId, jobId: ctx.job.id, actor: ctx.actor };
  const yt = new YouTubeDataClient({
    apiKey: p.cfg.YOUTUBE_API_KEY,
    fetch: youtubeFetchFor(p),
    signal: ctx.signal,
    onCall: (c) => {
      calls.push(c);
      pending.push(recordCall(p, ctx.workspaceId, meta, c));
    },
  });
  const flush = async () => {
    await Promise.allSettled(pending);
    const units = calls.reduce((s, c) => s + c.units, 0);
    p.log.info({ workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, quotaUnits: units, calls: calls.map((c) => `${c.method}:${c.status}`) }, "youtube data api quota used");
    return units;
  };

  let channel: YtChannelResource | null;
  let ids: string[] = [];
  let items: Awaited<ReturnType<YouTubeDataClient["videos"]>> = [];
  try {
    await ctx.progress(5, "fetching", "Finding the channel on YouTube");
    if (ref.kind === "video") {
      const [v] = await yt.videos([ref.value], "snippet");
      if (!v?.snippet?.channelId) throw new AppError("NOT_FOUND", `YouTube video ${ref.value} not found`, { retryable: false, userMessage: "YouTube couldn't find that video, so the channel is unknown. Paste the channel link or @handle instead." });
      channel = await yt.channel({ kind: "id", value: v.snippet.channelId });
    } else channel = await yt.channel(ref);
    if (!channel) {
      throw new AppError("NOT_FOUND", `No YouTube channel for ${ref.kind} ${ref.value}`, {
        retryable: false,
        userMessage: `YouTube has no channel for “${ctx.payload.channel.slice(0, 80)}”. Check the link or @handle${ref.kind === "handle" && ref.fromCustomUrl ? " (old /c/ links don't always match a handle; paste the @handle or channel ID)" : ""}.`,
      });
    }
    ctx.throwIfCancelled();
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) {
      await ctx.progress(20, "fetching", "Reading recent uploads");
      try {
        ids = (await yt.playlistVideos(uploads, maxVideos)).map((x) => x.videoId);
      } catch (raw) {
        if (toAppError(raw).code !== "NOT_FOUND") throw raw;
        ids = []; // a channel without uploads has no (or an empty) uploads playlist
      }
    }
    if (ids.length) {
      await ctx.progress(35, "fetching", `Reading stats for ${ids.length} videos`);
      items = await yt.videos(ids);
    }
  } catch (err) {
    await flush();
    throw err;
  }
  const units = await flush();
  const fetchedAtMs = Date.now();
  const fetchedAt = new Date(fetchedAtMs).toISOString();

  const { videos, excluded } = normalizeVideos(items, ids, fetchedAtMs);
  const stats = computeChannelStats(videos, excluded, fetchedAt);
  const title = (channel.snippet?.title ?? channel.id).slice(0, 200);
  const findings = keyFindings(title, videos, stats, fetchedAt);
  const analysisId = youtubeAnalysisIdFor(appId, channel.id);
  const accounts = (await ws.collection("connectedAccounts").list({ limit: 200 })).items;
  const connectedChannel = accounts.some((a) => a.provider === "youtube" && a.externalAccountId === channel!.id && a.status !== "revoked");
  const chUrl = channelUrl(channel);
  const thumb = channel.snippet?.thumbnails?.default?.url ?? channel.snippet?.thumbnails?.medium?.url;
  const channelInfo: YouTubeChannelAnalysis["channel"] = {
    id: channel.id,
    title,
    handle: channel.snippet?.customUrl?.slice(0, 120),
    url: chUrl,
    publishedAt: channel.snippet?.publishedAt && !Number.isNaN(Date.parse(channel.snippet.publishedAt)) ? new Date(channel.snippet.publishedAt).toISOString() : undefined,
    country: channel.snippet?.country?.slice(0, 8),
    thumbnailUrl: thumb && /^https:\/\//.test(thumb) ? thumb : undefined,
    subscriberCount: channel.statistics?.hiddenSubscriberCount ? null : (Number.isFinite(Number(channel.statistics?.subscriberCount)) ? Number(channel.statistics?.subscriberCount) : null),
    viewCount: Number.isFinite(Number(channel.statistics?.viewCount)) && channel.statistics?.viewCount !== undefined ? Number(channel.statistics.viewCount) : null,
    videoCount: Number.isFinite(Number(channel.statistics?.videoCount)) && channel.statistics?.videoCount !== undefined ? Number(channel.statistics.videoCount) : null,
    uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads?.slice(0, 64),
  };

  await ctx.progress(50, "interpreting", stats.videosAnalyzed ? `${chooseTextModel(p, INTERPRET_ROUTE).name} is reading the numbers for ${app.name}` : "No public uploads to analyse");
  const effectiveRelation: YouTubeChannelRelation = connectedChannel ? "mine" : relation;
  const { interpretation, modelRan } = stats.videosAnalyzed
    ? await interpret(ctx, app, title, effectiveRelation, { stats, videos, findings }, channelInfo)
    : { modelRan: false, interpretation: { status: "unavailable" as const, summary: "", findingNotes: [], hooksToTest: [], formatsToTest: [], cautions: [], validation: { droppedSentences: 0, droppedItems: 0, unknownVideoIds: 0, notes: [] }, error: "This channel has no public uploads to analyse." } };

  await ctx.progress(85, "saving");
  const sourceChannel: SourceRef = { kind: "api", url: chUrl, title: `${title} on YouTube`, publisher: "YouTube Data API v3", retrievedAt: fetchedAt };
  const videoSources = new Map<string, SourceRef>(videos.map((v) => [v.videoId, { kind: "api", url: v.url, title: v.title.slice(0, 500) || v.videoId, publisher: "YouTube Data API v3", retrievedAt: fetchedAt, publishedAt: v.publishedAt }]));
  const repo = ws.collection("youtubeAnalyses");
  const previous = await repo.get(analysisId);
  const minGroup = Math.min(...stats.byLength.filter((g) => g.videos >= MIN_GROUP).map((g) => g.videos), Number.POSITIVE_INFINITY);
  const savedFindings = await saveFindings(ws, analysisId, appId, effectiveRelation, findings, interpretation, { channel: sourceChannel, videos: videoSources }, previous?.keyFindings ?? [], Number.isFinite(minGroup) ? minGroup : 0, ctx.actor);

  const fields = {
    appId,
    input: ctx.payload.channel.slice(0, 300),
    relation: effectiveRelation,
    connectedChannel,
    channel: channelInfo,
    fetchedAt,
    videos,
    stats,
    keyFindings: savedFindings,
    interpretation,
    sources: [sourceChannel, ...videoSources.values()].slice(0, 60),
    quota: { units, calls: calls.map((c) => ({ method: c.method, units: c.units })).slice(0, 10) },
    memoryIds: [] as string[],
    jobId: ctx.job.id,
  };
  const { entity, created } = await repo.createIfAbsent({ id: analysisId, ...fields }, { actor: ctx.actor });
  let analysis = created ? entity : await repo.update(analysisId, fields, { actor: ctx.actor });

  // The founder's own channel: remember the measured pattern as a lesson (brand memory / Glimmer).
  if (effectiveRelation === "mine") {
    const lesson = savedFindings.find((f) => f.key === "length") ?? savedFindings.find((f) => f.key === "titles");
    if (lesson) {
      try {
        const mem = await memoryApi();
        const pref = await mem.rememberPreference(p, {
          workspaceId: ctx.workspaceId,
          appId,
          kind: "lesson",
          text: `Your YouTube channel, measured: ${lesson.statement} This is a correlation in public counts, not proof of cause.`.slice(0, 1000),
          source: { type: "agent", ref: { entity: "youtubeAnalyses", id: analysisId } },
          actor: ctx.actor,
        });
        analysis = await repo.update(analysisId, { memoryIds: [pref.id] }, { actor: ctx.actor });
      } catch (err) {
        p.log.warn({ workspaceId: ctx.workspaceId, code: toAppError(err).code }, "youtube lesson not saved to memory");
      }
    }
  }

  await ctx.log_event(`Analysed ${stats.videosAnalyzed} uploads of ${title} (${units} YouTube quota units)`, { entity: "youtubeAnalyses", id: analysisId });
  await ctx.progress(100, "done");
  return {
    refs: [{ entity: "youtubeAnalyses", id: analysis.id }, ...savedFindings.filter((f) => f.findingId).map((f) => ({ entity: "researchFindings", id: f.findingId! }))],
    data: { analysisId: analysis.id, channelId: channel.id, videos: stats.videosAnalyzed, quotaUnits: units, interpretation: interpretation.status, model: interpretation.model },
    // Credits cover the AI interpretation only; nothing is charged when no model ran.
    creditsUsed: modelRan ? (ctx.job.reservation?.credits ?? 0) : 0,
  };
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/** Validate configuration and input up front (clear errors, no credits held), then queue the job. */
export async function startYouTubeAnalysis(p: Platform, workspaceId: string, appId: string, input: AnalyzeYouTubeChannelRequest, actor: string, idempotencyKey?: string) {
  assertYouTubeConfigured(p);
  parseYouTubeChannelInput(input.channel);
  await p.db.ws(workspaceId).collection("apps").getOrThrow(appId);
  return p.jobs.create(workspaceId, "analytics.youtube_channel", { appId, channel: input.channel, relation: input.relation, maxVideos: input.maxVideos }, { actor, appId, idempotencyKey, credits: { operation: "analytics.youtube_channel" } });
}

export type YouTubeAnalysisSummary = Pick<YouTubeChannelAnalysis, "id" | "appId" | "input" | "relation" | "connectedChannel" | "channel" | "fetchedAt" | "updatedAt"> & {
  videosAnalyzed: number;
  medianViews: number | null;
  interpretation: Pick<YouTubeInterpretation, "status" | "model">;
};

export function summarizeAnalysis(a: YouTubeChannelAnalysis): YouTubeAnalysisSummary {
  return {
    id: a.id,
    appId: a.appId,
    input: a.input,
    relation: a.relation,
    connectedChannel: a.connectedChannel,
    channel: a.channel,
    fetchedAt: a.fetchedAt,
    updatedAt: a.updatedAt,
    videosAnalyzed: a.stats.videosAnalyzed,
    medianViews: a.stats.medians.views,
    interpretation: { status: a.interpretation.status, model: a.interpretation.model },
  };
}

/** The app's analysed channels, newest fetch first (single-field order: no composite index needed). */
export async function listYouTubeAnalyses(p: Platform, workspaceId: string, appId: string): Promise<YouTubeAnalysisSummary[]> {
  const page = await p.db.ws(workspaceId).collection("youtubeAnalyses").list({ orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  return page.items
    .filter((a) => a.appId === appId)
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
    .map(summarizeAnalysis);
}
