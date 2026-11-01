import { validateDoc } from "@muselaunch/compositions";
import type { CompositionDoc } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { fitScenesToVoice, lineCaptions } from "./scene-fit";

function doc(durations: number[]): CompositionDoc {
  const v = validateDoc({
    schemaVersion: 1,
    title: "Fit",
    kind: "video",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#0A84FF" },
    scenes: durations.map((d, i) => ({
      id: `sc_${i}`,
      name: `S${i}`,
      template: "hook-title",
      purpose: "hook",
      durationSec: d,
      layers: [
        { id: `ly_${i}_a`, type: "text", text: "Runs to the end", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }, timing: { start: 0.2, end: d } },
        { id: `ly_${i}_b`, type: "text", text: "Early exit", box: { x: 0.1, y: 0.3, w: 0.8, h: 0.1 }, timing: { start: 0, end: 1 } },
      ],
    })),
  });
  if (!v.ok) throw new Error(v.errors.join("; "));
  return v.doc;
}

describe("fitScenesToVoice", () => {
  it("holds each narrated scene for its line; layers that ran to the end still do", () => {
    const fit = fitScenesToVoice(doc([2, 3, 3]), new Map([["sc_0", 3], ["sc_2", 1]]), { maxTotalSec: 60 });
    expect(fit.doc.scenes.map((s) => s.durationSec)).toEqual([3.7, 3, 3]);
    expect(fit.placements).toEqual([
      { sceneId: "sc_0", startSec: 0.25, endSec: 3.25 },
      { sceneId: "sc_2", startSec: 6.95, endSec: 7.95 },
    ]);
    const layers = fit.doc.scenes[0]!.layers;
    expect(layers[0]!.timing).toEqual({ start: 0.2 }); // was end: 2 (the scene's end) → runs to the new end
    expect(layers[1]!.timing).toEqual({ start: 0, end: 1 }); // an early exit stays early
    expect(fit.changed).toEqual([["sc_0", 2, 3.7]]);
    expect(validateDoc(fit.doc).ok).toBe(true);
  });

  it("over the plan's length: silent scenes, then spare narrated time, give time back; the rest is reported", () => {
    const fit = fitScenesToVoice(doc([3, 4, 3]), new Map([["sc_1", 5]]), { maxTotalSec: 10 });
    expect(fit.doc.scenes.map((s) => s.durationSec)).toEqual([2.15, 5.7, 2.15]);
    expect(fit.overflowSec).toBe(0);
    const tight = fitScenesToVoice(doc([3, 4, 3]), new Map([["sc_1", 8]]), { maxTotalSec: 10 });
    expect(tight.doc.scenes.map((s) => s.durationSec)).toEqual([1.6, 8.7, 1.6]);
    expect(tight.overflowSec).toBe(1.9);
  });

  it("captions are the spoken lines at their times, long lines split at word boundaries", () => {
    const cues = lineCaptions(
      [{ sceneId: "a", text: "Save the screenshot once and find any detail later by typing a few words or asking" }],
      [{ sceneId: "a", startSec: 1, endSec: 5 }],
      { idPrefix: "vo" },
    );
    expect(cues.map((c) => c.text)).toEqual(["Save the screenshot once and find any detail later by typing a", "few words or asking"]);
    expect(cues[0]!.startSec).toBe(1);
    expect(cues[1]!.endSec).toBe(5);
    expect(cues[0]!.endSec).toBe(cues[1]!.startSec);
  });
});
