import type { App, BrandProfile, Layer, MediaAsset, RecordingSegment, Storyboard, StoryboardScene } from "@muselaunch/contracts";
import { TEMPLATE_IDS } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { _test, buildFromStoryboard, mediaToScreen } from "./build";
import { TEMPLATE_CATALOG, TEMPLATE_SHOT } from "./catalog";
import { compileToHtml, deviceGeometry } from "./compile";
import { describeForLLM } from "./describe";
import { lintDoc } from "./lint";
import { ensureNodeCompileRuntime } from "./node";
import { applyPatch } from "./patch";
import { sampleAsset } from "./test-fixtures";
import { validateDoc } from "./validate";
import { adaptToAspect } from "./variants";

const now = "2026-10-30T00:00:00.000Z";
const base = { workspaceId: "ws_t", createdAt: now, updatedAt: now, createdBy: "u" };
const app = { ...base, id: "app_1", name: "Magic Pocket", platforms: ["ios", "android"], storeUrls: {}, status: "ready", dnaStatus: "confirmed", targetCountries: [], targetLanguages: ["en"], iconAssetId: "ast_icon" } as unknown as App;
const brand = {
  ...base,
  id: "app_1",
  appId: "app_1",
  version: 1,
  status: "confirmed",
  features: [{ id: "feat_save", name: "Save anything", description: "", evidenceIds: [], assetIds: ["ast_raw"] }],
  visual: { palette: [{ hex: "#FF6B35", role: "primary" }], styleKeywords: [], logoAssetIds: [], sampleAssetIds: [] },
  preferredCtas: ["Get Magic Pocket"],
} as unknown as BrandProfile;

const assets: MediaAsset[] = [
  sampleAsset("ast_raw"),
  sampleAsset("ast_mkt", { screenshotKind: "marketing", width: 1290, height: 2796 }),
  sampleAsset("ast_crop", { sourceLabel: "sam_ui_crop", derivedFromAssetId: "ast_mkt", screenshotKind: "raw_ui", width: 1000, height: 2160, createdAt: "2026-10-30T00:00:01.000Z" }),
  sampleAsset("ast_rec", { kind: "video", role: "app_recording", mimeType: "video/mp4", width: 886, height: 1920, durationSec: 120 }),
  sampleAsset("ast_icon", { role: "icon", isProductTruth: false, width: 1024, height: 1024 }),
  sampleAsset("ast_stock", { role: "stock_image", origin: "stock", isProductTruth: false, width: 1080, height: 1350 }),
];
const segs: RecordingSegment[] = [
  { ...base, id: "rsg_long", appId: "app_1", assetId: "ast_rec", startSec: 40, endSec: 50, label: "Saves a booking", action: "tap", featureIds: ["feat_save"], quality: 0.9, privacy: { flagged: true, regions: [{ x: 0.1, y: 0.05, w: 0.8, h: 0.06 }] } },
  { ...base, id: "rsg_short", appId: "app_1", assetId: "ast_rec", startSec: 3, endSec: 5, label: "Opens pinned items", action: "navigate", featureIds: [], quality: 0.7, privacy: { flagged: false, regions: [] } },
] as RecordingSegment[];

let order = 0;
const scene = (template: string, over: Partial<StoryboardScene> = {}): StoryboardScene => ({ id: `s${++order}`, order, purpose: "demo", durationSec: 4, onScreenText: "Save it in one tap", narration: "", visual: "", template, assets: [], claimIds: [], ...over });

function storyboard(scenes: StoryboardScene[]): Storyboard {
  return { ...base, id: "sbd_1", appId: "app_1", campaignId: "cpg_1", variantId: "var_1", title: "Magic Pocket", aspectRatio: "9:16", targetDurationSec: scenes.reduce((n, s) => n + s.durationSec, 0), scenes, voiceover: { source: "none" }, music: {} } as Storyboard;
}

const devices = (l: Layer[]) => l.filter((x): x is Extract<Layer, { type: "device" }> => x.type === "device");

describe("scene variety templates", () => {
  const sb = storyboard([
    scene("kinetic-type", { purpose: "hook", durationSec: 2, onScreenText: "Lost that booking again?" }),
    scene("icon-reveal", { purpose: "transition", durationSec: 2.5, onScreenText: "Everything, one pocket" }),
    scene("phone-tilt", { assets: [{ kind: "app_recording", assetId: "ast_rec", segmentId: "rsg_short" }] }),
    scene("focus-zoom", { assets: [{ kind: "screenshot", assetId: "ast_raw" }], focus: { x: 0.1, y: 0.4, w: 0.5, h: 0.1 } }),
    scene("tap-demo", { durationSec: 3, assets: [{ kind: "app_recording", assetId: "ast_rec", segmentId: "rsg_long" }], focus: { x: 0.3, y: 0.6, w: 0.4, h: 0.08 } }),
    scene("device-demo", { assets: [{ kind: "screenshot", assetId: "ast_mkt" }] }),
    scene("fullscreen-showcase", { purpose: "feature", assets: [{ kind: "screenshot", assetId: "ast_mkt" }], onScreenText: "Pinned, always" }),
    scene("split-screen", { assets: [{ kind: "screenshot", assetId: "ast_raw" }, { kind: "stock_image", assetId: "ast_stock", query: "traveller at an airport" }], onScreenText: "Travel ready | Your plans | On the go" }),
    scene("store-cta", { purpose: "cta", durationSec: 3, onScreenText: "Get Magic Pocket" }),
  ]);
  const doc = buildFromStoryboard({ storyboard: sb, app, brand, assets, recordingSegments: segs });
  const byTemplate = (t: string) => doc.scenes.find((s) => s.template === t)!;

  it("builds every new template as a valid, editable doc in all aspect ratios", () => {
    expect(validateDoc(doc).ok).toBe(true);
    expect(doc.scenes.map((s) => s.template)).toEqual(["kinetic-type", "icon-reveal", "phone-tilt", "focus-zoom", "tap-demo", "device-demo", "fullscreen-showcase", "split-screen", "store-cta"]);
    for (const ar of ["9:16", "1:1", "16:9", "4:5"] as const) {
      const d = buildFromStoryboard({ storyboard: sb, app, brand, assets, recordingSegments: segs, aspectRatio: ar });
      expect(validateDoc(d).ok).toBe(true);
      expect(lintDoc(d, { assets: Object.fromEntries(assets.map((a) => [a.id, a])) }).filter((i) => i.level === "error")).toEqual([]);
    }
    for (const id of TEMPLATE_IDS) {
      expect(TEMPLATE_CATALOG[id].description.length).toBeGreaterThan(10);
      expect(TEMPLATE_SHOT[id]).toBeTruthy();
    }
  });

  it("plays walkthrough segments trimmed (long ones sped up ≤ 1.5×) and blurs flagged personal info", () => {
    const tilt = devices(byTemplate("phone-tilt").layers)[0]!;
    expect(tilt).toMatchObject({ screenAssetId: "ast_rec", screenKind: "video", trimInSec: 3, trimOutSec: 5, tilt: { x: 9, y: -22, swing: true } });
    expect(tilt.playbackRate).toBeUndefined(); // 2 s segment in a 4 s scene holds its last frame
    const tap = devices(byTemplate("tap-demo").layers)[0]!;
    expect(tap).toMatchObject({ trimInSec: 40, trimOutSec: 50, playbackRate: 1.5 }); // 10 s of footage in a 3 s slot: capped at 1.5×
    expect(tap.blurRegions).toHaveLength(1);
    expect(tap.tap!.x).toBeCloseTo(0.5, 2);
    expect(tap.tap!.atSec).toBeGreaterThan(0.8);
  });

  it("focus-zoom pushes in on Spark's region (mapped from the image to the visible screen) with a ring", () => {
    const fz = devices(byTemplate("focus-zoom").layers)[0]!;
    expect(fz.focus).toMatchObject({ ring: true });
    expect(fz.focus!.x).toBeCloseTo(0.1, 2);
    // A 1179×2556 screenshot is slightly taller than the iPhone screen: y fractions grow a little.
    expect(fz.focus!.y).toBeGreaterThan(0.39);
    expect(fz.focus!.y).toBeLessThan(0.42);
    expect(byTemplate("focus-zoom").layers.some((l) => l.id.endsWith("_scrim"))).toBe(true);
  });

  it("never puts a marketing screenshot in a device: its SAM cut-out goes in, the original only full screen", () => {
    const demo = devices(byTemplate("device-demo").layers)[0]!;
    expect(demo.screenAssetId).toBe("ast_crop");
    for (const s of doc.scenes) for (const d of devices(s.layers)) expect(d.screenAssetId).not.toBe("ast_mkt");
    const show = byTemplate("fullscreen-showcase");
    expect(show.layers.find((l) => l.type === "image")).toMatchObject({ assetId: "ast_mkt", fit: "contain", box: { x: 0, y: 0, w: 1, h: 1 } });
    expect(show.background).toMatchObject({ kind: "blur", assetId: "ast_mkt" });
    // Lint blocks the mistake if someone swaps the original back into a device.
    const bad = applyPatch(doc, [{ op: "update_layer", sceneId: byTemplate("device-demo").id, layerId: demo.id, set: { screenAssetId: "ast_mkt" } }]).doc;
    const errors = lintDoc(bad, { assets: Object.fromEntries(assets.map((a) => [a.id, a])) }).filter((i) => i.level === "error");
    expect(errors.map((e) => e.message).join(" ")).toMatch(/designed store screenshot/);
  });

  it("type, icon and end-card templates: word-by-word lines at reading pace, real icon, plain-text store pills", () => {
    const kt = byTemplate("kinetic-type").layers.filter((l) => l.type === "text");
    expect(kt.length).toBeGreaterThanOrEqual(2);
    expect(kt.every((l) => l.animation.enter?.preset === "words")).toBe(true);
    expect(kt[1]!.timing.start).toBeGreaterThan(kt[0]!.timing.start); // later lines wait their turn (~3 words/s)
    const icon = byTemplate("icon-reveal").layers.find((l) => l.type === "image");
    expect(icon).toMatchObject({ assetId: "ast_icon" });
    const pills = byTemplate("store-cta").layers.find((l) => l.type === "block");
    expect(pills).toMatchObject({ blockId: "store-badges", params: { ios: true, android: true, full: true, stack: true } });
  });

  it("split screens accept supporting b-roll beside the real app (never in a device)", () => {
    const s = byTemplate("split-screen");
    expect(devices(s.layers).map((d) => d.screenAssetId)).toEqual(["ast_raw"]);
    expect(s.layers.find((l) => l.type === "image")).toMatchObject({ assetId: "ast_stock" });
  });

  it("compiles focus ring, tap, tilt, privacy blur and store wording into HTML + timeline", () => {
    ensureNodeCompileRuntime();
    const { html } = compileToHtml(doc, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "inline", assetKinds: { ast_rec: "video" } });
    const fz = devices(byTemplate("focus-zoom").layers)[0]!;
    const tap = devices(byTemplate("tap-demo").layers)[0]!;
    const tilt = devices(byTemplate("phone-tilt").layers)[0]!;
    expect(html).toContain(`id="l-${fz.id}-ring"`);
    expect(html).toMatch(new RegExp(`tl\\.fromTo\\(q\\("l-${fz.id}-z"\\), \\{x:0, y:0, scale:1\\}, \\{x:-?[\\d.]+, y:-?[\\d.]+, scale:[\\d.]+`));
    expect(html).toContain(`id="l-${tap.id}-tapd"`);
    expect(html).toContain('data-playback-rate="1.5"');
    expect(html).toContain("backdrop-filter:blur(");
    expect(html).toContain(`q("l-${tilt.id}-t"), {rotationX:9, rotationY:-22`);
    expect(html).toContain("Download on the");
    expect(html).toContain("Get it on");
    expect(html).not.toMatch(/apple-logo|google-play-logo|<svg[^>]*aria-label="(Apple|Google)/i);
    // Still capture (carousels) shows the zoomed state without a timeline.
    const still = compileToHtml(doc, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "inline", still: true });
    expect(still.html).toMatch(/transform:translate\([-\d.]+px,[-\d.]+px\) scale\([\d.]+\)/);
  });

  it("keeps focus/tap/tilt editable: patches, AI description and aspect variants carry them", () => {
    const fzScene = byTemplate("focus-zoom");
    const fz = devices(fzScene.layers)[0]!;
    const moved = applyPatch(doc, [{ op: "update_layer", sceneId: fzScene.id, layerId: fz.id, set: { focus: { x: 0.2, zoom: 2 } } }]).doc;
    const after = devices(moved.scenes.find((s) => s.id === fzScene.id)!.layers)[0]!;
    expect(after.focus).toMatchObject({ x: 0.2, zoom: 2, ring: true });
    expect(describeForLLM(moved)).toMatch(/focus\(x=0\.2,.*zoom=2/);
    expect(describeForLLM(doc)).toMatch(/tilt\(x=9°,y=-22°/);
    const wide = adaptToAspect(moved, "16:9", buildFromStoryboard({ storyboard: sb, app, brand, assets, recordingSegments: segs, aspectRatio: "16:9" }));
    expect(devices(wide.scenes.find((s) => s.id === fzScene.id)!.layers)[0]!.focus).toMatchObject({ x: 0.2, zoom: 2 });
  });

  it("an item shown again gets a different crop when there are fewer items than scenes", () => {
    const d = buildFromStoryboard({
      storyboard: storyboard([scene("device-demo", { assets: [{ kind: "screenshot", assetId: "ast_raw" }] }), scene("device-demo", { assets: [{ kind: "screenshot", assetId: "ast_raw" }] }), scene("store-cta", { purpose: "cta" })]),
      app,
      brand,
      assets,
    });
    const [a, b] = d.scenes.slice(0, 2).map((s) => devices(s.layers)[0]!);
    expect(a!.focus).toBeUndefined();
    expect(b!.focus).toMatchObject({ zoom: 1.55, ring: false });
  });
});

describe("kinetic type lines", () => {
  it("break at punctuation and balance phrases (no orphan words), at most 4 lines", () => {
    expect(_test.kineticLines("Mornings keep slipping away?")).toEqual(["Mornings keep", "slipping away?"]);
    expect(_test.kineticLines("Too many tabs. Zero focus.")).toEqual(["Too many tabs.", "Zero focus."]);
    expect(_test.kineticLines("Lost it")).toEqual(["Lost it"]);
    expect(_test.kineticLines("one two three four five six seven eight nine ten eleven twelve thirteen").length).toBeLessThanOrEqual(4);
  });
});

describe("media → screen mapping", () => {
  it("accounts for the top-aligned cover crop of the device screen", () => {
    const g = deviceGeometry("iphone", 488.5, 1000);
    const sa = g.screen.width / g.screen.height;
    expect(sa).toBeCloseTo(0.4666, 3);
    // Same aspect: identity.
    expect(mediaToScreen({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, sa, sa)).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    // Taller media loses its bottom: a region near the bottom is clipped.
    const tall = mediaToScreen({ x: 0, y: 0.9, w: 1, h: 0.1 }, sa * 0.8, sa);
    expect(tall.y).toBeCloseTo(1, 2);
    expect(tall.h).toBeCloseTo(0, 2);
    // Wider media loses its sides symmetrically.
    expect(mediaToScreen({ x: 0.5, y: 0, w: 0, h: 1 }, sa * 2, sa).x).toBeCloseTo(0.5, 3);
  });
});
