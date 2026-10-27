import type { Experiment, MetricObservation } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { perVariantMetrics, validateAnalysis, type ExperimentData } from "./experiments";
import { makeDedupKey } from "./observations";

const base = { workspaceId: "w", createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z", createdBy: "t" };
const exp: Experiment = {
  ...base,
  id: "exp_1",
  appId: "app_1",
  title: "Hook A vs B",
  hypothesis: "A question hook gets more clicks",
  baseline: { description: "", observationIds: [] },
  variants: [
    { key: "a", label: "Question hook", publicationIds: [], isControl: true },
    { key: "b", label: "Demo-first", publicationIds: [], isControl: false },
  ],
  primaryMetric: "clicks",
  secondaryMetrics: [],
  launchWindow: {},
  status: "running",
};
const o = (id: string, variantKey: string, value: number, attribution: MetricObservation["attribution"] = "link"): MetricObservation => ({
  ...base,
  id,
  appId: "app_1",
  experimentId: "exp_1",
  variantKey,
  source: "tracked_link",
  metric: "clicks",
  metricDefinition: "clicks",
  value,
  unit: "count",
  windowStart: "2026-10-20T00:00:00.000Z",
  windowEnd: "2026-10-21T00:00:00.000Z",
  timezone: "UTC",
  attribution,
  provenance: { imported: false, fetchedAt: base.createdAt },
  dedupKey: makeDedupKey(`link:${id}`, "2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z"),
});
const data = (obs: MetricObservation[]): ExperimentData => ({ observations: obs, assignment: new Map(obs.map((x) => [x.id, x.variantKey!])) });

describe("validateAnalysis", () => {
  const d = data([o("obs_a", "a", 120), o("obs_b", "b", 80)]);
  const pv = perVariantMetrics(exp, d);

  it("computes per-variant totals from observations", () => {
    expect(pv.find((v) => v.key === "a")!.metrics[0]).toMatchObject({ metric: "clicks", value: 120, observationIds: ["obs_a"] });
  });

  it("drops measured claims citing unknown observation ids or invented figures, and moves causal claims to hypotheses", () => {
    const v = validateAnalysis(
      {
        summary: "A got more clicks.",
        measured: [
          { text: "Variant A had 120 clicks vs 80 for B (+50%).", observationIds: ["obs_a", "obs_b"] },
          { text: "Variant B had 500 installs.", observationIds: ["obs_fake"] },
          { text: "Variant A had 340 clicks.", observationIds: ["obs_a"] },
          { text: "The question hook caused 40 more clicks.", observationIds: ["obs_a", "obs_b"] },
        ],
        hypotheses: ["Questions may create curiosity."],
        limitations: [],
        confidence: "high",
      },
      exp,
      d,
      pv,
    );
    expect(v.measured).toEqual([{ text: "Variant A had 120 clicks vs 80 for B (+50%).", observationIds: ["obs_a", "obs_b"] }]);
    expect(v.validation.droppedMeasured).toBe(2);
    expect(v.validation.movedToHypotheses).toBe(1);
    expect(v.hypotheses.some((h) => h.startsWith("Hypothesis (not measured): The question hook caused"))).toBe(true);
    expect(v.validation.notes.join(" ")).toMatch(/unknown observation ids \(obs_fake\)/);
    expect(v.confidence).toBe("high");
  });

  it("caps confidence: aggregate attribution ⇒ low, missing variant data ⇒ insufficient_data", () => {
    const agg = data([o("obs_a", "a", 120, "aggregate"), o("obs_b", "b", 80, "aggregate")]);
    const v1 = validateAnalysis({ summary: "", measured: [], hypotheses: [], limitations: [], confidence: "high" }, exp, agg, perVariantMetrics(exp, agg));
    expect(v1.confidence).toBe("low");
    expect(v1.validation.confidenceCapped).toBe(true);
    expect(v1.limitations.join(" ")).toMatch(/correlation/);
    const onlyA = data([o("obs_a", "a", 120)]);
    const v2 = validateAnalysis({ summary: "", measured: [], hypotheses: [], limitations: [], confidence: "medium" }, exp, onlyA, perVariantMetrics(exp, onlyA));
    expect(v2.confidence).toBe("insufficient_data");
  });
});
