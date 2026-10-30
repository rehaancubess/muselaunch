/**
 * Deterministic measurements for Spark's video review (template-agnostic: they read the composition
 * document's scenes and layers, and pixel statistics of the extracted frames). They are given to Spark
 * as facts and stored as `measured` findings when Spark doesn't report the same problem itself.
 */
import type { CompositionDoc, Layer, MediaAsset, Scene, VideoReviewCheck, VideoReviewSeverity } from "@muselaunch/contracts";
import { sceneStarts } from "@muselaunch/compositions";
import sharp from "sharp";

/** Comfortable on-screen reading speed for short-form video (words per second). */
export const READING_WPS = 3;
/** At or above this, the hook can't be read in time: a blocker. */
export const HOOK_BLOCKER_WPS = 4;

export interface MeasuredFinding {
  sceneId?: string;
  severity: VideoReviewSeverity;
  check: VideoReviewCheck;
  issue: string;
  fixInstruction: string;
  frameRef?: string;
  measurement: string;
}

export interface SceneText {
  layerId: string;
  role: string;
  text: string;
  /** Seconds from scene start when the text is fully on screen. */
  readableFrom: number;
  /** Seconds from scene start when it leaves. */
  until: number;
}

export interface SceneFacts {
  id: string;
  name: string;
  template: string;
  purpose?: string;
  index: number;
  startSec: number;
  durationSec: number;
  texts: SceneText[];
  words: number;
  /** Words per second over the time the text is readable (undefined without text). */
  wps?: number;
  /** Media shown in this scene (asset ids), for repetition checks. */
  stillMedia: string[];
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();
export const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Block params that carry visible copy (Track 2 templates are blocks with text params). */
const TEXT_PARAM = /(^|_)(title|headline|subtitle|subhead|text|label|caption|cta|quote|line\d*|body|tagline|kicker|eyebrow)$/i;

function layerTexts(scene: Scene, l: Layer): SceneText[] {
  if (l.hidden) return [];
  const enter = l.animation.enter;
  const readableFrom = Math.min(scene.durationSec, l.timing.start + (enter ? enter.delaySec + enter.durationSec : 0));
  const until = Math.min(scene.durationSec, l.timing.end ?? scene.durationSec);
  if (l.type === "text") return [{ layerId: l.id, role: l.role, text: l.text, readableFrom, until }];
  if (l.type === "block") {
    return Object.entries(l.params)
      .filter(([k, v]) => typeof v === "string" && TEXT_PARAM.test(k) && wordCount(v) > 0 && !/^(#|https?:|ast_|theme\.)/.test(v))
      .map(([k, v]) => ({ layerId: `${l.id}.${k}`, role: "block", text: String(v), readableFrom, until }));
  }
  return [];
}

function stillMediaOf(l: Layer): string[] {
  if (l.hidden) return [];
  if (l.type === "device" && l.screenKind === "image") return [l.screenAssetId];
  if (l.type === "image") return [l.assetId];
  return [];
}

/** Scene timing, visible text with reading speed, and the still media each scene shows. */
export function sceneFacts(doc: CompositionDoc): SceneFacts[] {
  const starts = sceneStarts(doc);
  return doc.scenes.map((s, index) => {
    const texts = s.layers.flatMap((l) => layerTexts(s, l)).filter((t) => t.role !== "caption");
    const words = texts.reduce((n, t) => n + wordCount(t.text), 0);
    const from = texts.length ? Math.min(...texts.map((t) => t.readableFrom)) : 0;
    const to = texts.length ? Math.max(...texts.map((t) => t.until)) : s.durationSec;
    const window = Math.max(0.3, to - from);
    return {
      id: s.id,
      name: s.name,
      template: s.template,
      purpose: s.purpose,
      index,
      startSec: starts[index] ?? 0,
      durationSec: s.durationSec,
      texts,
      words,
      wps: words ? Math.round((words / window) * 10) / 10 : undefined,
      stillMedia: [...new Set(s.layers.flatMap(stillMediaOf))],
    };
  });
}

/** Reading speed: the opening scene against ~3 words/s (blocker at ≥4), other scenes warned when much faster. */
export function readingFindings(facts: SceneFacts[]): MeasuredFinding[] {
  const out: MeasuredFinding[] = [];
  for (const f of facts) {
    if (!f.wps || f.words < 3) continue;
    const need = Math.ceil((f.words / READING_WPS) * 10) / 10;
    if (f.index === 0 && f.wps > READING_WPS) {
      out.push({
        sceneId: f.id,
        severity: f.wps >= HOOK_BLOCKER_WPS ? "blocker" : "warn",
        check: "hook_readability",
        issue: `The opening text has ${f.words} words on screen for about ${fmt(f.words / f.wps)} s (${fmt(f.wps)} words/s): too fast to read before viewers scroll.`,
        fixInstruction: `In this scene only, cut the on-screen text to at most ${Math.max(3, Math.floor(f.durationSec * READING_WPS * 0.85))} words, or keep the words and extend the scene to about ${fmt(Math.max(need + 0.4, f.durationSec))} s.`,
        measurement: `${fmt(f.wps)} words/s (${f.words} words)`,
      });
    } else if (f.index > 0 && f.wps >= HOOK_BLOCKER_WPS + 0.5) {
      out.push({
        sceneId: f.id,
        severity: "warn",
        check: "pacing",
        issue: `“${f.name}” shows ${f.words} words for about ${fmt(f.words / f.wps)} s (${fmt(f.wps)} words/s), so most viewers can't finish reading it.`,
        fixInstruction: `In this scene only, shorten the text or extend the scene to about ${fmt(Math.max(need, f.durationSec))} s.`,
        measurement: `${fmt(f.wps)} words/s (${f.words} words)`,
      });
    }
  }
  return out;
}

/** A store "marketing" screenshot (it already contains its own phone frame) inside a device mockup. */
export function frameInFrameFindings(doc: CompositionDoc, assets: Map<string, MediaAsset>): MeasuredFinding[] {
  const out: MeasuredFinding[] = [];
  for (const s of doc.scenes) {
    for (const l of s.layers) {
      if (l.hidden) continue;
      const id = l.type === "device" ? l.screenAssetId : l.type === "effect" && l.effect === "screen-insert" ? l.assetId : undefined;
      const a = id ? assets.get(id) : undefined;
      if (!a || a.screenshotKind !== "marketing") continue;
      out.push({
        sceneId: s.id,
        severity: "blocker",
        check: "device_frame",
        issue: `“${s.name}” puts a designed store screenshot (it already has its own phone frame and headline) inside another device frame.`,
        fixInstruction: "In this scene only, show that store image without a device frame (as an image layer), or put a raw app screenshot or recording in the device instead.",
        measurement: `layer ${l.id} shows marketing screenshot ${a.id}`,
      });
    }
  }
  return out;
}

/** The same still screenshot/image in 3+ scenes (reported on the third and later scenes). */
export function repetitionFindings(facts: SceneFacts[]): MeasuredFinding[] {
  const seen = new Map<string, SceneFacts[]>();
  for (const f of facts) for (const a of f.stillMedia) seen.set(a, [...(seen.get(a) ?? []), f]);
  const out: MeasuredFinding[] = [];
  for (const [assetId, scenes] of seen) {
    if (scenes.length < 3) continue;
    const later = scenes.slice(2);
    for (const s of later) {
      out.push({
        sceneId: s.id,
        severity: "warn",
        check: "repetition",
        issue: `The same screenshot appears in ${scenes.length} scenes (${scenes.map((x) => `“${x.name}”`).join(", ")}); by “${s.name}” it reads as a repeat.`,
        fixInstruction: "In this scene only, show a different real screenshot or recording of the app (one not used in the earlier scenes), or a different crop of the feature this scene is about.",
        measurement: `asset ${assetId} in ${scenes.length} scenes`,
      });
    }
  }
  return out;
}

export interface FrameStats {
  ref: string;
  sceneId?: string;
  kind: string;
  atSec: number;
  /** Mean luminance 0–255. */
  mean: number;
  /** Largest per-channel standard deviation (≈0 = one flat colour). */
  stdev: number;
}

/** Pixel statistics of an extracted frame. */
export async function frameStats(buf: Buffer): Promise<{ mean: number; stdev: number }> {
  const s = await sharp(buf).stats();
  const ch = s.channels.slice(0, 3);
  return { mean: ch.reduce((n, c) => n + c.mean, 0) / Math.max(1, ch.length), stdev: Math.max(...ch.map((c) => c.stdev)) };
}

/** Flat-colour frames: a blank, black or missing-media scene (the very first frame may be a fade-in). */
export function blankFrameFindings(stats: FrameStats[], facts: SceneFacts[]): MeasuredFinding[] {
  const out: MeasuredFinding[] = [];
  for (const f of stats) {
    if (f.stdev >= 3) continue;
    const scene = facts.find((s) => s.id === f.sceneId);
    const black = f.mean < 12;
    const first = f.kind === "first";
    out.push({
      sceneId: f.sceneId,
      severity: first ? "warn" : "blocker",
      check: "broken_frame",
      issue: first
        ? `The very first frame (${f.ref}) is a single ${black ? "black" : "flat"} colour, so the video opens on an empty frame in the feed.`
        : `Frame ${f.ref} at ${fmt(f.atSec)} s${scene ? ` (“${scene.name}”)` : ""} is a single ${black ? "black" : "flat"} colour: the scene shows nothing there.`,
      fixInstruction: first
        ? "In the opening scene only, make the headline or the app visible from the first frame (no fade-in from an empty background)."
        : "In this scene only, make sure its media and text are visible: replace missing media with a real screenshot or recording and remove anything covering the frame.",
      frameRef: f.ref,
      measurement: `mean ${Math.round(f.mean)}, deviation ${fmt(f.stdev)}`,
    });
  }
  return out;
}
