import type { Claim, CompositionDoc, Layer, MediaAsset, Segmentation } from "@muselaunch/contracts";
import { totalDuration } from "./validate";

export interface LintIssue {
  level: "error" | "warning";
  sceneId?: string;
  layerId?: string;
  message: string;
}

export interface LintContext {
  assets: Record<string, MediaAsset>;
  /** Optional: when provided, claim usage is checked (unknown/unverified claims are errors). */
  claims?: Record<string, Claim>;
  /** Optional: when provided, masked layers are checked against their segmentation. */
  segmentations?: Record<string, Segmentation>;
}

const PROOF_TEMPLATES = new Set(["quote-proof", "stat-card"]);
const PRODUCT_TEMPLATES = new Set(["device-demo", "feature-callout", "before-after"]);
const READY = new Set(["ready", "uploaded"]);

/** Average glyph advance as a fraction of font size (Inter, mixed case). */
const GLYPH_W = 0.54;

/** Rough line-wrap estimate for a text layer: returns needed height in px. */
export function estimateTextHeight(text: string, sizePx: number, lineHeight: number, boxWidthPx: number, uppercase = false): { lines: number; heightPx: number } {
  const glyph = sizePx * (uppercase ? GLYPH_W * 1.12 : GLYPH_W);
  const maxChars = Math.max(1, Math.floor(boxWidthPx / glyph));
  let lines = 0;
  for (const para of text.split(/\n/)) {
    let cur = 0;
    lines++;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const len = word.length;
      if (cur === 0) cur = len;
      else if (cur + 1 + len <= maxChars) cur += 1 + len;
      else {
        lines++;
        cur = len;
      }
      while (cur > maxChars) {
        lines++;
        cur -= maxChars;
      }
    }
  }
  return { lines, heightPx: lines * sizePx * lineHeight };
}

/**
 * Production checks before preview/render: missing or unsuitable assets, product truth,
 * text legibility and safe zones, timing, claim usage. Errors block a final render;
 * warnings are shown in the editor.
 */
export function lintDoc(doc: CompositionDoc, ctx: LintContext): LintIssue[] {
  const out: LintIssue[] = [];
  const { width: W, height: H, safeZone: sz } = doc;
  const total = totalDuration(doc);

  const checkAsset = (assetId: string, want: ("image" | "video" | "audio")[], where: { sceneId?: string; layerId?: string }, what: string): MediaAsset | undefined => {
    const a = ctx.assets[assetId];
    if (!a) {
      out.push({ level: "error", ...where, message: `${what} references missing asset ${assetId}` });
      return undefined;
    }
    if (a.status === "failed" || a.status === "deleted") out.push({ level: "error", ...where, message: `${what} uses asset ${assetId} which is ${a.status}` });
    else if (!READY.has(a.status)) out.push({ level: "warning", ...where, message: `${what} uses asset ${assetId} which is still ${a.status}` });
    if (!want.includes(a.kind as never)) out.push({ level: "error", ...where, message: `${what} needs ${want.join("/")} but asset ${assetId} is ${a.kind}` });
    return a;
  };

  if (doc.kind === "video" && total < 3) out.push({ level: "warning", message: `Video is only ${total}s long` });
  if (doc.kind === "video" && total > 90) out.push({ level: "warning", message: `Video is ${total}s; short-form platforms favour ≤ 60s` });

  doc.scenes.forEach((scene, si) => {
    const sid = scene.id;
    if (scene.background.assetId) checkAsset(scene.background.assetId, scene.background.kind === "video" ? ["video"] : ["image", "video"], { sceneId: sid }, "Background");
    if (si > 0 && scene.transitionIn.durationSec > doc.scenes[si - 1]!.durationSec) out.push({ level: "warning", sceneId: sid, message: "Transition is longer than the previous scene" });
    if (PROOF_TEMPLATES.has(scene.template)) {
      const hasClaim = scene.layers.some((l) => l.type === "text" && l.claimIds.length > 0);
      if (!hasClaim) out.push({ level: "warning", sceneId: sid, message: `"${scene.template}" scenes must show real, sourced evidence; link the text to a verified claim` });
    }
    let words = 0;
    const visible = scene.layers.filter((l) => !l.hidden);
    for (const layer of visible) {
      const where = { sceneId: sid, layerId: layer.id };
      lintTiming(layer, scene.durationSec, where, out);
      switch (layer.type) {
        case "text": {
          words += layer.text.split(/\s+/).filter(Boolean).length;
          const b = layer.box;
          const bg = layer.style.background ? layer.style.background.paddingPx * 2 : 0;
          const est = estimateTextHeight(layer.text, layer.style.sizePx, layer.style.lineHeight, Math.max(1, b.w * W - bg), layer.style.uppercase);
          if (est.heightPx > b.h * H * 1.08 + 4) out.push({ level: "warning", ...where, message: `Text likely overflows its box (${est.lines} lines need ${Math.round(est.heightPx)}px, box is ${Math.round(b.h * H)}px)` });
          if (layer.style.sizePx < 28 && layer.role !== "label") out.push({ level: "warning", ...where, message: `Text at ${layer.style.sizePx}px may be unreadable on a phone` });
          const outside = b.x < sz.left - 0.005 || b.x + b.w > 1 - sz.right + 0.005 || b.y < sz.top - 0.005 || b.y + b.h > 1 - sz.bottom + 0.005;
          if (outside && !layer.animation.keyframes?.length) out.push({ level: "warning", ...where, message: "Text extends outside the platform safe zone" });
          if (ctx.claims) {
            for (const cid of layer.claimIds) {
              const c = ctx.claims[cid];
              if (!c) out.push({ level: "error", ...where, message: `Claim ${cid} not found` });
              else if (c.state !== "verified") out.push({ level: "error", ...where, message: `Uses claim "${c.text.slice(0, 60)}" which is ${c.state.replace("_", " ")}` });
              else if (!c.permittedContexts.some((x) => x === "all" || x === "video" || x === "ads" || x === "social"))
                out.push({ level: "warning", ...where, message: `Claim "${c.text.slice(0, 60)}" is not approved for video` });
            }
          }
          break;
        }
        case "image": {
          const a = checkAsset(layer.assetId, ["image"], where, "Image layer");
          if (a && PRODUCT_TEMPLATES.has(scene.template) && (a.role === "screenshot" || a.role === "app_recording") && !a.isProductTruth)
            out.push({ level: "error", ...where, message: "Screenshots must be real product media (asset is not marked as product truth)" });
          if (a && a.role === "generated_image" && PRODUCT_TEMPLATES.has(scene.template))
            out.push({ level: "warning", ...where, message: "Generated imagery in a product scene: make sure it does not look like the app UI" });
          break;
        }
        case "video": {
          const a = checkAsset(layer.assetId, ["video"], where, "Video layer");
          if (a?.durationSec !== undefined) {
            const avail = ((layer.trimOutSec ?? a.durationSec) - layer.trimInSec) / layer.playbackRate;
            const need = (layer.timing.end ?? scene.durationSec) - layer.timing.start;
            if (avail + 0.05 < need) out.push({ level: "warning", ...where, message: `Clip has ${avail.toFixed(1)}s of footage for a ${need.toFixed(1)}s slot (last frame will hold)` });
          }
          if (layer.mask) {
            const seg = ctx.segmentations?.[layer.mask.segmentationId];
            if (ctx.segmentations && !seg) out.push({ level: "warning", ...where, message: `Segmentation ${layer.mask.segmentationId} not found; ${layer.mask.fallback === "hide" ? "layer will be hidden" : "unmasked footage will be used"}` });
            else if (seg && seg.status !== "succeeded") out.push({ level: "warning", ...where, message: `Segmentation is ${seg.status}; ${layer.mask.fallback === "hide" ? "layer hidden" : "unmasked footage used"} until it finishes` });
            else if (seg && (seg.trackingQuality ?? 1) < 0.5) out.push({ level: "warning", ...where, message: "Mask tracking quality is low; unmasked footage will be used" });
            else if (seg && !seg.cutoutAssetId) out.push({ level: "warning", ...where, message: "Segmentation has no cutout asset yet" });
          }
          break;
        }
        case "device": {
          const a = checkAsset(layer.screenAssetId, [layer.screenKind], where, "Device screen");
          if (a && !a.isProductTruth) out.push({ level: "error", ...where, message: "Device frames may only show real screenshots or recordings of the product" });
          if (a && a.origin === "generated") out.push({ level: "error", ...where, message: "Generated media cannot be shown as the app's UI" });
          break;
        }
        case "shape":
        case "block":
          break;
      }
    }
    const wps = words / Math.max(0.5, scene.durationSec);
    if (doc.kind === "video" && wps > 4) out.push({ level: "warning", sceneId: sid, message: `${words} words in ${scene.durationSec}s is hard to read; shorten the text or lengthen the scene` });
  });

  for (const tr of doc.audio) {
    checkAsset(tr.assetId, ["audio", "video"], {}, `Audio track ${tr.id}`);
    if (tr.startSec >= total) out.push({ level: "warning", message: `Audio track ${tr.id} starts after the video ends` });
  }
  if (doc.captions.enabled) {
    if (!doc.captions.cues.length) out.push({ level: "warning", message: "Captions are enabled but there are no cues" });
    for (const c of doc.captions.cues) if (c.startSec >= total) out.push({ level: "warning", message: `Caption "${c.text.slice(0, 30)}" starts after the video ends` });
  }
  return out;
}

function lintTiming(layer: Layer, sceneDur: number, where: { sceneId: string; layerId: string }, out: LintIssue[]) {
  if (layer.timing.end !== undefined && layer.timing.end > sceneDur + 1e-6) out.push({ level: "warning", ...where, message: `Layer ends at ${layer.timing.end}s, after the scene ends (${sceneDur}s)` });
  const enter = layer.animation.enter;
  if (enter && layer.timing.start + enter.delaySec + enter.durationSec > (layer.timing.end ?? sceneDur) + 1e-6)
    out.push({ level: "warning", ...where, message: "Entrance animation does not finish before the layer disappears" });
  const kf = layer.animation.keyframes;
  if (kf?.some((k) => k.t > sceneDur)) out.push({ level: "warning", ...where, message: "Keyframes after the end of the scene are ignored" });
}

/** True when the issues allow a final render. */
export function lintPasses(issues: LintIssue[]): boolean {
  return !issues.some((i) => i.level === "error");
}
