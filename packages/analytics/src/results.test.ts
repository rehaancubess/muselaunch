import type { MetricObservation } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { makeDedupKey } from "./observations";
import { countPublished, dailySeries, isSingleDay, pickBestPost, pickSeries, postTitle } from "./results";

let n = 0;
function obs(p: Partial<MetricObservation> & Pick<MetricObservation, "metric" | "value" | "windowStart" | "windowEnd">, scope = "s"): MetricObservation {
  n++;
  return {
    id: `obs_${n}`,
    workspaceId: "w",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    createdBy: "t",
    appId: "app_1",
    source: "csv_import",
    metricDefinition: "def",
    unit: "count",
    timezone: "UTC",
    attribution: "aggregate",
    provenance: { imported: true, fetchedAt: "2026-10-27T00:00:00.000Z" },
    dedupKey: makeDedupKey(scope, p.windowStart, p.windowEnd),
    ...p,
  } as MetricObservation;
}
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T00:00:00.000Z`;
const R = { from: Date.parse(day(20)), to: Date.parse(day(27)) };
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const views = (d: number, value: number, over: Partial<MetricObservation> = {}, scope = "csv:views") => obs({ metric: "views", value, windowStart: day(d), windowEnd: day(d + 1), ...over }, scope);

describe("dailySeries (real daily numbers only)", () => {
  it("one point per UTC day; a day without a number is a gap (null), never 0", () => {
    const s = dailySeries("views", [views(20, 3400), views(21, 2900), views(23, 3100)], R, { now: NOW });
    expect(s.points.map((p) => p.date)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(s.points.map((p) => p.value)).toEqual([3400, 2900, null, 3100, null, null, null]);
    expect(s.measuredDays).toBe(3);
    expect(s.sources).toEqual([{ source: "csv_import", label: "Imported CSV", imported: true, observationCount: 3 }]);
    expect(s.multiDayLeftOut).toBe(0);
  });

  it("never splits a number that covers several days (a weekly total, a post's lifetime count)", () => {
    const weekly = obs({ metric: "views", value: 7000, windowStart: day(20), windowEnd: day(27) }, "weekly");
    const s = dailySeries("views", [weekly, views(22, 100)], R, { now: NOW });
    expect(s.points.filter((p) => p.value !== null)).toEqual([{ date: "2026-10-22", value: 100 }]);
    expect(s.multiDayLeftOut).toBe(1);
  });

  it("uses the same source priority and de-duplication as the totals (no double counting per day)", () => {
    const api = views(21, 500, { source: "youtube", attribution: "aggregate", provenance: { imported: false, fetchedAt: day(26) } }, "yt:acct");
    const csv = views(21, 480, {}, "csv:views");
    const s = dailySeries("views", [api, csv], R, { now: NOW });
    expect(s.points[1]).toEqual({ date: "2026-10-21", value: 500 });
    expect(s.sources.map((x) => x.source)).toEqual(["youtube", "csv_import"]);
  });

  it("clicks: a day with a live tracked link and no click is a measured 0; before the link existed it's a gap; never in the future", () => {
    const click = obs({ metric: "clicks", value: 4, windowStart: day(24), windowEnd: day(25), source: "tracked_link", attribution: "link", provenance: { imported: false, fetchedAt: day(24) } }, "link:l1");
    const s = dailySeries("clicks", [click], R, { links: [{ createdAt: "2026-10-23T09:00:00.000Z" }], now: Date.parse("2026-10-25T08:00:00.000Z") });
    expect(s.points.map((p) => p.value)).toEqual([null, null, null, 0, 4, 0, null]);
    expect(s.measuredDays).toBe(3);
    expect(s.sources[0]).toMatchObject({ source: "tracked_link", observationCount: 1 });
  });

  it("views are never zero-filled", () => {
    const s = dailySeries("views", [], R, { links: [{ createdAt: day(1) }], now: NOW });
    expect(s.points.every((p) => p.value === null)).toBe(true);
    expect(s.measuredDays).toBe(0);
  });

  it("isSingleDay", () => {
    expect(isSingleDay({ windowStart: day(20), windowEnd: day(21) })).toBe(true);
    expect(isSingleDay({ windowStart: "2026-10-20T05:00:00.000Z", windowEnd: "2026-10-20T09:00:00.000Z" })).toBe(true);
    expect(isSingleDay({ windowStart: day(20), windowEnd: day(20) })).toBe(true);
    expect(isSingleDay({ windowStart: day(20), windowEnd: "2026-10-21T00:00:01.000Z" })).toBe(false);
  });
});

describe("pickSeries: views, else link clicks", () => {
  const series = (metric: "views" | "clicks", measuredDays: number) => ({ metric, label: metric, points: [], measuredDays, sources: [], multiDayLeftOut: 0 });
  it("prefers views when they have enough days to draw", () => {
    expect(pickSeries(series("views", 3), series("clicks", 20))?.metric).toBe("views");
  });
  it("falls back to clicks when views have too few days", () => {
    expect(pickSeries(series("views", 2), series("clicks", 5))?.metric).toBe("clicks");
  });
  it("otherwise the first with any day, else nothing", () => {
    expect(pickSeries(series("views", 1), series("clicks", 2))?.metric).toBe("views");
    expect(pickSeries(series("views", 0), series("clicks", 0))).toBeNull();
  });
});

describe("pickBestPost (per-post numbers only)", () => {
  const published = new Map([
    ["pub_a", "2026-10-20T10:00:00.000Z"],
    ["pub_b", "2026-10-22T10:00:00.000Z"],
    ["pub_c", "2026-10-23T10:00:00.000Z"],
  ]);
  const postViews = (pub: string, d: number, value: number) => views(d, value, { publicationId: pub, source: "manual", attribution: "platform_reported" }, `manual:${pub}:views`);

  it("adds each post's own daily numbers and picks the most", () => {
    const best = pickBestPost([postViews("pub_a", 20, 100), postViews("pub_a", 21, 50), postViews("pub_b", 22, 120)], R, published);
    expect(best).toMatchObject({ publicationId: "pub_a", metric: "views", value: 150, comparedPosts: 2, tiedWith: 0, attribution: "platform_reported" });
    expect(best!.observationIds).toHaveLength(2);
  });

  it("never credits an account total to a post", () => {
    const account = views(22, 9000, { publicationId: "pub_b", attribution: "aggregate" }, "acct");
    expect(pickBestPost([account], R, published)).toBeNull();
  });

  it("ignores posts of other apps (not in this app's publications)", () => {
    expect(pickBestPost([postViews("pub_other", 20, 999)], R, published)).toBeNull();
  });

  it("falls back to link clicks when no post has views", () => {
    const click = obs({ metric: "clicks", value: 9, windowStart: day(23), windowEnd: day(24), source: "tracked_link", attribution: "link", publicationId: "pub_c", provenance: { imported: false, fetchedAt: day(24) } }, "link:c");
    expect(pickBestPost([click], R, published)).toMatchObject({ publicationId: "pub_c", metric: "clicks", value: 9, comparedPosts: 1 });
  });

  it("no best of zeros; ties show the newest post and say so", () => {
    expect(pickBestPost([postViews("pub_a", 20, 0)], R, published)).toBeNull();
    const tie = pickBestPost([postViews("pub_a", 20, 40), postViews("pub_c", 23, 40)], R, published);
    expect(tie).toMatchObject({ publicationId: "pub_c", tiedWith: 1, comparedPosts: 2 });
  });
});

describe("countPublished and postTitle", () => {
  it("counts MuseLaunch's own publication records inside the range", () => {
    const out = countPublished(
      [
        { publishedAt: "2026-10-19T23:59:59.000Z", mode: "api" },
        { publishedAt: "2026-10-20T00:00:00.000Z", mode: "api" },
        { publishedAt: "2026-10-25T12:00:00.000Z", mode: "manual_confirmed" },
        { publishedAt: day(27), mode: "manual_confirmed" },
      ],
      R,
    );
    expect(out).toEqual({ value: 2, api: 1, manual: 1 });
  });

  it("title, else the caption's first line, else the channel", () => {
    expect(postTitle({ title: " Focus without the friction ", caption: "x" }, "Instagram")).toBe("Focus without the friction");
    expect(postTitle({ caption: "\nOne tap to deep work\nMore text" }, "Instagram")).toBe("One tap to deep work");
    expect(postTitle({ caption: "" }, "TikTok")).toBe("TikTok post");
    expect(postTitle(null, "YouTube")).toBe("YouTube post");
  });
});
