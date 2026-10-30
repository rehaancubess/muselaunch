/**
 * Mastering: ITU-R BS.1770-4 loudness (K-weighting, 400 ms blocks, absolute + relative gating),
 * a look-ahead brickwall limiter with smooth gain (no clipping, no pumping) and fades.
 */
import { dbToGain, gainToDb, SR, type Stereo } from "./dsp";

/**
 * K-weighting at 48 kHz (BS.1770 stage 1 shelf + stage 2 RLB high-pass), squared and summed per
 * 100 ms hop into `hops`. Inlined biquads: this runs on every stem, so it must be cheap.
 */
function kWeightedHops(x: Float32Array, hops: Float64Array, hop: number): void {
  const b0 = 1.53512485958697, b1 = -2.69169618940638, b2 = 1.19839281085285, a1 = -1.69065929318241, a2 = 0.73248077421585;
  const c1 = -1.99004745483398, c2 = 0.99007225036621;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
  let acc = 0;
  let h = 0;
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    let y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    if (y < 1e-20 && y > -1e-20) y = 0;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = y;
    let z = y - 2 * u1 + u2 - c1 * z1 - c2 * z2;
    if (z < 1e-20 && z > -1e-20) z = 0;
    u2 = u1;
    u1 = y;
    z2 = z1;
    z1 = z;
    acc += z * z;
    if (++k === hop) {
      hops[h++]! += acc;
      acc = 0;
      k = 0;
    }
  }
  if (k) hops[h]! += acc;
}

/** Integrated loudness (LUFS) of a 48 kHz stereo buffer. −Infinity for silence. */
export function integratedLoudness(buf: Stereo): number {
  const hop = Math.round(0.1 * SR);
  const block = 4 * hop;
  const n = buf.length;
  const hops = new Float64Array(Math.ceil(n / hop) + 1);
  kWeightedHops(buf.L, hops, hop);
  kWeightedHops(buf.R, hops, hop);
  const z: number[] = [];
  const full = Math.floor(n / hop);
  if (n < block) {
    if (n > 0) z.push(hops.reduce((a, b) => a + b, 0) / n);
  } else for (let s = 0; s + 4 <= full; s++) z.push((hops[s]! + hops[s + 1]! + hops[s + 2]! + hops[s + 3]!) / block);
  const lk = (ms: number) => -0.691 + 10 * Math.log10(ms);
  const abs = z.filter((m) => m > 0 && lk(m) > -70);
  if (!abs.length) return -Infinity;
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((m) => lk(m) > rel);
  if (!gated.length) return -Infinity;
  return lk(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/** Sample peak in dBFS. */
export function peakDb(buf: Stereo): number {
  return gainToDb(buf.peak());
}

/**
 * Offline look-ahead limiter: per-sample required gain → sliding-window minimum over the
 * look-ahead → box smoothing of the same length (so the gain is fully down at the peak and the
 * ramp is click-free) → exponential release. Hard ceiling guaranteed.
 */
export interface LimiterScratch {
  req: Float32Array;
  mins: Float32Array;
  g: Float32Array;
  dq: Int32Array;
}
export const limiterScratch = (n: number): LimiterScratch => ({ req: new Float32Array(n), mins: new Float32Array(n), g: new Float32Array(n), dq: new Int32Array(n + SR) });

export function limit(buf: Stereo, o: { ceilingDb: number; lookaheadMs?: number; releaseMs?: number }, scratch: LimiterScratch = limiterScratch(buf.length)): { maxReductionDb: number } {
  const n = buf.length;
  const c = dbToGain(o.ceilingDb);
  const L = Math.max(1, Math.min(SR / 2, Math.round(((o.lookaheadMs ?? 3) / 1000) * SR)));
  const { req, mins, g, dq } = scratch;
  let any = false;
  for (let i = 0; i < n; i++) {
    const l = buf.L[i]!;
    const r = buf.R[i]!;
    const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
    if (a > c) {
      req[i] = c / a;
      any = true;
    } else req[i] = 1;
  }
  if (!any) return { maxReductionDb: 0 };
  // sliding minimum of req[i .. i+L] (monotonic deque)
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n + L; j++) {
    if (j < n) {
      while (tail > head && req[dq[tail - 1]!]! >= req[j]!) tail--;
      dq[tail++] = j;
    }
    const i = j - L;
    if (i >= 0) {
      while (dq[head]! < i) head++;
      mins[i] = req[dq[head]!]!;
    }
  }
  // box smoothing over the previous L samples: at a peak every averaged value ≤ its requirement
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += mins[i]!;
    if (i >= L) acc -= mins[i - L]!;
    g[i] = acc / Math.min(i + 1, L);
  }
  const rel = 1 - Math.exp(-1 / (((o.releaseMs ?? 120) / 1000) * SR));
  let cur = 1;
  let maxRed = 1;
  for (let i = 0; i < n; i++) {
    const target = Math.min(g[i]!, mins[i]!);
    cur = target < cur ? target : cur + (target - cur) * rel;
    if (cur < maxRed) maxRed = cur;
    let l = buf.L[i]! * cur;
    let r = buf.R[i]! * cur;
    // numerical safety net only; the gain curve already respects the ceiling
    if (l > c) l = c;
    else if (l < -c) l = -c;
    if (r > c) r = c;
    else if (r < -c) r = -c;
    buf.L[i] = l;
    buf.R[i] = r;
  }
  return { maxReductionDb: gainToDb(maxRed) };
}

/** Raised-cosine fade in/out (seconds), in place. */
export function fades(buf: Stereo, inSec: number, outSec: number): void {
  const fi = Math.min(buf.length, Math.round(inSec * SR));
  const fo = Math.min(buf.length, Math.round(outSec * SR));
  for (let i = 0; i < fi; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
    buf.L[i]! *= g;
    buf.R[i]! *= g;
  }
  for (let k = 0; k < fo; k++) {
    const i = buf.length - 1 - k;
    const g = 0.5 - 0.5 * Math.cos((Math.PI * k) / fo);
    buf.L[i]! *= g;
    buf.R[i]! *= g;
  }
}

export interface MasterReport {
  lufs: number;
  peakDb: number;
  gainDb: number;
  limiterDb: number;
}

/**
 * Normalise to `targetLufs` and brickwall at `ceilingDb`. Limiting lowers loudness slightly, so
 * the gain is corrected and the limiter re-run (converges in 2–3 passes).
 */
export function master(buf: Stereo, o: { targetLufs: number; ceilingDb: number; fadeInSec?: number; fadeOutSec?: number }): MasterReport {
  const src = { L: Float32Array.from(buf.L), R: Float32Array.from(buf.R) };
  const measured = integratedLoudness(buf);
  if (!Number.isFinite(measured)) return { lufs: measured, peakDb: peakDb(buf), gainDb: 0, limiterDb: 0 };
  let gainDb = o.targetLufs - measured;
  let lufs = measured;
  let limiterDb = 0;
  const scratch = limiterScratch(buf.length);
  for (let pass = 0; pass < 4; pass++) {
    const g = dbToGain(gainDb);
    for (let i = 0; i < buf.length; i++) {
      buf.L[i] = src.L[i]! * g;
      buf.R[i] = src.R[i]! * g;
    }
    limiterDb = limit(buf, { ceilingDb: o.ceilingDb, lookaheadMs: 3, releaseMs: 150 }, scratch).maxReductionDb;
    lufs = integratedLoudness(buf);
    const err = o.targetLufs - lufs;
    if (Math.abs(err) < 0.15) break;
    gainDb += err;
  }
  if (o.fadeInSec || o.fadeOutSec) fades(buf, o.fadeInSec ?? 0, o.fadeOutSec ?? 0);
  return { lufs, peakDb: peakDb(buf), gainDb, limiterDb };
}
