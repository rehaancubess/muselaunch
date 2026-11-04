/**
 * Video quality rules from the PocketPlay run (a TV app's landscape footage in 9:16 videos):
 * the first frame shows the hook, close-ups of wide screens stay a big slice of the screen,
 * landscape footage can fill the frame (never stretched), and phone apps are unchanged.
 */
import type { App, Layer, MediaAsset, RecordingSegment, Storyboard, StoryboardScene, TemplateId } from "@muselaunch/contracts";
import { TEMPLATE_IDS } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { _test, buildFromStoryboard } from "./build";
import { compileToHtml, deviceGeometry } from "./compile";
import { lintDoc } from "./lint";
import { ensureNodeCompileRuntime } from "./node";
import { opensOnFirstFrame } from "./opening";
import { posterTimeSec } from "./poster";
import { sampleAsset } from "./test-fixtures";
import { validateDoc } from "./validate";

const now = "2026-11-02T00:00:00.000Z";
const base = { workspaceId: "ws_t", createdAt: now, updatedAt: now, createdBy: "u" };
const appWith = (platforms: string[]) => ({ ...base, id: "app_pp", name: "PocketPlay", platforms, storeUrls: {}, status: "ready", dnaStatus: "confirmed", targetCountries: [], targetLanguages: ["en"], iconAssetId: "ast_icon" }) as unknown as App;
const tvApp = appWith(["web", "tv"]);
const phoneApp = appWith(["ios", "android"]);

const assets: MediaAsset[] = [
  sampleAsset("ast_tvrec", { kind: "video", role: "app_recording", mimeType: "video/mp4", width: 1920, height: 1206, durationSec: 120 }),
  sampleAsset("ast_tvshot", { width: 1920, height: 1206 }),
  sampleAsset("ast_phone", { width: 1179, height: 2556 }),
  sampleAsset("ast_phonerec", { kind: "video", role: "app_recording", mimeType: "video/mp4", width: 886, height: 1920, durationSec: 60 }),
  sampleAsset("ast_icon", { role: "icon", isProductTruth: false, width: 1024, height: 1024 }),
  sampleAsset("ast_stock", { role: "stock_image", origin: "stock", isProductTruth: false, width: 1080, height: 1350 }),
];
const segs = [
  { ...base, id: "rsg_race", appId: "app_pp", assetId: "ast_tvrec", startSec: 20, endSec: 26, label: "Two players race", action: "other", featureIds: [], quality: 0.9, privacy: { flagged: true, regions: [{ x: 0.7, y: 0.05, w: 0.25, h: 0.08 }] } },
  { ...base, id: "rsg_lobby", appId: "app_pp", assetId: "ast_tvrec", startSec: 0, endSec: 6, label: "Lobby with the join code", action: "navigate", featureIds: [], quality: 0.8, privacy: { flagged: false, regions: [] } },
] as RecordingSegment[];

let order = 0;
const scene = (template: string, over: Partial<StoryboardScene> = {}): StoryboardScene => ({ id: `q${++order}`, order, purpose: "demo", durationSec: 3, onScreenText: "Everyone scans one code", narration: "", visual: "", template, assets: [], claimIds: [], ...over });
const storyboard = (scenes: StoryboardScene[], aspectRatio = "9:16"): Storyboard => ({ ...base, id: "sbd_q", appId: "app_pp", campaignId: "cpg_1", variantId: "var_1", title: "PocketPlay", aspectRatio, targetDurationSec: scenes.reduce((n, s) => n + s.durationSec, 0), scenes, voiceover: { source: "none" }, music: {} }) as Storyboard;
const devices = (l: Layer[]) => l.filter((x): x is Extract<Layer, { type: "device" }> => x.type === "device");

/** Media hints that let every template build its real layout as scene 1. */
function hintsFor(t: TemplateId): StoryboardScene["assets"] {
  if (t === "text-over-media" || t === "hook-title") return [{ kind: "stock_image", assetId: "ast_stock", query: "friends on a couch" }];
  if (t === "fullscreen-recording" || t === "focus-zoom" || t === "tap-demo" || t === "phone-tilt" || t === "device-demo") return [{ kind: "app_recording", assetId: "ast_tvrec", segmentId: "rsg_race" }];
  if (t === "before-after" || t === "split-screen") return [{ kind: "screenshot", assetId: "ast_tvshot" }, { kind: "screenshot", assetId: "ast_phone" }];
  return [{ kind: "screenshot", assetId: "ast_tvshot" }];
}

/** Timeline statements (one per line) of a compiled page. */
const timeline = (html: string) => html.slice(html.lastIndexOf("<script>")).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("tl."));

describe("the first frame shows the hook (it is the thumbnail on Reels, Shorts and TikTok)", () => {
  ensureNodeCompileRuntime();

  it("every template as scene 1: layers starting with the scene are visible at t=0, their entrance only settles them", () => {
    for (const t of TEMPLATE_IDS) {
      const sb = storyboard([scene(t, { purpose: t === "store-cta" || t === "cta-endcard" ? "cta" : "hook", assets: hintsFor(t), focus: { x: 0.3, y: 0.3, w: 0.3, h: 0.3 } }), scene("device-demo", { onScreenText: "Then the app", assets: [{ kind: "screenshot", assetId: "ast_phone" }] })]);
      const doc = buildFromStoryboard({ storyboard: sb, app: tvApp, brand: null, assets, recordingSegments: segs });
      const s0 = doc.scenes[0]!;
      const { html } = compileToHtml(doc, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "inline", assetKinds: { ast_tvrec: "video", ast_phonerec: "video" } });
      const lines = timeline(html);
      const opening = s0.layers.filter((l) => opensOnFirstFrame(0, l));
      expect(opening.length, t).toBeGreaterThan(0);
      // Scene 1 has a visible headline / visual at t=0: something other than background glows.
      expect(opening.some((l) => l.type !== "shape"), t).toBe(true);
      if (["hook-title", "kinetic-type", "text-over-media", "device-demo", "phone-tilt", "focus-zoom", "fullscreen-recording", "feature-callout"].includes(s0.template)) {
        expect(opening.some((l) => l.type === "text" && (l.role === "headline" || l.role === "label")), t).toBe(true);
      }
      for (const l of opening) {
        const id = `l-${l.id}`;
        // The element is in the page from t=0 and its own style is not invisible.
        const tag = new RegExp(`<div id="${id}" class="layer clip[^"]*" data-start="0" [^>]*style="([^"]*)"`).exec(html);
        expect(tag, `${t}: ${l.id}`).not.toBeNull();
        expect(tag![1]).not.toMatch(/opacity:0(;|$)/);
        // No tween starts it from invisible: no opacity 0, mask, blur or word-by-word reveal.
        for (const line of lines.filter((x) => x.includes(`q("${id}-e")`) || x.includes(`qa("${id}"`))) {
          const from = line.slice(line.indexOf("{"), line.indexOf("}") + 1);
          expect(from, `${t}: ${line}`).not.toMatch(/opacity:0\b|clipPath|blur\(|yPercent/);
          expect(line, `${t}: ${line}`).not.toMatch(/qa\(/);
        }
      }
      // Scene 1 itself never transitions in.
      // (Its exit into scene 2 may fade or zoom it out: only the starting state is checked.)
      const fromOf = (x: string) => x.slice(x.indexOf(`q("s-${s0.id}"), {`) + `q("s-${s0.id}"), `.length).split("}")[0]!;
      expect(lines.some((x) => x.includes(`q("s-${s0.id}"), {`) && /opacity:0|xPercent:100|yPercent:100|clipPath/.test(fromOf(x)))).toBe(false);
      // The poster frame still parks once the hook has settled.
      expect(posterTimeSec(doc)).toBeLessThan(s0.durationSec);
    }
  });

  it("scene 1 settles in place while later scenes keep their entrances", () => {
    const sb = storyboard([scene("hook-title", { purpose: "hook", onScreenText: "Everyone scans one code" }), scene("kinetic-type", { purpose: "problem", onScreenText: "No controllers to buy" })]);
    const doc = buildFromStoryboard({ storyboard: sb, app: tvApp, brand: null, assets, recordingSegments: segs });
    const { html } = compileToHtml(doc, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "inline" });
    const lines = timeline(html);
    const head = doc.scenes[0]!.layers.find((l) => l.id.endsWith("_headline"))!;
    expect(head.animation.enter?.preset).toBe("mask-reveal"); // the doc keeps its entrance (editable)…
    expect(lines.find((x) => x.includes(`q("l-${head.id}-e")`))).toMatch(/\{scale:1\.045, y:[\d.]+\}, \{scale:1, y:0, duration:0\.9, ease:"power3\.out"\}, 0\.1\);/); // …compiled as a settle from frame 0
    const line2 = doc.scenes[1]!.layers.find((l) => l.type === "text")!;
    expect(lines.some((x) => x.includes(`qa("l-${line2.id}", ".wi"), {yPercent:70, opacity:0`))).toBe(true); // scene 2: word by word
    // A scene that becomes scene 1 after an edit opens visible too (the rule is the scene's position).
    const swapped = { ...doc, scenes: [doc.scenes[1]!, doc.scenes[0]!] };
    const again = timeline(compileToHtml(swapped, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "inline" }).html);
    expect(again.some((x) => x.includes(`qa("l-${line2.id}"`))).toBe(true); // its later lines still wait their turn…
    const first = doc.scenes[1]!.layers.filter((l) => l.type === "text" && l.timing.start === 0);
    for (const l of first) expect(again.some((x) => x.includes(`qa("l-${l.id}"`))).toBe(false); // …its first line is on screen at once
  });
});

describe("close-ups of wide screens (the PocketPlay 'mostly empty dark space' shot)", () => {
  ensureNodeCompileRuntime();
  const zoomOf = (html: string, id: string) => Number(/scale:([\d.]+), duration/.exec(timeline(html).find((x) => x.includes(`q("l-${id}-z")`))!)![1]);

  it("a TV push-in stays a big slice of the screen and keeps covering the frame's width; phones are unchanged", () => {
    // Spark's small box around the join code, as in the run (≈ 22% × 32% of the frame).
    const focus = { x: 0.72, y: 0.08, w: 0.22, h: 0.3 };
    const build = (app: App, hint: StoryboardScene["assets"]) => buildFromStoryboard({ storyboard: storyboard([scene("hook-title", { purpose: "hook" }), scene("focus-zoom", { assets: hint, focus })]), app, brand: null, assets, recordingSegments: segs });
    const tv = build(tvApp, [{ kind: "app_recording", assetId: "ast_tvrec", segmentId: "rsg_lobby" }]);
    const dev = devices(tv.scenes[1]!.layers)[0]!;
    expect(dev.device).toBe("tv");
    const g = deviceGeometry("tv", dev.box.w * 1080, dev.box.h * 1920);
    const html = compileToHtml(tv, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "inline", assetKinds: { ast_tvrec: "video" } }).html;
    const S = zoomOf(html, dev.id);
    expect(S).toBeGreaterThan(1.5);
    expect(S * g.screen.width).toBeLessThanOrEqual(1.75 * 1080 + 1); // was 3.2× (≈ 2.7 frame widths)
    // The zoomed screen covers the frame horizontally: no empty strip beside it.
    const m = /\{x:([-\d.]+), y:[-\d.]+, scale:[\d.]+/.exec(timeline(html).find((x) => x.includes(`q("l-${dev.id}-z")`))!)!;
    const dx = Number(m[1]);
    const left = dev.box.x * 1080;
    const ox = g.screen.left + (dev.focus!.x + dev.focus!.w / 2) * g.screen.width;
    const edgeL = left + ox + S * (g.screen.left - ox) + dx;
    const edgeR = left + ox + S * (g.screen.left + g.screen.width - ox) + dx;
    expect(edgeL).toBeLessThanOrEqual(0.5);
    expect(edgeR).toBeGreaterThanOrEqual(1079.5);
    // Moving footage on a TV: no fixed ring (it would soon frame an empty patch); a still keeps it.
    expect(dev.focus!.ring).toBe(false);
    expect(devices(build(tvApp, [{ kind: "screenshot", assetId: "ast_tvshot" }]).scenes[1]!.layers)[0]!.focus!.ring).toBe(true);
    // Phone recordings keep the strong push-in and the ring.
    const phone = build(phoneApp, [{ kind: "app_recording", assetId: "ast_phonerec" }]);
    const pd = devices(phone.scenes[1]!.layers)[0]!;
    expect(pd.focus!.ring).toBe(true);
    const pg = deviceGeometry(pd.device, pd.box.w * 1080, pd.box.h * 1920);
    const auto = Math.max(1.2, Math.min(3.2, (0.78 * 1080) / (pd.focus!.w * pg.screen.width), (0.42 * 1920) / (pd.focus!.h * pg.screen.height)));
    expect(zoomOf(compileToHtml(phone, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "inline", assetKinds: { ast_phonerec: "video" } }).html, pd.id)).toBeCloseTo(auto, 2);
  });
});

describe("landscape footage full screen (fullscreen-recording)", () => {
  ensureNodeCompileRuntime();

  it("fills the frame with the footage cover-cropped around the action, never stretched, headline on a scrim", () => {
    const focus = { x: 0.05, y: 0.4, w: 0.2, h: 0.3 }; // action on the left of the TV picture
    const sb = storyboard([scene("hook-title", { purpose: "hook" }), scene("fullscreen-recording", { onScreenText: "Race your friends", assets: [{ kind: "app_recording", assetId: "ast_tvrec", segmentId: "rsg_race" }], focus })]);
    for (const ar of ["9:16", "1:1", "4:5", "16:9"] as const) {
      const doc = buildFromStoryboard({ storyboard: sb, app: tvApp, brand: null, assets, recordingSegments: segs, aspectRatio: ar });
      expect(validateDoc(doc).ok).toBe(true);
      expect(lintDoc(doc, { assets: Object.fromEntries(assets.map((a) => [a.id, a])) }).filter((i) => i.level === "error")).toEqual([]);
      const s = doc.scenes[1]!;
      expect(s.template).toBe("fullscreen-recording");
      expect(devices(s.layers)).toHaveLength(0);
      const media = s.layers.find((l) => l.type === "video") as Extract<Layer, { type: "video" }>;
      expect(media).toMatchObject({ assetId: "ast_tvrec", fit: "cover", trimInSec: 20, trimOutSec: 26, muted: true, box: { x: 0, y: 0, w: 1, h: 1 } });
      expect(s.layers.find((l) => l.id.endsWith("_scrim"))).toBeTruthy();
      expect(s.layers.find((l) => l.id.endsWith("_headline"))).toMatchObject({ type: "text", style: { color: "#FFFFFF" } });
      if (ar !== "16:9") {
        // Cropped toward the action: the left edge of the picture (clamped to the edge), not the centre.
        expect(media.objectPosition!.x).toBeLessThan(0.1);
        // The flagged region (top right of the picture) is outside the crop: nothing to blur.
        expect(media.blurRegions ?? []).toHaveLength(0);
      }
    }
    const doc = buildFromStoryboard({ storyboard: sb, app: tvApp, brand: null, assets, recordingSegments: segs });
    const { html } = compileToHtml(doc, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "inline", assetKinds: { ast_tvrec: "video" } });
    expect(html).toMatch(/<video id="v-sc_q\d+_media" class="media" style="object-fit:cover;object-position:[\d.]+% 50%"/);
    expect(html).not.toMatch(/object-fit:fill/);
    expect(doc.scenes[1]!.transitionIn.kind).toBe("zoom");
  });

  it("cover crop keeps the media's aspect and centres the action as far as the edges allow", () => {
    const k = (9 / 16) / (1920 / 1206);
    const mid = _test.coverCrop(1920 / 1206, 9 / 16, { x: 0.5, y: 0.5 });
    expect(mid.visible.w).toBeCloseTo(k, 3);
    expect(mid.visible.h).toBe(1);
    expect(mid.position).toEqual({ x: 0.5, y: 0.5 });
    const right = _test.coverCrop(1920 / 1206, 9 / 16, { x: 0.7, y: 0.5 });
    expect(right.visible.x + right.visible.w / 2).toBeCloseTo(0.7, 3);
    const edge = _test.coverCrop(1920 / 1206, 9 / 16, { x: 0.98, y: 0.5 });
    expect(edge.visible.x + edge.visible.w).toBeCloseTo(1, 3);
    expect(edge.position.x).toBe(1);
    // A taller picture in a wide frame crops top/bottom instead.
    const tall = _test.coverCrop(1, 16 / 9, { x: 0.5, y: 0.1 });
    expect(tall.visible.w).toBe(1);
    expect(tall.visible.y).toBe(0);
    expect(tall.position.y).toBe(0);
  });

  it("portrait (phone) footage keeps its device frame", () => {
    const doc = buildFromStoryboard({ storyboard: storyboard([scene("hook-title", { purpose: "hook" }), scene("fullscreen-recording", { assets: [{ kind: "app_recording", assetId: "ast_phonerec" }] })]), app: phoneApp, brand: null, assets, recordingSegments: [] });
    expect(doc.scenes[1]!.template).toBe("device-demo");
    expect(devices(doc.scenes[1]!.layers)[0]).toMatchObject({ device: "iphone", screenAssetId: "ast_phonerec" });
  });
});
