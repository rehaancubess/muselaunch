import { describe, expect, it } from "vitest";
import { posterTimeSec } from "./poster";
import { sampleDoc } from "./test-fixtures";
import type { CompositionDoc } from "@muselaunch/contracts";

describe("posterTimeSec", () => {
  it("parks after the opening scene's entrances have landed (frame 0 is an empty backdrop)", () => {
    const doc = sampleDoc();
    const s0 = doc.scenes[0]!;
    const settled = Math.max(...s0.layers.filter((l) => !l.hidden && l.timing.start <= Math.min(1.5, s0.durationSec / 2)).map((l) => l.timing.start + (l.animation.enter ? l.animation.enter.delaySec + l.animation.enter.durationSec : 0)));
    const t = posterTimeSec(doc);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeGreaterThanOrEqual(Math.min(settled, s0.durationSec - 0.05, 2.5) - 0.001);
    expect(t).toBeLessThan(s0.durationSec);
  });

  it("ignores late layers, stays before exits and inside the scene", () => {
    const doc = structuredClone(sampleDoc()) as CompositionDoc;
    const s0 = doc.scenes[0]!;
    s0.durationSec = 2;
    s0.layers = [0, 1, 2].map((i) => ({ ...structuredClone(s0.layers[0]!), id: `ly_p${i}`, hidden: false }));
    for (const l of s0.layers) {
      l.timing = { start: 0 };
      l.animation = { loop: "none", enter: { preset: "fade", durationSec: 0.5, delaySec: 0.2, easing: "smooth" } };
    }
    // A late layer (CTA chip at 1.6 s) must not push the poster frame.
    s0.layers[0]!.timing = { start: 1.6 };
    expect(posterTimeSec(doc)).toBeCloseTo(0.82, 2);
    // An exit that starts before everything has landed wins.
    s0.layers[1]!.timing = { start: 0, end: 0.6 };
    s0.layers[1]!.animation.exit = { preset: "fade", durationSec: 0.2, easing: "smooth" };
    expect(posterTimeSec(doc)).toBeLessThanOrEqual(0.82);
  });

  it("is 0 for an empty doc", () => {
    expect(posterTimeSec({ ...sampleDoc(), scenes: [] } as CompositionDoc)).toBe(0);
  });
});
