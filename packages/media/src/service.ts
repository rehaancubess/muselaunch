import type { Job, MediaAsset, Segmentation, SegmentCorrectionRequest, StockImportRequest, Transcript } from "@muselaunch/contracts";
import { AppError, workspaceKey, type Platform } from "@muselaunch/platform";
import { getStockDetail, meterExternal, normaliseConceptPrompt, STOCK_ADAPTERS } from "@muselaunch/providers";
import { encodeCorrection, SAM_MAX_FRAMES } from "./segment";
import { MAX_TRANSCRIBE_SECONDS, modeForPurpose, storeFounderEvidence } from "./transcribe";
import { derivedId, EXT_BY_MIME, mediaDeps, sha256 } from "./util";

/**
 * Request-side logic for the media API (validation, consent, content-hash caching, job creation).
 * Kept here so the route file stays thin and other modules (agents) can reuse it.
 */

export interface Actor {
  uid: string;
}

/** Concept prompts that target people (consent needed to process a recording of a person). */
export const PERSON_PROMPT = /\b(person|people|man|men|woman|women|boy|girl|kid|child|human|face|head|founder|speaker|presenter|me|myself|someone|guy|lady|body|hair|hand|hands)\b/i;
const PERSON_ROLES = new Set<MediaAsset["role"]>(["founder_clip", "voiceover"]);

/** Ensure consent for processing a person's likeness/voice: already on the asset, or given now (recorded). */
export async function ensureConsent(p: Platform, wid: string, asset: MediaAsset, consent: { scope: string } | undefined, actor: string, why: string): Promise<MediaAsset> {
  if (asset.license?.consent) return asset;
  if (!consent) {
    throw new AppError("BAD_REQUEST", `Consent required: ${why}`, {
      userMessage: "Confirm you have permission from the person in this recording to use their likeness and voice.",
      details: { consentRequired: true },
    });
  }
  return p.db
    .ws(wid)
    .collection("mediaAssets")
    .update(asset.id, { license: { ...(asset.license ?? { type: "user_uploaded" }), consent: { by: actor, at: new Date().toISOString(), scope: consent.scope } } }, { actor });
}

function assertReady(asset: MediaAsset) {
  if (asset.status === "deleted") throw new AppError("NOT_FOUND", "Asset not found");
  if (asset.status !== "ready") throw new AppError("CONFLICT", `Asset is ${asset.status}`, { userMessage: "This file is still processing. Try again in a moment." });
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

export async function requestSegmentation(
  p: Platform,
  wid: string,
  input: { asset: MediaAsset; prompt: string; consent?: { scope: string }; actor: string },
): Promise<{ segmentation: Segmentation; job: Job | null; reused: boolean }> {
  let asset = input.asset;
  assertReady(asset);
  if (asset.kind !== "image" && asset.kind !== "video") throw new AppError("BAD_REQUEST", "Only images and videos can be segmented");
  if (asset.mimeType === "image/svg+xml") throw new AppError("BAD_REQUEST", "SVG images can't be segmented", { userMessage: "Use a PNG or JPEG for subject selection." });
  if (asset.kind === "video" && (asset.durationSec ?? 0) * (asset.fps ?? 30) > SAM_MAX_FRAMES) {
    throw new AppError("BAD_REQUEST", "Video too long for SAM", { userMessage: "That clip is too long to track (max ~10 minutes). Trim it first." });
  }
  const prompt = normaliseConceptPrompt(input.prompt);
  if (!prompt) throw new AppError("BAD_REQUEST", "Empty prompt", { userMessage: "Describe what to select, e.g. “person” or “phone”." });
  if (PERSON_ROLES.has(asset.role) || PERSON_PROMPT.test(prompt)) asset = await ensureConsent(p, wid, asset, input.consent, input.actor, "segmenting a person");

  const repo = p.db.ws(wid).collection("segmentations");
  const model = p.cfg.META_MODEL_SAM;
  const mediaType = asset.kind as "image" | "video";
  const fresh = (s: Segmentation) => s.prompt === prompt && s.model === model && !s.corrections.length && !s.selectedObjectIds.length;

  // 1) Same asset + prompt: return the existing result (or the in-flight job).
  const mine = (await repo.list({ where: [["sourceAssetId", "==", asset.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 })).items.filter((s) => fresh(s) && s.status !== "failed");
  const hit = mine.find((s) => s.status === "succeeded") ?? mine[0];
  if (hit) {
    const job = hit.status === "succeeded" ? null : await segmentJob(p, wid, hit, asset, input.actor, `seg:${hit.id}:0`, true);
    return { segmentation: hit, job, reused: hit.status === "succeeded" };
  }

  // 2) Identical content (same sha256) + prompt in this workspace: copy the result, no new SAM call or charge.
  if (asset.sha256) {
    const same = (await repo.list({ where: [["sourceSha256", "==", asset.sha256], ["prompt", "==", prompt]], limit: 20 })).items.find((s) => s.status === "succeeded" && fresh(s) && s.mediaType === mediaType);
    if (same) {
      const copy = await repo.create(
        {
          appId: asset.appId,
          sourceAssetId: asset.id,
          sourceSha256: asset.sha256,
          prompt,
          model,
          status: "succeeded",
          mediaType,
          objects: same.objects,
          maskAssetId: same.maskAssetId,
          cutoutAssetId: same.cutoutAssetId,
          previewAssetId: same.previewAssetId,
          outputAssetId: same.outputAssetId,
          frameCount: same.frameCount,
          fps: same.fps,
          trackingQuality: same.trackingQuality,
          corrections: [],
          selectedObjectIds: [],
          usageEventIds: [],
          reusedFromSegmentationId: same.id,
        },
        { actor: input.actor },
      );
      return { segmentation: copy, job: null, reused: true };
    }
  }

  // 3) New segmentation.
  const seg = await repo.create(
    { appId: asset.appId, sourceAssetId: asset.id, sourceSha256: asset.sha256, prompt, model, status: "queued", mediaType, objects: [], corrections: [], selectedObjectIds: [], usageEventIds: [] },
    { actor: input.actor },
  );
  const job = await segmentJob(p, wid, seg, asset, input.actor, `seg:${seg.id}:0`, true);
  return { segmentation: seg, job, reused: false };
}

function segmentJob(p: Platform, wid: string, seg: Segmentation, asset: MediaAsset, actor: string, key: string, charge: boolean) {
  return p.jobs.create(wid, "media.segment", { segmentationId: seg.id }, {
    actor,
    appId: asset.appId,
    idempotencyKey: key,
    credits: charge ? { operation: "media.segment", params: { mediaType: seg.mediaType, durationSec: asset.durationSec ?? 0 } } : undefined,
  });
}

export async function correctSegmentation(
  p: Platform,
  wid: string,
  seg: Segmentation,
  body: SegmentCorrectionRequest,
  actor: string,
): Promise<{ segmentation: Segmentation; job: Job }> {
  if (seg.status === "queued" || seg.status === "running") throw new AppError("CONFLICT", "Segmentation is still running", { userMessage: "Wait for the current selection to finish." });
  if (seg.corrections.length >= 20 && body.kind !== "objects") throw new AppError("BAD_REQUEST", "Too many corrections", { userMessage: "Start a new selection instead." });
  const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(seg.sourceAssetId);
  assertReady(asset);
  const repo = p.db.ws(wid).collection("segmentations");
  const at = new Date().toISOString();

  if (body.kind === "objects") {
    const known = new Set(seg.objects.map((o) => o.objectId));
    const unknown = body.objectIds.filter((id) => !known.has(id));
    if (unknown.length) throw new AppError("BAD_REQUEST", `Unknown object ids: ${unknown.join(", ")}`);
    if (!seg.outputAssetId) throw new AppError("CONFLICT", "No stored SAM output to re-select from");
    const updated = await repo.update(seg.id, { selectedObjectIds: [...new Set(body.objectIds)], status: "queued", error: undefined }, { actor });
    // Re-selection re-renders from stored SAM output: no provider call, no credits.
    const job = await segmentJob(p, wid, updated, asset, actor, `segsel:${seg.id}:${updated.updatedAt}`, false);
    return { segmentation: updated, job };
  }

  let correction: Segmentation["corrections"][number];
  let prompt = seg.prompt;
  if (body.kind === "prompt") {
    prompt = normaliseConceptPrompt(body.prompt);
    if (!prompt) throw new AppError("BAD_REQUEST", "Empty prompt");
    if (PERSON_PROMPT.test(prompt) && !asset.license?.consent) throw new AppError("BAD_REQUEST", "Consent required", { userMessage: "Confirm you have permission from the person in this recording first.", details: { consentRequired: true } });
    correction = { at, kind: "prompt", value: prompt.slice(0, 200) };
  } else if (body.kind === "box") {
    if (body.box.w <= 0 || body.box.h <= 0) throw new AppError("BAD_REQUEST", "Box must have a size");
    correction = { at, kind: "box", value: encodeCorrection({ kind: "box", frame: seg.mediaType === "image" ? 0 : body.frame, box: body.box }) };
  } else {
    correction = { at, kind: "point", value: encodeCorrection({ kind: "point", frame: seg.mediaType === "image" ? 0 : body.frame, points: body.points }) };
  }
  if (seg.mediaType === "video" && body.kind !== "prompt" && seg.frameCount && body.frame >= seg.frameCount) throw new AppError("BAD_REQUEST", "Frame out of range");
  const updated = await repo.update(
    seg.id,
    { prompt, corrections: [...seg.corrections, correction], selectedObjectIds: [], outputAssetId: undefined, status: "queued", error: undefined, reusedFromSegmentationId: undefined },
    { actor },
  );
  const job = await segmentJob(p, wid, updated, asset, actor, `segcorr:${seg.id}:${updated.corrections.length}`, true);
  return { segmentation: updated, job };
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

export async function requestTranscript(
  p: Platform,
  wid: string,
  input: { asset: MediaAsset; purpose: Transcript["purpose"]; languageBias?: string[]; keywords?: string[]; consent?: { scope: string }; actor: string },
): Promise<{ transcript: Transcript; job: Job | null; reused: boolean }> {
  let asset = input.asset;
  assertReady(asset);
  if (asset.kind !== "audio" && asset.kind !== "video") throw new AppError("BAD_REQUEST", "Only audio or video can be transcribed");
  if (asset.hasAudio === false) throw new AppError("BAD_REQUEST", "No audio track", { userMessage: "That video has no sound to transcribe." });
  if ((asset.durationSec ?? 0) > MAX_TRANSCRIBE_SECONDS) throw new AppError("BAD_REQUEST", "Audio longer than 60 minutes", { userMessage: "Recordings up to 60 minutes can be transcribed." });
  // Voice commands are the signed-in user's own instruction (never used in content); everything else is a recording of a person.
  if (input.purpose !== "voice_command") asset = await ensureConsent(p, wid, asset, input.consent, input.actor, "transcribing a recording of a person");
  const repo = p.db.ws(wid).collection("transcripts");
  const model = p.cfg.META_MODEL_VOICE;
  const mode = modeForPurpose(input.purpose);
  const covers = (t: Transcript) => t.status === "succeeded" && t.model === model && (t.mode === mode || t.mode === "DIARIZATION");

  const mine = (await repo.list({ where: [["sourceAssetId", "==", asset.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 })).items;
  const exact = mine.find((t) => t.purpose === input.purpose && t.mode === mode && t.status !== "failed");
  if (exact) {
    const job = exact.status === "succeeded" ? null : await transcribeJob(p, wid, exact, asset, input);
    return { transcript: exact, job, reused: exact.status === "succeeded" };
  }
  const prior = mine.find(covers) ?? (asset.sha256 ? (await repo.list({ where: [["sourceSha256", "==", asset.sha256]], limit: 20 })).items.find(covers) : undefined);
  if (prior) {
    const copy = await repo.create(
      { appId: asset.appId ?? prior.appId, sourceAssetId: asset.id, sourceSha256: asset.sha256, model, purpose: input.purpose, status: "succeeded", language: prior.language, text: prior.text, turns: prior.turns, durationSec: prior.durationSec, mode: prior.mode, usageEventIds: [], reusedFromTranscriptId: prior.id },
      { actor: input.actor },
    );
    if (copy.purpose === "founder_brief" && copy.appId && copy.text) await storeFounderEvidence(p.db.ws(wid), input.actor, copy, asset);
    return { transcript: copy, job: null, reused: true };
  }
  const t = await repo.create(
    { appId: asset.appId, sourceAssetId: asset.id, sourceSha256: asset.sha256, model, purpose: input.purpose, status: "queued", mode, text: "", turns: [], usageEventIds: [] },
    { actor: input.actor },
  );
  const job = await transcribeJob(p, wid, t, asset, input);
  return { transcript: t, job, reused: false };
}

function transcribeJob(p: Platform, wid: string, t: Transcript, asset: MediaAsset, input: { languageBias?: string[]; keywords?: string[]; actor: string }) {
  return p.jobs.create(
    wid,
    "media.transcribe",
    { transcriptId: t.id, languageBias: input.languageBias, keywords: input.keywords },
    { actor: input.actor, appId: asset.appId, idempotencyKey: `trn:${t.id}`, credits: { operation: "media.transcribe", params: { durationSec: asset.durationSec ?? 60 } } },
  );
}

/** Wait (bounded) for a transcript to finish: voice commands return text in the same request. */
export function waitForTranscript(p: Platform, wid: string, transcriptId: string, timeoutMs: number): Promise<Transcript | null> {
  const repo = p.db.ws(wid).collection("transcripts");
  return new Promise((resolve) => {
    let done = false;
    let unwatch: (() => void) | undefined;
    const finish = (t: Transcript | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unwatch?.();
      resolve(t);
    };
    const timer = setTimeout(() => void repo.get(transcriptId).then((t) => finish(t && (t.status === "succeeded" || t.status === "failed") ? t : null)), timeoutMs);
    unwatch = repo.watch(transcriptId, (t) => {
      if (t && (t.status === "succeeded" || t.status === "failed")) finish(t);
    });
    void repo.get(transcriptId).then((t) => {
      if (t && (t.status === "succeeded" || t.status === "failed")) finish(t);
    });
  });
}

// ---------------------------------------------------------------------------
// Stock import
// ---------------------------------------------------------------------------

const STOCK_MAX_BYTES = { image: 25 * 1024 * 1024, video: 250 * 1024 * 1024 } as const;

/**
 * Import a stock item: details (licence, attribution, file URL) are re-fetched from the provider
 * server-side, the file is downloaded with `safeFetch` into workspace storage, and a MediaAsset is
 * created with an AssetLicense. Then `media.probe` normalises it. Re-importing the same item returns
 * the existing asset.
 */
export async function importStock(p: Platform, wid: string, req: StockImportRequest, actor: string): Promise<{ asset: MediaAsset; job: Job | null; created: boolean }> {
  const deps = mediaDeps(p);
  const repo = p.db.ws(wid).collection("mediaAssets");
  if (req.appId) await p.db.ws(wid).collection("apps").getOrThrow(req.appId);
  const id = derivedId("ast", "stock", req.provider, req.kind, req.id, req.appId ?? "", req.campaignId ?? "");
  const existing = await repo.get(id);
  if (existing && existing.status !== "deleted" && existing.status !== "failed") return { asset: existing, job: null, created: false };

  const detail = await getStockDetail(p, req.provider, req.id, req.kind, { fetch: deps.fetch });
  const { value: file } = await meterExternal(p, { workspaceId: wid, task: "stock.import", appId: req.appId, actor }, { provider: "stock", model: req.provider, operation: "http", estimatedUsd: 0 }, async () => {
    const res = await deps.download(detail.downloadUrl, { maxBytes: STOCK_MAX_BYTES[req.kind], timeoutMs: 90_000, accept: [`${req.kind}/`, "application/octet-stream", "binary/octet-stream"] });
    return { value: res, usage: { costUsdEstimate: 0 }, trace: { request: { provider: req.provider, id: req.id, kind: req.kind, url: detail.downloadUrl }, response: { bytes: res.body.length, contentType: res.contentType } } };
  });
  if (!file.body.length) throw new AppError("PROVIDER_ERROR", "Stock download was empty");
  const ct = file.contentType.split(";")[0]!.trim().toLowerCase();
  const mimeType = ct.startsWith(`${req.kind}/`) ? ct : detail.mimeType;
  const key = workspaceKey(wid, "stock", id, `${req.provider}-${req.id.replace(/[^A-Za-z0-9_-]/g, "")}.${EXT_BY_MIME[mimeType] ?? (req.kind === "video" ? "mp4" : "jpg")}`);
  const { bytes } = await p.storage.put(key, file.body, { contentType: mimeType });
  const item = detail.item;
  const fields = {
    appId: req.appId,
    campaignId: req.campaignId,
    kind: req.kind,
    role: req.kind === "video" ? ("stock_video" as const) : ("stock_image" as const),
    origin: "stock" as const,
    storagePath: key,
    mimeType,
    bytes,
    sha256: sha256(file.body),
    status: "uploaded" as const,
    title: (item.title ?? `${STOCK_ADAPTERS[req.provider].label} ${req.kind}`).slice(0, 200),
    labels: [`stock:${req.provider}`],
    sourceLabel: "stock",
    isProductTruth: false,
    license: {
      type: item.license.type,
      provider: STOCK_ADAPTERS[req.provider].label,
      attribution: item.license.attribution,
      sourceUrl: item.pageUrl,
      termsUrl: item.license.url,
      restrictions: `${item.license.name}${item.license.attributionRequired ? " — attribution required" : ""}`.slice(0, 1000),
    },
  };
  const asset = existing ? await repo.update(id, fields, { actor }) : await repo.create({ id, ...fields }, { actor });
  const job = await p.jobs.create(wid, "media.probe", { assetId: asset.id }, { actor, appId: asset.appId, idempotencyKey: `probe:${asset.id}:${asset.updatedAt}` });
  return { asset, job, created: true };
}
