import { Channel, HttpUrl, Id, type Claim, type Competitor, type SourceRef, type TrackedCreator } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, assertSafeUrl } from "@muselaunch/platform";
import { z } from "zod";
import { DAY_MS, factualSources } from "../util";

export const MAX_TRACKERS_PER_APP = 30;

export const TrackerKind = z.enum(["competitor", "creator", "inspiration", "community"]);

export const CreateTrackerRequest = z.object({
  channel: Channel,
  handle: z
    .string()
    .min(1)
    .max(120)
    .transform((h) => h.trim()),
  url: HttpUrl.optional(),
  displayName: z.string().max(120).optional(),
  kind: TrackerKind,
  competitorId: Id.optional(),
  notes: z.string().max(2000).default(""),
});

export const UpdateTrackerRequest = z.object({
  displayName: z.string().max(120).optional(),
  url: HttpUrl.optional(),
  kind: TrackerKind.optional(),
  competitorId: Id.nullable().optional(),
  notes: z.string().max(2000).optional(),
});

const CHANNEL_HOSTS: Partial<Record<Channel, string[]>> = {
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be"],
  x: ["x.com", "twitter.com"],
  linkedin: ["linkedin.com"],
  facebook: ["facebook.com", "fb.com"],
  threads: ["threads.net", "threads.com"],
  reddit: ["reddit.com"],
  producthunt: ["producthunt.com"],
  hackernews: ["news.ycombinator.com"],
  app_store: ["apps.apple.com"],
  google_play: ["play.google.com"],
};

/** Public profile URLs only, on the channel's own domain. */
export function assertChannelUrl(channel: Channel, url: string): void {
  const u = assertSafeUrl(url);
  const hosts = CHANNEL_HOSTS[channel];
  if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
    throw new AppError("BAD_REQUEST", `URL host ${u.hostname} does not belong to ${channel}`, { userMessage: `That link isn't a ${channel} address.` });
  }
}

export async function createTracker(ws: WorkspaceDb, appId: string, input: z.infer<typeof CreateTrackerRequest>, actor: string): Promise<TrackedCreator> {
  if (input.url) assertChannelUrl(input.channel, input.url);
  const existing = (await ws.collection("trackedCreators").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: MAX_TRACKERS_PER_APP + 1 })).items;
  if (existing.length >= MAX_TRACKERS_PER_APP) throw new AppError("QUOTA_EXCEEDED", `Up to ${MAX_TRACKERS_PER_APP} tracked accounts per app`);
  const handle = input.handle.replace(/^@/, "");
  const dup = existing.find((t) => t.channel === input.channel && t.handle.toLowerCase() === handle.toLowerCase());
  if (dup) throw new AppError("ALREADY_EXISTS", `Already tracking ${input.channel}/${handle}`);
  if (input.competitorId) await ws.collection("competitors").getOrThrow(input.competitorId);
  return ws.collection("trackedCreators").create({ appId, channel: input.channel, handle, url: input.url, displayName: input.displayName, kind: input.kind, competitorId: input.competitorId, notes: input.notes }, { actor });
}

export async function updateTracker(ws: WorkspaceDb, id: string, input: z.infer<typeof UpdateTrackerRequest>, actor: string): Promise<TrackedCreator> {
  const t = await ws.collection("trackedCreators").getOrThrow(id);
  if (input.url) assertChannelUrl(t.channel, input.url);
  if (input.competitorId) await ws.collection("competitors").getOrThrow(input.competitorId);
  const { competitorId, ...rest } = input;
  return ws.collection("trackedCreators").update(id, { ...rest, ...(competitorId !== undefined ? { competitorId: competitorId ?? undefined } : {}) }, { actor });
}

const initials = (s: string) =>
  s
    .replace(/^@/, "")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** Story-style row model: newest activity first, `hasRecent` when observed in the last 7 days. */
export function storyRow(trackers: TrackedCreator[], now = Date.now()) {
  return trackers
    .map((t) => {
      const latest = t.observations.find((o) => factualSources([o.source]).length);
      return {
        id: t.id,
        kind: t.kind,
        channel: t.channel,
        handle: t.handle,
        displayName: t.displayName ?? t.handle,
        initials: initials(t.displayName ?? t.handle),
        url: t.url,
        lastObservedAt: t.lastObservedAt,
        observationCount: t.observations.length,
        hasRecent: Boolean(t.lastObservedAt && now - Date.parse(t.lastObservedAt) < 7 * DAY_MS),
        lastRefreshError: t.lastRefreshError,
        latest: latest ? { text: latest.text, kind: latest.kind, source: latest.source, observedAt: latest.observedAt } : undefined,
      };
    })
    .sort((a, b) => (b.lastObservedAt ?? "").localeCompare(a.lastObservedAt ?? "") || a.displayName.localeCompare(b.displayName));
}

type Obs = { text: string; sources: SourceRef[]; observedAt?: string; confidence?: number; origin: "tracker" | "research" };

/** Verified claims usable for a context (state verified, context permitted). */
export async function verifiedClaims(ws: WorkspaceDb, appId: string, context: "social" | "outreach" | "ads" | "video" | "store" = "social"): Promise<Claim[]> {
  const page = await ws.collection("claims").list({ where: [["appId", "==", appId], ["state", "==", "verified"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  return page.items.filter((c) => c.permittedContexts.includes("all") || c.permittedContexts.includes(context));
}

/**
 * Competitor profile view model: positioning, recurring hooks and formats (each with sources), and a
 * comparison against the user's VERIFIED claims only. Research comparison rows whose "us" side is
 * not tied to verified claims are returned separately and flagged.
 */
export async function competitorProfile(ws: WorkspaceDb, appId: string, ref: { competitorId?: string; trackerId?: string }) {
  let competitor: Competitor | null = null;
  let trackers: TrackedCreator[] = [];
  if (ref.trackerId) {
    const t = await ws.collection("trackedCreators").getOrThrow(ref.trackerId);
    if (t.appId !== appId) throw new AppError("NOT_FOUND", "Tracker not found");
    trackers = [t];
    if (t.competitorId) competitor = await ws.collection("competitors").get(t.competitorId);
  }
  if (ref.competitorId) {
    competitor = await ws.collection("competitors").getOrThrow(ref.competitorId);
    if (competitor.appId !== appId) throw new AppError("NOT_FOUND", "Competitor not found");
    const all = (await ws.collection("trackedCreators").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 })).items;
    trackers = all.filter((t) => t.competitorId === competitor!.id);
  }
  const claims = await verifiedClaims(ws, appId, "social");
  const claimById = new Map(claims.map((c) => [c.id, c]));

  const groups: Record<"positioning" | "hooks" | "formats" | "other", Obs[]> = { positioning: [], hooks: [], formats: [], other: [] };
  for (const t of trackers) {
    for (const o of t.observations) {
      const sources = factualSources([o.source]);
      if (!sources.length) continue;
      const bucket = o.kind === "positioning" ? "positioning" : o.kind === "hook" ? "hooks" : o.kind === "format" ? "formats" : "other";
      groups[bucket].push({ text: o.text, sources, observedAt: o.observedAt ?? t.lastObservedAt, confidence: o.confidence, origin: "tracker" });
    }
  }
  const compSources = competitor ? factualSources(competitor.sources) : [];
  if (competitor && compSources.length) {
    if (competitor.positioning) groups.positioning.push({ text: competitor.positioning, sources: compSources, observedAt: competitor.lastResearchedAt, origin: "research" });
    for (const h of competitor.observedHooks) groups.hooks.push({ text: h, sources: compSources, observedAt: competitor.lastResearchedAt, origin: "research" });
    for (const f of competitor.observedFormats) groups.formats.push({ text: f, sources: compSources, observedAt: competitor.lastResearchedAt, origin: "research" });
  }

  const comparison = trackers
    .flatMap((t) => t.comparison)
    .map((row) => {
      const usClaims = row.usClaimIds.map((id) => claimById.get(id)).filter((c): c is Claim => Boolean(c));
      return usClaims.length === row.usClaimIds.length ? { topic: row.topic, them: row.them, themSources: factualSources(row.evidence), us: usClaims.map((c) => c.text).join(" · "), usClaims: usClaims.map((c) => ({ id: c.id, text: c.text })) } : null;
    })
    .filter((r): r is NonNullable<typeof r> => Boolean(r && r.themSources.length));
  const researchComparison = (competitor?.comparison ?? [])
    .filter((r) => factualSources(r.evidence).length)
    .map((r) => ({ topic: r.topic, them: r.them, themSources: factualSources(r.evidence), us: r.us, usVerified: claims.some((c) => c.text.trim().toLowerCase() === r.us.trim().toLowerCase()) }));

  return {
    name: competitor?.name ?? trackers[0]?.displayName ?? trackers[0]?.handle ?? "Competitor",
    competitorId: competitor?.id,
    trackers: trackers.map((t) => ({ id: t.id, channel: t.channel, handle: t.handle, url: t.url, lastObservedAt: t.lastObservedAt, lastRefreshError: t.lastRefreshError })),
    websiteUrl: competitor?.websiteUrl,
    storeUrls: competitor?.storeUrls,
    positioning: groups.positioning,
    hooks: groups.hooks,
    formats: groups.formats,
    other: groups.other,
    comparison,
    researchComparison,
    ourVerifiedClaims: claims.map((c) => ({ id: c.id, text: c.text })),
    lastObservedAt: [competitor?.lastResearchedAt, ...trackers.map((t) => t.lastObservedAt)].filter(Boolean).sort().at(-1),
    notes: [
      "Observations come from publicly accessible pages found via web search; each lists its source and retrieval time.",
      "The comparison uses only your verified claims. Verify more claims in App DNA to compare more features.",
      ...(researchComparison.some((r) => !r.usVerified) ? ["Some research comparison rows describe your app with statements that aren't verified claims; they're marked as unverified."] : []),
    ],
  };
}
