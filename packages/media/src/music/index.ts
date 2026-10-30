/**
 * Original music and sound-effect assets (owned, synthesized by our own code). Renders are cached
 * per workspace by a hash of their parameters: the same mood, length, seed and accents give the
 * same asset id, so retries and repeated builds never render twice.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MUSIC_GENERATOR,
  MUSIC_MOOD_INFO,
  MUSIC_MOODS,
  ORIGINAL_MUSIC_LICENSE,
  ORIGINAL_SFX_LICENSE,
  SFX_GENERATOR,
  SFX_KINDS,
  SFX_SPECS,
  type MediaAsset,
  type MusicMood,
  type MusicParams,
  type SfxKind,
} from "@muselaunch/contracts";
import { workspaceKey, type Platform } from "@muselaunch/platform";
import { renderSfx } from "../sfx";
import { sha256, withWorkdir } from "../util";
import { renderMusic, type MusicRender } from "./compose";
import { encodeM4a } from "./encode";

export { renderMusic, planArrangement, MOODS, type MusicRender, type MusicPlan } from "./compose";
export { renderSfx } from "../sfx";
export { encodeM4a, wavBytes } from "./encode";
export { integratedLoudness, master, limit } from "./master";

/** Bump when the synthesis changes audibly: cached renders are keyed by it. */
export const MUSIC_ENGINE_VERSION = 1;
export const SFX_ENGINE_VERSION = 1;

const KEYWORDS: Record<MusicMood, string[]> = {
  "bright-pluck": ["upbeat", "happy", "bright", "energetic", "fun", "playful", "cheerful", "sunny", "uplifting", "pop", "positive", "optimistic", "launch", "exciting", "joyful", "lively", "summer", "fresh"],
  "calm-pad": ["calm", "ambient", "peaceful", "relaxing", "relaxed", "serene", "soft", "gentle", "meditative", "airy", "dreamy", "wellness", "mindful", "sleep", "soothing", "tranquil", "spacious"],
  "tech-pulse": ["tech", "electronic", "futuristic", "modern", "sleek", "driving", "synth", "techno", "startup", "productivity", "ai", "developer", "pulse", "edm", "digital", "premium", "minimal", "apple", "innovative", "fast", "confident"],
  "warm-keys": ["warm", "friendly", "cozy", "human", "heartfelt", "acoustic", "soulful", "jazzy", "jazz", "piano", "keys", "emotional", "sincere", "story", "founder", "personal", "intimate", "hopeful", "community"],
  "cinematic-build": ["cinematic", "epic", "dramatic", "trailer", "build", "building", "powerful", "intense", "bold", "anthemic", "suspense", "orchestral", "grand", "triumphant", "big", "inspiring"],
  "lofi-chill": ["lofi", "lo-fi", "chill", "study", "focus", "mellow", "laid-back", "laidback", "hip-hop", "hiphop", "beats", "vinyl", "nostalgic", "dusty", "lazy", "coffee"],
};

/**
 * Map a free-text mood (Spark's `storyboard.music.mood`, e.g. "upbeat, premium, Apple-style") to a
 * preset. Exact preset ids win; otherwise keyword votes; `fallback` when nothing matches.
 */
export function moodFromText(text: string | undefined | null, fallback: MusicMood = "bright-pluck"): MusicMood {
  if (!text) return fallback;
  const t = text.toLowerCase();
  for (const m of MUSIC_MOODS) if (t.includes(m)) return m;
  const words = t.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  let best: MusicMood = fallback;
  let bestScore = 0;
  for (const m of MUSIC_MOODS) {
    let score = 0;
    for (const k of KEYWORDS[m]) if (words.includes(k) || (k.includes("-") && t.includes(k))) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

function paramsKey(p: MusicParams): string {
  const accents = [...(p.accents ?? [])].map((a) => Math.round(a * 1000) / 1000).sort((a, b) => a - b);
  return sha256(JSON.stringify({ v: MUSIC_ENGINE_VERSION, mood: p.mood, d: Math.round(p.durationSec * 1000) / 1000, seed: p.seed, accents })).slice(0, 32);
}

/** Deterministic asset id of a music render in a workspace (the cache key). */
export const musicAssetId = (p: MusicParams) => `ast_mus_${paramsKey(p)}`;
export const sfxAssetId = (kind: SfxKind) => `ast_sfx_${kind.replace(/[^a-z0-9]/g, "")}_v${SFX_ENGINE_VERSION}`;

const READY = new Set(["ready", "uploaded"]);

async function cached(p: Platform, wid: string, id: string): Promise<MediaAsset | null> {
  const a = await p.db.ws(wid).collection("mediaAssets").get(id);
  if (a && READY.has(a.status) && (await p.storage.stat(a.storagePath))) return a;
  return null;
}

export interface EnsureMusicResult {
  asset: MediaAsset;
  reused: boolean;
  render?: Pick<MusicRender, "plan" | "key" | "progression" | "master" | "renderMs">;
}

/**
 * Original music for `params` in workspace `wid`: the cached asset, or a fresh render stored as
 * MediaAsset role "music", origin "generated", sourceLabel "original_music", license owned.
 */
export async function ensureMusicAsset(p: Platform, wid: string, input: { params: MusicParams; appId?: string; actor: string; signal?: AbortSignal }): Promise<EnsureMusicResult> {
  const params = input.params;
  const id = musicAssetId(params);
  const hit = await cached(p, wid, id);
  if (hit) return { asset: hit, reused: true };
  const r = renderMusic(params);
  const key = workspaceKey(wid, "generated", id, "music.m4a");
  const info = MUSIC_MOOD_INFO[params.mood];
  const bpm = Math.round(r.plan.bpm);
  const bytes = await withWorkdir(async (dir) => {
    const f = join(dir, "music.m4a");
    await encodeM4a(r.left, r.right, r.sampleRate, f, { bitrateK: 160, signal: input.signal, title: `MuseLaunch original music (${info.label})` });
    return readFile(f);
  });
  const stored = await p.storage.put(key, bytes, { contentType: "audio/mp4" });
  const { entity } = await p.db.ws(wid).collection("mediaAssets").createIfAbsent(
    {
      id,
      appId: input.appId,
      kind: "audio",
      role: "music",
      origin: "generated",
      storagePath: key,
      mimeType: "audio/mp4",
      bytes: stored.bytes,
      sha256: stored.sha256,
      durationSec: params.durationSec,
      hasAudio: true,
      status: "ready",
      isProductTruth: false,
      sourceLabel: "original_music",
      labels: ["original_music", `mood:${params.mood}`, `bpm:${bpm}`, `key:${r.key.replace(/\s+/g, "-")}`],
      title: `Original music · ${info.label} · ${bpm} BPM, ${r.key}`.slice(0, 200),
      license: { ...ORIGINAL_MUSIC_LICENSE },
      generation: { provider: MUSIC_GENERATOR.provider, model: MUSIC_GENERATOR.model, prompt: JSON.stringify({ ...params, engine: MUSIC_ENGINE_VERSION }).slice(0, 4000), revision: 1 },
    },
    { actor: input.actor },
  );
  return { asset: entity, reused: false, render: { plan: r.plan, key: r.key, progression: r.progression, master: r.master, renderMs: r.renderMs } };
}

/** The workspace's library of synthesized effects (created on first use; tiny, generated in ms). */
export async function ensureSfxLibrary(p: Platform, wid: string, input: { actor: string; kinds?: readonly SfxKind[]; signal?: AbortSignal }): Promise<Record<SfxKind, MediaAsset>> {
  const out = {} as Record<SfxKind, MediaAsset>;
  for (const kind of input.kinds ?? SFX_KINDS) {
    const id = sfxAssetId(kind);
    const hit = await cached(p, wid, id);
    if (hit) {
      out[kind] = hit;
      continue;
    }
    const s = renderSfx(kind);
    const bytes = await withWorkdir(async (dir) => {
      const f = join(dir, `${kind}.m4a`);
      await encodeM4a(s.left, s.right, s.sampleRate, f, { bitrateK: 128, signal: input.signal });
      return readFile(f);
    });
    const key = workspaceKey(wid, "generated", "sfx", `${kind}-v${SFX_ENGINE_VERSION}.m4a`);
    const stored = await p.storage.put(key, bytes, { contentType: "audio/mp4" });
    const spec = SFX_SPECS[kind];
    const { entity } = await p.db.ws(wid).collection("mediaAssets").createIfAbsent(
      {
        id,
        kind: "audio",
        role: "other",
        origin: "generated",
        storagePath: key,
        mimeType: "audio/mp4",
        bytes: stored.bytes,
        sha256: stored.sha256,
        durationSec: spec.durationSec,
        hasAudio: true,
        status: "ready",
        isProductTruth: false,
        sourceLabel: "original_sfx",
        labels: ["original_sfx", `sfx:${kind}`],
        title: `${spec.label} · original sound effect`,
        license: { ...ORIGINAL_SFX_LICENSE },
        generation: { provider: SFX_GENERATOR.provider, model: SFX_GENERATOR.model, prompt: JSON.stringify({ kind, engine: SFX_ENGINE_VERSION }), revision: 1 },
      },
      { actor: input.actor },
    );
    out[kind] = entity;
  }
  return out;
}
