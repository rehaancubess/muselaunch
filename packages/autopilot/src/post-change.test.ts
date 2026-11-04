import { COMPOSITION_SCHEMA_VERSION, type CompositionDoc, type ScheduledPost } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { estimatePostChange, finalRenderFor, videoChangeLine } from "./post-change";
import { autopilotHarness } from "./testing";

const theme = { mode: "light" as const, background: "#FFFFFF", surface: "#FFFFFF", text: "#111111", textMuted: "#666666", accent: "#0A84FF", headingFont: "Inter", bodyFont: "Inter", radiusPx: 28 };
/** A still doc's scenes are 3-second slots, so six slides "last" 18 s: what a video would be priced by. */
function doc(kind: CompositionDoc["kind"], scenes: number, durationSec: number): CompositionDoc {
  return {
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    title: "Doc",
    kind,
    aspectRatio: kind === "video" ? "9:16" : "4:5",
    width: 1080,
    height: kind === "video" ? 1920 : 1350,
    fps: 30,
    theme,
    safeZone: { top: 0.08, bottom: 0.14, left: 0.05, right: 0.05 },
    scenes: Array.from({ length: scenes }, (_, i) => ({ id: `sc_${i + 1}`, name: `Scene ${i + 1}`, template: kind === "video" ? "feature-callout" : "slide-feature", durationSec, background: { kind: "solid", color: "theme.background", angle: 180, dim: 0 }, transitionIn: { kind: "cut", durationSec: 0 }, layers: [] })),
    audio: [],
    captions: { enabled: false, preset: "boxed", position: "bottom", source: "script", cues: [] },
    meta: {},
  } as CompositionDoc;
}

describe("Tell Muse what to change on a post: the final render is priced by what the post is", () => {
  it("finalRenderFor: a video by its length, stills by their slides (sent as png: the renderer picks JPEG or PNG)", () => {
    expect(finalRenderFor(doc("video", 3, 6))).toEqual({ format: "mp4", credits: { operation: "render.final", params: { durationSec: 18 } } });
    expect(finalRenderFor(doc("carousel", 6, 3))).toEqual({ format: "png", credits: { operation: "render.final", params: { slides: 6 } } });
    expect(finalRenderFor(doc("static", 1, 3))).toEqual({ format: "png", credits: { operation: "render.final", params: { slides: 1 } } });
  });

  it("a 6-slide carousel costs what the worker charges (ceil(6/4) = 2), not an 18-second video", async () => {
    const h = await autopilotHarness({ workspaceId: "ws_post_change" });
    const ws = h.p.db.ws(h.wid);
    const campaign = await ws.collection("campaigns").create(
      { appId: h.appId, name: "Slides", goal: "awareness", status: "review", channels: ["instagram"], deliverables: [{ kind: "carousel", channel: "instagram", aspectRatio: "4:5", count: 1, slides: 6 }], opportunityIds: [], selectedVariantIds: [] } as never,
      { actor: "u1" },
    );
    const make = async (kind: CompositionDoc["kind"], scenes: number, durationSec: number) => {
      const comp = await ws.collection("compositions").create({ appId: h.appId, campaignId: campaign.id, title: `${kind}`, kind, aspectRatio: kind === "video" ? "9:16" : "4:5", currentVersion: 1, latestVersion: 1 } as never, { actor: "u1" });
      await ws.collection("compositionVersions").create({ id: `${comp.id}_v1`, compositionId: comp.id, version: 1, parentVersion: null, doc: doc(kind, scenes, durationSec), source: "generated", summary: "v1", contentHash: `h-${comp.id}` } as never, { actor: "u1" });
      const post = await ws.collection("scheduledPosts").create(
        { appId: h.appId, campaignId: campaign.id, compositionId: comp.id, compositionVersion: 1, channel: "instagram", mode: "manual", caption: "Hello", tags: [], visibility: "public", containsSyntheticMedia: false, timezone: "UTC", status: "draft", manualInstructions: [], attempts: 0, assetIds: [] } as Partial<ScheduledPost> as never,
        { actor: "u1" },
      );
      return post.id;
    };
    const edit = h.p.credits.estimate("composition.edit").credits;

    const carousel = await estimatePostChange(h.p, h.wid, await make("carousel", 6, 3), "video");
    expect(carousel.credits).toBe(edit + h.p.credits.estimate("render.final", { slides: 6 }).credits);
    expect(carousel.credits).toBeLessThan(edit + h.p.credits.estimate("render.final", { durationSec: 18 }).credits);
    expect(carousel.breakdown.map((b) => b.label)).toEqual(["Change the images (Muse Spark)", "Final images (6 slides)"]);

    const video = await estimatePostChange(h.p, h.wid, await make("video", 3, 6), "video");
    expect(video.credits).toBe(edit + h.p.credits.estimate("render.final", { durationSec: 18 }).credits);
    expect(video.breakdown[0]!.label).toBe("Change the video (Muse Spark)");
  });

  it("a still's change line names slides, a video's names scenes", () => {
    expect(videoChangeLine("Shorter headline", [2, 4], true)).toBe("Shorter headline (slides 2 and 4)");
    expect(videoChangeLine("", [], true)).toBe("Changed the images");
    expect(videoChangeLine("Faster opening.", [1])).toBe("Faster opening (scene 1)");
  });
});
