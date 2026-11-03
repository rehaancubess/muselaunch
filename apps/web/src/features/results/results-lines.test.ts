import type { InsightMetric, ResultsSeries } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import type { FeedItem } from "../discover/picks";
import { bestPostLine, chartCaption, chartFootnote, chartHiddenLine, chartModel, coverageLine, niceMax, nothingYet, pickTip, rangeQuery, shortNumber, tiles, tipFromRecommendation, tipFromTest, weekIdeas } from "./results-lines";

type M = Parameters<typeof tiles>[0][number];
const metric = (name: "views" | "clicks", value: number | null, over: Partial<M> = {}): M => ({ metric: name, value, byCurrency: undefined, sources: [], attribution: null, ...over });
const src = (over: Partial<InsightMetric["sources"][number]>): InsightMetric["sources"][number] => ({ source: "youtube", label: "YouTube (API)", imported: false, attribution: "platform_reported", value: 1, observationCount: 1, definitions: [], ...over });

describe("Results: range and numbers", () => {
  it("whole UTC days ending today", () => {
    const now = Date.parse("2026-11-03T15:00:00Z");
    expect(rangeQuery("28", now)).toEqual({ from: "2026-10-07", to: "2026-11-03" });
    expect(rangeQuery("7", now)).toEqual({ from: "2026-10-28", to: "2026-11-03" });
  });

  it("short numbers like the mockup", () => {
    expect(shortNumber(386)).toBe("386");
    expect(shortNumber(4200)).toBe("4.2K");
    expect(shortNumber(12_400)).toBe("12.4K");
    expect(shortNumber(1_250_000)).toBe("1.3M");
    expect(shortNumber(0)).toBe("0");
  });
});

describe("Results: the three numbers", () => {
  const posts = { value: 8, api: 3, manual: 5 };

  it("measured values with where they come from; posts are MuseLaunch's own records", () => {
    const t = tiles(
      [metric("views", 12_400, { sources: [src({})], attribution: "platform_reported" }), metric("clicks", 386, { sources: [src({ source: "tracked_link", label: "MuseLaunch tracked links" })], attribution: "link" })],
      [],
      posts,
      "connected",
      "28",
    );
    expect(t.map((x) => [x.label, x.value, x.source, x.action])).toEqual([
      ["Views", 12_400, "From YouTube", null],
      ["Link clicks", 386, "From your MuseLaunch links", null],
      ["Posts published", 8, "From your MuseLaunch posts", null],
    ]);
  });

  it("an account-wide total says so", () => {
    const [views] = tiles([metric("views", 9400, { sources: [src({ source: "csv_import", label: "Imported CSV", imported: true })], attribution: "aggregate" })], [], posts, "connected", "28");
    expect(views).toMatchObject({ source: "From a file you imported", scope: "Total for your whole account" });
  });

  it("not measured: no number, and the one action that would measure it", () => {
    const t = tiles([metric("views", null), metric("clicks", null)], [{ metric: "views", action: "publish_post" }, { metric: "clicks", action: "create_tracked_link" }], { value: 0, api: 0, manual: 0 }, "can_connect", "28");
    expect(t[0]).toMatchObject({ value: null, action: { kind: "home", label: "Post your first video" } });
    expect(t[1]).toMatchObject({ value: null, action: { kind: "sources", focus: "links", label: "Add a tracked link" } });
    expect(t[2]).toMatchObject({ value: 0 });
    expect(nothingYet(t)).toBe(true);
    const yt = tiles([], [{ metric: "views", action: "enter_manually" }], posts, "can_connect", "28");
    expect(yt[0]!.action).toEqual({ kind: "connect_youtube", label: "Connect YouTube" });
    const typed = tiles([], [{ metric: "views", action: "enter_manually" }], posts, "unavailable", "28");
    expect(typed[0]!.action).toEqual({ kind: "sources", label: "Add your numbers", focus: "manual" });
    const widen = tiles([], [{ metric: "views", action: "widen_range" }], posts, "connected", "7");
    expect(widen[0]!.action).toEqual({ kind: "widen", label: "Show 90 days" });
    expect(nothingYet(widen)).toBe(false); // posts were published
  });

  it("one coverage note for views and clicks only", () => {
    const part = { daysWithData: 3, daysInRange: 28 };
    expect(coverageLine([{ metric: "views", value: 9400, coverage: part }, { metric: "clicks", value: null, coverage: null }])).toMatch(/^This number covers 3 of the 28 days/);
    expect(coverageLine([{ metric: "installs" as "views", value: 1, coverage: part }])).toBeNull();
  });

  it("a measured 0 is a number, not a gap", () => {
    const [, clicks] = tiles([metric("clicks", 0, { sources: [src({ source: "tracked_link", label: "MuseLaunch tracked links", observationCount: 0 })] })], [], posts, "connected", "28");
    expect(clicks).toMatchObject({ value: 0, source: "From your MuseLaunch links", action: null });
  });
});

describe("Results: the chart", () => {
  const box = { width: 300, height: 100, pad: { l: 0, r: 0, t: 0, b: 0 } };
  const pts = (values: (number | null)[]): ResultsSeries["points"] => values.map((value, i) => ({ date: `2026-10-${String(20 + i).padStart(2, "0")}`, value }));

  it("round top values", () => {
    expect(niceMax(3400)).toBe(4000);
    expect(niceMax(386)).toBe(400);
    expect(niceMax(12)).toBe(12);
    expect(niceMax(4)).toBe(4);
    expect(niceMax(0)).toBe(1);
    expect(niceMax(2400)).toBe(2500);
  });

  it("a missing day breaks the line (no zero is drawn); a lone day is a dot", () => {
    const m = chartModel(pts([3400, 2900, null, 3100]), box);
    expect(m.max).toBe(4000);
    expect(m.lines).toEqual(["M0,15 L100,27.5"]);
    expect(m.areas).toHaveLength(1);
    expect(m.dots).toEqual([{ i: 3, x: 300, y: 22.5 }]);
    expect(m.xs).toEqual([0, 100, 200, 300]);
    expect(m.ticks.map((t) => t.label)).toEqual(["Oct 20", "Oct 21", "Oct 22", "Oct 23"]);
  });

  it("measured zeros sit on the baseline", () => {
    const m = chartModel(pts([0, 0, 4]), box);
    expect(m.lines[0]).toBe("M0,100 L150,100 L300,0");
  });

  it("long ranges label the first, middle and last day", () => {
    const m = chartModel(pts(Array.from({ length: 28 }, () => 1)), box);
    expect(m.ticks.map((t) => t.i)).toEqual([0, 14, 27]);
  });

  it("explains a hidden chart, captions the shown one with its source and notes what isn't on it", () => {
    const s = (measuredDays: number, over: Partial<ResultsSeries> = {}): ResultsSeries => ({ metric: "views", label: "Views", points: pts([1, null, 2]), measuredDays, sources: [{ source: "csv_import", label: "Imported CSV", imported: true, observationCount: 2 }], multiDayLeftOut: 0, ...over });
    expect(chartHiddenLine(s(2), 28)).toBe("A daily chart appears once views are measured on at least 3 days. There’s only 2 days with a number in the last 28 days so far.");
    expect(chartHiddenLine(s(1, { metric: "clicks" }), 7)).toMatch(/link clicks .* only 1 day/);
    expect(chartHiddenLine(s(3), 28)).toBeNull();
    expect(chartHiddenLine(null, 28)).toBeNull();
    expect(chartCaption(s(3))).toBe("Views per day · From a file you imported");
    expect(chartFootnote(s(3))).toBe("Days without a number are left blank, not counted as zero.");
    expect(chartFootnote(s(3, { points: pts([1, 2, 3]), multiDayLeftOut: 2 }))).toBe("2 numbers cover several days at once, so they aren’t on the chart.");
    expect(chartFootnote(s(3, { points: pts([1, 2, 3]) }))).toBeNull();
  });
});

describe("Results: best post", () => {
  it("says how many posts it was compared with, and ties", () => {
    const yt = [{ source: "youtube" as const, label: "YouTube (API)", imported: false, observationCount: 1 }];
    expect(bestPostLine({ metric: "views", comparedPosts: 5, tiedWith: 0, sources: yt })).toBe("Most views of your 5 posts with numbers · From YouTube.");
    expect(bestPostLine({ metric: "clicks", comparedPosts: 1, tiedWith: 0, sources: [] })).toBe("Your only post with link clicks measured so far.");
    expect(bestPostLine({ metric: "views", comparedPosts: 3, tiedWith: 1, sources: [{ source: "manual", label: "Manual entry", imported: true, observationCount: 2 }] })).toBe("Tied for the most views of your 3 posts with numbers · Typed in by you.");
  });
});

describe("Results: the tip (never a cause, always the sample)", () => {
  const exp = {
    title: "Feature demo vs problem hook",
    primaryMetric: "clicks",
    variants: [
      { key: "a", label: "Problem hook", publicationIds: ["p1", "p2", "p3"], isControl: true },
      { key: "b", label: "Feature demo", publicationIds: ["p4", "p5", "p6"], isControl: false },
    ],
  };
  const result = {
    confidence: "medium" as const,
    measured: [{ text: "Feature demo posts got 160 link clicks; problem hook posts got 70.", observationIds: ["o1", "o2"] }],
    perVariant: [
      { key: "a", metrics: [{ metric: "clicks", value: 70, observationIds: ["o1"] }] },
      { key: "b", metrics: [{ metric: "clicks", value: 160, observationIds: ["o2"] }] },
      { key: "baseline", metrics: [{ metric: "clicks", value: 900, observationIds: [] }] },
    ],
  };

  it("from a test with enough data: the leader, the measured sentence, the sample, a deep link to Create", () => {
    expect(tipFromTest(exp, result)).toEqual({
      title: "“Feature demo” got the most link clicks",
      body: "Feature demo posts got 160 link clicks; problem hook posts got 70.",
      basis: "From your test “Feature demo vs problem hook”: 6 posts, 230 link clicks in all.",
      caution: null,
      kind: "feature",
      prompt: "Another post like “Feature demo” (it got the most link clicks in my test “Feature demo vs problem hook”)",
      button: "Create a feature demo",
      from: "test",
    });
    expect(tipFromTest(exp, { ...result, confidence: "low" })?.caution).toMatch(/small sample/);
  });

  it("hidden when the data isn't enough or no version is clearly ahead", () => {
    expect(tipFromTest(exp, { ...result, confidence: "insufficient_data" })).toBeNull();
    expect(tipFromTest(exp, { ...result, measured: [] })).toBeNull();
    const tie = { ...result, perVariant: result.perVariant.map((v) => ({ ...v, metrics: v.metrics.map((m) => ({ ...m, value: v.key === "baseline" ? 1 : 50 })) })) };
    expect(tipFromTest(exp, tie)).toBeNull();
    const missingOne = { ...result, perVariant: [result.perVariant[1]!, { key: "a", metrics: [{ metric: "clicks", value: null, observationIds: [] }] }] };
    expect(tipFromTest(exp, missingOne)).toBeNull();
    expect(tipFromTest(exp, { ...result, measured: [{ text: "The feature demo drove 160 link clicks.", observationIds: ["o2"] }] })).toBeNull();
    expect(tipFromTest(null, result)).toBeNull();
  });

  it("a version that isn't a feature demo makes a 'make another' tip", () => {
    const e2 = { ...exp, variants: [{ ...exp.variants[0]!, label: "Question hook" }, { ...exp.variants[1]!, label: "Statement hook" }] };
    expect(tipFromTest(e2, result)).toMatchObject({ title: "“Statement hook” got the most link clicks", kind: "promote", button: "Make another like it" });
  });

  const rec = {
    title: "Post more screen recordings of Focus Mode",
    rationale: "Your 3 Focus Mode posts had the most link clicks of your last 8 posts.\n\nBased on limited data.",
    status: "new" as const,
    confidence: "medium" as const,
    basedOn: { observationIds: ["o1", "o2", "o3"], resultIds: [], findingIds: [], preferenceIds: [], sources: [] },
  };

  it("from a recommendation only when grounded in several measured numbers and not low confidence", () => {
    expect(tipFromRecommendation(rec)).toMatchObject({
      title: "Post more screen recordings of Focus Mode",
      body: "Your 3 Focus Mode posts had the most link clicks of your last 8 posts.",
      basis: "Muse’s suggestion, based on 3 of your measured numbers.",
      kind: "promote",
      from: "recommendation",
    });
    expect(tipFromRecommendation({ ...rec, confidence: "low" })).toBeNull();
    expect(tipFromRecommendation({ ...rec, basedOn: { ...rec.basedOn, observationIds: ["o1"] } })).toBeNull();
    expect(tipFromRecommendation({ ...rec, status: "dismissed" })).toBeNull();
    expect(tipFromRecommendation({ ...rec, rationale: "Screen recordings led to more installs." })).toBeNull();
  });

  it("a test result comes first, then a recommendation, else nothing", () => {
    expect(pickTip({ exp, result }, [rec])?.from).toBe("test");
    expect(pickTip({ exp, result: { ...result, confidence: "insufficient_data" } }, [rec])?.from).toBe("recommendation");
    expect(pickTip(null, [{ ...rec, confidence: "low" }])).toBeNull();
  });
});

describe("Results: what Muse found", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const item = (id: string, over: Partial<FeedItem> = {}): FeedItem => ({
    id,
    type: "opportunity",
    refId: `opp_${id}`,
    title: `Idea ${id}`,
    summary: "",
    channels: [],
    geography: [],
    tags: [],
    sources: [{ kind: "url", url: `https://example.com/${id}`, title: "A page", retrievedAt: "2026-11-01T00:00:00Z" }],
    retrievedAt: "2026-11-01T00:00:00Z",
    observedAt: "2026-11-01T00:00:00Z",
    confidence: 0.8,
    score: 1,
    freshness: 1,
    rank: 1,
    provenance: "research",
    ...over,
  });

  it("the top 1–2 ideas not used yet; 'this week' only when they were all found in the last 7 days", () => {
    const out = weekIdeas([item("a"), item("b", { status: "used", campaignId: "cpg_1" }), item("c"), item("d")], now);
    expect(out.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(out.thisWeek).toBe(true);
    expect(weekIdeas([item("a", { retrievedAt: "2026-10-01T00:00:00Z" })], now).thisWeek).toBe(false);
    expect(weekIdeas([item("x", { sources: [] })], now)).toEqual({ items: [], thisWeek: false });
  });
});
