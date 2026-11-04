import { describe, expect, it } from "vitest";
import { ASPECT_DIMENSIONS } from "./common";
import { withAiVoiceLine, AI_VOICE_CAPTION_LINE } from "./sound";
import { clampSlides, docKindOf, formatOfDeliverable, isStillFormat, isTextDeliverable, slideLimits, stillAspect } from "./stills";

describe("stills.ts: formats, slide limits and frames", () => {
  it("maps formats to composition kinds", () => {
    expect(docKindOf("video")).toBe("video");
    expect(docKindOf("post")).toBe("static");
    expect(docKindOf("thumbnail")).toBe("static");
    expect(docKindOf("carousel")).toBe("carousel");
    expect(docKindOf("store_screenshots")).toBe("carousel");
    expect(isStillFormat("video")).toBe(false);
    expect(isStillFormat("carousel")).toBe(true);
    expect(isStillFormat(null)).toBe(false);
  });

  it("keeps slide counts inside what the platforms take", () => {
    expect(slideLimits("carousel")).toEqual({ min: 3, max: 10, default: 6 });
    expect(slideLimits("store_screenshots", "ios").max).toBe(10);
    expect(slideLimits("store_screenshots", "android").max).toBe(8);
    expect(clampSlides("carousel", 14)).toBe(10);
    expect(clampSlides("carousel", 1)).toBe(3);
    expect(clampSlides("carousel", undefined)).toBe(6);
    expect(clampSlides("store_screenshots", 10, "android")).toBe(8);
    expect(clampSlides("post", 5)).toBe(1);
    expect(clampSlides("thumbnail", null)).toBe(1);
  });

  it("picks each format's frame", () => {
    expect(stillAspect("thumbnail", "9:16")).toBe("16:9");
    expect(stillAspect("store_screenshots", undefined, "ios")).toBe("9:19.5");
    expect(stillAspect("store_screenshots", "4:5", "android")).toBe("9:16");
    expect(stillAspect("carousel", "1:1")).toBe("1:1");
    expect(stillAspect("carousel", "16:9")).toBe("4:5");
    expect(stillAspect("post", undefined)).toBe("4:5");
    expect(stillAspect("video", "9:19.5")).toBe("9:16");
    expect(ASPECT_DIMENSIONS["9:19.5"]).toEqual({ width: 1290, height: 2796 });
  });

  it("reads deliverables", () => {
    expect(formatOfDeliverable("short_video")).toBe("video");
    expect(formatOfDeliverable("feature_promo")).toBe("video");
    expect(formatOfDeliverable("static_ad")).toBe("post");
    expect(formatOfDeliverable("carousel")).toBe("carousel");
    expect(formatOfDeliverable("store_screenshots")).toBe("store_screenshots");
    expect(formatOfDeliverable("text_post")).toBeNull();
    expect(isTextDeliverable("text_post")).toBe(true);
    expect(formatOfDeliverable(undefined)).toBeNull();
  });
});

describe("withAiVoiceLine: the AI-voice line in captions", () => {
  it("adds the line once, at the end", () => {
    const once = withAiVoiceLine("Focus, finally.");
    expect(once).toBe(`Focus, finally.\n\n${AI_VOICE_CAPTION_LINE}`);
    expect(withAiVoiceLine(once)).toBe(once);
    expect(withAiVoiceLine("")).toBe(AI_VOICE_CAPTION_LINE);
  });

  it("keeps a channel's limit: the line wins over the caption's tail", () => {
    const long = "word ".repeat(80).trim();
    const out = withAiVoiceLine(long, 280);
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith(AI_VOICE_CAPTION_LINE)).toBe(true);
    expect(out).toContain("…");
  });
});
