/**
 * `pnpm run audio:samples` — renders listening samples of MuseLaunch's original music and sound
 * effects into fixtures/audio-samples/ (AAC .m4a, small enough to keep in git):
 *   - <mood>.m4a        one ~30 s track per mood preset (accent riser → hit at ~2/3, ending ring-out)
 *   - sfx-sheet.m4a     every sound effect in order, 0.7 s apart (timestamps in index.json)
 *   - mix-demo.m4a      bright-pluck under a ducking envelope + effects placed as a 30 s video would
 *   - index.json        key, tempo, loudness and render time of each file
 * Everything is synthesized by our own code: no samples, no third-party audio.
 *
 *   pnpm run audio:samples [-- --seconds 30 --seed sample-1 --out fixtures/audio-samples]
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MUSIC_MOOD_INFO, MUSIC_MOODS, SFX_KINDS, SFX_SPECS, type SfxKind } from "@muselaunch/contracts";
import { encodeM4a, integratedLoudness, renderMusic, renderSfx } from "@muselaunch/media";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const root = fileURLToPath(new URL("..", import.meta.url));
const out = resolve(root, arg("out", "fixtures/audio-samples"));
const seconds = Number(arg("seconds", "30"));
const seed = arg("seed", "sample-1");
const SR = 48_000;
mkdirSync(out, { recursive: true });

const index: Record<string, unknown> = { generatedBy: "scripts/audio-samples.ts", note: "Synthesized by MuseLaunch's own code (no samples). Regenerate with `pnpm run audio:samples`.", seed, seconds, files: {} as Record<string, unknown> };
const files = index.files as Record<string, unknown>;
const lufs = (l: Float32Array, r: Float32Array) => Math.round(integratedLoudness({ L: l, R: r, length: l.length } as never) * 10) / 10;

for (const mood of MUSIC_MOODS) {
  const cpu = process.cpuUsage();
  const m = renderMusic({ mood, durationSec: seconds, seed, accents: [seconds * 0.66] });
  const used = process.cpuUsage(cpu);
  const file = `${mood}.m4a`;
  await encodeM4a(m.left, m.right, m.sampleRate, join(out, file), { bitrateK: 128, title: `MuseLaunch original music · ${MUSIC_MOOD_INFO[mood].label}` });
  files[file] = { mood, label: MUSIC_MOOD_INFO[mood].label, key: m.key, bpm: Math.round(m.plan.bpm * 10) / 10, bars: m.plan.bars, progression: m.progression, accents: m.plan.accents, lufs: Math.round(m.master.lufs * 10) / 10, peakDb: Math.round(m.master.peakDb * 10) / 10, renderCpuMs: Math.round((used.user + used.system) / 1000), bytes: statSync(join(out, file)).size };
  console.log(`${file.padEnd(22)} ${m.key.padEnd(10)} ${m.plan.bpm.toFixed(1)} BPM  ${m.master.lufs.toFixed(1)} LUFS  peak ${m.master.peakDb.toFixed(1)} dBFS  ${Math.round((used.user + used.system) / 1000)} ms cpu`);
}

// SFX sheet: each effect, 0.7 s of silence between.
{
  const gap = Math.round(0.7 * SR);
  const parts = SFX_KINDS.map((k) => ({ kind: k, ...renderSfx(k) }));
  const total = parts.reduce((n, p) => n + p.left.length + gap, gap);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const at: Record<string, number> = {};
  let pos = gap;
  for (const p of parts) {
    at[p.kind] = Math.round((pos / SR) * 100) / 100;
    L.set(p.left, pos);
    R.set(p.right, pos);
    pos += p.left.length + gap;
  }
  await encodeM4a(L, R, SR, join(out, "sfx-sheet.m4a"), { bitrateK: 128, title: "MuseLaunch original sound effects" });
  files["sfx-sheet.m4a"] = { order: SFX_KINDS, startsAtSec: at, bytes: statSync(join(out, "sfx-sheet.m4a")).size };
  console.log(`sfx-sheet.m4a          ${SFX_KINDS.join(", ")}`);
}

// Mix demo: music at track volume 0.8, ducked to 0.3 where a voice would speak (4–9 s, 12–19 s),
// effects at their default levels on a typical 30 s video's transitions, taps and end card.
{
  const m = renderMusic({ mood: "bright-pluck", durationSec: seconds, seed: `${seed}-mix`, accents: [seconds - 6] });
  const n = m.left.length;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const speech: [number, number][] = [
    [4, 9],
    [12, Math.min(19, seconds - 8)],
  ];
  const gainAt = (t: number) => {
    let g = 1;
    for (const [a, b] of speech) {
      if (t >= a - 0.15 && t < a) g = Math.min(g, 1 - ((t - (a - 0.15)) / 0.15) * (1 - 0.375));
      else if (t >= a && t <= b) g = Math.min(g, 0.375);
      else if (t > b && t < b + 0.45) g = Math.min(g, 0.375 + ((t - b) / 0.45) * (1 - 0.375));
    }
    return 0.8 * g;
  };
  for (let i = 0; i < n; i++) {
    const g = gainAt(i / SR);
    L[i] = m.left[i]! * g;
    R[i] = m.right[i]! * g;
  }
  const cues: [SfxKind, number][] = [
    ["whoosh", 3.25],
    ["tap", 6.4],
    ["swoosh-up", 10.25],
    ["tap", 14.2],
    ["whoosh", 20.25],
    ["shimmer", seconds - 5.6],
  ];
  for (const [kind, peak] of cues) {
    const s = renderSfx(kind);
    const start = Math.round((peak - SFX_SPECS[kind].peakSec) * SR);
    const v = SFX_SPECS[kind].volume;
    for (let i = 0; i < s.left.length && start + i < n; i++) {
      if (start + i < 0) continue;
      L[start + i]! += s.left[i]! * v;
      R[start + i]! += s.right[i]! * v;
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  await encodeM4a(L, R, SR, join(out, "mix-demo.m4a"), { bitrateK: 128, title: "MuseLaunch mix demo (music ducked where a voice would speak, effects)" });
  files["mix-demo.m4a"] = { music: "bright-pluck", duckedWhereVoiceSpeaksSec: speech, effects: cues.map(([k, t]) => ({ kind: k, atSec: t })), lufs: lufs(L, R), peakDb: Math.round(20 * Math.log10(peak) * 10) / 10, bytes: statSync(join(out, "mix-demo.m4a")).size };
  console.log(`mix-demo.m4a           ${lufs(L, R)} LUFS, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
}

writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`\nWrote ${Object.keys(files).length} files to ${out}`);
