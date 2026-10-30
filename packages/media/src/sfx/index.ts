/**
 * Original sound effects, synthesized by MuseLaunch's own code (no samples): short, soft and
 * tasteful UI/transition sounds that sit under music and voice. Timing facts (length, the moment
 * the effect "lands") are shared with the placement logic through `SFX_SPECS` in the contracts.
 */
import { SFX_SPECS, type SfxKind } from "@muselaunch/contracts";
import { clamp, fsin, panGains, Plate, Rng, SR, Stereo, Svf, TAU } from "../music/dsp";
import * as I from "../music/instruments";
import { integratedLoudness, limit } from "../music/master";

/** Loudness every effect is normalised to (LUFS over its length) and its peak ceiling. */
export const SFX_TARGET_LUFS = -16;
export const SFX_CEILING_DB = -3;

function noisePair(seed: number) {
  return [new I.Noise(seed), new I.Noise(seed ^ 0x6c8e9cf5)] as const;
}

function whoosh(buf: Stereo, rng: Rng, o: { peak: number; up?: boolean }): void {
  const n = buf.length;
  const pk = Math.round(o.peak * SR);
  const [nl, nr] = noisePair(I.seedFrom(rng.next()));
  const fl = new Svf(500, 0.9);
  const fr = new Svf(500, 0.9);
  const body = new Svf(320, 0.6);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    // smooth swell to the peak, faster decay after it
    const env = i < pk ? Math.pow(i / pk, 2.2) : Math.exp(-(i - pk) / ((n - pk) * 0.28));
    if ((i & 15) === 0) {
      const fc = o.up ? 600 * Math.pow(10, 1.05 * Math.min(1, i / pk)) : i < pk ? 380 + 2300 * Math.pow(i / pk, 1.6) : 2680 - 1800 * ((i - pk) / (n - pk));
      fl.set(fc, 0.9);
      fr.set(fc * 1.06, 0.9);
    }
    const a = nl.next();
    const b = nr.next();
    fl.tick(a);
    fr.tick(b);
    const low = body.tick((a + b) * 0.5) * 0.5;
    // the sound travels across the stereo field
    const [gl, gr] = panGains(clamp((x - 0.5) * 1.3, -0.7, 0.7));
    let tone = 0;
    if (o.up) {
      ph += (280 * Math.pow(4, Math.min(1, i / pk))) / SR;
      tone = fsin(TAU * ph) * 0.12;
    }
    buf.L[i] += (fl.bp * 1.2 + low + tone) * env * gl * 1.4;
    buf.R[i] += (fr.bp * 1.2 + low + tone) * env * gr * 1.4;
  }
}

function pop(buf: Stereo, rng: Rng): void {
  const nz = new I.Noise(I.seedFrom(rng.next()));
  let ph = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    ph += (380 + 760 * Math.exp(-t / 0.012)) / SR;
    const v = fsin(TAU * ph) * Math.exp(-t / 0.035) * Math.min(1, t / 0.0008) + nz.next() * Math.exp(-t / 0.0015) * 0.15;
    buf.L[i] += v;
    buf.R[i] += v;
  }
}

function click(buf: Stereo, rng: Rng): void {
  const nz = new I.Noise(I.seedFrom(rng.next()));
  const hp = new Svf(2200, 0.7);
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    hp.tick(nz.next());
    const v = hp.hp * Math.exp(-t / 0.0018) * 0.6 + fsin(TAU * 2600 * t) * Math.exp(-t / 0.006) * 0.5 + fsin(TAU * 1250 * t) * Math.exp(-t / 0.01) * 0.25;
    buf.L[i] += v * 0.95;
    buf.R[i] += v;
  }
}

function tap(buf: Stereo, rng: Rng): void {
  const nz = new I.Noise(I.seedFrom(rng.next()));
  const lp = new Svf(5000, 0.7);
  let ph = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    ph += (900 + 650 * Math.exp(-t / 0.006)) / SR;
    const v = fsin(TAU * ph) * Math.exp(-t / 0.022) * 0.7 + fsin(TAU * 320 * t) * Math.exp(-t / 0.035) * 0.45 + lp.tick(nz.next()) * Math.exp(-t / 0.002) * 0.25;
    const s = v * Math.min(1, t / 0.0006);
    buf.L[i] += s;
    buf.R[i] += s;
  }
}

function shimmer(buf: Stereo, rng: Rng): void {
  // Pentatonic glints (least likely to clash with any music key), quick and airy.
  const notes = [96, 93, 98, 100, 103, 105, 108];
  const order = rng.chance(0.5) ? notes : [...notes].reverse();
  order.forEach((m, k) => {
    const at = Math.round((0.012 + k * 0.042) * SR);
    I.bell(buf, at, m - 12, { vel: 0.55 - k * 0.04, decay: 0.5, pan: ((k % 3) - 1) * 0.45, ratio: 2 });
  });
  // a soft high noise "sparkle" bed
  const [nl, nr] = noisePair(I.seedFrom(rng.next()));
  const fl = new Svf(9000, 1.2);
  const fr = new Svf(9500, 1.2);
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.05) * Math.exp(-t / 0.35) * 0.06;
    fl.tick(nl.next());
    fr.tick(nr.next());
    buf.L[i] += fl.bp * env;
    buf.R[i] += fr.bp * env;
  }
}

function withReverb(dry: Stereo, o: { mix: number; decay: number }): void {
  const wet = new Stereo(dry.length);
  const send = new Float32Array(dry.length);
  for (let i = 0; i < dry.length; i++) send[i] = (dry.L[i]! + dry.R[i]!) * 0.5;
  new Plate({ decay: o.decay, damping: 0.4, predelayMs: 8, size: 0.8, bandwidth: 0.7 }).process(send, wet.L, wet.R);
  dry.mixFrom(wet, o.mix);
}

/** Render one effect (stereo, 48 kHz, exactly `SFX_SPECS[kind].durationSec` long), normalised. */
export function renderSfx(kind: SfxKind, seed = "v1"): { left: Float32Array; right: Float32Array; sampleRate: number } {
  const spec = SFX_SPECS[kind];
  const n = Math.round(spec.durationSec * SR);
  const buf = new Stereo(n);
  const rng = new Rng(`sfx|${kind}|${seed}`);
  switch (kind) {
    case "whoosh":
      whoosh(buf, rng, { peak: spec.peakSec });
      withReverb(buf, { mix: 0.25, decay: 0.5 });
      break;
    case "swoosh-up":
      whoosh(buf, rng, { peak: spec.peakSec, up: true });
      withReverb(buf, { mix: 0.2, decay: 0.45 });
      break;
    case "pop":
      pop(buf, rng);
      break;
    case "click":
      click(buf, rng);
      break;
    case "tap":
      tap(buf, rng);
      break;
    case "riser":
      I.riser(buf, Math.round(spec.peakSec * SR), spec.peakSec, { vel: 1, seed: I.seedFrom(rng.next()), tone: 200 });
      withReverb(buf, { mix: 0.3, decay: 0.55 });
      break;
    case "impact":
      I.impact(buf, Math.round(spec.peakSec * SR), { vel: 1, seed: I.seedFrom(rng.next()) });
      withReverb(buf, { mix: 0.35, decay: 0.7 });
      break;
    case "shimmer":
      shimmer(buf, rng);
      withReverb(buf, { mix: 0.45, decay: 0.75 });
      break;
  }
  // Normalise loudness, keep peaks low, and fade the last 30 ms so nothing clicks at the cut.
  const l = integratedLoudness(buf);
  if (Number.isFinite(l)) buf.scale(Math.pow(10, (SFX_TARGET_LUFS - l) / 20));
  limit(buf, { ceilingDb: SFX_CEILING_DB, lookaheadMs: 1.5, releaseMs: 60 });
  const fo = Math.min(n, Math.round(0.03 * SR));
  for (let k = 0; k < fo; k++) {
    const g = k / fo;
    buf.L[n - 1 - k]! *= g;
    buf.R[n - 1 - k]! *= g;
  }
  return { left: buf.L, right: buf.R, sampleRate: SR };
}
