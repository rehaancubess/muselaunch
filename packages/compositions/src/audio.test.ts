import type { CompositionDoc, Layer } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { attachAudio, compileAudioTags, duckingLane, musicAccents, placeSfx, soundStale, speechRanges } from "./audio";
import { compileToHtml } from "./compile";
import { ensureNodeCompileRuntime } from "./node";
import { sampleDoc } from "./test-fixtures";
import { totalDuration, validateDoc } from "./validate";

const SFX = { whoosh: "ast_sfx_whoosh_v1", "swoosh-up": "ast_sfx_swooshup_v1", tap: "ast_sfx_tap_v1", shimmer: "ast_sfx_shimmer_v1" } as const;

/** Hook (3 s) → zoom → demo with a tap block (5 s) → slide-up → tap-demo (4 s) → fade → CTA (3 s). */
function doc(): CompositionDoc {
  const d = sampleDoc();
  const tapBlock = { id: "sc_demo_tap", type: "block", blockId: "tap-indicator", params: { atSec: 1.4 }, box: { x: 0.4, y: 0.5, w: 0.1, h: 0.06 }, timing: { start: 0.2 }, animation: { loop: "none" }, locked: false, hidden: false } as unknown as Layer;
  const scenes = [
    d.scenes[0]!,
    { ...d.scenes[1]!, transitionIn: { kind: "zoom" as const, durationSec: 0.5 }, layers: [...d.scenes[1]!.layers, tapBlock] },
    { ...d.scenes[1]!, id: "sc_tapdemo", name: "Tap demo", template: "tap-demo", durationSec: 4, transitionIn: { kind: "slide-up" as const, durationSec: 0.6 }, layers: d.scenes[1]!.layers.map((l) => ({ ...l, id: `${l.id}_2` })) },
    { ...d.scenes[2]!, transitionIn: { kind: "fade" as const, durationSec: 0.5 } },
  ];
  return { ...d, scenes };
}

describe("placeSfx", () => {
  it("puts a swoosh on zooms, a whoosh on slides/wipes, taps on tap blocks and tap-demo scenes, and a shimmer on the end card", () => {
    const d = doc();
    const cues = placeSfx(d);
    expect(cues.map((c) => [c.kind, c.at, c.reason])).toEqual([
      ["swoosh-up", 3.25, "transition"], // zoom into scene 2 at 3 s, middle of the 0.5 s transition
      ["tap", 4.6, "tap"], // scene 2 starts at 3 s; block at +0.2 s fires at atSec 1.4
      ["whoosh", 8.3, "transition"], // slide-up into scene 3 at 8 s (0.6 s)
      ["tap", 9, "tap"], // tap-demo without a tap block: 1 s in
      ["shimmer", 12.55, "cta"], // CTA at 12 s; after 60 % of its 0.5 s fade + 0.25 s
    ]);
    // fades and cuts get nothing
    expect(placeSfx(sampleDoc()).map((c) => c.kind)).toEqual(["shimmer"]);
  });

  it("never stacks effects closer than 0.25 s and nothing after the end", () => {
    const d = doc();
    const tap2 = { ...(d.scenes[1]!.layers.at(-1) as Layer), id: "sc_demo_tap2", params: { atSec: 1.5 } } as Layer;
    d.scenes[1] = { ...d.scenes[1]!, layers: [...d.scenes[1]!.layers, tap2] };
    const cues = placeSfx(d);
    expect(cues.filter((c) => c.kind === "tap" && c.sceneId === "sc_demo")).toHaveLength(1);
    expect(cues.every((c) => c.at < totalDuration(d))).toBe(true);
  });
});

describe("attachAudio", () => {
  const voice = { assetId: "ast_vo", durationSec: 9, sourceLabel: "external_tts" as const, speech: [{ startSec: 0.1, endSec: 3.9 }, { startSec: 5.2, endSec: 8.8 }], captions: [{ id: "c1", startSec: 0.1, endSec: 3.9, text: "Meet Focusly." }], transcriptId: "trn_1", check: { wer: 0.04, passed: true, attempts: 1 } };

  it("adds original music, auto effects and a labelled AI voice; the doc stays valid", () => {
    const d = attachAudio(doc(), { music: { assetId: "ast_mus_1", mood: "bright-pluck" }, sfx: { enabled: true, assets: SFX }, voiceover: voice });
    const v = validateDoc(d);
    // "tap-demo" is Track 2's new template; until it lands in TEMPLATE_IDS only that error may appear.
    expect(v.ok ? [] : v.errors.filter((e) => !e.includes('"tap-demo" is not an allowlisted template'))).toEqual([]);
    const music = d.audio.find((a) => a.kind === "music")!;
    expect(music).toMatchObject({ sourceLabel: "original_music", auto: true, mood: "bright-pluck", startSec: 0, endSec: totalDuration(d), duckUnderVoice: true });
    const vo = d.audio.find((a) => a.kind === "voiceover")!;
    expect(vo).toMatchObject({ sourceLabel: "external_tts", startSec: 0.25, endSec: 9.25, check: { passed: true } });
    const fx = d.audio.filter((a) => a.kind === "sfx");
    expect(fx.map((a) => a.sfx)).toEqual(["swoosh-up", "tap", "whoosh", "tap", "shimmer"]);
    expect(fx.every((a) => a.auto && a.sourceLabel === "original_sfx" && a.label)).toBe(true);
    // effects are quieter under a voice; the whoosh lands (its peak) mid-transition
    const whoosh = fx.find((a) => a.sfx === "whoosh")!;
    expect(whoosh.startSec).toBeCloseTo(8.3 - 0.5, 3);
    expect(whoosh.volume).toBeCloseTo(0.32 * 0.75, 3);
    // captions follow the voice on the timeline (shifted by its start)
    expect(d.captions).toMatchObject({ enabled: true, source: "transcript", transcriptId: "trn_1" });
    expect(d.captions.cues[0]).toMatchObject({ startSec: 0.35, endSec: 4.15 });
  });

  it("re-places only automatic effects, keeps user tracks, and removes cleanly", () => {
    let d = attachAudio(doc(), { music: { assetId: "ast_mus_1", mood: "calm-pad" }, sfx: { enabled: true, assets: SFX } });
    d = { ...d, audio: [...d.audio, { id: "my_sfx", kind: "sfx", assetId: "ast_user", startSec: 1, trimInSec: 0, volume: 0.5, fadeInSec: 0, fadeOutSec: 0, duckUnderVoice: false, sourceLabel: "user_upload" }] };
    // a scene got longer: effects move with it
    d = { ...d, scenes: d.scenes.map((s) => (s.id === "sc_hook" ? { ...s, durationSec: 4 } : s)) };
    const moved = attachAudio(d, { sfx: { enabled: true, assets: SFX } });
    expect(moved.audio.find((a) => a.sfx === "swoosh-up")!.startSec).toBeCloseTo(4.25 - 0.42, 3);
    expect(moved.audio.find((a) => a.id === "my_sfx")).toBeTruthy();
    const off = attachAudio(moved, { sfx: { enabled: false, assets: {} }, music: null });
    expect(off.audio.map((a) => a.id)).toEqual(["my_sfx"]);
    const withVoice = attachAudio(off, { voiceover: voice });
    const noVoice = attachAudio(withVoice, { voiceover: null });
    expect(noVoice.audio.some((a) => a.kind === "voiceover")).toBe(false);
    expect(noVoice.captions).toMatchObject({ enabled: false, source: "script", cues: [] });
  });

  it("notices when scene edits leave the automatic sound behind", () => {
    const d = attachAudio(doc(), { music: { assetId: "ast_mus_1", mood: "bright-pluck" }, sfx: { enabled: true, assets: SFX } });
    expect(soundStale(d)).toEqual({ music: false, sfx: false });
    const trimmed = { ...d, scenes: d.scenes.map((s) => (s.id === "sc_hook" ? { ...s, durationSec: 2 } : s)) };
    expect(soundStale(trimmed)).toEqual({ music: true, sfx: true });
    const refit = attachAudio(trimmed, { music: { assetId: "ast_mus_2", mood: "bright-pluck" }, sfx: { enabled: true, assets: SFX } });
    expect(soundStale(refit)).toEqual({ music: false, sfx: false });
  });

  it("stays within the 48-track limit with many effects", () => {
    const d = doc();
    const many = { ...d, scenes: Array.from({ length: 30 }, (_, i) => ({ ...d.scenes[1]!, id: `sc_${i}`, durationSec: 2, transitionIn: { kind: "wipe" as const, durationSec: 0.3 }, layers: d.scenes[1]!.layers.map((l) => ({ ...l, id: `${l.id}_${i}` })) })) };
    const out = attachAudio(many, { music: { assetId: "ast_m", mood: "tech-pulse" }, sfx: { enabled: true, assets: SFX } });
    expect(out.audio.length).toBeLessThanOrEqual(48);
    expect(validateDoc(out).ok).toBe(true);
  });

  it("leaves static docs alone and accents the end card for the music", () => {
    const st = { ...sampleDoc(), kind: "static" as const };
    expect(attachAudio(st, { music: { assetId: "x", mood: "calm-pad" } })).toBe(st);
    expect(musicAccents(doc())).toEqual([12]);
  });
});

describe("audio compile (HyperFrames)", () => {
  it("ducks music under speech with a volume-automation lane, and keeps it full without a voice", () => {
    const d = attachAudio(doc(), { music: { assetId: "ast_mus_1", mood: "bright-pluck" }, sfx: { enabled: true, assets: SFX }, voiceover: { assetId: "ast_vo", durationSec: 9, sourceLabel: "external_tts", speech: [{ startSec: 0.1, endSec: 3.9 }, { startSec: 5.2, endSec: 8.8 }] } });
    const total = totalDuration(d);
    expect(speechRanges(d, total)).toEqual([
      [0.35, 4.15],
      [5.45, 9.05],
    ]);
    const used = new Set<string>();
    const html = compileAudioTags(d, total, (id) => `assets/${id}.m4a`, used);
    const music = /<audio id="a-aud_music"[^>]*>/.exec(html)![0];
    expect(music).toContain('data-volume="0.8"');
    const lane = JSON.parse(/data-automation="([^"]+)"/.exec(music)![1]!.replace(/&quot;/g, '"')) as { version: number; lanes: { target: string; points: { t: number; v: number }[] }[] };
    expect(lane.version).toBe(1);
    const pts = lane.lanes[0]!.points;
    expect(lane.lanes[0]!.target).toBe("volume");
    expect(pts[0]).toEqual({ t: 0, v: 1 });
    expect(pts.find((p) => p.t === 0.35)?.v).toBeCloseTo(0.375, 3);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.t).toBeGreaterThan(pts[i - 1]!.t);
    expect(pts.at(-1)!.v).toBe(1);
    expect(html.match(/<audio /g)).toHaveLength(d.audio.length);
    expect(used.has("ast_vo") && used.has("ast_mus_1") && used.has(SFX.shimmer)).toBe(true);
    // no voice → no lane, full level
    const plain = compileAudioTags(attachAudio(doc(), { music: { assetId: "ast_mus_1", mood: "bright-pluck" } }), total, (id) => id, new Set());
    expect(plain).not.toContain("data-automation");
  });

  it("falls back to a static duck when a voice has no locatable speech beyond its span", () => {
    expect(duckingLane({ startSec: 0 }, 10, [], 0.4)).toBeNull();
  });

  it("compileToHtml carries the audio clips with fades, and still captures render no audio", () => {
    ensureNodeCompileRuntime();
    const d = attachAudio(doc(), { music: { assetId: "ast_mus_1", mood: "warm-keys" }, sfx: { enabled: true, assets: SFX } });
    const { html, assetIds } = compileToHtml(d, { assetUrl: (id) => `assets/${id}.m4a`, mode: "render", gsapSource: "inline" });
    expect(html).toMatch(/<audio id="a-aud_music" src="assets\/ast_mus_1.m4a" data-start="0" data-duration="15"[^>]*data-fade-out="0.6"/);
    expect(html).toContain('id="a-sfx_auto_1"');
    expect(assetIds).toContain("ast_mus_1");
    const still = compileToHtml(d, { assetUrl: (id) => id, mode: "render", gsapSource: "inline", still: true });
    expect(still.html).not.toContain("<audio");
  });
});
