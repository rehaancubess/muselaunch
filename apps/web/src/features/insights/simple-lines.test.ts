import type { InsightMetric, MetricName } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { bigNumbers, changeLine, coverageNote, firstParagraph, nextStep, plainMetricLabel, plainSource, scopeLine, workingLine } from "./simple-lines";

const metric = (name: MetricName, value: number | null, over: Partial<InsightMetric> = {}): InsightMetric => ({
  metric: name,
  label: name,
  unit: "count",
  value,
  aggregation: "sum",
  sources: [],
  attribution: null,
  imported: false,
  definition: "",
  window: null,
  coverage: null,
  observationIds: [],
  comparison: null,
  notes: [],
  ...over,
});
const source = (over: Partial<InsightMetric["sources"][number]>): InsightMetric["sources"][number] => ({
  source: "youtube",
  label: "YouTube (API)",
  imported: false,
  attribution: "platform_reported",
  value: 1,
  observationCount: 1,
  definitions: [],
  ...over,
});

describe("How it's going (simple-lines.ts)", () => {
  it("shows up to three measured numbers, views → clicks → installs first, and never a gap", () => {
    const all = [metric("revenue", 52), metric("installs", 323), metric("views", null), metric("clicks", 0), metric("trials_started", 43), metric("ad_spend", 10)];
    expect(bigNumbers(all).map((m) => m.metric)).toEqual(["clicks", "installs", "trials_started"]);
    expect(bigNumbers([metric("views", null), metric("ad_spend", 5)])).toEqual([]);
    // Revenue in several currencies is measured even without one total.
    expect(bigNumbers([metric("revenue", null, { byCurrency: [{ currency: "USD", value: 4 }] })]).map((m) => m.metric)).toEqual(["revenue"]);
  });

  it("uses everyday names", () => {
    expect(plainMetricLabel(metric("clicks", 0))).toBe("Link clicks");
    expect(plainMetricLabel(metric("new_subscriptions", 0))).toBe("New subscribers");
    expect(plainMetricLabel({ metric: "mrr", label: "MRR" })).toBe("MRR");
  });

  it("says where each number comes from", () => {
    expect(plainSource({ sources: [source({})] })).toBe("From YouTube");
    expect(plainSource({ sources: [source({ source: "tracked_link", label: "MuseLaunch tracked links" })] })).toBe("From your MuseLaunch links");
    expect(plainSource({ sources: [source({ source: "app_store_connect", label: "App Store Connect · Imported CSV", imported: true })] })).toBe("From an App Store Connect file you imported");
    expect(plainSource({ sources: [source({ source: "tiktok", label: "TikTok · Imported CSV", imported: true })] })).toBe("From a TikTok file you imported");
    expect(plainSource({ sources: [source({ source: "csv_import", label: "Imported CSV", imported: true })] })).toBe("From a file you imported");
    expect(plainSource({ sources: [source({ source: "manual", label: "Manual entry" })] })).toBe("Typed in by you");
    expect(plainSource({ sources: [] })).toBeNull();
  });

  it("reports a change only when both periods were measured, without a reason", () => {
    expect(changeLine({ comparison: { value: 80, delta: 20, deltaPct: 25 } }, 28)).toBe("Up 25% on the 28 days before");
    expect(changeLine({ comparison: { value: 80, delta: -8, deltaPct: -10 } }, 7)).toBe("Down 10% on the 7 days before");
    expect(changeLine({ comparison: { value: 80, delta: 0, deltaPct: 0 } }, 28)).toBe("Same as the 28 days before");
    expect(changeLine({ comparison: { value: null, delta: null, deltaPct: null } }, 28)).toBeNull();
    expect(changeLine({ comparison: null }, 28)).toBeNull();
  });

  it("flags account-wide totals and partial coverage", () => {
    expect(scopeLine({ metric: "installs", attribution: "aggregate" })).toBe("Total for your whole app");
    expect(scopeLine({ metric: "views", attribution: "aggregate" })).toBe("Total for your whole account");
    expect(scopeLine({ metric: "clicks", attribution: "link" })).toBeNull();
    const part = { daysWithData: 3, daysInRange: 28 };
    expect(coverageNote([{ coverage: part }, { coverage: part }])).toBe("These numbers cover 3 of the 28 days. Days without numbers count as unknown, not zero.");
    expect(coverageNote([{ coverage: part }])).toMatch(/^This number covers 3 of the 28 days/);
    expect(coverageNote([{ coverage: part }, { coverage: null }])).toMatch(/^Some of these numbers cover only part/);
    expect(coverageNote([{ coverage: { daysWithData: 28, daysInRange: 28 } }, { coverage: null }])).toBeNull();
  });

  it("shows a recommendation's first paragraph only", () => {
    expect(firstParagraph("Run a two-variant test.\n\nBased on limited measured data.")).toBe("Run a two-variant test.");
    expect(firstParagraph("\n\nOne line\nwrapped")).toBe("One line wrapped");
    expect(firstParagraph("")).toBe("");
  });

  it("picks one next step when nothing is measured", () => {
    expect(nextStep([{ metric: "views", action: "publish_post" }], "can_connect")).toBe("post_video");
    expect(nextStep([{ metric: "views", action: "enter_manually" }], "can_connect")).toBe("connect_youtube");
    expect(nextStep([{ metric: "views", action: "enter_manually" }], "unavailable")).toBe("add_numbers");
    expect(nextStep([], "connected")).toBe("add_numbers");
  });

  it("what's working: only from a test with enough data, measured first, the reason labelled as a guess", () => {
    const exp = { title: "Question vs statement hook", primaryMetric: "clicks" };
    const result = {
      confidence: "low" as const,
      measured: [{ text: "Version B got 48 link clicks; version A got 31.", observationIds: ["o1", "o2"] }],
      hypotheses: ["The question may make people curious."],
      perVariant: [
        { key: "a", metrics: [{ metric: "clicks", value: 31, observationIds: ["o1"] }] },
        { key: "b", metrics: [{ metric: "clicks", value: 48, observationIds: ["o2"] }] },
        { key: "baseline", metrics: [{ metric: "clicks", value: 500, observationIds: [] }] },
      ],
    };
    expect(workingLine(exp, result)).toEqual({
      text: "Version B got 48 link clicks; version A got 31.",
      maybe: "A possible reason (not measured): The question may make people curious.",
      basis: "Measured on 79 link clicks",
      testTitle: "Question vs statement hook",
    });
    expect(workingLine(exp, { ...result, confidence: "insufficient_data" })).toBeNull();
    expect(workingLine(exp, { ...result, measured: [] })).toBeNull();
    expect(workingLine(exp, { ...result, hypotheses: [], perVariant: [] })).toMatchObject({ maybe: null, basis: "Measured on 2 numbers you have" });
    expect(workingLine(null, result)).toBeNull();
  });
});
