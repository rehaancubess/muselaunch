/**
 * Discover feed shapes (GET /apps/:appId/discover/feed, packages/growth/src/discover/feed.ts) and the
 * plain-TS choices behind "What Muse found": which few ideas to show, which source to name, and the
 * one line on why an idea fits. No React here (unit-tested in picks.test.ts).
 */
import type { Channel, SourceRef } from "@muselaunch/contracts";

export type FeedItem = {
  id: string;
  type: "opportunity" | "finding" | "tracker_update";
  refId: string;
  title: string;
  summary: string;
  interpretation?: string;
  proposedAngle?: string;
  audience?: string;
  channels: Channel[];
  contentType?: string;
  effort?: "low" | "medium" | "high";
  geography: string[];
  tags: string[];
  sources: SourceRef[];
  retrievedAt: string;
  observedAt: string;
  confidence: number;
  score: number;
  freshness: number;
  rank: number;
  status?: "new" | "saved" | "dismissed" | "used";
  campaignId?: string;
  trackerId?: string;
  provenance: "research" | "tracked_account";
};

export type FeedResponse = { items: FeedItem[]; nextCursor: string | null; excluded: { unsourced: number; duplicates: number; filtered: number }; generatedAt: string };

/** How many ideas the main Discover page shows. Everything else is one tap away ("See everything"). */
export const TOP_PICKS = 5;

/**
 * The few best ideas for this app right now: ideas Muse made for this app (opportunities), each with
 * a real source, in the feed's own order (relevance × freshness, newest first on ties). Ideas not
 * acted on come first; ideas already turned into videos ("used", e.g. by Autopilot) fill the rest so
 * the page says what Muse did with them. Waved-away ideas ("dismissed") never come back here.
 */
export function topPicks(items: FeedItem[], max = TOP_PICKS): FeedItem[] {
  const ideas = items.filter((i) => i.type === "opportunity" && i.status !== "dismissed" && primarySource(i));
  return [...ideas.filter((i) => i.status !== "used"), ...ideas.filter((i) => i.status === "used")].slice(0, max);
}

/** An idea Muse already made videos from: it links to them instead of offering to make another. */
export const isUsed = (i: Pick<FeedItem, "status" | "campaignId">) => i.status === "used" && Boolean(i.campaignId);

/** The source to name on a card: the first one people can open, else the first one at all. */
export function primarySource(item: Pick<FeedItem, "sources">): SourceRef | undefined {
  return item.sources.find((s) => s.url && s.kind !== "model_inference") ?? item.sources.find((s) => s.kind !== "model_inference");
}

/** A site's name for people: the publisher when known, else the web address without "www.". */
export function siteName(source: Pick<SourceRef, "url" | "publisher" | "title">): string {
  if (source.publisher?.trim()) return source.publisher.trim();
  if (source.url) {
    try {
      return new URL(source.url).hostname.replace(/^www\./, "");
    } catch {
      /* fall through */
    }
  }
  return source.title?.trim() || "Source";
}

/** The first sentence of a longer text, cut at a word near `max` characters. */
export function firstSentence(text: string | undefined, max = 200): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1]! : t;
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max * 0.6))).replace(/[,;:\s]+$/, "")}…`;
}

/** Why this idea fits the app, in one line (Muse's reading: the card labels it as such). */
export function whyLine(item: Pick<FeedItem, "interpretation" | "proposedAngle" | "summary" | "title">): string {
  return firstSentence(item.interpretation) || firstSentence(item.proposedAngle) || (item.summary !== item.title ? firstSentence(item.summary) : "");
}
