import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrandProfile, Job, MediaAsset, RecordingSegment, Transcript } from "@muselaunch/contracts";
import { AppError, toAppError, workspaceKey, type JobContext, type Platform } from "@muselaunch/platform";
import { generateJson, imagePart, metaClient, untrusted, type InputPart } from "@muselaunch/providers";
import { z } from "zod";
import { probeMedia } from "./ffmpeg";
import { detectShots, extractFrame, keyframeTimes, mapLimit, sampleFrameChanges, type Shot } from "./frames";
import { ensureConsent, findOrCreateTranscript } from "./service";
import { runTranscriptionSafely } from "./transcribe";
import { callCtx, derivedId, EXT_BY_MIME, inheritFrom, usageEventIdsForJob, withWorkdir } from "./util";

/**
 * Walkthrough breakdown (`media.analyze_recording`). The developer records ONE long screen recording
 * tapping through every main feature; MuseLaunch cuts it into labelled clips that every video can reuse:
 *
 * 1. shot detection on sampled frames (FFmpeg), micro-shots merged, long shots split at calm moments;
 * 2. narration (Muse Voice Transcribe), only when consent for the voice is recorded on the asset;
 * 3. 1–2 stills per shot (short edge ≈540 px) → Muse Spark (multimodal, ≤8 images per call) labels each
 *    shot with what happens, the App DNA features it shows, a marketing quality score and visible
 *    personal information (regions to blur);
 * 4. adjacent shots with the same label/features are merged; RecordingSegments replace earlier ones for
 *    the recording (idempotent); the recording is added as evidence to the App DNA features it shows.
 *
 * Shots the model did not label stay as honest "Unlabelled shot" segments with low quality.
 */

/** Longest walkthrough we break down (≈10 min). */
export const MAX_RECORDING_SEC = 600;
/** Images per Muse Spark call. */
export const FRAMES_PER_CALL = 8;
/** Above this many stills in total, every shot gets one still. */
const MAX_FRAMES = 200;
/** Merged segments stay short enough to be useful clips. */
const MAX_MERGED_SEC = 15;
const SPARK_CONCURRENCY = 3;
/** Features shown by segments at least this good get the recording as evidence. */
const EVIDENCE_QUALITY = 0.4;
const UNLABELLED_QUALITY = 0.2;

const clock = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;

export function estimateRecordingAnalysis(p: Platform, asset: Pick<MediaAsset, "durationSec">): { credits: number; minutes: number; perMinute: number } {
  const minutes = Math.max(1, Math.ceil(Math.min(asset.durationSec ?? 60, MAX_RECORDING_SEC) / 60));
  const perMinute = p.credits.prices["media.analyze_recording_per_min"] ?? 6;
  return { credits: minutes * perMinute, minutes, perMinute };
}

/** Why a recording can't be broken down (null when it can). */
export function recordingProblem(asset: MediaAsset, appId?: string): AppError | null {
  if (asset.status === "deleted" || (appId && asset.appId !== appId)) return new AppError("NOT_FOUND", "Recording not found");
  if (asset.kind !== "video" || asset.role !== "app_recording") return new AppError("BAD_REQUEST", "Not an app recording", { userMessage: "Choose a screen recording of your app (type: App recording)." });
  if (!asset.appId) return new AppError("BAD_REQUEST", "Recording is not attached to an app", { userMessage: "Upload the recording from your app's Library so we know which app it shows." });
  if (asset.status !== "ready") return new AppError("CONFLICT", `Recording is ${asset.status}`, { userMessage: "This recording is still processing. Try again in a moment." });
  if ((asset.durationSec ?? 0) > MAX_RECORDING_SEC) return new AppError("BAD_REQUEST", "Recording longer than 10 minutes", { userMessage: "Walkthroughs up to 10 minutes can be cut into clips. Trim it and upload it again." });
  return null;
}

export async function requestRecordingAnalysis(
  p: Platform,
  wid: string,
  input: { asset: MediaAsset; appId: string; actor: string; transcribe?: boolean; consent?: { scope: string }; idempotencyKey?: string },
): Promise<{ job: Job; estimate: ReturnType<typeof estimateRecordingAnalysis> }> {
  let asset = input.asset;
  const problem = recordingProblem(asset, input.appId);
  if (problem) throw problem;
  // Consent covers transcribing the founder's voice; without it the clips are labelled from pictures only.
  if (input.consent) asset = await ensureConsent(p, wid, asset, input.consent, input.actor, "transcribing the narration of a recording");
  const estimate = estimateRecordingAnalysis(p, asset);
  const job = await p.jobs.create(wid, "media.analyze_recording", { appId: input.appId, assetId: asset.id, transcribe: input.transcribe ?? true }, {
    actor: input.actor,
    appId: input.appId,
    idempotencyKey: input.idempotencyKey ?? `walkthrough:${asset.id}:${Date.now()}`,
    credits: { operation: "media.analyze_recording", amount: estimate.credits },
  });
  return { job, estimate };
}

/**
 * Called when an upload finishes processing (media.probe): app recordings of an app are broken down
 * automatically. Never fails the probe: missing credits, quota or keys are logged on the probe job.
 */
export async function autoAnalyzeRecording(ctx: JobContext, asset: MediaAsset): Promise<string | undefined> {
  if (asset.role !== "app_recording" || asset.kind !== "video" || !asset.appId || asset.status !== "ready") return undefined;
  if (!metaClient(ctx.platform).configured) return undefined;
  const problem = recordingProblem(asset);
  if (problem) {
    await ctx.log_event(`Walkthrough not cut into clips: ${problem.opts.userMessage ?? problem.message}`);
    return undefined;
  }
  try {
    const job = await ctx.enqueue("media.analyze_recording", { appId: asset.appId, assetId: asset.id, transcribe: true }, {
      appId: asset.appId,
      idempotencyKey: `walkthrough:${asset.id}:auto`,
      credits: { operation: "media.analyze_recording", amount: estimateRecordingAnalysis(ctx.platform, asset).credits },
    });
    return job.id;
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code !== "INSUFFICIENT_CREDITS" && err.code !== "QUOTA_EXCEEDED") ctx.log.warn({ err, assetId: asset.id }, "could not queue the walkthrough breakdown");
    await ctx.log_event(`Walkthrough not cut into clips yet: ${err.opts.userMessage ?? err.message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Muse Spark labelling
// ---------------------------------------------------------------------------

const Unit = z.number().min(0).max(1);
export const ShotLabels = z.object({
  shots: z
    .array(
      z.object({
        shot: z.number().int().min(0).max(10_000).describe("The shot number from the list"),
        label: z.string().min(1).max(300).describe("What happens in the shot, ≤ 12 words"),
        screen: z.string().max(120).optional().describe("Screen or area shown"),
        action: z.enum(["navigate", "tap", "type", "scroll", "swipe", "speak", "wait", "other"]),
        featureIds: z.array(z.string().max(128)).max(10).default([]),
        quality: Unit.describe("0–1 usefulness for a marketing video"),
        privacy: z
          .object({
            flagged: z.boolean(),
            notes: z.string().max(300).optional(),
            // Fractions of the frame; slightly out-of-range boxes are clamped afterwards rather than rejected.
            regions: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).describe("0–1 fractions of the frame, origin top-left")).max(8).default([]),
          })
          .default({ flagged: false, regions: [] }),
      }),
    )
    .max(16),
});
type ShotLabel = z.infer<typeof ShotLabels>["shots"][number];

const INSTRUCTIONS = `You are Muse Spark labelling a screen recording that an app's developer made while tapping through their app. MuseLaunch cuts the recording into clips for marketing videos.
Each numbered shot is one continuous stretch of the recording; you see 1–2 still frames per shot, in time order. Some shots include what the developer said at that moment.

For EVERY shot listed, return:
- label: what happens, specific and short (at most 12 words), e.g. "Saves a hotel booking from Photos via the share sheet". Describe only what is visible or said; never invent features, numbers or results.
- screen: the screen or area of the app shown.
- action: navigate | tap | type | scroll | swipe | speak | wait | other.
- featureIds: ids of the listed App DNA features this shot clearly demonstrates; [] when none. Only use ids from the list.
- quality (0–1): how useful the shot is in a marketing video. Low (≤ 0.3): loading or blank screens, lock screen, home screen, Control Center, system alerts or permission prompts, a keyboard covering most of the screen, accidental taps or fumbling, blurred or mid-transition frames. High (≥ 0.8): a clear, polished screen showing a feature working.
- privacy: flagged = true when personal information is visible: notification banners, people's names, email addresses, phone numbers, street addresses, account or payment details, private messages or photos of people. For each item give a region (x, y, w, h as 0–1 fractions of the frame, origin top-left, generous enough to blur) and a short note. Obvious sample/demo content is not personal information.`;

interface ShotWork extends Shot {
  index: number;
  frames: { atSec: number; file: string }[];
  narration?: string;
}

interface LabelledShot extends ShotWork {
  labelled: boolean;
  label: string;
  screen?: string;
  action: RecordingSegment["action"];
  featureIds: string[];
  quality: number;
  privacy: RecordingSegment["privacy"];
  /** Still used as the segment's keyframe. */
  keyframe: { atSec: number; file: string };
  labelledBy?: string;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

function cleanRegions(regions: { x: number; y: number; w: number; h: number }[]): RecordingSegment["privacy"]["regions"] {
  return regions
    .map((r) => {
      const x = clamp01(r.x);
      const y = clamp01(r.y);
      return { x, y, w: clamp01(Math.min(r.w, 1 - x)), h: clamp01(Math.min(r.h, 1 - y)) };
    })
    .filter((r) => r.w > 0.005 && r.h > 0.005)
    .slice(0, 8);
}

/** Group shots into Spark calls of ≤ FRAMES_PER_CALL images without splitting a shot. */
export function batchShots<T extends { frames: unknown[] }>(shots: T[], perCall = FRAMES_PER_CALL): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let n = 0;
  for (const s of shots) {
    if (cur.length && n + s.frames.length > perCall) {
      batches.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(s);
    n += s.frames.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function labelBatch(ctx: JobContext, batch: ShotWork[], app: { name: string }, features: BrandProfile["features"]): Promise<{ labels: Map<number, ShotLabel>; model: string }> {
  const parts: InputPart[] = [];
  const lines: string[] = [];
  const narration: string[] = [];
  let img = 0;
  for (const s of batch) {
    const first = img + 1;
    for (const f of s.frames) {
      parts.push(imagePart({ bytes: await readFile(f.file), mimeType: "image/jpeg" }));
      img++;
    }
    const imgs = img === first ? `image ${first}` : `images ${first}–${img}`;
    lines.push(`Shot ${s.index} · ${clock(s.startSec)}–${clock(s.endSec)} (${(s.endSec - s.startSec).toFixed(1)} s)${s.motion ? " · continuous motion (scrolling or animation)" : ""} · ${imgs}`);
    if (s.narration) narration.push(`Shot ${s.index}: ${s.narration.slice(0, 400)}`);
  }
  const text = [
    `App: ${app.name}`,
    "",
    "App DNA features (id: name — description):",
    features.length ? untrusted("app_dna_features", features.map((f) => `${f.id}: ${f.name} — ${f.description.slice(0, 200)}`).join("\n"), 8000) : "(none yet: return featureIds [])",
    "",
    "Shots in this batch, in time order:",
    ...lines,
    ...(narration.length ? ["", "What the developer said during these shots (transcript):", untrusted("walkthrough_narration", narration.join("\n"), 6000)] : []),
    "",
    `Return exactly one entry per shot number listed (${batch.map((s) => s.index).join(", ")}).`,
  ].join("\n");
  const out = await generateJson(ctx.platform, {
    ctx: callCtx(ctx, "media.analyze_recording"),
    model: "spark",
    instructions: INSTRUCTIONS,
    input: [{ type: "input_text", text }, ...parts],
    schema: ShotLabels,
    schemaName: "RecordingShotLabels",
    maxOutputTokens: 3000,
    reasoningEffort: "low",
    cacheKey: "media.recording_labels",
  });
  const want = new Set(batch.map((s) => s.index));
  const labels = new Map<number, ShotLabel>();
  for (const l of out.data.shots) if (want.has(l.shot) && !labels.has(l.shot)) labels.set(l.shot, l);
  return { labels, model: out.model };
}

/** Merge adjacent shots that show the same thing (same label, or same screen + action + features). */
export function mergeAdjacent(shots: LabelledShot[]): LabelledShot[] {
  const out: LabelledShot[] = [];
  for (const s of shots) {
    const prev = out[out.length - 1];
    const same =
      prev &&
      prev.labelled &&
      s.labelled &&
      sameSet(prev.featureIds, s.featureIds) &&
      (norm(prev.label) === norm(s.label) || (Boolean(prev.screen) && norm(prev.screen) === norm(s.screen) && prev.action === s.action && s.featureIds.length > 0));
    if (!prev || !same || s.startSec - prev.endSec > 1.2 || s.endSec - prev.startSec > MAX_MERGED_SEC) {
      out.push(s);
      continue;
    }
    const a = prev.endSec - prev.startSec;
    const b = s.endSec - s.startSec;
    out[out.length - 1] = {
      ...prev,
      endSec: s.endSec,
      motion: prev.motion || s.motion,
      frames: [...prev.frames, ...s.frames],
      quality: Math.round(((prev.quality * a + s.quality * b) / (a + b)) * 1000) / 1000,
      privacy: {
        flagged: prev.privacy.flagged || s.privacy.flagged,
        notes: [prev.privacy.notes, s.privacy.notes].filter(Boolean).join(" · ").slice(0, 300) || undefined,
        regions: [...prev.privacy.regions, ...s.privacy.regions].slice(0, 8),
      },
      keyframe: s.quality > prev.quality ? s.keyframe : prev.keyframe,
    };
  }
  return out;
}

/** Narration overlapping [start, end) from turn-level transcript timing. */
export function narrationFor(turns: Transcript["turns"], startSec: number, endSec: number): string | undefined {
  const text = turns
    .filter((t) => t.endSec > startSec && t.startSec < endSec && t.text.trim())
    .map((t) => t.text.trim())
    .join(" ")
    .trim();
  return text ? text.slice(0, 2000) : undefined;
}

async function waitForDna(ctx: JobContext, appId: string, timeoutMs = 4 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const app = await ctx.ws.collection("apps").get(appId);
    if (!app || app.dnaStatus !== "drafting" || Date.now() > deadline) return;
    ctx.throwIfCancelled();
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function analyzeRecordingHandler(ctx: JobContext<"media.analyze_recording">) {
  const asset = await ctx.ws.collection("mediaAssets").getOrThrow(ctx.payload.assetId);
  const problem = recordingProblem(asset, ctx.payload.appId);
  if (problem) throw new AppError(problem.code, problem.message, { retryable: false, userMessage: problem.opts.userMessage });
  const result = await withWorkdir((dir) => runBreakdown(ctx, asset, dir));
  await ctx.progress(100, "done");
  return result;
}

async function runBreakdown(ctx: JobContext<"media.analyze_recording">, asset: MediaAsset, dir: string) {
  const p = ctx.platform;
  const ws = ctx.ws;
  const appId = ctx.payload.appId;
  const app = await ws.collection("apps").getOrThrow(appId);

  await ctx.progress(2, "preparing recording");
  const src = join(dir, `source.${EXT_BY_MIME[asset.mimeType] ?? "mp4"}`);
  await p.storage.downloadToFile(asset.storagePath, src);
  const info = await probeMedia(src, { signal: ctx.signal });
  const duration = info.durationSec ?? asset.durationSec ?? 0;
  if (!info.hasVideo || duration <= 0) throw new AppError("BAD_REQUEST", "No video stream", { retryable: false, userMessage: "That recording has no playable video." });
  if (duration > MAX_RECORDING_SEC + 1) throw new AppError("BAD_REQUEST", "Recording longer than 10 minutes", { retryable: false, userMessage: "Walkthroughs up to 10 minutes can be cut into clips. Trim it and upload it again." });

  // 1) Shots.
  await ctx.progress(6, "finding shots");
  const changes = await sampleFrameChanges(src, join(dir, "samples.rgb"), { signal: ctx.signal });
  const shots = detectShots(changes, duration);
  ctx.throwIfCancelled();
  await ctx.log_event(`Found ${shots.length} shot${shots.length === 1 ? "" : "s"} in ${clock(duration)}`);

  // 2) Narration (Muse Voice Transcribe), only with consent for the voice.
  let transcript: Transcript | undefined;
  let narrationNote: string | undefined;
  if (ctx.payload.transcribe && info.hasAudio) {
    if (!asset.license?.consent) {
      narrationNote = "not transcribed: no consent recorded for the voice in this recording";
      await ctx.log_event("Narration not transcribed: confirm it's your voice (or you have permission) to add it");
    } else {
      await ctx.progress(14, "transcribing narration");
      try {
        let { seg: t } = await findOrCreateTranscript(p, ctx.workspaceId, asset, "captions", ctx.actor);
        if (t.status !== "succeeded") {
          const before = new Set(await usageEventIdsForJob(ctx));
          const r = await runTranscriptionSafely(ctx, t, asset, dir, { progress: (pct, stage, msg) => ctx.progress(14 + (12 * pct) / 100, stage, msg), usageBefore: before, localFile: src });
          t = r.transcript as Transcript;
        }
        transcript = t;
      } catch (raw) {
        const e = toAppError(raw);
        if (e.code === "CANCELLED") throw e;
        narrationNote = `not transcribed: ${e.opts.userMessage ?? e.message}`.slice(0, 200);
        await ctx.log_event(`Narration not transcribed (${e.code}); clips are labelled from the picture only`);
      }
    }
  }

  // 3) Stills (short edge ≈540 px).
  await ctx.progress(28, "sampling frames");
  const plannedFrames = shots.reduce((n, s) => n + keyframeTimes(s).length, 0);
  const work: ShotWork[] = shots.map((s, index) => {
    const times = plannedFrames > MAX_FRAMES ? [Math.round(((s.startSec + s.endSec) / 2) * 1000) / 1000] : keyframeTimes(s);
    return { ...s, index, frames: times.map((atSec, k) => ({ atSec, file: join(dir, `shot-${index}-${k}.jpg`) })), narration: transcript ? narrationFor(transcript.turns, s.startSec, s.endSec) : undefined };
  });
  const allFrames = work.flatMap((s) => s.frames);
  let done = 0;
  await mapLimit(allFrames, 4, async (f) => {
    ctx.throwIfCancelled();
    await extractFrame(src, f.atSec, f.file, { signal: ctx.signal });
    if (++done % 10 === 0) await ctx.progress(28 + (10 * done) / allFrames.length, "sampling frames", `${done}/${allFrames.length}`);
  });

  // 4) Muse Spark labels (App DNA features as the vocabulary; waits briefly for a DNA still being drafted).
  await waitForDna(ctx, appId);
  const dna = await ws.collection("brandProfiles").get(appId);
  const features = dna?.features ?? [];
  const featureIds = new Set(features.map((f) => f.id));
  const batches = batchShots(work);
  const labels = new Map<number, ShotLabel>();
  let model: string | undefined;
  let finished = 0;
  await ctx.progress(40, "labelling shots", `${batches.length} call${batches.length === 1 ? "" : "s"} to Muse Spark`);
  await mapLimit(batches, SPARK_CONCURRENCY, async (batch) => {
    ctx.throwIfCancelled();
    const r = await labelBatch(ctx, batch, app, features);
    model ??= r.model;
    for (const [k, v] of r.labels) labels.set(k, v);
    finished++;
    await ctx.progress(40 + (45 * finished) / batches.length, "labelling shots", `${finished}/${batches.length}`);
  });

  const labelled: LabelledShot[] = work.map((s) => {
    const l = labels.get(s.index);
    if (!l) {
      return { ...s, labelled: false, label: `Unlabelled shot ${clock(s.startSec)}–${clock(s.endSec)}`, action: "other", featureIds: [], quality: UNLABELLED_QUALITY, privacy: { flagged: false, regions: [] }, keyframe: s.frames[0]! };
    }
    return {
      ...s,
      labelled: true,
      label: l.label.slice(0, 300),
      screen: l.screen?.slice(0, 120) || undefined,
      action: l.action,
      featureIds: [...new Set(l.featureIds.filter((id) => featureIds.has(id)))].slice(0, 10),
      quality: Math.round(clamp01(l.quality) * 1000) / 1000,
      privacy: { flagged: l.privacy.flagged || l.privacy.regions.length > 0, notes: l.privacy.notes?.slice(0, 300) || undefined, regions: cleanRegions(l.privacy.regions) },
      keyframe: s.frames[0]!,
      labelledBy: model,
    };
  });
  const segments = mergeAdjacent(labelled);
  ctx.throwIfCancelled();

  // 5) Keyframes + segments (replacing this recording's earlier segments).
  await ctx.progress(88, "saving clips");
  const repo = ws.collection("recordingSegments");
  const assets = ws.collection("mediaAssets");
  const previous = (await repo.list({ where: [["assetId", "==", asset.id]], orderBy: { field: "startSec", dir: "asc" }, limit: 500 })).items;
  const portrait = (info.displayHeight ?? 0) >= (info.displayWidth ?? 0);
  const kfSize = (() => {
    const w = info.displayWidth ?? asset.width;
    const h = info.displayHeight ?? asset.height;
    if (!w || !h) return {};
    const k = Math.min(1, 540 / (portrait ? w : h));
    return { width: Math.max(2, Math.round((w * k) / 2) * 2), height: Math.max(2, Math.round((h * k) / 2) * 2) };
  })();
  const keepIds = new Set<string>();
  const keyframeIds = new Set<string>();
  const refs: { entity: string; id: string }[] = [];
  for (const s of segments) {
    ctx.throwIfCancelled();
    const kfId = derivedId("ast", asset.id, asset.sha256 ?? "", "kf", String(Math.round(s.keyframe.atSec * 1000)));
    if (!(await assets.get(kfId))) {
      const key = workspaceKey(ctx.workspaceId, "media", asset.id, "walkthrough", `${kfId}.jpg`);
      const { bytes } = await p.storage.uploadFile(s.keyframe.file, key, { contentType: "image/jpeg" });
      await assets.createIfAbsent(
        {
          id: kfId,
          ...inheritFrom(asset),
          kind: "image",
          role: "thumbnail",
          origin: "derived",
          storagePath: key,
          mimeType: "image/jpeg",
          bytes,
          ...kfSize,
          status: "ready",
          labels: ["recording_keyframe", `recording:${asset.id}`],
          sourceLabel: "recording_keyframe",
          isProductTruth: false,
          title: `${(asset.title ?? asset.originalFilename ?? "Walkthrough").slice(0, 120)} · still at ${clock(s.keyframe.atSec)}`,
        },
        { actor: ctx.actor },
      );
    }
    keyframeIds.add(kfId);
    const id = derivedId("rsg", asset.id, String(Math.round(s.startSec * 1000)), String(Math.round(s.endSec * 1000)));
    keepIds.add(id);
    const data = {
      appId,
      assetId: asset.id,
      startSec: s.startSec,
      endSec: s.endSec,
      label: s.label,
      screen: s.screen,
      action: s.action,
      featureIds: s.featureIds,
      quality: s.quality,
      privacy: s.privacy,
      narration: transcript ? narrationFor(transcript.turns, s.startSec, s.endSec) : undefined,
      keyframeAssetId: kfId,
      labelledBy: s.labelledBy,
    };
    const { created } = await repo.createIfAbsent({ id, ...data }, { actor: ctx.actor });
    if (!created) await repo.update(id, data, { actor: ctx.actor });
    refs.push({ entity: "recordingSegments", id });
  }
  for (const old of previous) {
    if (keepIds.has(old.id)) continue;
    await repo.delete(old.id);
    if (old.keyframeAssetId && !keyframeIds.has(old.keyframeAssetId)) await retireKeyframe(ctx, old.keyframeAssetId, asset.id);
  }

  // 6) App DNA evidence: add (never remove) the recording to the features it demonstrates.
  let evidenceFeatures = 0;
  if (dna) {
    const shown = new Set(segments.filter((s) => s.quality >= EVIDENCE_QUALITY).flatMap((s) => s.featureIds));
    const fresh = await ws.collection("brandProfiles").get(appId);
    if (fresh && shown.size) {
      let changed = false;
      const next = fresh.features.map((f) => {
        if (!shown.has(f.id) || f.assetIds.includes(asset.id)) return f;
        changed = true;
        evidenceFeatures++;
        return { ...f, assetIds: [...f.assetIds, asset.id] };
      });
      if (changed) await ws.collection("brandProfiles").update(appId, { features: next }, { actor: ctx.actor });
    }
  }

  const flagged = segments.filter((s) => s.privacy.flagged).length;
  const unlabelled = segments.filter((s) => !s.labelled).length;
  await ctx.log_event(`Cut into ${segments.length} clip${segments.length === 1 ? "" : "s"}${flagged ? `, ${flagged} with personal info to blur` : ""}${unlabelled ? `, ${unlabelled} not labelled` : ""}`);
  return {
    refs: [...refs, ...[...keyframeIds].map((id) => ({ entity: "mediaAssets", id })), ...(transcript ? [{ entity: "transcripts", id: transcript.id }] : [])],
    data: {
      shots: shots.length,
      segments: segments.length,
      sparkCalls: batches.length,
      frames: allFrames.length,
      privacyFlagged: flagged,
      unlabelled,
      narration: transcript ? "transcribed" : (narrationNote ?? (info.hasAudio ? "skipped" : "no audio track")),
      evidenceFeatures,
      dnaFeatures: features.length,
    },
  };
}

async function retireKeyframe(ctx: JobContext, id: string, recordingId: string) {
  try {
    const a = await ctx.ws.collection("mediaAssets").get(id);
    if (!a || a.status === "deleted" || !a.labels.includes(`recording:${recordingId}`)) return;
    await ctx.platform.storage.delete(a.storagePath);
    await ctx.ws.collection("mediaAssets").update(id, { status: "deleted" }, { actor: ctx.actor });
  } catch (err) {
    ctx.log.warn({ err, id }, "failed to retire a superseded keyframe");
  }
}
