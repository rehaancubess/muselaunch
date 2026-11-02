import type { App, Layer, MediaAsset, Storyboard, StoryboardScene } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { _test, buildFromStoryboard, mediaToScreen } from "./build";
import { compileToHtml, deviceGeometry, screenAlign, TV } from "./compile";
import { sampleAsset } from "./test-fixtures";
import { validateDoc } from "./validate";

const now = "2026-11-02T00:00:00.000Z";
const base = { workspaceId: "ws_t", createdAt: now, updatedAt: now, createdBy: "u" };
const appWith = (platforms: string[]) => ({ ...base, id: "app_tv", name: "PocketPlay", platforms, storeUrls: {}, status: "ready", dnaStatus: "confirmed", targetCountries: [], targetLanguages: ["en"] }) as unknown as App;
const tvApp = appWith(["web", "tv"]);

// A real TV recording frame size (1920×1206 ≈ 1.59:1) and a phone-controller screenshot.
const tvShot = sampleAsset("ast_tv", { width: 1920, height: 1206 });
const phoneShot = sampleAsset("ast_phone", { width: 1179, height: 2556 });

let order = 0;
const scene = (template: string, assetId: string, over: Partial<StoryboardScene> = {}): StoryboardScene => ({ id: `s${++order}`, order, purpose: "demo", durationSec: 4, onScreenText: "Your TV is the arcade", narration: "", visual: "", template, assets: [{ kind: "screenshot", assetId }], claimIds: [], ...over });
const storyboard = (scenes: StoryboardScene[], aspectRatio = "9:16"): Storyboard =>
  ({ ...base, id: "sbd_tv", appId: "app_tv", campaignId: "cpg_1", variantId: "var_1", title: "PocketPlay", aspectRatio, targetDurationSec: scenes.length * 4, scenes, voiceover: { source: "none" }, music: {} }) as Storyboard;
const devices = (l: Layer[]) => l.filter((x): x is Extract<Layer, { type: "device" }> => x.type === "device");

describe("TV apps' end card", () => {
  it("shows no Web pill for a TV app (the call to action says where to get it); web apps keep theirs", () => {
    const cta = (a: App) => {
      const doc = buildFromStoryboard({ storyboard: storyboard([scene("store-cta", "ast_tv", { purpose: "cta", onScreenText: "Get it on Fire TV", assets: [] })]), app: { ...a, websiteUrl: "https://pocketplay.club" } as App, brand: null, assets: [tvShot], recordingSegments: [] });
      return doc.scenes.flatMap((sc) => sc.layers).find((l) => l.type === "block" && l.blockId === "store-badges");
    };
    expect(cta(tvApp)).toBeUndefined();
    expect(cta(appWith(["web"]))).toMatchObject({ params: { web: true } });
  });
});

describe("TV device: which frame", () => {
  it("puts a TV app's landscape footage on a TV and keeps its portrait (phone-controller) screenshots on a phone", () => {
    expect(_test.deviceFor(tvApp, tvShot).device).toBe("tv");
    expect(_test.deviceFor(appWith(["tv"]), tvShot).device).toBe("tv");
    expect(_test.deviceFor(appWith(["macos", "tv"]), tvShot).device).toBe("tv"); // TV wins over macOS
    expect(_test.deviceFor(tvApp, phoneShot).device).toBe("iphone");
    expect(_test.deviceFor(appWith(["android", "tv"]), phoneShot).device).toBe("android");
    expect(_test.deviceFor(tvApp, sampleAsset("ast_tab", { width: 1536, height: 2048 })).device).toBe("ipad");
  });

  it("keeps browser / MacBook / phone frames for apps that are not TV apps", () => {
    expect(_test.deviceFor(appWith(["web"]), tvShot).device).toBe("browser");
    expect(_test.deviceFor(appWith(["macos"]), tvShot).device).toBe("macbook");
    expect(_test.deviceFor(appWith(["macos", "web"]), tvShot).device).toBe("browser");
    expect(_test.deviceFor(appWith(["ios"]), tvShot).device).toBe("browser");
    expect(_test.deviceFor(appWith(["ios"]), phoneShot).device).toBe("iphone");
    expect(_test.deviceFor(appWith(["android"]), phoneShot).device).toBe("android");
  });

  it("builds TV scenes in every aspect ratio, sized by width with the TV's fixed aspect and kept whole", () => {
    const sb = storyboard([
      scene("device-demo", "ast_tv"),
      scene("feature-callout", "ast_tv", { onScreenText: "Your TV is the arcade | Phones are the controllers | No console needed" }),
      scene("phone-tilt", "ast_tv"),
      scene("device-demo", "ast_phone", { onScreenText: "Scan to join" }),
    ]);
    for (const ar of ["9:16", "1:1", "16:9", "4:5"] as const) {
      const doc = buildFromStoryboard({ storyboard: sb, app: tvApp, brand: null, assets: [tvShot, phoneShot], recordingSegments: [], aspectRatio: ar });
      expect(validateDoc(doc).ok).toBe(true);
      const devs = devices(doc.scenes.flatMap((s) => s.layers));
      expect(devs.map((d) => d.device)).toEqual(["tv", "tv", "tv", "iphone"]);
      for (const d of devs.filter((x) => x.device === "tv")) {
        expect((d.box.w * doc.width) / (d.box.h * doc.height)).toBeCloseTo(TV.aspect, 1);
        expect(d.box.x).toBeGreaterThanOrEqual(0);
        expect(d.box.x + d.box.w).toBeLessThanOrEqual(1.0001);
        expect(d.box.y + d.box.h).toBeLessThanOrEqual(1); // the stand is never cut off
      }
    }
    // Portrait feature callout: the chips sit under the TV, not over its screen.
    const doc = buildFromStoryboard({ storyboard: sb, app: tvApp, brand: null, assets: [tvShot, phoneShot], recordingSegments: [] });
    const callout = doc.scenes[1]!;
    const tv = devices(callout.layers)[0]!;
    const chips = callout.layers.filter((l) => l.id.includes("_chip"));
    expect(chips).toHaveLength(2);
    for (const c of chips) expect(c.box.y).toBeGreaterThanOrEqual(tv.box.y + tv.box.h);
  });

  it("deviceBox sizes a TV like the other landscape devices (by width, capped by the height)", () => {
    const f = { W: 1080, H: 1920, ar: "9:16", portrait: true, landscape: false, u: 1, safe: { top: 0.08, bottom: 0.14, left: 0.05, right: 0.05 } } as Parameters<typeof _test.deviceBox>[0];
    const wide = _test.deviceBox(f, tvApp, tvShot, 0.5, 0.2, 0.66, 0.86);
    expect(wide.w).toBeCloseTo(0.86, 3);
    expect((wide.w * 1080) / (wide.h * 1920)).toBeCloseTo(TV.aspect, 2);
    const short = _test.deviceBox(f, tvApp, tvShot, 0.5, 0.2, 0.1, 0.86);
    expect(short.h).toBeCloseTo(0.1, 3);
    expect((short.w * 1080) / (short.h * 1920)).toBeCloseTo(TV.aspect, 2);
  });
});

describe("TV device: geometry, chrome and the centred screen fit", () => {
  it("has a 16:9 screen inside a thin bezel, with the stand below it", () => {
    const g = deviceGeometry("tv", 1000, 1000);
    expect(g.dw / g.dh).toBeCloseTo(TV.aspect, 4);
    expect(g.screen.width / g.screen.height).toBeCloseTo(16 / 9, 4);
    expect(g.screen.left - g.ox).toBeCloseTo(1000 * TV.bezel, 3);
    expect(g.screen.top + g.screen.height).toBeLessThan(g.oy + g.dh - g.dw * TV.stand * 0.9);
    expect(screenAlign("tv")).toBe("center");
    for (const d of ["iphone", "android", "ipad", "browser", "macbook"]) expect(screenAlign(d)).toBe("top");
  });

  it("compiles the TV chrome with the footage cover-fitted and centred (phones stay top-aligned)", () => {
    const sb = storyboard([scene("device-demo", "ast_tv"), scene("device-demo", "ast_phone", { onScreenText: "Scan to join" })]);
    const doc = buildFromStoryboard({ storyboard: sb, app: tvApp, brand: null, assets: [tvShot, phoneShot], recordingSegments: [] });
    const { html } = compileToHtml(doc, { assetUrl: (id) => `assets/${id}`, mode: "render", gsapSource: "gsap.min.js", still: true });
    expect(html).toContain('class="dev dev-tv"');
    expect(html).toContain('class="dev dev-iphone"');
    expect(html.match(/object-position:50% 50%/g)).toHaveLength(1); // only the TV screen
    expect(html).toMatch(/<img id="i-[^"]+" class="media" style="object-position:50% 50%" src="assets\/ast_tv"/);
    expect(html).toMatch(/<img id="i-[^"]+" class="media" src="assets\/ast_phone"/);
    expect(html).toContain(".dev-screen .media{object-fit:cover;object-position:50% 0%}");
  });

  it("maps media regions onto a centred screen: a taller frame loses equal strips top and bottom", () => {
    const g = deviceGeometry("tv", 1600, 1000);
    const sa = g.screen.width / g.screen.height;
    const ma = 1920 / 1206; // taller than 16:9
    const k = ma / sa;
    const cut = (1 - k) / 2;
    // Same aspect: identity, for both fits.
    expect(mediaToScreen({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, sa, sa, "center")).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    // The middle stays in the middle; a region's size scales by 1/k.
    const mid = mediaToScreen({ x: 0.4, y: 0.45, w: 0.2, h: 0.1 }, ma, sa, "center");
    expect(mid.y + mid.h / 2).toBeCloseTo(0.5, 3);
    expect(mid.h).toBeCloseTo(0.1 / k, 3);
    expect(mid.x).toBeCloseTo(0.4, 4);
    // The cropped strips map off-screen (clipped to nothing) at both ends.
    const top = mediaToScreen({ x: 0, y: 0, w: 1, h: cut * 0.9 }, ma, sa, "center");
    expect(top.h).toBe(0);
    const bottom = mediaToScreen({ x: 0, y: 1 - cut * 0.9, w: 1, h: cut * 0.9 }, ma, sa, "center");
    expect(bottom.h).toBe(0);
    expect(bottom.y).toBe(1);
    // A real region: (y - cut) / k.
    const r = mediaToScreen({ x: 0.72, y: 0.66, w: 0.2, h: 0.2 }, ma, sa, "center");
    expect(r.y).toBeCloseTo((0.66 - cut) / k, 3);
    expect(r.h).toBeCloseTo(0.2 / k, 3);
    // The default (phones) is still top-aligned: y / k.
    expect(mediaToScreen({ x: 0.72, y: 0.66, w: 0.2, h: 0.2 }, ma, sa).y).toBeCloseTo(0.66 / k, 3);
    // Wider media loses its sides symmetrically whatever the vertical alignment.
    expect(mediaToScreen({ x: 0.5, y: 0, w: 0, h: 1 }, sa * 1.5, sa, "center").x).toBeCloseTo(0.5, 3);
  });

  it("focus regions on a TV scene use the centred mapping", () => {
    const focus = { x: 0.72, y: 0.66, w: 0.2, h: 0.2 };
    const doc = buildFromStoryboard({ storyboard: storyboard([scene("focus-zoom", "ast_tv", { focus })]), app: tvApp, brand: null, assets: [tvShot], recordingSegments: [] });
    const tv = devices(doc.scenes[0]!.layers)[0]!;
    expect(tv.device).toBe("tv");
    const g = deviceGeometry("tv", tv.box.w * doc.width, tv.box.h * doc.height);
    const expected = mediaToScreen(focus, 1920 / 1206, g.screen.width / g.screen.height, "center");
    expect(tv.focus).toMatchObject({ x: expected.x, y: expected.y, w: expected.w, h: expected.h });
    expect(tv.focus!.y).toBeLessThan(0.66 / ((1920 / 1206) / (16 / 9))); // not the top-aligned mapping
  });
});
