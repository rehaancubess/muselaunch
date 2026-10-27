import { CompositionDoc, TEMPLATE_IDS, type Layer } from "@muselaunch/contracts";
import { BLOCK_PARAMS, isBlockId } from "./blocks";

export type ValidateResult = { ok: true; doc: CompositionDoc } | { ok: false; errors: string[] };

/** Total timeline length: scenes play back to back (transitions overlap into the incoming scene). */
export function totalDuration(doc: Pick<CompositionDoc, "scenes">): number {
  return round3(doc.scenes.reduce((s, x) => s + x.durationSec, 0));
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Scene start times on the composition timeline. */
export function sceneStarts(doc: Pick<CompositionDoc, "scenes">): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of doc.scenes) {
    out.push(round3(t));
    t += s.durationSec;
  }
  return out;
}

/**
 * Schema + semantic validation. Applies schema defaults, so the returned doc is normalised.
 * Semantic rules: unique scene/layer/audio/cue ids, allowlisted templates and blocks,
 * sane timings, total length ≤ 180 s.
 */
export function validateDoc(input: unknown): ValidateResult {
  const parsed = CompositionDoc.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 30).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const doc = parsed.data;
  const errors: string[] = [];
  const sceneIds = new Set<string>();
  const layerIds = new Set<string>();
  doc.scenes.forEach((scene, si) => {
    const at = `scenes.${si}(${scene.id})`;
    if (sceneIds.has(scene.id)) errors.push(`${at}: duplicate scene id "${scene.id}"`);
    sceneIds.add(scene.id);
    if (!(TEMPLATE_IDS as readonly string[]).includes(scene.template)) errors.push(`${at}.template: "${scene.template}" is not an allowlisted template`);
    if (scene.transitionIn.durationSec > scene.durationSec / 2 + 1e-9) errors.push(`${at}.transitionIn: transition longer than half the scene`);
    if (["image", "video"].includes(scene.background.kind) && !scene.background.assetId) errors.push(`${at}.background: ${scene.background.kind} background needs assetId`);
    if (scene.background.kind === "gradient" && !scene.background.colors) errors.push(`${at}.background: gradient needs colors`);
    scene.layers.forEach((layer, li) => {
      const lat = `${at}.layers.${li}(${layer.id})`;
      if (layerIds.has(layer.id) || sceneIds.has(layer.id)) errors.push(`${lat}: duplicate id "${layer.id}"`);
      layerIds.add(layer.id);
      errors.push(...layerErrors(layer, scene.durationSec).map((e) => `${lat}${e}`));
    });
  });
  const audioIds = new Set<string>();
  const total = totalDuration(doc);
  if (total > 180) errors.push(`scenes: total duration ${total}s exceeds 180s`);
  doc.audio.forEach((a, i) => {
    if (audioIds.has(a.id)) errors.push(`audio.${i}: duplicate id "${a.id}"`);
    audioIds.add(a.id);
    if (a.endSec !== undefined && a.endSec <= a.startSec) errors.push(`audio.${i}: endSec must be after startSec`);
  });
  const cueIds = new Set<string>();
  doc.captions.cues.forEach((c, i) => {
    if (cueIds.has(c.id)) errors.push(`captions.cues.${i}: duplicate id "${c.id}"`);
    cueIds.add(c.id);
    if (c.endSec <= c.startSec) errors.push(`captions.cues.${i}: endSec must be after startSec`);
  });
  if (doc.kind !== "video" && doc.audio.length) errors.push(`audio: ${doc.kind} compositions cannot carry audio`);
  return errors.length ? { ok: false, errors } : { ok: true, doc };
}

function layerErrors(layer: Layer, sceneDur: number): string[] {
  const e: string[] = [];
  if (layer.timing.end !== undefined && layer.timing.end <= layer.timing.start) e.push(".timing: end must be after start");
  if (layer.timing.start >= sceneDur) e.push(`.timing: starts at ${layer.timing.start}s but the scene is ${sceneDur}s long`);
  const kf = layer.animation.keyframes;
  if (kf) for (let i = 1; i < kf.length; i++) if (kf[i]!.t < kf[i - 1]!.t) e.push(".animation.keyframes: times must be ascending");
  if (layer.type === "block") {
    if (!isBlockId(layer.blockId)) e.push(`.blockId: "${layer.blockId}" is not an allowlisted block`);
    else {
      const r = BLOCK_PARAMS[layer.blockId].safeParse(layer.params);
      if (!r.success) e.push(...r.error.issues.map((i) => `.params.${i.path.join(".")}: ${i.message}`));
    }
  }
  if (layer.type === "video" && layer.trimOutSec !== undefined && layer.trimOutSec <= layer.trimInSec) e.push(".trimOutSec: must be after trimInSec");
  if (layer.type === "effect" && layer.effect === "screen-insert" && !layer.assetId) e.push(".assetId: screen-insert needs the real app media to place on the object");
  if (layer.type === "effect" && layer.effect !== "screen-insert" && layer.assetId) e.push(".assetId: only screen-insert effects take media");
  return e;
}
