import type { App, AspectRatio, BrandProfile, ClipAnalysis, CompositionDoc, Layer, MediaAsset, Segmentation, Storyboard, StoryboardScene } from "@muselaunch/contracts";
import { STILL_TEMPLATE_IDS } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { buildFromStoryboard, STILL_SCENE_SEC } from "./build";
import { compileToHtml } from "./compile";
import { estimateTextHeight, lintDoc } from "./lint";
import { ensureNodeCompileRuntime } from "./node";
import { applyPatch } from "./patch";
import { sampleAsset } from "./test-fixtures";
import { validateDoc } from "./validate";

const now = "2026-11-03T00:00:00.000Z";
const base = { workspaceId: "ws_t", createdAt: now, updatedAt: now, createdBy: "u" };
const app = { ...base, id: "app_1", name: "Focusly", tagline: "Plan your day in focus blocks", platforms: ["ios", "android"], storeUrls: {}, status: "ready", dnaStatus: "confirmed", targetCountries: [], targetLanguages: ["en"], iconAssetId: "ast_icon" } as unknown as App;
const brand = {
  ...base,
  id: "app_1",
  appId: "app_1",
  version: 1,
  status: "confirmed",
  features: [{ id: "feat_stats", name: "Weekly stats", description: "", evidenceIds: [], assetIds: ["ast_stats"] }],
  visual: { palette: [{ hex: "#5E5CE6", role: "primary" }], styleKeywords: [], logoAssetIds: [], sampleAssetIds: [] },
  preferredCtas: ["Try Focusly free"],
} as unknown as BrandProfile;

const assets: MediaAsset[] = [
  sampleAsset("ast_today"),
  sampleAsset("ast_stats"),
  sampleAsset("ast_icon", { role: "icon", isProductTruth: false, width: 1024, height: 1024 }),
];
const founderAssets: MediaAsset[] = [
  sampleAsset("ast_founder", { kind: "video", role: "founder_clip", isProductTruth: false, mimeType: "video/mp4", width: 720, height: 1280, durationSec: 6 }),
  sampleAsset("ast_founder_cut", { kind: "video", role: "other", origin: "derived", isProductTruth: false, mimeType: "video/webm", width: 720, height: 1280, durationSec: 6, derivedFromAssetId: "ast_founder" }),
];
const founderSeg = {
  ...base,
  id: "seg_person",
  appId: "app_1",
  sourceAssetId: "ast_founder",
  prompt: "person",
  model: "sam-3.1",
  status: "succeeded",
  mediaType: "video",
  objects: [{ objectId: "0", label: "person", bbox: { x: 0.15, y: 0.2, w: 0.6, h: 0.8 } }],
  cutoutAssetId: "ast_founder_cut",
  trackingQuality: 0.95,
  corrections: [],
  selectedObjectIds: [],
  objectOutputs: {},
  usageEventIds: [],
} as unknown as Segmentation;
const founderAnalysis = {
  ...base,
  id: "cla_1",
  appId: "app_1",
  sourceAssetId: "ast_founder",
  status: "succeeded",
  objects: [{ key: "person", label: "person", segmentationId: "seg_person", objectId: "0", trackingQuality: 0.95, presence: [], meanBbox: { x: 0.13, y: 0.2, w: 0.6, h: 0.8 } }],
} as unknown as ClipAnalysis;

let n = 0;
const scene = (purpose: StoryboardScene["purpose"], template: string, onScreenText: string, over: Partial<StoryboardScene> = {}): StoryboardScene =>
  ({ id: `s${++n}`, order: n, purpose, durationSec: 3, onScreenText, narration: "", visual: "", template, assets: [], claimIds: [], ...over }) as StoryboardScene;

function storyboard(format: Storyboard["format"], aspectRatio: AspectRatio, scenes: StoryboardScene[], store?: "ios" | "android"): Storyboard {
  return { ...base, id: `sbd_${format}`, appId: "app_1", campaignId: "cpg_1", variantId: "var_1", title: "Focusly", aspectRatio, targetDurationSec: 9, format, store, scenes, voiceover: { source: "none" }, music: {} } as Storyboard;
}

const carouselScenes = () => [
  scene("hook", "slide-cover", "Your mornings deserve better", { body: "Plan the day in calm focus blocks." }),
  scene("feature", "slide-feature", "See where your focus goes", { body: "Weekly stats show your best hours.", assets: [{ kind: "screenshot", assetId: "ast_stats" }] }),
  scene("demo", "slide-feature", "Your whole day on one screen", { body: "Blocks, breaks and goals together.", assets: [{ kind: "screenshot", assetId: "ast_today" }] }),
  scene("proof", "slide-proof", "Rated 4.8 on the App Store", { body: "App Store rating, October 2026", claimIds: ["clm_rating"] }),
  scene("cta", "slide-cta", "Try Focusly free", { body: "Free on iPhone and Android." }),
];

const W = (doc: CompositionDoc) => doc.width;
const H = (doc: CompositionDoc) => doc.height;
const texts = (l: Layer[]) => l.filter((x): x is Extract<Layer, { type: "text" }> => x.type === "text");
const devices = (l: Layer[]) => l.filter((x): x is Extract<Layer, { type: "device" }> => x.type === "device");

/** Every text inside the safe zone and fitting its box; devices inside the frame's sides and top. */
function expectSlideFits(doc: CompositionDoc) {
  const sz = doc.safeZone;
  for (const s of doc.scenes) {
    for (const t of texts(s.layers)) {
      const b = t.box;
      const where = `${s.template} ${t.id} @ ${doc.aspectRatio}`;
      expect(b.x, where).toBeGreaterThanOrEqual(sz.left - 0.005);
      expect(b.x + b.w, where).toBeLessThanOrEqual(1 - sz.right + 0.005);
      expect(b.y, where).toBeGreaterThanOrEqual(sz.top - 0.005);
      expect(b.y + b.h, where).toBeLessThanOrEqual(1 - sz.bottom + 0.005);
      const pad = t.style.background ? t.style.background.paddingPx * 2 : 0;
      const est = estimateTextHeight(t.text, t.style.sizePx, t.style.lineHeight, b.w * W(doc) - pad, t.style.uppercase);
      expect(est.heightPx, where).toBeLessThanOrEqual(b.h * H(doc) * 1.08 + 4);
    }
    for (const d of devices(s.layers)) {
      const where = `${s.template} ${d.id} @ ${doc.aspectRatio}`;
      expect(d.box.x, where).toBeGreaterThanOrEqual(-0.02);
      expect(d.box.x + d.box.w, where).toBeLessThanOrEqual(1.02);
      expect(d.box.y, where).toBeGreaterThan(0);
    }
  }
}

const lintOf = (doc: CompositionDoc, extra: MediaAsset[] = [], segs: Segmentation[] = []) =>
  lintDoc(doc, { assets: Object.fromEntries([...assets, ...extra].map((a) => [a.id, a])), segmentations: Object.fromEntries(segs.map((s) => [s.id, s])) });

describe("still templates", () => {
  it("builds a carousel as an editable still doc: kind, frame, no transitions, captions or audio, fixed short slots", () => {
    const doc = buildFromStoryboard({ storyboard: storyboard("carousel", "4:5", carouselScenes()), app, brand, assets });
    expect(validateDoc(doc).ok).toBe(true);
    expect(doc).toMatchObject({ kind: "carousel", aspectRatio: "4:5", width: 1080, height: 1350, audio: [], captions: { enabled: false, cues: [] } });
    expect(doc.scenes.map((s) => s.template)).toEqual(["slide-cover", "slide-feature", "slide-feature", "slide-proof", "slide-cta"]);
    for (const s of doc.scenes) {
      expect(s.transitionIn).toEqual({ kind: "cut", durationSec: 0 });
      expect(s.durationSec).toBe(STILL_SCENE_SEC);
      // Stills are captured as they stand: no entrances, loops or keyframes still running.
      for (const l of s.layers) {
        expect(l.animation.enter, `${s.template} ${l.id}`).toBeUndefined();
        expect(l.animation.loop, `${s.template} ${l.id}`).toBe("none");
      }
    }
    expectSlideFits(doc);
    // Real screens in the feature slides (the hinted ones), the claim on the proof slide, the icon on the CTA.
    expect(devices(doc.scenes[1]!.layers).map((d) => d.screenAssetId)).toEqual(["ast_stats"]);
    expect(devices(doc.scenes[2]!.layers).map((d) => d.screenAssetId)).toEqual(["ast_today"]);
    expect(texts(doc.scenes[3]!.layers).find((t) => t.id.endsWith("_claim"))?.claimIds).toEqual(["clm_rating"]);
    expect(doc.scenes[3]!.layers.some((l) => l.type === "device" || l.type === "image" || l.type === "video")).toBe(false);
    expect(doc.scenes[4]!.layers.find((l) => l.type === "image")).toMatchObject({ assetId: "ast_icon" });
    expect(doc.scenes[4]!.layers.find((l) => l.type === "block" && l.blockId === "store-badges")).toMatchObject({ params: { ios: true, android: true, full: true } });
    // Swipe cue on the cover, slide numbers + dots after it.
    expect(texts(doc.scenes[0]!.layers).find((t) => t.id.endsWith("_swipe"))?.text).toMatch(/Swipe/);
    expect(doc.scenes[0]!.layers.find((l) => l.type === "block" && l.blockId === "page-dots")).toMatchObject({ params: { count: 5, active: 1 } });
    expect(texts(doc.scenes[2]!.layers).find((t) => t.id.endsWith("_counter"))?.text).toBe("3 / 5");
    // The cover shows the best real screen when there is no founder cut-out.
    expect(devices(doc.scenes[0]!.layers)).toHaveLength(1);
    expect(lintOf(doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("lays out every slide template at every frame it is used in, text inside the safe zone and fitting", () => {
    for (const ar of ["4:5", "1:1", "16:9", "9:16", "9:19.5"] as const) {
      for (const format of ["carousel", "post"] as const) {
        const scenes = format === "post" ? [carouselScenes()[1]!] : carouselScenes();
        const doc = buildFromStoryboard({ storyboard: storyboard(format, ar, scenes), app, brand, assets, aspectRatio: ar });
        expect(validateDoc(doc).ok).toBe(true);
        expectSlideFits(doc);
      }
    }
  });

  it("a single post is a static doc without page cues", () => {
    const doc = buildFromStoryboard({ storyboard: storyboard("post", "1:1", [scene("hook", "slide-cover", "Plan your day in focus blocks")]), app, brand, assets });
    expect(doc).toMatchObject({ kind: "static", aspectRatio: "1:1", width: 1080, height: 1080 });
    const ids = doc.scenes[0]!.layers.map((l) => l.id);
    expect(ids.some((id) => /_(swipe|dots|counter)$/.test(id))).toBe(false);
  });

  it("uses the founder's SAM cut-out on the cover and the thumbnail when it is ready", () => {
    const all = [...assets, ...founderAssets];
    const sb = storyboard("carousel", "4:5", carouselScenes());
    const doc = buildFromStoryboard({ storyboard: sb, app, brand, assets: all, segmentations: [founderSeg], clipAnalyses: [founderAnalysis] });
    const cover = doc.scenes[0]!;
    const founder = cover.layers.find((l) => l.type === "video");
    expect(founder).toMatchObject({ assetId: "ast_founder", mask: { segmentationId: "seg_person", mode: "cutout", fallback: "hide" } });
    expect(devices(cover.layers)).toHaveLength(0);
    // Placed by where the person is: their feet (bbox bottom) reach the slide's bottom edge, centred on the right half.
    const b = founder!.box;
    expect(b.y + (0.2 + 0.8) * b.h).toBeGreaterThan(0.99);
    expect(b.x + (0.13 + 0.3) * b.w).toBeGreaterThan(0.5);
    // Kept at the clip's own aspect (never stretched).
    expect((b.w * 1080) / (b.h * 1350)).toBeCloseTo(720 / 1280, 2);
    expectSlideFits(doc);

    const thumb = buildFromStoryboard({ storyboard: storyboard("thumbnail", "16:9", [scene("hook", "thumbnail-bold", "I built the planner I wanted")]), app, brand, assets: all, segmentations: [founderSeg], clipAnalyses: [founderAnalysis] });
    expect(thumb.scenes[0]!.layers.find((l) => l.type === "video")).toMatchObject({ mask: { segmentationId: "seg_person" } });
    // A cut-out that isn't ready falls back to a real screen.
    const pending = { ...founderSeg, status: "running" } as Segmentation;
    const noCut = buildFromStoryboard({ storyboard: sb, app, brand, assets: all, segmentations: [pending] });
    expect(noCut.scenes[0]!.layers.some((l) => l.type === "video")).toBe(false);
    expect(devices(noCut.scenes[0]!.layers)).toHaveLength(1);
  });

  it("thumbnail-bold: at most five huge, heavy words with an accent shape and a real screen, at 16:9", () => {
    const doc = buildFromStoryboard({ storyboard: storyboard("thumbnail", "16:9", [scene("hook", "hook-title", "Stop losing your mornings to busy work today")]), app, brand, assets });
    expect(doc).toMatchObject({ kind: "static", aspectRatio: "16:9", width: 1920, height: 1080 });
    const s = doc.scenes[0]!;
    expect(s.template).toBe("thumbnail-bold");
    const head = texts(s.layers).find((t) => t.id.endsWith("_headline"))!;
    expect(head.text.split(/\s+/).length).toBeLessThanOrEqual(5);
    expect(head.style.weight).toBeGreaterThanOrEqual(850);
    expect(head.style.shadow).toBe(true);
    // Reads at 160 px wide: the words are at least ~9 % of the frame height.
    expect(head.style.sizePx / 1080).toBeGreaterThan(0.09);
    expect(s.layers.some((l) => l.type === "shape" && l.id.endsWith("_accent"))).toBe(true);
    expect(devices(s.layers)).toHaveLength(1);
    expectSlideFits(doc);
  });

  it("store screenshots: a short benefit on top and the REAL screen very large below, at 9:19.5 and 9:16", () => {
    for (const [store, ar, w, h] of [
      ["ios", "9:19.5", 1290, 2796],
      ["android", "9:16", 1080, 1920],
    ] as const) {
      const scenes = [
        scene("hook", "slide-cover", "Plan your day in focus blocks"),
        scene("feature", "feature-callout", "See your best focus hours", { body: "Weekly stats, at a glance.", assets: [{ kind: "screenshot", assetId: "ast_stats" }] }),
        scene("cta", "slide-cta", "Try Focusly free"),
      ];
      const doc = buildFromStoryboard({ storyboard: storyboard("store_screenshots", ar, scenes, store), app, brand, assets });
      expect(doc).toMatchObject({ kind: "carousel", aspectRatio: ar, width: w, height: h });
      expect(doc.scenes.map((s) => s.template)).toEqual(["store-screenshot", "store-screenshot", "slide-cta"]);
      for (const s of doc.scenes.slice(0, 2)) {
        const head = texts(s.layers).find((t) => t.id.endsWith("_headline"))!;
        expect(estimateTextHeight(head.text, head.style.sizePx, head.style.lineHeight, head.box.w * w).lines).toBeLessThanOrEqual(2);
        const [d] = devices(s.layers);
        expect(d, s.id).toBeTruthy();
        // Very large: most of the frame's width, starting under the headline and reaching the bottom.
        expect(d!.box.w).toBeGreaterThan(0.55);
        expect(d!.box.y).toBeGreaterThan(head.box.y + head.box.h);
        expect(d!.box.y + d!.box.h).toBeGreaterThan(0.97);
        // No page cues or store pills inside a store set.
        expect(s.layers.some((l) => /_(swipe|dots|counter)$/.test(l.id))).toBe(false);
      }
      expect(doc.scenes[2]!.layers.some((l) => l.type === "block" && l.blockId === "store-badges")).toBe(false);
      expectSlideFits(doc);
      expect(lintOf(doc).filter((i) => i.level === "error")).toEqual([]);
    }
  });

  it("maps non-still templates by purpose and never makes a proof slide without a verified claim", () => {
    const scenes = [
      scene("hook", "hook-title", "Your mornings deserve better"),
      scene("problem", "kinetic-type", "Too many tabs", { assets: [{ kind: "screenshot", assetId: "ast_today" }] }),
      scene("proof", "stat-card", "Loved by focused people"),
      scene("proof", "stat-card", "Rated 4.8 on the App Store", { claimIds: ["clm_rating"] }),
      scene("proof", "slide-proof", "Top rated planner"),
      scene("cta", "store-cta", "Try Focusly free"),
    ];
    const doc = buildFromStoryboard({ storyboard: storyboard("carousel", "1:1", scenes), app, brand, assets });
    expect(doc.scenes.map((s) => s.template)).toEqual(["slide-cover", "slide-feature", "slide-feature", "slide-proof", "slide-feature", "slide-cta"]);
    const store = buildFromStoryboard({ storyboard: storyboard("store_screenshots", "9:19.5", scenes, "ios"), app, brand, assets });
    expect(store.scenes.map((s) => s.template)).toEqual(["store-screenshot", "store-screenshot", "store-screenshot", "slide-proof", "store-screenshot", "slide-cta"]);
    const thumb = buildFromStoryboard({ storyboard: storyboard("thumbnail", "16:9", [scene("hook", "slide-cover", "Mornings, sorted")]), app, brand, assets });
    expect(thumb.scenes[0]!.template).toBe("thumbnail-bold");
  });

  it("never invents UI: slides without real screens stay type-led", () => {
    const doc = buildFromStoryboard({ storyboard: storyboard("carousel", "4:5", carouselScenes()), app, brand: null, assets: [] });
    expect(doc.scenes.flatMap((s) => s.layers).filter((l) => l.type === "device" || l.type === "image" || l.type === "video")).toEqual([]);
    expectSlideFits(doc);
  });

  it("is deterministic and keeps stable layer ids across frames (variants carry edits by id)", () => {
    const sb = storyboard("carousel", "4:5", carouselScenes());
    const a = buildFromStoryboard({ storyboard: sb, app, brand, assets });
    expect(buildFromStoryboard({ storyboard: sb, app, brand, assets })).toEqual(a);
    const sq = buildFromStoryboard({ storyboard: sb, app, brand, assets, aspectRatio: "1:1" });
    expect(sq.scenes.map((s) => s.layers.map((l) => l.id).filter((id) => /_(headline|body|device|claim|cta|name)$/.test(id)))).toEqual(a.scenes.map((s) => s.layers.map((l) => l.id).filter((id) => /_(headline|body|device|claim|cta|name)$/.test(id))));
  });

  it("every still template id is buildable and stays editable by patch", () => {
    const sb = storyboard("carousel", "4:5", STILL_TEMPLATE_IDS.filter((t) => t !== "thumbnail-bold").map((t, i) => scene(i === 0 ? "hook" : "feature", t, "Plan your day", { claimIds: t === "slide-proof" ? ["clm_1"] : [], assets: [{ kind: "screenshot", assetId: "ast_today" }] })));
    const doc = buildFromStoryboard({ storyboard: sb, app, brand, assets });
    expect(validateDoc(doc).ok).toBe(true);
    const s = doc.scenes[1]!;
    const head = texts(s.layers).find((t) => t.id.endsWith("_headline"))!;
    const edited = applyPatch(doc, [{ op: "update_layer", sceneId: s.id, layerId: head.id, set: { text: "Edited, only this slide" } }]).doc;
    expect(texts(edited.scenes[1]!.layers).find((t) => t.id === head.id)?.text).toBe("Edited, only this slide");
    expect(edited.scenes[0]).toEqual(doc.scenes[0]);
  });
});

describe("still compile", () => {
  ensureNodeCompileRuntime();
  const doc = buildFromStoryboard({ storyboard: storyboard("carousel", "4:5", carouselScenes()), app, brand, assets });

  it("compiles a still doc statically: no timeline motion, no audio, page dots drawn", () => {
    const r = compileToHtml(doc, { assetUrl: (id) => `assets/${id}`, mode: "preview", gsapSource: "inline" });
    expect(r.scenes).toHaveLength(5);
    expect(r.html).not.toContain("tl.fromTo(");
    expect(r.html).not.toContain("<audio");
    // The active page dot is a wider pill.
    expect(r.html).toMatch(/border-radius:[\d.]+px;background:#FFFFFF"><\/span>/);
    // A Studio preview parked anywhere in a scene shows that slide as it renders.
    const still = compileToHtml(doc, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "inline", still: true, sceneSlotSec: 0.2 });
    expect(still.durationSec).toBe(1);
    expect(still.scenes.map((s) => s.start)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  });
});
