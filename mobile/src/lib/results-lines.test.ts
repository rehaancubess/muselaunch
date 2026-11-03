import { bestPostLine, chartHiddenLine, chartModel, fullNumber, nothingYet, pickTip, shortNumber, tiles, tipFromRecommendation, tipFromTest } from "./results-lines";

const src = (label: string, source = "youtube", n = 3) => ({ source, label, imported: false, observationCount: n });

describe("the three numbers", () => {
  it("shows measured values with where they come from, and never a guessed 0", () => {
    const t = tiles(
      [{ metric: "views", value: 12400, sources: [src("YouTube (API)")], attribution: "aggregate" }, { metric: "clicks", value: null, sources: [], attribution: null }],
      [{ metric: "clicks", action: "create_tracked_link" }],
      { value: 8, api: 3, manual: 5 },
    );
    expect(t[0]).toMatchObject({ label: "Views", value: 12400, source: "From YouTube", scope: "Total for your whole account" });
    expect(t[1]).toMatchObject({ label: "Link clicks", value: null, missing: "Posts with a tracked link count clicks" });
    expect(t[2]).toMatchObject({ label: "Posts published", value: 8, source: "From your MuseLaunch posts" });
    expect(nothingYet(t)).toBe(false);
    expect(nothingYet(tiles([], [{ metric: "views", action: "publish_post" }], { value: 0, api: 0, manual: 0 }))).toBe(true);
  });

  it("formats numbers compactly without Intl", () => {
    expect(shortNumber(386)).toBe("386");
    expect(shortNumber(12400)).toBe("12.4K");
    expect(shortNumber(4000)).toBe("4K");
    expect(shortNumber(1_250_000)).toBe("1.3M");
    expect(fullNumber(1234567.5)).toBe("1,234,567.5");
  });
});

describe("the chart", () => {
  it("leaves days without a number as gaps", () => {
    const pts = [
      { date: "2026-10-01", value: 10 },
      { date: "2026-10-02", value: 20 },
      { date: "2026-10-03", value: null },
      { date: "2026-10-04", value: 5 },
      { date: "2026-10-05", value: 15 },
    ];
    const m = chartModel(pts, { width: 300, height: 160, pad: { l: 8, r: 8, t: 14, b: 24 } });
    expect(m.lines).toHaveLength(2);
    expect(m.max).toBe(20);
    expect(m.ticks.map((t) => t.label)).toEqual(["Oct 1", "Oct 2", "Oct 3", "Oct 4", "Oct 5"]);
  });

  it("hides itself with one line until 3 days are measured", () => {
    const series = { metric: "views" as const, label: "Views", points: [], measuredDays: 1, sources: [], multiDayLeftOut: 0 };
    expect(chartHiddenLine(series, 28)).toBe("A daily chart appears once views are measured on at least 3 days. There’s only 1 day with a number in the last 28 days so far.");
    expect(chartHiddenLine({ ...series, measuredDays: 3 }, 28)).toBeNull();
  });
});

describe("best post and the tip", () => {
  it("is honest about ties and a single post", () => {
    expect(bestPostLine({ metric: "views", comparedPosts: 1, tiedWith: 0, sources: [src("YouTube")] })).toBe("Your only post with views measured so far · From YouTube.");
    expect(bestPostLine({ metric: "clicks", comparedPosts: 5, tiedWith: 1, sources: [] })).toBe("Tied for the most link clicks of your 5 posts with numbers.");
  });

  it("only tips from a test with enough data and a clear leader, with its sample", () => {
    const exp = { title: "Hooks", primaryMetric: "clicks", variants: [{ key: "a", label: "Feature demo", publicationIds: ["p1", "p2"] }, { key: "b", label: "Founder story", publicationIds: ["p3"] }] };
    const result = { confidence: "low" as const, measured: [{ text: "Feature demo posts got 40 link clicks; founder story posts got 12.", observationIds: ["o1"] }], perVariant: [{ key: "a", metrics: [{ metric: "clicks", value: 40 }] }, { key: "b", metrics: [{ metric: "clicks", value: 12 }] }] };
    const tip = tipFromTest(exp, result)!;
    expect(tip.title).toBe("“Feature demo” got the most link clicks");
    expect(tip.basis).toBe("From your test “Hooks”: 3 posts, 52 link clicks in all.");
    expect(tip.caution).toMatch(/small sample/);
    expect(tipFromTest(exp, { ...result, confidence: "insufficient_data" })).toBeNull();
    expect(tipFromTest(exp, { ...result, measured: [{ text: "Feature demos caused more clicks.", observationIds: ["o1"] }] })).toBeNull();
  });

  it("never shows a recommendation that claims a cause or rests on too little", () => {
    const rec = { title: "Try more feature demos", rationale: "Feature demos had more clicks in 3 of your posts.\n\nCaveats…", status: "new" as const, confidence: "medium" as const, basedOn: { observationIds: ["a", "b", "c"], resultIds: [] } };
    expect(tipFromRecommendation(rec)?.body).toBe("Feature demos had more clicks in 3 of your posts.");
    expect(tipFromRecommendation({ ...rec, rationale: "Demos drove installs." })).toBeNull();
    expect(tipFromRecommendation({ ...rec, basedOn: { observationIds: ["a"], resultIds: [] } })).toBeNull();
    expect(pickTip(null, [rec])?.from).toBe("recommendation");
  });
});
