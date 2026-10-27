/**
 * Storyboard + App + BrandProfile + real MediaAssets → polished CompositionDoc.
 *
 * Deterministic: the same inputs give the same doc and the same ids (scene ids derive from
 * storyboard scene ids; layer ids from scene id + role), so rebuilds are idempotent and
 * aspect-ratio variants can carry edits across by id.
 *
 * Product truth: device frames and product scenes only ever use assets marked `isProductTruth`.
 * When a template's real media is missing it degrades to a text-led layout; it never invents UI.
 */
import {
  ASPECT_DIMENSIONS,
  CompositionDoc,
  TEMPLATE_IDS,
  type App,
  type AspectRatio,
  type AudioTrack,
  type BrandProfile,
  type CaptionCue,
  type Layer,
  type MediaAsset,
  type Scene,
  type Segmentation,
  type Storyboard,
  type StoryboardScene,
  type TemplateId,
  type Theme,
} from "@muselaunch/contracts";
import { luminance } from "./compile";
import { estimateTextHeight } from "./lint";
import { validateDoc } from "./validate";

export interface BuildInput {
  storyboard: Storyboard;
  app: App;
  brand: BrandProfile | null;
  assets: MediaAsset[];
  segmentations?: Segmentation[];
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const HEX6 = /^#[0-9a-fA-F]{6}$/;
function norm(hex: string): string {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  return `#${h.slice(0, 6).toUpperCase()}`;
}
function mix(a: string, b: string, t: number): string {
  const pa = norm(a).slice(1);
  const pb = norm(b).slice(1);
  const ch = (i: number) => Math.round(parseInt(pa.slice(i, i + 2), 16) * (1 - t) + parseInt(pb.slice(i, i + 2), 16) * t);
  return `#${[0, 2, 4].map((i) => ch(i).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
/** Rotate hue by `deg` (HSL), keeping saturation/lightness. */
function hueShift(hex: string, deg: number): string {
  const h = norm(hex).slice(1);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let hue = 0;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (mx === r) hue = ((g - b) / d) % 6;
    else if (mx === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
  }
  hue = (hue * 60 + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r1, g1, b1].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
function saturation(hex: string): number {
  const h = norm(hex).slice(1);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

export function themeFromBrand(brand: BrandProfile | null): Theme {
  const pal = brand?.visual.palette ?? [];
  const pick = (...roles: string[]) => pal.find((p) => roles.includes(p.role))?.hex;
  // Accent: the brand's primary, or the most saturated palette colour; Apple blue as a last resort.
  const saturated = [...pal].sort((a, b) => saturation(b.hex) - saturation(a.hex))[0]?.hex;
  let accent = norm(pick("primary", "accent") ?? saturated ?? "#0A84FF");
  const lum = luminance(accent);
  if (lum > 0.62) accent = mix(accent, "#000000", 0.35); // too light to carry text/UI on white
  if (lum < 0.015) accent = "#0A84FF"; // pure black/near-black isn't an accent
  const secondary = pick("secondary");
  const accent2 = norm(secondary && HEX6.test(norm(secondary)) ? secondary : hueShift(accent, 38));
  const bgCandidate = pick("background");
  const background = bgCandidate && luminance(norm(bgCandidate)) > 0.85 ? norm(bgCandidate) : "#F5F5F7";
  const textCandidate = pick("text");
  const text = textCandidate && luminance(norm(textCandidate)) < 0.05 ? norm(textCandidate) : "#1D1D1F";
  return {
    mode: "light",
    background,
    surface: "#FFFFFF",
    text,
    textMuted: "#6E6E73",
    accent,
    accent2,
    headingFont: brand?.visual.headingFont && /^[A-Za-z0-9 -]{1,60}$/.test(brand.visual.headingFont) ? brand.visual.headingFont : "Inter",
    bodyFont: brand?.visual.bodyFont && /^[A-Za-z0-9 -]{1,60}$/.test(brand.visual.bodyFont) ? brand.visual.bodyFont : "Inter",
    radiusPx: 28,
  };
}

// ---------------------------------------------------------------------------
// Frame & layout helpers
// ---------------------------------------------------------------------------

interface Frame {
  W: number;
  H: number;
  ar: AspectRatio;
  portrait: boolean;
  landscape: boolean;
  /** Size unit: 1 at 1080 on the short edge. */
  u: number;
  safe: { top: number; bottom: number; left: number; right: number };
}

const SAFE: Record<AspectRatio, Frame["safe"]> = {
  "9:16": { top: 0.08, bottom: 0.14, left: 0.05, right: 0.05 },
  "4:5": { top: 0.05, bottom: 0.08, left: 0.05, right: 0.05 },
  "1:1": { top: 0.05, bottom: 0.06, left: 0.05, right: 0.05 },
  "16:9": { top: 0.06, bottom: 0.08, left: 0.05, right: 0.05 },
};

function frameFor(ar: AspectRatio): Frame {
  const { width: W, height: H } = ASPECT_DIMENSIONS[ar];
  return { W, H, ar, portrait: H > W * 1.1, landscape: W > H * 1.1, u: Math.min(W, H) / 1080, safe: SAFE[ar] };
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const box = (x: number, y: number, w: number, h: number, z = 1) => ({ x: r4(x), y: r4(y), w: r4(w), h: r4(h), rotation: 0, opacity: 1, z });

/** Fit a headline in `maxLines` within width fraction `w`; returns size + box height fraction. */
function fitText(f: Frame, text: string, size: number, w: number, opts: { lineHeight?: number; maxLines?: number; min?: number; uppercase?: boolean } = {}) {
  const lh = opts.lineHeight ?? 1.05;
  const maxLines = opts.maxLines ?? 3;
  let s = size;
  const min = opts.min ?? size * 0.55;
  let est = estimateTextHeight(text, s, lh, w * f.W, opts.uppercase);
  while (est.lines > maxLines && s > min) {
    s = Math.max(min, s * 0.92);
    est = estimateTextHeight(text, s, lh, w * f.W, opts.uppercase);
  }
  return { size: Math.round(s), h: r4(Math.min(0.9, (est.heightPx * 1.12 + s * 0.2) / f.H)), lines: est.lines };
}

type TextOpts = {
  role?: "headline" | "subhead" | "body" | "label" | "cta" | "caption";
  size: number;
  weight?: number;
  color?: string;
  align?: "left" | "center" | "right";
  lineHeight?: number;
  letterSpacing?: number;
  uppercase?: boolean;
  font?: "heading" | "body" | "mono";
  enter?: { preset: string; durationSec?: number; delaySec?: number; easing?: string };
  exit?: { preset: string; durationSec?: number };
  loop?: string;
  highlight?: { words: string[]; color: string };
  background?: { color: string; paddingPx: number; radiusPx: number };
  claimIds?: string[];
  start?: number;
  z?: number;
  shadow?: boolean;
};

function text(id: string, value: string, b: ReturnType<typeof box>, o: TextOpts): Layer {
  return {
    id,
    type: "text",
    role: o.role ?? "headline",
    text: value.slice(0, 400),
    box: { ...b, z: o.z ?? b.z },
    timing: { start: o.start ?? 0 },
    animation: {
      enter: o.enter ? { preset: o.enter.preset, durationSec: o.enter.durationSec ?? 0.8, delaySec: o.enter.delaySec ?? 0, easing: o.enter.easing ?? "smooth" } : undefined,
      exit: o.exit ? { preset: o.exit.preset, durationSec: o.exit.durationSec ?? 0.35, easing: "smooth" } : undefined,
      loop: o.loop ?? "none",
    },
    locked: false,
    hidden: false,
    style: {
      font: o.font ?? "heading",
      sizePx: o.size,
      weight: o.weight ?? 700,
      color: o.color ?? "theme.text",
      align: o.align ?? "center",
      lineHeight: o.lineHeight ?? 1.05,
      letterSpacing: o.letterSpacing ?? -0.03,
      italic: false,
      uppercase: !!o.uppercase,
      shadow: !!o.shadow,
      background: o.background,
      highlight: o.highlight,
    },
    claimIds: o.claimIds ?? [],
  } as Layer;
}

function shape(id: string, kind: "rect" | "circle" | "pill" | "blob" | "line", b: ReturnType<typeof box>, fill: string, o: { gradientTo?: string; blurPx?: number; radiusPx?: number; loop?: string; enter?: TextOpts["enter"] } = {}): Layer {
  return {
    id,
    type: "shape",
    shape: kind,
    fill,
    gradientTo: o.gradientTo,
    radiusPx: o.radiusPx ?? 0,
    blurPx: o.blurPx ?? 0,
    box: b,
    timing: { start: 0 },
    animation: {
      loop: o.loop ?? "none",
      enter: o.enter ? { preset: o.enter.preset, durationSec: o.enter.durationSec ?? 1, delaySec: o.enter.delaySec ?? 0, easing: o.enter.easing ?? "smooth" } : undefined,
    },
    locked: false,
    hidden: false,
  } as Layer;
}

// ---------------------------------------------------------------------------
// Asset selection (real media only for product scenes)
// ---------------------------------------------------------------------------

const USABLE = new Set(["ready", "uploaded"]);

class AssetPicker {
  private used = new Map<string, number>();
  readonly byId: Map<string, MediaAsset>;
  constructor(
    readonly assets: MediaAsset[],
    readonly brand: BrandProfile | null,
    readonly app: App,
  ) {
    this.byId = new Map(assets.filter((a) => USABLE.has(a.status)).map((a) => [a.id, a]));
  }
  private pool(pred: (a: MediaAsset) => boolean) {
    return [...this.byId.values()].filter(pred).sort((a, b) => (this.used.get(a.id) ?? 0) - (this.used.get(b.id) ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  take(a: MediaAsset | undefined): MediaAsset | undefined {
    if (a) this.used.set(a.id, (this.used.get(a.id) ?? 0) + 1);
    return a;
  }
  /** Real product media (screenshot/recording), honouring explicit hints and feature links. */
  product(sb: StoryboardScene, prefer: "screenshot" | "app_recording" | "any" = "any", exclude: string[] = []): MediaAsset | undefined {
    const truth = (a: MediaAsset) => a.isProductTruth && (a.role === "screenshot" || a.role === "app_recording") && !exclude.includes(a.id);
    for (const h of sb.assets) {
      if ((h.kind === "screenshot" || h.kind === "app_recording") && h.assetId) {
        const a = this.byId.get(h.assetId);
        if (a && truth(a)) return this.take(a);
      }
    }
    const featureIds = sb.assets.map((h) => h.featureId).filter(Boolean) as string[];
    for (const fid of featureIds) {
      const feat = this.brand?.features.find((f) => f.id === fid);
      for (const aid of feat?.assetIds ?? []) {
        const a = this.byId.get(aid);
        if (a && truth(a)) return this.take(a);
      }
    }
    const wantsRecording = prefer === "app_recording" || sb.assets.some((h) => h.kind === "app_recording");
    const recs = this.pool((a) => truth(a) && a.kind === "video");
    const shots = this.pool((a) => truth(a) && a.kind === "image");
    return this.take((wantsRecording ? (recs[0] ?? shots[0]) : (shots[0] ?? recs[0])) ?? undefined);
  }
  founderClip(sb: StoryboardScene): MediaAsset | undefined {
    for (const h of sb.assets) if (h.kind === "founder_clip" && h.assetId && this.byId.get(h.assetId)?.kind === "video") return this.take(this.byId.get(h.assetId));
    return this.take(this.pool((a) => a.role === "founder_clip" && a.kind === "video")[0]);
  }
  logo(): MediaAsset | undefined {
    const ids = [this.app.iconAssetId, ...(this.brand?.visual.logoAssetIds ?? [])].filter(Boolean) as string[];
    for (const id of ids) {
      const a = this.byId.get(id);
      if (a && a.kind === "image") return a;
    }
    return this.pool((a) => (a.role === "icon" || a.role === "logo") && a.kind === "image")[0];
  }
  /** Non-product imagery for text-over-media (stock/generated/uploaded photos). */
  backdrop(sb: StoryboardScene): MediaAsset | undefined {
    for (const h of sb.assets) {
      if (h.assetId && ["generated_image", "stock_image", "stock_video"].includes(h.kind)) {
        const a = this.byId.get(h.assetId);
        if (a && (a.kind === "image" || a.kind === "video")) return this.take(a);
      }
    }
    return this.take(this.pool((a) => ["stock_video", "stock_image", "generated_image", "product_photo"].includes(a.role) && (a.kind === "image" || a.kind === "video"))[0]);
  }
}

function deviceFor(app: App, asset: MediaAsset): { device: "iphone" | "android" | "ipad" | "browser" | "macbook"; aspect: number } {
  const ar = asset.width && asset.height ? asset.width / asset.height : 0.46;
  if (ar > 1.15) return { device: app.platforms.includes("macos") && !app.platforms.includes("web") ? "macbook" : "browser", aspect: ar };
  if (ar > 0.6) return { device: "ipad", aspect: 0.75 };
  const androidOnly = app.platforms.includes("android") && !app.platforms.includes("ios");
  return { device: androidOnly ? "android" : "iphone", aspect: androidOnly ? 0.47 : 0.4885 };
}

function deviceLayer(id: string, app: App, asset: MediaAsset, b: ReturnType<typeof box>, o: { enter?: TextOpts["enter"]; loop?: string; start?: number; rotation?: number } = {}): Layer {
  const { device } = deviceFor(app, asset);
  return {
    id,
    type: "device",
    device,
    screenAssetId: asset.id,
    screenKind: asset.kind === "video" ? "video" : "image",
    trimInSec: 0,
    frameColor: "black",
    shadow: true,
    box: { ...b, rotation: o.rotation ?? 0 },
    timing: { start: o.start ?? 0 },
    animation: {
      enter: o.enter ? { preset: o.enter.preset, durationSec: o.enter.durationSec ?? 1, delaySec: o.enter.delaySec ?? 0, easing: o.enter.easing ?? "smooth" } : undefined,
      loop: o.loop ?? "float",
    },
    locked: false,
    hidden: false,
  } as Layer;
}

/** Device box (fractions) of a given pixel height, centred at cx, top at y. */
function deviceBox(f: Frame, app: App, asset: MediaAsset, cx: number, y: number, heightFrac: number, maxWidthFrac = 0.9, z = 2) {
  const { device, aspect } = deviceFor(app, asset);
  let hPx = heightFrac * f.H;
  if (device === "browser" || device === "macbook") {
    // Landscape media: size by width instead.
    let wPx = Math.min(maxWidthFrac * f.W, hPx * aspect);
    const bar = device === "browser" ? Math.max(28, (wPx / aspect) * 0.055) : 0;
    hPx = device === "macbook" ? wPx / 1.56 : wPx / aspect + bar;
    if (hPx > heightFrac * f.H) {
      hPx = heightFrac * f.H;
      wPx = device === "macbook" ? hPx * 1.56 : (hPx - bar) * aspect;
    }
    return box(cx - wPx / f.W / 2, y, wPx / f.W, hPx / f.H, z);
  }
  let wPx = hPx * aspect;
  if (wPx > maxWidthFrac * f.W) {
    wPx = maxWidthFrac * f.W;
    hPx = wPx / aspect;
  }
  return box(cx - wPx / f.W / 2, y, wPx / f.W, hPx / f.H, z);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

interface SceneCtx {
  f: Frame;
  theme: Theme;
  app: App;
  brand: BrandProfile | null;
  picker: AssetPicker;
  segs: Segmentation[];
  sb: StoryboardScene;
  sceneId: string;
  index: number;
  count: number;
  /** Words to tint in headlines. */
  emphasis: (t: string) => string[];
}

type Built = { template: TemplateId; layers: Layer[]; background: Scene["background"] };

const ENTER_HEAD = { preset: "mask-reveal", durationSec: 0.85, easing: "smooth" };

function softBackground(ctx: SceneCtx, variant = 0): Scene["background"] {
  const t = ctx.theme;
  const tint = mix(t.accent, "#FFFFFF", variant % 2 ? 0.9 : 0.86);
  return { kind: "gradient", colors: variant % 2 ? [t.background, tint] : [tint, t.background], angle: 180, dim: 0 };
}

function glow(ctx: SceneCtx, id: string, cx: number, cy: number, size: number, color: string, z = 0): Layer {
  const f = ctx.f;
  const s = Math.min(f.W, f.H) * size;
  return shape(id, "circle", box(cx - s / f.W / 2, cy - s / f.H / 2, s / f.W, s / f.H, z), color, { blurPx: Math.round(110 * f.u), loop: "float" });
}

function splitParts(t: string): string[] {
  return t
    .split(/\s*(?:\n|\||·|•|;|\s\/\s)\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function hookTitle(ctx: SceneCtx, textValue: string): Built {
  const { f, theme, sceneId } = ctx;
  const dark = mix(theme.accent, "#07070A", 0.9);
  const darker = "#050507";
  const w = 1 - f.safe.left - f.safe.right - 0.04;
  const base = f.portrait ? 118 : f.landscape ? 104 : 104;
  const fit = fitText(f, textValue, base * f.u, w, { maxLines: f.landscape ? 2 : 4, lineHeight: 1.02 });
  const headY = 0.5 - fit.h / 2 + (f.portrait ? 0.02 : 0.03);
  const eyebrow = ctx.app.name.slice(0, 60);
  const eyeSize = Math.round(30 * f.u);
  const layers: Layer[] = [
    glow(ctx, `${sceneId}_glow1`, 0.18, f.portrait ? 0.28 : 0.22, 0.8, theme.accent),
    glow(ctx, `${sceneId}_glow2`, 0.86, f.portrait ? 0.76 : 0.82, 0.7, theme.accent2 ?? theme.accent),
    text(`${sceneId}_eyebrow`, eyebrow, box(f.safe.left, headY - (eyeSize * 2.6) / f.H, 1 - f.safe.left - f.safe.right, (eyeSize * 1.6) / f.H, 3), {
      role: "label",
      size: eyeSize,
      weight: 600,
      color: mix(theme.accent, "#FFFFFF", 0.45),
      uppercase: true,
      letterSpacing: 0.14,
      font: "body",
      enter: { preset: "fade", durationSec: 0.6 },
    }),
    text(`${sceneId}_headline`, textValue, box(0.5 - w / 2, headY, w, fit.h, 3), {
      size: fit.size,
      weight: 760,
      color: "#FFFFFF",
      lineHeight: 1.02,
      letterSpacing: -0.035,
      enter: { ...ENTER_HEAD, delaySec: 0.1 },
      highlight: { words: ctx.emphasis(textValue), color: mix(theme.accent, "#FFFFFF", 0.35) },
      claimIds: ctx.sb.claimIds,
    }),
  ];
  // Glows sit on the dark field at low opacity.
  for (const l of layers) if (l.type === "shape") l.box.opacity = l.id.endsWith("glow1") ? 0.5 : 0.38;
  return { template: "hook-title", layers, background: { kind: "gradient", colors: [dark, darker], angle: 160, dim: 0 } };
}

function textOverMedia(ctx: SceneCtx, textValue: string, media: MediaAsset): Built {
  const { f, sceneId, theme } = ctx;
  const w = 1 - f.safe.left - f.safe.right - 0.02;
  const fit = fitText(f, textValue, (f.portrait ? 104 : 92) * f.u, w, { maxLines: 3 });
  const y = 1 - f.safe.bottom - fit.h - 0.04;
  const layers: Layer[] = [
    media.kind === "video"
      ? ({ id: `${sceneId}_media`, type: "video", assetId: media.id, fit: "cover", trimInSec: 0, playbackRate: 1, muted: true, volume: 1, radiusPx: 0, box: box(0, 0, 1, 1, 1), timing: { start: 0 }, animation: { loop: "slow-zoom" }, locked: false, hidden: false } as Layer)
      : ({ id: `${sceneId}_media`, type: "image", assetId: media.id, fit: "cover", radiusPx: 0, shadow: false, box: box(0, 0, 1, 1, 1), timing: { start: 0 }, animation: { loop: "ken-burns" }, locked: false, hidden: false } as Layer),
    shape(`${sceneId}_scrim`, "rect", box(0, 0.45, 1, 0.56, 2), "#00000000", { gradientTo: "#000000B3" }),
    text(`${sceneId}_headline`, textValue, box(0.5 - w / 2, y, w, fit.h, 3), {
      size: fit.size,
      weight: 740,
      color: "#FFFFFF",
      shadow: true,
      enter: { preset: "blur-in", durationSec: 0.8 },
      highlight: { words: ctx.emphasis(textValue), color: mix(theme.accent, "#FFFFFF", 0.4) },
      claimIds: ctx.sb.claimIds,
    }),
  ];
  return { template: "text-over-media", layers, background: { kind: "solid", color: "#000000", angle: 180, dim: 0 } };
}

function deviceDemo(ctx: SceneCtx, textValue: string, asset: MediaAsset): Built {
  const { f, sceneId, theme, app } = ctx;
  const layers: Layer[] = [];
  if (f.landscape) {
    const tw = 0.42;
    const fit = fitText(f, textValue, 92 * f.u, tw, { maxLines: 4 });
    layers.push(glow(ctx, `${sceneId}_glow`, 0.72, 0.5, 0.75, theme.accent));
    layers.push(
      text(`${sceneId}_headline`, textValue, box(0.07, 0.5 - fit.h / 2, tw, fit.h, 3), {
        size: fit.size,
        align: "left",
        enter: ENTER_HEAD,
        highlight: { words: ctx.emphasis(textValue), color: "theme.accent" },
        claimIds: ctx.sb.claimIds,
      }),
    );
    layers.push(deviceLayer(`${sceneId}_device`, app, asset, deviceBox(f, app, asset, 0.72, 0.09, 0.86, 0.46), { enter: { preset: "slide-up", durationSec: 1.1, delaySec: 0.15, easing: "smooth" }, loop: "float" }));
  } else {
    const tw = 1 - f.safe.left - f.safe.right - 0.04;
    const fit = fitText(f, textValue, (f.portrait ? 84 : 72) * f.u, tw, { maxLines: f.portrait ? 3 : 2 });
    const headTop = f.safe.top + (f.portrait ? 0.01 : 0);
    layers.push(glow(ctx, `${sceneId}_glow`, 0.5, f.portrait ? 0.62 : 0.66, 0.85, theme.accent));
    layers.push(
      text(`${sceneId}_headline`, textValue, box(0.5 - tw / 2, headTop, tw, fit.h, 3), {
        size: fit.size,
        enter: ENTER_HEAD,
        highlight: { words: ctx.emphasis(textValue), color: "theme.accent" },
        claimIds: ctx.sb.claimIds,
      }),
    );
    const devTop = headTop + fit.h + (f.portrait ? 0.035 : 0.03);
    const devH = f.portrait ? Math.min(0.66, 1.0 - devTop + 0.02) : 1 - devTop + 0.06; // may bleed past the bottom edge
    layers.push(deviceLayer(`${sceneId}_device`, app, asset, deviceBox(f, app, asset, 0.5, devTop, devH, 0.86), { enter: { preset: "slide-up", durationSec: 1.1, delaySec: 0.15, easing: "smooth" }, loop: "float" }));
  }
  for (const l of layers) if (l.type === "shape") l.box.opacity = 0.35;
  return { template: "device-demo", layers, background: softBackground(ctx, ctx.index) };
}

function featureCallout(ctx: SceneCtx, textValue: string, asset: MediaAsset): Built {
  const { f, sceneId, theme, app, brand, sb } = ctx;
  const parts = splitParts(textValue);
  const head = parts[0] ?? textValue;
  const featureNames = sb.assets
    .map((h) => brand?.features.find((x) => x.id === h.featureId)?.name)
    .filter((x): x is string => !!x);
  const chips = (parts.length > 1 ? parts.slice(1) : featureNames).slice(0, 3);
  const layers: Layer[] = [];
  const tw = f.landscape ? 0.4 : 1 - f.safe.left - f.safe.right - 0.04;
  const fit = fitText(f, head, (f.portrait ? 80 : 72) * f.u, tw, { maxLines: f.portrait ? 3 : 2 });
  if (f.landscape) {
    layers.push(text(`${sceneId}_headline`, head, box(0.07, 0.14, tw, fit.h, 3), { size: fit.size, align: "left", enter: ENTER_HEAD, claimIds: sb.claimIds }));
    layers.push(deviceLayer(`${sceneId}_device`, app, asset, deviceBox(f, app, asset, 0.72, 0.08, 0.86, 0.44), { enter: { preset: "slide-left", durationSec: 1, easing: "smooth" }, loop: "tilt" }));
    chips.forEach((c, i) => {
      const chipH = 0.085;
      layers.push(
        blockChip(`${sceneId}_chip${i + 1}`, c, box(0.07, 0.14 + fit.h + 0.08 + i * (chipH + 0.04), 0.36, chipH, 4), 0.55 + i * 0.25),
      );
    });
  } else {
    const headTop = f.safe.top + 0.01;
    layers.push(text(`${sceneId}_headline`, head, box(0.5 - tw / 2, headTop, tw, fit.h, 3), { size: fit.size, enter: ENTER_HEAD, claimIds: sb.claimIds }));
    const devTop = headTop + fit.h + 0.04;
    const devH = f.portrait ? 0.6 : 1 - devTop - 0.02;
    const devBox = deviceBox(f, app, asset, chips.length ? 0.36 : 0.5, devTop, devH, chips.length ? 0.56 : 0.8);
    layers.push(deviceLayer(`${sceneId}_device`, app, asset, devBox, { enter: { preset: "slide-up", durationSec: 1.05, easing: "smooth" }, loop: "float" }));
    const chipH = f.portrait ? 0.042 : 0.07;
    const chipW = 0.46;
    chips.forEach((c, i) => {
      const y = devTop + devBox.h * (0.22 + i * 0.24);
      layers.push(blockChip(`${sceneId}_chip${i + 1}`, c, box(Math.min(1 - f.safe.right - chipW, devBox.x + devBox.w * 0.78), y, chipW, chipH, 4), 0.7 + i * 0.35));
    });
    if (!chips.length) {
      const d = 0.11 * Math.min(f.W, f.H);
      layers.push({
        id: `${sceneId}_tap`,
        type: "block",
        blockId: "tap-indicator",
        params: { atSec: 1.4 },
        box: box(devBox.x + devBox.w * 0.5 - d / f.W / 2, devBox.y + devBox.h * 0.55, d / f.W, d / f.H, 5),
        timing: { start: 0 },
        animation: { loop: "none" },
        locked: false,
        hidden: false,
      } as Layer);
    }
  }
  void theme;
  return { template: "feature-callout", layers, background: softBackground(ctx, ctx.index + 1) };
}

function blockChip(id: string, label: string, b: ReturnType<typeof box>, delay: number): Layer {
  return {
    id,
    type: "block",
    blockId: "callout-chip",
    params: { text: label.slice(0, 80) },
    box: b,
    timing: { start: 0 },
    animation: { enter: { preset: "pop", durationSec: 0.55, delaySec: delay, easing: "spring" }, loop: "none" },
    locked: false,
    hidden: false,
  } as Layer;
}

function founderCutout(ctx: SceneCtx, textValue: string, clip: MediaAsset, backdrop: MediaAsset | undefined): Built {
  const { f, sceneId, segs, app } = ctx;
  const seg = segs.find((s) => s.sourceAssetId === clip.id && s.status === "succeeded" && s.cutoutAssetId && (s.trackingQuality ?? 1) >= 0.5);
  const layers: Layer[] = [];
  const tw = 1 - f.safe.left - f.safe.right - 0.04;
  const fit = fitText(f, textValue, (f.portrait ? 72 : 64) * f.u, f.landscape ? 0.42 : tw, { maxLines: 3 });
  if (seg) {
    if (backdrop) {
      const b = f.landscape ? deviceBox(f, app, backdrop, 0.74, 0.1, 0.8, 0.4) : deviceBox(f, app, backdrop, 0.68, f.portrait ? 0.2 : 0.16, f.portrait ? 0.5 : 0.62, 0.5);
      layers.push(deviceLayer(`${sceneId}_device`, app, backdrop, { ...b, z: 2 }, { enter: { preset: "scale-in", durationSec: 0.9 }, loop: "float", rotation: 6 }));
    }
    layers.push({
      id: `${sceneId}_founder`,
      type: "video",
      assetId: clip.id,
      fit: "cover",
      trimInSec: 0,
      playbackRate: 1,
      muted: false,
      volume: 1,
      radiusPx: 0,
      mask: { segmentationId: seg.id, mode: "cutout", objectIds: [], feather: 1, fallback: "unmasked" },
      box: box(0, 0, 1, 1, 3),
      timing: { start: 0 },
      animation: { enter: { preset: "fade", durationSec: 0.5, delaySec: 0, easing: "smooth" }, loop: "none" },
      locked: false,
      hidden: false,
    } as Layer);
  } else {
    // Honest fallback: the unmasked recording in a rounded card.
    const cw = f.landscape ? 0.46 : 0.84;
    const ch = f.landscape ? 0.74 : f.portrait ? 0.56 : 0.62;
    layers.push({
      id: `${sceneId}_founder`,
      type: "video",
      assetId: clip.id,
      fit: "cover",
      trimInSec: 0,
      playbackRate: 1,
      muted: false,
      volume: 1,
      radiusPx: Math.round(44 * f.u),
      box: box(f.landscape ? 0.5 : 0.5 - cw / 2, f.landscape ? 0.13 : f.safe.top + fit.h + 0.05, cw, ch, 3),
      timing: { start: 0 },
      animation: { enter: { preset: "scale-in", durationSec: 0.8, delaySec: 0, easing: "smooth" }, loop: "none" },
      locked: false,
      hidden: false,
    } as Layer);
  }
  const headBox = f.landscape ? box(0.06, 0.5 - fit.h / 2, 0.42, fit.h, 4) : box(0.5 - tw / 2, f.safe.top, tw, fit.h, 4);
  layers.push(
    text(`${sceneId}_headline`, textValue, headBox, {
      size: fit.size,
      align: f.landscape ? "left" : "center",
      color: seg ? "#FFFFFF" : "theme.text",
      shadow: !!seg,
      enter: ENTER_HEAD,
      claimIds: ctx.sb.claimIds,
    }),
  );
  return { template: "founder-cutout", layers, background: seg ? { kind: "gradient", colors: [mix(ctx.theme.accent, "#000000", 0.55), mix(ctx.theme.accent, "#000000", 0.85)], angle: 160, dim: 0 } : softBackground(ctx, ctx.index) };
}

function beforeAfter(ctx: SceneCtx, textValue: string, before: MediaAsset, after: MediaAsset): Built {
  const { f, sceneId, app } = ctx;
  const parts = splitParts(textValue);
  const head = parts[0] ?? textValue;
  const labels = [parts[1] ?? "Before", parts[2] ?? "After"];
  const tw = 1 - f.safe.left - f.safe.right - 0.04;
  const fit = fitText(f, head, (f.portrait ? 76 : 68) * f.u, tw, { maxLines: 2 });
  const layers: Layer[] = [text(`${sceneId}_headline`, head, box(0.5 - tw / 2, f.safe.top, tw, fit.h, 3), { size: fit.size, enter: ENTER_HEAD, claimIds: ctx.sb.claimIds })];
  const labelSize = Math.round(34 * f.u);
  const top = f.safe.top + fit.h + 0.05;
  const devH = f.portrait ? 0.5 : 0.62;
  [before, after].forEach((a, i) => {
    const cx = i === 0 ? 0.28 : 0.72;
    const b = deviceBox(f, app, a, cx, top + (labelSize * 2) / f.H, devH, 0.42);
    layers.push(
      text(`${sceneId}_label${i + 1}`, labels[i]!, box(cx - 0.2, top, 0.4, (labelSize * 1.5) / f.H, 3), {
        role: "label",
        size: labelSize,
        weight: 650,
        font: "body",
        color: i === 0 ? "theme.textMuted" : "theme.accent",
        letterSpacing: 0,
        enter: { preset: "fade", durationSec: 0.5, delaySec: 0.3 + i * 0.5 },
      }),
    );
    layers.push(deviceLayer(`${sceneId}_device${i + 1}`, app, a, b, { enter: { preset: "slide-up", durationSec: 0.9, delaySec: 0.2 + i * 0.5 }, loop: "none" }));
  });
  return { template: "before-after", layers, background: softBackground(ctx, ctx.index) };
}

function splitScreen(ctx: SceneCtx, textValue: string, a: MediaAsset, b: MediaAsset | undefined): Built {
  const { f, sceneId, app } = ctx;
  if (!b) return deviceDemo(ctx, textValue, a);
  const built = beforeAfter(ctx, textValue, a, b);
  void app;
  void f;
  return { ...built, template: "split-screen", layers: built.layers.map((l) => (l.id === `${sceneId}_label1` || l.id === `${sceneId}_label2` ? { ...l, hidden: splitParts(textValue).length < 3 } : l)) };
}

function quoteProof(ctx: SceneCtx, textValue: string): Built {
  const { f, sceneId, theme } = ctx;
  const parts = textValue.split(/\s+[—–-]\s+/);
  const quote = (parts[0] ?? textValue).replace(/^["“]|["”]$/g, "");
  const source = parts.slice(1).join(" — ");
  const tw = f.landscape ? 0.7 : 1 - f.safe.left - f.safe.right - 0.06;
  const fit = fitText(f, `“${quote}”`, (f.portrait ? 70 : 64) * f.u, tw, { maxLines: 6, lineHeight: 1.15 });
  const y = 0.5 - fit.h / 2;
  const layers: Layer[] = [
    text(`${sceneId}_mark`, "“", box(0.5 - 0.1, y - (190 * f.u) / f.H, 0.2, (200 * f.u) / f.H, 2), { role: "label", size: Math.round(260 * f.u), weight: 800, color: "theme.accent", lineHeight: 1, enter: { preset: "scale-in", durationSec: 0.6 } }),
    text(`${sceneId}_quote`, `“${quote}”`, box(0.5 - tw / 2, y, tw, fit.h, 3), { role: "body", size: fit.size, weight: 600, lineHeight: 1.15, letterSpacing: -0.02, enter: { preset: "blur-in", durationSec: 0.9, delaySec: 0.2 }, claimIds: ctx.sb.claimIds }),
  ];
  if (source)
    layers.push(
      text(`${sceneId}_source`, source, box(0.5 - tw / 2, y + fit.h + 0.02, tw, (44 * f.u) / f.H, 3), { role: "label", size: Math.round(32 * f.u), weight: 550, font: "body", color: "theme.textMuted", letterSpacing: 0, enter: { preset: "fade", durationSec: 0.5, delaySec: 0.8 }, claimIds: ctx.sb.claimIds }),
    );
  void theme;
  return { template: "quote-proof", layers, background: softBackground(ctx, 1) };
}

function statCard(ctx: SceneCtx, textValue: string): Built {
  const { f, sceneId } = ctx;
  const m = /([$€£₹]?\d[\d.,]*\s?(?:[%x×+★kKmM]|\+)?)/.exec(textValue);
  const stat = m ? m[1]!.trim() : textValue.split(/\s+/)[0]!;
  const label = (m ? textValue.replace(m[1]!, "") : textValue.split(/\s+/).slice(1).join(" ")).replace(/^\W+|\s+$/g, "").trim();
  const statSize = Math.round(Math.min(300, (f.W * 0.8) / Math.max(2, stat.length * 0.6)) * (f.portrait ? 1 : 0.9));
  const tw = 1 - f.safe.left - f.safe.right - 0.06;
  const lf = fitText(f, label || " ", 54 * f.u, tw, { maxLines: 3 });
  const statH = (statSize * 1.1) / f.H;
  const y = 0.5 - (statH + lf.h + 0.02) / 2;
  const layers: Layer[] = [
    glow(ctx, `${sceneId}_glow`, 0.5, 0.45, 0.8, ctx.theme.accent),
    text(`${sceneId}_stat`, stat, box(0.5 - tw / 2, y, tw, statH, 3), { size: statSize, weight: 800, color: "theme.accent", lineHeight: 1, letterSpacing: -0.04, enter: { preset: "pop", durationSec: 0.7, easing: "spring" }, claimIds: ctx.sb.claimIds }),
  ];
  if (label) layers.push(text(`${sceneId}_label`, label, box(0.5 - tw / 2, y + statH + 0.02, tw, lf.h, 3), { role: "subhead", size: lf.size, weight: 600, lineHeight: 1.15, letterSpacing: -0.015, enter: { preset: "slide-up", durationSec: 0.6, delaySec: 0.35 }, claimIds: ctx.sb.claimIds }));
  for (const l of layers) if (l.type === "shape") l.box.opacity = 0.3;
  return { template: "stat-card", layers, background: softBackground(ctx, 0) };
}

function ctaEndcard(ctx: SceneCtx, textValue: string): Built {
  const { f, sceneId, app, picker, brand, theme } = ctx;
  const logo = picker.logo();
  const cta = (textValue || brand?.preferredCtas[0] || "Download now").slice(0, 60);
  const layers: Layer[] = [];
  const icon = Math.round((f.portrait ? 260 : 220) * f.u);
  const nameSize = Math.round((f.portrait ? 76 : 68) * f.u);
  const ctaSize = Math.round((f.portrait ? 44 : 40) * f.u);
  const ctaFit = fitText(f, cta, ctaSize, 0.8, { maxLines: 2 });
  const blockH = (logo ? icon + 60 * f.u : 0) + nameSize * 1.3 + 40 * f.u + ctaFit.h * f.H + 60 * f.u + 140 * f.u;
  let y = 0.47 - blockH / f.H / 2;
  layers.push(glow(ctx, `${sceneId}_glow`, 0.5, 0.42, 0.9, theme.accent));
  if (logo) {
    layers.push({
      id: `${sceneId}_icon`,
      type: "image",
      assetId: logo.id,
      fit: "cover",
      radiusPx: Math.round(icon * 0.225),
      shadow: true,
      box: box(0.5 - icon / f.W / 2, y, icon / f.W, icon / f.H, 3),
      timing: { start: 0 },
      animation: { enter: { preset: "pop", durationSec: 0.75, delaySec: 0, easing: "spring" }, loop: "none" },
      locked: false,
      hidden: false,
    } as Layer);
    y += (icon + 60 * f.u) / f.H;
  }
  layers.push(text(`${sceneId}_name`, app.name, box(0.08, y, 0.84, (nameSize * 1.3) / f.H, 3), { size: nameSize, weight: 760, enter: { preset: "slide-up", durationSec: 0.7, delaySec: 0.2 } }));
  y += (nameSize * 1.3 + 40 * f.u) / f.H;
  const pad = Math.round(26 * f.u);
  const ctaW = Math.min(0.84, (Math.min(cta.length, 28) * ctaSize * 0.56 + pad * 3) / f.W);
  layers.push(
    text(`${sceneId}_cta`, cta, box(0.5 - ctaW / 2, y, ctaW, ctaFit.h + (pad * 2) / f.H, 4), {
      role: "cta",
      size: ctaFit.size,
      weight: 650,
      font: "body",
      color: luminance(theme.accent) > 0.45 ? "#000000" : "#FFFFFF",
      letterSpacing: -0.01,
      background: { color: "theme.accent", paddingPx: pad, radiusPx: 200 },
      enter: { preset: "scale-in", durationSec: 0.6, delaySec: 0.45, easing: "spring" },
      loop: "pulse",
      claimIds: ctx.sb.claimIds,
    }),
  );
  y += ctaFit.h + (pad * 2) / f.H + (60 * f.u) / f.H;
  const ios = app.platforms.includes("ios") || !!app.storeUrls.ios;
  const android = app.platforms.includes("android") || !!app.storeUrls.android;
  const web = !ios && !android && (app.platforms.includes("web") || !!app.websiteUrl);
  if (ios || android || web) {
    layers.push({
      id: `${sceneId}_stores`,
      type: "block",
      blockId: "store-badges",
      params: { ios, android, web },
      box: box(0.1, y, 0.8, (96 * f.u) / f.H, 3),
      timing: { start: 0 },
      animation: { enter: { preset: "fade", durationSec: 0.6, delaySec: 0.8, easing: "smooth" }, loop: "none" },
      locked: false,
      hidden: false,
    } as Layer);
  }
  for (const l of layers) if (l.type === "shape") l.box.opacity = 0.2;
  return { template: "cta-endcard", layers, background: { kind: "solid", color: "theme.background", angle: 180, dim: 0 } };
}

function carouselSlide(ctx: SceneCtx, textValue: string, asset: MediaAsset | undefined): Built {
  const { f, sceneId, app } = ctx;
  const parts = splitParts(textValue);
  const head = parts[0] ?? textValue;
  const bodyText = parts.slice(1).join(" ");
  const tw = 1 - f.safe.left - f.safe.right - 0.04;
  const fit = fitText(f, head, 84 * f.u, tw, { maxLines: 3 });
  const layers: Layer[] = [text(`${sceneId}_headline`, head, box(0.5 - tw / 2, f.safe.top + 0.02, tw, fit.h, 3), { size: fit.size, highlight: { words: ctx.emphasis(head), color: "theme.accent" }, claimIds: ctx.sb.claimIds })];
  let y = f.safe.top + 0.02 + fit.h + 0.02;
  if (bodyText) {
    const bf = fitText(f, bodyText, 40 * f.u, tw, { maxLines: 3, lineHeight: 1.3 });
    layers.push(text(`${sceneId}_body`, bodyText, box(0.5 - tw / 2, y, tw, bf.h, 3), { role: "body", size: bf.size, weight: 500, font: "body", color: "theme.textMuted", lineHeight: 1.3, letterSpacing: -0.005, claimIds: ctx.sb.claimIds }));
    y += bf.h + 0.02;
  }
  if (asset) layers.push(deviceLayer(`${sceneId}_device`, app, asset, deviceBox(f, app, asset, 0.5, y + 0.02, 1 - y + 0.04, 0.8), { loop: "none" }));
  return { template: "carousel-slide", layers, background: softBackground(ctx, ctx.index) };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "your", "you", "is", "it", "my", "our", "at", "by", "be", "are", "this", "that", "from", "just", "all", "no", "not"]);

function emphasisWords(t: string): string[] {
  const words = t.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'’-]+/gu, "")).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()));
  if (!words.length) return [];
  // Emphasise the final meaningful word (Apple-style punchline colouring).
  return [words[words.length - 1]!];
}

function transitionFor(prev: TemplateId | undefined, next: TemplateId, durationSec: number): Scene["transitionIn"] {
  if (!prev) return { kind: "cut", durationSec: 0 };
  const cap = (d: number) => Math.min(d, durationSec / 2 - 0.01);
  if (prev === "hook-title") return { kind: "zoom", durationSec: cap(0.5) };
  if (next === "cta-endcard") return { kind: "fade", durationSec: cap(0.5) };
  if (next === "stat-card" || next === "quote-proof") return { kind: "blur", durationSec: cap(0.45) };
  if (next === "founder-cutout" || next === "text-over-media") return { kind: "fade", durationSec: cap(0.4) };
  return { kind: "slide-up", durationSec: cap(0.55) };
}

function captionCues(storyboard: Storyboard, starts: number[]): CaptionCue[] {
  const cues: CaptionCue[] = [];
  storyboard.scenes.forEach((s, i) => {
    const words = s.narration.split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const chunks: string[] = [];
    for (let k = 0; k < words.length; k += 6) chunks.push(words.slice(k, k + 6).join(" "));
    const dur = Math.max(0.5, Math.min(60, s.durationSec));
    const per = dur / chunks.length;
    chunks.forEach((c, k) => {
      cues.push({ id: `cue_${s.id}_${k + 1}`.slice(0, 120), startSec: r4(starts[i]! + k * per), endSec: r4(starts[i]! + (k + 1) * per - 0.02), text: c.slice(0, 300) });
    });
  });
  return cues;
}

function audioLabel(a: MediaAsset | undefined, kind: "music" | "voiceover", vo: Storyboard["voiceover"]["source"]): AudioTrack["sourceLabel"] {
  if (kind === "voiceover") return vo === "tts" || a?.role === "tts" ? "external_tts" : "founder_recording";
  if (!a) return "user_upload";
  if (a.origin === "stock") return "licensed_music";
  if (a.origin === "generated") return "generated";
  return "user_upload";
}

export function buildFromStoryboard(input: BuildInput & { aspectRatio?: AspectRatio; kind?: CompositionDoc["kind"] }): CompositionDoc {
  const { storyboard, app, brand } = input;
  const ar = input.aspectRatio ?? storyboard.aspectRatio;
  const f = frameFor(ar);
  const theme = themeFromBrand(brand);
  const picker = new AssetPicker(input.assets, brand, app);
  const segs = input.segmentations ?? [];
  const kind = input.kind ?? "video";
  const ordered = [...storyboard.scenes].sort((a, b) => a.order - b.order);
  const scenes: Scene[] = [];
  let prevTemplate: TemplateId | undefined;
  ordered.forEach((sb, index) => {
    const sceneId = `sc_${sb.id}`.slice(0, 100);
    const ctx: SceneCtx = { f, theme, app, brand, picker, segs, sb, sceneId, index, count: ordered.length, emphasis: emphasisWords };
    const requested = ((TEMPLATE_IDS as readonly string[]).includes(sb.template) ? sb.template : null) as TemplateId | null;
    const fallbackText = sb.onScreenText.trim() || (sb.purpose === "cta" ? "" : app.tagline || app.name);
    const t = kind === "video" ? (requested ?? defaultTemplate(sb)) : "carousel-slide";
    const built = buildScene(ctx, t, fallbackText);
    for (const l of built.layers) if (!l.name) l.name = layerName(l.id.slice(sceneId.length + 1), l);
    const durationSec = Math.max(0.5, Math.min(60, kind === "video" ? sb.durationSec : Math.max(1, sb.durationSec)));
    scenes.push({
      id: sceneId,
      name: `${index + 1}. ${sb.purpose[0]!.toUpperCase()}${sb.purpose.slice(1)}`.slice(0, 80),
      template: built.template,
      purpose: sb.purpose,
      durationSec: r4(durationSec),
      background: built.background,
      transitionIn: kind === "video" ? transitionFor(prevTemplate, built.template, durationSec) : { kind: "cut", durationSec: 0 },
      layers: built.layers,
      storyboardSceneId: sb.id,
      notes: sb.visual.slice(0, 1000),
    });
    prevTemplate = built.template;
  });

  const starts: number[] = [];
  scenes.reduce((t, s) => (starts.push(t), t + s.durationSec), 0);
  const audio: AudioTrack[] = [];
  if (kind === "video") {
    const vo = storyboard.voiceover;
    if (vo.source !== "none" && vo.assetId && picker.byId.get(vo.assetId)) {
      const a = picker.byId.get(vo.assetId);
      audio.push({ id: "aud_voiceover", kind: "voiceover", assetId: vo.assetId, startSec: 0, trimInSec: 0, volume: 1, fadeInSec: 0, fadeOutSec: 0.3, duckUnderVoice: false, sourceLabel: audioLabel(a, "voiceover", vo.source) });
    }
    if (storyboard.music.assetId && picker.byId.get(storyboard.music.assetId)) {
      const a = picker.byId.get(storyboard.music.assetId);
      audio.push({ id: "aud_music", kind: "music", assetId: storyboard.music.assetId, startSec: 0, trimInSec: 0, volume: 0.7, fadeInSec: 0.5, fadeOutSec: 1.2, duckUnderVoice: true, sourceLabel: audioLabel(a, "music", vo.source) });
    }
  }
  const cues = kind === "video" ? captionCues({ ...storyboard, scenes: ordered }, starts) : [];
  const doc = {
    schemaVersion: 1,
    title: storyboard.title.slice(0, 200),
    kind,
    aspectRatio: ar,
    width: f.W,
    height: f.H,
    fps: 30,
    theme,
    safeZone: f.safe,
    scenes,
    audio,
    captions: { enabled: kind === "video" && storyboard.voiceover.source !== "none" && cues.length > 0, preset: "boxed", position: "bottom", source: "script", cues },
    meta: { storyboardId: storyboard.id, generatedByRunId: storyboard.generatedByRunId, brandProfileVersion: brand?.version },
  };
  const v = validateDoc(doc);
  if (!v.ok) throw new Error(`buildFromStoryboard produced an invalid doc: ${v.errors.slice(0, 5).join("; ")}`);
  return v.doc;
}

const NAMES: Record<string, string> = { glow: "Glow", glow1: "Glow", glow2: "Glow 2", eyebrow: "Eyebrow", headline: "Headline", device: "Device", device1: "Device (before)", device2: "Device (after)", media: "Background media", scrim: "Scrim", founder: "Founder", tap: "Tap hint", mark: "Quote mark", quote: "Quote", source: "Source", stat: "Stat", label: "Label", label1: "Label 1", label2: "Label 2", icon: "App icon", name: "App name", cta: "Call to action", stores: "Store badges", body: "Body" };

function layerName(suffix: string, l: Layer): string {
  if (NAMES[suffix]) return NAMES[suffix]!;
  const m = /^chip(\d+)$/.exec(suffix);
  if (m) return `Callout ${m[1]}`;
  return l.type[0]!.toUpperCase() + l.type.slice(1);
}

function defaultTemplate(sb: StoryboardScene): TemplateId {
  switch (sb.purpose) {
    case "hook":
    case "problem":
      return "hook-title";
    case "demo":
      return "device-demo";
    case "feature":
      return "feature-callout";
    case "founder":
      return "founder-cutout";
    case "proof":
      return "stat-card";
    case "cta":
      return "cta-endcard";
    default:
      return "device-demo";
  }
}

function buildScene(ctx: SceneCtx, t: TemplateId, txt: string): Built {
  const { picker, sb } = ctx;
  const textOr = (fallback: string) => txt || fallback;
  switch (t) {
    case "hook-title": {
      const media = sb.assets.some((h) => ["stock_video", "stock_image", "generated_image"].includes(h.kind)) ? picker.backdrop(sb) : undefined;
      return media ? textOverMedia(ctx, textOr(ctx.app.name), media) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "text-over-media": {
      const media = picker.backdrop(sb);
      return media ? textOverMedia(ctx, textOr(ctx.app.name), media) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "device-demo": {
      const a = picker.product(sb, sb.assets.some((h) => h.kind === "app_recording") ? "app_recording" : "any");
      return a ? deviceDemo(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "feature-callout": {
      const a = picker.product(sb, "screenshot");
      return a ? featureCallout(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "founder-cutout": {
      const clip = picker.founderClip(sb);
      if (!clip) {
        const a = picker.product(sb);
        return a ? deviceDemo(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
      }
      return founderCutout(ctx, textOr(ctx.app.name), clip, picker.product(sb));
    }
    case "before-after":
    case "split-screen": {
      const a = picker.product(sb, "screenshot");
      const b = a ? picker.product(sb, "screenshot", [a.id]) : undefined;
      if (a && b) return t === "before-after" ? beforeAfter(ctx, textOr(ctx.app.name), a, b) : splitScreen(ctx, textOr(ctx.app.name), a, b);
      return a ? deviceDemo(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "quote-proof":
      return quoteProof(ctx, textOr(ctx.app.name));
    case "stat-card":
      return statCard(ctx, textOr(ctx.app.name));
    case "cta-endcard":
      return ctaEndcard(ctx, txt);
    case "carousel-slide":
      return carouselSlide(ctx, textOr(ctx.app.name), picker.product(sb));
    // Object-aware templates: placeholder layouts until module C implements tracked compositing
    // (presenter cutout in front of the demo, spotlight on the tracked phone, screen insert).
    case "presenter-depth":
    case "object-spotlight":
    case "product-in-hand":
      return buildScene(ctx, "founder-cutout", txt);
  }
}

export { frameFor as _frameFor, mix as mixColor };
export type { Frame as LayoutFrame };
export const _test = { emphasisWords, splitParts, themeFromBrand };
export type { CompositionDoc };
