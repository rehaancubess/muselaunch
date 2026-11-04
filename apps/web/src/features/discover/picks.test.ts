import { describe, expect, it } from "vitest";
import { firstSentence, isUsed, primarySource, siteName, topPicks, whyLine, type FeedItem } from "./picks";

const src = (url?: string, extra: Partial<FeedItem["sources"][number]> = {}) => ({ kind: "url" as const, url, title: "A page", retrievedAt: "2026-11-01T00:00:00.000Z", ...extra });
const item = (id: string, over: Partial<FeedItem> = {}): FeedItem => ({
  id: `opportunity:${id}`,
  type: "opportunity",
  refId: id,
  title: `Idea ${id}`,
  summary: "topic",
  channels: [],
  geography: [],
  tags: [],
  sources: [src("https://trends.example.com/a")],
  retrievedAt: "2026-11-01T00:00:00.000Z",
  observedAt: "2026-11-01T00:00:00.000Z",
  confidence: 0.7,
  score: 70,
  freshness: 1,
  rank: 70,
  status: "new",
  provenance: "research",
  ...over,
});

describe("What Muse found (picks.ts)", () => {
  it("shows at most five ideas for this app, in the feed's ranked order", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"].map((id) => item(id));
    expect(topPicks(items).map((i) => i.refId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(topPicks(items, 2).map((i) => i.refId)).toEqual(["a", "b"]);
  });

  it("skips research findings, tracked-account updates and dismissed ideas; ideas already made into videos come last", () => {
    const items = [
      item("used", { status: "used", campaignId: "c1" }),
      item("finding", { type: "finding" }),
      item("tracked", { type: "tracker_update" }),
      item("gone", { status: "dismissed" }),
      item("saved", { status: "saved" }),
      item("fresh"),
    ];
    expect(topPicks(items).map((i) => i.refId)).toEqual(["saved", "fresh", "used"]);
    expect(topPicks(items, 2).map((i) => i.refId)).toEqual(["saved", "fresh"]);
    expect(isUsed(items[0]!)).toBe(true);
    expect(isUsed(item("x", { status: "used" }))).toBe(false);
  });

  it("never shows an idea without a real source", () => {
    expect(topPicks([item("x", { sources: [] }), item("y", { sources: [src(undefined, { kind: "model_inference" })] })])).toEqual([]);
  });

  it("names the source people can open, by publisher or web address", () => {
    const s = primarySource({ sources: [src(undefined, { kind: "search_result" }), src("https://www.reddit.com/r/productivity/x")] });
    expect(s?.url).toBe("https://www.reddit.com/r/productivity/x");
    expect(siteName(s!)).toBe("reddit.com");
    expect(siteName(src("https://x.example.com", { publisher: "The Verge" }))).toBe("The Verge");
    expect(siteName(src(undefined, { title: "App Store listing" }))).toBe("App Store listing");
  });

  it("says why an idea fits in one sentence", () => {
    expect(whyLine({ title: "t", summary: "t", interpretation: "The format centres on a visible timer. It also loops well." })).toBe("The format centres on a visible timer.");
    expect(whyLine({ title: "t", summary: "t", proposedAngle: "A 25-minute session in 15 seconds" })).toBe("A 25-minute session in 15 seconds");
    expect(whyLine({ title: "t", summary: "t" })).toBe("");
    const long = firstSentence("word ".repeat(80), 60);
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });
});
