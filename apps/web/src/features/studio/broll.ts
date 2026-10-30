/**
 * Lifestyle b-roll in the Studio (stock + generated stills): where "Add to scene" puts media, and
 * the response shapes of module D's routes (`/stock/search`, `/media/providers`,
 * `/storyboards/:id/broll`). Stock and generated media are never product truth: they go into the
 * scene's background or a media layer, never into a device frame.
 */
import type { BrollHintStatus, BrollStatusResponse, ImageProviderInfo, Job, MediaProvidersResponse, StockItem, StockProviderId, StockProviderState } from "@muselaunch/contracts";
import { newLayerId } from "./ops";
import type { CompositionDoc, Layer, MediaAsset, PatchOp, Scene } from "./types";

export type { BrollHintStatus, BrollStatusResponse, MediaProvidersResponse, StockItem, StockProviderId, StockProviderState };

export interface StockSearchResponse {
  items: StockItem[];
  provider: StockProviderId;
  providers: StockProviderState[];
  page: number;
  hasMore: boolean;
}
export interface StockImportResponse {
  asset: MediaAsset;
  job: Job | null;
}
export interface ImageGenerateResponse {
  job: Job;
  provider: ImageProviderInfo;
}

type MediaKind = "image" | "video";
type MediaLayer = Extract<Layer, { type: "image" | "video" }>;

const isMedia = (l: Layer): l is MediaLayer => l.type === "image" || l.type === "video";
const fullFrame = (l: Layer) => l.box.w >= 0.95 && l.box.h >= 0.95 && l.box.x <= 0.03 && l.box.y <= 0.03;
/** SAM-masked video layers (cut-outs) are compositing work on real footage: never swapped for b-roll. */
const masked = (l: MediaLayer) => l.type === "video" && !!l.mask;

export type MediaTarget = { kind: "layer"; layer: MediaLayer } | { kind: "background" };

/**
 * Where new b-roll goes in a scene: the selected image/video layer, else the scene's full-frame
 * image/video layer, else the scene background. Layers showing real product media (screens,
 * recordings, founder clips) are never replaced by stock or generated media.
 */
export function mediaTarget(scene: Scene, layer: Layer | null, isProductMedia: (assetId: string) => boolean): MediaTarget {
  if (layer && isMedia(layer) && !layer.locked && !masked(layer) && !isProductMedia(layer.assetId)) return { kind: "layer", layer };
  const full = scene.layers.find((l): l is MediaLayer => isMedia(l) && !l.hidden && !l.locked && !masked(l) && fullFrame(l) && !isProductMedia(l.assetId));
  return full ? { kind: "layer", layer: full } : { kind: "background" };
}

export function targetLabel(t: MediaTarget, kind: MediaKind): string {
  if (t.kind === "background") return "Set as scene background";
  return t.layer.type === kind ? (kind === "video" ? "Replace clip" : "Replace image") : `Replace ${t.layer.type === "video" ? "clip" : "image"}`;
}

/** Patch ops that put `asset` into the scene at `target` (a kind change swaps the layer, keeping its place and timing). */
export function placeMediaOps(scene: Scene, target: MediaTarget, asset: Pick<MediaAsset, "id" | "kind">): { ops: PatchOp[]; summary: string } {
  const kind: MediaKind = asset.kind === "video" ? "video" : "image";
  if (target.kind === "background") {
    return {
      ops: [{ op: "update_scene", sceneId: scene.id, set: { background: { kind, assetId: asset.id, angle: 180, dim: 0.35 } } }],
      summary: `${kind === "video" ? "Stock clip" : "Image"} as ${scene.name} background`,
    };
  }
  const l = target.layer;
  if (l.type === kind) return { ops: [{ op: "update_layer", sceneId: scene.id, layerId: l.id, set: { assetId: asset.id } }], summary: `Replace ${kind === "video" ? "clip" : "image"} in ${scene.name}` };
  const common = { id: newLayerId(), name: l.name, box: l.box, timing: l.timing, anchor: l.anchor, locked: false, hidden: false, radiusPx: l.radiusPx, fit: l.fit };
  const next: Layer =
    kind === "video"
      ? ({ ...common, type: "video", assetId: asset.id, trimInSec: 0, playbackRate: 1, muted: true, volume: 1, animation: { ...l.animation, loop: "slow-zoom" } } as Layer)
      : ({ ...common, type: "image", assetId: asset.id, shadow: false, animation: { ...l.animation, loop: "ken-burns" } } as Layer);
  const index = scene.layers.findIndex((x) => x.id === l.id);
  return {
    ops: [
      { op: "remove_layer", sceneId: scene.id, layerId: l.id },
      { op: "add_layer", sceneId: scene.id, layer: next, index: Math.max(0, index) },
    ],
    summary: `Replace ${l.type === "video" ? "clip" : "image"} with ${kind === "video" ? "a clip" : "an image"} in ${scene.name}`,
  };
}

export function docOrientation(doc: Pick<CompositionDoc, "width" | "height">): "portrait" | "landscape" | "square" {
  const r = doc.width / doc.height;
  return r > 1.15 ? "landscape" : r < 0.87 ? "portrait" : "square";
}

export function imageSizeForDoc(doc: Pick<CompositionDoc, "width" | "height">): "1024x1536" | "1536x1024" | "1024x1024" {
  const o = docOrientation(doc);
  return o === "landscape" ? "1536x1024" : o === "square" ? "1024x1024" : "1024x1536";
}

export const fmtDuration = (sec?: number) => (sec === undefined ? "" : sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}` : `${Math.round(sec)}s`);
