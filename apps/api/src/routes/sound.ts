import {

  MUSIC_MOOD_INFO,
  MUSIC_MOODS,
  SFX_KINDS,
  SFX_SPECS,
  SoundMusicRequest,
  SoundRemoveVoiceoverQuery,
  SoundSfxRequest,
  SoundVoiceoverRequest,
  VOICEOVER_WER_THRESHOLD,
  WorkspaceSoundSettings,
  type Composition,
  type MediaAsset,
} from "@muselaunch/contracts";
import { commitVersion, getVersion } from "@muselaunch/compositions/store";
import { ensureConsent, narrationScript, removeMusic, removeVoiceover, setSfx, soundSettings } from "@muselaunch/media";
import { AppError } from "@muselaunch/platform";
import { BUILTIN_TTS_VOICES, DEFAULT_TTS_VOICE, assertBuiltinVoice, TTS_DISCLOSURE } from "@muselaunch/providers";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, assertCap, body, idempotencyKey, query, requireCap, type AppEnv, type Ctx } from "../context";
import { rateLimit } from "../middleware";
import { audit } from "../services/workspaces";

/**
 * Owner: Track 3 (sound). Studio sound panel + workspace sound defaults. Mounted under
 * /v1/workspaces/:workspaceId. Music and effects are synthesized by our own code (owned, free);
 * AI voice is external TTS (labelled, metered) verified with Muse Voice Transcribe.
 */
export const soundRoutes = new Hono<AppEnv>();

async function loadComposition(c: Ctx): Promise<Composition> {
  const comp = await c.get("platform").db.ws(c.get("workspaceId")).collection("compositions").getOrThrow(c.req.param("id")!);
  if (comp.kind !== "video") throw new AppError("BAD_REQUEST", "Only videos have sound");
  return comp;
}

function assertFresh(comp: Composition, baseVersion: number) {
  if (baseVersion !== comp.currentVersion) throw new AppError("CONFLICT", `Composition is at version ${comp.currentVersion}`, { details: { currentVersion: comp.currentVersion } });
}

/** Sound state for the Studio panel: tracks with their assets and provenance, options, costs. */
soundRoutes.get("/compositions/:id/sound", async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const db = p.db.ws(wid);
  const comp = await loadComposition(c);
  const ver = await getVersion(db, comp.id, comp.currentVersion);
  const ids = [...new Set(ver.doc.audio.map((a) => a.assetId))];
  const assets = Object.fromEntries(((await db.collection("mediaAssets").getMany(ids)) as MediaAsset[]).map((a) => [a.id, { id: a.id, title: a.title, sourceLabel: a.sourceLabel, license: a.license, labels: a.labels, durationSec: a.durationSec, role: a.role, generation: a.generation ? { provider: a.generation.provider, model: a.generation.model } : undefined }]));
  const sb = comp.storyboardId ? await db.collection("storyboards").get(comp.storyboardId) : null;
  const script = narrationScript(sb);
  const settings = soundSettings(c.get("workspace"));
  const ttsConfigured = Boolean(p.cfg.OPENAI_API_KEY);
  const transcribeConfigured = Boolean(p.cfg.META_API_KEY);
  return c.json({
    version: comp.currentVersion,
    tracks: ver.doc.audio,
    assets,
    captions: { enabled: ver.doc.captions.enabled, source: ver.doc.captions.source, cues: ver.doc.captions.cues.length },
    settings,
    moods: MUSIC_MOODS.map((id) => ({ id, ...MUSIC_MOOD_INFO[id] })),
    sfx: SFX_KINDS.map((id) => ({ id, label: SFX_SPECS[id].label })),
    storyboard: sb ? { voiceover: sb.voiceover.source, musicMood: sb.music.mood ?? null } : null,
    script,
    tts: {
      configured: ttsConfigured && transcribeConfigured,
      ttsConfigured,
      transcribeConfigured,
      provider: "OpenAI TTS (external)",
      model: p.cfg.OPENAI_TTS_MODEL,
      voices: BUILTIN_TTS_VOICES,
      defaultVoice: settings.voice ?? DEFAULT_TTS_VOICE,
      disclosure: TTS_DISCLOSURE,
      checkThreshold: VOICEOVER_WER_THRESHOLD,
      estimate: script ? p.credits.estimate("media.voiceover", { text: script, source: "tts" }) : null,
    },
  });
});

/** Music: new mood or take (job), volume (instant), or remove. */
soundRoutes.post("/compositions/:id/sound/music", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const db = p.db.ws(wid);
  const actor = actorOf(c);
  const comp = await loadComposition(c);
  const input = await body(c, SoundMusicRequest);
  assertFresh(comp, input.baseVersion);
  if (!input.enabled) return c.json(await removeMusic(p, wid, { compositionId: comp.id, actor }));
  const cur = await getVersion(db, comp.id, comp.currentVersion);
  const track = cur.doc.audio.find((a) => a.kind === "music" && a.sourceLabel === "original_music");
  // Volume only: a direct edit of the existing track.
  if (track && !input.regenerate && (!input.mood || input.mood === track.mood) && input.volume !== undefined) {
    const doc = { ...cur.doc, audio: cur.doc.audio.map((a) => (a.id === track.id ? { ...a, volume: input.volume! } : a)) };
    return c.json(await commitVersion(db, comp.id, { baseVersion: comp.currentVersion, doc, source: "user_edit", summary: `Music volume ${Math.round(input.volume * 100)}%` }, actor));
  }
  const prev = track ? await db.collection("mediaAssets").get(track.assetId) : null;
  let prevSeed = comp.id;
  try {
    prevSeed = (JSON.parse(prev?.generation?.prompt ?? "{}") as { seed?: string }).seed ?? comp.id;
  } catch {
    /* keep default */
  }
  const mood = input.mood ?? track?.mood ?? "bright-pluck";
  const seed = input.regenerate ? `${comp.id}:${Date.now().toString(36)}` : prevSeed;
  const job = await p.jobs.create(
    wid,
    "media.music",
    { appId: comp.appId, compositionId: comp.id, baseVersion: comp.currentVersion, mood, seed, volume: input.volume ?? track?.volume },
    { actor, appId: comp.appId, idempotencyKey: idempotencyKey(c, `media.music:${comp.id}:v${comp.currentVersion}:${mood}:${seed}`), credits: { operation: "media.music" } },
  );
  return c.json({ job, mood, sourceLabel: "original_music", license: "Original music generated by MuseLaunch (owned)" }, 202);
});

/** Automatic sound effects on (re-placed for the current scenes) or off. */
soundRoutes.post("/compositions/:id/sound/sfx", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const comp = await loadComposition(c);
  const input = await body(c, SoundSfxRequest);
  assertFresh(comp, input.baseVersion);
  return c.json(await setSfx(p, c.get("workspaceId"), { compositionId: comp.id, enabled: input.enabled, volume: input.volume, actor: actorOf(c) }));
});



/** Voiceover: AI voice (external TTS, verified by Muse Voice Transcribe) or your recording (job). */
soundRoutes.post("/compositions/:id/sound/voiceover", requireCap("content.write"), rateLimit({ perMinute: 10, key: "voiceover" }), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const db = p.db.ws(wid);
  const actor = actorOf(c);
  const comp = await loadComposition(c);
  const input = await body(c, SoundVoiceoverRequest);
  assertFresh(comp, input.baseVersion);
  if (input.source === "tts") {
    if (!p.cfg.OPENAI_API_KEY) throw new AppError("PROVIDER_NOT_CONFIGURED", "OPENAI_API_KEY is not set", { userMessage: "AI voice (external TTS) isn't connected on this deployment." });
    if (!p.cfg.META_API_KEY) throw new AppError("PROVIDER_NOT_CONFIGURED", "META_API_KEY is not set", { userMessage: "Muse Voice Transcribe isn't connected, so an AI voice can't be checked against the script." });
    const voice = assertBuiltinVoice(input.voice ?? soundSettings(c.get("workspace")).voice);
    const sb = comp.storyboardId ? await db.collection("storyboards").get(comp.storyboardId) : null;
    const text = input.script?.trim() || narrationScript(sb);
    if (!text) throw new AppError("BAD_REQUEST", "No narration script", { userMessage: "Write a narration script for the AI voice first." });
    const job = await p.jobs.create(
      wid,
      "media.voiceover",
      { appId: comp.appId, compositionId: comp.id, baseVersion: comp.currentVersion, source: "tts", text, voice },
      { actor, appId: comp.appId, idempotencyKey: idempotencyKey(c), credits: { operation: "media.voiceover", params: { text, source: "tts" } } },
    );
    return c.json({ job, provider: { id: "openai", label: "OpenAI TTS (external)", model: p.cfg.OPENAI_TTS_MODEL, voice }, sourceLabel: "external_tts", disclosure: TTS_DISCLOSURE, check: { model: p.cfg.META_MODEL_VOICE, threshold: VOICEOVER_WER_THRESHOLD } }, 202);
  }
  if (!p.cfg.META_API_KEY) throw new AppError("PROVIDER_NOT_CONFIGURED", "META_API_KEY is not set", { userMessage: "Muse Voice Transcribe isn't connected, so captions can't be timed to your voice." });
  let asset = await db.collection("mediaAssets").getOrThrow(input.assetId);
  if (asset.appId && asset.appId !== comp.appId) throw new AppError("BAD_REQUEST", "That recording belongs to another app");
  if (asset.origin !== "recorded") asset = await ensureConsent(p, wid, asset, input.consent, actor, "using a recorded voice as voiceover");
  const job = await p.jobs.create(
    wid,
    "media.voiceover",
    { appId: comp.appId, compositionId: comp.id, baseVersion: comp.currentVersion, source: "recording", assetId: asset.id },
    { actor, appId: comp.appId, idempotencyKey: idempotencyKey(c), credits: { operation: "media.voiceover", params: { source: "recording", durationSec: asset.durationSec ?? 60 } } },
  );
  return c.json({ job, sourceLabel: "founder_recording" }, 202);
});

soundRoutes.delete("/compositions/:id/sound/voiceover", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const comp = await loadComposition(c);
  const q = query(c, SoundRemoveVoiceoverQuery);
  assertFresh(comp, q.baseVersion);
  return c.json(await removeVoiceover(p, c.get("workspaceId"), { compositionId: comp.id, actor: actorOf(c) }));
});

/**
 * Workspace sound defaults (workspace.manage). AI voice spends credits on every new video that
 * asks for narration, so turning it on (or off) also needs billing.manage.
 */
soundRoutes.patch("/sound/settings", requireCap("workspace.manage"), async (c) => {
  const p = c.get("platform");
  const ws = c.get("workspace");
  const input = await body(c, WorkspaceSoundSettings.partial().extend({ voice: z.string().max(40).nullable().optional() }).strict());
  if (input.aiVoiceover !== undefined) assertCap(c, "billing.manage");
  if (input.voice) assertBuiltinVoice(input.voice);
  const cur = soundSettings(ws);
  const next = WorkspaceSoundSettings.parse({ ...cur, ...input, voice: input.voice === null ? undefined : (input.voice ?? cur.voice) });
  const updated = await p.db.top("workspaces").update(ws.id, { settings: { ...ws.settings, sound: next } });
  await audit(p, ws.id, actorOf(c), "workspace.sound_updated", input);
  return c.json({ workspace: updated, settings: next });
});

