import type { MetricObservation } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { computeMetric } from "./insights";
import { makeDedupKey } from "./observations";

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
    source: "revenuecat",
    metricDefinition: "def",
    unit: "count",
    timezone: "UTC",
    attribution: "aggregate",
    provenance: { imported: false, fetchedAt: "2026-10-27T00:00:00.000Z" },
    dedupKey: makeDedupKey(scope, p.windowStart, p.windowEnd),
    ...p,
  } as MetricObservation;
}
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T00:00:00.000Z`;
const R = { from: Date.parse(day(20)), to: Date.parse(day(27)) };

describe("computeMetric (no fabrication, no double counting)", () => {
  it("sums daily windows and ignores an overlapping rolling window from the same series", () => {
    const daily = [20, 21, 22].map((d) => obs({ metric: "revenue", unit: "currency", currency: "USD", value: 10, windowStart: day(d), windowEnd: day(d + 1) }, "rc:rev:day"));
    const rolling = obs({ metric: "revenue", unit: "currency", currency: "USD", value: 999, windowStart: day(20), windowEnd: day(27) }, "rc:rev:day");
    const m = computeMetric("revenue", [...daily, rolling], R, {});
    expect(m.value).toBe(30);
    expect(m.observationIds).not.toContain(rolling.id);
    expect(m.coverage).toEqual({ daysWithData: 3, daysInRange: 7 });
    expect(m.notes.join(" ")).toMatch(/covers 3 of 7 days/);
  });

  it("returns null (not 0) when nothing is measured", () => {
    const m = computeMetric("installs", [], R, {});
    expect(m.value).toBeNull();
    expect(m.aggregation).toBe("none");
    expect(m.attribution).toBeNull();
  });

  it("never adds currencies together", () => {
    const a = obs({ metric: "revenue", unit: "currency", currency: "USD", value: 5, windowStart: day(20), windowEnd: day(21) }, "a");
    const b = obs({ metric: "revenue", unit: "currency", currency: "EUR", value: 7, windowStart: day(20), windowEnd: day(21) }, "b");
    const m = computeMetric("revenue", [a, b], R, {});
    expect(m.value).toBeNull();
    expect(m.byCurrency).toEqual([
      { currency: "USD", value: 5 },
      { currency: "EUR", value: 7 },
    ]);
  });

  it("prefers the most direct source per scope and labels imported data", () => {
    const api = obs({ metric: "revenue", unit: "currency", currency: "USD", value: 50, windowStart: day(20), windowEnd: day(21) }, "rc");
    const csv = obs({ metric: "revenue", unit: "currency", currency: "USD", value: 48, windowStart: day(20), windowEnd: day(21), source: "csv_import", provenance: { imported: true, fetchedAt: day(27) } }, "csv");
    const m = computeMetric("revenue", [api, csv], R, {});
    expect(m.value).toBe(50);
    expect(m.imported).toBe(false);
    expect(m.sources.map((s) => [s.label, s.value, s.imported])).toEqual([
      ["RevenueCat (API)", 50, false],
      ["Imported CSV", 48, true],
    ]);
  });

  it("adds disjoint store channels but lets account-wide numbers supersede per-channel ones", () => {
    const ios = obs({ metric: "installs", value: 10, windowStart: day(20), windowEnd: day(21), source: "app_store_connect", channel: "app_store", provenance: { imported: true, fetchedAt: day(27) } }, "asc");
    const android = obs({ metric: "installs", value: 5, windowStart: day(20), windowEnd: day(21), source: "google_play_console", channel: "google_play", provenance: { imported: true, fetchedAt: day(27) } }, "play");
    expect(computeMetric("installs", [ios, android], R, {}).value).toBe(15);
    const manualTotal = obs({ metric: "installs", value: 40, windowStart: day(20), windowEnd: day(21), source: "manual", provenance: { imported: true, fetchedAt: day(27) } }, "manual");
    const m = computeMetric("installs", [ios, android, manualTotal], R, {});
    expect(m.value).toBe(40);
    expect(m.notes.join(" ")).toMatch(/not added on top/);
  });

  it("campaign filter only uses observations attributed to that campaign", () => {
    const agg = obs({ metric: "clicks", value: 100, windowStart: day(20), windowEnd: day(21) }, "agg");
    const link = obs({ metric: "clicks", value: 7, windowStart: day(20), windowEnd: day(21), source: "tracked_link", campaignId: "cpg_1", attribution: "link" }, "link:1");
    const m = computeMetric("clicks", [agg, link], R, { campaignId: "cpg_1" });
    expect(m.value).toBe(7);
    expect(m.attribution).toBe("link");
  });

  it("stock metrics use the latest snapshot inside the range", () => {
    const a = obs({ metric: "active_subscriptions", value: 200, windowStart: day(21), windowEnd: day(21) }, "snap");
    const b = obs({ metric: "active_subscriptions", value: 210, windowStart: day(23), windowEnd: day(23) }, "snap");
    const m = computeMetric("active_subscriptions", [a, b], R, {});
    expect(m.value).toBe(210);
    expect(m.aggregation).toBe("latest");
  });
});
