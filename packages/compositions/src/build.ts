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
  type ClipAnalysis,
  type Layer,
  type MediaAsset,
  type RecordingSegment,
  type Region01,
  type Scene,
  type Segmentation,
  type Storyboard,
  type StoryboardScene,
  type TemplateId,
  type Theme,
} from "@muselaunch/contracts";
import { deviceGeometry, luminance } from "./compile";
import { estimateTextHeight } from "./lint";
import { validateDoc } from "./validate";

export interface BuildInput {
  storyboard: Storyboard;
  app: App;
  brand: BrandProfile | null;
  assets: MediaAsset[];
  segmentations?: Segmentation[];
  /** SAM clip analyses (module D) for founder clips; enable the object-aware templates. */
  clipAnalyses?: ClipAnalysis[];
  /** Walkthrough segments (scenes reference them with AssetHint.segmentId): trims, features, privacy regions. */
  recordingSegments?: RecordingSegment[];
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

/** Real product media for one scene: an asset, optionally one walkthrough segment of it. */
export interface ScreenMedia {
  asset: MediaAsset;
  segment?: RecordingSegment;
  /** How many earlier scenes of this video already showed this item (0 = first use). */
  use: number;
}

const isMarketing = (a: MediaAsset) => a.screenshotKind === "marketing" && a.sourceLabel !== "sam_ui_crop";

class AssetPicker {
  private used = new Map<string, number>();
  readonly byId: Map<string, MediaAsset>;
  readonly segments: Map<string, RecordingSegment>;
  /** Newest SAM screen cut-out per marketing screenshot. */
  private cropOf = new Map<string, MediaAsset>();
  constructor(
    readonly assets: MediaAsset[],
    readonly brand: BrandProfile | null,
    readonly app: App,
    segments: RecordingSegment[] = [],
  ) {
    this.byId = new Map(assets.filter((a) => USABLE.has(a.status)).map((a) => [a.id, a]));
    this.segments = new Map(segments.filter((s) => this.byId.get(s.assetId)?.kind === "video").map((s) => [s.id, s]));
    for (const a of this.byId.values()) {
      if (a.sourceLabel !== "sam_ui_crop" || !a.derivedFromAssetId || !a.isProductTruth || a.kind !== "image") continue;
      const prev = this.cropOf.get(a.derivedFromAssetId);
      if (!prev || a.createdAt > prev.createdAt) this.cropOf.set(a.derivedFromAssetId, a);
    }
  }
  private key(a: MediaAsset, seg?: RecordingSegment) {
    return seg ? `seg:${seg.id}` : a.id;
  }
  private pool(pred: (a: MediaAsset) => boolean) {
    return [...this.byId.values()].filter(pred).sort((a, b) => (this.used.get(a.id) ?? 0) - (this.used.get(b.id) ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  take(a: MediaAsset | undefined): MediaAsset | undefined {
    if (a) this.used.set(a.id, (this.used.get(a.id) ?? 0) + 1);
    return a;
  }
  private takeMedia(a: MediaAsset, segment?: RecordingSegment): ScreenMedia {
    const k = this.key(a, segment);
    const use = this.used.get(k) ?? 0;
    this.used.set(k, use + 1);
    if (segment) this.used.set(a.id, (this.used.get(a.id) ?? 0) + 1);
    return { asset: a, segment, use };
  }
  private truth(a: MediaAsset | undefined, exclude: string[]): a is MediaAsset {
    return !!a && a.isProductTruth && (a.role === "screenshot" || a.role === "app_recording") && !exclude.includes(a.id);
  }
  /** What may go inside a device frame: never a designed marketing screenshot (its SAM screen cut-out instead). */
  private framable(a: MediaAsset | undefined): MediaAsset | undefined {
    if (!a) return undefined;
    return isMarketing(a) ? this.cropOf.get(a.id) : a;
  }
  /**
   * Real product media for a device frame, honouring explicit hints (walkthrough segment, screenshot,
   * SAM cut-out, recording) and feature links; unhinted scenes get the least-used item.
   */
  screen(sb: StoryboardScene, prefer: "screenshot" | "app_recording" | "any" = "any", exclude: string[] = []): ScreenMedia | undefined {
    for (const h of sb.assets) {
      if (h.segmentId) {
        const seg = this.segments.get(h.segmentId);
        const rec = seg ? this.byId.get(seg.assetId) : undefined;
        if (seg && this.truth(rec, exclude)) return this.takeMedia(rec, seg);
      }
      if ((h.kind === "screenshot" || h.kind === "app_recording") && h.assetId) {
        const a = this.framable(this.byId.get(h.assetId));
        if (this.truth(a, exclude)) return this.takeMedia(a);
      }
    }
    const featureIds = sb.assets.map((h) => h.featureId).filter(Boolean) as string[];
    for (const fid of featureIds) {
      const feat = this.brand?.features.find((f) => f.id === fid);
      const linked = (feat?.assetIds ?? []).map((id) => this.framable(this.byId.get(id))).filter((a): a is MediaAsset => this.truth(a, exclude));
      const segs = [...this.segments.values()].filter((s) => s.featureIds.includes(fid) && !exclude.includes(s.assetId));
      const cands: { a: MediaAsset; seg?: RecordingSegment }[] = [...linked.map((a) => ({ a })), ...segs.map((seg) => ({ a: this.byId.get(seg.assetId)!, seg }))];
      cands.sort((x, y) => (this.used.get(this.key(x.a, x.seg)) ?? 0) - (this.used.get(this.key(y.a, y.seg)) ?? 0));
      if (cands[0]) return this.takeMedia(cands[0].a, cands[0].seg);
    }
    const wantsRecording = prefer === "app_recording" || sb.assets.some((h) => h.kind === "app_recording");
    const recs = this.pool((a) => this.truth(a, exclude) && a.kind === "video");
    const shots = this.pool((a) => this.truth(a, exclude) && a.kind === "image" && !isMarketing(a)).filter((a) => a.sourceLabel === "sam_ui_crop" || !this.cropOf.has(a.id));
    const marketingCrops = this.pool((a) => this.truth(a, exclude) && isMarketing(a)).map((a) => this.cropOf.get(a.id)).filter((a): a is MediaAsset => !!a && !exclude.includes(a.id));
    const stills = [...shots, ...marketingCrops.filter((c) => !shots.includes(c))].sort((a, b) => (this.used.get(a.id) ?? 0) - (this.used.get(b.id) ?? 0));
    const a = wantsRecording ? (recs[0] ?? stills[0]) : (stills[0] ?? recs[0]);
    return a ? this.takeMedia(a) : undefined;
  }
  /** Back-compat: the asset of `screen()`. */
  product(sb: StoryboardScene, prefer: "screenshot" | "app_recording" | "any" = "any", exclude: string[] = []): MediaAsset | undefined {
    return this.screen(sb, prefer, exclude)?.asset;
  }
  /**
   * A designed marketing screenshot for a full-screen shot (never framed). Falls back to a raw
   * screenshot when the app has no marketing images.
   */
  showcase(sb: StoryboardScene): ScreenMedia | undefined {
    for (const h of sb.assets) {
      if (h.kind !== "screenshot" || !h.assetId) continue;
      let a = this.byId.get(h.assetId);
      if (a?.sourceLabel === "sam_ui_crop" && a.derivedFromAssetId) a = this.byId.get(a.derivedFromAssetId) ?? a;
      if (this.truth(a, []) && a.kind === "image") return this.takeMedia(a);
    }
    const marketing = this.pool((a) => this.truth(a, []) && a.kind === "image" && isMarketing(a));
    const raw = this.pool((a) => this.truth(a, []) && a.kind === "image" && !isMarketing(a));
    const a = marketing[0] ?? raw[0];
    return a ? this.takeMedia(a) : undefined;
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

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * A region of the media (fractions of the screenshot / recording frame Spark saw) → fractions of the
 * device's visible screen. The screen shows the media `cover`-fitted and top-aligned (object-position
 * 50% 0%), so a taller image loses its bottom and a wider one its sides.
 */
export function mediaToScreen(r: Region01, mediaAspect: number, screenAspect: number): Region01 {
  let { x, y, w, h } = r;
  if (mediaAspect < screenAspect) {
    const k = mediaAspect / screenAspect;
    y /= k;
    h /= k;
  } else if (mediaAspect > screenAspect) {
    const k = screenAspect / mediaAspect;
    x = (x - (1 - k) / 2) / k;
    w /= k;
  }
  const x0 = clamp01(x);
  const y0 = clamp01(y);
  return { x: r4(x0), y: r4(y0), w: r4(Math.max(0, clamp01(x + w) - x0)), h: r4(Math.max(0, clamp01(y + h) - y0)) };
}

/** Different crops of the same screen when an item has to appear more than once. */
const DEFAULT_FOCUS: Region01[] = [
  { x: 0.06, y: 0.14, w: 0.88, h: 0.3 },
  { x: 0.06, y: 0.42, w: 0.88, h: 0.28 },
  { x: 0.06, y: 0.66, w: 0.88, h: 0.24 },
];

type FocusOpt = Region01 & { zoom?: number; atSec?: number; ring?: boolean };

/**
 * Device layer for real product media: walkthrough segments are trimmed into the screen (sped up to at
 * most 1.5× when longer than the scene), whole recordings continue across scenes, flagged personal
 * information is blurred, and focus/tap/tilt come in as fractions of the media and leave as fractions
 * of the visible screen.
 */
function screenLayer(ctx: SceneCtx, id: string, m: ScreenMedia, b: ReturnType<typeof box>, o: { enter?: TextOpts["enter"]; loop?: string; start?: number; rotation?: number; focus?: FocusOpt; tap?: { x: number; y: number; atSec?: number }; tilt?: { x: number; y: number; swing?: boolean } } = {}): Layer {
  const { f, app } = ctx;
  const asset = m.asset;
  const { device } = deviceFor(app, asset);
  const video = asset.kind === "video";
  let trimIn = 0;
  let trimOut: number | undefined;
  let rate: number | undefined;
  const slot = Math.max(0.5, ctx.durationSec - (o.start ?? 0));
  if (video && m.segment) {
    trimIn = m.segment.startSec;
    trimOut = m.segment.endSec;
    const len = m.segment.endSec - m.segment.startSec;
    if (len > slot * 1.02) rate = Math.round(Math.min(1.5, len / slot) * 100) / 100;
  } else if (video) {
    // A whole recording shown again continues where the previous scene stopped.
    const cur = ctx.clipCursor.get(asset.id) ?? 0;
    trimIn = cur + 1 < (asset.durationSec ?? Infinity) ? cur : 0;
    ctx.clipCursor.set(asset.id, trimIn + slot);
  }
  const g = deviceGeometry(device, b.w * f.W, b.h * f.H);
  const screenAspect = g.screen.width / Math.max(1, g.screen.height);
  const mediaAspect = asset.width && asset.height ? asset.width / asset.height : screenAspect;
  const toScreen = (r: Region01) => mediaToScreen(r, mediaAspect, screenAspect);
  const usable = (r: Region01) => r.w >= 0.02 && r.h >= 0.01;
  const blur = m.segment?.privacy.flagged ? m.segment.privacy.regions.map(toScreen).filter(usable) : [];
  let focus: Extract<Layer, { type: "device" }>["focus"];
  if (o.focus) {
    const r = toScreen(o.focus);
    const region = usable(r) ? r : DEFAULT_FOCUS[m.use % DEFAULT_FOCUS.length]!;
    focus = { ...region, ...(o.focus.zoom ? { zoom: o.focus.zoom } : {}), atSec: r4(o.focus.atSec ?? 0.6), ring: o.focus.ring ?? true };
  }
  let tap: Extract<Layer, { type: "device" }>["tap"];
  if (o.tap) {
    const p = toScreen({ x: o.tap.x, y: o.tap.y, w: 0, h: 0 });
    tap = { x: p.x, y: p.y, atSec: r4(o.tap.atSec ?? 1) };
  }
  return {
    id,
    type: "device",
    device,
    screenAssetId: asset.id,
    screenKind: video ? "video" : "image",
    trimInSec: r4(trimIn),
    ...(trimOut !== undefined ? { trimOutSec: r4(trimOut) } : {}),
    ...(rate ? { playbackRate: rate } : {}),
    frameColor: "black",
    shadow: true,
    ...(focus ? { focus } : {}),
    ...(tap ? { tap } : {}),
    ...(o.tilt ? { tilt: { x: o.tilt.x, y: o.tilt.y, swing: o.tilt.swing ?? true } } : {}),
    ...(blur.length ? { blurRegions: blur.slice(0, 8) } : {}),
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

/** The scene's focus region (Spark's box) or a different default crop per reuse of the item. */
function sceneFocus(ctx: SceneCtx, m: ScreenMedia): Region01 {
  return ctx.sb.focus ?? DEFAULT_FOCUS[m.use % DEFAULT_FOCUS.length]!;
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
  analyses: ClipAnalysis[];
  /** Per-clip playback cursor so a presenter clip keeps playing across consecutive scenes. */
  clipCursor: Map<string, number>;
  durationSec: number;
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

interface ShotOpts {
  template?: TemplateId;
  focus?: FocusOpt;
  tap?: { x: number; y: number; atSec?: number };
  /** Background-coloured band behind the headline so a pushed-in screen never runs under the text. */
  scrim?: boolean;
  deviceEnter?: TextOpts["enter"];
  loop?: string;
}

/** Headline + real screen in a device: the wide shot, and (with focus/tap) the close-ups. */
function deviceDemo(ctx: SceneCtx, textValue: string, m: ScreenMedia, o: ShotOpts = {}): Built {
  const { f, sceneId, theme, app } = ctx;
  const asset = m.asset;
  const layers: Layer[] = [];
  const bg = softBackground(ctx, ctx.index);
  const bgTop = (bg.colors?.[0] ?? theme.background).slice(0, 7);
  const bgBottom = (bg.colors?.[1] ?? theme.background).slice(0, 7);
  // An item shown again gets a different crop (a gentle push-in on another part of the screen).
  const focus = o.focus ?? (m.use > 0 ? { ...DEFAULT_FOCUS[m.use % DEFAULT_FOCUS.length]!, zoom: 1.55, ring: false, atSec: 0.2 } : undefined);
  const scrim = o.scrim ?? !!focus;
  const devOpts = { enter: o.deviceEnter ?? { preset: "slide-up", durationSec: 1.1, delaySec: 0.15, easing: "smooth" }, loop: o.loop ?? (focus ? "none" : "float"), focus, tap: o.tap };
  const scrimIn = { preset: "fade", durationSec: 0.5, delaySec: r4(Math.max(0, Math.min(ctx.durationSec - 0.6, focus?.atSec ?? 0.6))), easing: "smooth" };
  let headBox: ReturnType<typeof box>;
  if (f.landscape) {
    const tw = 0.42;
    const fit = fitText(f, textValue, 92 * f.u, tw, { maxLines: 4 });
    headBox = box(0.07, 0.5 - fit.h / 2, tw, fit.h, 6);
    layers.push(glow(ctx, `${sceneId}_glow`, 0.72, 0.5, 0.75, theme.accent));
    layers.push(text(`${sceneId}_headline`, textValue, headBox, { size: fit.size, align: "left", enter: ENTER_HEAD, highlight: { words: ctx.emphasis(textValue), color: "theme.accent" }, claimIds: ctx.sb.claimIds }));
    layers.push(screenLayer(ctx, `${sceneId}_device`, m, deviceBox(f, app, asset, 0.72, 0.09, 0.86, 0.46), devOpts));
    if (scrim) layers.push({ ...shape(`${sceneId}_scrim`, "rect", box(0, 0, 0.5, 1, 5), `${bgTop}F5`, { gradientTo: `${bgBottom}F5`, enter: scrimIn }), name: "Headline backdrop" } as Layer);
  } else {
    const tw = 1 - f.safe.left - f.safe.right - 0.04;
    const fit = fitText(f, textValue, (f.portrait ? 84 : 72) * f.u, tw, { maxLines: f.portrait ? 3 : 2 });
    const headTop = f.safe.top + (f.portrait ? 0.01 : 0);
    headBox = box(0.5 - tw / 2, headTop, tw, fit.h, 6);
    layers.push(glow(ctx, `${sceneId}_glow`, 0.5, f.portrait ? 0.62 : 0.66, 0.85, theme.accent));
    layers.push(text(`${sceneId}_headline`, textValue, headBox, { size: fit.size, enter: ENTER_HEAD, highlight: { words: ctx.emphasis(textValue), color: "theme.accent" }, claimIds: ctx.sb.claimIds }));
    const devTop = headTop + fit.h + (f.portrait ? 0.035 : 0.03);
    const devH = f.portrait ? Math.min(0.66, 1.0 - devTop + 0.02) : 1 - devTop + 0.06; // may bleed past the bottom edge
    layers.push(screenLayer(ctx, `${sceneId}_device`, m, deviceBox(f, app, asset, 0.5, devTop, devH, 0.86), devOpts));
    if (scrim) {
      // Solid behind the headline, a short fade below it; both appear as the screen pushes in under them.
      const headBottom = Math.min(0.45, headTop + fit.h + 0.012);
      layers.push({ ...shape(`${sceneId}_scrim`, "rect", box(0, 0, 1, headBottom, 5), `${bgTop}F7`, { enter: scrimIn }), name: "Headline backdrop" } as Layer);
      layers.push({ ...shape(`${sceneId}_scrimfade`, "rect", box(0, headBottom, 1, 0.07, 5), `${bgTop}F7`, { gradientTo: `${bgTop}00`, enter: scrimIn }), name: "Headline backdrop fade" } as Layer);
    }
  }
  for (const l of layers) if (l.type === "shape" && l.id.endsWith("_glow")) l.box.opacity = 0.35;
  return { template: o.template ?? "device-demo", layers, background: bg };
}

/** Close-up: the device pushes in on the region that matters, with a soft highlight ring. */
function focusZoom(ctx: SceneCtx, textValue: string, m: ScreenMedia): Built {
  const d = ctx.durationSec;
  const region = sceneFocus(ctx, m);
  return deviceDemo(ctx, textValue, m, { template: "focus-zoom", focus: { ...region, atSec: Math.max(0.3, Math.min(0.9, d * 0.28)), ring: true }, deviceEnter: { preset: "fade", durationSec: 0.6, delaySec: 0, easing: "smooth" } });
}

/** The action: a finger dot taps the control (centre of the focus region), with a gentle push-in. */
function tapDemo(ctx: SceneCtx, textValue: string, m: ScreenMedia): Built {
  const d = ctx.durationSec;
  const region = ctx.sb.focus;
  const point = region ? { x: region.x + region.w / 2, y: region.y + region.h / 2 } : { x: 0.5, y: 0.5 };
  const atSec = Math.max(0.9, Math.min(1.6, d * 0.45));
  const focus = region ? { ...region, zoom: 1.3, ring: false, atSec: 0.25 } : undefined;
  return deviceDemo(ctx, textValue, m, { template: "tap-demo", focus, tap: { ...point, atSec }, scrim: !!focus, loop: "none" });
}

function featureCallout(ctx: SceneCtx, textValue: string, m: ScreenMedia): Built {
  const { f, sceneId, theme, app, brand, sb } = ctx;
  const asset = m.asset;
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
    layers.push(screenLayer(ctx, `${sceneId}_device`, m, deviceBox(f, app, asset, 0.72, 0.08, 0.86, 0.44), { enter: { preset: "slide-left", durationSec: 1, easing: "smooth" }, loop: "tilt" }));
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
    layers.push(screenLayer(ctx, `${sceneId}_device`, m, devBox, { enter: { preset: "slide-up", durationSec: 1.05, easing: "smooth" }, loop: "float" }));
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

function founderCutout(ctx: SceneCtx, textValue: string, clip: MediaAsset, backdrop: ScreenMedia | undefined): Built {
  const { f, sceneId, segs, app } = ctx;
  const seg = segs.find((s) => s.sourceAssetId === clip.id && s.status === "succeeded" && s.cutoutAssetId && (s.trackingQuality ?? 1) >= 0.5);
  const layers: Layer[] = [];
  const tw = 1 - f.safe.left - f.safe.right - 0.04;
  const fit = fitText(f, textValue, (f.portrait ? 72 : 64) * f.u, f.landscape ? 0.42 : tw, { maxLines: 3 });
  if (seg) {
    if (backdrop) {
      const b = f.landscape ? deviceBox(f, app, backdrop.asset, 0.74, 0.1, 0.8, 0.4) : deviceBox(f, app, backdrop.asset, 0.68, f.portrait ? 0.2 : 0.16, f.portrait ? 0.5 : 0.62, 0.5);
      layers.push(screenLayer(ctx, `${sceneId}_device`, backdrop, { ...b, z: 2 }, { enter: { preset: "scale-in", durationSec: 0.9 }, loop: "float", rotation: 6 }));
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

/** One pane of a two-up: real product media in a device, or a supporting image/video card (stock, generated, upload). */
type Pane = { screen: ScreenMedia } | { media: MediaAsset };

function beforeAfter(ctx: SceneCtx, textValue: string, before: Pane, after: Pane, template: "before-after" | "split-screen" = "before-after"): Built {
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
  [before, after].forEach((pane, i) => {
    const cx = i === 0 ? 0.28 : 0.72;
    const y = top + (labelSize * 2) / f.H;
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
    const enter = { preset: "slide-up", durationSec: 0.9, delaySec: 0.2 + i * 0.5, easing: "smooth" };
    if ("screen" in pane) {
      layers.push(screenLayer(ctx, `${sceneId}_device${i + 1}`, pane.screen, deviceBox(f, app, pane.screen.asset, cx, y, devH, 0.42), { enter, loop: "none" }));
    } else {
      // Supporting media (never the app UI) as a rounded card the same height as a device.
      const wFrac = 0.42;
      const hFrac = Math.min(devH, (wFrac * f.W * 1.9) / f.H);
      const b = box(cx - wFrac / 2, y, wFrac, hFrac, 2);
      const common = { id: `${sceneId}_media${i + 1}`, assetId: pane.media.id, fit: "cover", radiusPx: Math.round(36 * f.u), box: b, timing: { start: 0 }, animation: { enter: { ...enter, durationSec: 0.9 }, loop: "slow-zoom" }, locked: false, hidden: false };
      layers.push((pane.media.kind === "video" ? { ...common, type: "video", trimInSec: 0, playbackRate: 1, muted: true, volume: 1 } : { ...common, type: "image", shadow: true }) as Layer);
    }
  });
  return { template, layers, background: softBackground(ctx, ctx.index) };
}

function splitScreen(ctx: SceneCtx, textValue: string, a: Pane, b: Pane | undefined): Built {
  const { sceneId } = ctx;
  if (!b) return "screen" in a ? deviceDemo(ctx, textValue, a.screen) : textOverMedia(ctx, textValue, a.media);
  const built = beforeAfter(ctx, textValue, a, b, "split-screen");
  return { ...built, layers: built.layers.map((l) => (l.id === `${sceneId}_label1` || l.id === `${sceneId}_label2` ? { ...l, hidden: splitParts(textValue).length < 3 } : l)) };
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

function ctaEndcard(ctx: SceneCtx, textValue: string, store = false): Built {
  const { f, sceneId, app, picker, brand, theme } = ctx;
  const logo = picker.logo();
  const cta = (textValue || brand?.preferredCtas[0] || "Download now").slice(0, 60);
  const layers: Layer[] = [];
  const icon = Math.round((f.portrait ? 260 : 220) * f.u);
  const nameSize = Math.round((f.portrait ? 76 : 68) * f.u);
  const ctaSize = Math.round((f.portrait ? 44 : 40) * f.u);
  const ctaFit = fitText(f, cta, ctaSize, 0.8, { maxLines: 2 });
  const stackedPills = store && f.portrait && [app.platforms.includes("ios") || !!app.storeUrls.ios, app.platforms.includes("android") || !!app.storeUrls.android].filter(Boolean).length > 1;
  const blockH = (logo ? icon + 60 * f.u : 0) + nameSize * 1.3 + 40 * f.u + ctaFit.h * f.H + 60 * f.u + (store ? (stackedPills ? 250 : 140) : 140) * f.u;
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
    const stack = store && f.portrait && [ios, android, web].filter(Boolean).length > 1;
    const pillsH = store ? (stack ? 230 : 120) * f.u : 96 * f.u;
    layers.push({
      id: `${sceneId}_stores`,
      type: "block",
      blockId: "store-badges",
      params: store ? { ios, android, web, full: true, stack } : { ios, android, web },
      box: box(0.1, Math.min(y, 1 - f.safe.bottom - pillsH / f.H), 0.8, pillsH / f.H, 3),
      timing: { start: 0 },
      animation: { enter: { preset: store ? "slide-up" : "fade", durationSec: 0.6, delaySec: store ? 0.6 : 0.8, easing: "smooth" }, loop: "none" },
      locked: false,
      hidden: false,
    } as Layer);
  }
  for (const l of layers) if (l.type === "shape") l.box.opacity = 0.2;
  return { template: store ? "store-cta" : "cta-endcard", layers, background: store ? { kind: "gradient", colors: [theme.background, mix(theme.accent, "#FFFFFF", 0.86)], angle: 180, dim: 0 } : { kind: "solid", color: "theme.background", angle: 180, dim: 0 } };
}

/** Wide hero: the real screen in a device turning in 3D over a parallax background. */
function phoneTilt(ctx: SceneCtx, textValue: string, m: ScreenMedia): Built {
  const { f, sceneId, theme, app } = ctx;
  const d = ctx.durationSec;
  const dark = mix(theme.accent, "#05050A", 0.78);
  const darker = mix(theme.accent, "#000000", 0.93);
  const layers: Layer[] = [];
  // Parallax: two soft glows drifting against the device's turn (depth without extra media).
  const drift = (l: Layer, dx: number) => {
    const b = l.box;
    l.animation = { ...l.animation, loop: "none", keyframes: [{ t: 0, x: r4(b.x + dx), y: b.y }, { t: r4(d), x: r4(b.x - dx), y: b.y, easing: "linear" }] };
    return l;
  };
  const g1 = drift(glow(ctx, `${sceneId}_glow1`, 0.26, f.portrait ? 0.36 : 0.3, 0.75, theme.accent), 0.07);
  const g2 = drift(glow(ctx, `${sceneId}_glow2`, 0.8, f.portrait ? 0.78 : 0.75, 0.6, theme.accent2 ?? theme.accent), -0.04);
  g1.box.opacity = 0.55;
  g2.box.opacity = 0.42;
  layers.push(g1, g2);
  const tilt = { x: 9, y: -22, swing: true };
  if (f.landscape) {
    const tw = 0.42;
    const fit = fitText(f, textValue, 92 * f.u, tw, { maxLines: 3 });
    layers.push(text(`${sceneId}_headline`, textValue, box(0.07, 0.5 - fit.h / 2, tw, fit.h, 6), { size: fit.size, align: "left", color: "#FFFFFF", enter: ENTER_HEAD, highlight: { words: ctx.emphasis(textValue), color: mix(theme.accent, "#FFFFFF", 0.4) }, claimIds: ctx.sb.claimIds }));
    layers.push(screenLayer(ctx, `${sceneId}_device`, m, deviceBox(f, app, m.asset, 0.72, 0.1, 0.82, 0.44), { enter: { preset: "scale-in", durationSec: 1, delaySec: 0.1, easing: "smooth" }, loop: "none", tilt }));
  } else {
    const tw = 1 - f.safe.left - f.safe.right - 0.04;
    const fit = fitText(f, textValue, (f.portrait ? 86 : 74) * f.u, tw, { maxLines: 2 });
    const headTop = f.safe.top + 0.01;
    layers.push(text(`${sceneId}_headline`, textValue, box(0.5 - tw / 2, headTop, tw, fit.h, 6), { size: fit.size, color: "#FFFFFF", enter: ENTER_HEAD, highlight: { words: ctx.emphasis(textValue), color: mix(theme.accent, "#FFFFFF", 0.4) }, claimIds: ctx.sb.claimIds }));
    const devTop = headTop + fit.h + 0.05;
    layers.push(screenLayer(ctx, `${sceneId}_device`, m, deviceBox(f, app, m.asset, 0.5, devTop, Math.min(f.portrait ? 0.62 : 0.66, 1 - devTop - 0.02), 0.8), { enter: { preset: "scale-in", durationSec: 1, delaySec: 0.1, easing: "smooth" }, loop: "none", tilt }));
  }
  return { template: "phone-tilt", layers, background: { kind: "gradient", colors: [dark, darker], angle: 160, dim: 0 } };
}

/**
 * Lines of ≤ 3 words for kinetic type: break at sentence punctuation first, then split each phrase
 * into balanced lines (4 words → 2 + 2, never a lone orphan word); at most 4 lines.
 */
function kineticLines(t: string): string[] {
  const phrases = t.split(/(?<=[.!?:;—–])\s+/).map((p) => p.split(/\s+/).filter(Boolean)).filter((p) => p.length);
  const lines: string[] = [];
  for (const words of phrases) {
    const n = Math.ceil(words.length / 3);
    const per = Math.floor(words.length / n);
    let extra = words.length % n;
    let i = 0;
    for (let k = 0; k < n; k++) {
      const len = per + (extra-- > 0 ? 1 : 0);
      lines.push(words.slice(i, i + len).join(" "));
      i += len;
    }
  }
  while (lines.length > 4) {
    // Merge the shortest neighbouring pair.
    let best = 0;
    for (let k = 1; k < lines.length - 1; k++) if (lines[k]!.length + lines[k + 1]!.length < lines[best]!.length + lines[best + 1]!.length) best = k;
    lines.splice(best, 2, `${lines[best]} ${lines[best + 1]}`);
  }
  return lines.length ? lines : [t];
}

/** Punchy type only: each line appears word by word at ~3 words per second; the last line is the punchline. */
function kineticType(ctx: SceneCtx, textValue: string): Built {
  const { f, sceneId, theme } = ctx;
  const lines = kineticLines(textValue);
  const tw = 1 - f.safe.left - f.safe.right - 0.04;
  const base = (f.portrait ? 132 : f.landscape ? 112 : 116) * f.u;
  // One size for every line so the block reads as one statement.
  const size = Math.min(...lines.map((l) => fitText(f, l, base, tw, { maxLines: 1, min: base * 0.5 }).size));
  const lineH = (size * 1.08) / f.H;
  const gap = (size * 0.12) / f.H;
  const blockH = lines.length * lineH + (lines.length - 1) * gap;
  let y = 0.5 - blockH / 2;
  let wordsBefore = 0;
  const layers: Layer[] = [];
  const pace = 1 / 3; // seconds per word: about 3 words per second
  lines.forEach((line, i) => {
    const words = line.split(/\s+/).filter(Boolean).length;
    const start = Math.min(Math.max(0, ctx.durationSec - 1), r4(0.15 + wordsBefore * pace));
    const last = i === lines.length - 1 && lines.length > 1;
    layers.push(
      text(`${sceneId}_line${i + 1}`, line, box(0.5 - tw / 2, y, tw, lineH, 3), {
        size,
        weight: 820,
        color: last ? mix(theme.accent, "#FFFFFF", 0.3) : "#FFFFFF",
        lineHeight: 1.02,
        letterSpacing: -0.045,
        align: f.landscape ? "left" : "center",
        start,
        enter: { preset: "words", durationSec: r4(Math.min(5, words * pace)), easing: "snappy" },
        claimIds: ctx.sb.claimIds,
      }),
    );
    wordsBefore += words;
    y += lineH + gap;
  });
  return { template: "kinetic-type", layers, background: { kind: "gradient", colors: [mix(theme.accent, "#08080C", 0.88), "#050507"], angle: 165, dim: 0 } };
}

/** Brand beat: the real app icon scales in with a glow, then the name (and an optional short line). */
function iconReveal(ctx: SceneCtx, textValue: string): Built {
  const { f, sceneId, theme, app, picker } = ctx;
  const logo = picker.logo();
  if (!logo) return kineticType(ctx, textValue || app.name);
  const icon = Math.round((f.portrait ? 340 : 280) * f.u);
  const nameSize = Math.round((f.portrait ? 92 : 80) * f.u);
  const sub = textValue && textValue.trim().toLowerCase() !== app.name.trim().toLowerCase() ? textValue : "";
  const subFit = sub ? fitText(f, sub, 50 * f.u, 0.84, { maxLines: 2, lineHeight: 1.2 }) : null;
  const blockH = icon / f.H + (70 * f.u) / f.H + (nameSize * 1.25) / f.H + (subFit ? subFit.h + 0.015 : 0);
  let y = 0.48 - blockH / 2;
  const halo = Math.min(f.W, f.H) * 0.95;
  const layers: Layer[] = [
    shape(`${sceneId}_glow`, "circle", box(0.5 - halo / f.W / 2, y + icon / f.H / 2 - halo / f.H / 2, halo / f.W, halo / f.H, 1), theme.accent, { blurPx: Math.round(120 * f.u), enter: { preset: "scale-in", durationSec: 1.2, delaySec: 0, easing: "smooth" }, loop: "pulse" }),
  ];
  layers[0]!.box.opacity = 0.45;
  layers.push({
    id: `${sceneId}_icon`,
    type: "image",
    assetId: logo.id,
    fit: "cover",
    radiusPx: Math.round(icon * 0.225),
    shadow: true,
    box: box(0.5 - icon / f.W / 2, y, icon / f.W, icon / f.H, 3),
    timing: { start: 0 },
    animation: { enter: { preset: "pop", durationSec: 0.8, delaySec: 0.1, easing: "spring" }, loop: "float" },
    locked: false,
    hidden: false,
  } as Layer);
  y += icon / f.H + (70 * f.u) / f.H;
  layers.push(text(`${sceneId}_name`, app.name, box(0.08, y, 0.84, (nameSize * 1.25) / f.H, 4), { size: nameSize, weight: 780, color: "#FFFFFF", enter: { preset: "blur-in", durationSec: 0.7, delaySec: 0.55 } }));
  y += (nameSize * 1.25) / f.H + 0.015;
  if (sub && subFit) layers.push(text(`${sceneId}_sub`, sub, box(0.08, y, 0.84, subFit.h, 4), { role: "subhead", size: subFit.size, weight: 560, font: "body", color: "#FFFFFFCC", lineHeight: 1.2, letterSpacing: -0.01, enter: { preset: "fade", durationSec: 0.6, delaySec: 0.9 }, claimIds: ctx.sb.claimIds }));
  return { template: "icon-reveal", layers, background: { kind: "gradient", colors: [mix(theme.accent, "#07070B", 0.72), "#060608"], angle: 180, dim: 0 } };
}

/**
 * A designed marketing screenshot, full screen with a slow push. It already carries its own device
 * frame and headline, so it is never framed again; it sits on a blurred copy of itself when its
 * shape differs from the video's.
 */
function fullscreenShowcase(ctx: SceneCtx, textValue: string, m: ScreenMedia): Built {
  const { f, sceneId } = ctx;
  const a = m.asset;
  const ma = a.width && a.height ? a.width / a.height : f.W / f.H;
  const cover = Math.abs(ma - f.W / f.H) / (f.W / f.H) < 0.08;
  const layers: Layer[] = [
    {
      id: `${sceneId}_media`,
      type: "image",
      assetId: a.id,
      fit: cover ? "cover" : "contain",
      radiusPx: 0,
      shadow: !cover,
      box: box(0, 0, 1, 1, 2),
      timing: { start: 0 },
      animation: { enter: { preset: "fade", durationSec: 0.5, delaySec: 0, easing: "smooth" }, loop: m.use % 2 ? "ken-burns" : "slow-zoom" },
      locked: false,
      hidden: false,
    } as Layer,
  ];
  // Short caption only: the screenshot already has its own headline.
  const caption = textValue.trim();
  if (caption && caption.split(/\s+/).length <= 8) {
    const tw = 1 - f.safe.left - f.safe.right - 0.08;
    const fit = fitText(f, caption, (f.portrait ? 46 : 40) * f.u, tw, { maxLines: 2, lineHeight: 1.15 });
    const pad = Math.round(22 * f.u);
    const h = fit.h + (pad * 2) / f.H;
    layers.push(
      text(`${sceneId}_caption`, caption, box(0.5 - tw / 2, 1 - f.safe.bottom - h - 0.01, tw, h, 4), {
        role: "caption",
        size: fit.size,
        weight: 650,
        font: "body",
        color: "#FFFFFF",
        lineHeight: 1.15,
        letterSpacing: -0.01,
        background: { color: "#000000B3", paddingPx: pad, radiusPx: 200 },
        enter: { preset: "slide-up", durationSec: 0.5, delaySec: 0.5 },
        claimIds: ctx.sb.claimIds,
      }),
    );
  }
  return { template: "fullscreen-showcase", layers, background: cover ? { kind: "solid", color: "#000000", angle: 180, dim: 0 } : { kind: "blur", assetId: a.id, color: "#000000", angle: 180, dim: 0.25 } };
}

function carouselSlide(ctx: SceneCtx, textValue: string, m: ScreenMedia | undefined): Built {
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
  if (m) layers.push(screenLayer(ctx, `${sceneId}_device`, m, deviceBox(f, app, m.asset, 0.5, y + 0.02, 1 - y + 0.04, 0.8), { loop: "none" }));
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

/** Editor-style cuts: hard cuts into punchy type and close-ups, softer moves into wide shots and end cards. */
function transitionFor(prev: TemplateId | undefined, next: TemplateId, durationSec: number, index = 0): Scene["transitionIn"] {
  if (!prev) return { kind: "cut", durationSec: 0 };
  const cap = (d: number) => Math.min(d, durationSec / 2 - 0.01);
  if (next === "kinetic-type") return { kind: "cut", durationSec: 0 };
  if (prev === "hook-title" || prev === "kinetic-type") return { kind: "zoom", durationSec: cap(0.5) };
  if (next === "cta-endcard" || next === "store-cta") return { kind: "fade", durationSec: cap(0.5) };
  if (next === "icon-reveal") return { kind: "zoom", durationSec: cap(0.5) };
  if (next === "focus-zoom" || next === "tap-demo") return { kind: "cut", durationSec: 0 };
  if (next === "stat-card" || next === "quote-proof") return { kind: "blur", durationSec: cap(0.45) };
  if (next === "founder-cutout" || next === "text-over-media" || next === "fullscreen-showcase") return { kind: "fade", durationSec: cap(0.4) };
  if (next === "phone-tilt") return { kind: "slide-left", durationSec: cap(0.55) };
  return { kind: index % 2 ? "slide-left" : "slide-up", durationSec: cap(0.55) };
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
  const picker = new AssetPicker(input.assets, brand, app, input.recordingSegments ?? []);
  const segs = input.segmentations ?? [];
  const kind = input.kind ?? "video";
  const ordered = [...storyboard.scenes].sort((a, b) => a.order - b.order);
  const clipCursor = new Map<string, number>();
  const scenes: Scene[] = [];
  let prevTemplate: TemplateId | undefined;
  ordered.forEach((sb, index) => {
    const sceneId = `sc_${sb.id}`.slice(0, 100);
    const ctx: SceneCtx = { f, theme, app, brand, picker, segs, sb, sceneId, index, count: ordered.length, emphasis: emphasisWords, analyses: input.clipAnalyses ?? [], clipCursor, durationSec: Math.max(0.5, Math.min(60, sb.durationSec)) };
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
      transitionIn: kind === "video" ? transitionFor(prevTemplate, built.template, durationSec, index) : { kind: "cut", durationSec: 0 },
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

const NAMES: Record<string, string> = { glow: "Glow", glow1: "Glow", glow2: "Glow 2", eyebrow: "Eyebrow", headline: "Headline", device: "Device", device1: "Device (before)", device2: "Device (after)", media: "Background media", media1: "Media 1", media2: "Media 2", scrim: "Scrim", founder: "Founder", tap: "Tap hint", mark: "Quote mark", quote: "Quote", source: "Source", stat: "Stat", label: "Label", label1: "Label 1", label2: "Label 2", icon: "App icon", name: "App name", sub: "Subline", cta: "Call to action", stores: "Store badges", body: "Body", caption: "Caption" };

function layerName(suffix: string, l: Layer): string {
  if (NAMES[suffix]) return NAMES[suffix]!;
  const m = /^chip(\d+)$/.exec(suffix);
  if (m) return `Callout ${m[1]}`;
  const line = /^line(\d+)$/.exec(suffix);
  if (line) return `Line ${line[1]}`;
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
      const a = picker.screen(sb, sb.assets.some((h) => h.kind === "app_recording") ? "app_recording" : "any");
      return a ? deviceDemo(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "focus-zoom": {
      const a = picker.screen(sb);
      return a ? focusZoom(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "tap-demo": {
      const a = picker.screen(sb, sb.assets.some((h) => h.kind === "app_recording") ? "app_recording" : "any");
      return a ? tapDemo(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "phone-tilt": {
      const a = picker.screen(sb);
      return a ? phoneTilt(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "fullscreen-showcase": {
      const a = picker.showcase(sb);
      return a ? fullscreenShowcase(ctx, txt, a) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "feature-callout": {
      const a = picker.screen(sb, "screenshot");
      return a ? featureCallout(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "founder-cutout": {
      const clip = picker.founderClip(sb);
      if (!clip) {
        const a = picker.screen(sb);
        return a ? deviceDemo(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
      }
      return founderCutout(ctx, textOr(ctx.app.name), clip, picker.screen(sb));
    }
    case "before-after":
    case "split-screen": {
      const a = picker.screen(sb, "screenshot");
      // Split screens may pair the app with supporting b-roll (stock/generated, never the app UI).
      const support = t === "split-screen" && sb.assets.some((h) => h.assetId && SUPPORT_KINDS.has(h.kind)) ? picker.backdrop(sb) : undefined;
      const second = support ? undefined : a ? picker.screen(sb, "screenshot", [a.asset.id]) : undefined;
      const b: Pane | undefined = support ? { media: support } : second ? { screen: second } : undefined;
      if (a && b) return t === "before-after" ? beforeAfter(ctx, textOr(ctx.app.name), { screen: a }, b) : splitScreen(ctx, textOr(ctx.app.name), { screen: a }, b);
      if (!a && support) return textOverMedia(ctx, textOr(ctx.app.name), support);
      return a ? deviceDemo(ctx, textOr(ctx.app.name), a) : hookTitle(ctx, textOr(ctx.app.name));
    }
    case "quote-proof":
      return quoteProof(ctx, textOr(ctx.app.name));
    case "stat-card":
      return statCard(ctx, textOr(ctx.app.name));
    case "kinetic-type":
      return kineticType(ctx, textOr(ctx.app.name));
    case "icon-reveal":
      return iconReveal(ctx, txt);
    case "cta-endcard":
      return ctaEndcard(ctx, txt);
    case "store-cta":
      return ctaEndcard(ctx, txt, true);
    case "carousel-slide":
      return carouselSlide(ctx, textOr(ctx.app.name), picker.screen(sb));
    case "presenter-depth":
    case "object-spotlight":
    case "product-in-hand":
      return objectAware(ctx, t, textOr(ctx.app.name)) ?? buildScene(ctx, "founder-cutout", txt);
  }
}

const SUPPORT_KINDS = new Set(["stock_video", "stock_image", "generated_image"]);

// ---------------------------------------------------------------------------
// Object-aware templates (SAM tracks + cutouts of a real founder clip)
// ---------------------------------------------------------------------------

const PERSON = /person|presenter|founder|people|human|man|woman|speaker|body/i;
const PHONE = /phone|smartphone|mobile|iphone|android|device|tablet|screen/i;
const HAND = /hand/i;

interface ClipObjects {
  clip: MediaAsset;
  analysis: ClipAnalysis;
  person?: ClipAnalysis["objects"][number];
  phone?: ClipAnalysis["objects"][number];
  hand?: ClipAnalysis["objects"][number];
  usable: (o: ClipAnalysis["objects"][number] | undefined) => boolean;
  cutoutReady: (o: ClipAnalysis["objects"][number] | undefined) => boolean;
}

function clipObjects(ctx: SceneCtx): ClipObjects | null {
  const clip = ctx.picker.founderClip(ctx.sb);
  if (!clip) return null;
  const analysis = ctx.analyses.find((a) => a.sourceAssetId === clip.id && (a.status === "succeeded" || a.status === "partial"));
  if (!analysis) return null;
  const pick = (re: RegExp) => analysis.objects.find((o) => re.test(`${o.key} ${o.label}`));
  const segOf = (o: ClipAnalysis["objects"][number] | undefined) => (o ? ctx.segs.find((s) => s.id === o.segmentationId) : undefined);
  const usable = (o: ClipAnalysis["objects"][number] | undefined) => {
    const seg = segOf(o);
    return !!o && !!seg && seg.status === "succeeded" && (o.trackingQuality ?? seg.trackingQuality ?? 1) >= 0.5;
  };
  const cutoutReady = (o: ClipAnalysis["objects"][number] | undefined) => {
    const seg = segOf(o);
    return usable(o) && !!(seg!.objectOutputs?.[o!.objectId]?.cutoutAssetId ?? seg!.cutoutAssetId);
  };
  return { clip, analysis, person: pick(PERSON), phone: pick(PHONE), hand: pick(HAND), usable, cutoutReady };
}

function baseClip(ctx: SceneCtx, clip: MediaAsset): Layer {
  const trimIn = ctx.clipCursor.get(clip.id) ?? 0;
  const avail = clip.durationSec ?? Infinity;
  const start = trimIn + 0.5 < avail ? trimIn : 0;
  ctx.clipCursor.set(clip.id, start + ctx.durationSec);
  return {
    id: `${ctx.sceneId}_clip`,
    name: "Presenter clip",
    type: "video",
    assetId: clip.id,
    fit: "cover",
    trimInSec: r4(start),
    playbackRate: 1,
    muted: false,
    volume: 1,
    radiusPx: 0,
    box: box(0, 0, 1, 1, 1),
    timing: { start: 0 },
    animation: { loop: "none" },
    locked: false,
    hidden: false,
  } as Layer;
}

function cutoutLayer(id: string, name: string, base: Layer, obj: ClipAnalysis["objects"][number], z: number): Layer {
  const b = base as Extract<Layer, { type: "video" }>;
  return {
    ...structuredClone(b),
    id,
    name,
    muted: true,
    box: { ...b.box, z },
    mask: { segmentationId: obj.segmentationId, mode: "cutout", objectIds: [obj.objectId], feather: 1, fallback: "hide" },
  } as Layer;
}

function effect(id: string, name: string, kind: Extract<Layer, { type: "effect" }>["effect"], obj: ClipAnalysis["objects"][number], z: number, o: { intensity?: number; color?: string; assetId?: string; enter?: TextOpts["enter"] } = {}): Layer {
  return {
    id,
    name,
    type: "effect",
    effect: kind,
    target: { segmentationId: obj.segmentationId, objectId: obj.objectId },
    intensity: o.intensity ?? 0.7,
    color: o.color,
    assetId: o.assetId,
    box: box(0, 0, 1, 1, z),
    timing: { start: 0 },
    animation: { enter: o.enter ? { preset: o.enter.preset, durationSec: o.enter.durationSec ?? 0.6, delaySec: o.enter.delaySec ?? 0, easing: o.enter.easing ?? "smooth" } : undefined, loop: "none" },
    locked: false,
    hidden: false,
  } as Layer;
}

function topHeadline(ctx: SceneCtx, value: string, z: number, size = 88): Layer {
  const { f } = ctx;
  const tw = 1 - f.safe.left - f.safe.right - 0.02;
  const fit = fitText(f, value, size * f.u, f.landscape ? 0.5 : tw, { maxLines: f.landscape ? 3 : 2 });
  const b = f.landscape ? box(0.06, f.safe.top + 0.02, 0.5, fit.h, z) : box(0.5 - tw / 2, f.safe.top + 0.005, tw, fit.h, z);
  return text(`${ctx.sceneId}_headline`, value, b, {
    size: fit.size,
    weight: 760,
    color: "#FFFFFF",
    align: f.landscape ? "left" : "center",
    shadow: true,
    enter: ENTER_HEAD,
    highlight: { words: ctx.emphasis(value), color: mix(ctx.theme.accent, "#FFFFFF", 0.35) },
    claimIds: ctx.sb.claimIds,
  });
}

function anchoredChip(ctx: SceneCtx, label: string, obj: ClipAnalysis["objects"][number], z: number, point: "top" | "right" | "left" = "top"): Layer {
  const { f } = ctx;
  const chipH = f.portrait ? 0.042 : 0.07;
  const chipW = Math.min(0.62, (label.length * 0.55 * 34 * f.u + 120 * f.u) / f.W);
  const mb = obj.meanBbox ?? { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
  const fx = point === "right" ? mb.x + mb.w + chipW / 2 + 0.02 : point === "left" ? mb.x - chipW / 2 - 0.02 : mb.x + mb.w / 2;
  const fy = point === "top" ? mb.y - chipH : mb.y + mb.h / 2;
  const layer = blockChip(`${ctx.sceneId}_chip1`, label, box(Math.min(1 - chipW, Math.max(0, fx - chipW / 2)), Math.max(0, fy - chipH / 2), chipW, chipH, z), 0.6);
  return {
    ...layer,
    name: "Callout (follows phone)",
    anchor: {
      segmentationId: obj.segmentationId,
      objectId: obj.objectId,
      point,
      offset: point === "top" ? { x: 0, y: -(chipH * 0.9) } : { x: point === "right" ? chipW / 2 + 0.015 : -(chipW / 2 + 0.015), y: 0 },
      scaleWithObject: false,
      smoothFrames: 7,
      whenLost: "hold",
    },
  } as Layer;
}

function objectAware(ctx: SceneCtx, t: "presenter-depth" | "object-spotlight" | "product-in-hand", value: string): Built | null {
  const co = clipObjects(ctx);
  if (!co) return null;
  const { f, sceneId, theme, app } = ctx;
  const parts = splitParts(value);
  const head = parts[0] ?? value;
  const featureNames = ctx.sb.assets.map((h) => ctx.brand?.features.find((x) => x.id === h.featureId)?.name).filter((x): x is string => !!x);
  const chipText = (parts[1] ?? featureNames[0])?.slice(0, 40);
  const darkBg: Scene["background"] = { kind: "solid", color: "#000000", angle: 180, dim: 0 };
  const shade = (z: number, strength = 1) => shape(`${sceneId}_shade`, "rect", box(0, 0, 1, 1, z), `#000000${Math.round(0x18 * strength).toString(16).padStart(2, "0")}`, { gradientTo: `#000000${Math.round(0x99 * strength).toString(16).padStart(2, "0")}` });
  /** Top scrim so white headlines stay legible over bright footage. */
  const scrim = (z: number) => ({ ...shape(`${sceneId}_scrim`, "rect", box(0, 0, 1, f.portrait ? 0.34 : 0.42, z), "#000000A6", { gradientTo: "#00000000" }), name: "Headline scrim" }) as Layer;

  if (t === "presenter-depth") {
    if (!co.usable(co.person)) return null;
    const base = baseClip(ctx, co.clip);
    const demoMedia = ctx.picker.screen(ctx.sb, "app_recording");
    const demo = demoMedia?.asset;
    const layers: Layer[] = [base, { ...shade(2, 0.9), name: "Depth shade" } as Layer, scrim(2)];
    const mean = co.person!.meanBbox ?? { x: 0.3, y: 0.2, w: 0.4, h: 0.8 };
    // Put the demo on the side away from the phone in hand (else away from the presenter's mass).
    const phoneMean = co.phone?.meanBbox;
    const personLeft = phoneMean ? phoneMean.x + phoneMean.w / 2 < 0.5 === false : mean.x + mean.w / 2 < 0.5;
    // Separate vertical bands, top to bottom: headline → wordmark (behind the head) → app demo.
    const headline = topHeadline(ctx, head, 8, 84);
    let bandTop = headline.box.y + headline.box.h + 0.022;
    if (co.cutoutReady(co.person)) {
      // Big word behind the presenter: reads as depth when the cutout sits in front of it. Faded so
      // the headline above stays the first read.
      const word = (app.name || head).toUpperCase().slice(0, 14);
      const gw = 1 - f.safe.left - f.safe.right;
      const gx = f.safe.left;
      const size = Math.round(Math.min((f.portrait ? 240 : 200) * f.u, (f.W * gw * 0.96) / Math.max(3, word.length * 0.62)));
      const gh = (size * 1.05) / f.H;
      layers.push(
        text(`${sceneId}_ghost`, word, box(gx, bandTop, gw, gh, 3), {
          role: "label",
          size,
          weight: 860,
          color: "#FFFFFF",
          lineHeight: 0.95,
          letterSpacing: -0.04,
          enter: { preset: "blur-in", durationSec: 1.1, delaySec: 0.1 },
        }),
      );
      layers[layers.length - 1]!.box.opacity = 0.72;
      layers[layers.length - 1]!.name = "Word behind presenter";
      bandTop += gh + 0.012;
    }
    if (demo) {
      // The phone is on the right when personLeft === false (we keep the demo away from it).
      const demoRight = phoneMean ? phoneMean.x + phoneMean.w / 2 < 0.5 : personLeft;
      // Sized to the room beside the presenter (they may overlap its inner edge: that is the depth
      // effect) and kept wholly inside the platform safe zone, rotation included.
      const room = demoRight ? 1 - f.safe.right - (mean.x + mean.w) : mean.x - f.safe.left;
      const maxW = Math.min(f.landscape ? 0.34 : 0.42, Math.max(f.landscape ? 0.2 : f.portrait ? 0.36 : 0.3, room / 0.6));
      const y = Math.max(bandTop, f.portrait ? 0.3 : 0.32);
      const hFrac = Math.max(0.24, Math.min(f.portrait ? 0.44 : 0.6, 1 - f.safe.bottom - y - 0.03));
      const rot = demoRight ? 4 : -4;
      const raw = deviceBox(f, app, demo, 0.5, y, hFrac, maxW);
      const th = (Math.abs(rot) * Math.PI) / 180;
      const extX = (raw.w * f.W * Math.cos(th) + raw.h * f.H * Math.sin(th)) / 2 / f.W;
      const cx = demoRight ? 1 - f.safe.right - extX : f.safe.left + extX;
      const devB = { ...raw, x: cx - raw.w / 2 };
      layers.push(screenLayer(ctx, `${sceneId}_device`, demoMedia!, { ...devB, z: 4 }, { enter: { preset: demoRight ? "slide-left" : "slide-right", durationSec: 1.1, delaySec: 0.25 }, loop: "tilt", rotation: rot }));
      layers[layers.length - 1]!.name = "App demo (behind presenter)";
    }
    if (co.cutoutReady(co.person)) layers.push(cutoutLayer(`${sceneId}_presenter`, "Presenter (cutout, in front)", base, co.person!, 6));
    // The phone in hand is foreground too (a person mask has a hole where the phone occludes them).
    if (co.cutoutReady(co.phone)) layers.push(cutoutLayer(`${sceneId}_phone`, "Phone in hand (cutout, in front)", base, co.phone!, 7));
    layers.push(headline);
    return { template: t, layers, background: darkBg };
  }

  if (t === "object-spotlight") {
    const target = co.usable(co.phone) ? co.phone! : co.usable(co.person) ? co.person! : null;
    if (!target) return null;
    const base = baseClip(ctx, co.clip);
    const layers: Layer[] = [
      base,
      effect(`${sceneId}_spot`, "Spotlight", "spotlight", target, 2, { intensity: 0.8, enter: { preset: "fade", durationSec: 0.6 } }),
      effect(`${sceneId}_ring`, "Highlight ring", "highlight-ring", target, 3, { intensity: 0.85, color: "theme.accent", enter: { preset: "scale-in", durationSec: 0.5, delaySec: 0.35, easing: "spring" } }),
    ];
    if (chipText) layers.push(anchoredChip(ctx, chipText, target, 5, "top"));
    else layers.push(effect(`${sceneId}_arrow`, "Arrow", "follow-arrow", target, 5, { color: "theme.accent", enter: { preset: "pop", durationSec: 0.5, delaySec: 0.5 } }));
    layers.push(topHeadline(ctx, head, 8, 80));
    return { template: t, layers, background: darkBg };
  }

  // product-in-hand
  const demo = ctx.picker.product(ctx.sb, "app_recording");
  if (!co.usable(co.phone) || !demo) return null;
  const base = baseClip(ctx, co.clip);
  const layers: Layer[] = [
    base,
    scrim(2),
    effect(`${sceneId}_screen`, "App on the phone (real recording)", "screen-insert", co.phone!, 3, { assetId: demo.id, intensity: 1, enter: { preset: "fade", durationSec: 0.4, delaySec: 0.15 } }),
  ];
  const over = co.cutoutReady(co.hand) ? co.hand : co.cutoutReady(co.person) ? co.person : undefined;
  if (over) layers.push(cutoutLayer(`${sceneId}_hand`, over === co.hand ? "Hand (over the screen)" : "Presenter (over the screen)", base, over, 4));
  if (chipText) layers.push(anchoredChip(ctx, chipText, co.phone!, 5, (co.phone!.meanBbox?.x ?? 0.5) > 0.5 ? "left" : "right"));
  layers.push(topHeadline(ctx, head, 8, 80));
  void theme;
  return { template: t, layers, background: darkBg };
}

export { frameFor as _frameFor, mix as mixColor };
export type { Frame as LayoutFrame };
export const _test = { emphasisWords, splitParts, themeFromBrand, kineticLines };
export type { CompositionDoc };
