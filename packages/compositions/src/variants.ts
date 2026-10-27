/**
 * Aspect-ratio variants. When the storyboard is available, the target layout is rebuilt with the
 * template layouts and the user's edits are carried across by stable scene/layer ids; anything
 * the templates don't know about is mapped proportionally.
 */
import { ASPECT_DIMENSIONS, type AspectRatio, type CompositionDoc, type Layer, type Scene } from "@muselaunch/contracts";
import { estimateTextHeight } from "./lint";
import { validateDoc } from "./validate";

const SAFE: Record<AspectRatio, CompositionDoc["safeZone"]> = {
  "9:16": { top: 0.08, bottom: 0.14, left: 0.05, right: 0.05 },
  "4:5": { top: 0.05, bottom: 0.08, left: 0.05, right: 0.05 },
  "1:1": { top: 0.05, bottom: 0.06, left: 0.05, right: 0.05 },
  "16:9": { top: 0.06, bottom: 0.08, left: 0.05, right: 0.05 },
};

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Dims {
  W0: number;
  H0: number;
  W1: number;
  H1: number;
}

/** Proportional mapping: keep the centre, scale pixel size uniformly, re-fit text height. */
function mapLayer(layer: Layer, d: Dims, safe: CompositionDoc["safeZone"]): Layer {
  const l = clone(layer);
  const b = l.box;
  if (b.w >= 0.95 && b.h >= 0.95) return l; // full-bleed stays full-bleed
  const s = Math.min(d.W1 / d.W0, d.H1 / d.H0);
  const fontScale = Math.min(d.W1, d.H1) / Math.min(d.W0, d.H0);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (l.type === "text") {
    const maxW = 1 - safe.left - safe.right;
    const w = Math.min(maxW, d.W0 * b.w > d.W0 * 0.6 ? maxW : (b.w * d.W0 * fontScale) / d.W1);
    l.style.sizePx = Math.max(8, Math.round(l.style.sizePx * fontScale));
    const pad = l.style.background ? l.style.background.paddingPx * 2 : 0;
    const est = estimateTextHeight(l.text, l.style.sizePx, l.style.lineHeight, w * d.W1 - pad, l.style.uppercase);
    const h = Math.min(0.9, (est.heightPx * 1.12 + pad) / d.H1);
    l.box = { ...b, x: r4(Math.max(safe.left, Math.min(1 - safe.right - w, cx - w / 2))), y: r4(Math.max(safe.top, Math.min(1 - safe.bottom - h, cy - h / 2))), w: r4(w), h: r4(h) };
    return l;
  }
  const w = (b.w * d.W0 * s) / d.W1;
  const h = (b.h * d.H0 * s) / d.H1;
  l.box = { ...b, x: r4(cx - w / 2), y: r4(cy - h / 2), w: r4(w), h: r4(h) };
  return l;
}

/** Content fields carried from an edited layer onto the rebuilt layout of the same id. */
function carry(from: Layer, onto: Layer): Layer {
  if (from.type !== onto.type) return onto;
  const out = clone(onto) as Record<string, unknown>;
  const src = from as Record<string, unknown>;
  const keep = ["name", "timing", "animation", "locked", "hidden"];
  const byType: Record<Layer["type"], string[]> = {
    text: ["text", "role", "claimIds"],
    image: ["assetId", "fit", "crop"],
    video: ["assetId", "fit", "trimInSec", "trimOutSec", "playbackRate", "muted", "volume", "mask"],
    device: ["device", "screenAssetId", "screenKind", "trimInSec", "frameColor", "shadow"],
    shape: ["shape", "fill", "gradientTo", "blurPx"],
    block: ["blockId", "params"],
  };
  for (const k of [...keep, ...byType[from.type]]) if (src[k] !== undefined) out[k] = clone(src[k]);
  if (from.type === "text" && onto.type === "text") {
    // Keep the user's styling but the target layout's size.
    out.style = { ...clone(from.style), sizePx: onto.style.sizePx };
  }
  return out as Layer;
}

export function adaptToAspect(current: CompositionDoc, target: AspectRatio, rebuilt?: CompositionDoc): CompositionDoc {
  const { width: W1, height: H1 } = ASPECT_DIMENSIONS[target];
  const d: Dims = { W0: current.width, H0: current.height, W1, H1 };
  const safe = SAFE[target];
  const rebuiltScenes = new Map((rebuilt?.scenes ?? []).map((s) => [s.id, s]));
  const scenes: Scene[] = current.scenes.map((scene) => {
    const rb = rebuiltScenes.get(scene.id);
    if (!rb) return { ...clone(scene), layers: scene.layers.map((l) => mapLayer(l, d, safe)) };
    const rbLayers = new Map(rb.layers.map((l) => [l.id, l]));
    const layers = scene.layers.map((l) => {
      const match = rbLayers.get(l.id);
      return match ? carry(l, match) : mapLayer(l, d, safe);
    });
    const background = scene.background.kind === "solid" || scene.background.kind === "gradient" ? clone(scene.background) : clone(rb.background);
    return { ...clone(scene), background, layers };
  });
  const doc: CompositionDoc = {
    ...clone(current),
    title: current.title,
    aspectRatio: target,
    width: W1,
    height: H1,
    safeZone: safe,
    scenes,
  };
  const v = validateDoc(doc);
  if (!v.ok) throw new Error(`adaptToAspect produced an invalid doc: ${v.errors.slice(0, 5).join("; ")}`);
  return v.doc;
}
