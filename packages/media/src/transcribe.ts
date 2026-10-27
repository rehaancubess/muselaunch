import { join } from "node:path";
import type { MediaAsset, Transcript } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, type JobContext } from "@muselaunch/platform";
import { transcribeFile, VOICE_LIMITS, type VoiceMode } from "@muselaunch/providers";
import { ffmpeg, probeMedia } from "./ffmpeg";
import { callCtx, derivedId, EXT_BY_MIME, usageEventIdsForJob, withWorkdir } from "./util";

/**
 * `media.transcribe` (Muse Voice Transcribe). Speech-to-text only, turn-level timing.
 * - `voice_command`: PUSH_TO_TALK (fastest; text only) for spoken editing instructions.
 * - everything else: DIARIZATION (speaker-attributed turns) for captions and founder briefs.
 * Audio is converted to the documented WAV (mono s16le 24 kHz) and split into ≤9.5-min chunks.
 */

export const modeForPurpose = (purpose: Transcript["purpose"]): VoiceMode => (purpose === "voice_command" ? "PUSH_TO_TALK" : "DIARIZATION");
/** Longest audio we will transcribe in one job (6 chunks). */
export const MAX_TRANSCRIBE_SECONDS = 60 * 60;

export async function toWav(input: string, output: string, opts: { startSec?: number; durationSec?: number; signal?: AbortSignal } = {}): Promise<void> {
  await ffmpeg(
    [
      ...(opts.startSec ? ["-ss", opts.startSec.toFixed(3)] : []),
      "-i", input,
      ...(opts.durationSec ? ["-t", opts.durationSec.toFixed(3)] : []),
      "-vn", "-ac", "1", "-ar", String(VOICE_LIMITS.sampleRate), "-c:a", "pcm_s16le", "-map_metadata", "-1",
      output,
    ],
    { signal: opts.signal },
  );
}

export async function transcribeHandler(ctx: JobContext<"media.transcribe">) {
  const repo = ctx.ws.collection("transcripts");
  const t = await repo.getOrThrow(ctx.payload.transcriptId);
  if (t.status === "succeeded") return { refs: [{ entity: "transcripts", id: t.id }], data: { alreadyDone: true, text: t.text.slice(0, 4000) }, creditsUsed: 0 };
  const asset = await ctx.ws.collection("mediaAssets").getOrThrow(t.sourceAssetId);
  const { refs, data } = await withWorkdir((dir) =>
    runTranscriptionSafely(ctx, t, asset, dir, { languageBias: ctx.payload.languageBias, keywords: ctx.payload.keywords, progress: (pct, stage, msg) => ctx.progress(pct, stage, msg), usageBefore: new Set() }),
  );
  await ctx.progress(100, "done");
  return { refs, data };
}

export interface TranscribeRunOptions {
  languageBias?: string[];
  keywords?: string[];
  progress: (pct: number, stage: string, message?: string) => Promise<void> | void;
  /** Usage events already on this job before this run (excluded from the transcript's usageEventIds). */
  usageBefore: Set<string>;
  /** Already-downloaded source (clip analysis). */
  localFile?: string;
}

/** Validate, run, and record failure on the transcript (status `failed`) before rethrowing. */
export async function runTranscriptionSafely(ctx: JobContext, t: Transcript, asset: MediaAsset, dir: string, opts: TranscribeRunOptions) {
  const repo = ctx.ws.collection("transcripts");
  try {
    if (asset.status !== "ready") throw new AppError("CONFLICT", `Source asset is ${asset.status}`, { retryable: false });
    if (asset.kind !== "audio" && asset.kind !== "video") throw new AppError("BAD_REQUEST", "Only audio or video can be transcribed", { retryable: false });
    if (asset.hasAudio === false) throw new AppError("BAD_REQUEST", "This video has no audio track", { retryable: false, userMessage: "That video has no sound to transcribe." });
    await repo.update(t.id, { status: "running", error: undefined }, { actor: ctx.actor });
    return await runTranscription(ctx, t, asset, dir, opts);
  } catch (err) {
    const e = err instanceof AppError ? err : new AppError("INTERNAL", (err as Error).message, { retryable: false, cause: err });
    if (!e.retryable || e.code === "CANCELLED") await repo.update(t.id, { status: "failed", error: e.message.slice(0, 1000) }, { actor: ctx.actor }).catch(() => {});
    throw e;
  }
}

async function runTranscription(ctx: JobContext, t: Transcript, asset: MediaAsset, dir: string, opts: TranscribeRunOptions) {
  const p = ctx.platform;
  let src = opts.localFile;
  if (!src) {
    src = join(dir, `source.${EXT_BY_MIME[asset.mimeType] ?? "bin"}`);
    await opts.progress(5, "preparing audio");
    await p.storage.downloadToFile(asset.storagePath, src);
  }
  const info = await probeMedia(src, { signal: ctx.signal });
  if (!info.hasAudio) throw new AppError("BAD_REQUEST", "No audio track", { retryable: false, userMessage: "That file has no sound to transcribe." });
  const total = info.durationSec ?? asset.durationSec ?? 0;
  if (total > MAX_TRANSCRIBE_SECONDS) throw new AppError("BAD_REQUEST", "Audio longer than 60 minutes", { retryable: false, userMessage: "Recordings up to 60 minutes can be transcribed. Trim it first." });
  const mode = t.mode ?? modeForPurpose(t.purpose);
  const chunkLen = VOICE_LIMITS.chunkSeconds;
  const chunks = Math.max(1, Math.ceil(total / chunkLen));
  const texts: string[] = [];
  const turns: Transcript["turns"] = [];
  let processedMs = 0;
  for (let i = 0; i < chunks; i++) {
    ctx.throwIfCancelled();
    const wav = join(dir, `${t.id}-chunk-${i}.wav`);
    const start = i * chunkLen;
    await toWav(src, wav, { startSec: chunks > 1 ? start : undefined, durationSec: chunks > 1 ? chunkLen : undefined, signal: ctx.signal });
    await opts.progress(10 + (80 * i) / chunks, "transcribing", chunks > 1 ? `part ${i + 1} of ${chunks}` : undefined);
    const res = await transcribeFile(p, callCtx(ctx, `transcribe.${t.purpose}`), {
      wav: { path: wav },
      durationSec: Math.min(chunkLen, Math.max(0.1, total - start)),
      mode,
      languageBias: opts.languageBias,
      keywords: opts.keywords,
      sessionId: `${t.id}-${i}`.slice(0, 100),
    });
    if (res.transcript.trim()) texts.push(res.transcript.trim());
    const offset = chunks > 1 ? start : 0;
    for (const turn of res.turns) {
      turns.push({
        startSec: Math.round((turn.startMs / 1000 + offset) * 1000) / 1000,
        endSec: Math.round((turn.endMs / 1000 + offset) * 1000) / 1000,
        // Speaker labels are scoped to one request: keep chunk scopes distinct rather than claim continuity.
        speaker: turn.speaker ? (i === 0 ? turn.speaker : `${turn.speaker}·${i + 1}`).slice(0, 40) : undefined,
        text: turn.transcript.slice(0, 5000),
      });
    }
    processedMs += res.audioDurationMs;
  }
  const text = texts.join(" ").slice(0, 100_000);
  const usageEventIds = (await usageEventIdsForJob(ctx)).filter((id) => !opts.usageBefore.has(id));
  const updated = await ctx.ws.collection("transcripts").update(
    t.id,
    { status: "succeeded", text, turns: turns.slice(0, 5000), durationSec: Math.round(processedMs) / 1000 || total, mode, usageEventIds: [...new Set([...t.usageEventIds, ...usageEventIds])].slice(-200), error: undefined },
    { actor: ctx.actor },
  );
  const refs = [{ entity: "transcripts", id: t.id }];
  if (t.purpose === "founder_brief" && t.appId && text) refs.push(...(await storeFounderEvidence(ctx.ws, ctx.actor, updated, asset)));
  return { refs, transcript: updated, data: { text: text.slice(0, 4000), turns: updated.turns.length, durationSec: updated.durationSec, mode } };
}

/**
 * Founder brief → App DNA evidence (module B consumes): verbatim excerpts of what the founder said,
 * sourced to the recording, `needs_review`. Facts are quotes, not model inferences.
 */
export async function storeFounderEvidence(ws: WorkspaceDb, actor: string, t: Transcript, asset: MediaAsset) {
  const repo = ws.collection("appEvidence");
  const groups: { text: string; startSec: number }[] = [];
  const units = t.turns.length ? t.turns.map((u) => ({ text: u.text, startSec: u.startSec })) : [{ text: t.text, startSec: 0 }];
  let cur: { text: string; startSec: number } | undefined;
  for (const u of units) {
    if (cur && (cur.text + " " + u.text).length <= 900) cur.text += ` ${u.text}`;
    else {
      if (cur) groups.push(cur);
      cur = { text: u.text.slice(0, 900), startSec: u.startSec };
    }
  }
  if (cur) groups.push(cur);
  const now = new Date().toISOString();
  const refs: { entity: string; id: string }[] = [];
  for (const [i, g] of groups.slice(0, 20).entries()) {
    const id = derivedId("evd", t.id, String(i));
    const fact = `Founder said (recorded brief, ${Math.floor(g.startSec / 60)}:${String(Math.floor(g.startSec % 60)).padStart(2, "0")}): “${g.text.trim()}”`.slice(0, 1000);
    await repo.createIfAbsent(
      {
        id,
        appId: t.appId!,
        kind: "other",
        fact,
        source: { kind: "recording", assetId: asset.id, title: asset.title ?? asset.originalFilename ?? "Founder recording", retrievedAt: now, excerpt: g.text.slice(0, 2000), contentHash: asset.sha256 },
        assetId: asset.isProductTruth ? asset.id : undefined,
        observedAt: now,
        reviewState: "needs_review",
      },
      { actor },
    );
    refs.push({ entity: "appEvidence", id });
  }
  return refs;
}
