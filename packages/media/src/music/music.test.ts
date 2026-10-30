import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MUSIC_CEILING_DB, MUSIC_MOOD_INFO, MUSIC_MOODS, MUSIC_TARGET_LUFS, SFX_KINDS, SFX_SPECS } from "@muselaunch/contracts";
import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { ffmpeg, probeMedia } from "../ffmpeg";
import { renderSfx, SFX_CEILING_DB } from "../sfx";
import { planArrangement, renderMusic } from "./compose";
import { SR, Stereo, Rng } from "./dsp";
import { encodeM4a } from "./encode";
import { ensureMusicAsset, ensureSfxLibrary, moodFromText, musicAssetId } from "./index";
import { integratedLoudness, limit } from "./master";

const dir = mkdtempSync(join(tmpdir(), "music-test-"));
const hash = (a: Float32Array, b: Float32Array) => createHash("sha256").update(Buffer.from(a.buffer)).update(Buffer.from(b.buffer)).digest("hex");
const peakDb = (a: Float32Array, b: Float32Array) => {
  let p = 0;
  for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]!), Math.abs(b[i]!));
  return 20 * Math.log10(p);
};

describe("loudness meter + limiter (BS.1770)", () => {
  it("reads a full-scale-relative 1 kHz sine on both channels at its dBFS level", () => {
    const n = SR * 3;
    const s = new Stereo(n);
    for (let i = 0; i < n; i++) s.L[i] = s.R[i] = 0.1 * Math.sin((2 * Math.PI * 997 * i) / SR);
    expect(integratedLoudness(s)).toBeCloseTo(-20, 0);
    expect(integratedLoudness(new Stereo(n))).toBe(-Infinity);
  });

  it("never lets a sample past the ceiling", () => {
    const n = SR;
    const s = new Stereo(n);
    const rng = new Rng(1);
    for (let i = 0; i < n; i++) s.L[i] = s.R[i] = (rng.next() * 2 - 1) * (i % 9000 < 40 ? 3 : 0.3);
    limit(s, { ceilingDb: -1.5 });
    expect(peakDb(s.L, s.R)).toBeLessThanOrEqual(-1.5 + 1e-4);
  });
});

describe("original music", () => {
  it("fits the arrangement to the exact length with an intro, a ring-out and beat-snapped accents", () => {
    for (const [mood, d] of [["bright-pluck", 30], ["calm-pad", 47.3], ["tech-pulse", 60], ["cinematic-build", 15]] as const) {
      const p = planArrangement(mood, d, new Rng("x"), [d * 0.5]);
      const [lo, hi] = MUSIC_MOOD_INFO[mood].bpm;
      expect(p.bpm).toBeGreaterThanOrEqual(lo);
      expect(p.bpm).toBeLessThanOrEqual(hi);
      expect(p.contentSec + p.tailSec).toBeCloseTo(d, 6);
      expect(p.tailSec).toBeGreaterThan(1);
      expect(p.energy).toHaveLength(p.bars);
      expect(p.energy[0]).toBe(0);
      expect(Math.max(...p.energy)).toBe(3);
      for (const a of p.accents) expect(Math.abs(a / p.beatSec - Math.round(a / p.beatSec))).toBeLessThan(1e-3);
    }
  });

  it("is deterministic by seed, exact in length, mastered to about −15 LUFS without clipping", { timeout: 90_000 }, () => {
    const a = renderMusic({ mood: "bright-pluck", durationSec: 9, seed: "cmp_1", accents: [6] });
    const b = renderMusic({ mood: "bright-pluck", durationSec: 9, seed: "cmp_1", accents: [6] });
    const c = renderMusic({ mood: "bright-pluck", durationSec: 9, seed: "cmp_2", accents: [6] });
    expect(a.left.length).toBe(9 * SR);
    expect(hash(a.left, a.right)).toBe(hash(b.left, b.right));
    expect(hash(a.left, a.right)).not.toBe(hash(c.left, c.right));
    expect(a.master.lufs).toBeGreaterThan(MUSIC_TARGET_LUFS - 0.6);
    expect(a.master.lufs).toBeLessThan(MUSIC_TARGET_LUFS + 0.6);
    expect(peakDb(a.left, a.right)).toBeLessThanOrEqual(MUSIC_CEILING_DB + 1e-4);
    // fades: silent first and last sample
    expect(Math.abs(a.left[0]!)).toBeLessThan(1e-3);
    expect(Math.abs(a.left[a.left.length - 1]!)).toBeLessThan(1e-3);
  });

  it("renders every mood with sound in it, wide but mono-compatible, and not harsh", { timeout: 90_000 }, () => {
    for (const mood of MUSIC_MOODS) {
      const r = renderMusic({ mood, durationSec: 7, seed: "moods" });
      expect(r.left.every((x) => Number.isFinite(x))).toBe(true);
      expect(r.master.lufs).toBeGreaterThan(-16);
      let lr = 0, ll = 0, rr = 0, hi = 0, tot = 0, prev = 0;
      for (let i = 0; i < r.left.length; i++) {
        lr += r.left[i]! * r.right[i]!;
        ll += r.left[i]! ** 2;
        rr += r.right[i]! ** 2;
        const m = (r.left[i]! + r.right[i]!) / 2;
        hi += (m - prev) ** 2; // first difference ≈ +6 dB/oct tilt: a crude "harshness" proxy
        tot += m * m;
        prev = m;
      }
      const corr = lr / Math.sqrt(ll * rr);
      expect(corr, mood).toBeGreaterThan(0.2);
      expect(corr, mood).toBeLessThan(0.995);
      expect(hi / tot, mood).toBeLessThan(0.08);
    }
  });

  it("maps Spark's free-text moods to presets", () => {
    expect(moodFromText("Upbeat, playful pop")).toBe("bright-pluck");
    expect(moodFromText("calm ambient, airy")).toBe("calm-pad");
    expect(moodFromText("sleek modern tech, premium")).toBe("tech-pulse");
    expect(moodFromText("warm heartfelt piano")).toBe("warm-keys");
    expect(moodFromText("epic cinematic trailer build")).toBe("cinematic-build");
    expect(moodFromText("lo-fi chill study beats")).toBe("lofi-chill");
    expect(moodFromText("tech-pulse")).toBe("tech-pulse");
    expect(moodFromText("")).toBe("bright-pluck");
    expect(moodFromText("something", "calm-pad")).toBe("calm-pad");
  });

  it("encodes to AAC/M4A whose loudness ffmpeg agrees with", async () => {
    const r = renderMusic({ mood: "warm-keys", durationSec: 8, seed: "enc" });
    const f = join(dir, "warm.m4a");
    await encodeM4a(r.left, r.right, r.sampleRate, f);
    const info = await probeMedia(f);
    expect(info.kind).toBe("audio");
    expect(info.durationSec).toBeCloseTo(8, 1);
    const log = await ffmpeg(["-loglevel", "info", "-nostats", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-"]);
    const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(log.split("Summary:").pop()!)?.[1]);
    expect(Math.abs(I - MUSIC_TARGET_LUFS)).toBeLessThan(1);
  });
});

describe("sound effects", () => {
  it("renders every effect at its spec length, normalised, peaking where the spec says", () => {
    for (const kind of SFX_KINDS) {
      const s = renderSfx(kind);
      const spec = SFX_SPECS[kind];
      expect(s.left.length, kind).toBe(Math.round(spec.durationSec * SR));
      expect(peakDb(s.left, s.right), kind).toBeLessThanOrEqual(SFX_CEILING_DB + 1e-4);
      // loudest 20 ms window lands near the declared peak
      const win = Math.round(0.02 * SR);
      let best = 0;
      let at = 0;
      for (let i = 0; i + win <= s.left.length; i += win / 2) {
        let e = 0;
        for (let k = i; k < i + win; k++) e += s.left[k]! ** 2 + s.right[k]! ** 2;
        if (e > best) {
          best = e;
          at = (i + win / 2) / SR;
        }
      }
      expect(Math.abs(at - spec.peakSec), kind).toBeLessThan(kind === "shimmer" ? 0.35 : 0.2);
      expect(Math.abs(s.left[s.left.length - 1]!), kind).toBeLessThan(1e-3);
    }
  });
});

describe("music + effect assets (cached per workspace, owned, labelled)", () => {
  it("stores original music once per parameter set and reuses it; effects once per workspace", async () => {
    const p = createTestPlatform({}, {});
    const params = { mood: "lofi-chill" as const, durationSec: 6, seed: "cmp_x", accents: [] };
    const a = await ensureMusicAsset(p, "ws_snd", { params, appId: "app_1", actor: "job:1" });
    expect(a.reused).toBe(false);
    expect(a.asset).toMatchObject({
      id: musicAssetId(params),
      kind: "audio",
      role: "music",
      origin: "generated",
      sourceLabel: "original_music",
      mimeType: "audio/mp4",
      status: "ready",
      isProductTruth: false,
      license: { type: "owned", provider: "MuseLaunch", attribution: "Original music generated by MuseLaunch" },
      generation: { provider: "MuseLaunch", model: "muselaunch-music-1" },
    });
    expect(a.asset.storagePath.startsWith("workspaces/ws_snd/generated/")).toBe(true);
    expect(a.asset.labels).toEqual(expect.arrayContaining(["original_music", "mood:lofi-chill"]));
    const again = await ensureMusicAsset(p, "ws_snd", { params, actor: "job:2" });
    expect(again).toMatchObject({ reused: true, asset: { id: a.asset.id } });
    // tenancy: another workspace gets its own copy, never a cross-workspace reference
    const other = await ensureMusicAsset(p, "ws_other", { params, actor: "job:3" });
    expect(other.reused).toBe(false);
    expect(other.asset.storagePath.startsWith("workspaces/ws_other/")).toBe(true);

    const lib = await ensureSfxLibrary(p, "ws_snd", { actor: "job:1", kinds: ["whoosh", "tap"] });
    expect(lib.whoosh).toMatchObject({ sourceLabel: "original_sfx", license: { type: "owned" }, labels: expect.arrayContaining(["sfx:whoosh"]) });
    const lib2 = await ensureSfxLibrary(p, "ws_snd", { actor: "job:2", kinds: ["whoosh"] });
    expect(lib2.whoosh.id).toBe(lib.whoosh.id);
  });
});
