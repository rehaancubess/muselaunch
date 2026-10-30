/**
 * Harmony for the music generator: extended chords (7ths/9ths/11ths), progressions written as
 * scale-relative roots, and voicings chosen by smooth voice leading (minimal total motion, no muddy
 * low clusters, a singable top line).
 */

/** Intervals above the chord root (semitones). */
export const CHORD_QUALITIES = {
  maj7: [0, 4, 7, 11],
  maj9: [0, 4, 7, 11, 14],
  "maj7#11": [0, 4, 7, 11, 18],
  add9: [0, 4, 7, 14],
  "6/9": [0, 4, 7, 9, 14],
  sus2: [0, 2, 7],
  m7: [0, 3, 7, 10],
  m9: [0, 3, 7, 10, 14],
  m11: [0, 3, 7, 10, 14, 17],
  madd9: [0, 3, 7, 14],
  "7": [0, 4, 7, 10],
  "9": [0, 4, 7, 10, 14],
  "13": [0, 4, 10, 14, 21],
  "7sus4": [0, 5, 7, 10],
  "9sus4": [0, 5, 7, 10, 14],
} as const;
export type ChordQuality = keyof typeof CHORD_QUALITIES;

export interface ChordSpec {
  /** Root, semitones above the key's tonic. */
  root: number;
  quality: ChordQuality;
}

export interface Chord extends ChordSpec {
  /** Absolute root pitch class (0 = C). */
  pc: number;
  /** Pitch classes in the chord. */
  pcs: number[];
  /** Pitch classes a voicing must contain (3rd, 7th/6th, colour tone). */
  required: number[];
}

export function chordOf(tonic: number, spec: ChordSpec): Chord {
  const pc = (((tonic + spec.root) % 12) + 12) % 12;
  const ivs = CHORD_QUALITIES[spec.quality];
  const pcs = [...new Set(ivs.map((i) => (pc + i) % 12))];
  // Root and 5th are optional in upper voicings (the bass carries the root); colour tones are not.
  const required = [...new Set(ivs.filter((i) => i !== 0 && i !== 7).map((i) => (pc + i) % 12))];
  return { ...spec, pc, pcs, required };
}

/** Bass root in a register that phones still hint at (C2–B2 → harmonics carry it). */
export function bassRoot(chord: Chord, low = 36): number {
  let m = low + ((chord.pc - (low % 12) + 12) % 12);
  if (m > low + 11) m -= 12;
  return m;
}

function combos<T>(arr: T[], k: number, start = 0, acc: T[] = [], out: T[][] = []): T[][] {
  if (acc.length === k) {
    out.push([...acc]);
    return out;
  }
  for (let i = start; i <= arr.length - (k - acc.length); i++) {
    acc.push(arr[i]!);
    combos(arr, k, i + 1, acc, out);
    acc.pop();
    if (out.length > 4000) break;
  }
  return out;
}

/**
 * Voice `chord` with `voices` notes in [lo, hi], moving as little as possible from `prev`.
 * Rules: all required tones present, no doubled pitch class unless needed, no interval under a
 * minor third below MIDI 57 (mud), span ≤ 2 octaves, top note close to the previous top note.
 */
export function voiceChord(chord: Chord, prev: number[] | null, o: { voices: number; lo: number; hi: number; center?: number }): number[] {
  const cands: number[] = [];
  for (let m = o.lo; m <= o.hi; m++) if (chord.pcs.includes(m % 12)) cands.push(m);
  const k = Math.min(o.voices, cands.length);
  let best: number[] | null = null;
  let bestScore = Infinity;
  const center = o.center ?? (o.lo + o.hi) / 2;
  for (const c of combos(cands, k)) {
    const pcs = c.map((m) => m % 12);
    if (!chord.required.every((r) => pcs.includes(r))) continue;
    if (new Set(pcs).size < Math.min(k, chord.pcs.length)) continue;
    let ok = true;
    for (let i = 1; i < c.length; i++) {
      const gap = c[i]! - c[i - 1]!;
      if (c[i - 1]! < 57 && gap < 3) ok = false;
      if (gap > 9) ok = false; // keep the voicing coherent (no holes in the middle)
    }
    if (!ok || c[c.length - 1]! - c[0]! > 24) continue;
    let score = 0;
    if (prev && prev.length) {
      for (let i = 0; i < c.length; i++) score += Math.abs(c[i]! - prev[Math.min(i, prev.length - 1)]!);
      score += Math.abs(c[c.length - 1]! - prev[prev.length - 1]!) * 1.5; // smooth top line
    } else {
      const mid = c.reduce((a, b) => a + b, 0) / c.length;
      score += Math.abs(mid - center) * 2;
    }
    // Gentle preference for the register centre so voicings don't drift over a long track.
    const mid = c.reduce((a, b) => a + b, 0) / c.length;
    score += Math.abs(mid - center) * 0.35;
    // Seconds at the top sparkle; seconds in the middle can get cloudy.
    for (let i = 1; i < c.length - 1; i++) if (c[i]! - c[i - 1]! <= 2) score += 1.2;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best) return best;
  // Fallback: stacked chord tones from the bottom of the range.
  return cands.slice(0, k);
}

/** Chord tones spread over `octaves` from `from` (for arps / melodies). */
export function chordTones(chord: Chord, from: number, octaves = 2): number[] {
  const out: number[] = [];
  for (let m = from; m < from + 12 * octaves; m++) if (chord.pcs.includes(m % 12)) out.push(m);
  return out;
}

/** Major/minor pentatonic + chord tones, for passing notes that never clash. */
export function safeScale(tonic: number, minor: boolean): number[] {
  const ivs = minor ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];
  return ivs.map((i) => (tonic + i) % 12);
}
