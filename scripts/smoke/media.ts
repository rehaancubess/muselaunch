import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg, handlers, loadTracks, requestClipAnalysis, toWav } from "@muselaunch/media";
import { makeTestClip, storeUpload } from "@muselaunch/media/testing";
import { createPlatform, createRunner, museImageEligible, type Platform } from "@muselaunch/platform";
import { chooseImageProvider, deleteMetaFile, guardImagePrompt, OpenAiImageProvider, runSam, synthesizeSpeech, transcribeFile, uploadMetaFile } from "@muselaunch/providers";
import { saveLive } from "./_save";
import { installWireCapture } from "./_wire";

/**
 * Module D live smoke (minimal REAL calls, ≈ $0.10 total):
 *  1. SAM 3.1 on a tiny generated PNG (concept prompt) — 1 image ($0.0025)
 *  2. SAM 3.1 on a 2 s generated MP4 via the Files API (input_video.file_id) — billed 50 frames ($0.01)
 *  3. Muse Voice Transcribe on a short WAV (spoken via OpenAI TTS when OPENAI_API_KEY is set, else a tone)
 *  4. OpenAI Images, 1 image (only if OPENAI_API_KEY is set; Muse Image is never called when ineligible)
 *  5. Clip analysis (person + phone, ≤3 s, with transcript) through the real job pipeline.
 *     Set SMOKE_CLIP=/path/to/clip.mp4 to a short recording of you holding a phone; without it a
 *     synthetic shapes clip is used (SAM may honestly find no person/phone in it).
 * Redacted responses are saved under fixtures/live/ for parser checks.
 */
export async function run(p: Platform): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "smoke-media-"));
  const ctx = { workspaceId: "smoke", task: "smoke.media" };
  const out: string[] = [];
  try {
    // 1) SAM on an image.
    const png = join(dir, "box.png");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x2B59FF:s=320x240", "-f", "lavfi", "-i", "color=c=0xFF3B30:s=120x90", "-filter_complex", "[0:v][1:v]overlay=x=100:y=75,format=rgb24", "-frames:v", "1", png]);
    const img = await runSam(p, ctx, { media: { kind: "image", imageUrl: `data:image/png;base64,${readFileSync(png).toString("base64")}` }, prompt: { kind: "text", text: "red rectangle" } });
    saveLive("sam-image", { objectIds: img.objectIds, detections: img.detections.map((d) => ({ ...d, mask: { ...d.mask, payload: d.mask.payload.slice(0, 80) } })), diagnostics: img.diagnostics, rawOutput: img.rawOutput });
    out.push(`sam.image objects=${img.objectIds.length} bounds=${JSON.stringify(img.detections[0]?.bounds ?? null)} conf=${img.detections[0]?.confidence ?? "n/a"}`);

    // 2) SAM on a short video through the Files API.
    const mp4 = join(dir, "clip.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x2B59FF:s=320x240:r=10:d=2", "-f", "lavfi", "-i", "color=c=0xFF3B30:s=80x80:r=10:d=2", "-filter_complex", "[0:v][1:v]overlay=x='20+n*8':y=80:shortest=1,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", mp4]);
    const file = await uploadMetaFile(p, ctx, { localPath: mp4, filename: "clip.mp4", mimeType: "video/mp4", expiresAfterSec: 3600 });
    try {
      const vid = await runSam(p, ctx, { media: { kind: "video", fileId: file.id }, prompt: { kind: "text", text: "red square" }, frameCount: 20 });
      saveLive("sam-video", { fileId: file.id, frames: vid.frames, objectIds: vid.objectIds, diagnostics: vid.diagnostics, rawOutput: vid.rawOutput.slice(0, 20_000) });
      out.push(`sam.video file=${file.id} framesWithDetections=${vid.frames.length}/20 objects=${vid.objectIds.join(",") || "none"}`);
    } finally {
      await deleteMetaFile(p, file.id);
    }

    // 3) Voice Transcribe on a short WAV.
    let source = join(dir, "tone.wav");
    let expected = "(tone only: empty transcript is a valid result)";
    if (p.cfg.OPENAI_API_KEY) {
      const speech = await synthesizeSpeech(p, ctx, { text: "MuseLaunch voice check. Make the opening more engaging.", voice: "marin" });
      source = join(dir, "speech.mp3");
      writeFileSync(source, speech.audio);
      expected = "speech via OpenAI TTS";
    } else {
      await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1", "-t", "2", source]);
    }
    const wav = join(dir, "voice.wav");
    await toWav(source, wav);
    const tr = await transcribeFile(p, ctx, { wav: { path: wav }, durationSec: 5, mode: "DIARIZATION", sessionId: "muselaunch-smoke" });
    saveLive("voice-transcribe", tr);
    out.push(`voice "${tr.transcript.slice(0, 80)}" turns=${tr.turns.length} ms=${tr.audioDurationMs} (${expected})`);

    // 4) Images: provider decided by the geo gate (Muse Image never called when ineligible).
    const gate = museImageEligible(p.cfg, p.cfg.OPERATOR_COUNTRY);
    if (p.cfg.OPENAI_API_KEY) {
      const choice = chooseImageProvider(p, p.cfg.OPERATOR_COUNTRY);
      const guard = guardImagePrompt("Minimal soft gradient background in calm blue tones, abstract shapes");
      if (choice.id === "openai" && guard.ok) {
        const res = await new OpenAiImageProvider(p).generate(ctx, { prompt: guard.prompt, n: 1, size: "1024x1024" });
        writeFileSync(join(dir, "gen.png"), res.images[0]!.data);
        saveLive("openai-image", { model: res.model, bytes: res.images[0]!.data.length, costUsd: res.costUsd });
        out.push(`image openai/${res.model} bytes=${res.images[0]!.data.length} cost≈$${res.costUsd.toFixed(3)}`);
      } else out.push(`image provider=${choice.id} (skipped: smoke only exercises OpenAI)`);
    } else out.push("image skipped (OPENAI_API_KEY not set)");
    out.push(`museImage eligible=${gate.eligible} (${gate.reason})`);

    // 5) Clip analysis end-to-end (probe → SAM per prompt → tracks + per-object cutouts → transcript).
    out.push(await clipAnalysis(p, dir));
    return out.join(" | ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function clipAnalysis(p: Platform, dir: string): Promise<string> {
  // Own inline runner with the media handlers, sharing the smoke run's DB/storage.
  const q = createPlatform({ cfg: p.cfg, db: p.db, storage: p.storage });
  installWireCapture(q);
  createRunner(q, handlers, "smoke-media");
  const wid = "smoke";
  await q.credits.ensureAccount(wid, { grant: 300, reason: "smoke" });
  const clip = join(dir, "analyze.mp4");
  const supplied = process.env.SMOKE_CLIP;
  if (supplied) await ffmpeg(["-i", supplied, "-t", "3", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", clip]);
  else await makeTestClip(clip);
  const uploaded = await storeUpload(q, wid, clip, { kind: "video", role: "founder_clip", mimeType: "video/mp4", consent: true, actor: "smoke-owner" });
  await q.jobs.create(wid, "media.probe", { assetId: uploaded.id }, { actor: "smoke-owner", idempotencyKey: `probe:${uploaded.id}` });
  await q.inline!.drain();
  const asset = await q.db.ws(wid).collection("mediaAssets").getOrThrow(uploaded.id);
  const { analysis } = await requestClipAnalysis(q, wid, { asset, prompts: ["person", "phone"], transcribe: true, actor: "smoke-owner" });
  await q.inline!.drain();
  const a = await q.db.ws(wid).collection("clipAnalyses").getOrThrow(analysis.id);
  const tracks = await Promise.all(Object.values(a.segmentationIds).map((id) => loadTracks(q, q.db.ws(wid), id)));
  saveLive("clip-analysis", { source: supplied ? "SMOKE_CLIP" : "synthetic shapes", analysis: a, tracks: tracks.map((t) => t && { ...t, tracks: t.tracks.map((tr) => ({ ...tr, frames: tr.frames.slice(0, 10) })) }) });
  const transcript = a.transcriptId ? await q.db.ws(wid).collection("transcripts").get(a.transcriptId) : null;
  const objs = a.objects.map((o) => `${o.key} q=${o.trackingQuality ?? "?"} ${o.presence.map((r) => `${r.startSec}-${r.endSec}s`).join(",")}`).join("; ");
  return `clip(${supplied ? "your clip" : "synthetic"}) status=${a.status} objects=[${objs || "none"}]${a.error ? ` error="${a.error}"` : ""} transcript="${transcript?.text.slice(0, 60) ?? "-"}"`;
}
