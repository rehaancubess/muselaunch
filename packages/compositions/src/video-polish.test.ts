import type { App, BrandProfile, Layer, RecordingSegment, Storyboard, StoryboardScene } from "@muselaunch/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFromStoryboard, withTypeface } from "./build";
import { TEMPLATE_SHOT } from "./catalog";
import { compileToHtml } from "./compile";
import { BUNDLED_FONTS, bundledFont, fontWidthFactor } from "./fonts";
import { estimateTextHeight, lintDoc } from "./lint";
import { ensureNodeCompileRuntime } from "./node";
import { getCompileRuntime } from "./runtime";
import { sampleAsset } from "./test-fixtures";
import { validateDoc } from "./validate";

const now = "2026-11-03T00:00:00.000Z";
const base = { workspaceId: "ws_t", createdAt: now, updatedAt: now, createdBy: "u" };
const app = { ...base, id: "app_1", name: "Ledgerly", platforms: ["ios"], storeUrls: {}, status: "ready", dnaStatus: "confirmed", targetCountries: [], targetLanguages: ["en"] } as unknown as App;
const shot = sampleAsset("ast_shot", { width: 1179, height: 2556, appId: "app_1" });
const shot2 = sampleAsset("ast_shot2", { width: 1179, height: 2556, appId: "app_1" });
const rec = sampleAsset("ast_rec", { kind: "video", role: "app_recording", mimeType: "video/mp4", width: 886, height: 1920, durationSec: 40, appId: "app_1" });
const stock = sampleAsset("ast_stock", { kind: "image", role: "stock_image", isProductTruth: false, width: 1080, height: 1920 });
const seg = { ...base, id: "rsg_1", appId: "app_1", assetId: "ast_rec", startSec: 4, endSec: 9, label: "Opens the dashboard", action: "navigate", featureIds: [], quality: 0.9, privacy: { flagged: true, regions: [{ x: 0.1, y: 0.5, w: 0.5, h: 0.04, path: [{ t: 4, x: 0.1, y: 0.5, w: 0.5, h: 0.04 }, { t: 9, x: 0.1, y: 0.3, w: 0.5, h: 0.04 }] }] }, keyframeAtSec: 6 } as unknown as RecordingSegment;

let order = 0;
const sc = (template: string, over: Partial<StoryboardScene> = {}): StoryboardScene => ({ id: `s${++order}`, order, purpose: "demo", durationSec: 4, onScreenText: "Money, finally calm", narration: "", visual: "", template, assets: [{ kind: "screenshot", assetId: "ast_shot" }], claimIds: [], ...over });
const sb = (scenes: StoryboardScene[], over: Partial<Storyboard> = {}): Storyboard =>
  ({ ...base, id: "sbd_1", appId: "app_1", campaignId: "c", variantId: "v", title: "Ledgerly", aspectRatio: "9:16", targetDurationSec: 12, scenes, voiceover: { source: "none" }, music: {}, ...over }) as Storyboard;
const opts = { assetUrl: (id: string) => `assets/${id}`, mode: "render" as const, gsapSource: "inline" as const };
const all = [shot, shot2, rec, stock];

beforeAll(() => ensureNodeCompileRuntime());

describe("footage-first hook", () => {
  it("opens on a walkthrough segment full-bleed with the hook in big type, privacy blur moving with the footage", () => {
    const doc = buildFromStoryboard({ storyboard: sb([sc("hook-footage", { purpose: "hook", onScreenText: "Stop losing receipts", assets: [{ kind: "app_recording", segmentId: "rsg_1" }] }), sc("device-demo")]), app, brand: null, assets: all, recordingSegments: [seg] });
    const s0 = doc.scenes[0]!;
    expect(s0.template).toBe("hook-footage");
    expect(TEMPLATE_SHOT["hook-footage"]).toBe("full");
    const media = s0.layers.find((l): l is Extract<Layer, { type: "video" }> => l.type === "video")!;
    expect(media).toMatchObject({ assetId: "ast_rec", trimInSec: 4, fit: "cover", box: { x: 0, y: 0, w: 1, h: 1 } });
    expect(media.blurRegions?.[0]?.path).toHaveLength(2);
    const head = s0.layers.find((l) => l.id.endsWith("_headline"))!;
    expect(head.box.y + head.box.h).toBeLessThanOrEqual(1 - doc.safeZone.bottom);
    expect(lintDoc(doc, { assets: Object.fromEntries(all.map((a) => [a.id, a])), claims: {} }).filter((i) => i.level === "error")).toEqual([]);
    // Out of the opening, the next scene dives in.
    expect(doc.scenes[1]!.transitionIn.kind).toBe("zoom");
  });

  it("uses a screenshot when there is no footage", () => {
    const doc = buildFromStoryboard({ storyboard: sb([sc("hook-footage", { purpose: "hook" }), sc("device-demo", { assets: [{ kind: "screenshot", assetId: "ast_shot2" }] })]), app, brand: null, assets: all });
    expect(doc.scenes[0]!.layers.find((l) => l.type === "image")).toMatchObject({ assetId: "ast_shot", fit: "cover" });
  });
});

describe("typefaces", () => {
  it("bundles six OFL display faces plus Inter, with measured widths", () => {
    expect(BUNDLED_FONTS.map((f) => f.name)).toEqual(["Inter", "Plus Jakarta Sans", "Space Grotesk", "Bricolage Grotesque", "Sora", "Fraunces", "Manrope"]);
    expect(bundledFont("space grotesk")?.cssFamily).toBe("Space Grotesk Variable");
    expect(bundledFont("Comic Sans")).toBeUndefined();
    expect(fontWidthFactor("Sora")).toBeGreaterThan(1.05);
    // A wider face needs more lines for the same text.
    expect(estimateTextHeight("Plan your whole week in one calm place", 100, 1, 700, false, 1.11).lines).toBeGreaterThanOrEqual(estimateTextHeight("Plan your whole week in one calm place", 100, 1, 700).lines);
  });

  it("uses Spark's pick unless the brand kit names its own heading font, and inlines only that face", () => {
    const theme = { mode: "light", background: "#fff", surface: "#fff", text: "#000", textMuted: "#666", accent: "#0A84FF", headingFont: "Inter", bodyFont: "Inter", radiusPx: 28 } as const;
    expect(withTypeface({ ...theme }, null, "Fraunces").headingFont).toBe("Fraunces");
    expect(withTypeface({ ...theme }, { visual: { headingFont: "Manrope" } } as unknown as BrandProfile, "Fraunces").headingFont).toBe("Inter"); // the theme already carries the brand font
    expect(withTypeface({ ...theme }, null, "Papyrus").headingFont).toBe("Inter");

    const doc = buildFromStoryboard({ storyboard: sb([sc("hook-title", { purpose: "hook" }), sc("device-demo")], { typeface: "Fraunces" }), app, brand: null, assets: all });
    expect(doc.theme.headingFont).toBe("Fraunces");
    const { html } = compileToHtml(doc, opts);
    expect(html).toContain("font-family:'Fraunces Variable'");
    expect(html).toContain("'Fraunces Variable','Inter Variable'");
    expect(html).not.toContain("font-family:'Sora Variable'"); // only the face this video uses
    expect(Object.keys(getCompileRuntime().fonts ?? {})).toHaveLength(6);
  });

  it("warns when a theme font isn't bundled (it would render as Inter)", () => {
    const doc = buildFromStoryboard({ storyboard: sb([sc("hook-title", { purpose: "hook" })]), app, brand: null, assets: all });
    const v = validateDoc({ ...doc, theme: { ...doc.theme, headingFont: "Helvetica Now" } });
    expect(v.ok).toBe(true);
    const issues = lintDoc(v.ok ? v.doc : doc, { assets: {}, claims: {} });
    expect(issues.some((i) => i.message.includes('"Helvetica Now" isn\'t bundled'))).toBe(true);
  });
});

describe("transitions", () => {
  it("dives out of a close-up, match-cuts phone to phone, and whips into a tilt", () => {
    const doc = buildFromStoryboard({
      storyboard: sb([
        sc("hook-title", { purpose: "hook" }),
        sc("focus-zoom", { focus: { x: 0.1, y: 0.3, w: 0.8, h: 0.2 } }),
        sc("device-demo", { assets: [{ kind: "screenshot", assetId: "ast_shot2" }] }),
        sc("device-demo", { onScreenText: "Every receipt, sorted" }),
        sc("phone-tilt", { assets: [{ kind: "screenshot", assetId: "ast_shot2" }] }),
      ]),
      app,
      brand: null,
      assets: all,
    });
    const kinds = doc.scenes.map((s) => s.transitionIn.kind);
    expect(kinds).toEqual(["cut", "zoom", "zoom-through", "match", "whip"]);
    // The matched phone has no entrance of its own: it is moved into place by the cut.
    const matched = doc.scenes[3]!.layers.find((l) => l.type === "device")!;
    expect(matched.animation.enter).toBeUndefined();
    const { html } = compileToHtml(doc, opts);
    expect(html).toContain(`tl.set(q("s-${doc.scenes[1]!.id}"), {transformOrigin:`);
    expect(html).toContain(`tl.fromTo(q("l-${matched.id}-k"), {x:`);
    expect(html).toMatch(new RegExp(`tl\\.fromTo\\(q\\("s-${doc.scenes[4]!.id}"\\), \\{xPercent:100\\}`));
    expect(html).toContain('{filter:"blur(0px)"}');
  });

  it("falls back to a whip when the phones are not in the same place", () => {
    const doc = buildFromStoryboard({ storyboard: sb([sc("device-demo"), sc("feature-callout", { onScreenText: "Scan | Sort | Done", assets: [{ kind: "screenshot", assetId: "ast_shot2" }] })], { aspectRatio: "16:9" }), app, brand: null, assets: all });
    const t = doc.scenes[1]!.transitionIn.kind;
    expect(["match", "whip"]).toContain(t);
    if (t === "whip") expect(doc.scenes[1]!.layers.find((l) => l.type === "device")!.animation.enter).toBeDefined();
  });
});

describe("one colour look", () => {
  it("grades supporting footage with the app's accent (never the app UI) and tints device shadows", () => {
    const doc = buildFromStoryboard({ storyboard: sb([sc("text-over-media", { purpose: "hook", assets: [{ kind: "stock_image", assetId: "ast_stock" }] }), sc("device-demo")]), app, brand: null, assets: all });
    const grade = doc.scenes[0]!.layers.find((l) => l.name === "Colour grade");
    expect(grade).toMatchObject({ type: "shape", blend: "soft-light" });
    expect(doc.scenes[1]!.layers.some((l) => l.name === "Colour grade")).toBe(false);
    const { html } = compileToHtml(doc, opts);
    expect(html).toContain("mix-blend-mode:soft-light");
    // Shadow colour: a deep shade of the accent, not neutral grey.
    expect(html).not.toContain("rgba(15,20,35,.26)");
  });
});
