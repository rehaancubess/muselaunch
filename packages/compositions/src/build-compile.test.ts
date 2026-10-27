import type { App, BrandProfile, MediaAsset, Storyboard } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { buildFromStoryboard } from "./build";
import { collectAssetRefs, compileToHtml } from "./compile";
import { docHash } from "./hash";
import { lintDoc } from "./lint";
import { ensureNodeCompileRuntime } from "./node";
import { applyPatch } from "./patch";
import { sampleAsset } from "./test-fixtures";
import { validateDoc } from "./validate";

const now = new Date().toISOString();
const base = { workspaceId: "ws_t", createdAt: now, updatedAt: now, createdBy: "u" };
const app = { ...base, id: "app_1", name: "Focusly", platforms: ["ios"], storeUrls: {}, status: "ready", dnaStatus: "confirmed", targetCountries: [], targetLanguages: ["en"], iconAssetId: "ast_icon" } as unknown as App;
const brand = {
  ...base,
  id: "app_1",
  appId: "app_1",
  version: 2,
  status: "confirmed",
  oneLiner: "x",
  description: "x",
  platforms: ["ios"],
  audiences: [],
  problems: [],
  features: [{ id: "feat_1", name: "Focus blocks", description: "", evidenceIds: [], assetIds: ["ast_shot2"] }],
  differentiators: [],
  monetization: { model: "freemium", evidenceIds: [] },
  tone: { voice: [], vocabularyUse: [], vocabularyAvoid: [] },
  visual: { palette: [{ hex: "#5E5CE6", role: "primary" }], styleKeywords: [], logoAssetIds: [], sampleAssetIds: [] },
  preferredCtas: [],
  prohibitedClaims: [],
  competitorIds: [],
  guidelines: "",
  userEditedPaths: [],
} as unknown as BrandProfile;
const assets: MediaAsset[] = [
  sampleAsset("ast_shot1"),
  sampleAsset("ast_shot2"),
  sampleAsset("ast_icon", { role: "icon", isProductTruth: false, width: 1024, height: 1024 }),
  sampleAsset("ast_gen", { role: "generated_image", origin: "generated", isProductTruth: false }),
];
const storyboard = {
  ...base,
  id: "sbd_1",
  appId: "app_1",
  campaignId: "cpg_1",
  variantId: "var_1",
  title: "Launch",
  aspectRatio: "9:16",
  targetDurationSec: 12,
  scenes: [
    { id: "s1", order: 0, purpose: "hook", durationSec: 2.5, onScreenText: "Your mornings deserve better", narration: "Mornings are chaos.", visual: "", template: "hook-title", assets: [], claimIds: [] },
    { id: "s2", order: 1, purpose: "demo", durationSec: 3.5, onScreenText: "Plan your day in focus blocks", narration: "Plan your day.", visual: "", template: "device-demo", assets: [{ kind: "screenshot", assetId: "ast_shot1" }], claimIds: [] },
    { id: "s3", order: 2, purpose: "feature", durationSec: 3, onScreenText: "See your focus | Weekly stats", narration: "", visual: "", template: "feature-callout", assets: [{ kind: "screenshot", featureId: "feat_1" }], claimIds: [] },
    { id: "s4", order: 3, purpose: "demo", durationSec: 3, onScreenText: "Generated UI is never used", narration: "", visual: "", template: "device-demo", assets: [{ kind: "generated_image", assetId: "ast_gen" }], claimIds: [] },
    { id: "s5", order: 4, purpose: "cta", durationSec: 3, onScreenText: "Try it free", narration: "", visual: "", template: "cta-endcard", assets: [], claimIds: [] },
  ],
  voiceover: { source: "none" },
  music: {},
} as unknown as Storyboard;

describe("buildFromStoryboard", () => {
  it("produces a valid, deterministic doc that only frames real product media", () => {
    const doc = buildFromStoryboard({ storyboard, app, brand, assets });
    expect(validateDoc(doc).ok).toBe(true);
    expect(docHash(buildFromStoryboard({ storyboard, app, brand, assets }))).toBe(docHash(doc));
    expect(doc.scenes.map((s) => s.template)).toEqual(["hook-title", "device-demo", "feature-callout", "device-demo", "cta-endcard"]);
    const devices = doc.scenes.flatMap((s) => s.layers.filter((l) => l.type === "device"));
    expect(devices.length).toBeGreaterThanOrEqual(3);
    for (const d of devices) expect(d.type === "device" && ["ast_shot1", "ast_shot2"]).toContain(d.type === "device" ? d.screenAssetId : "");
    // the feature scene uses the feature's linked screenshot
    const feat = doc.scenes[2]!.layers.find((l) => l.type === "device");
    expect(feat?.type === "device" && feat.screenAssetId).toBe("ast_shot2");
    expect(doc.theme.accent).toBe("#5E5CE6");
    expect(lintDoc(doc, { assets: Object.fromEntries(assets.map((a) => [a.id, a])) }).filter((i) => i.level === "error")).toEqual([]);
  });

  it("lays out every aspect ratio", () => {
    for (const ar of ["9:16", "1:1", "16:9", "4:5"] as const) {
      const doc = buildFromStoryboard({ storyboard, app, brand, assets, aspectRatio: ar });
      expect(doc.aspectRatio).toBe(ar);
      expect(validateDoc(doc).ok).toBe(true);
      // stable layer ids across aspects (variants carry edits by id)
      expect(doc.scenes[1]!.layers.map((l) => l.id)).toContain("sc_s2_headline");
    }
  });

  it("degrades to text-led scenes without product media (never invents UI)", () => {
    const doc = buildFromStoryboard({ storyboard, app, brand: null, assets: [] });
    expect(doc.scenes.flatMap((s) => s.layers).filter((l) => l.type === "device" || l.type === "image")).toEqual([]);
    expect(doc.theme.accent).toBe("#0A84FF");
  });
});

describe("compileToHtml", () => {
  ensureNodeCompileRuntime();
  const doc = buildFromStoryboard({ storyboard, app, brand, assets });

  it("emits a HyperFrames composition with timed clips and a registered GSAP timeline", () => {
    const { html, durationSec, scenes, assetIds } = compileToHtml(doc, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "inline" });
    expect(durationSec).toBe(15);
    expect(html).toContain('data-composition-id="muselaunch"');
    expect(html).toContain('data-width="1080" data-height="1920"');
    expect(html).toMatch(/<section id="s-sc_s1" class="scene clip" data-start="0" data-duration="3"/); // 2.5s + 0.5s zoom overlap into scene 2
    expect(html).toContain('data-track-index="');
    expect(html).toContain('window.__timelines["muselaunch"] = tl');
    expect(html).toContain("GSAP 3.");
    expect(html).toContain("@font-face{font-family:'Inter Variable'");
    expect(html).not.toMatch(/cdn\.jsdelivr|fonts\.googleapis/);
    expect(scenes.map((s) => s.start)).toEqual([0, 2.5, 6, 9, 12]);
    expect(assetIds.sort()).toEqual(["ast_icon", "ast_shot1", "ast_shot2"]);
    expect(collectAssetRefs(doc).assetIds.sort()).toEqual(["ast_icon", "ast_shot1", "ast_shot2"]);
  });

  it("escapes document text and never puts it in script", () => {
    const evil = applyPatch(doc, [{ op: "update_layer", sceneId: "sc_s1", layerId: "sc_s1_headline", set: { text: '</script><img src=x onerror="alert(1)"> & more' } }]).doc;
    const { html } = compileToHtml(evil, { assetUrl: (id) => `assets/${id}`, mode: "preview", gsapSource: "/static/gsap.min.js" });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;/script&gt;&lt;img");
    const script = html.slice(html.lastIndexOf("<script>"));
    expect(script).not.toContain("alert");
    expect(html).toContain('<script src="/static/gsap.min.js"></script>');
  });

  it("swaps masked video to the SAM cutout and falls back per mask.fallback", () => {
    const withVideo = applyPatch(doc, [
      {
        op: "add_layer",
        sceneId: "sc_s2",
        layer: { id: "ly_founder", type: "video", assetId: "ast_clip", box: { x: 0, y: 0, w: 1, h: 1 }, mask: { segmentationId: "seg_1", fallback: "unmasked" } } as never,
      },
    ]).doc;
    const ok = compileToHtml(withVideo, { assetUrl: (id) => `a/${id}`, mode: "render", gsapSource: "inline", segmentations: { seg_1: { status: "succeeded", cutoutAssetId: "ast_cut", trackingQuality: 0.9, mediaType: "video" } } });
    expect(ok.html).toMatch(/<video id="v-ly_founder"[^>]*src="a\/ast_cut"/);
    const low = compileToHtml(withVideo, { assetUrl: (id) => `a/${id}`, mode: "render", gsapSource: "inline", segmentations: { seg_1: { status: "succeeded", cutoutAssetId: "ast_cut", trackingQuality: 0.2, mediaType: "video" } } });
    expect(low.html).toMatch(/<video id="v-ly_founder"[^>]*src="a\/ast_clip"/);
    const hidden = applyPatch(withVideo, [{ op: "update_layer", sceneId: "sc_s2", layerId: "ly_founder", set: { mask: { fallback: "hide" } } }]).doc;
    expect(compileToHtml(hidden, { assetUrl: (id) => `a/${id}`, mode: "render", gsapSource: "inline" }).html).not.toContain("v-ly_founder");
  });

  it("supports still capture with fixed scene slots", () => {
    const r = compileToHtml(doc, { assetUrl: (id) => id, mode: "render", gsapSource: "inline", still: true, sceneSlotSec: 0.25 });
    expect(r.durationSec).toBe(1.25);
    expect(r.html).not.toContain("tl.fromTo(");
  });
});
