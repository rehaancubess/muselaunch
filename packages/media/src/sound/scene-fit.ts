import type { CompositionDoc, Scene } from "@muselaunch/contracts";
import { totalDuration } from "@muselaunch/compositions";

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Scene timing for a narrated video: every narrated scene stays on screen for its own spoken line
 * (a short lead-in, the line, a breath), so what is said matches what is shown. Scenes only grow;
 * if that pushes the video past the plan's length, scenes without narration and spare time in
 * narrated scenes give time back first, and what is still over is reported (the caller speeds the
 * voice up a little and fits again).
 */
export const VOICE_LEAD_SEC = 0.25;
export const VOICE_TAIL_SEC = 0.45;
/** Scenes without narration never get shorter than this (or their own length, if shorter). */
export const SILENT_SCENE_FLOOR_SEC = 1.6;

export interface VoicePlacement {
  sceneId: string;
  /** Video seconds. */
  startSec: number;
  endSec: number;
}

export interface SceneFit {
  doc: CompositionDoc;
  placements: VoicePlacement[];
  totalSec: number;
  /** Seconds still over `maxTotalSec` after giving time back (0 when it fits). */
  overflowSec: number;
  /** Scenes whose length changed: [sceneId, before, after]. */
  changed: [string, number, number][];
}

export function fitScenesToVoice(doc: CompositionDoc, lineSec: ReadonlyMap<string, number>, o: { maxTotalSec: number; leadSec?: number; tailSec?: number }): SceneFit {
  const lead = o.leadSec ?? VOICE_LEAD_SEC;
  const tail = o.tailSec ?? VOICE_TAIL_SEC;
  const need = doc.scenes.map((s) => {
    const d = lineSec.get(s.id);
    return d && d > 0 ? lead + d + tail : 0;
  });
  const dur = doc.scenes.map((s, i) => Math.max(s.durationSec, need[i]!));
  let over = dur.reduce((a, b) => a + b, 0) - o.maxTotalSec;
  // Give time back: silent scenes down to their floor, then spare time in narrated scenes.
  const giveBack = (room: number[]) => {
    const total = room.reduce((a, b) => a + b, 0);
    if (over <= 0 || total <= 0) return;
    const take = Math.min(over, total);
    room.forEach((r, i) => (dur[i] = dur[i]! - (r / total) * take));
    over -= take;
  };
  giveBack(doc.scenes.map((s, i) => (need[i] ? 0 : Math.max(0, dur[i]! - Math.min(s.durationSec, SILENT_SCENE_FLOOR_SEC)))));
  giveBack(doc.scenes.map((_, i) => (need[i] ? Math.max(0, dur[i]! - need[i]!) : 0)));

  const changed: [string, number, number][] = [];
  const scenes = doc.scenes.map((s, i) => {
    const next = Math.round(dur[i]! * 1000) / 1000;
    if (Math.abs(next - s.durationSec) < 0.001) return s;
    changed.push([s.id, s.durationSec, next]);
    return retimeScene(s, next);
  });
  const out: CompositionDoc = { ...doc, scenes };
  const placements: VoicePlacement[] = [];
  let t = 0;
  for (const s of scenes) {
    const d = lineSec.get(s.id);
    if (d && d > 0) placements.push({ sceneId: s.id, startSec: round3(t + lead), endSec: round3(t + lead + d) });
    t += s.durationSec;
  }
  const totalSec = totalDuration(out);
  return { doc: out, placements, totalSec, overflowSec: Math.max(0, round3(totalSec - o.maxTotalSec)), changed };
}

/** New scene length; layers that ran to the end of the scene still do, nothing starts after it ends. */
function retimeScene(s: Scene, next: number): Scene {
  const prev = s.durationSec;
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

/** Caption cues for the spoken lines, at their placements (long lines split at word boundaries). */
export function lineCaptions(lines: { sceneId: string; text: string }[], placements: VoicePlacement[], o: { idPrefix: string; maxChars?: number }): { id: string; startSec: number; endSec: number; text: string }[] {
  const maxChars = o.maxChars ?? 64;
  const cues: { id: string; startSec: number; endSec: number; text: string }[] = [];
  for (const pl of placements) {
    const line = lines.find((l) => l.sceneId === pl.sceneId);
    if (!line) continue;
    const chunks: string[] = [];
    let cur = "";
    for (const w of line.text.replace(/\s+/g, " ").trim().split(" ")) {
      if (cur && `${cur} ${w}`.length > maxChars) {
        chunks.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) chunks.push(cur);
    const chars = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let t = pl.startSec;
    chunks.forEach((c, k) => {
      const len = ((pl.endSec - pl.startSec) * c.length) / chars;
      const end = k === chunks.length - 1 ? pl.endSec : t + len;
      cues.push({ id: `${o.idPrefix}_${cues.length + 1}`.slice(0, 120), startSec: round3(t), endSec: round3(Math.max(end, t + 0.3)), text: c.slice(0, 300) });
      t = end;
    });
  }
  return cues;
}
