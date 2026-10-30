import type { ClipAnalysis, CompositionDoc, Layer } from "@muselaunch/contracts";
import { sceneStarts, totalDuration } from "./validate";

const f = (n: number, d = 2) => (Math.round(n * 10 ** d) / 10 ** d).toString();
const q = (s: string, max = 140) => JSON.stringify(s.length > max ? `${s.slice(0, max)}…` : s);

function box(l: Layer) {
  const b = l.box;
  let s = `box(x=${f(b.x)},y=${f(b.y)},w=${f(b.w)},h=${f(b.h)}`;
  if (b.rotation) s += `,rot=${f(b.rotation, 1)}`;
  if (b.opacity !== 1) s += `,op=${f(b.opacity)}`;
  if (b.z !== 1) s += `,z=${b.z}`;
  return `${s})`;
}

function anim(l: Layer) {
  const a = l.animation;
  const parts: string[] = [];
  if (a.enter && a.enter.preset !== "none") parts.push(`in=${a.enter.preset}${a.enter.delaySec ? `@+${f(a.enter.delaySec)}s` : ""}/${f(a.enter.durationSec)}s/${a.enter.easing}`);
  if (a.exit && a.exit.preset !== "none") parts.push(`out=${a.exit.preset}/${f(a.exit.durationSec)}s`);
  if (a.loop !== "none") parts.push(`loop=${a.loop}`);
  if (a.keyframes?.length) parts.push(`keyframes=${a.keyframes.length}`);
  return parts.length ? ` anim[${parts.join(" ")}]` : "";
}

function describeLayer(l: Layer): string {
  return describeLayerBase(l) + (l.anchor ? ` anchor[follows ${l.anchor.segmentationId}/${l.anchor.objectId} at ${l.anchor.point}${l.anchor.offset.x || l.anchor.offset.y ? ` offset(${f(l.anchor.offset.x)},${f(l.anchor.offset.y)})` : ""}${l.anchor.scaleWithObject ? " scaled" : ""} whenLost=${l.anchor.whenLost}]` : "");
}

function describeLayerBase(l: Layer): string {
  const t = `t=${f(l.timing.start)}–${l.timing.end === undefined ? "end" : f(l.timing.end)}`;
  const flags = `${l.hidden ? " HIDDEN" : ""}${l.locked ? " LOCKED" : ""}`;
  const head = `    - layer id=${l.id} ${l.type}${l.name ? ` "${l.name}"` : ""}`;
  switch (l.type) {
    case "text": {
      const s = l.style;
      const style = `${s.font} ${s.sizePx}px w${s.weight} ${s.color} ${s.align}${s.uppercase ? " upper" : ""}${s.background ? ` bg=${s.background.color}` : ""}${s.highlight ? ` highlight=${JSON.stringify(s.highlight.words)}` : ""}`;
      return `${head} role=${l.role} text=${q(l.text)} ${box(l)} ${t} style[${style}]${l.claimIds.length ? ` claims=${l.claimIds.join(",")}` : ""}${anim(l)}${flags}`;
    }
    case "image":
      return `${head} asset=${l.assetId} fit=${l.fit}${l.radiusPx ? ` radius=${l.radiusPx}` : ""} ${box(l)} ${t}${anim(l)}${flags}`;
    case "video":
      return `${head} asset=${l.assetId} trim=${f(l.trimInSec)}–${l.trimOutSec === undefined ? "end" : f(l.trimOutSec)} rate=${l.playbackRate}${l.muted ? " muted" : ""}${l.mask ? ` mask=${l.mask.mode}(seg ${l.mask.segmentationId}, fallback ${l.mask.fallback})` : ""} ${box(l)} ${t}${anim(l)}${flags}`;
    case "device": {
      const extra = [
        l.screenKind === "video" ? ` trim=${f(l.trimInSec)}–${l.trimOutSec === undefined ? "end" : f(l.trimOutSec)}${l.playbackRate && l.playbackRate !== 1 ? ` rate=${l.playbackRate}` : ""}` : "",
        l.focus ? ` focus(x=${f(l.focus.x)},y=${f(l.focus.y)},w=${f(l.focus.w)},h=${f(l.focus.h)}${l.focus.zoom ? `,zoom=${f(l.focus.zoom)}` : ""} @${f(l.focus.atSec)}s${l.focus.ring ? " ring" : ""})` : "",
        l.tap ? ` tap(x=${f(l.tap.x)},y=${f(l.tap.y)} @${f(l.tap.atSec)}s)` : "",
        l.tilt ? ` tilt(x=${f(l.tilt.x, 1)}°,y=${f(l.tilt.y, 1)}°${l.tilt.swing ? " swing" : ""})` : "",
        l.blurRegions?.length ? ` privacy-blur=${l.blurRegions.length}` : "",
      ].join("");
      return `${head} ${l.device}/${l.frameColor} screen=${l.screenKind}:${l.screenAssetId} (REAL product media)${extra} ${box(l)} ${t}${anim(l)}${flags}`;
    }
    case "shape":
      return `${head} ${l.shape} fill=${l.fill}${l.gradientTo ? `→${l.gradientTo}` : ""}${l.blurPx ? ` blur=${l.blurPx}` : ""} ${box(l)} ${t}${anim(l)}${flags}`;
    case "block":
      return `${head} block=${l.blockId} params=${JSON.stringify(l.params)} ${box(l)} ${t}${anim(l)}${flags}`;
    case "effect":
      return `${head} effect=${l.effect} target=${l.target.segmentationId}/${l.target.objectId}${l.color ? ` color=${l.color}` : ""}${l.assetId ? ` media=${l.assetId} (REAL app media)` : ""} intensity=${l.intensity} z=${l.box.z} ${t}${anim(l)}${flags}`;
  }
}

/**
 * Compact, id-annotated description for prompting Spark to produce PatchOps.
 * Coordinates are fractions of the frame; times are seconds relative to the scene start.
 */
/** Vocabulary Spark needs to direct object-aware edits with valid PatchOps. */
export const OBJECT_AWARE_VOCABULARY = [
  "Object-aware editing (SAM tracks of the real clip):",
  "- Effect layer: {type:\"effect\", id, effect, target:{segmentationId, objectId}, intensity 0..1, color?, assetId? (screen-insert only), inset? {top,right,bottom,left} (screen-insert only), box:{x:0,y:0,w:1,h:1,z}} — add with add_layer.",
  "  effects: spotlight (dim all but the object) · outline-glow (glow around the object's cutout) · focus-blur (blur everything except the object) · highlight-ring (ring following the object's box) · follow-arrow (arrow pointing at the object) · screen-insert (REAL app recording/screenshot placed onto the tracked phone; assetId must be a real product asset).",
  "- Any layer can follow an object: set anchor {segmentationId, objectId, point: center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right, offset:{x,y} (frame fractions), scaleWithObject, whenLost: hold|hide} via update_layer or in add_layer. The layer's centre is placed at the anchor point + offset; box keeps its size and is the fallback position.",
  "- Depth sandwich: base clip video (low z) → graphics/app demo (middle z) → presenter cutout = the same clip as a video layer with mask {segmentationId of the person, mode:\"cutout\", fallback:\"hide\"} (highest z) so the presenter is in front of the app.",
  "- Use only segmentation/object ids listed under Clip objects. Effects are skipped automatically if tracking is unreliable.",
].join("\n");

export function describeClipObjects(analyses: ClipAnalysis[]): string {
  const lines: string[] = ["Clip objects:"];
  for (const a of analyses) {
    lines.push(`  clip asset=${a.sourceAssetId} analysis=${a.id} status=${a.status}${a.durationSec ? ` dur=${f(a.durationSec)}s` : ""}${a.transcriptId ? ` transcript=${a.transcriptId}` : ""}`);
    for (const o of a.objects) {
      const pres = o.presence.length ? o.presence.slice(0, 6).map((p) => `${f(p.startSec, 1)}–${f(p.endSec, 1)}s`).join(",") + (o.presence.length > 6 ? ",…" : "") : "not visible";
      const mb = o.meanBbox ? ` mostly at box(x=${f(o.meanBbox.x)},y=${f(o.meanBbox.y)},w=${f(o.meanBbox.w)},h=${f(o.meanBbox.h)})` : "";
      const q = o.trackingQuality !== undefined ? ` quality=${Math.round(o.trackingQuality * 100)}%` : "";
      lines.push(`    - ${o.key} "${o.label}" segmentationId=${o.segmentationId} objectId=${o.objectId} visible=${pres}${mb}${q}`);
    }
  }
  return lines.join("\n");
}

export function describeForLLM(doc: CompositionDoc, ctx: { clipAnalyses?: ClipAnalysis[] } = {}): string {
  const th = doc.theme;
  const starts = sceneStarts(doc);
  const lines: string[] = [];
  lines.push(`Composition ${q(doc.title, 120)} kind=${doc.kind} ${doc.aspectRatio} ${doc.width}x${doc.height} ${doc.fps}fps total=${f(totalDuration(doc))}s`);
  lines.push(
    `Theme ${th.mode}: background=${th.background} surface=${th.surface} text=${th.text} textMuted=${th.textMuted} accent=${th.accent}${th.accent2 ? ` accent2=${th.accent2}` : ""} fonts=${th.headingFont}/${th.bodyFont} radius=${th.radiusPx}`,
  );
  const sz = doc.safeZone;
  lines.push(`Safe zone (keep text inside): top=${sz.top} bottom=${sz.bottom} left=${sz.left} right=${sz.right}`);
  lines.push("Scenes:");
  doc.scenes.forEach((s, i) => {
    const bg = s.background;
    const bgDesc =
      bg.kind === "solid" ? `solid ${bg.color ?? "theme.background"}` : bg.kind === "gradient" ? `gradient ${(bg.colors ?? []).join("→")} ${bg.angle}°` : `${bg.kind}${bg.assetId ? ` asset=${bg.assetId}` : ""}${bg.dim ? ` dim=${bg.dim}` : ""}`;
    lines.push(
      `  ${i + 1}. scene id=${s.id} "${s.name}" template=${s.template}${s.purpose ? ` purpose=${s.purpose}` : ""} at=${f(starts[i]!)}s dur=${f(s.durationSec)}s bg=[${bgDesc}] transitionIn=${s.transitionIn.kind}/${f(s.transitionIn.durationSec)}s`,
    );
    if (s.notes) lines.push(`    notes: ${q(s.notes, 200)}`);
    for (const l of s.layers) lines.push(describeLayer(l));
  });
  if (doc.audio.length) {
    lines.push("Audio:");
    for (const a of doc.audio) lines.push(`  - track id=${a.id} ${a.kind} asset=${a.assetId} ${f(a.startSec)}–${a.endSec === undefined ? "end" : f(a.endSec)}s vol=${a.volume} source=${a.sourceLabel}`);
  }
  const c = doc.captions;
  lines.push(`Captions: ${c.enabled ? `on preset=${c.preset} position=${c.position} source=${c.source} cues=${c.cues.length}` : "off"}`);
  for (const cue of c.cues.slice(0, 40)) lines.push(`  - cue id=${cue.id} ${f(cue.startSec)}–${f(cue.endSec)}s ${q(cue.text, 100)}`);
  if (c.cues.length > 40) lines.push(`  … ${c.cues.length - 40} more cues`);
  const usesObjects = doc.scenes.some((sc) => sc.layers.some((l) => l.type === "effect" || l.anchor || (l.type === "video" && l.mask)));
  if (ctx.clipAnalyses?.length) lines.push(describeClipObjects(ctx.clipAnalyses));
  if (ctx.clipAnalyses?.length || usesObjects) lines.push(OBJECT_AWARE_VOCABULARY);
  return lines.join("\n");
}
