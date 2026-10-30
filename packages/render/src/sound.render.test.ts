import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachAudio, validateDoc } from "@muselaunch/compositions";
import { createComposition } from "@muselaunch/compositions/store";
import { encodeM4a, ensureMusicAsset, ensureSfxLibrary, ffmpeg } from "@muselaunch/media";
import { createTestPlatform, workspaceKey } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { handlers } from "./handlers";

/**
 * Real HyperFrames render of the sound mix (Track 3): original music + effects + a voice, checked
 * in the final MP4 — loudness, true peak (no clipping) and the depth of the music ducking.
 *   RUN_RENDER_TESTS=1 RENDER_CHROME_PATH=/path/to/chrome-headless-shell npx vitest run packages/render/src/sound.render.test.ts
 */
describe.runIf(process.env.RUN_RENDER_TESTS === "1")("sound in the rendered MP4", { timeout: 15 * 60_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "ml-sound-render-"));
  const SR = 48_000;

  async function pcm(file: string, from: number, to: number): Promise<Float32Array> {
    const raw = join(tmp, `${Math.random().toString(36).slice(2)}.raw`);
    await ffmpeg(["-ss", String(from), "-t", String(to - from), "-i", file, "-ac", "1", "-ar", String(SR), "-af", "lowpass=f=250,lowpass=f=250,lowpass=f=250", "-f", "f32le", raw]);
    const b = await import("node:fs/promises").then((m) => m.readFile(raw));
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  }
  const rmsDb = (x: Float32Array) => 10 * Math.log10(x.reduce((a, v) => a + v * v, 0) / x.length);

  it("mixes music, effects and voice with music ducked ~8.5 dB under speech, at a sane level, without clipping", async () => {
    const p = createTestPlatform({}, handlers);
    const wid = "ws_sound_render";
    const ws = p.db.ws(wid);
    await p.credits.grant(wid, 100, { reason: "test", idempotencyKey: "grant:sound-render", actor: "system" });
    const app = await ws.collection("apps").create({ id: "app_s", name: "Focusly" } as never, { actor: "u1" });
    const v = validateDoc({
      schemaVersion: 1,
      title: "Sound",
      kind: "video",
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 30,
      theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#0A84FF" },
      scenes: [
        { id: "sc_a", name: "Hook", template: "hook-title", durationSec: 3, layers: [{ id: "ly_a", type: "text", text: "Sound check", box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 } }] },
        { id: "sc_b", name: "Demo", template: "device-demo", durationSec: 3, transitionIn: { kind: "wipe", durationSec: 0.4 }, layers: [{ id: "ly_b", type: "text", text: "Wipe", box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 } }] },
        { id: "sc_c", name: "CTA", template: "cta-endcard", purpose: "cta", durationSec: 2, layers: [{ id: "ly_c", type: "text", role: "cta", text: "Download", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 } }] },
      ],
    });
    if (!v.ok) throw new Error(v.errors.join("; "));
    // A stand-in "voice": 1 kHz tone bursts (no provider), stored like a recording.
    const n = Math.round(6 * SR);
    const tone = new Float32Array(n);
    const speech = [
      { startSec: 1.0, endSec: 2.4 },
      { startSec: 4.2, endSec: 5.4 },
    ];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      if (speech.some((r) => t >= r.startSec && t < r.endSec)) tone[i] = 0.3 * Math.sin(2 * Math.PI * 1000 * t);
    }
    const vf = join(tmp, "voice.m4a");
    await encodeM4a(tone, null, SR, vf);
    const vkey = workspaceKey(wid, "uploads", "ast_voice", "voice.m4a");
    const put = await p.storage.put(vkey, await import("node:fs/promises").then((m) => m.readFile(vf)), { contentType: "audio/mp4" });
    await ws.collection("mediaAssets").create({ id: "ast_voice", appId: app.id, kind: "audio", role: "voiceover", origin: "upload", storagePath: vkey, mimeType: "audio/mp4", bytes: put.bytes, durationSec: 6, hasAudio: true, status: "ready", isProductTruth: false, sourceLabel: "founder_recording" }, { actor: "u1" });
    const music = await ensureMusicAsset(p, wid, { params: { mood: "bright-pluck", durationSec: 8, seed: "render", accents: [6] }, actor: "u1" });
    const lib = await ensureSfxLibrary(p, wid, { actor: "u1" });
    const doc = attachAudio(v.doc, {
      music: { assetId: music.asset.id, mood: "bright-pluck" },
      sfx: { enabled: true, assets: Object.fromEntries(Object.entries(lib).map(([k, a]) => [k, a.id])) },
      voiceover: { assetId: "ast_voice", durationSec: 6, sourceLabel: "founder_recording", startSec: 0.25, speech },
    });
    await createComposition(ws, { id: "cmp_sound", appId: app.id, title: "Sound", doc }, "u1");
    const job = await p.jobs.create(wid, "render.preview", { appId: app.id, compositionId: "cmp_sound", version: 1 }, { actor: "u1", idempotencyKey: "sound-preview" });
    await p.inline!.drain();
    expect(await p.jobs.get(wid, job.id)).toMatchObject({ status: "succeeded" });
    const comp = await ws.collection("compositions").getOrThrow("cmp_sound");
    const asset = await ws.collection("mediaAssets").getOrThrow(comp.lastRender!.assetId!);
    const mp4 = join(tmp, "out.mp4");
    await p.storage.downloadToFile(asset.storagePath, mp4);
    const musicFile = join(tmp, "music.m4a");
    await p.storage.downloadToFile(music.asset.storagePath, musicFile);

    const log = await ffmpeg(["-loglevel", "info", "-nostats", "-i", mp4, "-af", "ebur128=peak=true", "-f", "null", "-"]);
    const summary = log.split("Summary:").pop()!;
    const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
    const tp = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
    await writeFile(join(tmp, "ebur128.txt"), summary);
    expect(I).toBeGreaterThan(-22);
    expect(I).toBeLessThan(-11);
    expect(tp).toBeLessThanOrEqual(-0.9);

    // Low band (< 250 Hz: music only, the 1 kHz "voice" is filtered out): mix vs the music file.
    const ducked = rmsDb(await pcm(mp4, 1.7, 2.5)) - rmsDb(await pcm(musicFile, 1.7, 2.5));
    const open = rmsDb(await pcm(mp4, 3.7, 4.2)) - rmsDb(await pcm(musicFile, 3.7, 4.2));
    console.log(`[sound render] I=${I} LUFS, true peak=${tp} dBFS, music under speech ${ducked.toFixed(1)} dB, music in a gap ${open.toFixed(1)} dB`);
    expect(open).toBeGreaterThan(-4.5); // 0.8 track volume ≈ −1.9 dB
    expect(open).toBeLessThan(0.5);
    expect(ducked - open).toBeLessThan(-6); // ducked by ~8.5 dB (0.3 / 0.8)
    expect(ducked - open).toBeGreaterThan(-11);
  });
});
