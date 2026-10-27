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
