/**
 * Beat sync (pure; Node + browser). MuseLaunch composes its own music, so it knows the beat grid
 * before the music exists: the tempo is picked from the mood (seeded, inside the mood's range), the
 * scene cuts are moved onto that tempo's beats (bar and half-bar boundaries preferred), and the music
 * is then rendered at exactly that tempo (`MusicParams.bpm`). Every cut lands on a beat.
 *
 * Limits that keep the edit honest:
 * - a scene moves by at most ±STRETCH of its planned length, and never gets shorter than it takes to
 *   read its on-screen text (or, when narrated, to say its line);
 * - the video's end is placed so the music's last bar resolves and its final chord rings out;
 * - footage with its own sound (a founder clip speaking) is never re-cut here (callers check
 *   `beatSyncBlocker`), so lips and voice stay in sync.
 */
import { MUSIC_MOOD_INFO, type CompositionDoc, type MusicMood, type Scene } from "@muselaunch/contracts";
import { sceneStarts } from "./validate";

export interface BeatGrid {
  bpm: number;
  beatSec: number;
  barSec: number;
  /** Timeline second of beat 0 (the music starts with the video). */
  offsetSec: number;
}

/** How far a scene may move from its planned length (±20 %). */
export const BEAT_STRETCH = 0.2;
/** Reading pace for on-screen text (same rule as the storyboard writer). */
const WORDS_PER_SEC = 3;

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function beatGrid(bpm: number, offsetSec = 0): BeatGrid {
  const beatSec = 60 / bpm;
  return { bpm, beatSec, barSec: beatSec * 4, offsetSec };
}

/** FNV-1a (32-bit) of a string → [0, 1). Deterministic in Node and the browser. */
function unit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/** The tempo for a video: inside the mood's range, a little around its middle, fixed by the seed. */
export function tempoFor(mood: MusicMood, seed: string): number {
  const [lo, hi] = MUSIC_MOOD_INFO[mood].bpm;
  return Math.round((lo + (hi - lo) * (0.35 + 0.3 * unit(`${mood}|${seed}|tempo`))) * 100) / 100;
}

/** The music's ring-out after its last bar (same rule as the arrangement). */
export function ringOutSec(totalSec: number): number {
  return Math.min(3, Math.max(1.6, totalSec * 0.07));
}

/** Words of the text a viewer must read in a scene (headlines, body, CTA, captions on screen). */
function sceneWords(scene: Pick<Scene, "layers">): number {
  let n = 0;
  for (const l of scene.layers) if (l.type === "text" && !l.hidden && l.role !== "label") n += l.text.split(/\s+/).filter(Boolean).length;
  return n;
}

/**
 * Shortest a scene can be and still be read: ~3 words/s after a 0.6 s entrance (≥ 1.2 s); the hook
 * ≥ 1.5 s and the end card ≥ 2.5 s.
 */
export function readableSec(scene: Pick<Scene, "layers" | "purpose" | "template">, index: number): number {
  let m = Math.max(1.2, sceneWords(scene) / WORDS_PER_SEC + 0.6);
  if (scene.template === "kinetic-type") m = Math.max(m, sceneWords(scene) / WORDS_PER_SEC + 1);
  if (index === 0) m = Math.max(m, 1.5);
  if (scene.purpose === "cta" || scene.template === "cta-endcard" || scene.template === "store-cta") m = Math.max(m, 2.5);
  return r3(m);
}

/** Beat strength at a beat index: 0 = downbeat (bar), 1 = half bar, 2 = other beat. */
const grade = (k: number) => (k % 4 === 0 ? 0 : k % 2 === 0 ? 1 : 2);

/**
 * Durations whose cuts land on the grid. Each cut takes the beat inside its scene's window
 * ([planned − STRETCH, planned + STRETCH], never below `min`) that is closest to the planned cut,
 * favouring bars, then half bars (a bar is worth 0.7 beats of distance, a half bar 0.35). The last
 * scene ends where the music's final bar plus its ring-out ends. Deterministic.
 */
export function snapDurations(durations: readonly number[], grid: BeatGrid, o: { min?: readonly number[]; stretch?: number; minTotalSec?: number; maxTotalSec?: number } = {}): number[] {
  const s = o.stretch ?? BEAT_STRETCH;
  const B = grid.beatSec;
  const out: number[] = [];
  let t = 0;
  durations.forEach((d, i) => {
    const last = i === durations.length - 1;
    const min = Math.min(60, Math.max(0.5, o.min?.[i] ?? 0));
    const lo = t + Math.max(min, d * (1 - s));
    let hi = t + Math.max(d * (1 + s), Math.max(min, d * (1 - s)));
    if (last && o.minTotalSec !== undefined) hi = Math.max(hi, o.minTotalSec);
    // Never past the plan's longest video (or the planned length when that is the cap).
    if (last && o.maxTotalSec !== undefined) hi = Math.max(lo, Math.min(hi, o.maxTotalSec));
    const want = t + d;
    let best: number | null = null;
    let bestScore = Infinity;
    if (!last) {
      for (let k = Math.ceil((lo - grid.offsetSec) / B - 1e-9); grid.offsetSec + k * B <= hi + 1e-9; k++) {
        const c = grid.offsetSec + k * B;
        const score = Math.abs(c - want) / B + grade(k) * 0.35;
        if (score < bestScore - 1e-9) {
          best = c;
          bestScore = score;
        }
      }
      // Window narrower than a beat: the first beat after the readable minimum.
      if (best === null) best = grid.offsetSec + Math.ceil((lo - grid.offsetSec) / B - 1e-9) * B;
    } else {
      // The end: whole bars + the ring-out, nearest the planned end inside the window.
      const floor = Math.max(lo, o.minTotalSec ?? 0);
      for (let bars = 1; bars <= 200; bars++) {
        const c = grid.offsetSec + bars * grid.barSec;
        const end = c + ringOutSec(c);
        if (end > hi + 1e-9) break;
        if (end < floor - 1e-9) continue;
        if (best === null || Math.abs(end - want) < Math.abs(best - want)) best = end;
      }
      if (best === null) best = Math.max(want, floor);
      if (o.maxTotalSec !== undefined) best = Math.max(lo, Math.min(best, o.maxTotalSec));
    }
    const end = r3(Math.min(t + 60, best));
    out.push(r3(end - t));
    t = end;
  });
  return out;
}

/** A scene at a new length: layers that ran to the end still do, nothing starts after it ends. */
export function retimeScene(s: Scene, next: number): Scene {
  const prev = s.durationSec;
  if (Math.abs(prev - next) < 0.0005) return s;
  const layers = s.layers.map((l) => {
    const { start, end } = l.timing;
    const toEnd = end === undefined || end >= prev - 0.05;
    const nextEnd = toEnd ? undefined : Math.min(end!, next);
    const nextStart = Math.min(start, Math.max(0, next - 0.5));
    if (nextStart === start && nextEnd === end) return l;
    return { ...l, timing: { start: nextStart, ...(nextEnd !== undefined ? { end: nextEnd } : {}) } };
  });
  return { ...s, durationSec: next, layers: layers as Scene["layers"] };
}

/**
 * Why a doc must keep its timing (null = it can be cut to the beat): footage with its own sound (a
 * founder clip talking) or a founder voice recording would drift out of sync with the picture.
 */
export function beatSyncBlocker(doc: Pick<CompositionDoc, "kind" | "scenes" | "audio">): string | null {
  if (doc.kind !== "video") return "not a video";
  if (doc.scenes.length < 2) return "a single scene";
  if (doc.audio.some((a) => a.kind === "voiceover" && a.sourceLabel !== "external_tts")) return "the founder's own voice sets the timing";
  if (doc.scenes.some((s) => s.layers.some((l) => l.type === "video" && !l.hidden && !l.muted))) return "a clip with its own sound sets the timing";
  return null;
}

export interface BeatSnap {
  doc: CompositionDoc;
  /** Scenes whose length changed: [sceneId, before, after]. */
  changed: [string, number, number][];
  /** Cuts (scene starts after the first) that are on a beat, and how many of them on a bar. */
  onBeat: number;
  onBar: number;
  cuts: number;
}

/** How many cuts of a doc are on the grid (within 1 ms). */
export function cutsOnGrid(doc: Pick<CompositionDoc, "scenes">, grid: BeatGrid): { cuts: number; onBeat: number; onBar: number } {
  const starts = sceneStarts(doc as CompositionDoc).slice(1);
  let onBeat = 0;
  let onBar = 0;
  for (const t of starts) {
    const k = (t - grid.offsetSec) / grid.beatSec;
    if (Math.abs(k - Math.round(k)) * grid.beatSec < 0.0015) {
      onBeat++;
      if (Math.round(k) % 4 === 0) onBar++;
    }
  }
  return { cuts: starts.length, onBeat, onBar };
}

/**
 * Move a doc's cuts onto the grid (scene lengths only; layer timing follows `retimeScene`). `min`
 * overrides the readable minimum per scene index (e.g. a narrated scene's spoken line).
 */
export function snapToBeats(doc: CompositionDoc, grid: BeatGrid, o: { min?: readonly number[]; minTotalSec?: number; maxTotalSec?: number; stretch?: number } = {}): BeatSnap {
  const planned = doc.scenes.map((s) => s.durationSec);
  const min = doc.scenes.map((s, i) => Math.min(planned[i]!, o.min?.[i] ?? readableSec(s, i)));
  const next = snapDurations(planned, grid, { min, minTotalSec: o.minTotalSec, maxTotalSec: o.maxTotalSec, stretch: o.stretch });
  const changed: [string, number, number][] = [];
  const scenes = doc.scenes.map((s, i) => {
    if (Math.abs(next[i]! - s.durationSec) >= 0.0005) changed.push([s.id, s.durationSec, next[i]!]);
    return retimeScene(s, next[i]!);
  });
  const out: CompositionDoc = { ...doc, scenes, beat: { bpm: grid.bpm, offsetSec: grid.offsetSec } };
  return { doc: out, changed, ...cutsOnGrid(out, grid) };
}
