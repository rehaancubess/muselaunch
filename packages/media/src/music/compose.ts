/**
 * MuseLaunch original music: mood presets → a fitted arrangement → synthesized stems → auto-balanced
 * mix with sends (plate reverb, ping-pong delay) and sidechain pumping → mastered stereo PCM.
 *
 * Deterministic: the seed picks key, progression, patterns and humanization; same params, same bytes.
 * The arrangement is fitted to the exact duration: tempo is nudged inside the mood's range so whole
 * bars end with a final chord that rings out to the last sample, after an intro and a stripped outro.
 */
import { MUSIC_CEILING_DB, MUSIC_MOOD_INFO, MUSIC_TARGET_LUFS, type MusicMood } from "@muselaunch/contracts";
import { Biquad, chorus, clamp, dbToGain, duckCurve, eq, fsin, pingPong, Plate, Rng, SR, Stereo, Svf, TAU, width } from "./dsp";
import * as I from "./instruments";
import { integratedLoudness, master, type MasterReport } from "./master";
import { bassRoot, chordOf, chordTones, voiceChord, type Chord, type ChordQuality } from "./theory";

type Prog = [number, ChordQuality][];
type DrumStyle = "pop" | "tech" | "soft" | "boombap" | "cinematic";
type LeadStyle = "pluck-motif" | "bell-arp" | "sparkle" | "bell-motif" | "ostinato";
type BassPattern = "tresillo" | "pulse16" | "walk" | "boombap" | "sustain" | "ostinato8";

interface MoodConfig {
  minor: boolean;
  tonics: number[];
  progressions: Prog[];
  final: [number, ChordQuality];
  chordBars: 1 | 2;
  swing16: number;
  swing8: number;
  build: "song" | "ramp";
  /** Stem loudness relative to the mix reference (LU). Undefined = part not used. */
  levels: { drums?: number; bass?: number; pad?: number; keys?: number; lead?: number; fx: number; reverb: number; delay?: number };
  pad?: { attack: number; release: number; cutoff: [number, number, number, number]; detune: number; tri: number; voices: number; lo: number; hi: number; vel: [number, number, number, number] };
  keys?: { style: "warm" | "lofi"; bright: number };
  bass?: { style: I.BassStyle; pattern: BassPattern };
  lead?: { style: LeadStyle; lo: number };
  drums?: DrumStyle;
  sidechain: { depth: number; releaseBeats: number; pad: number; bass: number; lead: number; keys: number };
  reverb: { decay: number; damping: number; predelayMs: number; size: number; sends: { pad: number; keys: number; lead: number; perc: number; fx: number } };
  delay?: { beats: number; feedback: number; send: number };
  lofi?: boolean;
  /** Master tone: high-shelf (dB at 9 kHz) and low-pass. */
  tone: { shelfDb: number; presenceDb: number; lowpass: number; width: number };
}

export const MOODS: Record<MusicMood, MoodConfig> = {
  "bright-pluck": {
    minor: false,
    tonics: [0, 2, 5, 7, 9],
    progressions: [
      [[0, "maj9"], [9, "m9"], [5, "maj9"], [7, "9sus4"]],
      [[5, "maj9"], [0, "add9"], [7, "add9"], [9, "m7"]],
      [[9, "m9"], [5, "maj7"], [0, "add9"], [7, "9sus4"]],
    ],
    final: [0, "maj9"],
    chordBars: 1,
    swing16: 0.53,
    swing8: 0.5,
    build: "song",
    levels: { drums: -5, bass: -7.5, pad: -9, lead: -6, fx: -13, reverb: -14, delay: -16 },
    pad: { attack: 0.3, release: 0.7, cutoff: [900, 1500, 2400, 3600], detune: 8, tri: 0.7, voices: 4, lo: 55, hi: 76, vel: [0.6, 0.7, 0.8, 0.9] },
    bass: { style: "round", pattern: "tresillo" },
    lead: { style: "pluck-motif", lo: 67 },
    drums: "pop",
    sidechain: { depth: 0.5, releaseBeats: 0.55, pad: 1, bass: 0.7, lead: 0.35, keys: 0.5 },
    reverb: { decay: 0.72, damping: 0.35, predelayMs: 18, size: 1, sends: { pad: 0.4, keys: 0.3, lead: 0.35, perc: 0.22, fx: 0.5 } },
    delay: { beats: 0.75, feedback: 0.36, send: 0.35 },
    tone: { shelfDb: 2.5, presenceDb: 1.5, lowpass: 17000, width: 1.15 },
  },
  "calm-pad": {
    minor: false,
    tonics: [2, 4, 5, 7, 9],
    progressions: [
      [[0, "maj9"], [9, "m9"], [5, "maj7#11"], [7, "9sus4"]],
      [[0, "maj7"], [4, "m7"], [5, "maj9"], [2, "m9"]],
      [[5, "maj9"], [0, "6/9"], [9, "m9"], [7, "9sus4"]],
    ],
    final: [0, "maj9"],
    chordBars: 2,
    swing16: 0.5,
    swing8: 0.5,
    build: "song",
    levels: { bass: -10, pad: -3, lead: -7.5, fx: -14, reverb: -8, delay: -14 },
    pad: { attack: 1.6, release: 2.4, cutoff: [900, 1300, 1900, 2700], detune: 9, tri: 0.9, voices: 5, lo: 53, hi: 79, vel: [0.7, 0.8, 0.9, 0.95] },
    bass: { style: "sub", pattern: "sustain" },
    lead: { style: "sparkle", lo: 74 },
    sidechain: { depth: 0, releaseBeats: 1, pad: 0, bass: 0, lead: 0, keys: 0 },
    reverb: { decay: 0.84, damping: 0.5, predelayMs: 32, size: 1.25, sends: { pad: 0.45, keys: 0.4, lead: 0.6, perc: 0.3, fx: 0.6 } },
    delay: { beats: 1, feedback: 0.42, send: 0.4 },
    tone: { shelfDb: 2.5, presenceDb: 1, lowpass: 16000, width: 1.2 },
  },
  "tech-pulse": {
    minor: true,
    tonics: [9, 11, 0, 2, 4],
    progressions: [
      [[0, "m9"], [8, "maj7"], [3, "maj9"], [10, "add9"]],
      [[0, "m9"], [10, "add9"], [8, "maj7"], [10, "9sus4"]],
      [[8, "maj7#11"], [10, "6/9"], [0, "m9"], [7, "m7"]],
    ],
    final: [0, "m9"],
    chordBars: 1,
    swing16: 0.5,
    swing8: 0.5,
    build: "song",
    levels: { drums: -5, bass: -7.5, pad: -10, lead: -8, fx: -13, reverb: -15, delay: -16 },
    pad: { attack: 0.12, release: 0.5, cutoff: [700, 1100, 1900, 3200], detune: 10, tri: 0.4, voices: 4, lo: 53, hi: 74, vel: [0.6, 0.7, 0.8, 0.9] },
    bass: { style: "pulse", pattern: "pulse16" },
    lead: { style: "bell-arp", lo: 69 },
    drums: "tech",
    sidechain: { depth: 0.6, releaseBeats: 0.5, pad: 1, bass: 0.85, lead: 0.45, keys: 0.5 },
    reverb: { decay: 0.66, damping: 0.4, predelayMs: 12, size: 0.9, sends: { pad: 0.35, keys: 0.3, lead: 0.3, perc: 0.18, fx: 0.5 } },
    delay: { beats: 0.75, feedback: 0.4, send: 0.4 },
    tone: { shelfDb: 2.5, presenceDb: 1.5, lowpass: 17500, width: 1.15 },
  },
  "warm-keys": {
    minor: false,
    tonics: [3, 5, 7, 8, 10, 0],
    progressions: [
      [[2, "m9"], [7, "13"], [0, "maj9"], [9, "m9"]],
      [[5, "maj9"], [4, "m7"], [2, "m9"], [7, "9sus4"]],
      [[0, "maj9"], [9, "m9"], [2, "m9"], [7, "13"]],
    ],
    final: [0, "maj9"],
    chordBars: 1,
    swing16: 0.55,
    swing8: 0.5,
    build: "song",
    levels: { drums: -7, bass: -8, keys: -3, pad: -13, lead: -10, fx: -14, reverb: -12, delay: -17 },
    pad: { attack: 0.8, release: 1.2, cutoff: [800, 1000, 1400, 1900], detune: 6, tri: 1, voices: 4, lo: 55, hi: 74, vel: [0.6, 0.7, 0.75, 0.8] },
    keys: { style: "warm", bright: 0.7 },
    bass: { style: "round", pattern: "walk" },
    lead: { style: "bell-motif", lo: 72 },
    drums: "soft",
    sidechain: { depth: 0.15, releaseBeats: 0.6, pad: 1, bass: 0.4, lead: 0.2, keys: 0.5 },
    reverb: { decay: 0.7, damping: 0.45, predelayMs: 20, size: 1, sends: { pad: 0.3, keys: 0.22, lead: 0.4, perc: 0.2, fx: 0.5 } },
    delay: { beats: 0.75, feedback: 0.3, send: 0.25 },
    tone: { shelfDb: 1.5, presenceDb: 1, lowpass: 16000, width: 1.1 },
  },
  "cinematic-build": {
    minor: true,
    tonics: [2, 4, 7, 9, 11],
    progressions: [
      [[0, "madd9"], [8, "add9"], [3, "add9"], [10, "add9"]],
      [[0, "madd9"], [10, "sus2"], [8, "maj7"], [10, "add9"]],
      [[8, "add9"], [3, "add9"], [10, "add9"], [0, "madd9"]],
    ],
    final: [0, "madd9"],
    chordBars: 1,
    swing16: 0.5,
    swing8: 0.5,
    build: "ramp",
    levels: { drums: -5.5, bass: -8, pad: -4, lead: -8.5, fx: -9, reverb: -9, delay: -16 },
    pad: { attack: 0.7, release: 1.5, cutoff: [700, 1200, 2200, 3800], detune: 11, tri: 0.6, voices: 5, lo: 50, hi: 74, vel: [0.6, 0.75, 0.85, 1] },
    bass: { style: "ostinato", pattern: "ostinato8" },
    lead: { style: "ostinato", lo: 64 },
    drums: "cinematic",
    sidechain: { depth: 0.2, releaseBeats: 0.8, pad: 0.6, bass: 0.4, lead: 0.2, keys: 0.3 },
    reverb: { decay: 0.82, damping: 0.45, predelayMs: 26, size: 1.25, sends: { pad: 0.35, keys: 0.3, lead: 0.35, perc: 0.45, fx: 0.6 } },
    delay: { beats: 0.5, feedback: 0.3, send: 0.2 },
    tone: { shelfDb: 3, presenceDb: 1.5, lowpass: 17000, width: 1.2 },
  },
  "lofi-chill": {
    minor: false,
    tonics: [0, 2, 5, 7, 9, 10],
    progressions: [
      [[5, "maj9"], [4, "m7"], [2, "m9"], [0, "maj7"]],
      [[2, "m9"], [7, "9"], [0, "maj9"], [9, "m9"]],
      [[0, "maj7"], [9, "m9"], [5, "maj9"], [4, "m7"]],
    ],
    final: [0, "maj9"],
    chordBars: 1,
    swing16: 0.5,
    swing8: 0.6,
    build: "song",
    levels: { drums: -5.5, bass: -8, keys: -2.5, lead: -11, fx: -15, reverb: -13 },
    keys: { style: "lofi", bright: 0.4 },
    bass: { style: "round", pattern: "boombap" },
    lead: { style: "bell-motif", lo: 72 },
    drums: "boombap",
    sidechain: { depth: 0.2, releaseBeats: 0.6, pad: 0.5, bass: 0.3, lead: 0.2, keys: 0.4 },
    reverb: { decay: 0.6, damping: 0.6, predelayMs: 14, size: 0.9, sends: { pad: 0.3, keys: 0.2, lead: 0.4, perc: 0.15, fx: 0.4 } },
    lofi: true,
    tone: { shelfDb: -1, presenceDb: 0.5, lowpass: 10000, width: 1.05 },
  },
};

const MIX_REF = -18;

// ---------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------

export interface MusicPlan {
  bpm: number;
  beatSec: number;
  barSec: number;
  bars: number;
  contentSec: number;
  tailSec: number;
  durationSec: number;
  introBars: number;
  outroBars: number;
  /** Energy per bar: 0 intro, 1 low/break/outro, 2 build, 3 full. */
  energy: number[];
  /** Accent times (s) after snapping to beats and thinning. */
  accents: number[];
}

/** Tempo in the mood's range so whole bars + a 1.2–3.5 s ring-out tail fill the exact duration. */
export function planArrangement(mood: MusicMood, durationSec: number, rng: Rng, accents: number[] = []): MusicPlan {
  const cfg = MOODS[mood];
  const [lo, hi] = MUSIC_MOOD_INFO[mood].bpm;
  const center = lo + (hi - lo) * rng.range(0.35, 0.65);
  const tailNominal = clamp(durationSec * 0.07, 1.6, 3);
  let best: { bpm: number; bars: number } | null = null;
  for (let bars = 1; bars <= 200; bars++) {
    const bpm = (240 * bars) / Math.max(0.5, durationSec - tailNominal);
    if (bpm < lo || bpm > hi) continue;
    if (!best || Math.abs(bpm - center) < Math.abs(best.bpm - center)) best = { bpm, bars };
  }
  if (!best) {
    const bpm = center;
    const bars = Math.max(1, Math.floor((durationSec - 1.2) / (240 / bpm)));
    best = { bpm, bars };
  }
  const beatSec = 60 / best.bpm;
  const barSec = beatSec * 4;
  const N = best.bars;
  const contentSec = N * barSec;
  const calm = mood === "calm-pad" || mood === "cinematic-build";
  const introBars = calm ? (N >= 8 ? 2 : N >= 4 ? 1 : 0) : N >= 12 ? 2 : N >= 6 ? 1 : 0;
  const outroBars = N >= 8 ? 1 : 0;
  const body = N - introBars - outroBars;
  const energy: number[] = new Array(N).fill(0);
  for (let b = introBars; b < introBars + body; b++) {
    const x = (b - introBars) / Math.max(1, body);
    if (cfg.build === "ramp") energy[b] = x < 0.25 ? 1 : x < 0.6 ? 2 : 3;
    else {
      const a = body <= 4 ? Math.ceil(body / 2) : 2 * Math.round((body * 0.4) / 2);
      energy[b] = b - introBars < a ? 2 : 3;
    }
  }
  // A two-bar breakdown in long songs, at a phrase boundary ~60% through the body.
  if (cfg.build === "song" && body >= 20) {
    const at = introBars + 2 * Math.round((body * 0.6) / 2);
    for (let b = at; b < Math.min(at + 2, introBars + body - 2); b++) energy[b] = 1;
  }
  for (let b = N - outroBars; b < N; b++) energy[b] = 1;

  // Accents: nearest beat, inside the body, ≥ 2 bars apart, at most 4.
  const snapped: number[] = [];
  for (const t of [...accents].sort((a, b) => a - b)) {
    const s = Math.round(t / beatSec) * beatSec;
    if (s < Math.max(1.5, barSec) || s > contentSec - beatSec) continue;
    if (snapped.length && s - snapped[snapped.length - 1]! < 2 * barSec) continue;
    snapped.push(Math.round(s * 1000) / 1000);
    if (snapped.length >= 4) break;
  }
  return { bpm: best.bpm, beatSec, barSec, bars: N, contentSec, tailSec: durationSec - contentSec, durationSec, introBars, outroBars, energy, accents: snapped };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface Ctx {
  cfg: MoodConfig;
  plan: MusicPlan;
  rng: Rng;
  n: number;
  chords: Chord[];
  finalChord: Chord;
  tonic: number;
}

/** Timeline seconds of a 16th step inside a bar (with swing). */
function t16(ctx: Ctx, bar: number, step: number): number {
  const { beatSec, barSec } = ctx.plan;
  const q = beatSec / 4;
  let t = bar * barSec + step * q;
  if (step % 2 === 1) t += (ctx.cfg.swing16 - 0.5) * 2 * q;
  if (step % 4 === 2) t += (ctx.cfg.swing8 - 0.5) * beatSec;
  return t;
}
const smp = (t: number) => Math.max(0, Math.round(t * SR));

function inGap(ctx: Ctx, t: number): boolean {
  const g = ctx.plan.beatSec / 2;
  return ctx.plan.accents.some((a) => t >= a - g && t < a - 0.002);
}

/** Bars where the energy rises (fills + risers lead into them). */
function rises(ctx: Ctx): number[] {
  const e = ctx.plan.energy;
  const out: number[] = [];
  for (let b = 1; b < e.length; b++) if (e[b]! > e[b - 1]! && e[b]! >= 2) out.push(b);
  return out;
}

function humanize(rng: Rng, ms: number): number {
  return (rng.gauss() * ms) / 1000;
}

function drums(ctx: Ctx, kit: Stereo, perc: Stereo): number[] {
  const style = ctx.cfg.drums!;
  const rng = ctx.rng.fork("drums");
  const kicks: number[] = [];
  const E = ctx.plan.energy;
  const fills = new Set(rises(ctx).map((b) => b - 1));
  const seed = () => I.seedFrom(rng.next());
  const vel = (v: number) => v * (1 + rng.gauss() * 0.06);
  // Kit balance (the drum stem is normalised as a whole): a lean kick and present hats/shakers
  // keep the mix from getting boomy on laptops and muffled on phones.
  const KICK = 0.72;
  const HAT = 1.7;
  const SHAKE = 1.5;
  const SNARE = 1.15;
  const K = (t: number, v: number, tone?: I.KickTone) => {
    if (inGap(ctx, t)) return;
    const at = smp(t);
    if (at >= ctx.n) return;
    I.kick(kit, at, { vel: v * KICK, tone, seed: seed() });
    kicks.push(at);
  };
  const H = (t: number, v: number, open = false, dark = false) => !inGap(ctx, t) && I.hat(kit, smp(t + humanize(rng, 3)), { vel: vel(v * HAT), open, seed: seed(), dark, pan: 0.18 });
  const S = (t: number, v: number) => !inGap(ctx, t) && I.shaker(kit, smp(t + humanize(rng, 4)), { vel: vel(v * SHAKE), seed: seed(), pan: -0.28 });
  const C = (t: number, v: number) => !inGap(ctx, t) && I.clap(perc, smp(t + humanize(rng, 2)), { vel: vel(v * SNARE), seed: seed(), pan: 0.04 });
  const SN = (t: number, v: number, lofi = false) => !inGap(ctx, t) && I.snare(perc, smp(t + humanize(rng, 2)), { vel: vel(v * SNARE), seed: seed(), lofi });
  const R = (t: number, v: number) => !inGap(ctx, t) && I.rim(kit, smp(t + humanize(rng, 2)), { vel: vel(v), seed: seed(), pan: 0.12 });
  const T = (t: number, v: number, hz: number, pan = 0) => !inGap(ctx, t) && I.tom(perc, smp(t + humanize(rng, 2)), { vel: vel(v), hz, seed: seed(), pan });
  const at = (b: number, s: number) => t16(ctx, b, s);

  for (let b = 0; b < ctx.plan.bars; b++) {
    const e = E[b]!;
    const fill = fills.has(b);
    switch (style) {
      case "pop":
        if (e >= 2) {
          for (const s of e === 3 ? [0, 4, 8, 12] : [0, 8]) K(at(b, s), 1, "punch");
          if (e === 2 && rng.chance(0.4)) K(at(b, 10), 0.7, "punch");
          for (const s of [4, 12]) C(at(b, s), e === 3 ? 0.75 : 0.55);
          for (let s = 0; s < 16; s += 2) if (e === 3 || s % 4 === 2) H(at(b, s), s % 4 === 2 ? 0.34 : 0.2, e === 3 && s === 14 && b % 2 === 1);
          for (let s = 0; s < 16; s++) S(at(b, s), s % 4 === 2 ? 0.26 : 0.13);
        } else if (e === 1) {
          for (let s = 2; s < 16; s += 4) H(at(b, s), 0.24);
          K(at(b, 0), 0.55, "soft");
        }
        if (fill) for (const [k, s] of [12, 13, 14, 15].entries()) C(at(b, s), 0.3 + k * 0.12);
        break;
      case "tech":
        if (e >= 1) for (const s of e === 1 ? [0] : [0, 4, 8, 12]) K(at(b, s), e === 1 ? 0.65 : 1, "punch");
        if (e >= 2) {
          for (let s = 0; s < 16; s++) {
            if (e === 2 && s % 4 !== 2) continue;
            if (s % 4 === 2) H(at(b, s), e === 3 ? 0.3 : 0.32, e === 3, true);
            else H(at(b, s), s % 2 === 0 ? 0.2 : 0.13);
          }
          R(at(b, 14), 0.3);
          if (e === 3) for (const s of [4, 12]) C(at(b, s), 0.65);
        } else if (e === 1) for (let s = 2; s < 16; s += 4) H(at(b, s), 0.22, false, true);
        if (fill) for (const [k, s] of [8, 10, 12, 13, 14, 15].entries()) R(at(b, s), 0.2 + k * 0.08);
        break;
      case "soft":
        if (e >= 2) {
          K(at(b, 0), 0.85, "soft");
          if (rng.chance(0.55)) K(at(b, 6), 0.55, "soft");
          K(at(b, 8), 0.75, "soft");
          for (const s of [4, 12]) (e === 3 ? SN : R)(at(b, s), e === 3 ? 0.42 : 0.45);
          for (let s = 0; s < 16; s += 2) S(at(b, s), s % 4 === 2 ? 0.24 : 0.14);
          if (e === 3) for (let s = 1; s < 16; s += 2) H(at(b, s), 0.1, false, true);
        } else if (e === 1) for (let s = 0; s < 16; s += 2) S(at(b, s), s % 4 === 2 ? 0.18 : 0.1);
        if (fill) for (const [k, s] of [13, 14, 15].entries()) R(at(b, s), 0.22 + k * 0.1);
        break;
      case "boombap":
        if (e >= 2) {
          K(at(b, 0), 0.95, "soft");
          if (rng.chance(0.6)) K(at(b, 7), 0.6, "soft");
          if (e === 3 || rng.chance(0.5)) K(at(b, 10), 0.75, "soft");
          for (const s of [4, 12]) SN(at(b, s), 0.62, true);
          for (let s = 0; s < 16; s += 2) H(at(b, s), s % 4 === 0 ? 0.28 : 0.2, false, true);
          if (rng.chance(0.3)) H(at(b, 15), 0.12, false, true);
        } else if (e === 1) {
          for (let s = 0; s < 16; s += 2) H(at(b, s), s % 4 === 0 ? 0.22 : 0.15, false, true);
          R(at(b, 12), 0.3);
        }
        if (fill) SN(at(b, 15), 0.35, true);
        break;
      case "cinematic":
        if (e === 1 && b % 2 === 0) K(at(b, 0), 0.7, "deep");
        if (e === 2) {
          K(at(b, 0), 0.9, "deep");
          for (const [s, hz] of [[0, 72], [6, 86], [10, 72]] as const) T(at(b, s), 0.45, hz, s === 6 ? 0.25 : -0.2);
        }
        if (e === 3) {
          for (const s of [0, 8]) K(at(b, s), 1, "deep");
          for (const [s, hz] of [[0, 72], [3, 96], [6, 86], [8, 72], [11, 110], [14, 96]] as const) T(at(b, s), 0.55, hz, hz > 90 ? 0.3 : -0.25);
          C(at(b, 8), 0.7);
          SN(at(b, 8), 0.5);
        }
        if (fill) for (let s = 8; s < 16; s++) T(at(b, s), 0.25 + (s - 8) * 0.07, s % 2 ? 96 : 110, s % 2 ? 0.3 : -0.3);
        break;
    }
  }
  // Ending: one hit on the final chord.
  const end = ctx.plan.contentSec;
  if (style === "cinematic") K(end, 1, "deep");
  else if (style !== "boombap") K(end, style === "soft" ? 0.8 : 0.9, style === "soft" ? "soft" : "punch");
  else K(end, 0.8, "soft");
  return kicks;
}

function bassLine(ctx: Ctx, bus: Stereo): void {
  const { style, pattern } = ctx.cfg.bass!;
  const rng = ctx.rng.fork("bass");
  const q = ctx.plan.beatSec / 4;
  const N = (t: number, steps: number, midi: number, v: number, st: I.BassStyle = style) => {
    const a = smp(t);
    if (a < ctx.n) I.bass(bus, a, Math.max(0.05, steps * q * 0.88), midi, { vel: v * (1 + rng.gauss() * 0.04), style: st, seed: I.seedFrom(rng.next()) });
  };
  const span = ctx.cfg.chordBars;
  for (let b = 0; b < ctx.plan.bars; b++) {
    const e = ctx.plan.energy[b]!;
    if (e === 0) continue;
    const ch = ctx.chords[b]!;
    const root = bassRoot(ch);
    const next = ctx.chords[b + 1] ?? ctx.finalChord;
    const at = (s: number) => t16(ctx, b, s);
    if (e === 1 && pattern !== "sustain") {
      N(at(0), 15, root, 0.75, style === "pulse" ? "round" : style === "ostinato" ? "sub" : style);
      continue;
    }
    switch (pattern) {
      case "tresillo":
        N(at(0), 6, root, 0.95);
        N(at(6), 6, root, 0.8);
        N(at(12), 4, rng.chance(0.35) ? root + 12 : root, 0.75);
        break;
      case "pulse16":
        for (let s = 0; s < 16; s += e === 3 ? 1 : 2) N(at(s), e === 3 ? 0.9 : 1.7, s === 3 || s === 11 ? root + 12 : root, s % 4 === 0 ? 0.95 : 0.7);
        break;
      case "walk": {
        N(at(0), 6, root, 0.95);
        N(at(6), 2, root, 0.6);
        N(at(8), 5, root + 7 <= 50 ? root + 7 : root - 5, 0.8);
        const nr = bassRoot(next);
        if (rng.chance(0.5) && nr !== root) N(at(14), 2, nr + (nr > root ? -1 : 1), 0.6);
        else N(at(14), 2, root + 12, 0.45);
        break;
      }
      case "boombap":
        N(at(0), 5, root, 0.95);
        if (rng.chance(0.7)) N(at(7), 2, root, 0.6);
        N(at(10), 4, rng.chance(0.5) ? root + 7 : root + 12, 0.7);
        break;
      case "sustain":
        if ((b - ctx.plan.introBars) % span === 0 || b === 0) N(at(0), 16 * span - 1, root, 0.85);
        break;
      case "ostinato8": {
        const pat = [0, 0, 12, 0, 0, 0, 12, 7];
        for (let s = 0; s < 8; s++) N(at(s * 2), 1.6, root + pat[s]!, s === 0 ? 0.95 : 0.7);
        if (e === 3) N(at(0), 15, root - 12 >= 28 ? root - 12 : root, 0.4, "sub");
        break;
      }
    }
  }
  // Final root under the last chord.
  N(ctx.plan.contentSec, Math.min(ctx.plan.tailSec * 0.8, 2.5) / q, bassRoot(ctx.finalChord), 0.8, style === "pulse" || style === "ostinato" ? "round" : style);
}

/** Chord spans (start bar, bars, chord) — consecutive bars with the same chord merge. */
function spans(ctx: Ctx): { bar: number; bars: number; chord: Chord }[] {
  const out: { bar: number; bars: number; chord: Chord }[] = [];
  for (let b = 0; b < ctx.plan.bars; b++) {
    const c = ctx.chords[b]!;
    const last = out[out.length - 1];
    if (last && last.chord === c) last.bars++;
    else out.push({ bar: b, bars: 1, chord: c });
  }
  return out;
}

function padPart(ctx: Ctx, bus: Stereo): void {
  const p = ctx.cfg.pad!;
  const rng = ctx.rng.fork("pad");
  let prev: number[] | null = null;
  const { barSec } = ctx.plan;
  for (const s of spans(ctx)) {
    const v = voiceChord(s.chord, prev, { voices: p.voices, lo: p.lo, hi: p.hi });
    prev = v;
    const e = ctx.plan.energy[s.bar]!;
    for (const m of v) padNoteAt(bus, s.bar * barSec, s.bars * barSec, m, p.vel[e]! / Math.sqrt(p.voices / 4), p, rng);
  }
  const fv = voiceChord(ctx.finalChord, prev, { voices: p.voices, lo: p.lo, hi: p.hi });
  for (const m of fv) padNoteAt(bus, ctx.plan.contentSec, Math.max(0.3, ctx.plan.tailSec - p.release), m, p.vel[2]! / Math.sqrt(p.voices / 4), p, rng);
  // Section-driven low-pass: closed in the intro, opening as the energy rises.
  filterSweep(ctx, bus, p.cutoff);
}

function padNoteAt(bus: Stereo, t: number, len: number, midi: number, vel: number, p: NonNullable<MoodConfig["pad"]>, rng: Rng): void {
  const at = smp(t);
  if (at >= bus.length) return;
  I.padNote(bus, at, len, midi, { vel, attack: p.attack, release: p.release, detuneCents: p.detune * rng.range(0.85, 1.15), triMix: p.tri, seed: I.seedFrom(rng.next()) });
}

function filterSweep(ctx: Ctx, bus: Stereo, cutoff: [number, number, number, number]): void {
  const { barSec } = ctx.plan;
  const fl = new Svf(cutoff[0], 0.6);
  const fr = new Svf(cutoff[0], 0.6);
  let cur = cutoff[ctx.plan.energy[0] ?? 0]!;
  const k = 1 - Math.exp(-32 / (barSec * 0.6 * SR));
  for (let i = 0; i < bus.length; i += 32) {
    const bar = Math.min(ctx.plan.bars - 1, Math.floor(i / SR / barSec));
    const target = i / SR >= ctx.plan.contentSec ? cutoff[2] : cutoff[ctx.plan.energy[bar]!]!;
    cur += (target - cur) * k;
    fl.set(cur, 0.6);
    fr.set(cur, 0.6);
    const end = Math.min(bus.length, i + 32);
    for (let j = i; j < end; j++) {
      bus.L[j] = fl.tick(bus.L[j]!);
      bus.R[j] = fr.tick(bus.R[j]!);
    }
  }
}

function keysPart(ctx: Ctx, bus: Stereo): void {
  const k = ctx.cfg.keys!;
  const rng = ctx.rng.fork("keys");
  let prev: number[] | null = null;
  const q = ctx.plan.beatSec / 4;
  const strike = (t: number, steps: number, chord: number[], v: number) => {
    const roll = k.style === "lofi" ? 0.02 : 0.011;
    chord.forEach((m, i) => {
      const at = smp(t + i * roll * rng.range(0.6, 1.3) + humanize(rng, 4));
      if (at < ctx.n) I.epiano(bus, at, steps * q, m, { vel: v * rng.range(0.85, 1.05), pan: (i / Math.max(1, chord.length - 1) - 0.5) * 0.5, bright: k.bright, seed: I.seedFrom(rng.next()) });
    });
  };
  for (let b = 0; b < ctx.plan.bars; b++) {
    const e = ctx.plan.energy[b]!;
    const v = voiceChord(ctx.chords[b]!, prev, { voices: 4, lo: 52, hi: 75 });
    prev = v;
    const at = (s: number) => t16(ctx, b, s);
    if (k.style === "warm") {
      if (e <= 1) strike(at(0), 15, v, 0.55);
      else {
        strike(at(0), 7, v, 0.68);
        strike(at(7), 3, v.slice(1), 0.45);
        strike(at(10), 6, v, 0.58);
      }
    } else {
      strike(at(0), e <= 1 ? 15 : 11, v, 0.62);
      if (e >= 2 && rng.chance(0.55)) strike(at(rng.chance(0.5) ? 10 : 14), 4, v.slice(1), 0.42);
    }
  }
  const fv = voiceChord(ctx.finalChord, prev, { voices: 4, lo: 52, hi: 75 });
  strike(ctx.plan.contentSec, Math.min(ctx.plan.tailSec, 3) / q, fv, 0.6);
  // Rhodes-style tremolo auto-pan + chorus for width.
  const rate = (TAU * 4.2) / SR;
  for (let i = 0; i < bus.length; i++) {
    const m = fsin(rate * i) * 0.22;
    bus.L[i]! *= 1 + m;
    bus.R[i]! *= 1 - m;
  }
  chorus(bus, { rate: 0.45, depthMs: 2.2, baseMs: 9, mix: 0.35 });
}

function leadPart(ctx: Ctx, bus: Stereo): void {
  const l = ctx.cfg.lead!;
  const rng = ctx.rng.fork("lead");
  const E = ctx.plan.energy;
  const q = ctx.plan.beatSec / 4;
  const seed = () => I.seedFrom(rng.next());
  switch (l.style) {
    case "pluck-motif": {
      const rhythms = [
        [0, 3, 6, 10, 13],
        [0, 3, 6, 8, 11, 14],
        [0, 2, 5, 8, 10, 13],
        [2, 5, 8, 11, 14],
      ];
      const rhythm = rng.pick(rhythms);
      const contour: number[] = [];
      let idx = rng.int(2, 4);
      for (let i = 0; i < rhythm.length; i++) {
        contour.push(idx);
        idx = clamp(idx + rng.pick([-2, -1, -1, 1, 1, 2]), 0, 6);
      }
      for (let b = 0; b < ctx.plan.bars; b++) {
        const e = E[b]!;
        if (e < 2) continue;
        const tones = chordTones(ctx.chords[b]!, l.lo, 2);
        const answer = b % 2 === 1;
        rhythm.forEach((s, i) => {
          if (e === 2 && i % 2 === 1 && !answer) return;
          const ci = clamp(contour[i]! + (answer && i >= rhythm.length - 2 ? 1 : 0), 0, tones.length - 1);
          const t = t16(ctx, b, s) + humanize(rng, 3);
          if (smp(t) < ctx.n) I.pluck(bus, smp(t), tones[ci]!, { vel: (e === 3 ? 0.8 : 0.62) * (s % 4 === 0 ? 1 : 0.85) * rng.range(0.9, 1.05), decay: 0.3, bright: 0.8, pan: i % 2 ? 0.18 : -0.18, seed: seed() });
        });
      }
      const top = chordTones(ctx.finalChord, l.lo + 5, 1);
      if (top.length) I.pluck(bus, smp(ctx.plan.contentSec), top[top.length - 1]!, { vel: 0.6, decay: 0.6, bright: 0.45, seed: seed() });
      break;
    }
    case "bell-arp": {
      const order = rng.pick([
        [0, 1, 2, 3, 2, 1],
        [0, 2, 1, 3],
        [0, 1, 2, 3, 4, 3, 2, 1],
      ]);
      for (let b = 0; b < ctx.plan.bars; b++) {
        const e = E[b]!;
        if (e < 2) continue;
        const tones = chordTones(ctx.chords[b]!, l.lo, 2).slice(0, 6);
        const stepInc = e === 3 ? 1 : 2;
        for (let s = 0, k = 0; s < 16; s += stepInc, k++) {
          const m = tones[order[k % order.length]! % tones.length]!;
          const t = t16(ctx, b, s);
          if (smp(t) < ctx.n) I.bell(bus, smp(t), m, { vel: (s % 4 === 0 ? 0.6 : 0.42) * rng.range(0.9, 1.05), decay: 0.32, pan: (k % 2 ? 0.25 : -0.25), ratio: 2 });
        }
      }
      break;
    }
    case "sparkle": {
      let last = -1;
      for (let b = 0; b < ctx.plan.bars; b++) {
        const e = E[b]!;
        const p = [0.12, 0.25, 0.38, 0.5][e]!;
        const tones = chordTones(ctx.chords[b]!, l.lo, 2);
        for (let beat = 0; beat < 4; beat++) {
          if (!rng.chance(p)) continue;
          let m = rng.pick(tones);
          if (m === last) m = rng.pick(tones);
          last = m;
          const t = t16(ctx, b, beat * 4 + (rng.chance(0.3) ? 2 : 0));
          if (smp(t) < ctx.n) I.bell(bus, smp(t), m, { vel: rng.range(0.28, 0.48), decay: 1.5, pan: rng.range(-0.5, 0.5), ratio: 2 });
        }
      }
      const top = chordTones(ctx.finalChord, l.lo, 1);
      if (top.length) I.bell(bus, smp(ctx.plan.contentSec + 0.05), top[Math.floor(top.length / 2)]!, { vel: 0.4, decay: 2, ratio: 2 });
      break;
    }
    case "bell-motif": {
      const rhythm = rng.pick([
        [0, 6, 10],
        [2, 6, 12],
        [0, 3, 8, 14],
      ]);
      const contour = rhythm.map(() => rng.int(1, 4));
      for (let b = 0; b < ctx.plan.bars; b++) {
        if (E[b]! < 3 || b % 2 === 1) continue;
        const tones = chordTones(ctx.chords[b]!, l.lo, 2);
        rhythm.forEach((s, i) => {
          const t = t16(ctx, b, s) + humanize(rng, 5);
          if (smp(t) < ctx.n) I.bell(bus, smp(t), tones[clamp(contour[i]!, 0, tones.length - 1)]!, { vel: rng.range(0.35, 0.5), decay: 0.9, pan: rng.range(-0.3, 0.3), ratio: 2 });
        });
      }
      break;
    }
    case "ostinato": {
      const pat = [0, 1, 2, 1, 0, 1, 2, 3];
      for (let b = 0; b < ctx.plan.bars; b++) {
        const e = E[b]!;
        if (e < 2) continue;
        const tones = chordTones(ctx.chords[b]!, l.lo, 2);
        for (let s = 0; s < 8; s++) {
          if (e === 2 && s % 2 === 1) continue;
          const t = t16(ctx, b, s * 2);
          const m = tones[pat[s]! % tones.length]!;
          if (smp(t) < ctx.n) {
            I.pluck(bus, smp(t), m, { vel: (e === 3 ? 0.7 : 0.55) * (s === 0 ? 1 : 0.85), decay: 0.24, bright: 0.6, pan: s % 2 ? 0.2 : -0.2, seed: seed() });
            if (e === 3 && s % 2 === 0) I.bell(bus, smp(t), m + 12, { vel: 0.22, decay: 0.5, pan: s % 4 ? 0.35 : -0.35 });
          }
        }
      }
      break;
    }
  }
  void q;
}

function fxPart(ctx: Ctx, bus: Stereo): number[] {
  const rng = ctx.rng.fork("fx");
  const hits: number[] = [];
  const beat = ctx.plan.beatSec;
  const big = ctx.cfg.drums === "cinematic";
  const riserLen = Math.min(1.6, 2 * beat);
  for (const b of rises(ctx)) {
    const t = b * ctx.plan.barSec;
    if (ctx.plan.accents.some((a) => Math.abs(a - t) < beat)) continue;
    I.riser(bus, smp(t), riserLen, { vel: big ? 0.5 : 0.3, seed: I.seedFrom(rng.next()), tone: 180 });
    if (big) {
      I.impact(bus, smp(t), { vel: 0.7, seed: I.seedFrom(rng.next()) });
      hits.push(smp(t));
    }
  }
  for (const a of ctx.plan.accents) {
    I.riser(bus, smp(a), riserLen, { vel: big ? 0.5 : 0.36, seed: I.seedFrom(rng.next()), tone: 200 });
    I.impact(bus, smp(a), { vel: big ? 0.75 : 0.5, seed: I.seedFrom(rng.next()) });
    hits.push(smp(a));
  }
  if (big) I.impact(bus, smp(ctx.plan.contentSec), { vel: 0.85, seed: I.seedFrom(rng.next()) });
  return hits;
}

/** Wow: slow pitch drift (tape/vinyl), as a modulated delay. In place. */
function wow(buf: Stereo, rate: number, depthMs: number): void {
  const depth = (depthMs / 1000) * SR;
  const len = Math.ceil(depth * 2) + 8;
  const dl = new Float32Array(len);
  const dr = new Float32Array(len);
  let w = 0;
  for (let i = 0; i < buf.length; i++) {
    dl[w] = buf.L[i]!;
    dr[w] = buf.R[i]!;
    const d = depth * (1 + fsin((TAU * rate * i) / SR) * 0.8 + fsin((TAU * rate * 2.7 * i) / SR) * 0.2) + 2;
    let rp = w - d;
    while (rp < 0) rp += len;
    const i0 = Math.floor(rp);
    const f = rp - i0;
    buf.L[i] = dl[i0 % len]! * (1 - f) + dl[(i0 + 1) % len]! * f;
    buf.R[i] = dr[i0 % len]! * (1 - f) + dr[(i0 + 1) % len]! * f;
    w = (w + 1) % len;
  }
}

export interface MusicRender {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  plan: MusicPlan;
  key: string;
  progression: string[];
  master: MasterReport;
  renderMs: number;
}

const NOTE = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/** Render original music. Pure CPU, deterministic for (mood, durationSec, seed, accents). */
export function renderMusic(params: { mood: MusicMood; durationSec: number; seed: string; accents?: number[] }): MusicRender {
  const t0 = Date.now();
  const cfg = MOODS[params.mood];
  const rng = new Rng(`${params.mood}|${params.seed}`);
  const plan = planArrangement(params.mood, params.durationSec, rng.fork("plan"), params.accents ?? []);
  const n = Math.round(params.durationSec * SR);
  const tonic = rng.pick(cfg.tonics);
  const prog = rng.pick(cfg.progressions);
  const specs = prog.map(([root, quality]) => chordOf(tonic, { root, quality }));
  const span = cfg.chordBars;
  const K = specs.length;
  // Intro bars play the end of the progression so the body starts on its first chord.
  const chords: Chord[] = [];
  for (let b = 0; b < plan.bars; b++) {
    const rel = b - plan.introBars;
    const idx = rel >= 0 ? Math.floor(rel / span) % K : (((K * 8 + Math.floor(rel / span)) % K) + K) % K;
    chords.push(specs[idx]!);
  }
  const finalChord = chordOf(tonic, { root: cfg.final[0], quality: cfg.final[1] });
  const ctx: Ctx = { cfg, plan, rng, n, chords, finalChord, tonic };

  const out = new Stereo(n);
  const verb = new Float32Array(n);
  const dly = new Float32Array(n);
  // One reusable stem buffer keeps peak memory (and GC) low: stems are rendered, balanced and
  // mixed one after another.
  const stem = new Stereo(n);
  const clear = () => {
    stem.L.fill(0);
    stem.R.fill(0);
    return stem;
  };
  const ref = (lu: number) => MIX_REF + lu;
  /** Bring a stem to its target loudness, feed the sends, then mix it in (with optional pump). */
  const add = (bus: Stereo, lu: number | undefined, pump: Float32Array | null, amt: number, sends: { verb?: number; delay?: number } = {}) => {
    if (lu === undefined) return;
    const l = integratedLoudness(bus);
    if (!Number.isFinite(l)) return;
    const g = dbToGain(ref(lu) - l);
    const sv = (sends.verb ?? 0) * 0.5 * g;
    const sd = (sends.delay ?? 0) * 0.5 * g;
    const usePump = pump !== null && amt > 0;
    const { L, R } = bus;
    for (let i = 0; i < n; i++) {
      const l2 = L[i]!;
      const r2 = R[i]!;
      if (sv) verb[i]! += (l2 + r2) * sv;
      if (sd) dly[i]! += (l2 + r2) * sd;
      const k = usePump ? g * (1 - amt * (1 - pump![i]!)) : g;
      out.L[i]! += l2 * k;
      out.R[i]! += r2 * k;
    }
  };

  let pump: Float32Array | null = null;
  if (cfg.drums) {
    const kit = clear();
    const perc = new Stereo(n);
    const kicks = drums(ctx, kit, perc);
    eq(kit, [["highpass", 30], ["peak", 3500, 1, -1.5]]);
    // Kit and percussion are balanced together (one "drums" stem); percussion also feeds the reverb.
    kit.mixFrom(perc, 0.9);
    const lb = integratedLoudness(kit);
    const g = Number.isFinite(lb) ? dbToGain(ref(cfg.levels.drums!) - lb) : 1;
    const sv = cfg.reverb.sends.perc * 0.9 * 0.5 * g;
    for (let i = 0; i < n; i++) {
      verb[i]! += (perc.L[i]! + perc.R[i]!) * sv;
      out.L[i]! += kit.L[i]! * g;
      out.R[i]! += kit.R[i]! * g;
    }
    if (cfg.sidechain.depth > 0) pump = duckCurve(n, kicks, cfg.sidechain.depth, cfg.sidechain.releaseBeats * plan.beatSec);
  }
  {
    const fx = clear();
    const hits = fxPart(ctx, fx);
    if (pump && hits.length) {
      const extra = duckCurve(n, hits, 0.5, 0.9);
      for (let i = 0; i < n; i++) if (extra[i]! < pump[i]!) pump[i] = extra[i]!;
    }
    add(fx, cfg.levels.fx, null, 0, { verb: cfg.reverb.sends.fx });
  }
  if (cfg.bass) {
    const bus = clear();
    bassLine(ctx, bus);
    eq(bus, [["highpass", 40], ["lowpass", 2400]]);
    add(bus, cfg.levels.bass, pump, cfg.sidechain.bass);
  }
  if (cfg.pad && cfg.levels.pad !== undefined) {
    const bus = clear();
    padPart(ctx, bus);
    eq(bus, [["highpass", 140], ["peak", 350, 0.8, -2]]);
    chorus(bus, { rate: 0.25, depthMs: 3, baseMs: 14, mix: 0.3 });
    width(bus, 1.25);
    add(bus, cfg.levels.pad, pump, cfg.sidechain.pad, { verb: cfg.reverb.sends.pad });
  }
  if (cfg.keys) {
    const bus = clear();
    keysPart(ctx, bus);
    if (cfg.lofi) {
      wow(bus, 0.45, 0.35);
      eq(bus, [["highpass", 90], ["lowpass", 6500], ["peak", 280, 0.9, -1.5]]);
    } else eq(bus, [["highpass", 80], ["peak", 300, 0.9, -2]]);
    add(bus, cfg.levels.keys, pump, cfg.sidechain.keys, { verb: cfg.reverb.sends.keys });
  }
  if (cfg.lead) {
    const bus = clear();
    leadPart(ctx, bus);
    eq(bus, [["highpass", 220], ["peak", 450, 0.9, -1.5]]);
    add(bus, cfg.levels.lead, pump, cfg.sidechain.lead, { verb: cfg.reverb.sends.lead, delay: cfg.delay?.send ?? 0 });
  }
  // Delay return (ping-pong, darkened feedback), then the plate (fed by the dry sends + delay).
  if (cfg.delay && cfg.levels.delay !== undefined) {
    const d = clear();
    pingPong(dly, d, { timeSec: cfg.delay.beats * plan.beatSec, feedback: cfg.delay.feedback, wet: 1, lowCut: 300, highCut: 4200 });
    add(d, cfg.levels.delay, pump, 0.5, { verb: 0.3 });
  }
  {
    const r = clear();
    Biquad.make("highpass", 300, 0.6).run(verb);
    new Plate({ decay: cfg.reverb.decay, damping: cfg.reverb.damping, predelayMs: cfg.reverb.predelayMs, size: cfg.reverb.size, bandwidth: 0.6 }).process(verb, r.L, r.R);
    add(r, cfg.levels.reverb, pump, 0.4);
  }

  // Master tone.
  eq(out, [["highpass", 28], ["peak", 2800, 0.7, cfg.tone.presenceDb], ["highshelf", 9000, 0.7, cfg.tone.shelfDb], ["lowpass", cfg.tone.lowpass, 0.6]]);
  if (cfg.tone.width !== 1) width(out, cfg.tone.width);
  if (cfg.lofi) I.vinyl(out, 0, n, { level: 0.012, seed: I.seedFrom(rng.fork("vinyl").next()) });
  const report = master(out, { targetLufs: MUSIC_TARGET_LUFS, ceilingDb: MUSIC_CEILING_DB, fadeInSec: plan.introBars ? 0.04 : 0.02, fadeOutSec: Math.min(Math.max(0.6, plan.tailSec * 0.9), 2.4) });
  return {
    left: out.L,
    right: out.R,
    sampleRate: SR,
    plan,
    key: `${NOTE[tonic]} ${cfg.minor ? "minor" : "major"}`,
    progression: prog.map(([r, q]) => `${NOTE[(tonic + r) % 12]}${q}`),
    master: report,
    renderMs: Date.now() - t0,
  };
}
