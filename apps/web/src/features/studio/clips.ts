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

/** Usable analyses for the clips this doc shows (sent to Spark as object-aware context). */
export function activeAnalysisIds(items: ClipItem[] | undefined): string[] {
  return [...new Set((items ?? []).filter((i) => i.usedInDoc && i.analysis && (i.analysis.status === "succeeded" || i.analysis.status === "partial")).map((i) => i.analysis!.id))].slice(0, 4);
}

// ---------------------------------------------------------------------------
// One-click effects → PatchOps
// ---------------------------------------------------------------------------

const full = (z: number) => ({ x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, z });
const maxZ = (scene: Scene) => scene.layers.reduce((m, l) => Math.max(m, l.box.z), 1);

export function sceneClipLayer(scene: Scene, clipAssetId: string): Extract<Layer, { type: "video" }> | undefined {
  return scene.layers.find((l): l is Extract<Layer, { type: "video" }> => l.type === "video" && l.assetId === clipAssetId && !l.mask && !l.hidden);
}

/** Make sure the scene shows the clip full-frame underneath everything; returns ops + the clip layer. */
function ensureClip(scene: Scene, clipAssetId: string): { ops: PatchOp[]; clip: Extract<Layer, { type: "video" }> } {
  const existing = sceneClipLayer(scene, clipAssetId);
  if (existing) return { ops: [], clip: existing };
  const clip = {
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
    box: full(0),
    timing: { start: 0 },
    animation: { loop: "none" },
    locked: false,
    hidden: false,
  } as Extract<Layer, { type: "video" }>;
  return { ops: [{ op: "add_layer", sceneId: scene.id, layer: clip, index: 0 }], clip };
}

function cutout(scene: Scene, clip: Extract<Layer, { type: "video" }>, obj: ClipObject, name: string, z: number): PatchOp | null {
  if (scene.layers.some((l) => l.type === "video" && l.mask?.segmentationId === obj.segmentationId && !l.hidden)) return null;
  const layer = { ...structuredClone(clip), id: newLayerId("ly_cut"), name, muted: true, box: { ...clip.box, z }, mask: { segmentationId: obj.segmentationId, mode: "cutout", objectIds: [obj.objectId], feather: 1, fallback: "hide" } } as Layer;
  return { op: "add_layer", sceneId: scene.id, layer };
}

function effect(scene: Scene, kind: Extract<Layer, { type: "effect" }>["effect"], obj: ClipObject, z: number, extra: Partial<Extract<Layer, { type: "effect" }>> = {}): PatchOp {
  const layer = {
    id: newLayerId("ly_fx"),
    name: kind.replace(/-/g, " "),
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
  } as Layer;
  return { op: "add_layer", sceneId: scene.id, layer };
}

export type OneClick = "app-behind" | "spotlight-phone" | "app-on-phone" | "glow-me" | "blur-bg";

export const ONE_CLICK: { id: OneClick; label: string; needs: ("person" | "phone" | "demo")[]; hint: string }[] = [
  { id: "app-behind", label: "Put the app behind me", needs: ["person", "demo"], hint: "Real app demo layered between your background and you" },
  { id: "spotlight-phone", label: "Spotlight my phone", needs: ["phone"], hint: "Dim everything except the phone, with a ring that follows it" },
  { id: "app-on-phone", label: "Put the app on my phone", needs: ["phone", "demo"], hint: "Your real app recording on the phone in your hand" },
  { id: "glow-me", label: "Glow around me", needs: ["person"], hint: "A soft accent glow that follows your outline" },
  { id: "blur-bg", label: "Blur background", needs: ["person"], hint: "Depth-of-field: you stay sharp, the room blurs" },
];

export function oneClickOps(kind: OneClick, doc: CompositionDoc, scene: Scene, objs: { person?: ClipObject; phone?: ClipObject; hand?: ClipObject }, demo: MediaAsset | undefined): PatchOp[] | null {
  const clipAssetId = (objs.person ?? objs.phone)?.clipAssetId;
  if (!clipAssetId) return null;
  const { ops, clip } = ensureClip(scene, clipAssetId);
  const top = maxZ(scene);
  const push = (op: PatchOp | null) => op && ops.push(op);
  switch (kind) {
    case "app-behind": {
      if (!objs.person || !demo) return null;
      const phoneRight = objs.phone?.meanBbox ? objs.phone.meanBbox.x + objs.phone.meanBbox.w / 2 > 0.5 : (objs.person.meanBbox?.x ?? 0.3) + (objs.person.meanBbox?.w ?? 0.4) / 2 > 0.5;
      const h = 0.5;
      const w = Math.min(0.5, (h * doc.height * (demo.width && demo.height && demo.width > demo.height ? demo.width / demo.height : 0.4885)) / doc.width);
      const cx = phoneRight ? 0.2 : 0.8;
      const device = {
        id: newLayerId("ly_dev"),
        name: "App demo (behind you)",
        type: "device",
        device: demo.width && demo.height && demo.width > demo.height ? "browser" : "iphone",
        screenAssetId: demo.id,
        screenKind: demo.kind === "video" ? "video" : "image",
        trimInSec: 0,
        frameColor: "black",
        shadow: true,
        box: { x: Math.round((cx - w / 2) * 1000) / 1000, y: 0.335, w: Math.round(w * 1000) / 1000, h, rotation: phoneRight ? -6 : 6, opacity: 1, z: top + 1 },
        timing: { start: 0 },
        animation: { enter: { preset: phoneRight ? "slide-right" : "slide-left", durationSec: 1, delaySec: 0.2, easing: "smooth" }, loop: "tilt" },
        locked: false,
        hidden: false,
      } as Layer;
      ops.push({ op: "add_layer", sceneId: scene.id, layer: device });
      push(cutout(scene, clip, objs.person, "You (in front)", top + 10));
      if (objs.phone?.hasCutout) push(cutout(scene, clip, objs.phone, "Phone in hand (in front)", top + 11));
      return ops;
    }
    case "spotlight-phone": {
      if (!objs.phone) return null;
      ops.push(effect(scene, "spotlight", objs.phone, top + 1, { intensity: 0.8 }), effect(scene, "highlight-ring", objs.phone, top + 2, { intensity: 0.85, color: "theme.accent" }));
      return ops;
    }
    case "app-on-phone": {
      if (!objs.phone || !demo) return null;
      ops.push(effect(scene, "screen-insert", objs.phone, top + 1, { assetId: demo.id, intensity: 1 }));
      const over = objs.hand?.hasCutout ? objs.hand : objs.person?.hasCutout ? objs.person : undefined;
      if (over) push(cutout(scene, clip, over, over === objs.hand ? "Hand (over the screen)" : "You (over the screen)", top + 2));
      return ops;
    }
    case "glow-me": {
      if (!objs.person) return null;
      ops.push(effect(scene, "outline-glow", objs.person, Math.max(2, clip.box.z + 1), { intensity: 0.7, color: "theme.accent" }));
      return ops;
    }
    case "blur-bg": {
      if (!objs.person) return null;
      ops.push(effect(scene, "focus-blur", objs.person, Math.max(2, clip.box.z + 1), { intensity: 0.6 }));
      return ops;
    }
  }
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
