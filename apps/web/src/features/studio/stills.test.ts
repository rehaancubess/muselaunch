import { describe, expect, it } from "vitest";
import { isStillDoc, slideAssetIds, stillChips, stillNoun, stillRenderCredits, unitWord, wholeLabel } from "./stills";

const text = (id: string, t: string) => ({ id, type: "text", role: "headline", text: t, hidden: false }) as never;
const device = (id: string) => ({ id, type: "device", hidden: false }) as never;
const scene = (id: string, layers: unknown[] = []) => ({ id, name: id, layers }) as never;
const doc = (kind: "video" | "static" | "carousel", n: number, aspectRatio = "4:5", layers: (i: number) => unknown[] = () => []) =>
  ({ kind, aspectRatio, scenes: Array.from({ length: n }, (_, i) => scene(`s${i + 1}`, layers(i))) }) as never;

describe("Studio for stills", () => {
  it("speaks of slides, not scenes, for posts, carousels and store sets", () => {
    expect(isStillDoc({ kind: "video" })).toBe(false);
    expect(isStillDoc({ kind: "carousel" })).toBe(true);
    expect(unitWord({ kind: "static" })).toBe("slide");
    expect(unitWord({ kind: "video" })).toBe("scene");
    expect(wholeLabel(doc("carousel", 6))).toBe("All slides");
    expect(wholeLabel(doc("static", 1))).toBe("Whole image");
    expect(wholeLabel(doc("video", 4))).toBe("Whole video");
    expect(stillNoun(doc("carousel", 6, "9:19.5"))).toBe("screenshots");
    expect(stillNoun(doc("carousel", 6, "9:16"))).toBe("screenshots");
    expect(stillNoun(doc("carousel", 6))).toBe("carousel");
    expect(stillNoun(doc("static", 1, "16:9"))).toBe("image");
  });

  it("finds every slide of a still render by the render worker's ids", () => {
    expect(slideAssetIds("ast_r_abc", 3)).toEqual(["ast_r_abc", "ast_r_abc_2", "ast_r_abc_3"]);
    expect(slideAssetIds("ast_r_abc", 0)).toEqual(["ast_r_abc"]);
    expect([1, 4, 6, 10].map(stillRenderCredits)).toEqual([1, 1, 2, 3]);
  });

  it("suggests still edits: shorter headline, another real screen, darker background, a slide about a feature", () => {
    const d = doc("carousel", 4, "4:5", (i) => (i === 1 ? [text("h", "Plan your whole day in calm focus blocks"), device("d")] : [text("h", "Calm")]));
    // A slide picked: changes go to that slide only.
    const one = stillChips(d, "s2", ["Focus Mode"]);
    expect(one.map((c) => [c.label, c.sceneIds])).toEqual([
      ["Make the headline shorter", ["s2"]],
      ["Use a different screen on this slide", ["s2"]],
      ["Try a darker background", ["s2"]],
      ["Add a slide about Focus Mode", []],
    ]);
    expect(one[0]!.instruction).toMatch(/slide 2/);
    expect(one[0]!.hint).toBe("Now: “Plan your whole day in calm focus blocks”");
    // No phone on the slide: no "different screen".
    expect(stillChips(d, "s1").map((c) => c.key)).toEqual(["headline", "darker"]);
    // All slides.
    expect(stillChips(d, null).map((c) => c.label)).toEqual(["Make the headlines shorter", "Try a darker background", "Make the first slide stop the scroll"]);
    // A full carousel, a store set and a single image never offer another slide.
    expect(stillChips(doc("carousel", 10), null, ["Focus Mode"]).some((c) => c.key === "add")).toBe(false);
    expect(stillChips(doc("carousel", 5, "9:19.5"), null, ["Focus Mode"]).some((c) => c.key === "add")).toBe(false);
    expect(stillChips(doc("static", 1), null, ["Focus Mode"]).map((c) => c.label)).toEqual(["Make the headline shorter", "Try a darker background"]);
  });
});
