import { creativeDirectionLines, directionFollowed } from "@muselaunch/agents";
import { describe, expect, it } from "vitest";
import { directionProblem, directionSchema, directionSummary, signatureShotOptions, toCreativeDirection, type WonderDirection } from "./direction";

const base: WonderDirection = {
  hookApproach: "Open mid-search on the real screen.",
  pacing: "punchy",
  visualMotif: "Each scene pushes closer to the result.",
  signatureShots: ["focus-zoom", "tap-demo"],
  musicMood: "tech-pulse",
  why: "Isolates the product-first hook.",
};

describe("Wonder creative direction", () => {
  it("offers SAM presenter shots only when presenter footage exists, and never end cards or proof cards", () => {
    const without = signatureShotOptions(false);
    expect(without).not.toContain("presenter-depth");
    expect(without).not.toContain("product-in-hand");
    expect(without).toContain("focus-zoom");
    for (const t of ["cta-endcard", "store-cta", "stat-card", "quote-proof", "carousel-slide"]) expect(without).not.toContain(t);
    expect(signatureShotOptions(true)).toEqual(expect.arrayContaining(["presenter-depth", "object-spotlight", "product-in-hand", "founder-cutout"]));
  });

  it("rejects a presenter shot in the schema when there is no presenter footage", () => {
    const schema = directionSchema(signatureShotOptions(false));
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, signatureShots: ["presenter-depth"] }).success).toBe(false);
    expect(schema.safeParse({ ...base, musicMood: "dubstep" }).success).toBe(false);
  });

  it("asks Wonder to vary the look when every pick shares one pacing and mood", () => {
    expect(directionProblem([base])).toBeNull();
    expect(directionProblem([base, { ...base, visualMotif: "other" }])).toMatch(/different directions/);
    expect(directionProblem([base, { ...base, pacing: "steady" }])).toBeNull();
  });

  it("gives the storyboard writer the direction, and reports what it followed honestly", () => {
    const d = toCreativeDirection(base, "muse-wonder-1.0", "run_abc", "2026-11-03T00:00:00.000Z");
    const lines = creativeDirectionLines(d);
    expect(lines).toMatch(/^Creative direction from Muse Wonder/);
    expect(lines).toContain('set music.mood to "tech-pulse"');
    expect(lines).toContain("focus-zoom, tap-demo");

    const followed = directionFollowed(d, { scenes: [{ template: "hook-title" }, { template: "focus-zoom" }], music: { mood: "upbeat" } });
    expect(followed).toMatchObject({ used: ["focus-zoom"], missing: ["tap-demo"], musicMood: "tech-pulse", moodOverridden: true });
    expect(followed.summary).toMatch(/left out tap-demo/);
    expect(directionSummary(d)).toBe("punchy, tech pulse score, focus-zoom + tap-demo; motif: Each scene pushes closer to the result.");
  });

  it("names the model that actually directed (a stand-in is never shown as Muse Wonder)", () => {
    expect(creativeDirectionLines(toCreativeDirection(base, "gpt-5.1", "run_x", "2026-11-03T00:00:00.000Z"))).toMatch(/^Creative direction from OpenAI gpt-5\.1/);
  });
});
