/**
 * CompositionDoc → HyperFrames HTML.
 *
 * One root composition (`data-composition-id="muselaunch"`) holds every scene as a timed
 * `.clip` section; layers are timed clips inside it (absolute root time). Motion is a single
 * paused GSAP timeline registered on `window.__timelines`, built only from numbers and our own
 * element ids — document text and colours are escaped into markup/CSS and never reach script.
 * Every visual is produced by the allowlisted components below.
 */
import type { BlurRegion, CompositionDoc, Layer, MaskUse, Region01, RegionPathPoint, Scene, Theme, TracksFile } from "@muselaunch/contracts";
import { compileAudioTags } from "./audio";
import { BLOCK_PARAMS, isBlockId } from "./blocks";
import { bundledFont, fontWeight, fontWidthFactor } from "./fonts";
import { captionPages } from "./karaoke";
import { estimateTextHeight } from "./lint";
import { anchorPoint, clipMapping, holdGaps, sampleTrack, trackTweens, trackUsable, type SegmentationInfo } from "./objects";
import { opensOnFirstFrame, settleTiming } from "./opening";
import { getCompileRuntime } from "./runtime";
import { round3, sceneStarts, totalDuration } from "./validate";

export const ROOT_COMPOSITION_ID = "muselaunch";

export type { SegmentationInfo } from "./objects";

export interface CompileOptions {
  /** Resolve an asset id to a URL or a path relative to the render directory. */
  assetUrl: (assetId: string) => string;
  mode: "preview" | "render";
  /** "inline" embeds the registered GSAP source; anything else is used as a script URL. */
  gsapSource: "inline" | string;
  /** Segmentations referenced by masked layers, anchors and effects (cutout swap + fallback). */
  segmentations?: Record<string, SegmentationInfo>;
  /** SAM object tracks per segmentation id (TracksFile JSON), for anchors and effect layers. */
  tracks?: Record<string, TracksFile>;
  /** Output scale (e.g. 0.5 for fast previews). The layout is authored at doc size and scaled. */
  scale?: number;
  /** Static capture: no motion, cuts only; each scene lasts `sceneSlotSec` (default: authored). */
  still?: boolean;
  sceneSlotSec?: number;
  /** Optional HyperFrames runtime script URL for standalone preview pages. */
  runtimeSrc?: string;
  /** Media kind per asset id, so backgrounds/blur can pick <img> vs <video>. */
  assetKinds?: Record<string, string>;
  /** Whether each video asset has an audio track (from probe). An unmuted layer on a silent file renders muted. */
  assetHasAudio?: Record<string, boolean>;
}

export interface CompileResult {
  html: string;
  durationSec: number;
  /** Scene start/end on the compiled timeline (for thumbnails / static capture). */
  scenes: { id: string; start: number; end: number }[];
  /** Asset ids the HTML references (after mask resolution). */
  assetIds: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);
const n = (v: number, d = 3) => {
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return Object.is(r, -0) ? 0 : r;
};
const px = (v: number) => `${n(v, 2)}px`;
const J = (v: unknown) => JSON.stringify(v);

const HEX = /^#(?:[0-9a-fA-F]{3}){1,2}(?:[0-9a-fA-F]{2})?$/;

function themeColor(theme: Theme, c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  if (HEX.test(c)) return c;
  switch (c) {
    case "theme.background":
      return theme.background;
    case "theme.surface":
      return theme.surface;
    case "theme.text":
      return theme.text;
    case "theme.textMuted":
      return theme.textMuted;
    case "theme.accent":
      return theme.accent;
    case "theme.accent2":
      return theme.accent2 ?? theme.accent;
    default:
      return fallback;
  }
}

/** #rgb/#rrggbb/#rrggbbaa → [r,g,b,a]. */
function rgba(hex: string): [number, number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}
export function withAlpha(hex: string, a: number): string {
  const [r, g, b] = rgba(hex);
  return `rgba(${r},${g},${b},${n(a, 3)})`;
}
export function luminance(hex: string): number {
  const [r, g, b] = rgba(hex).map((v, i) => (i < 3 ? v / 255 : v)) as [number, number, number, number];
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const SAFE_FONT = /^[A-Za-z0-9 -]{1,60}$/;
function fontStack(theme: Theme, kind: "heading" | "body" | "mono"): string {
  if (kind === "mono") return `ui-monospace,'SF Mono',Menlo,'DejaVu Sans Mono',monospace`;
  const named = kind === "heading" ? theme.headingFont : theme.bodyFont;
  const lib = bundledFont(named);
  const first = lib && lib.name !== "Inter" ? `'${lib.cssFamily}',` : named && SAFE_FONT.test(named) && !/^inter$/i.test(named) ? `'${named}',` : "";
  return `${first}'Inter Variable',Inter,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif`;
}

/** The theme font a text style uses (for weight clamping and fitting). */
const styleFont = (theme: Theme, font: "heading" | "body" | "mono") => (font === "heading" ? theme.headingFont : font === "body" ? theme.bodyFont : undefined);

/** @font-face CSS for the bundled display faces this doc's theme uses (Inter is always inlined). */
function docFontCss(theme: Theme): string {
  const fonts = getCompileRuntime().fonts ?? {};
  const names = [...new Set([bundledFont(theme.headingFont)?.name, bundledFont(theme.bodyFont)?.name].filter((x): x is string => !!x && x !== "Inter"))];
  return names.map((n) => fonts[n] ?? "").filter(Boolean).join("\n");
}

const EASE_IN: Record<string, string> = { smooth: "power3.out", snappy: "expo.out", spring: "back.out(1.5)", linear: "none" };
const EASE_OUT: Record<string, string> = { smooth: "power2.in", snappy: "expo.in", spring: "back.in(1.2)", linear: "none" };

// ---------------------------------------------------------------------------
// Device frames (drawn with CSS; no third-party device artwork)
// ---------------------------------------------------------------------------

interface DeviceSpec {
  aspect: number | null; // width / height of the whole device; null = use the box
  bezel: number; // fraction of device width
  outerRadius: number; // fraction of device width
  screenRadius: number;
}

/**
 * A modern thin-bezel TV (fractions of the TV's width): a 16:9 screen, an even thin bezel, and a
 * slim pedestal stand below the panel. The whole frame has a fixed aspect, so the box sizes by width.
 */
export const TV = (() => {
  const bezel = 0.011;
  const screenH = ((1 - bezel * 2) * 9) / 16;
  const panel = screenH + bezel * 2;
  const stand = 0.052;
  return { bezel, panel, stand, aspect: 1 / (panel + stand) };
})();
const DEVICES: Record<string, DeviceSpec> = {
  iphone: { aspect: 0.4885, bezel: 0.042, outerRadius: 0.165, screenRadius: 0.128 },
  android: { aspect: 0.47, bezel: 0.03, outerRadius: 0.12, screenRadius: 0.1 },
  ipad: { aspect: 0.75, bezel: 0.045, outerRadius: 0.06, screenRadius: 0.035 },
  browser: { aspect: null, bezel: 0, outerRadius: 0.018, screenRadius: 0 },
  macbook: { aspect: 1.56, bezel: 0.025, outerRadius: 0.03, screenRadius: 0.012 },
  tv: { aspect: TV.aspect, bezel: TV.bezel, outerRadius: 0.007, screenRadius: 0.0025 },
};

/**
 * How the media is cover-fitted into a device screen: top-aligned on phones, tablets, browsers and
 * laptops (an app's top bar stays visible); centred on a TV (game/TV footage has no top bar).
 */
export function screenAlign(device: string): "top" | "center" {
  return device === "tv" ? "center" : "top";
}

export interface DeviceGeometry {
  /** Device size and offset inside the layer box (px). */
  dw: number;
  dh: number;
  ox: number;
  oy: number;
  /** The visible screen inside the layer box (px). Focus/tap/blur fractions are relative to this rect. */
  screen: { left: number; top: number; width: number; height: number };
}

/** Where the device and its screen sit inside a w×h layer box (same maths as the frame drawing). */
export function deviceGeometry(device: string, w: number, h: number): DeviceGeometry {
  const spec = DEVICES[device] ?? DEVICES.iphone!;
  let dw = w;
  let dh = h;
  if (spec.aspect) {
    if (w / h > spec.aspect) dw = h * spec.aspect;
    else dh = w / spec.aspect;
  }
  const ox = (w - dw) / 2;
  const oy = (h - dh) / 2;
  if (device === "browser") {
    const bar = Math.max(28, dh * 0.055);
    return { dw, dh, ox, oy, screen: { left: ox, top: oy + bar, width: dw, height: dh - bar } };
  }
  if (device === "macbook") {
    const bz = dw * spec.bezel;
    const border = Math.max(1, dw * 0.003);
    return { dw, dh, ox, oy, screen: { left: ox + dw * 0.06 + border + bz, top: oy + border + bz, width: dw * 0.88 - bz * 2, height: dh * 0.9 - bz * 2.2 } };
  }
  if (device === "tv") {
    const bz = dw * TV.bezel;
    const sw = dw - bz * 2;
    return { dw, dh, ox, oy, screen: { left: ox + bz, top: oy + bz, width: sw, height: (sw * 9) / 16 } };
  }
  const bz = dw * spec.bezel;
  return { dw, dh, ox, oy, screen: { left: ox + bz, top: oy + bz, width: dw - bz * 2, height: dh - bz * 2 } };
}

const FRAME_COLORS: Record<string, { edge: string; body: string; hi: string }> = {
  black: { edge: "#2e2e31", body: "#141416", hi: "#6a6a70" },
  silver: { edge: "#c9cbcf", body: "#e3e4e6", hi: "#ffffff" },
  natural: { edge: "#a29c90", body: "#bdb6aa", hi: "#e6e0d4" },
  white: { edge: "#d8d8dc", body: "#f2f2f4", hi: "#ffffff" },
};

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

interface Ctx {
  doc: CompositionDoc;
  opts: CompileOptions;
  W: number;
  H: number;
  tl: string[];
  assetIds: Set<string>;
  still: boolean;
}

interface Window {
  start: number;
  end: number;
}

export function compileToHtml(doc: CompositionDoc, opts: CompileOptions): CompileResult {
  const W = doc.width;
  const H = doc.height;
  const still = !!opts.still || doc.kind !== "video";
  const scenes = opts.sceneSlotSec ? doc.scenes.map((s) => ({ ...s, durationSec: opts.sceneSlotSec! })) : doc.scenes;
  const d2 = { ...doc, scenes };
  const starts = sceneStarts(d2);
  const total = totalDuration(d2);
  const ctx: Ctx = { doc: d2, opts, W, H, tl: [], assetIds: new Set(), still };

  const sceneHtml: string[] = [];
  const sceneTimes: CompileResult["scenes"] = [];
  scenes.forEach((scene, i) => {
    const start = starts[i]!;
    const next = scenes[i + 1];
    const overlapOut = !still && next && next.transitionIn.kind !== "cut" ? next.transitionIn.durationSec : 0;
    const win = { start, end: round3(start + scene.durationSec + overlapOut) };
    sceneTimes.push({ id: scene.id, start, end: round3(start + scene.durationSec) });
    sceneHtml.push(compileScene(ctx, scene, i, win, round3(start + scene.durationSec)));
    if (!still && i > 0 && scene.transitionIn.kind !== "cut" && scene.transitionIn.durationSec > 0) transition(ctx, scene, scenes[i - 1]!, start);
  });

  const captions = compileCaptions(ctx, total);
  const audio = compileAudio(ctx, total);

  // Pin the timeline length so the runtime and the render agree on duration.
  ctx.tl.push(`tl.set({}, {}, ${n(total)});`);

  const rt = getCompileRuntime();
  let gsapTag: string;
  if (opts.gsapSource === "inline") {
    if (!rt.gsap) throw new Error("GSAP source not registered: call ensureNodeCompileRuntime() (Node) or registerCompileRuntime({ gsap })");
    gsapTag = `<script>${rt.gsap.replace(/<\/script/gi, "<\\/script")}</script>`;
  } else {
    gsapTag = `<script src="${esc(opts.gsapSource)}"></script>`;
  }
  const scale = opts.scale && opts.scale > 0 && opts.scale !== 1 ? opts.scale : 1;
  const outW = Math.round(W * scale);
  const outH = Math.round(H * scale);
  const th = doc.theme;

  const css = baseCss(doc, W, H, outW, outH, scale);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${outW}, height=${outH}" />
<meta name="generator" content="MuseLaunch compositions (${opts.mode})" />
${opts.runtimeSrc ? `<script src="${esc(opts.runtimeSrc)}"></script>\n` : ""}${rt.fontCss ? `<style>${rt.fontCss}${docFontCss(th) ? `\n${docFontCss(th)}` : ""}</style>\n` : ""}${gsapTag}
<style>${css}</style>
</head>
<body>
<div id="root" data-composition-id="${ROOT_COMPOSITION_ID}" data-start="0" data-duration="${n(total)}" data-width="${outW}" data-height="${outH}" style="background:${th.background}">
<div id="stage">
${sceneHtml.join("\n")}
${captions}
</div>
${audio}
</div>
<script>
(function(){
  var q = function(id){ return document.getElementById(id); };
  var qa = function(id, sel){ var el = q(id); return el ? Array.prototype.slice.call(el.querySelectorAll(sel)) : []; };
  var tl = gsap.timeline({ paused: true });
${ctx.tl.map((l) => `  ${l}`).join("\n")}
  window.__timelines = window.__timelines || {};
  window.__timelines["${ROOT_COMPOSITION_ID}"] = tl;
})();
</script>
</body>
</html>
`;
  return { html, durationSec: total, scenes: sceneTimes, assetIds: [...ctx.assetIds] };
}

function baseCss(doc: CompositionDoc, W: number, H: number, outW: number, outH: number, scale: number): string {
  const th = doc.theme;
  return `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${outW}px;height:${outH}px;overflow:hidden;background:${th.background}}
body{-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;font-optical-sizing:auto;font-kerning:normal}
#root{position:relative;width:${outW}px;height:${outH}px;overflow:hidden;isolation:isolate}
#stage{position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0;${scale !== 1 ? `transform:scale(${n(scale, 5)});` : ""}}
.scene{position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:hidden;isolation:isolate}
.bg,.bgm,.dim,.flash{position:absolute;left:0;top:0;width:100%;height:100%}
.bgm{object-fit:cover}
.flash{background:#fff;opacity:0;pointer-events:none;z-index:99}
.layer{position:absolute}
.lk,.le,.ll{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:50% 50%}
.txt{position:absolute;left:0;top:0;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center}
.tb{max-width:100%;overflow-wrap:break-word;hyphens:manual;text-wrap:balance}
.w{display:inline-block;overflow:hidden;vertical-align:top;padding:0.06em 0.02em 0.1em;margin:-0.06em -0.02em -0.1em}
.wi,.ch{display:inline-block}
.media{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.fxm{display:block}
.dev{position:absolute}
.dev-body{position:absolute;left:0;top:0;width:100%;height:100%}
.dev-screen{position:absolute;overflow:hidden;background:#000;isolation:isolate}
.dev-screen .media{object-fit:cover;object-position:50% 0%}
.cap{position:absolute;left:0;width:100%;display:flex;justify-content:center;padding:0 ${n(W * doc.safeZone.left, 1)}px}
.cap span{display:inline-block;text-align:center}
`;
}

function sceneBackground(ctx: Ctx, scene: Scene, win: Window): string {
  const { doc } = ctx;
  const th = doc.theme;
  const bg = scene.background;
  const parts: string[] = [];
  let style = "";
  switch (bg.kind) {
    case "solid":
      style = `background:${themeColor(th, bg.color, th.background)}`;
      break;
    case "gradient": {
      const cols = (bg.colors ?? [th.background, th.surface]).map((c) => themeColor(th, c, th.background));
      style = `background:linear-gradient(${n(bg.angle, 1)}deg,${cols.join(",")})`;
      break;
    }
    case "image":
    case "video":
    case "blur": {
      style = `background:${themeColor(th, bg.color, "#000000")}`;
      if (bg.assetId) {
        const blur = bg.kind === "blur" ? ";filter:blur(48px);transform:scale(1.15)" : "";
        parts.push(mediaElement(ctx, bg.assetId, `bgv-${scene.id}`, win, { cls: "bgm", style: blur.slice(1), trimIn: 0, rate: 1, muted: true }));
      }
      break;
    }
  }
  if (bg.dim > 0) parts.push(`<div class="dim" style="background:rgba(0,0,0,${n(bg.dim)})"></div>`);
  return `<div class="bg" style="${style}">${parts.join("")}</div>`;
}

/** <img> or timed <video>, depending on the asset's role in the doc. */
function mediaElement(
  ctx: Ctx,
  assetId: string,
  id: string,
  win: Window,
  o: { cls: string; style?: string; trimIn: number; rate: number; muted: boolean; volume?: number; video?: boolean; alt?: string },
): string {
  ctx.assetIds.add(assetId);
  const src = esc(ctx.opts.assetUrl(assetId));
  const style = o.style ? ` style="${o.style}"` : "";
  const isVideo = o.video !== undefined ? o.video : looksLikeVideo(ctx, assetId);
  if (isVideo) {
    const silent = o.muted || ctx.opts.assetHasAudio?.[assetId] === false;
    const audio = silent ? "muted" : `data-has-audio="true" data-volume="${n(o.volume ?? 1)}"`;
    return `<video id="${id}" class="${o.cls}"${style} src="${src}" data-start="${n(win.start)}" data-duration="${n(win.end - win.start)}" data-media-start="${n(o.trimIn)}"${o.rate !== 1 ? ` data-playback-rate="${n(o.rate)}"` : ""} ${audio} playsinline preload="auto"></video>`;
  }
  return `<img id="${id}" class="${o.cls}"${style} src="${src}" alt="${esc(o.alt ?? "")}" draggable="false" />`;
}

/** Background assets carry no kind in the doc: use the caller's asset kinds, else `background.kind`. */
function looksLikeVideo(ctx: Ctx, assetId: string): boolean {
  const k = ctx.opts.assetKinds?.[assetId];
  if (k) return k === "video";
  for (const s of ctx.doc.scenes) if (s.background.assetId === assetId && s.background.kind === "video") return true;
  return false;
}

function compileScene(ctx: Ctx, scene: Scene, index: number, win: Window, sceneEnd: number): string {
  const layers = scene.layers
    .map((l, li) => ({ l, li }))
    .filter(({ l }) => !l.hidden)
    .map(({ l, li }) => compileLayer(ctx, scene, l, li, win, sceneEnd, index))
    .filter(Boolean);
  const flash = !ctx.still && scene.transitionIn.kind === "flash" ? `<div class="flash" id="fl-${scene.id}"></div>` : "";
  return `<section id="s-${scene.id}" class="scene clip" data-start="${n(win.start)}" data-duration="${n(win.end - win.start)}" data-track-index="${index % 2}" style="z-index:${index + 1}">
${sceneBackground(ctx, scene, win)}
${layers.join("\n")}
${flash}</section>`;
}

function layerWindow(layer: Layer, sceneStart: number, sceneEnd: number, sceneWin: Window): Window {
  const start = round3(sceneStart + layer.timing.start);
  const end = layer.timing.end !== undefined ? round3(Math.min(sceneStart + layer.timing.end, sceneEnd)) : sceneWin.end;
  return { start, end: Math.max(end, round3(start + 0.04)) };
}

function compileLayer(ctx: Ctx, scene: Scene, layer: Layer, li: number, sceneWin: Window, sceneEnd: number, sceneIndex = -1): string {
  const { W, H } = ctx;
  const win = layerWindow(layer, sceneWin.start, sceneEnd, sceneWin);
  // The first frame is the thumbnail: the opening scene's layers are on screen from frame 0 (./opening.ts).
  const opening = opensOnFirstFrame(sceneIndex, layer);
  const b = layer.box;
  const left = b.x * W;
  const top = b.y * H;
  const w = b.w * W;
  const h = b.h * H;
  let inner = "";
  switch (layer.type) {
    case "text":
      inner = textHtml(ctx, layer, w, h);
      break;
    case "image": {
      const crop = layer.crop ? `;object-view-box:inset(${n(layer.crop.y * 100)}% ${n((1 - layer.crop.x - layer.crop.w) * 100)}% ${n((1 - layer.crop.y - layer.crop.h) * 100)}% ${n(layer.crop.x * 100)}%)` : "";
      if (layer.lift) {
        inner = liftedImage(ctx, layer, `l-${layer.id}`, w, h, crop, win);
        break;
      }
      const shadow = layer.shadow ? `;box-shadow:0 ${px(h * 0.03)} ${px(h * 0.08)} rgba(0,0,0,.22)` : "";
      inner = mediaElement(ctx, layer.assetId, `i-${layer.id}`, win, { cls: "media", style: `object-fit:${layer.fit}${objectPosition(layer.objectPosition)};border-radius:${px(layer.radiusPx)}${crop}${shadow}`, trimIn: 0, rate: 1, muted: true, video: false });
      // Privacy: frosted patches over personal or secret details (fractions of the layer box).
      inner += blurPatches(ctx, layer.blurRegions, `l-${layer.id}`, w, h, w * 0.03, 0, win, null);
      break;
    }
    case "video": {
      const src = resolveMask(ctx, layer.assetId, layer.mask);
      if (src === null) return "";
      const radius = layer.radiusPx ? `;border-radius:${px(layer.radiusPx)}` : "";
      inner = mediaElement(ctx, src.assetId, `v-${layer.id}`, win, {
        cls: "media",
        style: `object-fit:${layer.fit}${objectPosition(layer.objectPosition)}${radius}`,
        trimIn: layer.trimInSec,
        rate: layer.playbackRate,
        muted: layer.muted,
        volume: layer.volume,
        video: true,
      });
      // Privacy: frosted, blurred patches over personal information (fractions of the layer box), moving with SAM's track.
      inner += blurPatches(ctx, layer.blurRegions, `l-${layer.id}`, w, h, w * 0.03, 0, win, { trimIn: layer.trimInSec, rate: layer.playbackRate });
      break;
    }
    case "device":
      inner = deviceHtml(ctx, layer, w, h, win, left, top);
      break;
    case "shape":
      inner = shapeHtml(ctx, layer, w, h);
      break;
    case "block":
      inner = blockHtml(ctx, layer, w, h, win, sceneWin.start);
      break;
    case "effect": {
      // Effects draw in frame coordinates over the whole frame; box.z / box.opacity still apply.
      const fx = effectHtml(ctx, scene, layer, win, sceneWin.start);
      if (fx === null) return "";
      const id = `l-${layer.id}`;
      if (!ctx.still) animateLayer(ctx, layer, id, win, sceneWin.start, opening);
      const op = b.opacity !== 1 ? `opacity:${n(b.opacity)};` : "";
      return `<div id="${id}" class="layer clip l-effect" data-start="${n(win.start)}" data-duration="${n(win.end - win.start)}" data-track-index="${2 + li}" style="left:0;top:0;width:${W}px;height:${H}px;z-index:${b.z};pointer-events:none;${op}"><div class="lk" id="${id}-k"><div class="le" id="${id}-e"><div class="ll" id="${id}-l">${fx}</div></div></div></div>`;
    }
  }
  const rot = b.rotation ? `transform:rotate(${n(b.rotation, 2)}deg);` : "";
  // Blend modes sit on the outer layer element: it is what composites against the layers below.
  const op = `${b.opacity !== 1 ? `opacity:${n(b.opacity)};` : ""}${layer.type === "shape" && layer.blend ? `mix-blend-mode:${layer.blend};` : ""}`;
  const id = `l-${layer.id}`;
  if (!ctx.still) animateLayer(ctx, layer, id, win, sceneWin.start, opening);
  if (layer.anchor) anchorLayer(ctx, scene, layer, id, win, sceneWin.start);
  else if (layer.type === "image" && layer.lift && !ctx.still && !layer.animation.keyframes?.length) liftMotion(ctx, layer, id, win);
  return `<div id="${id}" class="layer clip l-${layer.type}" data-start="${n(win.start)}" data-duration="${n(win.end - win.start)}" data-track-index="${2 + li}" style="left:${px(left)};top:${px(top)};width:${px(w)};height:${px(h)};z-index:${b.z};${rot}${op}"><div class="lk" id="${id}-k"><div class="le" id="${id}-e"><div class="ll" id="${id}-l">${inner}</div></div></div></div>`;
}

// --- tracked regions (SAM paths) ---------------------------------------------------------------

/** A tracked region at media time `t` (linear between samples; held before the first and after the last). */
export function regionAt(path: readonly RegionPathPoint[], t: number): Region01 {
  const first = path[0]!;
  if (t <= first.t) return { x: first.x, y: first.y, w: first.w, h: first.h };
  for (let i = 1; i < path.length; i++) {
    const b = path[i]!;
    if (t <= b.t) {
      const a = path[i - 1]!;
      const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k };
    }
  }
  const last = path[path.length - 1]!;
  return { x: last.x, y: last.y, w: last.w, h: last.h };
}

/** How a layer plays its source media: from `trimIn` at `rate` from the start of its window. */
interface MediaClock {
  trimIn: number;
  rate: number;
}

/** Composition-time samples of a path inside a layer window (the window's start and end included). */
export function pathSamples(path: readonly RegionPathPoint[], win: { start: number; end: number }, clock: MediaClock): { tc: number; r: Region01 }[] {
  const rate = clock.rate > 0 ? clock.rate : 1;
  const out: { tc: number; r: Region01 }[] = [{ tc: win.start, r: regionAt(path, clock.trimIn) }];
  for (const p of path) {
    const tc = win.start + (p.t - clock.trimIn) / rate;
    if (tc > out[out.length - 1]!.tc + 0.02 && tc < win.end - 0.02) out.push({ tc, r: p });
  }
  out.push({ tc: win.end, r: regionAt(path, clock.trimIn + (win.end - win.start) * rate) });
  return out;
}

/** GSAP statements moving `sel` along composition-time samples (numbers only). */
function sampleTweens(sel: string, samples: { tc: number; r: Region01 }[], props: (r: Region01) => Record<string, number>): string[] {
  if (samples.length < 2) return [];
  const fmt = (o: Record<string, number | string | boolean>) => J(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 100) / 100 : v])));
  const out = [`tl.set(${sel}, ${fmt(props(samples[0]!.r))}, ${n(samples[0]!.tc)});`];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    out.push(`tl.fromTo(${sel}, ${fmt(props(a.r))}, ${fmt({ ...props(b.r), duration: Math.max(0.01, b.tc - a.tc), ease: "none", immediateRender: false })}, ${n(a.tc)});`);
  }
  return out;
}

/**
 * Frosted privacy patches over regions of a w×h box. A region with a SAM path (and a media clock: a
 * video) moves with the content; otherwise it stays where Muse Spark drew it.
 */
function blurPatches(ctx: Ctx, regions: readonly BlurRegion[] | undefined, idBase: string, w: number, h: number, blurPx: number, z: number, win: Window, clock: MediaClock | null): string {
  const out: string[] = [];
  (regions ?? []).forEach((reg, i) => {
    const tracked = reg.path && reg.path.length >= 2 && clock ? reg.path : undefined;
    const r0 = tracked ? regionAt(tracked, clock!.trimIn) : reg;
    const id = `${idBase}-pv${i}`;
    const radius = Math.max(4, Math.min(reg.w * w, reg.h * h) * 0.22);
    out.push(
      `<div class="pv" id="${id}" style="position:absolute;left:${px(r0.x * w)};top:${px(r0.y * h)};width:${px(r0.w * w)};height:${px(r0.h * h)};backdrop-filter:blur(${px(blurPx)});-webkit-backdrop-filter:blur(${px(blurPx)});background:rgba(232,232,237,.78);border-radius:${px(radius)}${z ? `;z-index:${z}` : ""}"></div>`,
    );
    if (tracked && !ctx.still) ctx.tl.push(...sampleTweens(`q("${id}")`, pathSamples(tracked, win, clock!), (r) => ({ left: r.x * w, top: r.y * h, width: r.w * w, height: r.h * h })));
  });
  return out.join("");
}

// --- object-aware: anchors & effects ------------------------------------------------------------

function segAndTracks(ctx: Ctx, segmentationId: string) {
  return { seg: ctx.opts.segmentations?.[segmentationId], tracks: ctx.opts.tracks?.[segmentationId] };
}

/** Drive the layer's `-k` wrapper along the tracked object (static fallback when the track is unusable). */
function anchorLayer(ctx: Ctx, scene: Scene, layer: Layer, id: string, win: Window, sceneStart: number) {
  const a = layer.anchor!;
  const { seg, tracks } = segAndTracks(ctx, a.segmentationId);
  const use = trackUsable(seg, tracks, a.objectId);
  if (!use.ok || !tracks) return;
  const map = clipMapping(scene, seg, tracks, ctx.W, ctx.H);
  let samples = sampleTrack(use.track!, tracks.fps, map, sceneStart, win, a.smoothFrames);
  if (a.whenLost === "hold") samples = holdGaps(samples);
  const ref = samples.find((s) => s.visible);
  if (!ref) {
    if (a.whenLost === "hide") ctx.tl.push(`tl.set(q("${id}-k"), {autoAlpha:0}, ${n(win.start)});`);
    return;
  }
  const b = layer.box;
  const cx0 = (b.x + b.w / 2) * ctx.W;
  const cy0 = (b.y + b.h / 2) * ctx.H;
  const refDiag = Math.hypot(ref.w, ref.h) || 1;
  ctx.tl.push(
    ...trackTweens(
      `q("${id}-k")`,
      samples,
      (s) => {
        const p = anchorPoint(s, a.point);
        const o: Record<string, number> = { x: p.x + a.offset.x * ctx.W - cx0, y: p.y + a.offset.y * ctx.H - cy0 };
        if (a.scaleWithObject) o.scale = Math.max(0.3, Math.min(3, Math.hypot(s.w, s.h) / refDiag));
        return o;
      },
      { fadeLost: a.whenLost === "hide" },
    ),
  );
}

/** The object's own cutout (per-object output first, else the segmentation's combined cutout). */
function objectCutout(seg: SegmentationInfo | undefined, objectId: string): string | undefined {
  return seg?.objectOutputs?.[objectId]?.cutoutAssetId ?? seg?.cutoutAssetId;
}

/** A timed <video> of the clip (or its cutout) positioned exactly like the clip layer. */
function clipVideo(ctx: Ctx, assetId: string, elId: string, map: ReturnType<typeof clipMapping>, win: Window, sceneStart: number, extraStyle = ""): string {
  const style = `position:absolute;left:${px(map.boxX)};top:${px(map.boxY)};width:${px(map.boxW)};height:${px(map.boxH)};object-fit:${map.fit};${extraStyle}`;
  return mediaElement(ctx, assetId, elId, win, { cls: "fxm", style, trimIn: map.srcAt(win.start - sceneStart), rate: map.rate, muted: true, video: true });
}

function effectHtml(ctx: Ctx, scene: Scene, layer: Extract<Layer, { type: "effect" }>, win: Window, sceneStart: number): string | null {
  const { W, H } = ctx;
  const th = ctx.doc.theme;
  const { seg, tracks } = segAndTracks(ctx, layer.target.segmentationId);
  const use = trackUsable(seg, tracks, layer.target.objectId);
  const map = clipMapping(scene, seg, tracks, W, H);
  const color = themeColor(th, layer.color, th.accent);
  const rgb = color.length >= 7 ? color.slice(0, 7) : "#FFFFFF";
  const I = layer.intensity;
  const id = `l-${layer.id}`;
  const sel = (suffix: string) => `q("${id}-${suffix}")`;
  const samples = use.ok && tracks ? holdGaps(sampleTrack(use.track!, tracks.fps, map, sceneStart, win, 5)) : [];
  const anyVisible = samples.some((s) => s.visible);
  const motion = (suffix: string, props: Parameters<typeof trackTweens>[2], fadeLost = false) => {
    if (!ctx.still) ctx.tl.push(...trackTweens(sel(suffix), samples, props, { fadeLost }));
    else if (samples[0]) ctx.tl.push(`tl.set(${sel(suffix)}, ${JSON.stringify(props(samples.find((x) => x.visible) ?? samples[0]))}, ${n(win.start)});`);
  };
  switch (layer.effect) {
    case "spotlight": {
      if (!anyVisible) return null;
      const a = n(0.35 + I * 0.5);
      motion("spot", (s) => ({ "--x": `${n(s.cx, 1)}px`, "--y": `${n(s.cy, 1)}px`, "--rx": `${n(s.w * 0.72 + W * 0.04, 1)}px`, "--ry": `${n(s.h * 0.68 + W * 0.04, 1)}px` }));
      const first = samples.find((x) => x.visible)!;
      const vars = `--x:${n(first.cx, 1)}px;--y:${n(first.cy, 1)}px;--rx:${n(first.w * 0.72, 1)}px;--ry:${n(first.h * 0.68, 1)}px`;
      return `<div id="${id}-spot" class="media" style="${vars};background:radial-gradient(ellipse var(--rx) var(--ry) at var(--x) var(--y),rgba(0,0,0,0) 0%,rgba(0,0,0,0) 58%,${withAlpha(rgb, 0.16 * I)} 66%,rgba(0,0,0,${a}) 100%)"></div>`;
    }
    case "highlight-ring": {
      if (!anyVisible) return null;
      const first = samples.find((x) => x.visible)!;
      const pad = Math.max(first.w, first.h) * 0.08;
      const radius = Math.min(first.w, first.h) * 0.22;
      motion("ring", (s) => ({ left: s.x - pad, top: s.y - pad, width: s.w + pad * 2, height: s.h + pad * 2 }));
      const bw = Math.max(3, W * 0.005);
      return `<div id="${id}-ring" style="position:absolute;left:${px(first.x - pad)};top:${px(first.y - pad)};width:${px(first.w + pad * 2)};height:${px(first.h + pad * 2)};border:${px(bw)} solid ${withAlpha(rgb, 0.55 + 0.45 * I)};border-radius:${px(radius)};box-shadow:0 0 ${px(W * 0.03)} ${withAlpha(rgb, 0.55 * I)},inset 0 0 ${px(W * 0.02)} ${withAlpha(rgb, 0.35 * I)}"></div>`;
    }
    case "follow-arrow": {
      if (!anyVisible) return null;
      const size = W * 0.075;
      const first = samples.find((x) => x.visible)!;
      motion("arrow", (s) => ({ left: s.cx - size / 2, top: s.y - size * 1.25 }));
      if (!ctx.still) {
        const reps = Math.max(0, Math.ceil((win.end - win.start) / 0.5) - 1);
        ctx.tl.push(`tl.fromTo(${sel("arrow-b")}, {y:0}, {y:${n(size * 0.18, 1)}, duration:0.5, ease:"sine.inOut", yoyo:true, repeat:${reps}}, ${n(win.start)});`);
      }
      return `<div id="${id}-arrow" style="position:absolute;left:${px(first.cx - size / 2)};top:${px(first.y - size * 1.25)};width:${px(size)};height:${px(size)}"><svg id="${id}-arrow-b" viewBox="0 0 24 24" width="100%" height="100%" style="filter:drop-shadow(0 ${px(size * 0.06)} ${px(size * 0.14)} rgba(0,0,0,.35))"><path d="M12 22 L3.5 12.5 H9 V2 H15 V12.5 H20.5 Z" fill="${rgb}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg></div>`;
    }
    case "screen-insert": {
      if (!layer.assetId || !anyVisible) return null;
      const inset = layer.inset ?? { top: 0.045, right: 0.075, bottom: 0.045, left: 0.075 };
      const first = samples.find((x) => x.visible)!;
      const rect = (s: { x: number; y: number; w: number; h: number }) => ({ left: s.x + s.w * inset.left, top: s.y + s.h * inset.top, width: s.w * (1 - inset.left - inset.right), height: s.h * (1 - inset.top - inset.bottom) });
      motion("ins", (s) => rect(s), true);
      const r0 = rect(first);
      const radius = Math.min(r0.width, r0.height) * 0.14;
      const isVideo = (ctx.opts.assetKinds?.[layer.assetId] ?? "image") === "video";
      const media = mediaElement(ctx, layer.assetId, `ef-${layer.id}-scr`, win, { cls: "media", style: "object-fit:cover;object-position:50% 0%", trimIn: 0, rate: 1, muted: true, video: isVideo });
      return `<div id="${id}-ins" style="position:absolute;left:${px(r0.left)};top:${px(r0.top)};width:${px(r0.width)};height:${px(r0.height)};border-radius:${px(radius)};overflow:hidden;background:#000;box-shadow:0 0 0 1px rgba(0,0,0,.6)">${media}<div style="position:absolute;inset:0;background:linear-gradient(120deg,rgba(255,255,255,.14),rgba(255,255,255,0) 40%);pointer-events:none"></div></div>`;
    }
    case "outline-glow": {
      const cut = objectCutout(seg, layer.target.objectId);
      if (!cut || !seg || seg.status !== "succeeded" || (seg.trackingQuality ?? 1) < 0.5) return null;
      const r1 = W * (0.006 + 0.012 * I);
      const r2 = W * (0.02 + 0.03 * I);
      if (!ctx.still) {
        const reps = Math.max(0, Math.ceil((win.end - win.start) / 1.2) - 1);
        ctx.tl.push(`tl.fromTo(${sel("glow")}, {opacity:0.75}, {opacity:1, duration:1.2, ease:"sine.inOut", yoyo:true, repeat:${reps}}, ${n(win.start)});`);
      }
      return `<div id="${id}-glow" style="position:absolute;inset:0;filter:drop-shadow(0 0 ${px(r1)} ${withAlpha(rgb, 0.95)}) drop-shadow(0 0 ${px(r2)} ${withAlpha(rgb, 0.7)})">${clipVideo(ctx, cut, `ef-${layer.id}-cut`, map, win, sceneStart)}</div>`;
    }
    case "focus-blur": {
      const cut = objectCutout(seg, layer.target.objectId);
      const source = seg?.sourceAssetId;
      if (!cut || !source || !seg || seg.status !== "succeeded" || (seg.trackingQuality ?? 1) < 0.5) return null;
      const blur = W * (0.006 + 0.02 * I);
      return `<div style="position:absolute;inset:0;overflow:hidden"><div style="position:absolute;inset:0;filter:blur(${px(blur)}) saturate(0.9);transform:scale(1.04)">${clipVideo(ctx, source, `ef-${layer.id}-bg`, map, win, sceneStart)}</div><div style="position:absolute;inset:0;background:rgba(0,0,0,${n(0.12 * I)})"></div>${clipVideo(ctx, cut, `ef-${layer.id}-cut`, map, win, sceneStart)}</div>`;
    }
  }
}

function resolveMask(ctx: Ctx, assetId: string, mask: MaskUse | undefined): { assetId: string } | null {
  if (!mask) return { assetId };
  const seg = ctx.opts.segmentations?.[mask.segmentationId];
  const usable = seg && seg.status === "succeeded" && seg.cutoutAssetId && (seg.trackingQuality ?? 1) >= 0.5 && mask.mode === "cutout";
  if (usable) return { assetId: seg.cutoutAssetId! };
  return mask.fallback === "hide" ? null : { assetId };
}

/** `;object-position:X% Y%` for a cover-cropped image/video (omitted = the browser's centred default). */
function objectPosition(p: { x: number; y: number } | undefined): string {
  return p ? `;object-position:${n(p.x * 100, 2)}% ${n(p.y * 100, 2)}%` : "";
}

// --- ui-popout: lifted element --------------------------------------------------------------------

type ImageL = Extract<Layer, { type: "image" }>;

/** The cropped real UI element with its (initially hidden) lift shadow, sheen and privacy patches. */
function liftedImage(ctx: Ctx, layer: ImageL, id: string, w: number, h: number, crop: string, win: Window): string {
  const lift = layer.lift!;
  const R = layer.radiusPx;
  const st = ctx.still;
  const tilt = st ? `transform:perspective(1200px) rotateX(${n(lift.tilt.x, 2)}deg) rotateY(${n(lift.tilt.y, 2)}deg);` : "";
  const media = mediaElement(ctx, layer.assetId, `i-${layer.id}`, win, { cls: "media", style: `object-fit:cover${objectPosition(layer.objectPosition)};border-radius:${px(st ? R : 0)}${crop}`, trimIn: 0, rate: 1, muted: true, video: false });
  const shadow = `0 ${px(h * 0.16)} ${px(h * 0.34)} rgba(10,14,28,.34),0 ${px(h * 0.04)} ${px(h * 0.1)} rgba(10,14,28,.22)`;
  return `<div id="${id}-lift" style="position:absolute;inset:0;transform-origin:50% 60%;${tilt}">`
    + `<div id="${id}-sh" style="position:absolute;inset:0;border-radius:${px(R)};box-shadow:${shadow};background:#fff;opacity:${st ? 1 : 0}"></div>`
    + media
    + blurPatches(ctx, layer.blurRegions, id, w, h, w * 0.035, 2, win, null)
    + `<div id="${id}-gl" style="position:absolute;inset:0;border-radius:${px(R)};background:linear-gradient(125deg,rgba(255,255,255,.22),rgba(255,255,255,0) 42%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.35);pointer-events:none;z-index:3;opacity:${st ? 1 : 0}"></div>`
    + `</div>`;
}

/**
 * Lift: the layer sits exactly over the element on the screen (`from`) until `atSec`, then rises to its
 * own box (bigger, toward the viewer) with shadow, rounding and a 3D tilt, and floats with a gentle
 * parallax sway. Numbers and our own ids only.
 */
function liftMotion(ctx: Ctx, layer: ImageL, id: string, win: Window) {
  const { W, H, tl } = ctx;
  const lift = layer.lift!;
  const b = layer.box;
  const from = lift.from;
  const s0 = Math.max(0.05, Math.min(from.w / Math.max(1e-6, b.w), from.h / Math.max(1e-6, b.h)));
  const dx = (from.x + from.w / 2 - (b.x + b.w / 2)) * W;
  const dy = (from.y + from.h / 2 - (b.y + b.h / 2)) * H;
  const at = Math.max(win.start, Math.min(win.start + lift.atSec, win.end - 0.25));
  const D = Math.max(0.2, Math.min(lift.durationSec, win.end - at - 0.05));
  const k = `q("${id}-k")`;
  const R = layer.radiusPx;
  const fromK = `{x:${n(dx, 1)}, y:${n(dy, 1)}, scale:${n(s0, 4)}}`;
  tl.push(`tl.set(${k}, ${fromK}, ${n(win.start)});`);
  tl.push(`tl.fromTo(${k}, ${fromK}, {x:0, y:0, scale:1, duration:${n(D)}, ease:"power3.out", immediateRender:false}, ${n(at)});`);
  tl.push(`tl.fromTo(q("${id}-lift"), {rotationX:0, rotationY:0, transformPerspective:1200}, {rotationX:${n(lift.tilt.x, 2)}, rotationY:${n(lift.tilt.y, 2)}, transformPerspective:1200, duration:${n(D)}, ease:"power2.out", immediateRender:false}, ${n(at)});`);
  tl.push(`tl.fromTo([q("${id}-sh"), q("${id}-gl")], {opacity:0}, {opacity:1, duration:${n(D * 0.8)}, ease:"power2.out", immediateRender:false}, ${n(at)});`);
  tl.push(`tl.fromTo([q("i-${layer.id}"), q("${id}-sh"), q("${id}-gl")], {borderRadius:0}, {borderRadius:${n(R, 1)}, duration:${n(D)}, ease:"power2.out", immediateRender:false}, ${n(at)});`);
  // Parallax float: the element bobs and sways a little (the device behind it drifts the other way).
  const rest = win.end - (at + D);
  if (rest > 0.4) {
    const half = 1.5;
    const reps = Math.max(0, Math.ceil(rest / half) - 1);
    tl.push(`tl.fromTo(q("${id}-l"), {y:0}, {y:${n(-H * 0.008, 1)}, duration:${half}, ease:"sine.inOut", yoyo:true, repeat:${reps}, immediateRender:false}, ${n(at + D)});`);
    tl.push(`tl.fromTo(q("${id}-lift"), {rotationY:${n(lift.tilt.y, 2)}}, {rotationY:${n(lift.tilt.y * 0.45, 2)}, duration:${n(half * 1.3)}, ease:"sine.inOut", yoyo:true, repeat:${Math.max(0, Math.ceil(rest / (half * 1.3)) - 1)}, immediateRender:false}, ${n(at + D)});`);
  }
}

// --- text ---------------------------------------------------------------------------------------

function splitWords(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

function textHtml(ctx: Ctx, layer: Extract<Layer, { type: "text" }>, w: number, h: number): string {
  const { doc } = ctx;
  const th = doc.theme;
  const s = layer.style;
  const pad = s.background ? s.background.paddingPx : 0;
  // Fit: shrink (never grow) so the text stays inside its box.
  const wf = fontWidthFactor(styleFont(th, s.font));
  const est = estimateTextHeight(layer.text, s.sizePx, s.lineHeight, Math.max(1, w - pad * 2), s.uppercase, wf);
  const longest = Math.max(...layer.text.split(/\s+/).map((x) => x.length), 1);
  const glyph = s.sizePx * (s.uppercase ? 0.6 : 0.54) * wf;
  const fitH = est.heightPx > 0 ? (h - pad * 2) / est.heightPx : 1;
  const fitW = (w - pad * 2) / (longest * glyph);
  const fit = Math.max(0.55, Math.min(1, fitH, fitW));
  const size = s.sizePx * fit;
  const color = themeColor(th, s.color, th.text);
  const hlColor = s.highlight ? themeColor(th, s.highlight.color, th.accent) : null;
  const hlWords = new Set((s.highlight?.words ?? []).map((x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")));
  const enter = layer.animation.enter?.preset;
  const perChar = !ctx.still && enter === "typewriter";
  const perWord = !ctx.still && (enter === "mask-reveal" || enter === "words");
  const tokens = splitWords(layer.text);
  const body = tokens
    .map((t) => {
      if (/^\s+$/.test(t)) return t.includes("\n") ? "<br/>" : " ";
      const key = t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      const hl = hlColor && hlWords.has(key) ? ` style="color:${hlColor}"` : "";
      const inner = perChar ? [...t].map((c) => `<span class="ch">${esc(c)}</span>`).join("") : esc(t);
      if (perWord) return `<span class="w"><span class="wi"${hl}>${inner}</span></span>`;
      return hl ? `<span class="hl"${hl}>${inner}</span>` : inner;
    })
    .join("");
  const align = s.align;
  const justify = align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
  const bg = s.background ? `background:${themeColor(th, s.background.color, th.surface)};padding:${px(pad)} ${px(pad * 1.25)};border-radius:${px(s.background.radiusPx)};` : "";
  const shadow = s.shadow ? `text-shadow:0 ${px(size * 0.04)} ${px(size * 0.22)} rgba(0,0,0,.28);` : "";
  const weight = Math.round(fontWeight(styleFont(th, s.font), s.weight));
  const style = [
    `font-family:${fontStack(th, s.font)}`,
    `font-size:${px(size)}`,
    `font-weight:${weight}`,
    `line-height:${n(s.lineHeight)}`,
    `letter-spacing:${n(s.letterSpacing)}em`,
    `color:${color}`,
    `text-align:${align}`,
    s.italic ? "font-style:italic" : "",
    s.uppercase ? "text-transform:uppercase" : "",
    `font-variation-settings:'opsz' ${size >= 32 ? 32 : 14}`,
  ]
    .filter(Boolean)
    .join(";");
  return `<div class="txt" style="align-items:${justify}"><div class="tb" style="${style};${bg}${shadow}">${body}</div></div>`;
}

// --- device -------------------------------------------------------------------------------------

type DeviceL = Extract<Layer, { type: "device" }>;

/** Frames for landscape footage (TV, desktop, web): wide screens that sit small in a tall video frame. */
const WIDE_DEVICES = new Set(["tv", "browser", "macbook"]);
export const isWideDevice = (device: string) => WIDE_DEVICES.has(device);
/** An automatic push-in never makes a wide screen more than this many frame widths wide. */
const WIDE_ZOOM_MAX_FRAME_WIDTHS = 1.75;

/** Push-in scale + translation that brings the focus region to a comfortable size near the device's centre. */
function focusMove(ctx: Ctx, layer: DeviceL, g: DeviceGeometry, left: number, top: number, w: number, h: number) {
  const f = layer.focus!;
  const { W, H } = ctx;
  const landscape = W > H * 1.1;
  const portrait = H > W * 1.1;
  const wide = isWideDevice(layer.device);
  const rw = Math.max(4, f.w * g.screen.width);
  const rh = Math.max(4, f.h * g.screen.height);
  const ox = g.screen.left + (f.x + f.w / 2) * g.screen.width;
  const oy = g.screen.top + (f.y + f.h / 2) * g.screen.height;
  const auto = Math.min(((landscape ? 0.5 : 0.78) * W) / rw, ((portrait ? 0.42 : 0.6) * H) / rh);
  // A wide screen sits small in a tall frame, so making its region fill the frame would blow the
  // screen up to ~3 frame widths: the shot becomes a few inches of one screen (on footage that keeps
  // moving, often a dark, empty patch of a game or a loading screen). Its automatic close-up stays a
  // big slice of the screen instead. Phones and tablets keep the stronger push-in.
  const cap = wide ? Math.max(1.2, (WIDE_ZOOM_MAX_FRAME_WIDTHS * W) / Math.max(1, g.screen.width)) : 3.2;
  const S = f.zoom ?? Math.max(1.2, Math.min(3.2, cap, auto));
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const tx = clamp(left + w / 2, W * 0.3, W * 0.7);
  const ty = clamp(top + h / 2, H * 0.35, H * 0.65);
  // A gentle push-in (≈1.3×) only drifts toward the centre; a real close-up brings the region to it.
  const k = clamp((S - 1) / 0.8, 0.3, 1);
  let dx = (tx - (left + ox)) * k;
  const dy = (ty - (top + oy)) * k;
  if (wide && g.screen.width * S >= W) {
    // A wide screen pushed in past the frame's width keeps covering it: no empty strip beside it.
    const edge = (sx: number) => left + ox + S * (sx - ox);
    dx = clamp(dx, W - edge(g.screen.left + g.screen.width), -edge(g.screen.left));
  }
  return { S, ox, oy, dx, dy };
}

/** The device's media clock (video screens only): tracked regions are timed against it. */
function deviceClock(layer: DeviceL): MediaClock | null {
  return layer.screenKind === "video" ? { trimIn: layer.trimInSec, rate: layer.playbackRate ?? 1 } : null;
}

/** A tracked focus region (video screens with a SAM path); null for a fixed one. */
function focusPath(layer: DeviceL) {
  const p = layer.focus?.path;
  return p && p.length >= 2 && layer.screenKind === "video" ? p : null;
}

/** Blur regions, focus ring, lift socket and tap marks drawn inside the device screen (fractions of the screen). */
function screenOverlays(ctx: Ctx, layer: DeviceL, id: string, sw: number, sh: number, S: number, win: Window): string {
  const th = ctx.doc.theme;
  const accent = th.accent.slice(0, 7);
  const out: string[] = [];
  out.push(blurPatches(ctx, layer.blurRegions, id, sw, sh, sw * 0.035, 4, win, deviceClock(layer)));
  const lift = layer.lift;
  if (lift) {
    // Where the lifted element was: a shallow, shadowed socket.
    const r = Math.max(4, Math.min(lift.w * sw, lift.h * sh) * 0.12);
    out.push(
      `<div id="${id}-sock" style="position:absolute;left:${px(lift.x * sw)};top:${px(lift.y * sh)};width:${px(lift.w * sw)};height:${px(lift.h * sh)};border-radius:${px(r)};background:rgba(14,16,24,.2);box-shadow:inset 0 ${px(sh * 0.004)} ${px(sh * 0.014)} rgba(0,0,0,.42);z-index:4${ctx.still ? "" : ";opacity:0"}"></div>`,
    );
  }
  const f = layer.focus;
  if (f && f.ring) {
    const pad = Math.max(sw, sh) * 0.012;
    const path = focusPath(layer);
    const f0 = path ? regionAt(path, layer.trimInSec) : f;
    const rw = f0.w * sw + pad * 2;
    const rh = f0.h * sh + pad * 2;
    const bw = Math.max(1.2, (ctx.W * 0.0045) / S);
    out.push(
      `<div id="${id}-ring" style="position:absolute;left:${px(f0.x * sw - pad)};top:${px(f0.y * sh - pad)};width:${px(rw)};height:${px(rh)};border:${px(bw)} solid ${withAlpha(accent, 0.95)};border-radius:${px(Math.min(rw, rh) * 0.2)};box-shadow:0 0 0 ${px(Math.max(sw, sh) * 2)} rgba(10,10,14,.28),0 0 ${px((ctx.W * 0.02) / S)} ${withAlpha(accent, 0.6)};z-index:5${ctx.still ? "" : ";opacity:0"}"></div>`,
    );
    // The ring follows the element through the footage.
    if (path && !ctx.still) ctx.tl.push(...sampleTweens(`q("${id}-ring")`, pathSamples(path, win, deviceClock(layer)!), (r) => ({ left: r.x * sw - pad, top: r.y * sh - pad, width: r.w * sw + pad * 2, height: r.h * sh + pad * 2 })));
  }
  const t = layer.tap;
  if (t) {
    const d = (sw * 0.17) / S;
    const cx = t.x * sw;
    const cy = t.y * sh;
    out.push(
      `<div id="${id}-tapr" style="position:absolute;left:${px(cx - d / 2)};top:${px(cy - d / 2)};width:${px(d)};height:${px(d)};border-radius:50%;border:${px(d * 0.07)} solid rgba(255,255,255,.95);box-shadow:0 0 ${px(d * 0.25)} rgba(0,0,0,.25);opacity:0;z-index:6"></div>`,
      `<div id="${id}-tapd" style="position:absolute;left:${px(cx - d * 0.36)};top:${px(cy - d * 0.36)};width:${px(d * 0.72)};height:${px(d * 0.72)};border-radius:50%;background:rgba(255,255,255,.6);border:${px(Math.max(1, d * 0.045))} solid rgba(255,255,255,.92);box-shadow:0 ${px(d * 0.08)} ${px(d * 0.3)} rgba(0,0,0,.35);z-index:6${ctx.still ? "" : ";opacity:0"}"></div>`,
    );
  }
  return out.join("");
}

/** When the focus push-in starts and how long it takes. */
function pushTiming(atSec: number, win: Window): { t0: number; dur: number } {
  const t0 = Math.min(win.start + atSec, win.end - 0.2);
  return { t0, dur: Math.max(0.3, Math.min(1.15, win.end - t0 - 0.1)) };
}

/**
 * After the push-in lands, keep the tracked element where it landed: the zoom wrapper (scaled S about
 * the landing point) is translated by −S × the element's movement on the screen. Smoothed like a camera
 * operator, and never more than a third of the frame away from the landing framing.
 */
function followFocus(ctx: Ctx, layer: DeviceL, id: string, g: DeviceGeometry, left: number, move: ReturnType<typeof focusMove>, path: readonly RegionPathPoint[], win: Window, push: { t0: number; dur: number }) {
  const start = push.t0 + push.dur;
  if (start >= win.end - 0.1) return;
  const clock = deviceClock(layer)!;
  const samples = pathSamples(path, { start, end: win.end }, clock);
  const center = (r: Region01) => ({ x: g.screen.left + (r.x + r.w / 2) * g.screen.width, y: g.screen.top + (r.y + r.h / 2) * g.screen.height });
  const raw = samples.map((s) => ({ tc: s.tc, c: center(s.r) }));
  // Camera smoothing: centred moving average over ±2 samples.
  const smooth = raw.map((s, i) => {
    let x = 0;
    let y = 0;
    let k = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(raw.length - 1, i + 2); j++) {
      x += raw[j]!.c.x;
      y += raw[j]!.c.y;
      k++;
    }
    return { tc: s.tc, x: x / k, y: y / k };
  });
  const c0 = smooth[0]!;
  const { W, H } = ctx;
  const wide = isWideDevice(layer.device) && g.screen.width * move.S >= W;
  const edge = (sx: number) => left + move.ox + move.S * (sx - move.ox);
  const pos = (s: { x: number; y: number }) => {
    let dx = move.dx - move.S * (s.x - c0.x);
    const dy = move.dy - move.S * (s.y - c0.y);
    dx = Math.max(move.dx - W / 3, Math.min(move.dx + W / 3, dx));
    if (wide) dx = Math.max(W - edge(g.screen.left + g.screen.width), Math.min(-edge(g.screen.left), dx));
    return { x: dx, y: Math.max(move.dy - H / 3, Math.min(move.dy + H / 3, dy)) };
  };
  const sel = `q("${id}-z")`;
  for (let i = 1; i < smooth.length; i++) {
    const a = smooth[i - 1]!;
    const b = smooth[i]!;
    const pa = pos(a);
    const pb = pos(b);
    ctx.tl.push(`tl.fromTo(${sel}, {x:${n(pa.x, 1)}, y:${n(pa.y, 1)}}, {x:${n(pb.x, 1)}, y:${n(pb.y, 1)}, duration:${n(Math.max(0.01, b.tc - a.tc))}, ease:"none", immediateRender:false}, ${n(a.tc)});`);
  }
}

/** Timeline for focus push-in, ring, tap and 3D tilt (numbers + our own ids only). */
function deviceMotion(ctx: Ctx, layer: DeviceL, id: string, win: Window, move: ReturnType<typeof focusMove> | null) {
  const tl = ctx.tl;
  const life = win.end - win.start;
  if (move) {
    const { t0, dur } = pushTiming(layer.focus!.atSec, win);
    tl.push(`tl.fromTo(q("${id}-z"), {x:0, y:0, scale:1}, {x:${n(move.dx, 1)}, y:${n(move.dy, 1)}, scale:${n(move.S)}, duration:${n(dur)}, ease:"power3.inOut"}, ${n(t0)});`);
    if (layer.focus!.ring) tl.push(`tl.fromTo(q("${id}-ring"), {opacity:0, scale:1.08}, {opacity:1, scale:1, duration:0.45, ease:"power2.out"}, ${n(t0 + dur * 0.8)});`);
  }
  const t = layer.tap;
  if (t) {
    const at = Math.max(win.start + 0.45, Math.min(win.start + t.atSec, win.end - 0.5));
    const travel = ctx.W * 0.06;
    tl.push(`tl.fromTo(q("${id}-tapd"), {opacity:0, x:${n(travel, 1)}, y:${n(travel * 1.5, 1)}, scale:1.15}, {opacity:1, x:0, y:0, scale:1, duration:0.42, ease:"power2.out"}, ${n(at - 0.42)});`);
    tl.push(`tl.fromTo(q("${id}-tapd"), {scale:1}, {scale:0.78, duration:0.12, ease:"power1.in", immediateRender:false}, ${n(at)});`);
    tl.push(`tl.fromTo(q("${id}-tapd"), {scale:0.78}, {scale:1, duration:0.2, ease:"power1.out", immediateRender:false}, ${n(at + 0.12)});`);
    tl.push(`tl.fromTo(q("${id}-tapr"), {opacity:0.95, scale:0.45}, {opacity:0, scale:2.3, duration:0.75, ease:"power2.out"}, ${n(at)});`);
    tl.push(`tl.fromTo(q("${id}-tapd"), {opacity:1}, {opacity:0, duration:0.35, ease:"power1.in", immediateRender:false}, ${n(Math.min(at + 0.9, win.end - 0.36))});`);
  }
  const lift = layer.lift;
  if (lift) {
    const at = Math.max(win.start, Math.min(win.start + lift.atSec, win.end - 0.25));
    tl.push(`tl.fromTo(q("${id}-sock"), {opacity:0}, {opacity:1, duration:0.4, ease:"power2.out", immediateRender:false}, ${n(at)});`);
    if (lift.recede && !move) {
      // Depth: the device steps back and dims as the element comes forward, then drifts the other way.
      tl.push(`tl.fromTo(q("${id}-z"), {scale:1, filter:"brightness(1) saturate(1)"}, {scale:0.95, filter:"brightness(0.86) saturate(0.9)", duration:0.85, ease:"power3.out", immediateRender:false}, ${n(at)});`);
      const rest = win.end - at - 0.85;
      if (rest > 0.3) tl.push(`tl.fromTo(q("${id}-z"), {y:0}, {y:${n(ctx.H * 0.006, 1)}, duration:${n(rest)}, ease:"sine.inOut", immediateRender:false}, ${n(at + 0.85)});`);
    }
  }
  const tilt = layer.tilt;
  if (tilt) {
    const toX = tilt.swing ? tilt.x * 0.35 : tilt.x;
    const toY = tilt.swing ? -tilt.y * 0.3 : tilt.y;
    tl.push(`tl.fromTo(q("${id}-t"), {rotationX:${n(tilt.x, 2)}, rotationY:${n(tilt.y, 2)}, transformPerspective:1600}, {rotationX:${n(toX, 2)}, rotationY:${n(toY, 2)}, transformPerspective:1600, duration:${n(life)}, ease:"sine.inOut"}, ${n(win.start)});`);
  }
}

function deviceHtml(ctx: Ctx, layer: DeviceL, w: number, h: number, win: Window, left = 0, top = 0): string {
  const spec = DEVICES[layer.device] ?? DEVICES.iphone!;
  const g = deviceGeometry(layer.device, w, h);
  const { dw, dh, ox, oy } = g;
  const fc = FRAME_COLORS[layer.frameColor] ?? FRAME_COLORS.black!;
  const media = mediaElement(ctx, layer.screenAssetId, layer.screenKind === "video" ? `v-${layer.id}` : `i-${layer.id}`, win, {
    cls: "media",
    // Same fit as mediaToScreen (build.ts) assumes, so focus/tap/blur regions land on the right pixels.
    ...(screenAlign(layer.device) === "center" ? { style: "object-position:50% 50%" } : {}),
    trimIn: layer.trimInSec,
    rate: layer.screenKind === "video" ? (layer.playbackRate ?? 1) : 1,
    muted: true,
    video: layer.screenKind === "video",
  });
  const id = `l-${layer.id}`;
  // A tracked focus pushes in on where the element is when the push-in lands, then follows it.
  const path = focusPath(layer);
  const push = layer.focus ? pushTiming(layer.focus.atSec, win) : null;
  const landed = path && push ? { ...layer, focus: { ...layer.focus!, ...regionAt(path, layer.trimInSec + (push.t0 + push.dur - win.start) * (layer.playbackRate ?? 1)) } } : layer;
  const move = layer.focus ? focusMove(ctx, landed, g, left, top, w, h) : null;
  const overlays = screenOverlays(ctx, layer, id, g.screen.width, g.screen.height, move?.S ?? 1, win);
  if (!ctx.still) deviceMotion(ctx, layer, id, win, move);
  if (!ctx.still && path && move && push) followFocus(ctx, layer, id, g, left, move, path, win, push);
  // Wrappers: tilt (3D) → zoom (push-in about the focus point) → the device itself.
  const wrap = (frame: string) => {
    const recede = layer.lift?.recede && !move && ctx.still ? "transform:scale(0.95);filter:brightness(0.86) saturate(0.9);" : "";
    const zStyle = move ? `transform-origin:${px(move.ox)} ${px(move.oy)};${ctx.still ? `transform:translate(${px(move.dx)},${px(move.dy)}) scale(${n(move.S)});` : ""}` : recede;
    let out = move || overlays ? `<div class="dz" id="${id}-z" style="position:absolute;inset:0;${zStyle}">${frame}</div>` : frame;
    if (layer.tilt) out = `<div class="dt" id="${id}-t" style="position:absolute;inset:0;transform:perspective(1600px) rotateX(${n(layer.tilt.x, 2)}deg) rotateY(${n(layer.tilt.y, 2)}deg)">${out}</div>`;
    return out;
  };
  const screenExtra = overlays;
  // Shadows are tinted with the app's own colour (a deep shade of the accent), so every shot shares one light.
  const sh = shadowTint(ctx.doc.theme);
  const shadow = layer.shadow
    ? `box-shadow:0 ${px(dh * 0.05)} ${px(dh * 0.1)} ${withAlpha(sh, 0.3)},0 ${px(dh * 0.014)} ${px(dh * 0.028)} ${withAlpha(sh, 0.22)};`
    : "";
  if (layer.device === "browser") {
    const bar = Math.max(28, dh * 0.055);
    const dot = bar * 0.28;
    const r = dw * spec.outerRadius;
    const dots = ["#ff5f57", "#febc2e", "#28c840"].map((c, i) => `<span style="position:absolute;left:${px(bar * 0.45 + i * dot * 1.7)};top:${px((bar - dot) / 2)};width:${px(dot)};height:${px(dot)};border-radius:50%;background:${c}"></span>`).join("");
    return wrap(`<div class="dev dev-browser" style="left:${px(ox)};top:${px(oy)};width:${px(dw)};height:${px(dh)};border-radius:${px(r)};${shadow}overflow:hidden;background:#fff">
<div style="position:absolute;left:0;top:0;width:100%;height:${px(bar)};background:linear-gradient(#f6f6f7,#ececee);border-bottom:1px solid rgba(0,0,0,.08)">${dots}<span style="position:absolute;left:30%;width:40%;top:${px(bar * 0.22)};height:${px(bar * 0.56)};border-radius:${px(bar * 0.28)};background:rgba(0,0,0,.06)"></span></div>
<div class="dev-screen" style="left:0;top:${px(bar)};width:100%;height:${px(dh - bar)};background:#fff">${media}${screenExtra}</div></div>`);
  }
  if (layer.device === "macbook") {
    const lidH = dh * 0.9;
    const bz = dw * spec.bezel;
    const r = dw * spec.outerRadius;
    return wrap(`<div class="dev dev-macbook" style="left:${px(ox)};top:${px(oy)};width:${px(dw)};height:${px(dh)}">
<div style="position:absolute;left:${px(dw * 0.06)};top:0;width:${px(dw * 0.88)};height:${px(lidH)};border-radius:${px(r)} ${px(r)} ${px(r * 0.3)} ${px(r * 0.3)};background:#0d0d0f;border:${px(Math.max(1, dw * 0.003))} solid ${fc.edge};${shadow}">
<div class="dev-screen" style="left:${px(bz)};top:${px(bz)};width:${px(dw * 0.88 - bz * 2)};height:${px(lidH - bz * 2.2)};border-radius:${px(dw * spec.screenRadius)}">${media}${screenExtra}</div></div>
<div style="position:absolute;left:0;top:${px(lidH)};width:100%;height:${px(dh - lidH)};border-radius:0 0 ${px(dh * 0.08)} ${px(dh * 0.08)};background:linear-gradient(${fc.hi},${fc.body} 45%,${fc.edge})"></div></div>`);
  }
  if (layer.device === "tv") {
    // Thin near-black bezel with a faint metal rim, glass sheen on the screen, slim pedestal stand.
    const sw = g.screen.width;
    const sh = g.screen.height;
    const bz = g.screen.left - ox;
    const panelH = sh + bz * 2;
    const standH = dh - panelH;
    const R = dw * spec.outerRadius;
    const rim = Math.max(1, dw * 0.0016);
    const neckW = dw * 0.042;
    const baseW = dw * 0.27;
    const baseH = Math.max(3, standH * 0.24);
    const baseTop = dh - baseH - standH * 0.08;
    const panelShadow = layer.shadow ? `0 ${px(dh * 0.05)} ${px(dh * 0.1)} rgba(15,20,35,.28),0 ${px(dh * 0.014)} ${px(dh * 0.03)} rgba(15,20,35,.2),` : "";
    const floor = layer.shadow
      ? `<div style="position:absolute;left:${px((dw - baseW * 1.5) / 2)};top:${px(baseTop + baseH * 0.2)};width:${px(baseW * 1.5)};height:${px(baseH * 1.9)};border-radius:50%;background:radial-gradient(closest-side,rgba(15,20,35,.32),rgba(15,20,35,0))"></div>`
      : "";
    return wrap(`<div class="dev dev-tv" style="left:${px(ox)};top:${px(oy)};width:${px(dw)};height:${px(dh)}">${floor}
<div style="position:absolute;left:${px((dw - neckW) / 2)};top:${px(panelH - 1)};width:${px(neckW)};height:${px(baseTop - panelH + 2)};background:linear-gradient(90deg,${fc.edge},${fc.hi} 50%,${fc.edge})"></div>
<div style="position:absolute;left:${px((dw - baseW) / 2)};top:${px(baseTop)};width:${px(baseW)};height:${px(baseH)};border-radius:${px(baseH * 0.35)} ${px(baseH * 0.35)} ${px(baseH * 0.5)} ${px(baseH * 0.5)};background:linear-gradient(${fc.hi},${fc.body} 38%,${fc.edge})"></div>
<div class="dev-body" style="height:${px(panelH)};border-radius:${px(R)};background:linear-gradient(180deg,#1b1b1e,#0b0b0d 55%,#060607);box-shadow:${panelShadow}inset 0 0 0 ${px(rim)} ${withAlpha(fc.edge, 0.95)},inset 0 ${px(rim * 2)} ${px(rim * 2)} rgba(255,255,255,.06)">
<div class="dev-screen" style="left:${px(bz)};top:${px(bz)};width:${px(sw)};height:${px(sh)};border-radius:${px(dw * spec.screenRadius)}">${media}<div style="position:absolute;inset:0;background:linear-gradient(118deg,rgba(255,255,255,.08),rgba(255,255,255,0) 34%);pointer-events:none;z-index:2"></div>${screenExtra}</div>
</div></div>`);
  }
  const bz = dw * spec.bezel;
  const R = dw * spec.outerRadius;
  const r = dw * spec.screenRadius;
  // Metal band, then the black glass bezel. Light comes from the upper left (as in product shots).
  const rim = Math.max(2, dw * 0.011);
  const light = fc === FRAME_COLORS.black ? 0.34 : 0.7;
  const iw = dw - bz * 2;
  const island =
    layer.device === "iphone"
      ? `<div style="position:absolute;left:${px(iw * 0.335)};top:${px(dw * 0.032)};width:${px(iw * 0.33)};height:${px(dw * 0.092)};border-radius:${px(dw * 0.05)};background:#000;z-index:3"><span style="position:absolute;right:${px(dw * 0.026)};top:50%;width:${px(dw * 0.034)};height:${px(dw * 0.034)};margin-top:${px(-dw * 0.017)};border-radius:50%;background:radial-gradient(circle at 35% 35%,#2a3550 0%,#0a0d16 55%,#000 100%);box-shadow:inset 0 0 ${px(dw * 0.004)} rgba(120,140,200,.35)"></span></div>`
      : layer.device === "android"
        ? `<div style="position:absolute;left:50%;top:${px(dw * 0.03)};width:${px(dw * 0.045)};height:${px(dw * 0.045)};margin-left:${px(-dw * 0.0225)};border-radius:50%;background:radial-gradient(circle at 35% 35%,#2a3550 0%,#05070c 60%);box-shadow:0 0 0 ${px(dw * 0.004)} #000;z-index:3"></div>`
        : "";
  const button = (side: "left" | "right", top: number, height: number) =>
    `<span style="position:absolute;${side}:${px(-rim * 0.85)};top:${px(dh * top)};width:${px(rim * 1.3)};height:${px(dh * height)};border-radius:${px(rim)};background:linear-gradient(${side === "left" ? 90 : 270}deg,${fc.edge},${fc.hi} 55%,${fc.edge});box-shadow:0 ${px(rim * 0.4)} ${px(rim * 0.8)} rgba(0,0,0,.25)"></span>`;
  const buttons =
    layer.device === "iphone"
      ? button("left", 0.15, 0.035) + button("left", 0.215, 0.06) + button("left", 0.29, 0.06) + button("right", 0.25, 0.1)
      : layer.device === "android"
        ? button("right", 0.2, 0.08) + button("right", 0.31, 0.05)
        : "";
  // Antenna lines in the band (phones), a thin lighter stroke along the band's inner edge, and the glass.
  const antenna =
    layer.device === "iphone" || layer.device === "android"
      ? [0.085, 0.915].map((y) => `<span style="position:absolute;left:0;width:${px(rim)};top:${px(dh * y)};height:${px(Math.max(1, rim * 0.45))};background:rgba(0,0,0,.35)"></span><span style="position:absolute;right:0;width:${px(rim)};top:${px(dh * y)};height:${px(Math.max(1, rim * 0.45))};background:rgba(0,0,0,.35)"></span>`).join("")
      : "";
  const band = `linear-gradient(140deg,${fc.hi} 0%,${fc.edge} 12%,${fc.body} 34%,${fc.edge} 56%,${fc.body} 76%,${fc.edge} 92%,${fc.hi} 100%)`;
  const specular = `<div style="position:absolute;inset:0;border-radius:${px(R)};background:linear-gradient(90deg,rgba(255,255,255,${n(light * 0.55)}) 0%,rgba(255,255,255,0) ${n((rim / dw) * 160, 2)}%,rgba(255,255,255,0) ${n(100 - (rim / dw) * 160, 2)}%,rgba(255,255,255,${n(light * 0.25)}) 100%),linear-gradient(180deg,rgba(255,255,255,${n(light * 0.45)}) 0%,rgba(255,255,255,0) ${n((rim / dh) * 160, 2)}%);pointer-events:none"></div>`;
  const glass = `<div style="position:absolute;inset:0;border-radius:${px(r)};background:linear-gradient(118deg,rgba(255,255,255,.13) 0%,rgba(255,255,255,.04) 26%,rgba(255,255,255,0) 40%,rgba(255,255,255,0) 78%,rgba(255,255,255,.05) 100%);box-shadow:inset 0 0 ${px(dw * 0.02)} rgba(0,0,0,.28),inset 0 ${px(1)} 0 rgba(255,255,255,.12);pointer-events:none;z-index:2"></div>`;
  return wrap(`<div class="dev dev-${layer.device}" style="left:${px(ox)};top:${px(oy)};width:${px(dw)};height:${px(dh)}">${buttons}
<div class="dev-body" style="border-radius:${px(R)};background:${band};box-shadow:inset 0 0 0 ${px(Math.max(1, rim * 0.18))} rgba(0,0,0,.55),inset 0 0 0 ${px(Math.max(1, rim * 0.35))} rgba(255,255,255,${n(light * 0.3)})${shadow ? `,${shadow.slice("box-shadow:".length, -1)}` : ""}">${antenna}${specular}
<div style="position:absolute;left:${px(rim)};top:${px(rim)};right:${px(rim)};bottom:${px(rim)};border-radius:${px(R - rim)};background:radial-gradient(120% 70% at 30% 0%,#1a1a1d 0%,#060607 60%);box-shadow:inset 0 0 0 ${px(Math.max(1, rim * 0.25))} rgba(255,255,255,.06)"></div>
<div class="dev-screen" style="left:${px(bz)};top:${px(bz)};width:${px(iw)};height:${px(dh - bz * 2)};border-radius:${px(r)}">${media}${island}${glass}${screenExtra}</div>
</div></div>`);
}

/** A deep shade of the app's accent: device shadows and lighting share the brand's colour. */
function shadowTint(theme: Theme): string {
  const a = theme.accent.length >= 7 ? theme.accent.slice(0, 7) : "#0A84FF";
  const [r, g, b] = rgba(a);
  // ~82% toward a cool near-black, keeping a little of the accent's hue.
  const mixc = (c: number, base: number) => Math.round(c * 0.18 + base * 0.82);
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(mixc(r, 14))}${hex(mixc(g, 18))}${hex(mixc(b, 32))}`;
}

// --- shapes & blocks ----------------------------------------------------------------------------

function shapeHtml(ctx: Ctx, layer: Extract<Layer, { type: "shape" }>, w: number, h: number): string {
  const th = ctx.doc.theme;
  const fill = themeColor(th, layer.fill, th.accent);
  const angle = layer.shape === "rect" || layer.shape === "line" ? 180 : 135;
  const bg = layer.gradientTo ? `linear-gradient(${angle}deg,${fill},${themeColor(th, layer.gradientTo, th.accent)})` : fill;
  const radius =
    layer.shape === "circle"
      ? "50%"
      : layer.shape === "pill"
        ? `${px(Math.min(w, h) / 2)}`
        : layer.shape === "blob"
          ? "42% 58% 63% 37% / 41% 44% 56% 59%"
          : layer.shape === "line"
            ? px(h / 2)
            : px(layer.radiusPx);
  const blur = layer.blurPx ? `;filter:blur(${px(layer.blurPx)})` : "";
  return `<div class="media" style="background:${bg};border-radius:${radius}${blur}"></div>`;
}

function blockHtml(ctx: Ctx, layer: Extract<Layer, { type: "block" }>, w: number, h: number, win: Window, sceneStart: number): string {
  const th = ctx.doc.theme;
  if (!isBlockId(layer.blockId)) return "";
  const id = `l-${layer.id}`;
  switch (layer.blockId) {
    case "tap-indicator": {
      const p = BLOCK_PARAMS["tap-indicator"].parse(layer.params);
      const c = themeColor(th, p.color, "#FFFFFF");
      const d = Math.min(w, h);
      if (!ctx.still) {
        const at = n(win.start + (p.atSec ?? 0.5));
        ctx.tl.push(`tl.fromTo(q("${id}-dot"), {scale:0.4, opacity:0}, {scale:1, opacity:1, duration:0.18, ease:"power2.out"}, ${at});`);
        ctx.tl.push(`tl.fromTo(q("${id}-ring"), {scale:0.5, opacity:0.9}, {scale:1.9, opacity:0, duration:0.7, ease:"power2.out"}, ${at});`);
        ctx.tl.push(`tl.to(q("${id}-dot"), {scale:0.85, opacity:0, duration:0.3, ease:"power1.in"}, ${n(Number(at) + 0.45)});`);
      }
      void sceneStart;
      return `<div class="media" style="display:flex;align-items:center;justify-content:center"><div id="${id}-ring" style="position:absolute;width:${px(d)};height:${px(d)};border-radius:50%;border:${px(d * 0.06)} solid ${c}"></div><div id="${id}-dot" style="position:absolute;width:${px(d * 0.55)};height:${px(d * 0.55)};border-radius:50%;background:${withAlpha(c.length === 7 ? c : "#FFFFFF", 0.55)};box-shadow:0 0 ${px(d * 0.3)} rgba(0,0,0,.18)"></div></div>`;
    }
    case "store-badges": {
      const p = BLOCK_PARAMS["store-badges"].parse(layer.params);
      const pills: { small?: string; big: string }[] = [];
      if (p.ios ?? true) pills.push(p.full ? { small: "Download on the", big: "App Store" } : { big: "App Store" });
      if (p.android) pills.push(p.full ? { small: "Get it on", big: "Google Play" } : { big: "Google Play" });
      if (p.web) pills.push(p.full ? { small: "Try it on the", big: "Web" } : { big: "Web" });
      const rows = p.stack ? Math.max(1, pills.length) : 1;
      const perRow = p.stack ? 1 : Math.max(1, pills.length);
      const avail = h * (p.label ? 0.75 : 1);
      const pillH = Math.min(avail / rows / (p.stack ? 1.3 : 1), w / perRow / (p.full ? 3.6 : 2.6));
      const dark = luminance(th.background) > 0.4;
      const fg = dark ? "#FFFFFF" : "#000000";
      const bgc = dark ? "#000000" : "#FFFFFF";
      const label = p.label ? `<div style="font-family:${fontStack(th, "body")};font-size:${px(pillH * 0.34)};font-weight:600;letter-spacing:.02em;color:${th.textMuted};margin-bottom:${px(pillH * 0.22)};text-transform:uppercase">${esc(p.label)}</div>` : "";
      const pillW = p.full ? pillH * 3.3 : undefined;
      return `<div class="media" style="display:flex;flex-direction:column;align-items:center;justify-content:center">${label}<div style="display:flex;flex-direction:${p.stack ? "column" : "row"};gap:${px(pillH * 0.3)}">${pills
        .map(
          (t) =>
            `<div style="height:${px(pillH)};${pillW ? `width:${px(pillW)};justify-content:center;` : ""}padding:0 ${px(pillH * 0.5)};border-radius:${px(pillH * 0.26)};background:${bgc};color:${fg};display:flex;flex-direction:column;align-items:${pillW ? "center" : "flex-start"};justify-content:center;font-family:${fontStack(th, "body")};white-space:nowrap">${t.small ? `<span style="font-size:${px(pillH * 0.2)};font-weight:500;letter-spacing:.01em;line-height:1.1;opacity:.9">${esc(t.small)}</span>` : ""}<span style="font-size:${px(pillH * (t.small ? 0.36 : 0.4))};font-weight:600;letter-spacing:-0.01em;line-height:1.1">${esc(t.big)}</span></div>`,
        )
        .join("")}</div></div>`;
    }
    case "progress-bar": {
      const p = BLOCK_PARAMS["progress-bar"].parse(layer.params);
      const c = themeColor(th, p.color, th.accent);
      if (!ctx.still) ctx.tl.push(`tl.fromTo(q("${id}-fill"), {scaleX:0}, {scaleX:1, duration:${n(win.end - win.start)}, ease:"none"}, ${n(win.start)});`);
      return `<div class="media" style="border-radius:${px(h / 2)};background:${withAlpha(c.length === 7 ? c : "#000000", 0.18)};overflow:hidden"><div id="${id}-fill" style="position:absolute;inset:0;background:${c};transform-origin:0 50%"></div></div>`;
    }
    case "page-dots": {
      const p = BLOCK_PARAMS["page-dots"].parse(layer.params);
      const on = themeColor(th, p.color, th.accent);
      const off = themeColor(th, p.inactive, withAlpha(th.text.slice(0, 7), 0.2));
      const d = Math.min(h * 0.62, w / Math.max(1, p.count * 2.2 + 2));
      const dots = Array.from({ length: p.count }, (_, i) =>
        `<span style="display:block;flex:none;height:${px(d)};width:${px(i + 1 === p.active ? d * 2.6 : d)};border-radius:${px(d / 2)};background:${i + 1 === p.active ? on : off}"></span>`,
      ).join("");
      return `<div class="media" style="display:flex;align-items:center;justify-content:${p.align === "center" ? "center" : "flex-start"};gap:${px(d * 0.9)}">${dots}</div>`;
    }
    case "callout-chip": {
      const p = BLOCK_PARAMS["callout-chip"].parse(layer.params);
      const c = themeColor(th, p.color, th.accent);
      const fs = Math.min(h * 0.42, (w / Math.max(4, p.text.length)) * 1.6);
      return `<div class="media" style="display:flex;align-items:center;justify-content:center"><div style="display:flex;align-items:center;gap:${px(fs * 0.5)};height:${px(h)};padding:0 ${px(h * 0.42)};border-radius:${px(h / 2)};background:rgba(255,255,255,.92);box-shadow:0 ${px(h * 0.12)} ${px(h * 0.4)} rgba(15,20,35,.16),0 0 0 1px rgba(15,20,35,.05);font-family:${fontStack(th, "body")};font-size:${px(fs)};font-weight:600;letter-spacing:-0.01em;color:#1d1d1f;white-space:nowrap"><span style="width:${px(fs * 0.55)};height:${px(fs * 0.55)};border-radius:50%;background:${c};flex:none"></span>${esc(p.text)}</div></div>`;
    }
  }
}

// --- animation ----------------------------------------------------------------------------------

function animateLayer(ctx: Ctx, layer: Layer, id: string, win: Window, sceneStart: number, opening = false) {
  const { H, W } = ctx;
  const a = layer.animation;
  const D = H * 0.035;
  const life = win.end - win.start;
  const tl = ctx.tl;
  const sel = `q("${id}-e")`;
  if (opening && a.enter && a.enter.preset !== "none") {
    // Opening frame: on screen at frame 0 (never from opacity 0, a mask or a blur); the entrance
    // becomes a short settle into place. Text drifts a touch more than media.
    const s = settleTiming(a.enter);
    const text = layer.type === "text";
    tl.push(`tl.fromTo(${sel}, {scale:${text ? 1.045 : 1.03}, y:${n(D * (text ? 0.3 : 0.2), 1)}}, {scale:1, y:0, duration:${n(Math.min(s.durationSec, life))}, ease:"power3.out"}, ${n(win.start + s.delaySec)});`);
  } else if (a.enter && a.enter.preset !== "none") {
    const t = n(win.start + a.enter.delaySec);
    const dur = n(Math.max(0.05, Math.min(a.enter.durationSec, life)));
    const ease = J(EASE_IN[a.enter.easing] ?? "power3.out");
    switch (a.enter.preset) {
      case "fade":
        tl.push(`tl.fromTo(${sel}, {opacity:0}, {opacity:1, duration:${dur}, ease:${ease}}, ${t});`);
        break;
      case "slide-up":
      case "slide-down":
      case "slide-left":
      case "slide-right": {
        const prop = a.enter.preset === "slide-up" || a.enter.preset === "slide-down" ? "y" : "x";
        const sign = a.enter.preset === "slide-up" || a.enter.preset === "slide-left" ? 1 : -1;
        tl.push(`tl.fromTo(${sel}, {opacity:0, ${prop}:${n(D * sign, 1)}}, {opacity:1, ${prop}:0, duration:${dur}, ease:${ease}}, ${t});`);
        break;
      }
      case "scale-in":
        tl.push(`tl.fromTo(${sel}, {opacity:0, scale:0.86}, {opacity:1, scale:1, duration:${dur}, ease:${ease}}, ${t});`);
        break;
      case "pop":
        tl.push(`tl.fromTo(${sel}, {opacity:0, scale:0.55}, {opacity:1, scale:1, duration:${dur}, ease:"back.out(2)"}, ${t});`);
        break;
      case "blur-in":
        tl.push(`tl.fromTo(${sel}, {opacity:0, y:${n(D * 0.5, 1)}, filter:"blur(22px)"}, {opacity:1, y:0, filter:"blur(0px)", duration:${dur}, ease:${ease}}, ${t});`);
        break;
      case "typewriter":
        if (layer.type === "text") {
          const chars = layer.text.replace(/\s+/g, "").length || 1;
          tl.push(`tl.fromTo(qa("${id}", ".ch"), {opacity:0}, {opacity:1, duration:0.01, stagger:${n(Math.min(0.06, a.enter.durationSec / chars), 4)}, ease:"none"}, ${t});`);
        } else tl.push(`tl.fromTo(${sel}, {opacity:0}, {opacity:1, duration:${dur}, ease:${ease}}, ${t});`);
        break;
      case "words":
        if (layer.type === "text") {
          // Word by word at a readable pace: ~3 words per second, each word pops up into place.
          const words = layer.text.split(/\s+/).filter(Boolean).length || 1;
          const stagger = n(Math.max(0.16, Math.min(0.42, a.enter.durationSec / words)), 4);
          tl.push(`tl.fromTo(qa("${id}", ".wi"), {yPercent:70, opacity:0, scale:0.92}, {yPercent:0, opacity:1, scale:1, duration:0.34, stagger:${stagger}, ease:"back.out(1.7)"}, ${t});`);
        } else tl.push(`tl.fromTo(${sel}, {opacity:0}, {opacity:1, duration:${dur}, ease:${ease}}, ${t});`);
        break;
      case "mask-reveal":
        if (layer.type === "text") {
          const words = layer.text.split(/\s+/).filter(Boolean).length || 1;
          const stagger = n(Math.min(0.09, (a.enter.durationSec * 0.6) / words), 4);
          tl.push(`tl.fromTo(qa("${id}", ".wi"), {yPercent:118, rotation:2}, {yPercent:0, rotation:0, duration:${dur}, stagger:${stagger}, ease:${ease}}, ${t});`);
        } else {
          tl.push(`tl.fromTo(${sel}, {clipPath:"inset(100% 0% 0% 0%)", y:${n(D * 0.6, 1)}}, {clipPath:"inset(0% 0% 0% 0%)", y:0, duration:${dur}, ease:${ease}}, ${t});`);
        }
        break;
    }
  }
  if (a.exit && a.exit.preset !== "none") {
    const dur = n(Math.max(0.05, Math.min(a.exit.durationSec, life / 2)));
    const end = layer.timing.end !== undefined ? win.end : win.end; // exit finishes when the layer window closes
    const t = n(Math.max(win.start, end - dur));
    const ease = J(EASE_OUT[a.exit.easing] ?? "power2.in");
    const base = `immediateRender:false, duration:${dur}, ease:${ease}`;
    switch (a.exit.preset) {
      case "fade":
        tl.push(`tl.fromTo(${sel}, {opacity:1}, {opacity:0, ${base}}, ${t});`);
        break;
      case "slide-up":
      case "slide-down":
      case "slide-left":
      case "slide-right": {
        const prop = a.exit.preset === "slide-up" || a.exit.preset === "slide-down" ? "y" : "x";
        const sign = a.exit.preset === "slide-up" || a.exit.preset === "slide-left" ? -1 : 1;
        tl.push(`tl.fromTo(${sel}, {opacity:1, ${prop}:0}, {opacity:0, ${prop}:${n(D * sign, 1)}, ${base}}, ${t});`);
        break;
      }
      case "scale-out":
        tl.push(`tl.fromTo(${sel}, {opacity:1, scale:1}, {opacity:0, scale:0.9, ${base}}, ${t});`);
        break;
      case "blur-out":
        tl.push(`tl.fromTo(${sel}, {opacity:1, filter:"blur(0px)"}, {opacity:0, filter:"blur(22px)", ${base}}, ${t});`);
        break;
    }
  }
  const ll = `q("${id}-l")`;
  switch (a.loop) {
    case "float": {
      const half = 1.6;
      const reps = Math.max(0, Math.ceil(life / half) - 1);
      tl.push(`tl.fromTo(${ll}, {y:0}, {y:${n(-H * 0.009, 1)}, duration:${half}, ease:"sine.inOut", yoyo:true, repeat:${reps}}, ${n(win.start)});`);
      break;
    }
    case "pulse": {
      const half = 0.8;
      const reps = Math.max(0, Math.ceil(life / half) - 1);
      tl.push(`tl.fromTo(${ll}, {scale:1}, {scale:1.035, duration:${half}, ease:"sine.inOut", yoyo:true, repeat:${reps}}, ${n(win.start)});`);
      break;
    }
    case "ken-burns":
      tl.push(`tl.fromTo(${ll}, {scale:1, x:0}, {scale:1.12, x:${n(-W * 0.02, 1)}, duration:${n(life)}, ease:"sine.inOut"}, ${n(win.start)});`);
      break;
    case "slow-zoom":
      tl.push(`tl.fromTo(${ll}, {scale:1}, {scale:1.06, duration:${n(life)}, ease:"none"}, ${n(win.start)});`);
      break;
    case "tilt":
      tl.push(`tl.fromTo(${ll}, {rotationY:-9, rotationX:5, transformPerspective:1600}, {rotationY:7, rotationX:-2, transformPerspective:1600, duration:${n(life)}, ease:"sine.inOut"}, ${n(win.start)});`);
      break;
    default:
      break;
  }
  const kf = layer.anchor ? undefined : a.keyframes; // an anchor owns the -k wrapper
  if (kf && kf.length) {
    const b = layer.box;
    const val = (k: (typeof kf)[number]) => ({
      x: n(((k.x ?? b.x) - b.x) * W, 1),
      y: n(((k.y ?? b.y) - b.y) * H, 1),
      scale: k.scale ?? 1,
      rotation: k.rotation ?? 0,
      opacity: k.opacity ?? 1,
    });
    const k = `q("${id}-k")`;
    tl.push(`tl.set(${k}, ${J(val(kf[0]!))}, ${n(sceneStart)});`);
    for (let i = 1; i < kf.length; i++) {
      const prev = kf[i - 1]!;
      const cur = kf[i]!;
      const dur = n(Math.max(0.01, cur.t - prev.t));
      tl.push(`tl.fromTo(${k}, ${J(val(prev))}, ${J({ ...val(cur), duration: dur, ease: EASE_IN[cur.easing ?? "smooth"] ?? "power3.out", immediateRender: false })}, ${n(sceneStart + prev.t)});`);
    }
  }
}

function transition(ctx: Ctx, scene: Scene, prev: Scene, start: number) {
  const d = n(scene.transitionIn.durationSec);
  const t = n(start);
  const cur = `q("s-${scene.id}")`;
  const old = `q("s-${prev.id}")`;
  const tl = ctx.tl;
  switch (scene.transitionIn.kind) {
    case "fade":
      tl.push(`tl.fromTo(${cur}, {opacity:0}, {opacity:1, duration:${d}, ease:"power1.inOut"}, ${t});`);
      break;
    case "slide-left":
      tl.push(`tl.fromTo(${cur}, {xPercent:100}, {xPercent:0, duration:${d}, ease:"power3.inOut"}, ${t});`);
      tl.push(`tl.fromTo(${old}, {xPercent:0}, {xPercent:-28, duration:${d}, ease:"power3.inOut", immediateRender:false}, ${t});`);
      break;
    case "slide-up":
      tl.push(`tl.fromTo(${cur}, {yPercent:100}, {yPercent:0, duration:${d}, ease:"power3.inOut"}, ${t});`);
      tl.push(`tl.fromTo(${old}, {yPercent:0}, {yPercent:-22, duration:${d}, ease:"power3.inOut", immediateRender:false}, ${t});`);
      break;
    case "zoom":
      tl.push(`tl.fromTo(${cur}, {opacity:0, scale:1.14}, {opacity:1, scale:1, duration:${d}, ease:"power3.out"}, ${t});`);
      tl.push(`tl.fromTo(${old}, {scale:1}, {scale:0.94, duration:${d}, ease:"power2.in", immediateRender:false}, ${t});`);
      break;
    case "blur":
      tl.push(`tl.fromTo(${cur}, {opacity:0, filter:"blur(36px)"}, {opacity:1, filter:"blur(0px)", duration:${d}, ease:"power2.out"}, ${t});`);
      break;
    case "flash":
      tl.push(`tl.fromTo(${cur}, {opacity:0}, {opacity:1, duration:${n(Math.max(0.04, d * 0.25))}, ease:"none"}, ${t});`);
      tl.push(`tl.fromTo(q("fl-${scene.id}"), {opacity:0.95}, {opacity:0, duration:${d}, ease:"power2.out"}, ${t});`);
      break;
    case "wipe":
      tl.push(`tl.fromTo(${cur}, {clipPath:"inset(0% 0% 0% 100%)"}, {clipPath:"inset(0% 0% 0% 0%)", duration:${d}, ease:"power3.inOut"}, ${t});`);
      break;
    case "whip": {
      // A fast camera pan: both scenes travel together, motion-blurred at the peak of the move.
      const half = n(scene.transitionIn.durationSec / 2);
      tl.push(`tl.fromTo(${cur}, {xPercent:100}, {xPercent:0, duration:${d}, ease:"power4.inOut"}, ${t});`);
      tl.push(`tl.fromTo(${old}, {xPercent:0}, {xPercent:-100, duration:${d}, ease:"power4.inOut", immediateRender:false}, ${t});`);
      tl.push(`tl.fromTo([${cur}, ${old}], {filter:"blur(0px)"}, {filter:"blur(${n(ctx.W * 0.018, 1)}px)", duration:${half}, ease:"power2.in", immediateRender:false}, ${t});`);
      tl.push(`tl.fromTo(${cur}, {filter:"blur(${n(ctx.W * 0.018, 1)}px)"}, {filter:"blur(0px)", duration:${half}, ease:"power2.out", immediateRender:false}, ${n(start + scene.transitionIn.durationSec / 2)});`);
      break;
    }
    case "zoom-through": {
      // Dive into what the previous scene was showing (its focused element), land in the next scene.
      const p = focalPoint(ctx, prev);
      const dd = scene.transitionIn.durationSec;
      tl.push(`tl.set(${old}, {transformOrigin:"${n(p.x, 1)}px ${n(p.y, 1)}px"}, ${t});`);
      tl.push(`tl.fromTo(${old}, {scale:1, opacity:1}, {scale:2.6, opacity:0, duration:${d}, ease:"power3.in", immediateRender:false}, ${t});`);
      tl.push(`tl.fromTo(${cur}, {opacity:0, scale:1.22}, {opacity:1, scale:1, duration:${n(dd * 0.7)}, ease:"power3.out"}, ${n(start + dd * 0.3)});`);
      break;
    }
    case "match": {
      // Match cut: the phone holds its place while everything around it changes.
      const a = mainDevice(prev);
      const b = mainDevice(scene);
      if (!a || !b || b.anchor) {
        tl.push(`tl.fromTo(${cur}, {opacity:0}, {opacity:1, duration:${d}, ease:"power1.inOut"}, ${t});`);
        break;
      }
      const { W, H } = ctx;
      const dx = (a.box.x + a.box.w / 2 - (b.box.x + b.box.w / 2)) * W;
      const dy = (a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2)) * H;
      const s = Math.max(0.5, Math.min(2, a.box.h / Math.max(1e-6, b.box.h)));
      tl.push(`tl.fromTo(${cur}, {opacity:0}, {opacity:1, duration:${n(scene.transitionIn.durationSec * 0.7)}, ease:"power1.inOut"}, ${t});`);
      tl.push(`tl.fromTo(q("l-${b.id}-k"), {x:${n(dx, 1)}, y:${n(dy, 1)}, scale:${n(s, 4)}}, {x:0, y:0, scale:1, duration:${d}, ease:"power3.inOut"}, ${t});`);
      break;
    }
    case "cut":
      break;
  }
}

/** The first visible device of a scene (match cuts, zoom-through). */
function mainDevice(scene: Scene): Extract<Layer, { type: "device" }> | undefined {
  return scene.layers.find((l): l is Extract<Layer, { type: "device" }> => l.type === "device" && !l.hidden);
}

/**
 * Where a scene's attention is at its end, in frame pixels: the lifted element of a ui-popout, the
 * landed focus of a device push-in, the device's centre, else a little above the frame's centre.
 */
function focalPoint(ctx: Ctx, scene: Scene): { x: number; y: number } {
  const { W, H } = ctx;
  const lifted = scene.layers.find((l) => l.type === "image" && l.lift && !l.hidden);
  if (lifted) return { x: (lifted.box.x + lifted.box.w / 2) * W, y: (lifted.box.y + lifted.box.h / 2) * H };
  const dev = mainDevice(scene);
  if (dev) {
    const left = dev.box.x * W;
    const top = dev.box.y * H;
    const w = dev.box.w * W;
    const h = dev.box.h * H;
    const g = deviceGeometry(dev.device, w, h);
    if (dev.focus) {
      const path = focusPath(dev);
      const end = path ? { ...dev, focus: { ...dev.focus, ...path[path.length - 1]! } } : dev;
      const m = focusMove(ctx, end, g, left, top, w, h);
      return { x: left + m.ox + m.dx, y: top + m.oy + m.dy };
    }
    return { x: left + w / 2, y: top + h * 0.45 };
  }
  return { x: W / 2, y: H * 0.45 };
}

// --- captions & audio ---------------------------------------------------------------------------

function compileCaptions(ctx: Ctx, total: number): string {
  const { doc, W, H } = ctx;
  const c = doc.captions;
  if (!c.enabled || !c.cues.length) return "";
  const th = doc.theme;
  const sz = doc.safeZone;
  const size = c.preset === "bold-center" || c.preset === "word-pop" ? W * 0.058 : c.preset === "minimal-bottom" ? W * 0.04 : W * 0.044;
  const posStyle =
    c.position === "top" ? `top:${px(H * (sz.top + 0.03))}` : c.position === "center" ? `top:${px(H * 0.5 - size)}` : `bottom:${px(H * (sz.bottom + 0.03))}`;
  const spanStyle =
    c.preset === "boxed"
      ? `background:rgba(0,0,0,.72);color:#fff;padding:${px(size * 0.32)} ${px(size * 0.55)};border-radius:${px(size * 0.42)};font-weight:600`
      : c.preset === "minimal-bottom"
        ? `color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.55),0 0 2px rgba(0,0,0,.6);font-weight:600`
        : `color:#fff;font-weight:800;letter-spacing:-0.02em;text-shadow:0 4px 24px rgba(0,0,0,.45);-webkit-text-stroke:${px(size * 0.035)} rgba(0,0,0,.55);paint-order:stroke fill`;
  const out: string[] = [];
  const open = (id: string, start: number, end: number) => `<div id="${id}" class="cap clip" data-start="${n(start)}" data-duration="${n(end - start)}" data-track-index="90" style="${posStyle};z-index:1000"><span style="font-family:${fontStack(th, "body")};font-size:${px(size)};line-height:1.25;max-width:${px(W * (1 - sz.left - sz.right))};${spanStyle}">`;
  for (const cue of c.cues) {
    if (cue.startSec >= total) continue;
    const end = Math.min(cue.endSec, total);
    if (c.preset === "word-pop") {
      out.push(...karaokeCue(ctx, cue, end, open));
      continue;
    }
    const id = `c-${cue.id}`;
    out.push(`${open(id, cue.startSec, end)}${esc(cue.text)}</span></div>`);
  }
  return out.join("\n");
}

/** Karaoke highlight colour: the theme accent, lifted toward white when it is too dark to read on footage. */
export function captionAccent(hex: string): string {
  const base = hex.slice(0, 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(base)) return "#FFD60A";
  if (luminance(base) >= 0.15) return base.toUpperCase();
  const lift = (i: number) => {
    const v = parseInt(base.slice(i, i + 2), 16);
    return Math.round(v + (255 - v) * 0.5)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${lift(1)}${lift(3)}${lift(5)}`.toUpperCase();
}

/**
 * `word-pop` captions, karaoke style: the cue is paged into short phrases (≤ 6 words, ≤ 2 lines); each
 * phrase pops in, upcoming words are dimmed, the word being spoken turns the accent colour with a
 * slight pop, spoken words stay at full strength. Word times are estimated inside the cue
 * (./karaoke.ts: syllable weights, pauses at punctuation); numbers and our own ids only reach script.
 */
function karaokeCue(ctx: Ctx, cue: { id: string; startSec: number; text: string }, end: number, open: (id: string, start: number, end: number) => string): string[] {
  const acc = captionAccent(ctx.doc.theme.accent);
  const out: string[] = [];
  captionPages(cue.text, cue.startSec, end).forEach((pg, k) => {
    if (pg.end - pg.start < 0.04) return;
    const id = `c-${cue.id}-p${k}`;
    // Each word keeps a little side room so the popped (scaled) word never touches its neighbours.
    const words = pg.words.map((w, i) => `<span id="${id}-w${i}" class="kw" style="display:inline-block;padding:0 .07em;transform-origin:50% 75%${ctx.still ? "" : ";opacity:.5"}">${esc(w.word)}</span>`).join(" ");
    out.push(`${open(id, pg.start, pg.end)}${words}</span></div>`);
    if (ctx.still) return;
    ctx.tl.push(k === 0 ? `tl.fromTo(q("${id}"), {scale:0.82, opacity:0}, {scale:1, opacity:1, duration:0.22, ease:"back.out(2.2)"}, ${n(pg.start)});` : `tl.fromTo(q("${id}"), {scale:0.94, opacity:0.4}, {scale:1, opacity:1, duration:0.16, ease:"power2.out"}, ${n(pg.start)});`);
    pg.words.forEach((w, i) => {
      const sel = `q("${id}-w${i}")`;
      ctx.tl.push(`tl.fromTo(${sel}, {opacity:0.5, scale:1, color:"#FFFFFF"}, {opacity:1, scale:1.06, color:"${acc}", duration:0.09, ease:"power2.out", immediateRender:false}, ${n(Math.max(pg.start, w.at))});`);
      const next = pg.words[i + 1];
      if (next) ctx.tl.push(`tl.fromTo(${sel}, {scale:1.06, color:"${acc}"}, {scale:1, color:"#FFFFFF", duration:0.14, ease:"power1.out", immediateRender:false}, ${n(next.at)});`);
    });
  });
  return out;
}

/** Music, voiceover and effects (Track 3, ./audio.ts): music is ducked under speech by an automation lane. */
function compileAudio(ctx: Ctx, total: number): string {
  if (ctx.still) return "";
  return compileAudioTags(ctx.doc, total, ctx.opts.assetUrl, ctx.assetIds);
}

/** Every asset id a doc can reference (before mask resolution); used to fetch media for renders. */
export function collectAssetRefs(doc: CompositionDoc): { assetIds: string[]; segmentationIds: string[] } {
  const a = new Set<string>();
  const s = new Set<string>();
  for (const sc of doc.scenes) {
    if (sc.background.assetId) a.add(sc.background.assetId);
    for (const l of sc.layers) {
      if (l.type === "image" || l.type === "video") a.add(l.assetId);
      if (l.type === "device") a.add(l.screenAssetId);
      if (l.type === "video" && l.mask) s.add(l.mask.segmentationId);
      if (l.type === "effect") {
        s.add(l.target.segmentationId);
        if (l.assetId) a.add(l.assetId);
      }
      if (l.anchor) s.add(l.anchor.segmentationId);
    }
  }
  for (const t of doc.audio) a.add(t.assetId);
  return { assetIds: [...a], segmentationIds: [...s] };
}
