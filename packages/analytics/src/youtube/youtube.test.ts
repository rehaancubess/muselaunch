import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { YtVideoResource } from "@muselaunch/providers";
import { describe, expect, it } from "vitest";
import { groundInterpretation } from "./channel";
import { computeChannelStats, keyFindings, median, normalizeVideos } from "./stats";
import { groundText, KnownNumbers, numbersIn } from "./validate";

/** Documented response shapes with synthetic values (fixtures/analytics/youtube-data-api.json). Not live data. */
// biome-ignore lint/suspicious/noExplicitAny: fixture JSON
const fx = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../fixtures/analytics/youtube-data-api.json", import.meta.url)), "utf8")) as Record<string, any>;
const FETCHED = "2026-10-29T12:00:00.000Z";
const order = (fx.playlistItems.items as { contentDetails: { videoId: string } }[]).map((i) => i.contentDetails.videoId);

function analyse() {
  const { videos, excluded } = normalizeVideos(fx.videos.items as YtVideoResource[], order, Date.parse(FETCHED));
  const stats = computeChannelStats(videos, excluded, FETCHED);
  return { videos, excluded, stats, findings: keyFindings("Fixture Focus Apps", videos, stats, FETCHED) };
}

describe("YouTube channel stats (deterministic)", () => {
  it("keeps only published videos with public numbers and says why others are left out", () => {
    const { videos, excluded, stats } = analyse();
    expect(stats.videosAnalyzed).toBe(10);
    expect(excluded).toEqual([
      { videoId: "FXvid000011", reason: expect.stringContaining("premiere") },
      { videoId: "FXvid000012", reason: expect.stringContaining("Not returned") },
    ]);
    const first = videos[0]!;
    expect(first).toMatchObject({ videoId: "FXvid000001", url: "https://www.youtube.com/watch?v=FXvid000001", durationSec: 45, lengthGroup: "short", views: 15400, likes: 820, comments: 64, ageDays: 1, viewsPerDay: 15400 });
    expect(first.engagementRate).toBeCloseTo((820 + 64) / 15400, 4);
    expect(videos.find((v) => v.videoId === "FXvid000009")).toMatchObject({ likes: null, engagementRate: null });
    expect(videos.find((v) => v.videoId === "FXvid000010")).toMatchObject({ comments: null, lengthGroup: "long" });
    expect(videos.find((v) => v.videoId === "FXvid000007")?.lengthGroup).toBe("live");
    expect(stats.totals).toMatchObject({ views: 96700, videosWithHiddenLikes: 1, videosWithCommentsOff: 1 });
  });

  it("computes medians, length groups, posting times and title patterns", () => {
    const { stats } = analyse();
    expect(stats.medians.views).toBe(8_100); // (6,400 + 9,800) / 2
    expect(stats.byLength.map((g) => [g.key, g.videos, g.medianViews])).toEqual([
      ["length:short", 5, 15_400],
      ["length:mid", 1, 6_400],
      ["length:long", 3, 3_500],
      ["length:live", 1, 1_200],
    ]);
    expect(stats.byWeekday.reduce((s, g) => s + g.videos, 0)).toBe(10);
    expect(stats.byHour.find((g) => g.key === "hour:12")).toMatchObject({ label: "12:00–15:59 UTC", videos: 5 });
    const number = stats.titlePatterns.find((p) => p.key === "title:number")!;
    expect([number.with.videos, number.with.medianViews, number.without.videos, number.without.medianViews]).toEqual([3, 18_800, 7, 4_100]);
    expect(stats.topByViews.slice(0, 3)).toEqual(["FXvid000002", "FXvid000006", "FXvid000001"]);
    expect(stats.cadence.uploadsPerWeek).toBeGreaterThan(2);
    expect(stats.notes.join(" ")).toMatch(/Shorts/);
    expect(stats.notes.join(" ")).toMatch(/not causes/);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it("writes measured key findings that cite the API and fetch date", () => {
    const { findings } = analyse();
    expect(findings.map((f) => f.key)).toEqual(["length", "top", "titles", "cadence"]);
    const length = findings[0]!.statement;
    expect(length).toContain("60 s or less (5 videos): median 15,400 views");
    expect(length).toContain("over 3 min (3 videos): median 3,500 views");
    expect(length).toContain("YouTube Data API, 10 most recent public uploads, fetched Oct 29, 2026");
    expect(length).not.toContain("live"); // groups under 3 videos aren't compared
    expect(findings[2]!.statement).toContain("contains a number (3 videos) had a median of 18,800 views, against 4,100 for the other 7");
    expect(findings[1]!.videoIds).toEqual(["FXvid000002", "FXvid000006", "FXvid000001"]);
  });
});

describe("number grounding of AI text", () => {
  it("finds numbers in common formats", () => {
    expect(numbersIn("12,300 views, 4.2%, 1.5K, 3x and 2.4 times on 2026-10-29 at 17:00").map((n) => [n.value, n.kind])).toEqual([
      [12300, "plain"],
      [4.2, "percent"],
      [1500, "thousand"],
      [3, "ratio"],
      [2.4, "ratio"],
    ]);
  });

  it("keeps sentences whose numbers are in the data and drops invented ones", () => {
    const known = new KnownNumbers([15_400, 3_500, 0.0574], [4.4], ["5 apps I use every day"]);
    const g = groundText("Short videos had a median of 15,400 views. That is about 4.4x the long ones. Expect 47,000 views next month! Engagement was 5.7%.", known);
    expect(g.text).toBe("Short videos had a median of 15,400 views. That is about 4.4x the long ones. Engagement was 5.7%.");
    expect(g.dropped).toBe(1);
    expect(g.unsupported).toEqual(["47,000"]);
    expect(known.unsupported("Roughly 15K views")).toEqual([]);
    expect(known.unsupported("A 9x jump")).toEqual(["9x"]);
  });

  it("grounds a whole interpretation: unknown numbers, video ids and stat keys never get through", () => {
    const { videos, stats, findings } = analyse();
    const out = groundInterpretation(
      {
        summary: "Uploads of 60 s or less had a median of 15,400 views. They will reach 100,000 subscribers soon. Worth testing short demos.",
        findingNotes: [
          { key: "length", interpretation: "Short videos may suit a quick app demo." },
          { key: "invented", interpretation: "Not a finding key." },
        ],
        hooksToTest: [
          { hook: "Plan your week before your coffee cools", angle: "Mirrors the quick-planning angle of the top short.", videoIds: ["FXvid000001", "NOPE0000000"] },
          { hook: "This app saved me 37 hours", angle: "Result claim.", videoIds: [] },
        ],
        formatsToTest: [{ format: "Under-60-second demo", why: "Short uploads had the higher median.", statKeys: ["length:short", "made:up"] }],
        cautions: ["Only 10 uploads were analysed.", "Retention was 83% on average."],
      },
      { stats, videos, findings, extraTexts: ["App: Focusly"], channel: { subscriberCount: 12_400, viewCount: 1_830_000, videoCount: 212 } },
    );
    expect(out.summary).toBe("Uploads of 60 s or less had a median of 15,400 views. Worth testing short demos.");
    expect(out.findingNotes).toEqual([{ key: "length", interpretation: "Short videos may suit a quick app demo." }]);
    expect(out.hooksToTest).toEqual([{ hook: "Plan your week before your coffee cools", angle: "Mirrors the quick-planning angle of the top short.", videoIds: ["FXvid000001"] }]);
    expect(out.formatsToTest[0]!.statKeys).toEqual(["length:short"]);
    expect(out.cautions).toEqual(["Only 10 uploads were analysed."]);
    expect(out.validation).toMatchObject({ droppedSentences: 1, droppedItems: 2, unknownVideoIds: 1 });
    expect(out.validation.notes.join(" ")).toContain("100,000");
  });
});
