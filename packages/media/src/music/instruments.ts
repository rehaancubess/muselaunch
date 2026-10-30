/**
 * Synthesized instruments. Each function renders one note/hit into a stereo bus at a sample
 * offset. Sound design goals: soft attacks, rounded highs, harmonics that survive phone speakers,
 * nothing piercing. All synthesis is our own (sine/FM/subtractive/noise); no samples.
 */
import { blep, clamp, fsin, mtof, panGains, softClip, SR, Svf, TAU, type Stereo } from "./dsp";

/** xorshift32 white noise in [-1, 1). */
export class Noise {
  private s: number;
  constructor(seed: number) {
    this.s = seed | 0 || 0x2545f491;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x;
    return (x >>> 0) / 2147483648 - 1;
  }
}

const seedFrom = (n: number) => Math.floor(n * 4294967295) | 0;

/** Linear fade over the last 10 ms of a voice, so no note ever stops on a click. */
const TAIL = 480;
const tail = (k: number, len: number) => (k >= len - TAIL ? Math.max(0, (len - k) / TAIL) : 1);

function write(bus: Stereo, i: number, v: number, gl: number, gr: number): void {
  bus.L[i] += v * gl;
  bus.R[i] += v * gr;
}

// ---------------------------------------------------------------------------
// Drums
// ---------------------------------------------------------------------------

export type KickTone = "punch" | "soft" | "deep";

export function kick(bus: Stereo, at: number, o: { vel: number; tone?: KickTone; seed: number }): void {
  const tone = o.tone ?? "punch";
  const p = tone === "deep" ? { base: 41, sweep: 95, st: 0.05, dec: 0.5, click: 0.12, drive: 1.5 } : tone === "soft" ? { base: 50, sweep: 70, st: 0.04, dec: 0.2, click: 0, drive: 1.2 } : { base: 52, sweep: 118, st: 0.03, dec: 0.21, click: 0.2, drive: 1.9 };
  const len = Math.min(bus.length - at, Math.round((p.dec * 5 + 0.02) * SR));
  const nz = new Noise(o.seed);
  const kSt = Math.exp(-1 / (p.st * SR));
  const kFast = Math.exp(-1 / (0.004 * SR));
  const kDec = Math.exp(-1 / (p.dec * SR));
  const kClick = Math.exp(-1 / (0.0012 * SR));
  const norm = o.vel / softClip(p.drive);
  const attN = 0.0015 * SR;
  let eSt = 1;
  let eFast = 1;
  let eDec = 1;
  let eClick = 1;
  let ph = 0;
  let prevN = 0;
  for (let k = 0; k < len; k++) {
    eSt *= kSt;
    eFast *= kFast;
    eDec *= kDec;
    ph += (p.base + p.sweep * eSt + 30 * eFast) / SR;
    let v = softClip(fsin(TAU * ph) * p.drive) * norm * eDec * (k < attN ? k / attN : 1);
    if (p.click && k < 480) {
      eClick *= kClick;
      const n = nz.next();
      v += (n - prevN) * 0.5 * p.click * eClick * o.vel;
      prevN = n;
    }
    v *= tail(k, len);
    bus.L[at + k] += v;
    bus.R[at + k] += v;
  }
}

export function snare(bus: Stereo, at: number, o: { vel: number; lofi?: boolean; seed: number; pan?: number }): void {
  const len = Math.min(bus.length - at, Math.round(0.4 * SR));
  const nz = new Noise(o.seed);
  const bp = new Svf(o.lofi ? 2400 : 3200, 0.7);
  const lp = new Svf(o.lofi ? 4200 : 9000, 0.6);
  const [gl, gr] = panGains(o.pan ?? 0);
  const nd = o.lofi ? 0.075 : 0.11;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    const body = fsin(TAU * 185 * t) * Math.exp(-t / 0.045) * 0.55 + fsin(TAU * 332 * t) * Math.exp(-t / 0.028) * 0.25;
    bp.tick(nz.next());
    const noise = (bp.bp * 0.9 + bp.hp * 0.35) * Math.exp(-t / nd) * 0.9;
    const v = lp.tick(body + noise) * Math.min(1, t / 0.0008) * o.vel;
    write(bus, at + k, v * tail(k, len), gl, gr);
  }
}

export function clap(bus: Stereo, at: number, o: { vel: number; seed: number; pan?: number }): void {
  const len = Math.min(bus.length - at, Math.round(0.45 * SR));
  const nz = new Noise(o.seed);
  const bp = new Svf(1350, 1.1);
  const hp = new Svf(700, 0.7);
  const [gl, gr] = panGains(o.pan ?? 0);
  const bursts = [0, 0.0095, 0.019];
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    let env = 0;
    for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / 0.0035));
    if (t >= 0.026) env = Math.max(env, 0.75 * Math.exp(-(t - 0.026) / 0.11));
    bp.tick(nz.next());
    hp.tick(bp.bp);
    const v = hp.hp * env * 1.6 * o.vel;
    write(bus, at + k, v * tail(k, len), gl, gr);
  }
}

export function hat(bus: Stereo, at: number, o: { vel: number; open?: boolean; seed: number; pan?: number; dark?: boolean }): void {
  const dec = o.open ? 0.21 : 0.032;
  const len = Math.min(bus.length - at, Math.round((dec * 6 + 0.01) * SR));
  const nz = new Noise(o.seed);
  const hp = new Svf(o.dark ? 6000 : 7600, 0.7);
  const lp = new Svf(o.dark ? 9500 : 13500, 0.6);
  const [gl, gr] = panGains(o.pan ?? 0.15);
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    hp.tick(nz.next());
    const v = lp.tick(hp.hp) * Math.exp(-t / dec) * Math.min(1, t / 0.0006) * o.vel;
    write(bus, at + k, v * tail(k, len), gl, gr);
  }
}

export function shaker(bus: Stereo, at: number, o: { vel: number; seed: number; pan?: number }): void {
  const len = Math.min(bus.length - at, Math.round(0.12 * SR));
  const nz = new Noise(o.seed);
  const bp = new Svf(6200, 1.4);
  const [gl, gr] = panGains(o.pan ?? -0.3);
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    bp.tick(nz.next());
    const env = t < 0.009 ? t / 0.009 : Math.exp(-(t - 0.009) / 0.035);
    write(bus, at + k, bp.bp * env * o.vel * tail(k, len), gl, gr);
  }
}

export function rim(bus: Stereo, at: number, o: { vel: number; seed: number; pan?: number }): void {
  const len = Math.min(bus.length - at, Math.round(0.09 * SR));
  const nz = new Noise(o.seed);
  const [gl, gr] = panGains(o.pan ?? 0.1);
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    const v = fsin(TAU * 1720 * t) * Math.exp(-t / 0.011) * 0.6 + fsin(TAU * 810 * t) * Math.exp(-t / 0.018) * 0.45 + nz.next() * Math.exp(-t / 0.003) * 0.25;
    write(bus, at + k, v * o.vel, gl, gr);
  }
}

export function tom(bus: Stereo, at: number, o: { vel: number; hz: number; seed: number; pan?: number }): void {
  const len = Math.min(bus.length - at, Math.round(1.2 * SR));
  const nz = new Noise(o.seed);
  const lp = new Svf(2200, 0.6);
  const [gl, gr] = panGains(o.pan ?? 0);
  let ph = 0;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    ph += (o.hz * (1 + 0.45 * Math.exp(-t / 0.045))) / SR;
    const v = fsin(TAU * ph) * Math.exp(-t / 0.3) + lp.tick(nz.next()) * Math.exp(-t / 0.025) * 0.35;
    write(bus, at + k, softClip(v * 1.3) * o.vel * Math.min(1, t / 0.001) * tail(k, len), gl, gr);
  }
}

// ---------------------------------------------------------------------------
// Tonal voices
// ---------------------------------------------------------------------------

/**
 * Pad voice: two detuned PolyBLEP saws (spread left/right) plus a triangle for body. The pad bus
 * is low-passed as a whole (automated per section), so the voice itself stays unfiltered.
 */
export function padNote(bus: Stereo, at: number, lenSec: number, midi: number, o: { vel: number; attack: number; release: number; detuneCents?: number; spread?: number; triMix?: number; seed: number }): void {
  const f = mtof(midi);
  const det = Math.pow(2, (o.detuneCents ?? 7) / 1200);
  const fa = f * det;
  const fb = f / det;
  const relN = o.release * SR;
  const total = Math.min(bus.length - at, Math.round(lenSec * SR + relN * 5));
  const holdN = Math.round(lenSec * SR);
  const attN = Math.max(1, Math.round(o.attack * SR));
  const spread = o.spread ?? 0.7;
  const [al, ar] = panGains(-spread);
  const [bl, br] = panGains(spread);
  const tri = o.triMix ?? 0.6;
  // random start phases (deterministic) avoid identical attacks across notes
  let pa = (o.seed & 1023) / 1024;
  let pb = ((o.seed >>> 10) & 1023) / 1024;
  let pt = ((o.seed >>> 20) & 1023) / 1024;
  const da = fa / SR;
  const db = fb / SR;
  const dt = f / SR;
  const relK = Math.exp(-1 / relN);
  let rel = 1;
  for (let k = 0; k < total; k++) {
    // raised-cosine attack × exponential release (smooth even when released mid-attack)
    const a = k < attN ? 0.5 - 0.5 * fsin((Math.PI * k) / attN + Math.PI / 2) : 1;
    if (k >= holdN) rel *= relK;
    const env = a * rel;
    if (rel < 1e-4) break;
    pa += da;
    if (pa >= 1) pa -= 1;
    pb += db;
    if (pb >= 1) pb -= 1;
    pt += dt;
    if (pt >= 1) pt -= 1;
    const sa = 2 * pa - 1 - blep(pa, da);
    const sb = 2 * pb - 1 - blep(pb, db);
    const tv = (pt < 0.5 ? 4 * pt - 1 : 3 - 4 * pt) * tri;
    const g = env * o.vel * 0.35;
    const i = at + k;
    bus.L[i] += (sa * al + sb * bl + tv * 0.7) * g;
    bus.R[i] += (sa * ar + sb * br + tv * 0.7) * g;
  }
}

/** Subtractive pluck: saw+square through a fast-closing low-pass. Bright, short, never harsh. */
export function pluck(bus: Stereo, at: number, midi: number, o: { vel: number; decay?: number; bright?: number; pan?: number; seed: number }): void {
  const f = mtof(midi);
  const decay = o.decay ?? 0.32;
  const len = Math.min(bus.length - at, Math.round((decay * 6 + 0.02) * SR));
  const bright = clamp(o.bright ?? 0.6, 0, 1);
  const peak = 1200 + 5200 * bright * (0.6 + 0.4 * o.vel);
  const base = Math.max(220, f * 1.2);
  const svf = new Svf(peak, 0.85);
  const [gl, gr] = panGains(o.pan ?? 0);
  const det = Math.pow(2, 4 / 1200);
  let p1 = (o.seed & 1023) / 1024;
  let p2 = ((o.seed >>> 10) & 1023) / 1024;
  const d1 = (f * det) / SR;
  const d2 = f / det / SR;
  const kF = Math.exp(-16 / (0.09 * SR));
  const kA = Math.exp(-1 / (decay * SR));
  let eF = 1;
  let eA = 1;
  for (let k = 0; k < len; k++) {
    if ((k & 15) === 0) {
      svf.set(base + (peak - base) * eF, 0.85);
      eF *= kF;
    }
    p1 += d1;
    if (p1 >= 1) p1 -= 1;
    p2 += d2;
    if (p2 >= 1) p2 -= 1;
    const saw = 2 * p1 - 1 - blep(p1, d1);
    let sq = p2 < 0.5 ? 1 : -1;
    sq += blep(p2, d2);
    sq -= blep((p2 + 0.5) % 1, d2);
    eA *= kA;
    const env = k < 96 ? (eA * k) / 96 : eA;
    const v = svf.tick(saw * 0.7 + sq * 0.3) * env * o.vel * 0.55;
    bus.L[at + k] += v * gl;
    bus.R[at + k] += v * gr;
  }
}

/**
 * Electric piano (FM, after the classic two-operator "tine" models): a 1:1 operator pair gives the
 * warm bark, a 1:14 pair the short bell-like tine on the attack. Lower notes ring longer.
 */
export function epiano(bus: Stereo, at: number, lenSec: number, midi: number, o: { vel: number; pan?: number; bright?: number; seed: number }): void {
  const f = mtof(midi);
  const ring = clamp(3.2 - (midi - 48) * 0.05, 1.2, 3.5);
  const relN = 0.18 * SR;
  const holdN = Math.round(lenSec * SR);
  const len = Math.min(bus.length - at, holdN + Math.round(relN * 5));
  const bright = o.bright ?? 0.5;
  const idx0 = (0.6 + 1.6 * o.vel) * (0.6 + bright * 0.8);
  const [gl, gr] = panGains(o.pan ?? 0);
  const w = (TAU * f) / SR;
  const wt = (TAU * f * 14) / SR;
  // recursive exponentials (one multiply per sample instead of exp())
  const kIdx = Math.exp(-1 / (0.55 * SR));
  const kRing = Math.exp(-1 / (ring * SR));
  const kRel = Math.exp(-1 / relN);
  const kTm = Math.exp(-1 / (0.018 * SR));
  const kT = Math.exp(-1 / (0.22 * SR));
  const tineN = Math.min(len, Math.round(1.2 * SR));
  const attN = 0.003 * SR;
  const amp = o.vel * 0.42;
  const tineAmp = 0.18 * bright;
  let eIdx = 1;
  let env = 1;
  let eTm = 1;
  let eT = 1;
  for (let k = 0; k < len; k++) {
    eIdx *= kIdx;
    env *= k < holdN ? kRing : kRel;
    if (env < 1e-4) break;
    const wk = w * k;
    let v = fsin(wk + fsin(wk) * (idx0 * eIdx + 0.22));
    if (k < tineN) {
      eTm *= kTm;
      eT *= kT;
      v += fsin(wk + fsin(wt * k) * 1.1 * eTm) * eT * tineAmp;
    }
    const s = v * env * (k < attN ? k / attN : 1) * amp;
    bus.L[at + k] += s * gl;
    bus.R[at + k] += s * gr;
  }
}

/** Glassy FM bell / mallet (2:1 modulator), for arps and sparkle. */
export function bell(bus: Stereo, at: number, midi: number, o: { vel: number; decay?: number; pan?: number; ratio?: number }): void {
  const f = mtof(midi);
  const decay = o.decay ?? 0.9;
  const len = Math.min(bus.length - at, Math.round((decay * 4.6 + 0.02) * SR));
  const [gl, gr] = panGains(o.pan ?? 0);
  const w = (TAU * f) / SR;
  const wm = (TAU * f * (o.ratio ?? 2)) / SR;
  const kI = Math.exp(-1 / (0.12 * SR));
  const kA = Math.exp(-1 / (decay * SR));
  const attN = 0.0015 * SR;
  const amp = o.vel * 0.4;
  let eI = 1;
  let eA = 1;
  for (let k = 0; k < len; k++) {
    eI *= kI;
    eA *= kA;
    const v = fsin(w * k + fsin(wm * k) * (1.1 * eI + 0.08)) * eA * (k < attN ? k / attN : 1) * amp * tail(k, len);
    bus.L[at + k] += v * gl;
    bus.R[at + k] += v * gr;
  }
}

export type BassStyle = "round" | "pulse" | "sub" | "ostinato";

/**
 * Bass: a sine fundamental with saturation-generated harmonics (so phone speakers still "hear" the
 * line), or a filtered saw pulse for driving styles.
 */
export function bass(bus: Stereo, at: number, lenSec: number, midi: number, o: { vel: number; style?: BassStyle; seed: number }): void {
  const style = o.style ?? "round";
  const f = mtof(midi);
  const holdN = Math.round(lenSec * SR);
  const relN = (style === "sub" ? 0.2 : 0.05) * SR;
  const len = Math.min(bus.length - at, holdN + Math.round(relN * 5));
  const svf = new Svf(style === "pulse" ? 1400 : 700, style === "pulse" ? 1.1 : 0.7);
  const att = style === "sub" ? 0.05 : 0.004;
  const dPh = f / SR;
  let ph = (o.seed & 1023) / 1024;
  let relLevel = 1;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    ph += dPh;
    if (ph >= 1) ph -= 1;
    let v: number;
    if (style === "pulse" || style === "ostinato") {
      if ((k & 15) === 0) svf.set((style === "pulse" ? 260 : 380) + (style === "pulse" ? 1300 : 1500) * Math.exp(-t / 0.07), style === "pulse" ? 1.15 : 0.8);
      const saw = 2 * ph - 1 - blep(ph, dPh);
      v = svf.tick(saw) * 0.9 + fsin(TAU * ph) * 0.55;
    } else {
      const s = fsin(TAU * ph);
      v = style === "sub" ? s + 0.12 * fsin(2 * TAU * ph) : svf.tick(softClip(s * 2.2) * 0.75 + s * 0.35);
    }
    let env = Math.min(1, t / att) * (style === "round" ? 0.75 + 0.25 * Math.exp(-t / 0.25) : style === "pulse" ? 0.6 + 0.4 * Math.exp(-t / 0.08) : 1);
    if (k === holdN) relLevel = env;
    if (k >= holdN) env = relLevel * Math.exp(-(k - holdN) / relN);
    const s = v * env * o.vel * 0.5 * tail(k, len);
    bus.L[at + k] += s;
    bus.R[at + k] += s;
  }
}

// ---------------------------------------------------------------------------
// Transitions / ear candy
// ---------------------------------------------------------------------------

/** Filtered-noise riser that ends exactly at `endAt` (sample), with a rising tone underneath. */
export function riser(bus: Stereo, endAt: number, lenSec: number, o: { vel: number; seed: number; tone?: number }): void {
  const n = Math.round(lenSec * SR);
  const start = Math.max(0, endAt - n);
  const nl = new Noise(o.seed);
  const nr = new Noise(o.seed ^ 0x5bd1e995);
  const fl = new Svf(400, 1.4);
  const fr = new Svf(400, 1.4);
  const tone = o.tone ?? 220;
  let ph = 0;
  for (let i = start; i < Math.min(bus.length, endAt); i++) {
    const x = (i - start) / n;
    if (((i - start) & 31) === 0) {
      const fc = 350 * Math.pow(9000 / 350, x);
      fl.set(fc, 1.3);
      fr.set(fc * 1.07, 1.3);
    }
    fl.tick(nl.next());
    fr.tick(nr.next());
    ph += (tone * Math.pow(4, x)) / SR;
    const env = Math.pow(x, 2.2) * Math.min(1, (endAt - i) / (0.012 * SR));
    const t = fsin(TAU * ph) * 0.18;
    bus.L[i] += (fl.bp * 0.9 + t) * env * o.vel;
    bus.R[i] += (fr.bp * 0.9 + t) * env * o.vel;
  }
}

/** Soft cinematic hit: sub drop + dark noise bloom. Best with a reverb send. */
export function impact(bus: Stereo, at: number, o: { vel: number; seed: number }): void {
  const len = Math.min(bus.length - at, Math.round(2.6 * SR));
  const nz = new Noise(o.seed);
  const lp = new Svf(1800, 0.6);
  let ph = 0;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    ph += (37 + 58 * Math.exp(-t / 0.07)) / SR;
    const sub = fsin(TAU * ph) * Math.exp(-t / 0.65);
    lp.set(300 + 1500 * Math.exp(-t / 0.2), 0.6);
    const noise = lp.tick(nz.next()) * Math.exp(-t / 0.28) * 0.5;
    const v = softClip((sub + noise) * 1.4) * Math.min(1, t / 0.002) * o.vel * tail(k, len);
    bus.L[at + k] += v;
    bus.R[at + k] += v;
  }
}

/** Sparse vinyl crackle + hiss (lofi colour). Very low level. */
export function vinyl(bus: Stereo, from: number, to: number, o: { level: number; seed: number }): void {
  const nz = new Noise(o.seed);
  const hiss = new Svf(5000, 0.5);
  let hpL = 0;
  let prev = 0;
  for (let i = Math.max(0, from); i < Math.min(bus.length, to); i++) {
    const r = nz.next();
    let c = 0;
    if (r > 0.99988) c = (nz.next() + 1) * 0.5;
    hpL += 0.25 * (c - hpL);
    const click = c - hpL;
    const h = hiss.tick(nz.next()) * 0.06;
    const v = (click * 0.9 + h) * o.level;
    bus.L[i] += v;
    bus.R[i] += v * 0.8 + prev * 0.2;
    prev = v;
  }
}

export { seedFrom };
