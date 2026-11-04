import { MUSIC_MOOD_INFO, MUSIC_MOODS, type CompositionDoc } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { beatGrid, beatSyncBlocker, cutsOnGrid, readableSec, ringOutSec, snapDurations, snapToBeats, tempoFor } from "./beats";
import { captionAccent, compileToHtml } from "./compile";
import { captionPages, captionWordTimes, syllables } from "./karaoke";
import { sampleDoc } from "./test-fixtures";
import { sceneStarts, totalDuration, validateDoc } from "./validate";

const onGrid = (t: number, beat: number) => Math.abs(t / beat - Math.round(t / beat)) * beat < 0.0015;

describe("beat sync", () => {
  it("picks a deterministic tempo inside each mood's range", () => {
    for (const mood of MUSIC_MOODS) {
      const [lo, hi] = MUSIC_MOOD_INFO[mood].bpm;
      const t = tempoFor(mood, "cmp_1");
      expect(t).toBeGreaterThanOrEqual(lo);
      expect(t).toBeLessThanOrEqual(hi);
      expect(tempoFor(mood, "cmp_1")).toBe(t);
    }
    expect(tempoFor("bright-pluck", "cmp_1")).not.toBe(tempoFor("bright-pluck", "cmp_2"));
  });

  it("puts every cut on a beat within ±20 %, never below the minimum, preferring bars", () => {
    const grid = beatGrid(120); // beat 0.5 s, bar 2 s
    const planned = [1.8, 3.3, 2.9, 4.1, 3.6];
    const min = [1.5, 3.2, 1.2, 1.2, 2.5];
    const out = snapDurations(planned, grid, { min });
    let t = 0;
    out.forEach((d, i) => {
      expect(Math.abs(d - planned[i]!)).toBeLessThanOrEqual(planned[i]! * 0.2 + 1e-9);
      expect(d).toBeGreaterThanOrEqual(min[i]! - 1e-9);
      t += d;
      if (i < out.length - 1) expect(onGrid(t, 0.5)).toBe(true);
    });
    // 1.8 s planned → the bar at 2.0 s beats the beat at 1.5 s.
    expect(out[0]).toBe(2);
    // The video ends on whole bars + the ring-out.
    const content = t - ringOutSec(t - ringOutSec(t));
    expect(Math.abs(content / 2 - Math.round(content / 2))).toBeLessThan(0.05);
  });

  it("snaps a doc (layers retimed, beat grid recorded) and counts its cuts on the grid", () => {
    const doc = sampleDoc(); // 3 + 5 + 3 s
    const grid = beatGrid(tempoFor("tech-pulse", "x"));
    const s = snapToBeats(doc, grid);
    expect(s.doc.beat).toEqual({ bpm: grid.bpm, offsetSec: 0 });
    expect(s.onBeat).toBe(2);
    expect(cutsOnGrid(s.doc, grid)).toEqual({ cuts: 2, onBeat: 2, onBar: s.onBar });
    for (const t of sceneStarts(s.doc).slice(1)) expect(onGrid(t, grid.beatSec)).toBe(true);
    expect(validateDoc(s.doc).ok).toBe(true);
    // A hook needs ≥ 1.5 s and reading time; the end card ≥ 2.5 s.
    expect(readableSec(doc.scenes[0]!, 0)).toBeGreaterThanOrEqual(1.5);
    expect(readableSec(doc.scenes[2]!, 2)).toBeGreaterThanOrEqual(2.5);
    // A narrated video's continuous voice: the video outlasts it.
    expect(totalDuration(snapToBeats(doc, grid, { minTotalSec: 12.5 }).doc)).toBeGreaterThanOrEqual(12.5);
  });

  it("never re-cuts footage that carries its own sound or a founder's voice", () => {
    const doc = sampleDoc();
    expect(beatSyncBlocker(doc)).toBeNull();
    const voiced: CompositionDoc = { ...doc, audio: [{ id: "aud_voiceover", kind: "voiceover", assetId: "ast_v", startSec: 0, trimInSec: 0, volume: 1, fadeInSec: 0, fadeOutSec: 0.2, duckUnderVoice: false, sourceLabel: "founder_recording" }] };
    expect(beatSyncBlocker(voiced)).toMatch(/founder/);
    const clip = structuredClone(doc);
    clip.scenes[1]!.layers.push({ id: "ly_clip", type: "video", assetId: "ast_clip", fit: "cover", trimInSec: 0, playbackRate: 1, muted: false, volume: 1, radiusPx: 0, box: { x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, z: 1 }, timing: { start: 0 }, animation: { loop: "none" }, locked: false, hidden: false } as never);
    expect(beatSyncBlocker(clip)).toMatch(/own sound/);
  });
});

describe("karaoke captions", () => {
  it("times words by syllables inside the cue, with pauses at punctuation", () => {
    expect(syllables("Focusly")).toBe(3);
    expect(syllables("taps")).toBe(1);
    const w = captionWordTimes("Meet Focusly, the calm planner.", 2, 4);
    expect(w.map((x) => x.word)).toEqual(["Meet", "Focusly,", "the", "calm", "planner."]);
    for (let i = 1; i < w.length; i++) expect(w[i]!.at).toBeGreaterThanOrEqual(w[i - 1]!.until);
    expect(w[0]!.at).toBeGreaterThanOrEqual(2);
    expect(w[w.length - 1]!.until).toBeLessThanOrEqual(4);
    // "Focusly" (3 syllables) takes longer than "Meet"; the comma leaves a gap before "the".
    expect(w[1]!.until - w[1]!.at).toBeGreaterThan(w[0]!.until - w[0]!.at);
    expect(w[2]!.at - w[1]!.until).toBeGreaterThan(0.05);
  });

  it("breaks pages at clauses when a comma is close", () => {
    expect(captionPages("Plan your whole day in three taps, then get back to work.", 0, 4).map((p) => p.words.map((x) => x.word).join(" "))).toEqual(["Plan your whole day", "in three taps,", "then get back to work."]);
    expect(captionPages("Meet Focusly, the calm planner.", 0, 2).map((p) => p.words.length)).toEqual([5]);
  });

  it("pages a long line into short phrases (≤ 6 words, ≤ 32 characters, new page after a sentence)", () => {
    const pages = captionPages("Plan your whole day in three taps. Then get back to the work that actually matters to you.", 0, 6);
    // Balanced inside each sentence, never straddling two (no "…three / taps." orphan).
    expect(pages.map((p) => p.words.map((x) => x.word).join(" "))).toEqual(["Plan your whole day", "in three taps.", "Then get back to the work", "that actually matters to you."]);
    for (const p of pages) {
      expect(p.words.length).toBeLessThanOrEqual(6);
      expect(p.words.map((x) => x.word).join(" ").length).toBeLessThanOrEqual(32);
    }
    for (let i = 1; i < pages.length; i++) expect(pages[i]!.start).toBe(pages[i - 1]!.end);
    expect(pages[0]!.start).toBe(0);
    expect(pages[pages.length - 1]!.end).toBe(6);
  });

  it("compiles word-pop captions as phrases whose spoken word lights up in the accent", () => {
    const doc = sampleDoc();
    doc.captions = { enabled: true, preset: "word-pop", position: "bottom", source: "transcript", cues: [{ id: "cue_1", startSec: 0.3, endSec: 2.6, text: "Meet Focusly, the calm planner." }] };
    const html = compileToHtml(doc, { assetUrl: (id) => id, mode: "render", gsapSource: "https://cdn.example/gsap.js" }).html;
    expect(html).toContain('id="c-cue_1-p0"');
    expect(html).toContain('id="c-cue_1-p0-w1" class="kw"');
    expect(html).toContain(">Focusly,</span>");
    expect(html).toMatch(/tl\.fromTo\(q\("c-cue_1-p0-w1"\), \{opacity:0\.5, scale:1, color:"#FFFFFF"\}, \{opacity:1, scale:1\.06, color:"#0A84FF"/);
    expect(html).toMatch(/tl\.fromTo\(q\("c-cue_1-p0-w0"\), \{scale:1\.06, color:"#0A84FF"\}, \{scale:1, color:"#FFFFFF"/);
    // Still frames (thumbnails): every word at full strength, no dimming.
    const still = compileToHtml(doc, { assetUrl: (id) => id, mode: "render", gsapSource: "https://cdn.example/gsap.js", still: true }).html;
    expect(still).not.toContain("opacity:.5");
    // Other presets keep one block per cue.
    doc.captions.preset = "boxed";
    expect(compileToHtml(doc, { assetUrl: (id) => id, mode: "render", gsapSource: "x" }).html).toContain('id="c-cue_1" class="cap clip"');
  });

  it("lifts a dark accent so the highlighted word stays readable on footage", () => {
    expect(captionAccent("#0A84FF")).toBe("#0A84FF");
    expect(captionAccent("#1B1464")).not.toBe("#1B1464");
    expect(captionAccent("theme.accent")).toBe("#FFD60A");
  });
});

describe("beat sync respects the plan's longest video", () => {
  it("never ends past maxTotalSec, even when the nearest bar ending is later", () => {
    const grid = beatGrid(97);
    const planned = [4, 5, 5, 5.9];
    const free = snapDurations(planned, grid);
    const capped = snapDurations(planned, grid, { maxTotalSec: 20 });
    expect(capped.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20 + 1e-6);
    expect(capped.slice(0, -1)).toEqual(free.slice(0, -1)); // the cuts before the ending stay on the beat
  });
});
