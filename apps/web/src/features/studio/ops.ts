/**
 * Client helpers that build PatchOps for direct manipulation, and describe ops in plain words
 * for the AI edit review. The server validates and applies every op (applyPatch); the client
 * never mutates the document itself.
 */
import type { CompositionDoc, Layer, PatchOp, Scene } from "./types";

export const TEMPLATE_LABELS: Record<string, string> = {
  "hook-title": "Hook title",
  "device-demo": "Device demo",
  "feature-callout": "Feature callout",
  "founder-cutout": "Founder cutout",
  "before-after": "Before / after",
  "text-over-media": "Text over media",
  "split-screen": "Split screen",
  "quote-proof": "Quote proof",
  "stat-card": "Stat card",
  "cta-endcard": "CTA end card",
  "carousel-slide": "Carousel slide",
  "presenter-depth": "Presenter in front of the app",
  "object-spotlight": "Spotlight a real object",
  "product-in-hand": "App on the phone in hand",
  "focus-zoom": "Focus zoom",
  "tap-demo": "Tap demo",
  "phone-tilt": "Phone tilt",
  "kinetic-type": "Kinetic type",
  "icon-reveal": "Icon reveal",
  "store-cta": "Store CTA",
  "fullscreen-showcase": "Full-screen showcase",
};

const rand = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "").slice(0, 12) : Math.random().toString(36).slice(2, 14));
export const newLayerId = (prefix = "ly") => `${prefix}_${rand()}`;
export const newSceneId = () => `sc_${rand()}`;

export function sceneStarts(doc: CompositionDoc): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of doc.scenes) {
    out.push(t);
    t += s.durationSec;
  }
  return out;
}

export const totalDuration = (doc: CompositionDoc) => doc.scenes.reduce((s, x) => s + x.durationSec, 0);

export function sceneAt(doc: CompositionDoc, t: number): { scene: Scene; index: number; start: number } | null {
  const starts = sceneStarts(doc);
  for (let i = doc.scenes.length - 1; i >= 0; i--) if (t >= starts[i]! - 1e-6) return { scene: doc.scenes[i]!, index: i, start: starts[i]! };
  return doc.scenes[0] ? { scene: doc.scenes[0], index: 0, start: 0 } : null;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Split a scene at `atSec` (scene-relative): the scene keeps the first part; a copy with fresh ids takes the rest. */
export function splitSceneOps(scene: Scene, atSec: number): PatchOp[] | null {
  const a = r3(atSec);
  const b = r3(scene.durationSec - atSec);
  if (a < 0.5 || b < 0.5) return null;
  const copy: Scene = {
    ...structuredClone(scene),
    id: newSceneId(),
    name: `${scene.name} (2)`.slice(0, 80),
    durationSec: b,
    transitionIn: { kind: "cut", durationSec: 0 },
    layers: scene.layers
      .filter((l) => (l.timing.end ?? scene.durationSec) > atSec)
      .map((l) => ({
        ...structuredClone(l),
        id: newLayerId(),
        timing: { start: r3(Math.max(0, l.timing.start - atSec)), end: l.timing.end !== undefined ? r3(l.timing.end - atSec) : undefined },
        // The continuation shouldn't replay the entrance.
        animation: { ...structuredClone(l.animation), enter: undefined, keyframes: undefined },
      })),
  };
  const trims: PatchOp[] = scene.layers
    .filter((l) => l.timing.start >= atSec)
    .map((l) => ({ op: "update_layer", sceneId: scene.id, layerId: l.id, set: { hidden: true } }) as PatchOp);
  return [{ op: "update_scene", sceneId: scene.id, set: { durationSec: a } }, ...trims, { op: "add_scene", scene: copy, afterSceneId: scene.id }];
}

export function duplicateSceneOps(scene: Scene): PatchOp[] {
  const copy: Scene = { ...structuredClone(scene), id: newSceneId(), name: `${scene.name} copy`.slice(0, 80), layers: scene.layers.map((l) => ({ ...structuredClone(l), id: newLayerId() })) };
  return [{ op: "add_scene", scene: copy, afterSceneId: scene.id }];
}

export function textLayer(text: string, opts: { role?: "headline" | "subhead" | "body" | "label" | "cta" | "caption"; sizePx?: number; y?: number } = {}): Layer {
  return {
    id: newLayerId(),
    type: "text",
    role: opts.role ?? "headline",
    text,
    box: { x: 0.08, y: opts.y ?? 0.42, w: 0.84, h: 0.12, rotation: 0, opacity: 1, z: 10 },
    timing: { start: 0 },
    animation: { enter: { preset: "mask-reveal", durationSec: 0.8, delaySec: 0, easing: "smooth" }, loop: "none" },
    locked: false,
    hidden: false,
    style: { font: "heading", sizePx: opts.sizePx ?? 72, weight: 700, color: "theme.text", align: "center", lineHeight: 1.05, letterSpacing: -0.03, italic: false, uppercase: false, shadow: false },
    claimIds: [],
  } as Layer;
}

export function mediaLayer(asset: { id: string; kind: string; isProductTruth: boolean; role: string; width?: number; height?: number }, frame: { width: number; height: number }): Layer | null {
  const portraitShot = asset.width && asset.height ? asset.height / asset.width > 1.4 : true;
  if (asset.isProductTruth && (asset.role === "screenshot" || asset.role === "app_recording")) {
    const hFrac = 0.6;
    const wFrac = ((hFrac * frame.height) * (portraitShot ? 0.4885 : (asset.width ?? 16) / (asset.height ?? 9))) / frame.width;
    const w = Math.min(0.86, wFrac);
    return {
      id: newLayerId(),
      type: "device",
      device: portraitShot ? "iphone" : "browser",
      screenAssetId: asset.id,
      screenKind: asset.kind === "video" ? "video" : "image",
      trimInSec: 0,
      frameColor: "black",
      shadow: true,
      box: { x: r3(0.5 - w / 2), y: 0.28, w: r3(w), h: hFrac, rotation: 0, opacity: 1, z: 5 },
      timing: { start: 0 },
      animation: { enter: { preset: "slide-up", durationSec: 1, delaySec: 0, easing: "smooth" }, loop: "float" },
      locked: false,
      hidden: false,
    } as Layer;
  }
  if (asset.kind === "image") {
    return { id: newLayerId(), type: "image", assetId: asset.id, fit: "cover", radiusPx: 32, shadow: true, box: { x: 0.1, y: 0.3, w: 0.8, h: 0.4, rotation: 0, opacity: 1, z: 5 }, timing: { start: 0 }, animation: { loop: "none" }, locked: false, hidden: false } as Layer;
  }
  if (asset.kind === "video") {
    return { id: newLayerId(), type: "video", assetId: asset.id, fit: "cover", trimInSec: 0, playbackRate: 1, muted: true, volume: 1, radiusPx: 32, box: { x: 0.1, y: 0.3, w: 0.8, h: 0.4, rotation: 0, opacity: 1, z: 5 }, timing: { start: 0 }, animation: { loop: "none" }, locked: false, hidden: false } as Layer;
  }
  return null;
}

/** One-line human description of an op, resolved against the doc it applies to. */
export function describeOp(op: PatchOp, doc: CompositionDoc | undefined): string {
  const sceneName = (id: string) => doc?.scenes.find((s) => s.id === id)?.name ?? id;
  const layerOf = (sid: string, lid: string) => doc?.scenes.find((s) => s.id === sid)?.layers.find((l) => l.id === lid);
  const layerName = (sid: string, lid: string) => {
    const l = layerOf(sid, lid);
    if (!l) return lid;
    return l.name ?? (l.type === "text" ? `“${l.text.slice(0, 40)}${l.text.length > 40 ? "…" : ""}”` : `${l.type} layer`);
  };
  switch (op.op) {
    case "update_layer": {
      const keys = Object.keys(op.set);
      const text = typeof op.set.text === "string" ? ` → “${(op.set.text as string).slice(0, 60)}”` : "";
      return `${sceneName(op.sceneId)}: change ${keys.join(", ")} of ${layerName(op.sceneId, op.layerId)}${text}`;
    }
    case "update_scene":
      return `${sceneName(op.sceneId)}: change ${Object.keys(op.set).join(", ")}`;
    case "add_layer":
      return `${sceneName(op.sceneId)}: add ${op.layer.type} layer${op.layer.type === "text" ? ` “${op.layer.text.slice(0, 50)}”` : ""}`;
    case "remove_layer":
      return `${sceneName(op.sceneId)}: remove ${layerName(op.sceneId, op.layerId)}`;
    case "reorder_layer":
      return `${sceneName(op.sceneId)}: reorder ${layerName(op.sceneId, op.layerId)}`;
    case "add_scene":
      return `Add scene “${op.scene.name}”`;
    case "remove_scene":
      return `Remove scene ${sceneName(op.sceneId)}`;
    case "move_scene":
      return `Move scene ${sceneName(op.sceneId)}`;
    case "update_theme":
      return `Change theme: ${Object.keys(op.set).join(", ")}`;
    case "upsert_audio":
      return `Set ${op.track.kind} track`;
    case "remove_audio":
      return "Remove an audio track";
    case "set_captions":
      return `Update captions (${op.captions.cues.length} cues, ${op.captions.enabled ? "on" : "off"})`;
  }
}

export function fmtTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}
