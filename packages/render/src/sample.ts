/**
 * Sample inputs for render tests and the smoke script. These describe a fictional app
 * ("Focusly") whose screenshots are generated test fixtures under fixtures/render/;
 * they are never shown as real customer data in the product.
 */
import type { App, BrandProfile, MediaAsset, Storyboard } from "@muselaunch/contracts";

const NOW = "2026-10-27T00:00:00.000Z";
const base = (wid: string, id: string) => ({ id, workspaceId: wid, createdAt: NOW, updatedAt: NOW, createdBy: "fixture" });

export const SAMPLE_FIXTURE_FILES = {
  ast_shot_today: { file: "screenshot-today.png", mime: "image/png", width: 1179, height: 2556, role: "screenshot" as const },
  ast_shot_stats: { file: "screenshot-stats.png", mime: "image/png", width: 1179, height: 2556, role: "screenshot" as const },
  ast_icon: { file: "app-icon.png", mime: "image/png", width: 1024, height: 1024, role: "icon" as const },
};

export function sampleApp(wid: string, appId = "app_focusly"): App {
  return {
    ...base(wid, appId),
    name: "Focusly",
    tagline: "Plan your day in focus blocks",
    platforms: ["ios"],
    storeUrls: {},
    status: "ready",
    dnaStatus: "confirmed",
    targetCountries: [],
    targetLanguages: ["en"],
    iconAssetId: "ast_icon",
  } as App;
}

export function sampleBrand(wid: string, appId = "app_focusly"): BrandProfile {
  return {
    ...base(wid, appId),
    appId,
    version: 1,
    status: "confirmed",
    oneLiner: "Plan your day in focus blocks",
    description: "A day planner built around focus blocks.",
    platforms: ["ios"],
    audiences: [],
    problems: [],
    features: [
      { id: "feat_blocks", name: "Focus blocks", description: "Time-boxed focus sessions", evidenceIds: [], assetIds: ["ast_shot_today"] },
      { id: "feat_stats", name: "Weekly focus stats", description: "Focus hours per day", evidenceIds: [], assetIds: ["ast_shot_stats"] },
    ],
    differentiators: [],
    monetization: { model: "freemium", evidenceIds: [] },
    tone: { voice: ["calm"], vocabularyUse: [], vocabularyAvoid: [] },
    visual: { palette: [{ hex: "#5E5CE6", role: "primary" }], styleKeywords: ["minimal"], logoAssetIds: [], sampleAssetIds: [] },
    preferredCtas: ["Try Focusly free"],
    prohibitedClaims: [],
    competitorIds: [],
    guidelines: "",
    userEditedPaths: [],
  } as BrandProfile;
}

export function sampleAssets(wid: string, appId = "app_focusly", keyFor: (id: string, file: string) => string): MediaAsset[] {
  return Object.entries(SAMPLE_FIXTURE_FILES).map(([id, f]) => ({
    ...base(wid, id),
    appId,
    kind: "image",
    role: f.role,
    origin: "upload",
    storagePath: keyFor(id, f.file),
    mimeType: f.mime,
    bytes: 0,
    width: f.width,
    height: f.height,
    status: "ready",
    labels: ["fixture"],
    isProductTruth: f.role === "screenshot",
  })) as MediaAsset[];
}

/**
 * A ~40 s editor-style storyboard over the same fixture screenshots: kinetic type, icon reveal,
 * phone tilt, focus zooms (boxes point at real elements of the fixture screens), a tap demo, a
 * full-screen shot and the store CTA.
 */
export function sampleLongStoryboard(wid: string, opts: { appId?: string; id?: string } = {}): Storyboard {
  const appId = opts.appId ?? "app_focusly";
  const shot = (id: string) => [{ kind: "screenshot" as const, assetId: id }];
  const s = (id: string, purpose: string, durationSec: number, template: string, onScreenText: string, extra: Partial<Storyboard["scenes"][number]> = {}) =>
    ({ id, order: 0, purpose, durationSec, onScreenText, narration: "", visual: template, template, assets: [], claimIds: [], ...extra }) as Storyboard["scenes"][number];
  const scenes = [
    s("l1", "hook", 2.2, "kinetic-type", "Mornings keep slipping away?"),
    s("l2", "problem", 3, "hook-title", "Too many tabs. Zero focus."),
    s("l3", "transition", 2.8, "icon-reveal", "Plan your day in focus blocks"),
    s("l4", "demo", 4, "phone-tilt", "Your whole day, one screen", { assets: shot("ast_shot_today") }),
    s("l5", "demo", 4, "focus-zoom", "Your focus goal, at a glance", { assets: shot("ast_shot_today"), focus: { x: 0.051, y: 0.173, w: 0.898, h: 0.129 } }),
    s("l6", "feature", 3.6, "tap-demo", "Add a block in one tap", { assets: shot("ast_shot_today"), focus: { x: 0.796, y: 0.81, w: 0.148, h: 0.068 } }),
    s("l7", "feature", 3.6, "device-demo", "See where your focus goes", { assets: shot("ast_shot_stats") }),
    s("l8", "feature", 4, "focus-zoom", "Your best hours to focus", { assets: shot("ast_shot_stats"), focus: { x: 0.051, y: 0.451, w: 0.898, h: 0.177 } }),
    s("l9", "other", 3.4, "fullscreen-showcase", "Built for calm mornings", { assets: shot("ast_shot_stats") }),
    s("l10", "other", 3, "kinetic-type", "Less busy. More done."),
    s("l11", "cta", 3.4, "store-cta", "Try Focusly free"),
  ];
  scenes.forEach((x, i) => (x.order = i));
  return {
    ...base(wid, opts.id ?? "sbd_sample_long"),
    appId,
    campaignId: "cpg_sample",
    variantId: "var_sample",
    title: "Focusly — calm mornings",
    aspectRatio: "9:16",
    targetDurationSec: scenes.reduce((n, x) => n + x.durationSec, 0),
    scenes,
    voiceover: { source: "none" },
    music: {},
  } as Storyboard;
}

export function sampleStoryboard(wid: string, opts: { appId?: string; scenes?: 3 | 5; id?: string } = {}): Storyboard {
  const appId = opts.appId ?? "app_focusly";
  const scenes: Storyboard["scenes"] = [
    { id: "s1", order: 0, purpose: "hook", durationSec: 2.5, onScreenText: "Your mornings deserve better", narration: "", visual: "Kinetic headline", template: "hook-title", assets: [], claimIds: [] },
    { id: "s2", order: 1, purpose: "demo", durationSec: 3.5, onScreenText: "Plan your whole day in focus blocks", narration: "", visual: "Real Today screen in a phone", template: "device-demo", assets: [{ kind: "screenshot", assetId: "ast_shot_today" }], claimIds: [] },
    { id: "s3", order: 2, purpose: "cta", durationSec: 3, onScreenText: "Try Focusly free", narration: "", visual: "End card", template: "cta-endcard", assets: [{ kind: "logo" }], claimIds: [] },
  ];
  if (opts.scenes === 5) {
    scenes.splice(2, 0, {
      id: "s2b",
      order: 1.5 as never,
      purpose: "feature",
      durationSec: 3,
      onScreenText: "See where your focus goes | Focus hours | Best time to focus",
      narration: "",
      visual: "Stats screen with callouts",
      template: "feature-callout",
      assets: [{ kind: "screenshot", assetId: "ast_shot_stats" }],
      claimIds: [],
    });
    scenes.forEach((s, i) => (s.order = i));
  }
  return {
    ...base(wid, opts.id ?? "sbd_sample"),
    appId,
    campaignId: "cpg_sample",
    variantId: "var_sample",
    title: "Focusly — mornings",
    aspectRatio: "9:16",
    targetDurationSec: 9,
    scenes,
    voiceover: { source: "none" },
    music: {},
  } as Storyboard;
}

/**
 * Still storyboards over the same fixture screenshots: a 4-slide carousel (4:5), a YouTube thumbnail
 * (16:9) and a 3-slide App Store set (9:19.5). Copy is fixture copy; the proof slide is only made
 * when a claim id is given (never an invented number).
 */
export function sampleStillStoryboard(
  wid: string,
  format: "carousel" | "thumbnail" | "store_screenshots",
  opts: { appId?: string; id?: string; store?: "ios" | "android"; claimId?: string } = {},
): Storyboard {
  const appId = opts.appId ?? "app_focusly";
  const shot = (id: string) => [{ kind: "screenshot" as const, assetId: id }];
  const s = (id: string, purpose: string, template: string, onScreenText: string, extra: Partial<Storyboard["scenes"][number]> = {}) =>
    ({ id, order: 0, purpose, durationSec: 3, onScreenText, narration: "", visual: template, template, assets: [], claimIds: [], ...extra }) as Storyboard["scenes"][number];
  let scenes: Storyboard["scenes"];
  let aspectRatio: Storyboard["aspectRatio"];
  if (format === "carousel") {
    aspectRatio = "4:5";
    scenes = [
      s("c1", "hook", "slide-cover", "Your mornings deserve better", { body: "Plan the whole day in calm focus blocks.", assets: shot("ast_shot_today") }),
      s("c2", "feature", "slide-feature", "Your whole day on one screen", { body: "Focus blocks, breaks and your goal, together.", assets: shot("ast_shot_today") }),
      s("c3", "feature", "slide-feature", "See where your focus goes", { body: "Weekly stats show your best hours to focus.", assets: shot("ast_shot_stats") }),
      ...(opts.claimId ? [s("c3b", "proof", "slide-proof", "Rated 4.8 on the App Store", { body: "App Store rating", claimIds: [opts.claimId] })] : []),
      s("c4", "cta", "slide-cta", "Try Focusly free", { body: "Plan tomorrow in two minutes." }),
    ];
  } else if (format === "thumbnail") {
    aspectRatio = "16:9";
    scenes = [s("t1", "hook", "thumbnail-bold", "Fix your mornings", { assets: shot("ast_shot_today") })];
  } else {
    aspectRatio = opts.store === "android" ? "9:16" : "9:19.5";
    scenes = [
      s("a1", "hook", "store-screenshot", "Plan your day in focus blocks", { body: "Your whole day, calmly laid out.", assets: shot("ast_shot_today") }),
      s("a2", "feature", "store-screenshot", "See your best focus hours", { body: "Weekly stats, at a glance.", assets: shot("ast_shot_stats") }),
      s("a3", "feature", "store-screenshot", "Add a block in one tap", { assets: shot("ast_shot_today") }),
    ];
  }
  scenes.forEach((x, i) => (x.order = i));
  return {
    ...base(wid, opts.id ?? `sbd_still_${format}`),
    appId,
    campaignId: "cpg_sample",
    variantId: "var_sample",
    title: format === "carousel" ? "Focusly — mornings carousel" : format === "thumbnail" ? "Focusly — thumbnail" : "Focusly — App Store screenshots",
    aspectRatio,
    targetDurationSec: scenes.length * 3,
    format,
    ...(format === "store_screenshots" ? { store: opts.store ?? "ios" } : {}),
    scenes,
    voiceover: { source: "none" },
    music: {},
  } as Storyboard;
}
