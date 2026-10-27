import { AppError, type Platform } from "@muselaunch/platform";
import type { CallContext } from "../meta/client";
import { httpError, meterExternal } from "../images/meter";
import { PRICES } from "../pricing";

/**
 * Optional narration via OpenAI text-to-speech (`POST /v1/audio/speech`). External provider, always
 * labelled `external_tts` and disclosed as an AI-generated voice (OpenAI usage policy). Built-in
 * voices only: custom voice ids are refused, so no voice is ever cloned.
 * (OpenAI lists tts-1/gpt-4o-mini-tts for shutdown on 2027-01-06; set OPENAI_TTS_MODEL to migrate.)
 */
export const BUILTIN_TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"] as const;
export type BuiltinVoice = (typeof BUILTIN_TTS_VOICES)[number];
export const DEFAULT_TTS_VOICE: BuiltinVoice = "marin";
export const TTS_MAX_CHARS = 4096;
export const TTS_DISCLOSURE = "AI-generated voice (external text-to-speech). Disclose to viewers that this voice is not a human recording.";

export function assertBuiltinVoice(voice: string | undefined): BuiltinVoice {
  const v = (voice ?? DEFAULT_TTS_VOICE).trim().toLowerCase();
  if (!(BUILTIN_TTS_VOICES as readonly string[]).includes(v)) {
    throw new AppError("BAD_REQUEST", `Unsupported voice "${voice}"`, {
      userMessage: `Choose one of the built-in voices (${BUILTIN_TTS_VOICES.join(", ")}). Voice cloning isn't supported.`,
    });
  }
  return v as BuiltinVoice;
}

export function ttsCost(chars: number): number {
  return (chars / 1000) * PRICES.openaiTtsPer1kChars;
}

export interface SpeechResult {
  audio: Buffer;
  mimeType: "audio/mpeg";
  provider: "openai";
  model: string;
  voice: BuiltinVoice;
  usageEventId: string;
  costUsd: number;
}

export async function synthesizeSpeech(
  p: Platform,
  ctx: CallContext,
  input: { text: string; voice?: string; instructions?: string },
  opts: { fetch?: typeof fetch } = {},
): Promise<SpeechResult> {
  const key = p.cfg.OPENAI_API_KEY;
  if (!key) throw new AppError("PROVIDER_NOT_CONFIGURED", "OPENAI_API_KEY is not set", { userMessage: "Voiceover (external TTS) isn't connected on this deployment." });
  const voice = assertBuiltinVoice(input.voice);
  const text = input.text.trim();
  if (!text) throw new AppError("BAD_REQUEST", "Empty text");
  if (text.length > TTS_MAX_CHARS) throw new AppError("BAD_REQUEST", `Text exceeds ${TTS_MAX_CHARS} characters`);
  const model = p.cfg.OPENAI_TTS_MODEL;
  const body: Record<string, unknown> = { model, voice, input: text, response_format: "mp3" };
  if (input.instructions && model.startsWith("gpt-")) body.instructions = input.instructions.slice(0, 500);
  const doFetch = opts.fetch ?? fetch;
  const { value, usageEvent } = await meterExternal(p, ctx, { provider: "openai", model, operation: "tts", estimatedUsd: ttsCost(text.length) + 0.001 }, async () => {
    const res = await doFetch(`${p.cfg.OPENAI_BASE_URL.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) throw await httpError(res, "OpenAI TTS");
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new AppError("PROVIDER_ERROR", "OpenAI TTS returned no audio");
    return { value: audio, usage: { costUsdEstimate: ttsCost(text.length) }, trace: { request: body, response: { bytes: audio.length, contentType: res.headers.get("content-type") } } };
  });
  return { audio: value, mimeType: "audio/mpeg", provider: "openai", model, voice, usageEventId: usageEvent.id, costUsd: usageEvent.costUsdEstimate };
}
