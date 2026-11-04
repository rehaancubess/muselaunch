import type { App, Layer, RecordingSegment, Storyboard, StoryboardScene } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { buildFromStoryboard, mediaToScreen, regionInCrop, screenToMedia } from "./build";
import { TEMPLATE_CATALOG, TEMPLATE_SHOT } from "./catalog";
import { compileToHtml, deviceGeometry, pathSamples, regionAt } from "./compile";
import { describeForLLM as describeDoc } from "./describe";
import { lintDoc } from "./lint";
import { sampleAsset } from "./test-fixtures";
import { validateDoc } from "./validate";

const now = "2026-11-03T00:00:00.000Z";
const base = { workspaceId: "ws_t", createdAt: now, updatedAt: now, createdBy: "u" };
const app = { ...base, id: "app_1", name: "Ledgerly", platforms: ["ios"], storeUrls: {}, status: "ready", dnaStatus: "confirmed", targetCountries: [], targetLanguages: ["en"] } as unknown as App;

const shot = sampleAsset("ast_dash", { width: 1179, height: 2556, appId: "app_1" });
const recording = sampleAsset("ast_rec", { kind: "video", role: "app_recording", mimeType: "video/mp4", width: 886, height: 1920, durationSec: 40, appId: "app_1" });
const keyframe = sampleAsset("ast_kf", { role: "thumbnail", isProductTruth: false, width: 540, height: 1170, labels: ["recording_keyframe", "recording:ast_rec"], appId: "app_1" });

const segment = (over: Partial<RecordingSegment> = {}): RecordingSegment =>
  ({
    ...base,
    id: "rsg_1",
    appId: "app_1",
    assetId: "ast_rec",
    startSec: 10,
    endSec: 16,
    label: "Opens the revenue dashboard",
    action: "scroll",
    featureIds: [],
    quality: 0.9,
    privacy: { flagged: false, regions: [] },
    keyframeAssetId: "ast_kf",
    keyframeAtSec: 12,
    ...over,
  }) as RecordingSegment;

let order = 0;
const scene = (template: string, over: Partial<StoryboardScene> = {}): StoryboardScene => ({
  id: `s${++order}`,
  order,
  purpose: "feature",
  durationSec: 4,
  onScreenText: "Revenue at a glance",
  narration: "",
  visual: "",
  template,
  assets: [{ kind: "screenshot", assetId: "ast_dash" }],
  claimIds: [],
  ...over,
});
const storyboard = (scenes: StoryboardScene[]): Storyboard =>
  ({ ...base, id: "sbd_1", appId: "app_1", campaignId: "cpg_1", variantId: "var_1", title: "Ledgerly", aspectRatio: "9:16", targetDurationSec: 12, scenes, voiceover: { source: "none" }, music: {} }) as Storyboard;
const opts = { assetUrl: (id: string) => `assets/${id}`, mode: "render" as const, gsapSource: "https://cdn.example/gsap.js" };
const layers = (doc: ReturnType<typeof buildFromStoryboard>) => doc.scenes.flatMap((s) => s.layers);
const device = (l: Layer[]) => l.find((x): x is Extract<Layer, { type: "device" }> => x.type === "device")!;

describe("ui-popout template", () => {
  it("is registered as a close-up product template", () => {
    expect(TEMPLATE_CATALOG["ui-popout"].needs).toContain("screenshot");
    expect(TEMPLATE_SHOT["ui-popout"]).toBe("close");
  });

  it("lifts a crop of the real screenshot off the device, starting exactly over the element", () => {
    const focus = { x: 0.08, y: 0.3, w: 0.84, h: 0.16 };
    const doc = buildFromStoryboard({ storyboard: storyboard([scene("ui-popout", { focus })]), app, brand: null, assets: [shot] });
    expect(doc.scenes[0]!.template).toBe("ui-popout");
    const ls = layers(doc);
    const dev = device(ls);
    const lifted = ls.find((l): l is Extract<Layer, { type: "image" }> => l.type === "image" && !!l.lift)!;
    expect(dev.lift).toBeDefined();
    expect(dev.focus).toBeUndefined(); // the screen stays put so the element lifts from where it is
    expect(lifted.assetId).toBe("ast_dash");
    expect(lifted.box.z).toBeGreaterThan(dev.box.z);
    // `from` = the socket's place on the device screen, in frame fractions.
    const g = deviceGeometry(dev.device, dev.box.w * doc.width, dev.box.h * doc.height);
    const fromX = dev.box.x + (g.screen.left + dev.lift!.x * g.screen.width) / doc.width;
    const fromY = dev.box.y + (g.screen.top + dev.lift!.y * g.screen.height) / doc.height;
    expect(lifted.lift!.from.x).toBeCloseTo(fromX, 3);
    expect(lifted.lift!.from.y).toBeCloseTo(fromY, 3);
    // Bigger than where it starts, same aspect (the crop fills the box without distortion).
    expect(lifted.box.w).toBeGreaterThan(lifted.lift!.from.w * 1.15);
    expect((lifted.box.w * doc.width) / (lifted.box.h * doc.height)).toBeCloseTo((lifted.lift!.from.w * doc.width) / (lifted.lift!.from.h * doc.height), 2);
    // The crop is the visible part of Spark's box on the media.
    expect(lifted.crop!.x).toBeCloseTo(focus.x, 2);
    expect(lifted.crop!.w).toBeCloseTo(focus.w, 2);
    expect(lintDoc(doc, { assets: { ast_dash: shot }, claims: {} }).filter((i) => i.level === "error")).toEqual([]);
    expect(describeDoc(doc)).toContain("lift(from");

    const html = compileToHtml(doc, opts).html;
    const id = `l-${lifted.id}`;
    expect(html).toContain(`id="${id}-lift"`);
    expect(html).toContain(`id="l-${dev.id}-sock"`);
    expect(html).toMatch(new RegExp(`tl\\.set\\(q\\("${id}-k"\\), \\{x:-?[\\d.]+, y:-?[\\d.]+, scale:0\\.[\\d]+\\}`));
    expect(html).toContain(`tl.fromTo(q("${id}-lift"), {rotationX:0, rotationY:0, transformPerspective:1200}`);
    expect(html).toContain(`tl.fromTo(q("l-${dev.id}-z"), {scale:1, filter:"brightness(1) saturate(1)"}`);
    // Still (thumbnail / static ad): the lifted end state, shadow visible, device receded.
    const still = compileToHtml(doc, { ...opts, still: true }).html;
    expect(still).toContain("rotateX(6deg)");
    expect(still).toContain("transform:scale(0.95);filter:brightness(0.86)");
  });

  it("on a walkthrough segment, crops the keyframe and lines the footage up with it at the lift", () => {
    const seg = segment();
    const sb = storyboard([scene("ui-popout", { assets: [{ kind: "app_recording", segmentId: "rsg_1" }], focus: { x: 0.1, y: 0.4, w: 0.8, h: 0.12 } })]);
    const doc = buildFromStoryboard({ storyboard: sb, app, brand: null, assets: [recording, keyframe], recordingSegments: [seg] });
    const ls = layers(doc);
    const dev = device(ls);
    const lifted = ls.find((l): l is Extract<Layer, { type: "image" }> => l.type === "image" && !!l.lift)!;
    expect(dev.screenKind).toBe("video");
    expect(lifted.assetId).toBe("ast_kf");
    // At the lift, the recording shows the keyframe's moment (played at 1×).
    expect(dev.trimInSec + lifted.lift!.atSec).toBeCloseTo(12, 3);
    expect(dev.playbackRate).toBeUndefined();
  });

  it("falls back to a focus zoom without a focus box", () => {
    const doc = buildFromStoryboard({ storyboard: storyboard([scene("ui-popout")]), app, brand: null, assets: [shot] });
    expect(doc.scenes[0]!.template).toBe("focus-zoom");
    expect(layers(doc).some((l) => l.type === "image" && l.lift)).toBe(false);
  });

  it("keeps private details inside the element blurred on the lifted copy", () => {
    const secret = { ...shot, privacy: { flagged: true, notes: "Stripe secret key", regions: [{ x: 0.2, y: 0.33, w: 0.5, h: 0.04 }] } };
    const doc = buildFromStoryboard({ storyboard: storyboard([scene("ui-popout", { focus: { x: 0.08, y: 0.3, w: 0.84, h: 0.16 } })]), app, brand: null, assets: [secret] });
    const ls = layers(doc);
    const lifted = ls.find((l): l is Extract<Layer, { type: "image" }> => l.type === "image" && !!l.lift)!;
    expect(lifted.blurRegions).toHaveLength(1);
    expect(lifted.blurRegions![0]!.y).toBeGreaterThan(0.1);
    expect(device(ls).blurRegions).toHaveLength(1); // and on the screen behind it
  });
});

describe("privacy blur on real media", () => {
  it("blurs a screenshot's flagged regions in device frames and full-screen showcases", () => {
    const secret = { ...shot, privacy: { flagged: true, notes: "API key", regions: [{ x: 0.1, y: 0.5, w: 0.6, h: 0.05 }] } };
    const doc = buildFromStoryboard({ storyboard: storyboard([scene("device-demo"), scene("fullscreen-showcase")]), app, brand: null, assets: [secret] });
    const dev = device(doc.scenes[0]!.layers);
    expect(dev.blurRegions).toHaveLength(1);
    const img = doc.scenes[1]!.layers.find((l): l is Extract<Layer, { type: "image" }> => l.type === "image")!;
    expect(img.blurRegions).toHaveLength(1);
    const html = compileToHtml(doc, opts).html;
    expect(html).toContain(`id="l-${dev.id}-pv0"`);
    expect(html).toContain(`id="l-${img.id}-pv0"`);
  });

  it("moves a segment's blur along its SAM path, timed against the footage", () => {
    const path = [
      { t: 10, x: 0.1, y: 0.6, w: 0.5, h: 0.05 },
      { t: 12, x: 0.1, y: 0.4, w: 0.5, h: 0.05 },
      { t: 14, x: 0.1, y: 0.2, w: 0.5, h: 0.05 },
    ];
    const seg = segment({ privacy: { flagged: true, notes: "Customer email", regions: [{ x: 0.1, y: 0.4, w: 0.5, h: 0.05, path }] } });
    const sb = storyboard([scene("device-demo", { assets: [{ kind: "app_recording", segmentId: "rsg_1" }] })]);
    const doc = buildFromStoryboard({ storyboard: sb, app, brand: null, assets: [recording], recordingSegments: [seg] });
    const dev = device(layers(doc));
    expect(dev.blurRegions![0]!.path).toHaveLength(3);
    // Mapped into screen fractions like the static region.
    const g = deviceGeometry(dev.device, dev.box.w * doc.width, dev.box.h * doc.height);
    const exp = mediaToScreen(path[2]!, 886 / 1920, g.screen.width / g.screen.height);
    expect(dev.blurRegions![0]!.path![2]!.y).toBeCloseTo(exp.y, 3);
    expect(validateDoc(doc).ok).toBe(true);
    const html = compileToHtml(doc, opts).html;
    expect(html).toMatch(new RegExp(`tl\\.fromTo\\(q\\("l-${dev.id}-pv0"\\), \\{"left":[\\d.]+,"top":[\\d.]+`));
    expect(describeDoc(doc)).toContain("privacy-blur=1 (tracked)");
  });

  it("interpolates and holds tracked regions, and samples them on the composition clock", () => {
    const path = [
      { t: 2, x: 0, y: 0.2, w: 0.1, h: 0.1 },
      { t: 4, x: 0, y: 0.6, w: 0.1, h: 0.1 },
    ];
    expect(regionAt(path, 3).y).toBeCloseTo(0.4, 5);
    expect(regionAt(path, 0).y).toBe(0.2);
    expect(regionAt(path, 9).y).toBe(0.6);
    // A layer at composition 10–14 s playing the media from 2 s at 2× reaches media 4 s at 11 s.
    const s = pathSamples(path, { start: 10, end: 14 }, { trimIn: 2, rate: 2 });
    expect(s[0]).toMatchObject({ tc: 10 });
    expect(s.find((x) => Math.abs(x.tc - 11) < 1e-6)?.r.y).toBe(0.6);
    expect(s[s.length - 1]).toMatchObject({ tc: 14 });
  });
});

describe("focus zoom that follows the element", () => {
  it("carries SAM's path into the device focus and follows it after the push-in", () => {
    const focusPath = [
      { t: 10, x: 0.1, y: 0.55, w: 0.8, h: 0.1 },
      { t: 13, x: 0.1, y: 0.35, w: 0.8, h: 0.1 },
      { t: 16, x: 0.1, y: 0.25, w: 0.8, h: 0.1 },
    ];
    const sb = storyboard([scene("focus-zoom", { assets: [{ kind: "app_recording", segmentId: "rsg_1" }], focus: { x: 0.1, y: 0.4, w: 0.8, h: 0.1 }, focusPath, durationSec: 5 })]);
    const doc = buildFromStoryboard({ storyboard: sb, app, brand: null, assets: [recording], recordingSegments: [segment()] });
    const dev = device(layers(doc));
    expect(dev.focus?.path).toHaveLength(3);
    expect(dev.focus?.ring).toBe(true);
    const html = compileToHtml(doc, opts).html;
    const z = `q("l-${dev.id}-z")`;
    // Push-in, then follow tweens on the zoom wrapper (x/y only) and the ring.
    expect(html).toContain(`tl.fromTo(${z}, {x:0, y:0, scale:1}`);
    expect(html.split(`tl.fromTo(${z}, {x:`).length).toBeGreaterThan(3);
    expect(html).toMatch(new RegExp(`tl\\.fromTo\\(q\\("l-${dev.id}-ring"\\), \\{"left":`));
    expect(describeDoc(doc)).toContain("follows-element");
  });

  it("keeps the fixed close-up on screenshots (no path to follow)", () => {
    const doc = buildFromStoryboard({ storyboard: storyboard([scene("focus-zoom", { focus: { x: 0.1, y: 0.4, w: 0.8, h: 0.1 } })]), app, brand: null, assets: [shot] });
    expect(device(layers(doc)).focus?.path).toBeUndefined();
  });
});

describe("region mapping helpers", () => {
  it("screenToMedia inverts mediaToScreen", () => {
    const r = { x: 0.1, y: 0.3, w: 0.5, h: 0.2 };
    for (const [ma, sa, align] of [[0.46, 0.46, "top"], [0.4, 0.46, "top"], [0.5, 0.46, "top"], [1.6, 1.78, "center"]] as const) {
      const back = screenToMedia(mediaToScreen(r, ma, sa, align), ma, sa, align);
      expect(back.x).toBeCloseTo(r.x, 3);
      expect(back.y).toBeCloseTo(r.y, 3);
    }
  });

  it("regionInCrop re-expresses a region inside a crop (null outside)", () => {
    expect(regionInCrop({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, { x: 0, y: 0, w: 0.5, h: 0.5 })).toEqual({ x: 0.4, y: 0.4, w: 0.4, h: 0.4 });
    expect(regionInCrop({ x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, { x: 0, y: 0, w: 0.5, h: 0.5 })).toBeNull();
  });
});
