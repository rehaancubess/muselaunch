"use client";
/**
 * Clip intelligence (SAM tracks of real founder clips) for the Studio: data from
 * GET /compositions/:id/clips, and deterministic PatchOp builders for one-click object-aware effects.
 * Every op is validated server-side; effects degrade gracefully if tracking is unreliable.
 */
import type { ClipAnalysis, TracksFile } from "@muselaunch/contracts";
import { useApiQuery } from "@/lib/query";
import { newLayerId } from "./ops";
import type { CompositionDoc, Layer, MediaAsset, PatchOp, Scene } from "./types";

export interface ClipSegmentationView {
  id: string;
  prompt: string;
  status: string;
  trackingQuality: number | null;
  hasCutout: boolean;
  hasTracks: boolean;
}

export interface ClipItem {
  asset: MediaAsset;
  url: string | null;
  posterUrl: string | null;
  usedInDoc: boolean;
  analysis: ClipAnalysis | null;
  segmentations: ClipSegmentationView[];
}

export interface ClipsResponse {
  items: ClipItem[];
  tracks: Record<string, TracksFile>;
}

/** A tracked object, flattened for pickers and effects. */
export interface ClipObject {
  key: string;
  label: string;
  segmentationId: string;
  objectId: string;
  quality: number | null;
  clipAssetId: string;
  analysisId: string;
  meanBbox?: { x: number; y: number; w: number; h: number };
  hasCutout: boolean;
  hasTracks: boolean;
}

export function useClips(base: string, enabled = true) {
  return useApiQuery<ClipsResponse>(enabled ? `${base}/clips` : null, {
    staleTime: 60_000,
    // Signed clip URLs last 30 min; analysis may be running.
    refetchInterval: (q) => (q.state.data?.items.some((i) => i.analysis && (i.analysis.status === "queued" || i.analysis.status === "running")) ? 4000 : 10 * 60_000),
  });
}

export function clipObjects(items: ClipItem[] | undefined): ClipObject[] {
  const out: ClipObject[] = [];
  for (const it of items ?? []) {
    const a = it.analysis;
    if (!a || (a.status !== "succeeded" && a.status !== "partial")) continue;
    for (const o of a.objects) {
      const seg = it.segmentations.find((s) => s.id === o.segmentationId);
      out.push({
        key: o.key,
        label: o.label,
        segmentationId: o.segmentationId,
        objectId: o.objectId,
        quality: o.trackingQuality ?? seg?.trackingQuality ?? null,
        clipAssetId: it.asset.id,
        analysisId: a.id,
        meanBbox: o.meanBbox,
        hasCutout: !!seg?.hasCutout,
        hasTracks: !!seg?.hasTracks,
      });
    }
  }
  return out;
}

export const isPerson = (o: ClipObject) => /person|presenter|founder|people|human|man|woman|speaker|body/i.test(`${o.key} ${o.label}`);
export const isPhone = (o: ClipObject) => /phone|smartphone|mobile|iphone|android|device|tablet|screen/i.test(`${o.key} ${o.label}`);
export const isHand = (o: ClipObject) => /hand/i.test(`${o.key} ${o.label}`);

/** Usable analyses of the clips this doc shows or targets (sent to Spark as object-aware context, max 4). */
export function docAnalysisIds(doc: CompositionDoc, items: ClipItem[] | undefined): string[] {
  const assetIds = new Set<string>();
  const segIds = new Set<string>();
  for (const sc of doc.scenes)
    for (const l of sc.layers) {
      if (l.type === "video") assetIds.add(l.assetId);
      if (l.type === "video" && l.mask) segIds.add(l.mask.segmentationId);
      if (l.type === "effect") segIds.add(l.target.segmentationId);
      if (l.anchor) segIds.add(l.anchor.segmentationId);
    }
  const ids: string[] = [];
  for (const it of items ?? []) {
    const a = it.analysis;
    if (!a || (a.status !== "succeeded" && a.status !== "partial")) continue;
    if (assetIds.has(it.asset.id) || Object.values(a.segmentationIds).some((s) => segIds.has(s))) ids.push(a.id);
  }
  return [...new Set(ids)].slice(0, 4);
}

// ---------------------------------------------------------------------------
// One-click effects → PatchOps (deterministic; no model call)
// ---------------------------------------------------------------------------

type VideoL = Extract<Layer, { type: "video" }>;
type EffectL = Extract<Layer, { type: "effect" }>;
const full = (z: number) => ({ x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, z });
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function sceneClipLayer(scene: Scene, clipAssetId: string): VideoL | undefined {
  return scene.layers.find((l): l is VideoL => l.type === "video" && l.assetId === clipAssetId && !l.mask && !l.hidden);
}

/**
 * Working z-order for one edit: new layers are slotted in and existing ones lifted so headlines and
 * callouts stay in front, keeping every other relative order. Emits add_layer + minimal z updates.
 */
class Stack {
  private items: { id: string; type: Layer["type"]; z: number; orig: number; order: number; cutout: boolean; layer?: Layer; index?: number; place?: { x?: number; y?: number } }[];
  private n: number;
  constructor(private scene: Scene) {
    this.items = scene.layers.map((l, i) => ({ id: l.id, type: l.type, z: l.box.z, orig: l.box.z, order: i, cutout: l.type === "video" && l.mask?.mode === "cutout" && !l.hidden }));
    this.n = this.items.length;
  }
  zOf(id: string) {
    return this.items.find((x) => x.id === id)?.z ?? 0;
  }
  /** Top z among layers matching `pred` (-1 if none). */
  top(pred: (t: Layer["type"]) => boolean) {
    return this.items.filter((x) => pred(x.type)).reduce((m, x) => Math.max(m, x.z), -1);
  }
  /** Free `count` z values starting at `slot`; text/callouts move above them unless they sit behind an existing cutout (intentional depth). */
  room(slot: number, count: number) {
    const cutMin = this.items.filter((x) => x.cutout).reduce((m, x) => Math.min(m, x.z), Infinity);
    const behindCutout = (z: number) => Number.isFinite(cutMin) && z < cutMin;
    const lift = this.items.filter((x) => x.z >= slot || ((x.type === "text" || x.type === "block") && !behindCutout(x.z)));
    lift.sort((p, q) => p.z - q.z || p.order - q.order).forEach((x, i) => (x.z = Math.min(100, Math.max(x.z, slot + count + i))));
    return slot;
  }
  /** Move an existing layer (position only; z is managed by `room`). */
  place(id: string, at: { x?: number; y?: number }) {
    const it = this.items.find((x) => x.id === id && !x.layer);
    if (it) it.place = { ...it.place, ...at };
  }
  add(layer: Layer, z: number, index?: number) {
    this.items.push({ id: layer.id, type: layer.type, z, orig: -1, order: index !== undefined ? -1 : this.n++, cutout: false, layer, index });
    return layer;
  }
  ops(): PatchOp[] {
    const adds: PatchOp[] = this.items.filter((x) => x.layer).map((x) => ({ op: "add_layer", sceneId: this.scene.id, layer: { ...x.layer!, box: { ...x.layer!.box, z: x.z } } as Layer, ...(x.index !== undefined ? { index: x.index } : {}) }));
    const moves: PatchOp[] = this.items.filter((x) => !x.layer && (x.z !== x.orig || x.place)).map((x) => ({ op: "update_layer", sceneId: this.scene.id, layerId: x.id, set: { box: { ...x.place, z: x.z } } }));
    return [...moves, ...adds];
  }
}

/**
 * Make sure the scene shows the clip full-frame: added above decorative shapes (they were the
 * backdrop of a footage-less scene) and below media, text and callouts.
 */
function ensureClip(st: Stack, scene: Scene, clipAssetId: string): VideoL {
  const existing = sceneClipLayer(scene, clipAssetId);
  if (existing) return existing;
  const slot = st.room(st.top((t) => t === "shape") + 1, 1);
  return st.add(
    {
      id: newLayerId("ly_clip"),
      name: "Presenter clip",
      type: "video",
      assetId: clipAssetId,
      fit: "cover",
      trimInSec: 0,
      playbackRate: 1,
      muted: false,
      volume: 1,
      radiusPx: 0,
      box: full(slot),
      timing: { start: 0 },
      animation: { loop: "none" },
      locked: false,
      hidden: false,
    } as VideoL,
    slot,
    0,
  ) as VideoL;
}

/** First z above the footage and graphics, below text and callouts. */
const overlaySlot = (st: Stack) => Math.min(95, st.top((t) => t !== "text" && t !== "block") + 1);

/** First z above the clip and everything already tied to it (cutouts, effects); other overlays stay on top. */
function footageSlot(st: Stack, scene: Scene, clip: VideoL): number {
  const tied = scene.layers.filter((l) => (l.type === "video" && l.assetId === clip.assetId) || l.type === "effect").map((l) => st.zOf(l.id));
  return Math.min(95, Math.max(st.zOf(clip.id), ...tied) + 1);
}

function cutoutLayer(clip: VideoL, obj: ClipObject, name: string, z: number): VideoL {
  return { ...structuredClone(clip), id: newLayerId("ly_cut"), name, muted: true, box: { ...clip.box, z }, mask: { segmentationId: obj.segmentationId, mode: "cutout", objectIds: [obj.objectId], feather: 1, fallback: "hide" } } as VideoL;
}

const hasCutoutOf = (scene: Scene, obj: ClipObject) => scene.layers.some((l) => l.type === "video" && !l.hidden && l.mask?.segmentationId === obj.segmentationId && l.mask.mode === "cutout");

function effectLayer(kind: EffectL["effect"], obj: ClipObject, z: number, extra: Partial<EffectL> = {}): EffectL {
  return {
    id: newLayerId("ly_fx"),
    name: EFFECT_LABELS[kind],
    type: "effect",
    effect: kind,
    target: { segmentationId: obj.segmentationId, objectId: obj.objectId },
    intensity: 0.75,
    box: full(z),
    timing: { start: 0 },
    animation: { enter: { preset: "fade", durationSec: 0.5, delaySec: 0, easing: "smooth" }, loop: "none" },
    locked: false,
    hidden: false,
    ...extra,
  } as EffectL;
}

export const EFFECT_LABELS: Record<EffectL["effect"], string> = {
  spotlight: "Spotlight",
  "outline-glow": "Outline glow",
  "focus-blur": "Background blur",
  "highlight-ring": "Highlight ring",
  "follow-arrow": "Follow arrow",
  "screen-insert": "App on screen",
};

export type OneClick = "app-behind" | "spotlight-phone" | "app-on-phone" | "glow-me" | "blur-bg";

export const ONE_CLICK: { id: OneClick; label: string; needs: ("person" | "phone" | "demo")[]; hint: string }[] = [
  { id: "app-behind", label: "Put the app behind me", needs: ["person", "demo"], hint: "Your real app demo between the background and you" },
  { id: "spotlight-phone", label: "Spotlight my phone", needs: ["phone"], hint: "Dims everything but the phone; a ring follows it" },
  { id: "app-on-phone", label: "Put the app on my phone", needs: ["phone", "demo"], hint: "Your real recording on the phone in your hand" },
  { id: "glow-me", label: "Glow around me", needs: ["person"], hint: "A soft accent glow that follows your outline" },
  { id: "blur-bg", label: "Blur background", needs: ["person"], hint: "You stay sharp, the room softly blurs" },
];

export interface OneClickTargets {
  person?: ClipObject;
  phone?: ClipObject;
  hand?: ClipObject;
}

/**
 * PatchOps for a one-click object-aware effect on `scene`. Returns null when a required object or
 * demo asset is missing. The clip is added full-frame if the scene doesn't show it yet.
 */
/**
 * Text that would sit over the presenter or the phone in hand moves up into a headline band (as in
 * the presenter-depth template), so the cutout never covers the opening line.
 */
function liftTextAbove(st: Stack, doc: CompositionDoc, scene: Scene, objs: (ClipObject | undefined)[]) {
  const boxes = objs.map((o) => o?.meanBbox).filter((b): b is NonNullable<typeof b> => Boolean(b));
  if (!boxes.length) return;
  const covers = (b: { x: number; y: number; w: number; h: number }) => boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
  const top = Math.min(...boxes.map((b) => b.y));
  const texts = scene.layers.filter((l) => l.type === "text" && !l.hidden && covers(l.box)).sort((a, b) => a.box.y - b.box.y);
  // Start inside the platform safe zone (UI overlays never cover it).
  let y = (doc.safeZone?.top ?? 0.07) + 0.005;
  for (const t of texts) {
    if (t.box.y + t.box.h <= top) continue;
    st.place(t.id, { y: r3(y) });
    y += t.box.h + 0.012;
  }
}

export function oneClickOps(kind: OneClick, doc: CompositionDoc, scene: Scene, objs: OneClickTargets, demo: MediaAsset | undefined): PatchOp[] | null {
  const clipAssetId = (objs.person ?? objs.phone)?.clipAssetId;
  if (!clipAssetId) return null;
  const st = new Stack(scene);
  const clip = ensureClip(st, scene, clipAssetId);
  const at = (z: number) => ({ ...clip, box: { ...clip.box, z } }) as VideoL;
  switch (kind) {
    case "app-behind": {
      if (!objs.person || !demo) return null;
      // Depth sandwich: clip → depth shade → real app demo → presenter (+ phone) cutout → text.
      const fronts = [objs.person, ...(objs.phone?.hasCutout ? [objs.phone] : [])].filter((o) => !hasCutoutOf(scene, o));
      const slot = st.room(overlaySlot(st), 2 + fronts.length);
      st.add({ id: newLayerId("ly_shade"), name: "Depth shade", type: "shape", shape: "rect", fill: "#00000014", gradientTo: "#00000080", radiusPx: 0, blurPx: 0, box: full(slot), timing: { start: 0 }, animation: { loop: "none" }, locked: false, hidden: false } as Layer, slot);
      const pb = objs.phone?.meanBbox ?? objs.person.meanBbox;
      const phoneRight = pb ? pb.x + pb.w / 2 > 0.5 : true;
      const landscape = !!(demo.width && demo.height && demo.width > demo.height);
      const h = landscape ? 0.26 : 0.5;
      const aspect = demo.width && demo.height ? demo.width / demo.height : 0.4885;
      const w = Math.min(landscape ? 0.86 : 0.5, (h * doc.height * aspect) / doc.width + (landscape ? 0 : 0.02));
      const cx = landscape ? 0.5 : phoneRight ? 0.2 : 0.8;
      st.add(
        {
          id: newLayerId("ly_dev"),
          name: "App demo (behind you)",
          type: "device",
          device: landscape ? "browser" : "iphone",
          screenAssetId: demo.id,
          screenKind: demo.kind === "video" ? "video" : "image",
          trimInSec: 0,
          frameColor: "black",
          shadow: true,
          box: { x: r3(cx - w / 2), y: landscape ? 0.2 : 0.335, w: r3(w), h, rotation: landscape ? 0 : phoneRight ? -6 : 6, opacity: 1, z: slot + 1 },
          timing: { start: 0 },
          animation: { enter: { preset: landscape ? "slide-up" : phoneRight ? "slide-right" : "slide-left", durationSec: 0.9, delaySec: 0.15, easing: "smooth" }, loop: "tilt" },
          locked: false,
          hidden: false,
        } as Layer,
        slot + 1,
      );
      fronts.forEach((o, i) => st.add(cutoutLayer(at(slot + 2 + i), o, o === objs.person ? "You (in front)" : "Phone in hand (in front)", slot + 2 + i), slot + 2 + i));
      liftTextAbove(st, doc, scene, [objs.person, objs.phone]);
      return st.ops();
    }
    case "spotlight-phone": {
      if (!objs.phone) return null;
      // Dims the footage only: the scene's own overlays (device mockups, text) stay bright on top.
      const slot = st.room(footageSlot(st, scene, clip), 2);
      st.add(effectLayer("spotlight", objs.phone, slot, { intensity: 0.8 }), slot);
      st.add(effectLayer("highlight-ring", objs.phone, slot + 1, { intensity: 0.85, color: "theme.accent" }), slot + 1);
      return st.ops();
    }
    case "app-on-phone": {
      if (!objs.phone || !demo) return null;
      // Real recording on the tracked phone; the hand (or presenter) cutout goes on top so fingers overlap the screen.
      const over = objs.hand?.hasCutout ? objs.hand : objs.person?.hasCutout ? objs.person : undefined;
      const slot = st.room(overlaySlot(st), over ? 2 : 1);
      st.add(effectLayer("screen-insert", objs.phone, slot, { assetId: demo.id, intensity: 1 }), slot);
      if (over) st.add(cutoutLayer(at(slot + 1), over, over === objs.hand ? "Hand (over the screen)" : "You (over the screen)", slot + 1), slot + 1);
      return st.ops();
    }
    case "glow-me":
    case "blur-bg": {
      if (!objs.person) return null;
      // Directly above the footage, under any app demo / cutouts / text.
      const slot = st.room(st.zOf(clip.id) + 1, 1);
      st.add(kind === "glow-me" ? effectLayer("outline-glow", objs.person, slot, { intensity: 0.7, color: "theme.accent" }) : effectLayer("focus-blur", objs.person, slot, { intensity: 0.6 }), slot);
      return st.ops();
    }
  }
}

/** The best demo asset: real app recording (preferred) or screenshot marked as product truth. */
export function pickDemo(assets: MediaAsset[]): MediaAsset | undefined {
  const truth = assets.filter((a) => a.isProductTruth && a.status === "ready" && (a.kind === "video" || a.kind === "image"));
  return truth.find((a) => a.role === "app_recording") ?? truth.find((a) => a.kind === "video") ?? truth.find((a) => a.role === "screenshot") ?? truth[0];
}

/** Composition-space rect (fractions) of a tracked object at composition time `t`, or null. */
export function overlayRect(doc: CompositionDoc, scene: Scene, sceneStart: number, t: number, obj: ClipObject, tracks: TracksFile | undefined): { x: number; y: number; w: number; h: number } | null {
  if (!tracks) return null;
  const clip = sceneClipLayer(scene, obj.clipAssetId) ?? (scene.layers.find((l) => l.type === "video" && l.assetId === obj.clipAssetId) as Extract<Layer, { type: "video" }> | undefined);
  if (!clip) return null;
  const track = tracks.tracks.find((tr) => tr.objectId === obj.objectId);
  if (!track || !track.frames.length) return null;
  const W = doc.width;
  const H = doc.height;
  const bx = clip.box.x * W;
  const by = clip.box.y * H;
  const bw = clip.box.w * W;
  const bh = clip.box.h * H;
  const scale = clip.fit === "cover" ? Math.max(bw / tracks.width, bh / tracks.height) : Math.min(bw / tracks.width, bh / tracks.height);
  const dw = tracks.width * scale;
  const dh = tracks.height * scale;
  const ox = bx + (bw - dw) / 2;
  const oy = by + (bh - dh) / 2;
  const srcT = clip.trimInSec + Math.max(0, t - sceneStart - clip.timing.start) * clip.playbackRate;
  // Thinned frames: nearest by time.
  const frames = track.frames;
  const dt = frames.length > 1 ? frames[1]!.t - frames[0]!.t : 1;
  const f = frames[Math.max(0, Math.min(frames.length - 1, Math.round((srcT - frames[0]!.t) / (dt || 1))))];
  if (!f?.visible || !f.bbox) return null;
  return { x: (ox + f.bbox.x * dw) / W, y: (oy + f.bbox.y * dh) / H, w: (f.bbox.w * dw) / W, h: (f.bbox.h * dh) / H };
}
