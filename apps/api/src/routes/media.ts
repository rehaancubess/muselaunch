import { ImageGenerateRequest, SegmentCorrectionRequest, SegmentRequest, StockImportRequest, StockSearchQuery, TranscribeRequest, TtsRequest, type ImageProviderInfo } from "@muselaunch/contracts";
import { correctSegmentation, importStock, mediaDeps, requestSegmentation, requestTranscript, transcriptToCaptionCues, waitForTranscript } from "@muselaunch/media";
import { AppError } from "@muselaunch/platform";
import { assertBuiltinVoice, chooseImageProvider, guardImagePrompt, searchStock, stockProviderStates, TTS_DISCLOSURE } from "@muselaunch/providers";
import { Hono } from "hono";
import { actorOf, body, idempotencyKey, query, requireCap, type AppEnv } from "../context";
import { rateLimit } from "../middleware";

/**
 * Owner: module D (Multimodal media): segmentations, transcripts, image generation, stock, TTS.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 */
export const mediaRoutes = new Hono<AppEnv>();

const VOICE_COMMAND_WAIT_MS = 20_000;

// ---------------------------------------------------------------------------
// SAM 3.1 segmentation
// ---------------------------------------------------------------------------

/** Start (or reuse) a subject selection. Same content hash + prompt → existing result, no new charge. */
mediaRoutes.post("/assets/:assetId/segment", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const input = await body(c, SegmentRequest);
  const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(c.req.param("assetId"));
  const { segmentation, job, reused } = await requestSegmentation(p, wid, { asset, prompt: input.prompt, consent: input.consent, actor: actorOf(c) });
  return c.json({ job, segmentation, reused }, job ? 202 : 200);
});

mediaRoutes.get("/assets/:assetId/segmentations", async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(c.req.param("assetId"));
  const page = await p.db.ws(wid).collection("segmentations").list({ where: [["sourceAssetId", "==", asset.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 });
  return c.json(page);
});

mediaRoutes.get("/segmentations/:id", async (c) => {
  const p = c.get("platform");
  const ws = p.db.ws(c.get("workspaceId"));
  const segmentation = await ws.collection("segmentations").getOrThrow(c.req.param("id"));
  const ids = [segmentation.maskAssetId, segmentation.cutoutAssetId, segmentation.previewAssetId].filter((x): x is string => Boolean(x));
  const assets = Object.fromEntries((await ws.collection("mediaAssets").getMany(ids)).map((a) => [a.id, a]));
  return c.json({
    segmentation,
    assets: {
      mask: segmentation.maskAssetId ? (assets[segmentation.maskAssetId] ?? null) : null,
      cutout: segmentation.cutoutAssetId ? (assets[segmentation.cutoutAssetId] ?? null) : null,
      preview: segmentation.previewAssetId ? (assets[segmentation.previewAssetId] ?? null) : null,
    },
    lowQuality: segmentation.trackingQuality !== undefined && segmentation.trackingQuality < 0.5,
  });
});

/** Correct a selection: re-prompt, box or points (new SAM call), or choose objects (re-render only, free). */
mediaRoutes.post("/segmentations/:id/correct", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const input = await body(c, SegmentCorrectionRequest);
  const seg = await p.db.ws(wid).collection("segmentations").getOrThrow(c.req.param("id"));
  const { segmentation, job } = await correctSegmentation(p, wid, seg, input, actorOf(c));
  return c.json({ job, segmentation }, 202);
});

// ---------------------------------------------------------------------------
// Muse Voice Transcribe
// ---------------------------------------------------------------------------

/**
 * Transcribe an uploaded recording. `voice_command` waits briefly so the spoken instruction's text
 * comes back in this response (200); otherwise 202 `{ job, transcript }`.
 */
mediaRoutes.post("/assets/:assetId/transcribe", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const input = await body(c, TranscribeRequest);
  const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(c.req.param("assetId"));
  const res = await requestTranscript(p, wid, { asset, purpose: input.purpose, languageBias: input.languageBias, keywords: input.keywords, consent: input.consent, actor: actorOf(c) });
  if (res.job && input.purpose === "voice_command") {
    const done = await waitForTranscript(p, wid, res.transcript.id, VOICE_COMMAND_WAIT_MS);
    if (done) return c.json({ job: (await p.jobs.get(wid, res.job.id)) ?? res.job, transcript: done, reused: false }, 200);
  }
  return c.json({ job: res.job, transcript: res.transcript, reused: res.reused }, res.job ? 202 : 200);
});

mediaRoutes.get("/transcripts/:id", async (c) => {
  const p = c.get("platform");
  const transcript = await p.db.ws(c.get("workspaceId")).collection("transcripts").getOrThrow(c.req.param("id"));
  return c.json({ transcript, cues: transcript.status === "succeeded" ? transcriptToCaptionCues(transcript) : [], timing: "turn" as const });
});

// ---------------------------------------------------------------------------
// Image generation (Muse Image only behind the geo gate; otherwise OpenAI, always named)
// ---------------------------------------------------------------------------

mediaRoutes.post("/images/generate", requireCap("content.write"), rateLimit({ perMinute: 20, key: "images" }), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const input = await body(c, ImageGenerateRequest);
  const guard = guardImagePrompt(input.prompt);
  if (!guard.ok) throw new AppError("BAD_REQUEST", `Image prompt refused: ${guard.reason}`, { userMessage: guard.userMessage });
  const country = c.get("country");
  const choice = chooseImageProvider(p, country);
  const ws = p.db.ws(wid);
  if (input.appId) await ws.collection("apps").getOrThrow(input.appId);
  if (input.parentAssetId) {
    const parent = await ws.collection("mediaAssets").getOrThrow(input.parentAssetId);
    if (parent.isProductTruth) throw new AppError("BAD_REQUEST", "Refusing to AI-edit a real product screenshot", { userMessage: "Real screenshots can't be AI-edited. Revise a generated image instead." });
  }
  const job = await p.jobs.create(wid, "media.image_generate", { ...input, endUserCountry: country }, {
    actor: actorOf(c),
    appId: input.appId,
    idempotencyKey: idempotencyKey(c),
    credits: { operation: "media.image_generate", params: { count: input.count } },
  });
  const provider: ImageProviderInfo = { id: choice.id, label: choice.label, model: choice.model, museImage: choice.museImage };
  return c.json({ job, provider }, 202);
});

// ---------------------------------------------------------------------------
// Stock media
// ---------------------------------------------------------------------------

mediaRoutes.get("/stock/search", rateLimit({ perMinute: 60, key: "stock" }), async (c) => {
  const p = c.get("platform");
  const q = query(c, StockSearchQuery);
  const providers = stockProviderStates(p);
  const r = await searchStock(p, { workspaceId: c.get("workspaceId"), task: "stock.search", actor: actorOf(c) }, q, { fetch: mediaDeps(p).fetch });
  return c.json({ items: r.items, provider: r.provider, providers, page: q.page, hasMore: r.hasMore });
});

mediaRoutes.post("/stock/import", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const input = await body(c, StockImportRequest);
  const { asset, job, created } = await importStock(p, c.get("workspaceId"), input, actorOf(c));
  return c.json({ asset, job }, created ? 201 : 200);
});

// ---------------------------------------------------------------------------
// Optional TTS (external, labelled, built-in voices only)
// ---------------------------------------------------------------------------

mediaRoutes.post("/tts", requireCap("content.write"), rateLimit({ perMinute: 20, key: "tts" }), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const input = await body(c, TtsRequest);
  const voice = assertBuiltinVoice(input.voice);
  if (!p.cfg.OPENAI_API_KEY) throw new AppError("PROVIDER_NOT_CONFIGURED", "OPENAI_API_KEY is not set", { userMessage: "Voiceover (external TTS) isn't connected on this deployment." });
  if (input.appId) await p.db.ws(wid).collection("apps").getOrThrow(input.appId);
  const job = await p.jobs.create(wid, "media.tts", { ...input, voice }, { actor: actorOf(c), appId: input.appId, idempotencyKey: idempotencyKey(c), credits: { operation: "media.tts", params: { text: input.text } } });
  return c.json({ job, provider: { id: "openai", label: "OpenAI TTS (external)", model: p.cfg.OPENAI_TTS_MODEL, voice }, sourceLabel: "external_tts", disclosure: TTS_DISCLOSURE }, 202);
});
