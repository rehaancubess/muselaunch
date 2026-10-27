/**
 * CompositionDoc → HyperFrames HTML.
 *
 * One root composition (`data-composition-id="muselaunch"`) holds every scene as a timed
 * `.clip` section; layers are timed clips inside it (absolute root time). Motion is a single
 * paused GSAP timeline registered on `window.__timelines`, built only from numbers and our own
 * element ids — document text and colours are escaped into markup/CSS and never reach script.
 * Every visual is produced by the allowlisted components below.
 */
import type { CompositionDoc, Layer, MaskUse, Scene, Theme, TracksFile } from "@muselaunch/contracts";
import { BLOCK_PARAMS, isBlockId } from "./blocks";
import { estimateTextHeight } from "./lint";
import { anchorPoint, clipMapping, holdGaps, sampleTrack, trackTweens, trackUsable, type SegmentationInfo } from "./objects";
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
  const first = named && SAFE_FONT.test(named) && !/^inter$/i.test(named) ? `'${named}',` : "";
  return `${first}'Inter Variable',Inter,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif`;
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
const DEVICES: Record<string, DeviceSpec> = {
  iphone: { aspect: 0.4885, bezel: 0.042, outerRadius: 0.165, screenRadius: 0.128 },
  android: { aspect: 0.47, bezel: 0.03, outerRadius: 0.12, screenRadius: 0.1 },
  ipad: { aspect: 0.75, bezel: 0.045, outerRadius: 0.06, screenRadius: 0.035 },
  browser: { aspect: null, bezel: 0, outerRadius: 0.018, screenRadius: 0 },
  macbook: { aspect: 1.56, bezel: 0.025, outerRadius: 0.03, screenRadius: 0.012 },
};
const FRAME_COLORS: Record<string, { edge: string; body: string; hi: string }> = {
  black: { edge: "#2a2a2c", body: "#111113", hi: "#4a4a4e" },
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
${opts.runtimeSrc ? `<script src="${esc(opts.runtimeSrc)}"></script>\n` : ""}${rt.fontCss ? `<style>${rt.fontCss}</style>\n` : ""}${gsapTag}
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
    .map(({ l, li }) => compileLayer(ctx, scene, l, li, win, sceneEnd))
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

function compileLayer(ctx: Ctx, scene: Scene, layer: Layer, li: number, sceneWin: Window, sceneEnd: number): string {
  const { W, H } = ctx;
  const win = layerWindow(layer, sceneWin.start, sceneEnd, sceneWin);
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
      const shadow = layer.shadow ? `;box-shadow:0 ${px(h * 0.03)} ${px(h * 0.08)} rgba(0,0,0,.22)` : "";
      inner = mediaElement(ctx, layer.assetId, `i-${layer.id}`, win, { cls: "media", style: `object-fit:${layer.fit};border-radius:${px(layer.radiusPx)}${crop}${shadow}`, trimIn: 0, rate: 1, muted: true, video: false });
      break;
    }
    case "video": {
      const src = resolveMask(ctx, layer.assetId, layer.mask);
      if (src === null) return "";
      const radius = layer.radiusPx ? `;border-radius:${px(layer.radiusPx)}` : "";
      inner = mediaElement(ctx, src.assetId, `v-${layer.id}`, win, {
        cls: "media",
        style: `object-fit:${layer.fit}${radius}`,
        trimIn: layer.trimInSec,
        rate: layer.playbackRate,
        muted: layer.muted,
        volume: layer.volume,
        video: true,
      });
      break;
    }
    case "device":
      inner = deviceHtml(ctx, layer, w, h, win);
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
      if (!ctx.still) animateLayer(ctx, layer, id, win, sceneWin.start);
      const op = b.opacity !== 1 ? `opacity:${n(b.opacity)};` : "";
      return `<div id="${id}" class="layer clip l-effect" data-start="${n(win.start)}" data-duration="${n(win.end - win.start)}" data-track-index="${2 + li}" style="left:0;top:0;width:${W}px;height:${H}px;z-index:${b.z};pointer-events:none;${op}"><div class="lk" id="${id}-k"><div class="le" id="${id}-e"><div class="ll" id="${id}-l">${fx}</div></div></div></div>`;
    }
  }
  const rot = b.rotation ? `transform:rotate(${n(b.rotation, 2)}deg);` : "";
  const op = b.opacity !== 1 ? `opacity:${n(b.opacity)};` : "";
  const id = `l-${layer.id}`;
  if (!ctx.still) animateLayer(ctx, layer, id, win, sceneWin.start);
  if (layer.anchor) anchorLayer(ctx, scene, layer, id, win, sceneWin.start);
  return `<div id="${id}" class="layer clip l-${layer.type}" data-start="${n(win.start)}" data-duration="${n(win.end - win.start)}" data-track-index="${2 + li}" style="left:${px(left)};top:${px(top)};width:${px(w)};height:${px(h)};z-index:${b.z};${rot}${op}"><div class="lk" id="${id}-k"><div class="le" id="${id}-e"><div class="ll" id="${id}-l">${inner}</div></div></div></div>`;
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
  const est = estimateTextHeight(layer.text, s.sizePx, s.lineHeight, Math.max(1, w - pad * 2), s.uppercase);
  const longest = Math.max(...layer.text.split(/\s+/).map((x) => x.length), 1);
  const glyph = s.sizePx * (s.uppercase ? 0.6 : 0.54);
  const fitH = est.heightPx > 0 ? (h - pad * 2) / est.heightPx : 1;
  const fitW = (w - pad * 2) / (longest * glyph);
  const fit = Math.max(0.55, Math.min(1, fitH, fitW));
  const size = s.sizePx * fit;
  const color = themeColor(th, s.color, th.text);
  const hlColor = s.highlight ? themeColor(th, s.highlight.color, th.accent) : null;
  const hlWords = new Set((s.highlight?.words ?? []).map((x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")));
  const enter = layer.animation.enter?.preset;
  const perChar = !ctx.still && enter === "typewriter";
  const perWord = !ctx.still && enter === "mask-reveal";
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
  const weight = Math.round(s.weight);
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

function deviceHtml(ctx: Ctx, layer: Extract<Layer, { type: "device" }>, w: number, h: number, win: Window): string {
  const spec = DEVICES[layer.device] ?? DEVICES.iphone!;
  let dw = w;
  let dh = h;
  if (spec.aspect) {
    if (w / h > spec.aspect) dw = h * spec.aspect;
    else dh = w / spec.aspect;
  }
  const ox = (w - dw) / 2;
  const oy = (h - dh) / 2;
  const fc = FRAME_COLORS[layer.frameColor] ?? FRAME_COLORS.black!;
  const media = mediaElement(ctx, layer.screenAssetId, layer.screenKind === "video" ? `v-${layer.id}` : `i-${layer.id}`, win, {
    cls: "media",
    trimIn: layer.trimInSec,
    rate: 1,
    muted: true,
    video: layer.screenKind === "video",
  });
  const shadow = layer.shadow
    ? `box-shadow:0 ${px(dh * 0.045)} ${px(dh * 0.09)} rgba(15,20,35,.26),0 ${px(dh * 0.012)} ${px(dh * 0.025)} rgba(15,20,35,.18);`
    : "";
  if (layer.device === "browser") {
    const bar = Math.max(28, dh * 0.055);
    const dot = bar * 0.28;
    const r = dw * spec.outerRadius;
    const dots = ["#ff5f57", "#febc2e", "#28c840"].map((c, i) => `<span style="position:absolute;left:${px(bar * 0.45 + i * dot * 1.7)};top:${px((bar - dot) / 2)};width:${px(dot)};height:${px(dot)};border-radius:50%;background:${c}"></span>`).join("");
    return `<div class="dev dev-browser" style="left:${px(ox)};top:${px(oy)};width:${px(dw)};height:${px(dh)};border-radius:${px(r)};${shadow}overflow:hidden;background:#fff">
<div style="position:absolute;left:0;top:0;width:100%;height:${px(bar)};background:linear-gradient(#f6f6f7,#ececee);border-bottom:1px solid rgba(0,0,0,.08)">${dots}<span style="position:absolute;left:30%;width:40%;top:${px(bar * 0.22)};height:${px(bar * 0.56)};border-radius:${px(bar * 0.28)};background:rgba(0,0,0,.06)"></span></div>
<div class="dev-screen" style="left:0;top:${px(bar)};width:100%;height:${px(dh - bar)};background:#fff">${media}</div></div>`;
  }
  if (layer.device === "macbook") {
    const lidH = dh * 0.9;
    const bz = dw * spec.bezel;
    const r = dw * spec.outerRadius;
    return `<div class="dev dev-macbook" style="left:${px(ox)};top:${px(oy)};width:${px(dw)};height:${px(dh)}">
<div style="position:absolute;left:${px(dw * 0.06)};top:0;width:${px(dw * 0.88)};height:${px(lidH)};border-radius:${px(r)} ${px(r)} ${px(r * 0.3)} ${px(r * 0.3)};background:#0d0d0f;border:${px(Math.max(1, dw * 0.003))} solid ${fc.edge};${shadow}">
<div class="dev-screen" style="left:${px(bz)};top:${px(bz)};width:${px(dw * 0.88 - bz * 2)};height:${px(lidH - bz * 2.2)};border-radius:${px(dw * spec.screenRadius)}">${media}</div></div>
<div style="position:absolute;left:0;top:${px(lidH)};width:100%;height:${px(dh - lidH)};border-radius:0 0 ${px(dh * 0.08)} ${px(dh * 0.08)};background:linear-gradient(${fc.hi},${fc.body} 45%,${fc.edge})"></div></div>`;
  }
  const bz = dw * spec.bezel;
  const R = dw * spec.outerRadius;
  const r = dw * spec.screenRadius;
  const rim = Math.max(1.5, dw * 0.009);
  const island =
    layer.device === "iphone"
      ? `<div style="position:absolute;left:${px((dw - bz * 2) * 0.335)};top:${px(dw * 0.032)};width:${px((dw - bz * 2) * 0.33)};height:${px(dw * 0.092)};border-radius:${px(dw * 0.05)};background:#000;z-index:3"></div>`
      : layer.device === "android"
        ? `<div style="position:absolute;left:50%;top:${px(dw * 0.03)};width:${px(dw * 0.045)};height:${px(dw * 0.045)};margin-left:${px(-dw * 0.0225)};border-radius:50%;background:#000;z-index:3"></div>`
        : "";
  const buttons =
    layer.device === "iphone" || layer.device === "android"
      ? `<span style="position:absolute;left:${px(-rim * 0.9)};top:${px(dh * 0.2)};width:${px(rim * 1.2)};height:${px(dh * 0.06)};border-radius:${px(rim)};background:${fc.edge}"></span><span style="position:absolute;left:${px(-rim * 0.9)};top:${px(dh * 0.29)};width:${px(rim * 1.2)};height:${px(dh * 0.06)};border-radius:${px(rim)};background:${fc.edge}"></span><span style="position:absolute;right:${px(-rim * 0.9)};top:${px(dh * 0.25)};width:${px(rim * 1.2)};height:${px(dh * 0.1)};border-radius:${px(rim)};background:${fc.edge}"></span>`
      : "";
  return `<div class="dev dev-${layer.device}" style="left:${px(ox)};top:${px(oy)};width:${px(dw)};height:${px(dh)}">${buttons}
<div class="dev-body" style="border-radius:${px(R)};background:linear-gradient(145deg,${fc.hi},${fc.edge} 18%,${fc.body} 50%,${fc.edge} 82%,${fc.hi});${shadow}">
<div style="position:absolute;left:${px(rim)};top:${px(rim)};right:${px(rim)};bottom:${px(rim)};border-radius:${px(R - rim)};background:#050505"></div>
<div class="dev-screen" style="left:${px(bz)};top:${px(bz)};width:${px(dw - bz * 2)};height:${px(dh - bz * 2)};border-radius:${px(r)}">${media}${island}<div style="position:absolute;inset:0;border-radius:${px(r)};background:linear-gradient(115deg,rgba(255,255,255,.10),rgba(255,255,255,0) 38%);pointer-events:none;z-index:2"></div></div>
</div></div>`;
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
      const pills: string[] = [];
      if (p.ios ?? true) pills.push("App Store");
      if (p.android) pills.push("Google Play");
      if (p.web) pills.push("Web");
      const pillH = Math.min(h * (p.label ? 0.6 : 1), w / Math.max(1, pills.length) / 2.6);
      const dark = luminance(th.background) > 0.4;
      const fg = dark ? "#FFFFFF" : "#000000";
      const bgc = dark ? "#000000" : "#FFFFFF";
      const label = p.label ? `<div style="font-family:${fontStack(th, "body")};font-size:${px(pillH * 0.34)};font-weight:600;letter-spacing:.02em;color:${th.textMuted};margin-bottom:${px(pillH * 0.22)};text-transform:uppercase">${esc(p.label)}</div>` : "";
      return `<div class="media" style="display:flex;flex-direction:column;align-items:center;justify-content:center">${label}<div style="display:flex;gap:${px(pillH * 0.3)}">${pills
        .map(
          (t) =>
            `<div style="height:${px(pillH)};padding:0 ${px(pillH * 0.5)};border-radius:${px(pillH * 0.26)};background:${bgc};color:${fg};display:flex;align-items:center;font-family:${fontStack(th, "body")};font-size:${px(pillH * 0.4)};font-weight:600;letter-spacing:-0.01em;white-space:nowrap">${esc(t)}</div>`,
        )
        .join("")}</div></div>`;
    }
    case "progress-bar": {
      const p = BLOCK_PARAMS["progress-bar"].parse(layer.params);
      const c = themeColor(th, p.color, th.accent);
      if (!ctx.still) ctx.tl.push(`tl.fromTo(q("${id}-fill"), {scaleX:0}, {scaleX:1, duration:${n(win.end - win.start)}, ease:"none"}, ${n(win.start)});`);
      return `<div class="media" style="border-radius:${px(h / 2)};background:${withAlpha(c.length === 7 ? c : "#000000", 0.18)};overflow:hidden"><div id="${id}-fill" style="position:absolute;inset:0;background:${c};transform-origin:0 50%"></div></div>`;
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

function animateLayer(ctx: Ctx, layer: Layer, id: string, win: Window, sceneStart: number) {
  const { H, W } = ctx;
  const a = layer.animation;
  const D = H * 0.035;
  const life = win.end - win.start;
  const tl = ctx.tl;
  const sel = `q("${id}-e")`;
  if (a.enter && a.enter.preset !== "none") {
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
    case "cut":
      break;
  }
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
  for (const cue of c.cues) {
    if (cue.startSec >= total) continue;
    const end = Math.min(cue.endSec, total);
    const id = `c-${cue.id}`;
    out.push(
      `<div id="${id}" class="cap clip" data-start="${n(cue.startSec)}" data-duration="${n(end - cue.startSec)}" data-track-index="90" style="${posStyle};z-index:1000"><span style="font-family:${fontStack(th, "body")};font-size:${px(size)};line-height:1.25;max-width:${px(W * (1 - sz.left - sz.right))};${spanStyle}">${esc(cue.text)}</span></div>`,
    );
    if (!ctx.still && c.preset === "word-pop") ctx.tl.push(`tl.fromTo(q("${id}"), {scale:0.82, opacity:0}, {scale:1, opacity:1, duration:0.22, ease:"back.out(2.2)"}, ${n(cue.startSec)});`);
  }
  return out.join("\n");
}

function compileAudio(ctx: Ctx, total: number): string {
  const { doc } = ctx;
  if (ctx.still) return "";
  const hasVoice = doc.audio.some((a) => a.kind === "voiceover");
  return doc.audio
    .filter((a) => a.startSec < total)
    .map((a) => {
      ctx.assetIds.add(a.assetId);
      const end = Math.min(a.endSec ?? total, total);
      const vol = a.kind === "music" && hasVoice && a.duckUnderVoice ? a.volume * 0.35 : a.volume;
      return `<audio id="a-${a.id}" src="${esc(ctx.opts.assetUrl(a.assetId))}" data-start="${n(a.startSec)}" data-duration="${n(end - a.startSec)}" data-media-start="${n(a.trimInSec)}" data-volume="${n(vol)}" data-fade-in="${n(a.fadeInSec)}" data-fade-out="${n(a.fadeOutSec)}" data-track-index="${100 + doc.audio.indexOf(a)}" preload="auto"></audio>`;
    })
    .join("\n");
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
