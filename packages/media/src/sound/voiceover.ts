/**
 * Voiceover for videos.
 *
 * AI voice: OpenAI TTS (external, labelled `external_tts`, built-in voices only, never a clone) →
 * loudness-normalised → transcribed back with Muse Voice Transcribe → compared with the script
 * (normalised word error rate). Above `VOICEOVER_WER_THRESHOLD` it is regenerated once (asking for
 * slower, clearer delivery); if it still differs, the better take is used with a visible warning.
 *
 * Founder recording: the person's own audio (consent on the asset), loudness-normalised into a
 * derived asset and transcribed for caption timing and music ducking.
 *
 * Muse Voice Transcribe gives TURN-level timing (no word timestamps): captions use the turn
 * boundaries; the script's words are distributed over turns by the transcribed word counts.
 */
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  VOICEOVER_WER_THRESHOLD,
  type CaptionCue,
  type MediaAsset,
  type SpeechRange,
  type Transcript,
  type VoiceoverCheck,
} from "@muselaunch/contracts";
import { AppError, workspaceKey, type JobContext } from "@muselaunch/platform";
import { assertBuiltinVoice, synthesizeSpeech, TTS_DISCLOSURE } from "@muselaunch/providers";
import { transcriptToCaptionCues } from "../captions";
import { Stereo, SR } from "../music/dsp";
import { decodePcm, encodeM4a } from "../music/encode";
import { master } from "../music/master";
import { runTranscriptionSafely } from "../transcribe";
import { callCtx, derivedId, EXT_BY_MIME, mediaDeps, sha256, usageEventIdsForJob, withWorkdir } from "../util";

/** Voice loudness in the final mix (music is mastered to −15 LUFS and played under it). */
export const VOICE_TARGET_LUFS = -16;
export const VOICE_CEILING_DB = -3;
/** Most speed-up applied to fit a long narration into the video (beyond it the last scene is extended). */
export const MAX_VOICE_TEMPO = 1.12;

const INSTRUCTIONS = "Warm, clear, confident narrator for a short app video. Natural, slightly upbeat pace. Say product names exactly as written.";
const RETRY_INSTRUCTIONS = "Warm, clear narrator. Speak a little slower and enunciate every word exactly as written, including product names and numbers.";

// ---------------------------------------------------------------------------
// Word error rate
// ---------------------------------------------------------------------------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numberWords(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
  if (n < 1_000_000) return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ""}`;
  return String(n);
}

/** Lower-case words without punctuation; digits spelled out; common symbols as words. */
export function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/(\d+)\s*%/g, "$1 percent")
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/\b(\d{1,6})\b/g, (m) => numberWords(Number(m)))
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .replace(/'(?!\p{L})|(?<!\p{L})'/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Normalised word error rate: word-level edit distance / reference length (0 = identical). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = normalizeWords(reference);
  const h = normalizeWords(hypothesis);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[h.length]! / r.length;
}

/**
 * Turns carrying the SCRIPT's words (correct spelling of brand names) at the transcript's turn
 * timing: script words are handed out in order, in proportion to each turn's transcribed words.
 */
export function scriptTurns(script: string, turns: Transcript["turns"]): Transcript["turns"] {
  const words = script.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const counts = turns.map((t) => Math.max(1, t.text.trim().split(/\s+/).filter(Boolean).length));
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  let used = 0;
  let acc = 0;
  return turns.map((t, i) => {
    acc += counts[i]!;
    const upto = i === turns.length - 1 ? words.length : Math.round((acc / total) * words.length);
    const text = words.slice(used, Math.max(used, upto)).join(" ");
    used = Math.max(used, upto);
    return { ...t, text: text || t.text };
  });
}

// ---------------------------------------------------------------------------
// Audio preparation
// ---------------------------------------------------------------------------

/** Decode → (optional tempo) → loudness-normalise to −16 LUFS / −3 dBFS → mono AAC. */
export async function normalizeVoice(input: string, out: string, o: { tempo?: number; signal?: AbortSignal } = {}): Promise<{ durationSec: number; lufs: number }> {
  const tempo = o.tempo && Math.abs(o.tempo - 1) > 0.005 ? o.tempo : undefined;
  const [mono] = await decodePcm(input, `${out}.raw`, { sampleRate: SR, channels: 1, filter: tempo ? `atempo=${tempo.toFixed(4)}` : undefined, signal: o.signal });
  const buf = new Stereo(mono!.length);
  buf.L.set(mono!);
  buf.R.set(mono!);
  const rep = master(buf, { targetLufs: VOICE_TARGET_LUFS, ceilingDb: VOICE_CEILING_DB, fadeInSec: 0.005, fadeOutSec: 0.05 });
  await encodeM4a(buf.L, null, SR, out, { bitrateK: 128, signal: o.signal });
  return { durationSec: mono!.length / SR, lufs: rep.lufs };
}

export interface VoiceoverResult {
  asset: MediaAsset;
  durationSec: number;
  transcriptId: string;
  speech: SpeechRange[];
  /** Caption cues, voice-local seconds. */
  captions: CaptionCue[];
  check?: VoiceoverCheck;
  warnings: string[];
  /** Provider work actually done (for credits): TTS generations, characters each, check passes. */
  ttsCalls: number;
  ttsChars: number;
  checkSeconds: number;
  /** Muse Voice Transcribe passes that ran (0 when transcripts were reused). */
  checks: number;
}

function speechOf(t: Transcript): SpeechRange[] {
  return t.turns.filter((u) => u.endSec > u.startSec).map((u) => ({ startSec: u.startSec, endSec: u.endSec }));
}

async function transcribeAsset(ctx: JobContext, asset: MediaAsset, dir: string, localFile: string, keywords: string[]): Promise<{ transcript: Transcript; ran: boolean }> {
  const repo = ctx.ws.collection("transcripts");
  const id = derivedId("trn", "voiceover", asset.id);
  const existing = await repo.get(id);
  if (existing?.status === "succeeded") return { transcript: existing, ran: false };
  const t =
    existing ??
    (
      await repo.createIfAbsent(
        { id, appId: asset.appId, sourceAssetId: asset.id, sourceSha256: asset.sha256, model: ctx.platform.cfg.META_MODEL_VOICE, purpose: "captions", status: "queued", mode: "DIARIZATION", text: "", turns: [], usageEventIds: [] },
        { actor: ctx.actor },
      )
    ).entity;
  const before = new Set(await usageEventIdsForJob(ctx));
  const { transcript } = await runTranscriptionSafely(ctx, t, asset, dir, { keywords: keywords.slice(0, 50), progress: () => {}, usageBefore: before, localFile });
  return { transcript, ran: true };
}

/**
 * AI voiceover with a Muse Voice Transcribe check. Idempotent per (composition, script, voice,
 * attempt): a re-run reuses stored takes and transcripts instead of paying again.
 */
export async function produceAiVoiceover(
  ctx: JobContext,
  input: { appId?: string; compositionId: string; text: string; voice?: string; keywords?: string[]; maxDurationSec?: number; progress?: (pct: number, msg: string) => Promise<void> | void },
): Promise<VoiceoverResult> {
  const p = ctx.platform;
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new AppError("BAD_REQUEST", "The voiceover script is empty", { userMessage: "Write a narration script first." });
  const voice = assertBuiltinVoice(input.voice);
  const repo = ctx.ws.collection("mediaAssets");
  const takes: { asset: MediaAsset; transcript: Transcript; wer: number }[] = [];
  let ttsCalls = 0;
  let checkSeconds = 0;
  let checks = 0;
  return withWorkdir(async (dir) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      ctx.throwIfCancelled();
      const id = derivedId("ast", "voiceover", input.compositionId, sha256(text), voice, String(attempt));
      let asset = await repo.get(id);
      const local = join(dir, `vo-${attempt}.m4a`);
      if (asset?.status === "ready") {
        await p.storage.downloadToFile(asset.storagePath, local);
      } else {
        await input.progress?.(attempt === 1 ? 15 : 55, attempt === 1 ? "generating AI voice (OpenAI TTS)" : "regenerating AI voice more clearly");
        const speech = await synthesizeSpeech(p, callCtx(ctx, "tts.voiceover"), { text, voice, instructions: attempt === 1 ? INSTRUCTIONS : RETRY_INSTRUCTIONS }, { fetch: mediaDeps(p).fetch });
        ttsCalls++;
        const raw = join(dir, `raw-${attempt}.${EXT_BY_MIME[speech.mimeType] ?? "mp3"}`);
        await writeFile(raw, speech.audio);
        let norm = await normalizeVoice(raw, local, { signal: ctx.signal });
        // Too long for the video: speed up a little (never more than MAX_VOICE_TEMPO).
        if (input.maxDurationSec && norm.durationSec > input.maxDurationSec) {
          const tempo = Math.min(MAX_VOICE_TEMPO, norm.durationSec / input.maxDurationSec);
          norm = await normalizeVoice(raw, local, { tempo, signal: ctx.signal });
        }
        const bytes = await readFile(local);
        const key = workspaceKey(ctx.workspaceId, "generated", id, "voiceover.m4a");
        const stored = await p.storage.put(key, bytes, { contentType: "audio/mp4" });
        asset = (
          await repo.createIfAbsent(
            {
              id,
              appId: input.appId,
              kind: "audio",
              role: "tts",
              origin: "generated",
              storagePath: key,
              mimeType: "audio/mp4",
              bytes: stored.bytes,
              sha256: stored.sha256,
              durationSec: Math.round(norm.durationSec * 1000) / 1000,
              hasAudio: true,
              status: "ready",
              isProductTruth: false,
              sourceLabel: "external_tts",
              labels: ["external_tts", "ai_voice", `voice:${speech.voice}`, `composition:${input.compositionId}`.slice(0, 60)],
              title: `AI voiceover · OpenAI TTS (${speech.voice})`,
              license: { type: "generated_terms", provider: "OpenAI TTS", termsUrl: "https://openai.com/policies/usage-policies/", restrictions: TTS_DISCLOSURE },
              generation: { provider: speech.provider, model: speech.model, prompt: text.slice(0, 4000), revision: attempt, usageEventId: speech.usageEventId },
            },
            { actor: ctx.actor },
          )
        ).entity;
      }
      await input.progress?.(attempt === 1 ? 35 : 75, "checking the voice against the script (Muse Voice Transcribe)");
      const { transcript, ran } = await transcribeAsset(ctx, asset, dir, local, input.keywords ?? []);
      if (ran) {
        checks++;
        checkSeconds = Math.max(checkSeconds, asset.durationSec ?? 0);
      }
      const wer = wordErrorRate(text, transcript.text);
      takes.push({ asset, transcript, wer });
      if (wer <= VOICEOVER_WER_THRESHOLD) break;
    }
    const best = takes.reduce((a, b) => (b.wer < a.wer ? b : a));
    const passed = best.wer <= VOICEOVER_WER_THRESHOLD;
    const warnings = passed
      ? []
      : [`The AI voice didn't match the script closely (${Math.round(best.wer * 100)}% of words differ, checked with Muse Voice Transcribe, after one regeneration). Listen before publishing, or edit the script.`];
    const turns = passed ? scriptTurns(text, best.transcript.turns) : best.transcript.turns;
    const captions = transcriptToCaptionCues({ id: best.transcript.id, text: passed ? text : best.transcript.text, turns, durationSec: best.asset.durationSec }, { idPrefix: `vo-${best.transcript.id}`.slice(0, 60), maxChars: 64 });
    return {
      asset: best.asset,
      durationSec: best.asset.durationSec ?? 0,
      transcriptId: best.transcript.id,
      speech: speechOf(best.transcript),
      captions,
      check: { wer: Math.round(best.wer * 1000) / 1000, passed, attempts: takes.length, transcriptId: best.transcript.id, model: best.transcript.model },
      warnings,
      ttsCalls,
      ttsChars: ttsCalls * text.length,
      checkSeconds,
      checks,
    };
  });
}

/**
 * The founder's own recording as voiceover: normalised into a derived asset (same consent and
 * licence) and transcribed for captions + ducking. Requires consent on the source asset.
 */
export async function prepareRecordingVoiceover(ctx: JobContext, input: { source: MediaAsset; compositionId: string; keywords?: string[]; progress?: (pct: number, msg: string) => Promise<void> | void }): Promise<VoiceoverResult> {
  const p = ctx.platform;
  const src = input.source;
  if (src.status !== "ready" && src.status !== "uploaded") throw new AppError("CONFLICT", `Recording is ${src.status}`, { userMessage: "This recording is still processing. Try again in a moment." });
  if (src.kind !== "audio" && src.kind !== "video") throw new AppError("BAD_REQUEST", "Only audio or video can be a voiceover");
  if (src.hasAudio === false) throw new AppError("BAD_REQUEST", "This file has no sound", { userMessage: "That file has no sound to use as a voiceover." });
  if (!src.license?.consent && src.origin !== "recorded") throw new AppError("BAD_REQUEST", "Consent required for a recorded voice", { userMessage: "Confirm you have permission to use this person's voice.", details: { consentRequired: true } });
  const repo = ctx.ws.collection("mediaAssets");
  const id = derivedId("ast", "voice", src.id);
  return withWorkdir(async (dir) => {
    let asset = await repo.get(id);
    const local = join(dir, "voice.m4a");
    if (asset?.status === "ready") await p.storage.downloadToFile(asset.storagePath, local);
    else {
      await input.progress?.(15, "preparing your recording");
      const original = join(dir, `source.${EXT_BY_MIME[src.mimeType] ?? "bin"}`);
      await p.storage.downloadToFile(src.storagePath, original);
      const norm = await normalizeVoice(original, local, { signal: ctx.signal });
      const bytes = await readFile(local);
      const key = workspaceKey(ctx.workspaceId, "derived", id, "voice.m4a");
      const stored = await p.storage.put(key, bytes, { contentType: "audio/mp4" });
      asset = (
        await repo.createIfAbsent(
          {
            id,
            appId: src.appId,
            campaignId: src.campaignId,
            kind: "audio",
            role: "voiceover",
            origin: "derived",
            storagePath: key,
            mimeType: "audio/mp4",
            bytes: stored.bytes,
            sha256: stored.sha256,
            durationSec: Math.round(norm.durationSec * 1000) / 1000,
            hasAudio: true,
            status: "ready",
            isProductTruth: false,
            sourceLabel: "founder_recording",
            labels: ["founder_recording", "voiceover"],
            title: `Your voice · ${src.title ?? src.originalFilename ?? "recording"}`.slice(0, 200),
            license: src.license,
            derivedFromAssetId: src.id,
          },
          { actor: ctx.actor },
        )
      ).entity;
    }
    await input.progress?.(40, "timing captions (Muse Voice Transcribe)");
    const { transcript, ran } = await transcribeAsset(ctx, asset, dir, local, input.keywords ?? []);
    const captions = transcriptToCaptionCues({ id: transcript.id, text: transcript.text, turns: transcript.turns, durationSec: asset.durationSec }, { idPrefix: `vo-${transcript.id}`.slice(0, 60), maxChars: 64 });
    return { asset, durationSec: asset.durationSec ?? 0, transcriptId: transcript.id, speech: speechOf(transcript), captions, warnings: [], ttsCalls: 0, ttsChars: 0, checkSeconds: ran ? (asset.durationSec ?? 0) : 0, checks: ran ? 1 : 0 };
  });
}

/** Credits for the provider work a voiceover actually did (same prices as the estimate). */
export function voiceoverCredits(prices: Record<string, number>, r: Pick<VoiceoverResult, "ttsCalls" | "ttsChars" | "checkSeconds" | "checks">): number {
  const tts = r.ttsCalls ? Math.max(1, Math.ceil(r.ttsChars / r.ttsCalls / 100)) * (prices["media.voiceover_per_100_chars"] ?? 1) * r.ttsCalls : 0;
  const check = r.checks * Math.max(1, Math.ceil(r.checkSeconds / 60)) * (prices["media.voiceover_check_per_min"] ?? 1);
  return tts + check;
}
