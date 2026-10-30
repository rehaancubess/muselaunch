import {
  AnalyzeClipRequest,
  BrollHintKind,
  ImageGenerateRequest,
  SegmentCorrectionRequest,
  SegmentRequest,
  StockImportRequest,
  StockSearchQuery,
  TranscribeRequest,
  TtsRequest,
  type BrollStatusResponse,
  type ImageProviderInfo,
  type MediaProvidersResponse,
} from "@muselaunch/contracts";
import { correctSegmentation, DEFAULT_CLIP_PROMPTS, estimateClipAnalysis, importStock, mediaDeps, requestClipAnalysis, requestSegmentation, requestTranscript, transcriptToCaptionCues, waitForTranscript } from "@muselaunch/media";
import { AppError, assertKeyInWorkspace, toAppError } from "@muselaunch/platform";
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

/**
 * What the Studio's Stock and Generate tabs can use on this deployment, without calling any provider:
 * stock providers with their state, and the image provider this user's requests would go to (or why
 * generation is unavailable), with credit prices.
 */
mediaRoutes.get("/media/providers", async (c) => {
  const p = c.get("platform");
  const creditsPerImage = p.credits.estimate("media.image_generate", { count: 1 }).credits;
  let image: MediaProvidersResponse["image"];
  try {
    const choice = chooseImageProvider(p, c.get("country"));
    image = { state: "live", provider: { id: choice.id, label: choice.label, model: choice.model, museImage: choice.museImage }, creditsPerImage };
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code !== "PROVIDER_NOT_CONFIGURED") throw err;
    image = { state: "not_configured", message: err.opts.userMessage ?? err.message, creditsPerImage };
  }
  const res: MediaProvidersResponse = { stock: stockProviderStates(p), stockDownloadCredits: p.credits.estimate("media.stock_download").credits, image };
  return c.json(res);
});

/** Lifestyle b-roll of a storyboard: each stock/generated hint, the asset `storyboard.resolve_media` attached, or why not. */
mediaRoutes.get("/storyboards/:storyboardId/broll", async (c) => {
  const p = c.get("platform");
  const ws = p.db.ws(c.get("workspaceId"));
  const sb = await ws.collection("storyboards").getOrThrow(c.req.param("storyboardId"));
  const hints = [...sb.scenes].sort((a, b) => a.order - b.order).flatMap((scene) => scene.assets.flatMap((h) => (BrollHintKind.safeParse(h.kind).success ? [{ scene, h }] : [])));
  const ids = [...new Set(hints.map((x) => x.h.assetId).filter((x): x is string => Boolean(x)))];
  const assets = new Map((await ws.collection("mediaAssets").getMany(ids)).filter((a) => a.status !== "deleted").map((a) => [a.id, a]));
  const res: BrollStatusResponse = {
    storyboardId: sb.id,
    items: hints.map(({ scene, h }) => {
      const a = h.assetId ? assets.get(h.assetId) : undefined;
      return {
        sceneId: scene.id,
        sceneOrder: scene.order,
        kind: BrollHintKind.parse(h.kind),
        query: h.query,
        assetId: a?.id,
        unresolved: h.unresolved,
        asset: a ? { id: a.id, title: a.title, kind: a.kind, role: a.role, origin: a.origin, sourceLabel: a.sourceLabel, license: a.license } : undefined,
      };
    }),
  };
  return c.json(res);
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

// ---------------------------------------------------------------------------
// Clip analysis (object-aware editing): SAM tracks per prompt + per-object cutouts + transcript
// ---------------------------------------------------------------------------

/** Analyse a real clip. 202 `{job, analysis}`; 200 `{job: null, analysis}` when an identical analysis is reused. */
mediaRoutes.post("/assets/:assetId/analyze-clip", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const input = await body(c, AnalyzeClipRequest);
  const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(c.req.param("assetId"));
  const { analysis, job } = await requestClipAnalysis(p, wid, { asset, prompts: input.prompts, transcribe: input.transcribe, consent: input.consent, actor: actorOf(c), idempotencyKey: idempotencyKey(c) });
  return c.json({ job, analysis }, job ? 202 : 200);
});

/** Credits a clip analysis would reserve (cached prompts/transcripts are free). */
mediaRoutes.post("/assets/:assetId/analyze-clip/estimate", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const input = await body(c, AnalyzeClipRequest);
  const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(c.req.param("assetId"));
  const est = await estimateClipAnalysis(p, wid, asset, input.prompts.length ? input.prompts : DEFAULT_CLIP_PROMPTS, input.transcribe);
  const balance = await p.credits.balance(wid);
  return c.json({ ...est, available: balance.available });
});

mediaRoutes.get("/assets/:assetId/clip-analyses", async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(c.req.param("assetId"));
  const page = await p.db.ws(wid).collection("clipAnalyses").list({ where: [["sourceAssetId", "==", asset.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 });
  return c.json({ items: page.items });
});

/**
 * Analysis + its segmentations + signed URLs (1 h) for the source clip, combined and per-object
 * cutouts/mattes/previews, and each segmentation's tracks JSON.
 */
mediaRoutes.get("/clip-analyses/:id", async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const ws = p.db.ws(wid);
  const analysis = await ws.collection("clipAnalyses").getOrThrow(c.req.param("id"));
  const segmentations = await ws.collection("segmentations").getMany(Object.values(analysis.segmentationIds));
  const assetIds = new Set<string>([analysis.sourceAssetId]);
  for (const s of segmentations) {
    for (const id of [s.maskAssetId, s.cutoutAssetId, s.previewAssetId, s.tracksAssetId]) if (id) assetIds.add(id);
    for (const o of Object.values(s.objectOutputs ?? {})) for (const id of [o.cutoutAssetId, o.matteAssetId]) if (id) assetIds.add(id);
  }
  const found = (await ws.collection("mediaAssets").getMany([...assetIds])).filter((a) => a.status === "ready");
  const signed = await Promise.all(
    found.map(async (a) => {
      assertKeyInWorkspace(wid, a.storagePath);
      const { url } = await p.storage.signedDownloadUrl(a.storagePath, { expiresSec: 3600 });
      return [a.id, { url, kind: a.kind, role: a.role, mimeType: a.mimeType }] as const;
    }),
  );
  const assets = Object.fromEntries(signed);
  const tracksUrls = Object.fromEntries(segmentations.filter((s) => s.tracksAssetId && assets[s.tracksAssetId]).map((s) => [s.id, assets[s.tracksAssetId!]!.url]));
  const transcript = analysis.transcriptId ? await ws.collection("transcripts").get(analysis.transcriptId) : null;
  return c.json({ analysis, segmentations, assets, tracksUrls, transcript });
});
