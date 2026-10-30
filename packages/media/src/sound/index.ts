/**
 * Sound pass for compositions (Track 3): original music + automatic sound effects by default, AI
 * voiceover when the workspace allows it and the storyboard asks for narration, and the Studio's
 * sound jobs (`media.music`, `media.voiceover`). Every change lands as a new composition version.
 */
import {
  DEFAULT_SOUND_SETTINGS,
  MUSIC_MOOD_INFO,
  WorkspaceSoundSettings,
  type App,
  type CompositionDoc,
  type MusicMood,
  type SfxKind,
  type Storyboard,
  type Workspace,
} from "@muselaunch/contracts";
import { attachAudio, musicAccents, totalDuration, validateDoc, type AttachVoiceover } from "@muselaunch/compositions";
import { commitVersion, getVersion } from "@muselaunch/compositions/store";
import { AppError, toAppError, type JobContext, type Platform } from "@muselaunch/platform";
import { ensureMusicAsset, ensureSfxLibrary, moodFromText } from "../music";
import { prepareRecordingVoiceover, produceAiVoiceover, voiceoverCredits, type VoiceoverResult } from "./voiceover";

export { normalizeWords, wordErrorRate, scriptTurns, normalizeVoice, produceAiVoiceover, prepareRecordingVoiceover, voiceoverCredits, VOICE_TARGET_LUFS, type VoiceoverResult } from "./voiceover";

/** Workspace sound defaults (workspaces saved before this existed parse to the defaults). */
export function soundSettings(ws: Pick<Workspace, "settings"> | null | undefined): WorkspaceSoundSettings {
  const raw = (ws?.settings as { sound?: unknown } | undefined)?.sound;
  const parsed = WorkspaceSoundSettings.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_SOUND_SETTINGS };
}

/** The narration a storyboard asks for (its script, else the scenes' narration lines). */
export function narrationScript(sb: Pick<Storyboard, "voiceover" | "scenes"> | null | undefined): string {
  if (!sb) return "";
  const s = sb.voiceover.script?.trim() || [...sb.scenes].sort((a, b) => a.order - b.order).map((x) => x.narration.trim()).filter(Boolean).join(" ");
  return s.replace(/\s+/g, " ").trim().slice(0, 4000);
}

/** Seed of the music currently in a doc (so a voiceover that lengthens the video keeps the same take). */
async function currentMusic(ctx: JobContext, doc: CompositionDoc): Promise<{ mood: MusicMood; seed: string; volume: number } | null> {
  const t = doc.audio.find((a) => a.kind === "music" && a.sourceLabel === "original_music");
  if (!t) return null;
  const asset = await ctx.ws.collection("mediaAssets").get(t.assetId);
  try {
    const params = JSON.parse(asset?.generation?.prompt ?? "{}") as { seed?: string; mood?: MusicMood };
    if (!params.seed) return null;
    return { mood: t.mood ?? params.mood ?? "bright-pluck", seed: params.seed, volume: t.volume };
  } catch {
    return null;
  }
}

/** Lengthen the last scene (≤ 6 s) so a narration isn't cut off. */
function extendForVoice(doc: CompositionDoc, voiceStart: number, voiceSec: number): { doc: CompositionDoc; extendedSec: number } {
  const total = totalDuration(doc);
  const overflow = voiceStart + voiceSec + 0.4 - total;
  if (overflow <= 0.05) return { doc, extendedSec: 0 };
  const last = doc.scenes[doc.scenes.length - 1]!;
  const add = Math.min(overflow, 6, 60 - last.durationSec);
  if (add <= 0) return { doc, extendedSec: 0 };
  const scenes = doc.scenes.map((s, i) => (i === doc.scenes.length - 1 ? { ...s, durationSec: Math.round((s.durationSec + add) * 1000) / 1000 } : s));
  return { doc: { ...doc, scenes }, extendedSec: Math.round(add * 100) / 100 };
}

function voiceAttach(r: VoiceoverResult, sourceLabel: AttachVoiceover["sourceLabel"]): AttachVoiceover {
  return { assetId: r.asset.id, durationSec: r.durationSec, sourceLabel, speech: r.speech, check: r.check, captions: r.captions, transcriptId: r.transcriptId };
}

const VOICE_START = 0.25;

export interface SoundtrackResult {
  doc: CompositionDoc;
  notes: string[];
  warnings: string[];
  music?: { assetId: string; mood: MusicMood; reused: boolean };
  sfx?: number;
  voiceover?: { assetId: string; check?: VoiceoverResult["check"]; credits: number };
}

/**
 * The build pipeline's sound pass (called once from `composition.build`): AI voiceover when the
 * storyboard asks for TTS and the workspace turned AI voice on (credits held and settled here),
 * then original music fitted to the final length and auto-placed effects. Music/SFX failures never
 * block a video: they are reported as warnings.
 */
export async function prepareSoundtrack(ctx: JobContext, input: { doc: CompositionDoc; compositionId: string; appId: string; storyboard?: Storyboard | null; app?: Pick<App, "name"> | null }): Promise<SoundtrackResult> {
  let doc = input.doc;
  const notes: string[] = [];
  const warnings: string[] = [];
  if (doc.kind !== "video") return { doc, notes, warnings };
  const p = ctx.platform;
  const settings = soundSettings(await p.db.top("workspaces").get(ctx.workspaceId));
  const sb = input.storyboard;
  const out: SoundtrackResult = { doc, notes, warnings };

  // 1. Voiceover first: it can lengthen the video, and the music is fitted to the final length.
  const wantsTts = sb?.voiceover.source === "tts";
  const script = narrationScript(sb);
  if (wantsTts && script) {
    if (!settings.aiVoiceover) notes.push("The storyboard has narration; AI voice is off for this workspace, so captions show the script. Add a voice in Studio → Sound.");
    else if (!p.cfg.OPENAI_API_KEY) warnings.push("AI voice is on, but external TTS isn't connected on this deployment (OPENAI_API_KEY). Captions show the script.");
    else {
      const est = p.credits.estimate("media.voiceover", { text: script, source: "tts" }).credits;
      let reservation: { reservationId: string; credits: number } | null = null;
      try {
        reservation = await p.credits.reserve(ctx.workspaceId, est, { operation: "media.voiceover", idempotencyKey: `job:${ctx.job.id}:voiceover`, actor: ctx.actor, jobId: ctx.job.id });
        const total = totalDuration(doc);
        const r = await produceAiVoiceover(ctx, { appId: input.appId, compositionId: input.compositionId, text: script, voice: settings.voice, keywords: input.app?.name ? [input.app.name] : [], maxDurationSec: Math.max(2, total - VOICE_START - 0.4) });
        const ext = extendForVoice(doc, VOICE_START, r.durationSec);
        doc = attachAudio(ext.doc, { voiceover: { ...voiceAttach(r, "external_tts"), startSec: VOICE_START } });
        if (ext.extendedSec) notes.push(`Extended the last scene by ${ext.extendedSec}s so the narration isn't cut off.`);
        const credits = voiceoverCredits(p.credits.prices as Record<string, number>, r);
        await p.credits.settle(ctx.workspaceId, reservation.reservationId, credits, { actor: ctx.actor, reason: "AI voiceover (external TTS) + Muse Voice Transcribe check" });
        reservation = null;
        warnings.push(...r.warnings);
        notes.push(`AI voiceover (OpenAI TTS, external) checked with Muse Voice Transcribe: ${Math.round((1 - (r.check?.wer ?? 0)) * 100)}% word match.`);
        out.voiceover = { assetId: r.asset.id, check: r.check, credits };
      } catch (raw) {
        const err = toAppError(raw);
        if (err.code === "CANCELLED") throw err;
        warnings.push(`AI voiceover skipped: ${err.opts.userMessage ?? err.message}`);
      } finally {
        if (reservation) await p.credits.release(ctx.workspaceId, reservation.reservationId, { actor: ctx.actor, reason: "Voiceover not produced" }).catch(() => {});
      }
    }
  }

  // 2. Original music, fitted to the final length (a storyboard's own music asset wins).
  const total = totalDuration(doc);
  const hasUserMusic = doc.audio.some((a) => a.kind === "music" && !a.auto);
  if (settings.music && !hasUserMusic) {
    try {
      const mood = moodFromText(sb?.music.mood);
      const { asset, reused } = await ensureMusicAsset(p, ctx.workspaceId, { params: { mood, durationSec: total, seed: input.compositionId, accents: musicAccents(doc) }, appId: input.appId, actor: ctx.actor, signal: ctx.signal });
      doc = attachAudio(doc, { music: { assetId: asset.id, mood, label: `Original music · ${MUSIC_MOOD_INFO[mood].label}` } });
      out.music = { assetId: asset.id, mood, reused };
      notes.push(`Original music: ${MUSIC_MOOD_INFO[mood].label}${sb?.music.mood ? ` (storyboard asked for “${sb.music.mood}”)` : ""}.`);
    } catch (raw) {
      const err = toAppError(raw);
      if (err.code === "CANCELLED") throw err;
      warnings.push(`Music skipped: ${err.message}`);
    }
  }
  // 3. Sound effects on transitions, taps and the end card.
  if (settings.sfx) {
    try {
      const lib = await ensureSfxLibrary(p, ctx.workspaceId, { actor: ctx.actor, signal: ctx.signal });
      doc = attachAudio(doc, { sfx: { enabled: true, assets: sfxIds(lib) } });
      out.sfx = doc.audio.filter((a) => a.kind === "sfx" && a.auto).length;
    } catch (raw) {
      const err = toAppError(raw);
      if (err.code === "CANCELLED") throw err;
      warnings.push(`Sound effects skipped: ${err.message}`);
    }
  }
  const v = validateDoc(doc);
  if (!v.ok) {
    warnings.push(`Sound not attached (invalid result: ${v.errors.slice(0, 2).join("; ")})`);
    return { doc: input.doc, notes, warnings };
  }
  out.doc = v.doc;
  return out;
}

const sfxIds = (lib: Record<SfxKind, { id: string }>) => Object.fromEntries(Object.entries(lib).map(([k, a]) => [k, a.id])) as Partial<Record<SfxKind, string>>;

// ---------------------------------------------------------------------------
// Studio operations (each commits a new version on top of the current one)
// ---------------------------------------------------------------------------

async function commitSound(ctx: { p: Platform; wid: string; actor: string }, compositionId: string, edit: (doc: CompositionDoc) => Promise<CompositionDoc> | CompositionDoc, summary: string) {
  const ws = ctx.p.db.ws(ctx.wid);
  // Sound edits are orthogonal to scene edits, so they apply on top of whatever is current
  // (one retry if someone committed in between).
  for (let attempt = 0; attempt < 2; attempt++) {
    const comp = await ws.collection("compositions").getOrThrow(compositionId);
    const cur = await getVersion(ws, compositionId, comp.currentVersion);
    const next = await edit(cur.doc);
    try {
      return await commitVersion(ws, compositionId, { baseVersion: comp.currentVersion, doc: next, source: "user_edit", summary: summary.slice(0, 500) }, ctx.actor);
    } catch (err) {
      if ((err as { code?: string }).code !== "CONFLICT" || attempt === 1) throw err;
    }
  }
  throw new AppError("CONFLICT", "The video changed while sound was being added; try again");
}

/** SFX on/off (re-placed for the current scenes). Effects are tiny: done inline. */
export async function setSfx(p: Platform, wid: string, input: { compositionId: string; enabled: boolean; volume?: number; actor: string }) {
  const lib = input.enabled ? await ensureSfxLibrary(p, wid, { actor: input.actor }) : null;
  return commitSound({ p, wid, actor: input.actor }, input.compositionId, (doc) => attachAudio(doc, { sfx: { enabled: input.enabled, assets: lib ? sfxIds(lib) : {}, volume: input.volume } }), input.enabled ? "Sound effects on (placed on transitions, taps and the end card)" : "Sound effects off");
}

export async function removeMusic(p: Platform, wid: string, input: { compositionId: string; actor: string }) {
  return commitSound({ p, wid, actor: input.actor }, input.compositionId, (doc) => attachAudio(doc, { music: null }), "Removed music");
}

export async function removeVoiceover(p: Platform, wid: string, input: { compositionId: string; actor: string }) {
  return commitSound({ p, wid, actor: input.actor }, input.compositionId, (doc) => attachAudio(doc, { voiceover: null, sfx: autoSfxRefresh(doc) }), "Removed voiceover");
}

/** Re-place auto effects with the same assets (their level depends on whether a voice is present). */
function autoSfxRefresh(doc: CompositionDoc): { enabled: boolean; assets: Partial<Record<SfxKind, string>> } | undefined {
  const auto = doc.audio.filter((a) => a.kind === "sfx" && a.auto && a.sfx);
  if (!auto.length) return undefined;
  return { enabled: true, assets: Object.fromEntries(auto.map((a) => [a.sfx!, a.assetId])) };
}

/** `media.music`: render (or reuse) original music for the composition and commit it. */
export async function musicHandler(ctx: JobContext<"media.music">) {
  const { appId, compositionId, mood, seed, volume } = ctx.payload;
  const comp = await ctx.ws.collection("compositions").getOrThrow(compositionId);
  if (comp.appId !== appId) throw new AppError("BAD_REQUEST", "Composition belongs to another app");
  await ctx.progress(10, `composing ${MUSIC_MOOD_INFO[mood].label.toLowerCase()} music`);
  const cur = await getVersion(ctx.ws, compositionId, comp.currentVersion);
  if (cur.doc.kind !== "video") throw new AppError("BAD_REQUEST", "Only videos have music");
  const { asset, reused } = await ensureMusicAsset(ctx.platform, ctx.workspaceId, { params: { mood, durationSec: totalDuration(cur.doc), seed, accents: musicAccents(cur.doc) }, appId, actor: ctx.actor, signal: ctx.signal });
  ctx.throwIfCancelled();
  await ctx.progress(80, "adding it to the video");
  const committed = await commitSound({ p: ctx.platform, wid: ctx.workspaceId, actor: ctx.actor }, compositionId, async (doc) => {
    // the length may have changed while composing: re-fit if so
    const d = totalDuration(doc);
    const a = Math.abs(d - totalDuration(cur.doc)) < 0.01 ? asset : (await ensureMusicAsset(ctx.platform, ctx.workspaceId, { params: { mood, durationSec: d, seed, accents: musicAccents(doc) }, appId, actor: ctx.actor })).asset;
    return attachAudio(doc, { music: { assetId: a.id, mood, volume, label: `Original music · ${MUSIC_MOOD_INFO[mood].label}` } });
  }, `Original music: ${MUSIC_MOOD_INFO[mood].label}`);
  await ctx.progress(100, "done");
  return { refs: [{ entity: "mediaAssets", id: asset.id }, { entity: "compositionVersions", id: committed.version.id }], data: { assetId: asset.id, mood, reused, version: committed.version.version, sourceLabel: "original_music" }, creditsUsed: 0 };
}

/** `media.voiceover`: AI voice (verified) or the founder's recording, committed with captions + ducking. */
export async function voiceoverHandler(ctx: JobContext<"media.voiceover">) {
  const p = ctx.platform;
  const { appId, compositionId, source } = ctx.payload;
  const comp = await ctx.ws.collection("compositions").getOrThrow(compositionId);
  if (comp.appId !== appId) throw new AppError("BAD_REQUEST", "Composition belongs to another app");
  const app = await ctx.ws.collection("apps").get(appId);
  const keywords = app?.name ? [app.name] : [];
  const cur = await getVersion(ctx.ws, compositionId, comp.currentVersion);
  if (cur.doc.kind !== "video") throw new AppError("BAD_REQUEST", "Only videos have a voiceover");
  const progress = (pct: number, msg: string) => ctx.progress(pct, msg);
  let r: VoiceoverResult;
  let label: AttachVoiceover["sourceLabel"];
  if (source === "tts") {
    const sb = comp.storyboardId ? await ctx.ws.collection("storyboards").get(comp.storyboardId) : null;
    const text = ctx.payload.text?.trim() || narrationScript(sb);
    if (!text) throw new AppError("BAD_REQUEST", "No narration script", { userMessage: "Write a narration script for the AI voice first.", retryable: false });
    const voice = ctx.payload.voice ?? soundSettings(await p.db.top("workspaces").get(ctx.workspaceId)).voice;
    r = await produceAiVoiceover(ctx, { appId, compositionId, text, voice, keywords, maxDurationSec: Math.max(2, totalDuration(cur.doc) - VOICE_START - 0.4), progress });
    label = "external_tts";
  } else {
    if (!ctx.payload.assetId) throw new AppError("BAD_REQUEST", "assetId is required for a recording", { retryable: false });
    const src = await ctx.ws.collection("mediaAssets").getOrThrow(ctx.payload.assetId);
    r = await prepareRecordingVoiceover(ctx, { source: src, compositionId, keywords, progress });
    label = src.sourceLabel === "external_tts" ? "external_tts" : "founder_recording";
  }
  ctx.throwIfCancelled();
  await ctx.progress(85, "adding the voice, captions and ducking");
  const notes: string[] = [];
  const music = await currentMusic(ctx, cur.doc);
  const committed = await commitSound({ p, wid: ctx.workspaceId, actor: ctx.actor }, compositionId, async (doc) => {
    const ext = extendForVoice(doc, VOICE_START, r.durationSec);
    let next = attachAudio(ext.doc, { voiceover: { ...voiceAttach(r, label), startSec: VOICE_START }, sfx: autoSfxRefresh(ext.doc) });
    if (ext.extendedSec) {
      notes.push(`Extended the last scene by ${ext.extendedSec}s so the voice isn't cut off.`);
      if (music) {
        const m = await ensureMusicAsset(p, ctx.workspaceId, { params: { mood: music.mood, durationSec: totalDuration(next), seed: music.seed, accents: musicAccents(next) }, appId, actor: ctx.actor });
        next = attachAudio(next, { music: { assetId: m.asset.id, mood: music.mood, volume: music.volume, label: `Original music · ${MUSIC_MOOD_INFO[music.mood].label}` } });
      }
    }
    return next;
  }, source === "tts" ? "Added AI voiceover (external TTS, checked with Muse Voice Transcribe)" : "Added your voice recording");
  await ctx.progress(100, "done");
  const credits = voiceoverCredits(p.credits.prices as Record<string, number>, r);
  return {
    refs: [{ entity: "mediaAssets", id: r.asset.id }, { entity: "transcripts", id: r.transcriptId }, { entity: "compositionVersions", id: committed.version.id }],
    data: { assetId: r.asset.id, version: committed.version.version, check: r.check, warnings: r.warnings, notes, sourceLabel: label, durationSec: r.durationSec },
    creditsUsed: credits,
  };
}
