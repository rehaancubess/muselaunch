import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { workspaceKey, type JobContext } from "@muselaunch/platform";
import { synthesizeSpeech, TTS_DISCLOSURE } from "@muselaunch/providers";
import { probeMedia } from "./ffmpeg";
import { callCtx, derivedId, mediaDeps, sha256, withWorkdir } from "./util";

/**
 * `media.tts` (optional): narration from an external TTS provider. The asset is explicitly labelled
 * `external_tts` + `ai_voice`, uses a built-in provider voice (never a clone of a real person), and
 * carries a disclosure string the UI/export must show.
 */
export async function ttsHandler(ctx: JobContext<"media.tts">) {
  const { text, voice, appId, compositionId } = ctx.payload;
  const repo = ctx.ws.collection("mediaAssets");
  const id = derivedId("ast", ctx.job.id, "tts");
  const done = await repo.get(id);
  if (done?.status === "ready") return { refs: [{ entity: "mediaAssets", id }], data: { reused: true, disclosure: TTS_DISCLOSURE } };

  await ctx.progress(10, "synthesising voiceover");
  const speech = await synthesizeSpeech(ctx.platform, callCtx(ctx, "tts.voiceover"), { text, voice }, { fetch: mediaDeps(ctx.platform).fetch });
  ctx.throwIfCancelled();
  const key = workspaceKey(ctx.workspaceId, "generated", id, "voiceover.mp3");
  const { bytes } = await ctx.platform.storage.put(key, speech.audio, { contentType: speech.mimeType });
  const info = await withWorkdir(async (dir) => {
    const f = join(dir, "v.mp3");
    await writeFile(f, speech.audio);
    return probeMedia(f);
  });
  const { entity } = await repo.createIfAbsent(
    {
      id,
      appId,
      kind: "audio",
      role: "tts",
      origin: "generated",
      storagePath: key,
      mimeType: speech.mimeType,
      bytes,
      sha256: sha256(speech.audio),
      durationSec: info.durationSec,
      hasAudio: true,
      status: "ready",
      isProductTruth: false,
      sourceLabel: "external_tts",
      labels: ["external_tts", "ai_voice", `voice:${speech.voice}`, ...(compositionId ? [`composition:${compositionId}`] : [])],
      title: `AI voiceover · OpenAI TTS (${speech.voice})`,
      license: { type: "generated_terms", provider: "OpenAI TTS", termsUrl: "https://openai.com/policies/usage-policies/", restrictions: TTS_DISCLOSURE },
      generation: { provider: speech.provider, model: speech.model, prompt: text.slice(0, 4000), revision: 1, usageEventId: speech.usageEventId },
    },
    { actor: ctx.actor },
  );
  await ctx.progress(100, "done");
  return { refs: [{ entity: "mediaAssets", id: entity.id }], data: { assetId: entity.id, durationSec: entity.durationSec, voice: speech.voice, model: speech.model, sourceLabel: "external_tts", disclosure: TTS_DISCLOSURE } };
}
