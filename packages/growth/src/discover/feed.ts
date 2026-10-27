import { Channel, ContentType, type Opportunity, type ResearchFinding, type SourceRef, type TrackedCreator } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { z } from "zod";
import { DAY_MS, factualSources, latestIso, normText, normUrl } from "../util";

/**
 * Discover feed: research findings + opportunities (created by module B's Wonder research) and
 * observations of tracked public accounts (discover.refresh), ranked by score × freshness.
 * Every card carries its sources, retrieval time and confidence. Items without a checkable
 * source are excluded (never shown as research).
 */

export const FeedQuery = z.object({
  channel: Channel.optional(),
  audience: z.string().max(120).optional(),
  geography: z.string().length(2).optional(),
  maxAgeDays: z.coerce.number().int().min(1).max(365).optional(),
  contentType: ContentType.optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  types: z
    .string()
    .optional()
    .transform((s) => (s ? (s.split(",").filter(Boolean) as FeedItemType[]) : undefined)),
  includeDismissed: z.coerce.boolean().default(false),
  savedOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(20).optional(),
});
export type FeedQuery = z.infer<typeof FeedQuery>;

export type FeedItemType = "opportunity" | "finding" | "tracker_update";

export interface FeedItem {
  id: string;
  type: FeedItemType;
  refId: string;
  title: string;
  summary: string;
  /** Model reading of what it means for the app — always labelled as interpretation, separate from the sourced statement. */
  interpretation?: string;
  proposedAngle?: string;
  audience?: string;
  channels: Channel[];
  contentType?: z.infer<typeof ContentType>;
  effort?: "low" | "medium" | "high";
  geography: string[];
  tags: string[];
  sources: SourceRef[];
  /** Most recent retrieval time across the sources. */
  retrievedAt: string;
  observedAt: string;
  confidence: number;
  /** 0–100 base score before freshness. */
  score: number;
  /** 0–1, half-life decay by item kind. */
  freshness: number;
  rank: number;
  status?: Opportunity["status"];
  campaignId?: string;
  relatedFindingIds: string[];
  trackerId?: string;
  provenance: "research" | "tracked_account";
  /** Always "sourced" in the feed: unsourced items are excluded. */
  evidenceLabel: "sourced";
}

const HALF_LIFE_DAYS: Record<string, number> = {
  trend: 14,
  hook: 21,
  format: 30,
  audience_conversation: 21,
  creator: 45,
  community: 60,
  competitor_strategy: 45,
  market: 90,
  opportunity: 21,
  tracker_update: 21,
};

export function freshnessOf(observedAt: string, halfLifeDays: number, now: number): number {
  const age = Math.max(0, (now - Date.parse(observedAt)) / DAY_MS);
  return Number(Math.pow(0.5, age / halfLifeDays).toFixed(4));
}

function opportunityItem(o: Opportunity, now: number): FeedItem | null {
  const sources = factualSources(o.evidence);
  if (!sources.length) return null;
  const freshness = freshnessOf(o.observedAt, HALF_LIFE_DAYS.opportunity!, now);
  return {
    id: `opportunity:${o.id}`,
    type: "opportunity",
    refId: o.id,
    title: o.title,
    summary: o.topic,
    interpretation: o.whyRelevant,
    proposedAngle: o.proposedAngle,
    audience: o.audience,
    channels: o.channels,
    contentType: o.contentType,
    effort: o.effort,
    geography: o.geography,
    tags: [],
    sources,
    retrievedAt: latestIso(sources.map((s) => s.retrievedAt))!,
    observedAt: o.observedAt,
    confidence: o.confidence,
    score: o.score,
    freshness,
    rank: Number((o.score * freshness).toFixed(3)),
    status: o.status,
    campaignId: o.campaignId,
    relatedFindingIds: o.findingIds,
    provenance: "research",
    evidenceLabel: "sourced",
  };
}

function findingItem(f: ResearchFinding, now: number): FeedItem | null {
  const sources = factualSources(f.evidence);
  if (!sources.length) return null;
  const freshness = freshnessOf(f.observedAt, HALF_LIFE_DAYS[f.kind] ?? 30, now);
  const corroborationBoost = Math.min(1, 0.7 + 0.15 * (Math.max(f.corroboration, sources.length) - 1));
  const score = Math.round(f.confidence * corroborationBoost * 100);
  return {
    id: `finding:${f.id}`,
    type: "finding",
    refId: f.id,
    title: f.statement.length > 120 ? `${f.statement.slice(0, 117)}…` : f.statement,
    summary: f.statement,
    interpretation: f.interpretation,
    channels: f.channels,
    geography: [],
    tags: [f.kind, ...f.tags],
    sources,
    retrievedAt: latestIso(sources.map((s) => s.retrievedAt))!,
    observedAt: f.observedAt,
    confidence: f.confidence,
    score,
    freshness,
    rank: Number((score * freshness).toFixed(3)),
    relatedFindingIds: [],
    provenance: "research",
    evidenceLabel: "sourced",
  };
}

function trackerItems(t: TrackedCreator, now: number): FeedItem[] {
  const out: FeedItem[] = [];
  t.observations.forEach((obs, i) => {
    const sources = factualSources([obs.source]);
    if (!sources.length) return;
    const observedAt = obs.observedAt ?? t.lastObservedAt ?? obs.source.retrievedAt;
    const confidence = obs.confidence ?? 0.6;
    const freshness = freshnessOf(observedAt, HALF_LIFE_DAYS.tracker_update!, now);
    const score = Math.round(confidence * 80);
    out.push({
      id: `tracker_update:${t.id}:${i}`,
      type: "tracker_update",
      refId: t.id,
      title: `${t.displayName ?? t.handle} · ${obs.kind ?? "update"}`,
      summary: obs.text,
      channels: [t.channel],
      geography: [],
      tags: [t.kind, ...(obs.kind ? [obs.kind] : [])],
      sources,
      retrievedAt: sources[0]!.retrievedAt,
      observedAt,
      confidence,
      score,
      freshness,
      rank: Number((score * freshness).toFixed(3)),
      relatedFindingIds: [],
      trackerId: t.id,
      provenance: "tracked_account",
      evidenceLabel: "sourced",
    });
  });
  return out;
}

function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const seen = new Set(a.map((s) => (s.url ? normUrl(s.url) : `${s.assetId}:${s.evidenceId}`)));
  return [...a, ...b.filter((s) => !seen.has(s.url ? normUrl(s.url) : `${s.assetId}:${s.evidenceId}`))];
}

/** Pure ranking/dedupe/filter step (unit-tested separately from storage). */
export function buildFeed(
  input: { opportunities: Opportunity[]; findings: ResearchFinding[]; trackers: TrackedCreator[] },
  q: Partial<FeedQuery>,
  now = Date.now(),
): { items: FeedItem[]; nextCursor: string | null; excluded: { unsourced: number; duplicates: number; filtered: number } } {
  let unsourced = 0;
  let duplicates = 0;
  let filtered = 0;
  const opps = input.opportunities
    .filter((o) => (q.includeDismissed ? true : o.status !== "dismissed"))
    .map((o) => opportunityItem(o, now))
    .filter((x): x is FeedItem => (x ? true : (unsourced++, false)));

  // Findings that an opportunity builds on are folded into that card, not repeated.
  const folded = new Set(opps.flatMap((o) => o.relatedFindingIds));
  const findings = input.findings
    .filter((f) => !folded.has(f.id))
    .map((f) => findingItem(f, now))
    .filter((x): x is FeedItem => (x ? true : (unsourced++, false)));
  const tracker = input.trackers.flatMap((t) => trackerItems(t, now));

  // Dedupe: same normalised title/statement (or finding dedupKey) → keep higher rank, merge sources.
  const byKey = new Map<string, FeedItem>();
  const dedupKeyOf = (i: FeedItem) => {
    if (i.type === "finding") {
      const f = input.findings.find((x) => x.id === i.refId);
      return `f:${f?.dedupKey || normText(i.summary)}`;
    }
    return `${i.type === "opportunity" ? "o" : "t"}:${normText(i.type === "opportunity" ? i.title : i.summary)}`;
  };
  for (const item of [...opps, ...findings, ...tracker]) {
    const key = dedupKeyOf(item);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, item);
      continue;
    }
    duplicates++;
    const [keep, drop] = prev.rank >= item.rank ? [prev, item] : [item, prev];
    keep.sources = mergeSources(keep.sources, drop.sources);
    keep.relatedFindingIds = [...new Set([...keep.relatedFindingIds, ...drop.relatedFindingIds])];
    byKey.set(key, keep);
  }

  const matches = (i: FeedItem) => {
    if (q.types?.length && !q.types.includes(i.type)) return false;
    if (q.channel && i.channels.length && !i.channels.includes(q.channel)) return false;
    if (q.channel && !i.channels.length && i.type !== "finding") return false;
    if (q.geography && i.type === "opportunity" && i.geography.length && !i.geography.includes(q.geography.toUpperCase())) return false;
    if (q.contentType && i.contentType !== q.contentType) return false;
    if (q.effort && i.effort !== q.effort) return false;
    if (q.maxAgeDays && now - Date.parse(i.observedAt) > q.maxAgeDays * DAY_MS) return false;
    if (q.savedOnly && i.status !== "saved") return false;
    if (q.audience) {
      const needle = normText(q.audience);
      const hay = normText([i.audience ?? "", i.summary, i.tags.join(" ")].join(" "));
      if (!hay.includes(needle)) return false;
    }
    return true;
  };
  const all = [...byKey.values()].filter((i) => (matches(i) ? true : (filtered++, false)));
  all.sort((a, b) => b.rank - a.rank || b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
  const offset = q.cursor ? Math.max(0, Number(q.cursor) || 0) : 0;
  const limit = q.limit ?? 30;
  const items = all.slice(offset, offset + limit);
  return { items, nextCursor: offset + limit < all.length ? String(offset + limit) : null, excluded: { unsourced, duplicates, filtered } };
}

/** Load the app's Discover inputs and build the feed. */
export async function discoverFeed(ws: WorkspaceDb, appId: string, q: Partial<FeedQuery>, now = Date.now()) {
  const byApp = { where: [["appId", "==", appId]] as const, orderBy: { field: "createdAt", dir: "desc" as const }, limit: 300 };
  const [opps, findings, trackers] = await Promise.all([
    ws.collection("opportunities").list(byApp),
    ws.collection("researchFindings").list(byApp),
    ws.collection("trackedCreators").list(byApp),
  ]);
  const feed = buildFeed({ opportunities: opps.items, findings: findings.items, trackers: trackers.items }, q, now);
  return { ...feed, generatedAt: new Date(now).toISOString() };
}
