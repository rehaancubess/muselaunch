import { openAsBlob } from "node:fs";
import { AppError, type Platform } from "@muselaunch/platform";
import { z } from "zod";
import { metaClient, type CallContext } from "../meta/client";
import { voiceCost } from "../pricing";

/**
 * Muse Voice Transcribe, file transcription (https://dev.meta.ai/docs/speech-to-text,
 * /docs/api-reference/voice/transcribe): `POST /v1/asr/transcribe`, multipart with a `request` JSON
 * part and an `audio` WAV part (mono, 16-bit PCM, 16 or 24 kHz; ≤10 min; body ≤32 MB).
 * Speech-to-text only. Timing is turn-level (`startMs`/`endMs`); there are no word timestamps.
 */

export type VoiceMode = "PUSH_TO_TALK" | "ENDPOINTING" | "DIARIZATION";

/** Documented file limits. Callers split longer audio into chunks below MAX_SECONDS. */
export const VOICE_LIMITS = { maxSeconds: 600, maxBodyBytes: 32 * 1024 * 1024, chunkSeconds: 570, sampleRate: 24_000 } as const;

const Turn = z.object({
  turnId: z.number().int(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  transcript: z.string(),
  speaker: z.string().optional(),
});
export const VoiceTranscribeResponse = z.object({
  sessionId: z.string().default(""),
  transcript: z.string().default(""),
  audioDurationMs: z.number().nonnegative().default(0),
  turns: z.array(Turn).default([]),
});
export type VoiceTranscribeResponse = z.infer<typeof VoiceTranscribeResponse>;

export interface TranscribeFileInput {
  /** Local WAV path (mono s16le 16/24 kHz) or bytes. */
  wav: { path: string } | { data: Uint8Array };
  /** Expected audio length (for the spend estimate). */
  durationSec: number;
  mode: VoiceMode;
  languageBias?: string[];
  keywords?: string[];
  /** Correlation id echoed by the server (support requests). */
  sessionId?: string;
}

export async function transcribeFile(p: Platform, ctx: CallContext, input: TranscribeFileInput): Promise<VoiceTranscribeResponse> {
  if (input.durationSec > VOICE_LIMITS.maxSeconds + 1) {
    throw new AppError("BAD_REQUEST", `Audio is ${Math.round(input.durationSec)}s; Muse Voice Transcribe accepts up to ${VOICE_LIMITS.maxSeconds}s per request`);
  }
  const client = metaClient(p);
  const model = client.models.voice;
  const request: Record<string, unknown> = { model, audioEncoding: "WAV", mode: input.mode };
  if (input.languageBias?.length) request.languageBias = input.languageBias;
  if (input.keywords?.length) request.keywords = input.keywords;
  const path = `/asr/transcribe${input.sessionId ? `?sessionId=${encodeURIComponent(input.sessionId)}` : ""}`;

  return client.metered(ctx, { model, operation: "asr", estimatedUsd: voiceCost(input.durationSec + 1) }, async () => {
    const audio = "path" in input.wav ? await openAsBlob(input.wav.path, { type: "audio/wav" }) : new Blob([input.wav.data as Uint8Array<ArrayBuffer>], { type: "audio/wav" });
    if (audio.size > VOICE_LIMITS.maxBodyBytes - 64 * 1024) throw new AppError("BAD_REQUEST", "Audio chunk exceeds the 32 MB request limit");
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
    form.append("audio", audio, "audio.wav");
    const { data } = await client.fetchForm<unknown>(path, form, { signal: ctx.signal });
    const parsed = VoiceTranscribeResponse.safeParse(data);
    if (!parsed.success) throw new AppError("PROVIDER_ERROR", "Muse Voice Transcribe returned an unexpected response shape");
    const seconds = Math.floor(parsed.data.audioDurationMs / 1000);
    return {
      value: parsed.data,
      usage: { provider: "meta", model, operation: "asr", audioSeconds: seconds, costUsdEstimate: voiceCost(seconds), requestId: parsed.data.sessionId || undefined, dataMode: "standard" },
      trace: { request: { path, request, audioBytes: audio.size }, response: { ...parsed.data, transcript: parsed.data.transcript.slice(0, 2000), turns: parsed.data.turns.slice(0, 50) } },
    };
  });
}
