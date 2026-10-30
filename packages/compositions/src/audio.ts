/**
 * Sound for compositions (pure; Node + browser): attach original music, auto-placed sound effects
 * and a voiceover to a doc, and compile audio tracks to HyperFrames `<audio>` clips with music
 * ducked under speech by a volume-automation lane (`data-automation`).
 *
 * The build pipeline renders/fetches the assets (packages/media) and calls `attachAudio` once.
 */
import {
  SFX_SPECS,
  type AudioTrack,
  type CaptionCue,
  type CompositionDoc,
  type MusicMood,
  type SfxKind,
  type SpeechRange,
  type VoiceoverCheck,
} from "@muselaunch/contracts";
import { round3, sceneStarts, totalDuration } from "./validate";

/** Transitions that move the frame get a whoosh; zooms get the rising swoosh. */
const WHOOSH_TRANSITIONS = new Set(["slide-left", "slide-up", "wipe"]);
const SWOOSH_TRANSITIONS = new Set(["zoom"]);
/** Tap moments come from tap blocks (Track 2's tap-demo uses them too) or the tap-demo template. */
const TAP_TEMPLATE = "tap-demo";
const CTA_TEMPLATE = "cta-endcard";
const MAX_AUDIO_TRACKS = 48;

/** Default levels (track volume, 0..1). Music sits under a voice by ~11 dB when ducked. */
export const SOUND_LEVELS = { music: 0.8, musicDucked: 0.3, voice: 1, sfxUnderVoice: 0.75 } as const;

export interface SfxCue {
  kind: SfxKind;
  /** Timeline second where the effect lands (its peak). */
  at: number;
  sceneId: string;
  reason: "transition" | "tap" | "cta";
}

/** Where effects belong in a doc: moving transitions, taps on the UI, the end card. */
export function placeSfx(doc: CompositionDoc): SfxCue[] {
  if (doc.kind !== "video") return [];
  const starts = sceneStarts(doc);
  const total = totalDuration(doc);
  const cues: SfxCue[] = [];
  doc.scenes.forEach((s, i) => {
    const start = starts[i]!;
    const tr = s.transitionIn;
    if (i > 0 && tr.durationSec > 0) {
      if (WHOOSH_TRANSITIONS.has(tr.kind)) cues.push({ kind: "whoosh", at: start + tr.durationSec / 2, sceneId: s.id, reason: "transition" });
      else if (SWOOSH_TRANSITIONS.has(tr.kind)) cues.push({ kind: "swoosh-up", at: start + tr.durationSec / 2, sceneId: s.id, reason: "transition" });
    }
    let taps = 0;
    for (const l of s.layers) {
      if (l.hidden || l.type !== "block" || !/tap/i.test(l.blockId)) continue;
      const atSec = typeof l.params.atSec === "number" ? l.params.atSec : 0.5;
      const at = start + l.timing.start + atSec;
      if (at < start + s.durationSec) {
        cues.push({ kind: "tap", at, sceneId: s.id, reason: "tap" });
        taps++;
      }
    }
    if (!taps && s.template === TAP_TEMPLATE) cues.push({ kind: "tap", at: start + Math.min(1, s.durationSec * 0.4), sceneId: s.id, reason: "tap" });
    if (s.template === CTA_TEMPLATE || s.purpose === "cta") {
      const settle = tr.kind !== "cut" ? tr.durationSec * 0.6 : 0;
      cues.push({ kind: "shimmer", at: start + settle + 0.25, sceneId: s.id, reason: "cta" });
    }
  });
  // In time order; effects closer than 0.25 s to the previous one are dropped (no pile-ups).
  const out: SfxCue[] = [];
  for (const c of cues.sort((a, b) => a.at - b.at)) {
    if (c.at >= total - 0.05) continue;
    if (out.length && c.at - out[out.length - 1]!.at < 0.25) continue;
    out.push({ ...c, at: round3(c.at) });
  }
  return out;
}

/** Music accents (riser into a soft hit) for a doc: the end card's entrance. */
export function musicAccents(doc: CompositionDoc): number[] {
  const starts = sceneStarts(doc);
  const out: number[] = [];
  doc.scenes.forEach((s, i) => {
    if (i > 0 && (s.template === CTA_TEMPLATE || s.purpose === "cta") && starts[i]! >= 3) out.push(starts[i]!);
  });
  return out.slice(-1);
}

export interface AttachMusic {
  assetId: string;
  mood: MusicMood;
  volume?: number;
  label?: string;
}

export interface AttachVoiceover {
  assetId: string;
  durationSec: number;
  sourceLabel: "external_tts" | "founder_recording" | "user_upload";
  /** Timeline second the voice starts (default 0.25 s, so the first word isn't on frame 0). */
  startSec?: number;
  trimInSec?: number;
  /** Spoken stretches, track-local (Muse Voice Transcribe turns). */
  speech?: SpeechRange[];
  check?: VoiceoverCheck;
  label?: string;
  /** Caption cues, track-local; shifted onto the timeline. */
  captions?: CaptionCue[];
  transcriptId?: string;
}

export interface AttachAudioOptions {
  /** Replace all music with this original track; `null` removes music; omitted keeps it. */
  music?: AttachMusic | null;
  /** Automatic effects: re-placed from the current scenes (or removed when disabled). */
  sfx?: { enabled: boolean; assets: Partial<Record<SfxKind, string>>; volume?: number };
  /** Replace the voiceover; `null` removes it (and its transcript captions); omitted keeps it. */
  voiceover?: AttachVoiceover | null;
}

const isVoice = (t: AudioTrack) => t.kind === "voiceover";

/**
 * Attach sound to a doc (pure). User tracks are kept unless the option replaces their kind;
 * automatic effects (`auto: true`) are always re-placed for the current scene timing.
 */
export function attachAudio(doc: CompositionDoc, opts: AttachAudioOptions): CompositionDoc {
  if (doc.kind !== "video") return doc;
  const total = totalDuration(doc);
  let audio = doc.audio.map((t) => ({ ...t }));
  let captions = doc.captions;

  if (opts.voiceover !== undefined) {
    const hadTranscriptCaptions = captions.source === "transcript";
    audio = audio.filter((t) => !isVoice(t));
    if (opts.voiceover) {
      const v = opts.voiceover;
      const start = round3(Math.max(0, Math.min(v.startSec ?? 0.25, Math.max(0, total - 0.5))));
      const end = round3(Math.min(total, start + Math.max(0.1, v.durationSec - (v.trimInSec ?? 0))));
      audio.unshift({
        id: "aud_voiceover",
        kind: "voiceover",
        assetId: v.assetId,
        startSec: start,
        endSec: end,
        trimInSec: v.trimInSec ?? 0,
        volume: SOUND_LEVELS.voice,
        fadeInSec: 0,
        fadeOutSec: end < start + v.durationSec - 0.05 ? 0.4 : 0.15,
        duckUnderVoice: false,
        sourceLabel: v.sourceLabel,
        label: v.label ?? (v.sourceLabel === "external_tts" ? "AI voiceover (external TTS)" : "Your voice"),
        ...(v.speech?.length ? { speech: v.speech.slice(0, 200).map((r) => ({ startSec: round3(r.startSec), endSec: round3(r.endSec) })) } : {}),
        ...(v.check ? { check: v.check } : {}),
      });
      if (v.captions?.length) {
        const cues = v.captions
          .map((c) => ({ ...c, startSec: round3(c.startSec + start), endSec: round3(Math.min(total, c.endSec + start)) }))
          .filter((c) => c.startSec < total && c.endSec > c.startSec)
          .slice(0, 400);
        captions = { ...captions, enabled: true, source: "transcript", transcriptId: v.transcriptId, cues };
      }
    } else if (hadTranscriptCaptions) {
      captions = { ...captions, enabled: false, source: "script", transcriptId: undefined, cues: [] };
    }
  }

  const hasVoice = audio.some(isVoice);
  if (opts.music !== undefined) {
    audio = audio.filter((t) => t.kind !== "music");
    if (opts.music) {
      const m = opts.music;
      audio.push({
        id: "aud_music",
        kind: "music",
        assetId: m.assetId,
        startSec: 0,
        endSec: total,
        trimInSec: 0,
        volume: m.volume ?? SOUND_LEVELS.music,
        fadeInSec: 0,
        fadeOutSec: 0.6,
        duckUnderVoice: true,
        sourceLabel: "original_music",
        auto: true,
        mood: m.mood,
        label: m.label ?? "Original music",
      });
    }
  }

  if (opts.sfx) {
    audio = audio.filter((t) => !(t.kind === "sfx" && t.auto));
    if (opts.sfx.enabled) {
      const room = MAX_AUDIO_TRACKS - audio.length;
      const mul = (opts.sfx.volume ?? 1) * (hasVoice ? SOUND_LEVELS.sfxUnderVoice : 1);
      const cues = placeSfx(doc).filter((c) => opts.sfx!.assets[c.kind]);
      cues.slice(0, Math.max(0, room)).forEach((c, i) => {
        const spec = SFX_SPECS[c.kind];
        const start = round3(Math.max(0, c.at - spec.peakSec));
        const sceneNo = doc.scenes.findIndex((s) => s.id === c.sceneId) + 1;
        audio.push({
          id: `sfx_auto_${i + 1}`,
          kind: "sfx",
          assetId: opts.sfx!.assets[c.kind]!,
          startSec: start,
          endSec: round3(Math.min(total, start + spec.durationSec)),
          trimInSec: 0,
          volume: round3(Math.min(1, spec.volume * mul)),
          fadeInSec: 0,
          fadeOutSec: 0,
          duckUnderVoice: false,
          sourceLabel: "original_sfx",
          auto: true,
          sfx: c.kind,
          label: `${spec.label} · ${c.reason === "transition" ? `into scene ${sceneNo}` : c.reason === "tap" ? `tap in scene ${sceneNo}` : "end card"}`,
        });
      });
    }
  }
  return { ...doc, audio, captions };
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

/** Timeline ranges where someone speaks (merged when the gap is short, so music doesn't pump). */
export function speechRanges(doc: Pick<CompositionDoc, "audio">, total: number): [number, number][] {
  const raw: [number, number][] = [];
  for (const v of doc.audio) {
    if (!isVoice(v)) continue;
    const end = Math.min(v.endSec ?? total, total);
    const local = v.speech?.length ? v.speech : [{ startSec: 0, endSec: end - v.startSec + v.trimInSec }];
    for (const r of local) {
      const a = v.startSec + r.startSec - v.trimInSec;
      const b = Math.min(end, v.startSec + r.endSec - v.trimInSec);
      if (b > a && b > v.startSec) raw.push([Math.max(v.startSec, a), b]);
    }
  }
  raw.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r[0] - last[1] < 0.9) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * HyperFrames volume-automation lane (clip-local seconds) that dips music to `duck` while someone
 * speaks: 150 ms down before each phrase, 450 ms back up after it.
 */
export function duckingLane(track: Pick<AudioTrack, "startSec">, clipDuration: number, ranges: [number, number][], duck: number): string | null {
  const pts: { t: number; v: number }[] = [];
  const add = (t: number, v: number) => {
    const tt = num(Math.min(clipDuration, Math.max(0, t)));
    const last = pts[pts.length - 1];
    if (last && tt <= last.t) {
      if (tt === last.t) last.v = Math.min(last.v, v);
      return;
    }
    pts.push({ t: tt, v });
  };
  for (const [a0, b0] of ranges) {
    const a = a0 - track.startSec;
    const b = b0 - track.startSec;
    if (b <= 0 || a >= clipDuration) continue;
    add(a - 0.15, 1);
    add(a, duck);
    add(b, duck);
    add(b + 0.45, 1);
  }
  if (!pts.length) return null;
  if (pts[0]!.t > 0) pts.unshift({ t: 0, v: 1 });
  return JSON.stringify({ version: 1, lanes: [{ target: "volume", points: pts.slice(0, 500) }] });
}

/**
 * `<audio>` clips for the doc's tracks. Music with `duckUnderVoice` gets a ducking lane when a
 * voice is present (static ×0.35 fallback when no speech can be located).
 */
export function compileAudioTags(doc: CompositionDoc, total: number, assetUrl: (assetId: string) => string, used: Set<string>): string {
  const ranges = speechRanges(doc, total);
  const hasVoice = doc.audio.some(isVoice);
  return doc.audio
    .filter((a) => a.startSec < total)
    .map((a, i) => {
      used.add(a.assetId);
      const end = Math.min(a.endSec ?? total, total);
      const dur = end - a.startSec;
      let vol = a.volume;
      let lane: string | null = null;
      if (a.kind === "music" && hasVoice && a.duckUnderVoice) {
        lane = duckingLane(a, dur, ranges, SOUND_LEVELS.musicDucked / SOUND_LEVELS.music);
        if (!lane) vol = a.volume * 0.35;
      }
      return `<audio id="a-${a.id}" src="${esc(assetUrl(a.assetId))}" data-start="${num(a.startSec)}" data-duration="${num(dur)}" data-media-start="${num(a.trimInSec)}" data-volume="${num(vol)}" data-fade-in="${num(a.fadeInSec)}" data-fade-out="${num(a.fadeOutSec)}"${lane ? ` data-automation="${esc(lane)}"` : ""} data-track-index="${100 + i}" preload="auto"></audio>`;
    })
    .join("\n");
}
