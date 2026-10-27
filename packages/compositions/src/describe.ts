import type { CompositionDoc, Layer } from "@muselaunch/contracts";
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
    case "device":
      return `${head} ${l.device}/${l.frameColor} screen=${l.screenKind}:${l.screenAssetId} (REAL product media) ${box(l)} ${t}${anim(l)}${flags}`;
    case "shape":
      return `${head} ${l.shape} fill=${l.fill}${l.gradientTo ? `→${l.gradientTo}` : ""}${l.blurPx ? ` blur=${l.blurPx}` : ""} ${box(l)} ${t}${anim(l)}${flags}`;
    case "block":
      return `${head} block=${l.blockId} params=${JSON.stringify(l.params)} ${box(l)} ${t}${anim(l)}${flags}`;
  }
}

/**
 * Compact, id-annotated description for prompting Spark to produce PatchOps.
 * Coordinates are fractions of the frame; times are seconds relative to the scene start.
 */
export function describeForLLM(doc: CompositionDoc): string {
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
  return lines.join("\n");
}
