import type { ClipAnalysis, MediaAsset, Segmentation, Storyboard, TracksFile } from "@muselaunch/contracts";
import { CompositionDoc } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { buildFromStoryboard } from "./build";
import { compileToHtml } from "./compile";
import { describeForLLM } from "./describe";
import { lintDoc } from "./lint";
import { ensureNodeCompileRuntime } from "./node";
import { clipMapping, sampleTrack, trackUsable } from "./objects";
import { applyPatch } from "./patch";
import { sampleAsset, sampleDoc } from "./test-fixtures";
import { validateDoc } from "./validate";

ensureNodeCompileRuntime();
const now = new Date().toISOString();
const base = { workspaceId: "ws_t", createdAt: now, updatedAt: now, createdBy: "u" };

/** Phone moving left→right across a 720x1280 clip over 2 s at 30 fps. */
function tracks(objectLabel: string, visible = (i: number) => true): TracksFile {
  const frames = Array.from({ length: 60 }, (_, i) => ({ t: i / 30, visible: visible(i), bbox: visible(i) ? { x: 0.2 + i * 0.005, y: 0.5, w: 0.2, h: 0.3 } : undefined, centroid: visible(i) ? { x: 0.3 + i * 0.005, y: 0.65 } : undefined }));
  return { fps: 30, frameCount: 60, width: 720, height: 1280, tracks: [{ objectId: "0", label: objectLabel, frames }] };
}
const seg = (id: string, over: Partial<Segmentation> = {}) => ({ ...base, id, sourceAssetId: "ast_clip", prompt: "phone", status: "succeeded", mediaType: "video", objects: [], cutoutAssetId: `${id}_cut`, tracksAssetId: `${id}_tr`, objectOutputs: { "0": { cutoutAssetId: `${id}_obj` } }, trackingQuality: 0.95, corrections: [], usageEventIds: [], model: "sam-3.1", ...over }) as Segmentation;

function clipDoc(extra: unknown[]) {
  const raw = {
    schemaVersion: 1,
    title: "Clip",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#5E5CE6" },
    scenes: [{ id: "sc_1", name: "Demo", template: "object-spotlight", durationSec: 2, layers: [{ id: "ly_clip", type: "video", assetId: "ast_clip", box: { x: 0, y: 0, w: 1, h: 1 } }, ...extra] }],
  };
  const v = validateDoc(raw);
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.doc;
}
const opts = (segs: Record<string, Segmentation>, tr: Record<string, TracksFile>) => ({ assetUrl: (id: string) => `a/${id}`, mode: "render" as const, gsapSource: "inline", segmentations: segs, tracks: tr, assetKinds: { ast_clip: "video", ast_rec: "video" } });

describe("object tracks", () => {
  it("maps source coordinates through the clip layer's cover fit", () => {
    const doc = clipDoc([]);
    const m = clipMapping(doc.scenes[0]!, seg("seg_p"), tracks("phone"), 1080, 1920);
    expect([m.x, m.y, m.w, m.h]).toEqual([0, 0, 1080, 1920]); // 720x1280 → exactly 1.5x
    const s = sampleTrack(tracks("phone").tracks[0]!, 30, m, 0, { start: 0, end: 1 }, 0);
    expect(s[0]).toMatchObject({ visible: true, x: 216, w: 216 });
    expect(s.at(-1)!.x).toBeCloseTo(216 + 30 * 0.005 * 1080, 0);
  });

  it("refuses unreliable tracks", () => {
    expect(trackUsable(seg("s"), tracks("phone", (i) => i % 3 === 0), "0").ok).toBe(false);
    expect(trackUsable(seg("s", { status: "running" }), tracks("phone"), "0").reason).toMatch(/running/);
    expect(trackUsable(seg("s"), tracks("phone"), "9").reason).toMatch(/not in the tracks/);
  });
});

describe("compile: anchors and effects", () => {
  const segs = { seg_p: seg("seg_p") };
  const tr = { seg_p: tracks("phone") };

  it("drives an anchored layer from the track, and leaves it static without one", () => {
    const chip = { id: "ly_chip", type: "block", blockId: "callout-chip", params: { text: "Search" }, box: { x: 0.3, y: 0.3, w: 0.3, h: 0.04 }, anchor: { segmentationId: "seg_p", objectId: "0", point: "top", offset: { x: 0, y: -0.03 } } };
    const doc = clipDoc([chip]);
    const { html } = compileToHtml(doc, opts(segs, tr));
    const tweens = html.match(/tl\.fromTo\(q\("l-ly_chip-k"\)/g) ?? [];
    expect(tweens.length).toBeGreaterThan(20);
    const none = compileToHtml(doc, opts(segs, {})).html;
    expect(none).not.toContain('q("l-ly_chip-k")');
    expect(lintDoc(doc, { assets: { ast_clip: sampleAsset("ast_clip", { kind: "video", role: "founder_clip", isProductTruth: false }) }, segmentations: segs, tracks: {} }).some((i) => i.layerId === "ly_chip" && /fixed position/.test(i.message))).toBe(true);
  });

  it("renders each effect from the track / per-object cutout, and skips it when tracking is unusable", () => {
    const fx = (effect: string, extra = {}) => ({ id: `ly_${effect.replace("-", "_")}`, type: "effect", effect, target: { segmentationId: "seg_p", objectId: "0" }, box: { x: 0, y: 0, w: 1, h: 1, z: 3 }, ...extra });
    const doc = clipDoc([fx("spotlight"), fx("highlight-ring"), fx("follow-arrow"), fx("outline-glow"), fx("focus-blur"), fx("screen-insert", { assetId: "ast_rec" })]);
    const { html, assetIds } = compileToHtml(doc, opts(segs, tr));
    expect(html).toContain("radial-gradient(ellipse var(--rx) var(--ry) at var(--x) var(--y)");
    expect(html).toMatch(/tl\.fromTo\(q\("l-ly_spotlight-spot"\), \{"--x":"[\d.]+px"/);
    expect(html).toContain('id="l-ly_highlight_ring-ring"');
    expect(html).toContain('id="l-ly_follow_arrow-arrow"');
    expect(html).toMatch(/<video id="ef-ly_outline_glow-cut"[^>]*src="a\/seg_p_obj"/); // per-object cutout wins
    expect(html).toMatch(/<video id="ef-ly_focus_blur-bg"[^>]*src="a\/ast_clip"/);
    expect(html).toMatch(/<video id="ef-ly_screen_insert-scr"[^>]*src="a\/ast_rec"/);
    expect(assetIds).toEqual(expect.arrayContaining(["ast_clip", "ast_rec", "seg_p_obj"]));
    const low = compileToHtml(doc, opts({ seg_p: seg("seg_p", { trackingQuality: 0.2 }) }, { seg_p: tracks("phone", (i) => i % 4 === 0) })).html;
    for (const id of ["l-ly_spotlight", "l-ly_highlight_ring", "l-ly_follow_arrow", "l-ly_outline_glow", "l-ly_focus_blur", "l-ly_screen_insert"]) expect(low).not.toContain(`id="${id}"`);
  });

  it("validates screen inserts and object ids", () => {
    expect(validateDoc({ ...clipDoc([]), scenes: [{ ...clipDoc([]).scenes[0]!, layers: [{ id: "x", type: "effect", effect: "screen-insert", target: { segmentationId: "seg_p", objectId: "0" }, box: { x: 0, y: 0, w: 1, h: 1 } }] }] }).ok).toBe(false);
    expect(CompositionDoc.safeParse({ ...clipDoc([]), scenes: [{ ...clipDoc([]).scenes[0]!, layers: [{ id: "x", type: "effect", effect: "spotlight", target: { segmentationId: "seg_p", objectId: '0");alert(1)//' }, box: { x: 0, y: 0, w: 1, h: 1 } }] }] }).success).toBe(false);
    const doc = clipDoc([{ id: "ly_ins", type: "effect", effect: "screen-insert", assetId: "ast_gen", target: { segmentationId: "seg_p", objectId: "0" }, box: { x: 0, y: 0, w: 1, h: 1 } }]);
    const issues = lintDoc(doc, { assets: { ast_clip: sampleAsset("ast_clip", { kind: "video" }), ast_gen: sampleAsset("ast_gen", { origin: "generated", role: "generated_image", isProductTruth: false }) }, segmentations: segs, tracks: tr });
    expect(issues.some((i) => i.level === "error" && /real screenshots or recordings/.test(i.message))).toBe(true);
  });
});

describe("object-aware templates", () => {
  const app = { ...base, id: "app_1", name: "Focusly", platforms: ["ios"], storeUrls: {}, status: "ready", dnaStatus: "confirmed", targetCountries: [], targetLanguages: ["en"] } as never;
  const assets: MediaAsset[] = [
    sampleAsset("ast_clip", { kind: "video", role: "founder_clip", isProductTruth: false, width: 720, height: 1280, durationSec: 6 }),
    sampleAsset("ast_rec", { kind: "video", role: "app_recording", isProductTruth: true, width: 590, height: 1278, durationSec: 6 }),
  ];
  const segs = [seg("seg_person", { prompt: "person" }), seg("seg_phone", { prompt: "phone" })];
  const analysis = { ...base, id: "cla_1", sourceAssetId: "ast_clip", status: "succeeded", prompts: ["person", "phone"], segmentationIds: { person: "seg_person", phone: "seg_phone" }, objects: [
    { key: "person", label: "person", segmentationId: "seg_person", objectId: "0", trackingQuality: 0.95, presence: [{ startSec: 0, endSec: 6 }], meanBbox: { x: 0.15, y: 0.2, w: 0.55, h: 0.8 } },
    { key: "phone", label: "phone", segmentationId: "seg_phone", objectId: "0", trackingQuality: 0.95, presence: [{ startSec: 0, endSec: 6 }], meanBbox: { x: 0.62, y: 0.47, w: 0.23, h: 0.27 } },
  ] } as ClipAnalysis;
  const sb = { ...base, id: "sbd_1", appId: "app_1", campaignId: "c", variantId: "v", title: "Founder", aspectRatio: "9:16", targetDurationSec: 9, voiceover: { source: "none" }, music: {}, scenes: [
    { id: "a", order: 0, purpose: "hook", durationSec: 3, onScreenText: "I built this", narration: "", visual: "", template: "presenter-depth", assets: [{ kind: "founder_clip", assetId: "ast_clip" }, { kind: "app_recording", assetId: "ast_rec" }], claimIds: [] },
    { id: "b", order: 1, purpose: "demo", durationSec: 3, onScreenText: "In your hand | Focus blocks", narration: "", visual: "", template: "product-in-hand", assets: [{ kind: "founder_clip", assetId: "ast_clip" }, { kind: "app_recording", assetId: "ast_rec" }], claimIds: [] },
    { id: "c", order: 2, purpose: "feature", durationSec: 3, onScreenText: "One tap | Search", narration: "", visual: "", template: "object-spotlight", assets: [{ kind: "founder_clip", assetId: "ast_clip" }], claimIds: [] },
  ] } as unknown as Storyboard;

  it("builds the depth sandwich, screen insert and spotlight from a clip analysis", () => {
    const doc = buildFromStoryboard({ storyboard: sb, app, brand: null, assets, segmentations: segs, clipAnalyses: [analysis] });
    const [d, h, sp] = doc.scenes;
    expect(doc.scenes.map((s) => s.template)).toEqual(["presenter-depth", "product-in-hand", "object-spotlight"]);
    const z = (l: { box: { z: number } } | undefined) => l!.box.z;
    const clip = d!.layers.find((l) => l.id === "sc_a_clip");
    const device = d!.layers.find((l) => l.type === "device");
    const presenter = d!.layers.find((l) => l.id === "sc_a_presenter");
    expect(presenter?.type === "video" && presenter.mask).toMatchObject({ segmentationId: "seg_person", fallback: "hide" });
    expect(z(clip)).toBeLessThan(z(device));
    expect(z(device)).toBeLessThan(z(presenter));
    expect(d!.layers.find((l) => l.id === "sc_a_phone")).toBeTruthy();
    const ins = h!.layers.find((l) => l.type === "effect");
    expect(ins?.type === "effect" && [ins.effect, ins.assetId]).toEqual(["screen-insert", "ast_rec"]);
    expect(h!.layers.find((l) => l.id === "sc_b_chip1")?.anchor).toMatchObject({ segmentationId: "seg_phone" });
    expect(sp!.layers.filter((l) => l.type === "effect").map((l) => (l.type === "effect" ? l.effect : ""))).toEqual(["spotlight", "highlight-ring"]);
    // the presenter clip keeps playing across scenes
    expect(h!.layers.find((l) => l.id === "sc_b_clip")).toMatchObject({ trimInSec: 3 });
    expect(lintDoc(doc, { assets: Object.fromEntries(assets.map((a) => [a.id, a])) }).filter((i) => i.level === "error")).toEqual([]);
    const text = describeForLLM(doc, { clipAnalyses: [analysis] });
    expect(text).toContain("Clip objects:");
    expect(text).toContain("segmentationId=seg_phone objectId=0");
    expect(text).toContain("screen-insert");
    expect(text).toContain("anchor[follows seg_phone/0");
  });

  it("falls back honestly without a clip analysis", () => {
    const doc = buildFromStoryboard({ storyboard: sb, app, brand: null, assets, segmentations: [] });
    expect(doc.scenes.map((s) => s.template)).toEqual(["founder-cutout", "founder-cutout", "founder-cutout"]);
    expect(doc.scenes.flatMap((s) => s.layers).some((l) => l.type === "effect")).toBe(false);
  });

  it("carries anchors through patches", () => {
    const doc = sampleDoc();
    const r = applyPatch(doc, [{ op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_head", set: { anchor: { segmentationId: "seg_p", objectId: "0", point: "top" } } }]);
    const l = r.doc.scenes[1]!.layers.find((x) => x.id === "ly_demo_head");
    expect(l?.anchor).toMatchObject({ point: "top", whenLost: "hide", smoothFrames: 5 });
    const back = applyPatch(r.doc, r.inverse).doc;
    expect(back.scenes[1]!.layers.find((x) => x.id === "ly_demo_head")?.anchor).toBeUndefined();
  });
});
