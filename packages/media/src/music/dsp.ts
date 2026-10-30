/**
 * Small, allocation-free DSP toolkit for MuseLaunch's original music and sound effects.
 * Everything is our own code (no samples, no third-party audio), deterministic for a given seed,
 * and written over Float32Arrays so a 60 s stereo mix renders in a couple of seconds.
 */

export const SR = 48_000;
export const TAU = Math.PI * 2;
/** Below this, filter states are flushed to zero (subnormal floats are ~100× slower on x86). */
export const DENORMAL = 1e-20;

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash of a string (seed derivation). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, good-enough PRNG. Same seed → same music, bit for bit. */
export class Rng {
  private s: number;
  constructor(seed: number | string) {
    this.s = (typeof seed === "string" ? fnv1a(seed) : seed) >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Approximately normal (sum of uniforms), mean 0, sd ≈ 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }
  /** Derived generator (independent stream per instrument). */
  fork(label: string): Rng {
    return new Rng((Math.imul(this.s ^ fnv1a(label), 0x9e3779b1) >>> 0) || 1);
  }
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(1e-12, g));
export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
/** Constant-power pan law; pan in −1 (left) … 1 (right). */
export function panGains(pan: number): [number, number] {
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}
/** Pole coefficient for a one-pole smoother with time constant `sec`. */
export const tauCoef = (sec: number) => (sec <= 0 ? 1 : 1 - Math.exp(-1 / (sec * SR)));

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

export class Stereo {
  readonly L: Float32Array;
  readonly R: Float32Array;
  constructor(readonly length: number) {
    this.L = new Float32Array(length);
    this.R = new Float32Array(length);
  }
  mixFrom(src: Stereo, gain = 1, envelope?: Float32Array): this {
    const n = Math.min(this.length, src.length);
    const { L, R } = this;
    if (envelope) {
      for (let i = 0; i < n; i++) {
        const g = gain * envelope[i]!;
        L[i]! += src.L[i]! * g;
        R[i]! += src.R[i]! * g;
      }
    } else {
      for (let i = 0; i < n; i++) {
        L[i]! += src.L[i]! * gain;
        R[i]! += src.R[i]! * gain;
      }
    }
    return this;
  }
  scale(g: number): this {
    for (let i = 0; i < this.length; i++) {
      this.L[i]! *= g;
      this.R[i]! *= g;
    }
    return this;
  }
  peak(): number {
    let p = 0;
    for (let i = 0; i < this.length; i++) {
      const a = Math.abs(this.L[i]!);
      const b = Math.abs(this.R[i]!);
      if (a > p) p = a;
      if (b > p) p = b;
    }
    return p;
  }
}

// ---------------------------------------------------------------------------
// Oscillators
// ---------------------------------------------------------------------------

/** PolyBLEP residual: removes most aliasing from naive saw/square edges. */
export function blep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

const INV_TAU = 1 / TAU;
const HALF_PI = Math.PI / 2;
/**
 * sin(x) for any x: range-reduced 9th-order polynomial, |error| < 4e-6 (−108 dB). About 6× faster
 * than Math.sin, which dominates FM/oscillator inner loops.
 */
export function fsin(x: number): number {
  x -= TAU * Math.floor(x * INV_TAU + 0.5);
  if (x > HALF_PI) x = Math.PI - x;
  else if (x < -HALF_PI) x = -Math.PI - x;
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880)))));
}

/** Fast tanh-like soft clipper (Padé), exact enough for warmth/saturation. */
export function softClip(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Topology-preserving state-variable filter (Simper/Cytomic). Stable under fast modulation. */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1.4;
  lp = 0;
  bp = 0;
  hp = 0;
  constructor(fc = 1000, q = 0.707) {
    this.set(fc, q);
  }
  set(fc: number, q = 0.707): void {
    const x = (Math.PI * clamp(fc, 10, SR * 0.45)) / SR;
    // tan() series is accurate to <0.1 % below ~9 kHz and far cheaper in per-note filter sweeps
    const x2 = x * x;
    const g = x < 0.6 ? x * (1 + x2 * (1 / 3 + x2 * (2 / 15 + x2 * (17 / 315)))) : Math.tan(x);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  tick(v0: number): number {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    const i1 = 2 * v1 - this.ic1;
    const i2 = 2 * v2 - this.ic2;
    // flush denormals: decaying filter states otherwise slow every later operation ~100×
    this.ic1 = i1 > DENORMAL || i1 < -DENORMAL ? i1 : 0;
    this.ic2 = i2 > DENORMAL || i2 < -DENORMAL ? i2 : 0;
    this.lp = v2;
    this.bp = v1;
    this.hp = v0 - this.k * v1 - v2;
    return v2;
  }
  reset(): void {
    this.ic1 = this.ic2 = 0;
  }
}

/** RBJ biquad (direct form I), for static EQ. */
export class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(
    private b0: number,
    private b1: number,
    private b2: number,
    private a1: number,
    private a2: number,
  ) {}
  static make(type: "lowpass" | "highpass" | "bandpass" | "peak" | "lowshelf" | "highshelf", fc: number, q = 0.707, db = 0): Biquad {
    const w = (TAU * clamp(fc, 10, SR * 0.45)) / SR;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const A = Math.pow(10, db / 40);
    const alpha = sw / (2 * q);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (type) {
      case "lowpass":
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case "highpass":
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case "bandpass":
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case "peak":
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      case "lowshelf": {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
        a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s;
        break;
      }
      case "highshelf": {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s;
        break;
      }
    }
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }
  /** Raw coefficients (normalised, a0 = 1). */
  static raw(b: [number, number, number], a: [number, number]): Biquad {
    return new Biquad(b[0], b[1], b[2], a[0], a[1]);
  }
  tick(x: number): number {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    if (y < DENORMAL && y > -DENORMAL) y = 0;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
  run(buf: Float32Array, from = 0, to = buf.length): void {
    const { b0, b1, b2, a1, a2 } = this;
    let { x1, x2, y1, y2 } = this;
    for (let i = from; i < to; i++) {
      const x = buf[i]!;
      let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      if (y < DENORMAL && y > -DENORMAL) y = 0;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      buf[i] = y;
    }
    this.x1 = x1;
    this.x2 = x2;
    this.y1 = y1;
    this.y2 = y2;
  }
}

/** Static stereo EQ chain applied in place. */
export function eq(buf: Stereo, bands: [Parameters<typeof Biquad.make>[0], number, number?, number?][]): void {
  for (const [type, fc, q, db] of bands) {
    Biquad.make(type, fc, q ?? 0.707, db ?? 0).run(buf.L);
    Biquad.make(type, fc, q ?? 0.707, db ?? 0).run(buf.R);
  }
}

// ---------------------------------------------------------------------------
// Time-based effects
// ---------------------------------------------------------------------------

/**
 * Dattorro plate reverb (J. Dattorro, "Effect Design, Part 1", 1997), with modulated tank
 * allpasses. Smooth, dense and cheap: one instance per mix, fed from a send bus.
 */
export class Plate {
  // Lines: 0-3 input diffusers, 4 A1 allpass (modulated), 5 A1 delay, 6 A2 allpass, 7 A2 delay,
  // 8 B1 allpass (modulated), 9 B1 delay, 10 B2 allpass, 11 B2 delay. Fixed lines have length
  // nominal+1, so the read slot is always the slot after the write head.
  private readonly b: Float32Array[] = [];
  private readonly len: number[] = [];
  private readonly nom: number[] = [];
  private readonly p: Int32Array = new Int32Array(12);
  private readonly taps: Int32Array;
  private readonly exc: number;
  private readonly pre: Float32Array;
  private prePos = 0;
  private bw = 0;
  private dampA = 0;
  private dampB = 0;
  private lfo = 0;
  private fbA = 0;
  private fbB = 0;
  constructor(
    private readonly o: { decay: number; damping: number; predelayMs: number; bandwidth?: number; size?: number; modDepth?: number },
  ) {
    const s = (SR / 29761) * (o.size ?? 1);
    this.exc = (o.modDepth ?? 10) * (SR / 29761);
    const base = [142, 107, 379, 277, 672, 4453, 1800, 3720, 908, 4217, 2656, 3163];
    for (const [i, v] of base.entries()) {
      const nominal = Math.max(1, Math.round(v * (i < 4 ? SR / 29761 : s)));
      const len = nominal + (i === 4 || i === 8 ? Math.ceil(2 * this.exc) + 4 : 1);
      this.b.push(new Float32Array(len));
      this.len.push(len);
      this.nom.push(nominal);
    }
    const t = (line: number, d: number, sign: number) => [line, Math.min(this.len[line]! - 1, Math.max(1, Math.round(d * s))), sign];
    // Dattorro's output taps: 7 per side as (line, delay, sign)
    this.taps = Int32Array.from([
      ...t(9, 266, 1), ...t(9, 2974, 1), ...t(10, 1913, -1), ...t(11, 1996, 1), ...t(5, 1990, -1), ...t(6, 187, -1), ...t(7, 1066, -1),
      ...t(5, 353, 1), ...t(5, 3627, 1), ...t(6, 1228, -1), ...t(7, 2673, 1), ...t(9, 2111, -1), ...t(10, 335, -1), ...t(11, 121, -1),
    ]);
    this.pre = new Float32Array(Math.max(1, Math.round((o.predelayMs / 1000) * SR)));
  }

  /** Process a mono send into stereo `out` (added, scaled by `gain`). Fully inlined hot loop. */
  process(input: Float32Array, outL: Float32Array, outR: Float32Array, gain = 1): void {
    const decay = this.o.decay;
    const damp = 1 - this.o.damping;
    const bwc = this.o.bandwidth ?? 0.7;
    const exc = this.exc;
    const lfoInc = (TAU * 0.7) / SR;
    const [B0, B1, B2, B3, B4, B5, B6, B7, B8, B9, B10, B11] = this.b as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
    const [L0, L1, L2, L3, L4, L5, L6, L7, L8, L9, L10, L11] = this.len as number[] as [number, number, number, number, number, number, number, number, number, number, number, number];
    const nA = this.nom[4]!;
    const nB = this.nom[8]!;
    const P = this.p;
    let p0 = P[0]!, p1 = P[1]!, p2 = P[2]!, p3 = P[3]!, p4 = P[4]!, p5 = P[5]!, p6 = P[6]!, p7 = P[7]!, p8 = P[8]!, p9 = P[9]!, p10 = P[10]!, p11 = P[11]!;
    const pre = this.pre;
    const preLen = pre.length;
    let prePos = this.prePos;
    let bw = this.bw, dampA = this.dampA, dampB = this.dampB, lfo = this.lfo, fbA = this.fbA, fbB = this.fbB;
    const T = this.taps;
    const lines = [B0, B1, B2, B3, B4, B5, B6, B7, B8, B9, B10, B11];
    const lens = [L0, L1, L2, L3, L4, L5, L6, L7, L8, L9, L10, L11];
    const g = 0.6 * gain;
    const n = input.length;
    let rd: number, d: number, w: number, v: number;
    for (let s = 0; s < n; s++) {
      // pre-delay + bandwidth low-pass
      const pd = pre[prePos]!;
      pre[prePos] = input[s]!;
      if (++prePos === preLen) prePos = 0;
      bw += bwc * (pd - bw);
      if (bw < DENORMAL && bw > -DENORMAL) bw = 0;
      // four input diffusers (allpass): d = oldest, w = x + g·d, y = d − g·w
      rd = p0 + 1; if (rd === L0) rd = 0; d = B0[rd]!; w = bw + 0.75 * d; B0[p0] = w; p0 = rd; v = d - 0.75 * w;
      rd = p1 + 1; if (rd === L1) rd = 0; d = B1[rd]!; w = v + 0.75 * d; B1[p1] = w; p1 = rd; v = d - 0.75 * w;
      rd = p2 + 1; if (rd === L2) rd = 0; d = B2[rd]!; w = v + 0.625 * d; B2[p2] = w; p2 = rd; v = d - 0.625 * w;
      rd = p3 + 1; if (rd === L3) rd = 0; d = B3[rd]!; w = v + 0.625 * d; B3[p3] = w; p3 = rd; v = d - 0.625 * w;
      lfo += lfoInc;
      if (lfo > TAU) lfo -= TAU;
      const m = fsin(lfo) * exc;
      // tank A: modulated allpass → delay → damping → allpass → delay
      let rp = p4 - (nA + exc + m);
      if (rp < 0) rp += L4;
      let i0 = rp | 0;
      let fr = rp - i0;
      let i1 = i0 + 1; if (i1 === L4) i1 = 0;
      d = B4[i0]! * (1 - fr) + B4[i1]! * fr;
      w = v + fbB * decay - 0.7 * d;
      if (w < DENORMAL && w > -DENORMAL) w = 0;
      B4[p4] = w; if (++p4 === L4) p4 = 0;
      let a = d + 0.7 * w;
      rd = p5 + 1; if (rd === L5) rd = 0; d = B5[rd]!; B5[p5] = a; p5 = rd; a = d;
      dampA += damp * (a - dampA);
      if (dampA < DENORMAL && dampA > -DENORMAL) dampA = 0;
      rd = p6 + 1; if (rd === L6) rd = 0; d = B6[rd]!; w = dampA * decay + 0.5 * d; B6[p6] = w; p6 = rd; a = d - 0.5 * w;
      rd = p7 + 1; if (rd === L7) rd = 0; const aOut = B7[rd]!; B7[p7] = a; p7 = rd;
      // tank B
      rp = p8 - (nB + exc - m);
      if (rp < 0) rp += L8;
      i0 = rp | 0;
      fr = rp - i0;
      i1 = i0 + 1; if (i1 === L8) i1 = 0;
      d = B8[i0]! * (1 - fr) + B8[i1]! * fr;
      w = v + fbA * decay - 0.7 * d;
      if (w < DENORMAL && w > -DENORMAL) w = 0;
      B8[p8] = w; if (++p8 === L8) p8 = 0;
      let b = d + 0.7 * w;
      rd = p9 + 1; if (rd === L9) rd = 0; d = B9[rd]!; B9[p9] = b; p9 = rd; b = d;
      dampB += damp * (b - dampB);
      if (dampB < DENORMAL && dampB > -DENORMAL) dampB = 0;
      rd = p10 + 1; if (rd === L10) rd = 0; d = B10[rd]!; w = dampB * decay + 0.5 * d; B10[p10] = w; p10 = rd; b = d - 0.5 * w;
      rd = p11 + 1; if (rd === L11) rd = 0; const bOut = B11[rd]!; B11[p11] = b; p11 = rd;
      fbA = aOut > DENORMAL || aOut < -DENORMAL ? aOut : 0;
      fbB = bOut > DENORMAL || bOut < -DENORMAL ? bOut : 0;
      // output taps (positions after this sample's writes)
      P[4] = p4; P[5] = p5; P[6] = p6; P[7] = p7; P[8] = p8; P[9] = p9; P[10] = p10; P[11] = p11;
      let l = 0;
      let r = 0;
      for (let k = 0; k < 42; k += 3) {
        const line = T[k]!;
        let idx = P[line]! - T[k + 1]!;
        if (idx < 0) idx += lens[line]!;
        const val = lines[line]![idx]! * T[k + 2]!;
        if (k < 21) l += val;
        else r += val;
      }
      outL[s]! += l * g;
      outR[s]! += r * g;
    }
    P[0] = p0; P[1] = p1; P[2] = p2; P[3] = p3;
    this.prePos = prePos;
    this.bw = bw;
    this.dampA = dampA;
    this.dampB = dampB;
    this.lfo = lfo;
    this.fbA = fbA;
    this.fbB = fbB;
  }
}

/** Tempo-synced stereo ping-pong delay with darkening feedback. Adds the wet signal into `out`. */
export function pingPong(input: Float32Array, out: Stereo, o: { timeSec: number; feedback: number; lowCut?: number; highCut?: number; wet: number }): void {
  const d = Math.max(1, Math.round(o.timeSec * SR));
  const bl = new Float32Array(d);
  const br = new Float32Array(d);
  const hc = tauCoef(1 / (TAU * (o.highCut ?? 4500)));
  const lc = tauCoef(1 / (TAU * (o.lowCut ?? 250)));
  let lpL = 0, lpR = 0, hpL = 0, hpR = 0;
  let p = 0;
  for (let i = 0; i < input.length; i++) {
    const dl = bl[p]!;
    const dr = br[p]!;
    // L feeds R and vice versa → ping-pong; the mono send enters on the left.
    const inMono = input[i]!;
    lpL += hc * (dr * o.feedback + inMono - lpL);
    lpR += hc * (dl * o.feedback - lpR);
    hpL += lc * (lpL - hpL);
    hpR += lc * (lpR - hpR);
    if (lpL < DENORMAL && lpL > -DENORMAL) lpL = hpL = 0;
    if (lpR < DENORMAL && lpR > -DENORMAL) lpR = hpR = 0;
    bl[p] = lpL - hpL;
    br[p] = lpR - hpR;
    out.L[i]! += dl * o.wet;
    out.R[i]! += dr * o.wet;
    p = (p + 1) % d;
  }
}

/** Gentle stereo chorus (two modulated delay lines), in place. */
export function chorus(buf: Stereo, o: { rate: number; depthMs: number; baseMs: number; mix: number }): void {
  const max = Math.ceil(((o.baseMs + o.depthMs) / 1000) * SR) + 4;
  const len = max + 1;
  const dl = new Float32Array(len);
  const dr = new Float32Array(len);
  let w = 0;
  const inc = (TAU * o.rate) / SR;
  let ph = 0;
  const base = (o.baseMs / 1000) * SR;
  const depth = (o.depthMs / 1000) * SR;
  for (let i = 0; i < buf.length; i++) {
    const xl = buf.L[i]!;
    const xr = buf.R[i]!;
    dl[w] = xl;
    dr[w] = xr;
    ph += inc;
    if (ph > TAU) ph -= TAU;
    const tl = base + depth * (0.5 + 0.5 * fsin(ph));
    const tr = base + depth * (0.5 + 0.5 * fsin(ph + HALF_PI));
    // cross-feed the modulated copies for width
    let rp = w - tr;
    if (rp < 0) rp += len;
    let i0 = Math.floor(rp);
    let f = rp - i0;
    const wr = dr[i0 % len]! * (1 - f) + dr[(i0 + 1) % len]! * f;
    rp = w - tl;
    if (rp < 0) rp += len;
    i0 = Math.floor(rp);
    f = rp - i0;
    const wl = dl[i0 % len]! * (1 - f) + dl[(i0 + 1) % len]! * f;
    buf.L[i] = xl * (1 - o.mix * 0.5) + wr * o.mix;
    buf.R[i] = xr * (1 - o.mix * 0.5) + wl * o.mix;
    w = (w + 1) % len;
  }
}

/** Mid/side width: 1 = unchanged, >1 wider, <1 narrower. In place. */
export function width(buf: Stereo, amount: number): void {
  for (let i = 0; i < buf.length; i++) {
    const m = (buf.L[i]! + buf.R[i]!) * 0.5;
    const s = (buf.L[i]! - buf.R[i]!) * 0.5 * amount;
    buf.L[i] = m + s;
    buf.R[i] = m - s;
  }
}

/**
 * Sidechain-style ducking curve: dips to `1 - depth` on each hit and recovers over `releaseSec`
 * with an ease-out shape (the "pump" of modern pop), never touching zero.
 */
export function duckCurve(length: number, hits: number[], depth: number, releaseSec: number, attackSec = 0.004): Float32Array {
  const env = new Float32Array(length).fill(1);
  const rel = Math.max(1, Math.round(releaseSec * SR));
  const att = Math.max(1, Math.round(attackSec * SR));
  for (const h of hits) {
    const start = Math.max(0, h - att);
    for (let i = start; i < Math.min(length, h + rel); i++) {
      let g: number;
      if (i < h) g = 1 - depth * ((i - start) / att);
      else {
        const x = (i - h) / rel;
        g = 1 - depth * Math.pow(1 - x, 2.2);
      }
      if (g < env[i]!) env[i] = g;
    }
  }
  return env;
}
