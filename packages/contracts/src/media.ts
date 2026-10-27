import { z } from "zod";
import { BaseEntity, HttpUrl, Id, IsoDateTime, Percent01 } from "./common";

export const MediaKind = z.enum(["image", "video", "audio", "document", "mask", "captions", "archive", "json"]);
export type MediaKind = z.infer<typeof MediaKind>;

export const MediaRole = z.enum([
  "screenshot",
  "app_recording",
  "founder_clip",
  "logo",
  "icon",
  "product_photo",
  "generated_image",
  "stock_video",
  "stock_image",
  "music",
  "voiceover",
  "tts",
  "render",
  "preview",
  "thumbnail",
  "mask",
  "srt",
  "package",
  "document",
  "other",
]);
export type MediaRole = z.infer<typeof MediaRole>;

/** Where the bytes came from: drives labelling in the UI and claims eligibility. */
export const MediaOrigin = z.enum(["upload", "store_import", "website_import", "generated", "stock", "render", "derived", "recorded"]);
export type MediaOrigin = z.infer<typeof MediaOrigin>;

export const AssetLicense = z.object({
  type: z.enum(["owned", "user_uploaded", "stock_license", "creative_commons", "generated_terms", "public_listing", "unknown"]),
  provider: z.string().max(80).optional(),
  attribution: z.string().max(500).optional(),
  sourceUrl: HttpUrl.optional(),
  termsUrl: HttpUrl.optional(),
  restrictions: z.string().max(1000).optional(),
  /** Explicit consent for voice/likeness (founder recordings). */
  consent: z.object({ by: z.string(), at: IsoDateTime, scope: z.string().max(300) }).optional(),
});
export type AssetLicense = z.infer<typeof AssetLicense>;

export const MediaAsset = BaseEntity.extend({
  appId: Id.optional(),
  campaignId: Id.optional(),
  kind: MediaKind,
  role: MediaRole,
  origin: MediaOrigin,
  /** Object key inside the workspace prefix: `workspaces/{wid}/...`. Never a public URL. */
  storagePath: z.string().min(1).max(1024),
  mimeType: z.string().max(120),
  bytes: z.number().int().nonnegative().default(0),
  sha256: z.string().max(128).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  fps: z.number().positive().optional(),
  hasAudio: z.boolean().optional(),
  status: z.enum(["pending_upload", "uploaded", "processing", "ready", "failed", "deleted"]),
  originalFilename: z.string().max(260).optional(),
  title: z.string().max(200).optional(),
  labels: z.array(z.string().max(60)).max(30).default([]),
  /** True only for real screenshots/recordings of the product (never generated media). */
  isProductTruth: z.boolean().default(false),
  /**
   * Provenance label the UI must show next to the asset, e.g. `external_tts` (AI voice from an
   * external TTS provider), `ai_generated_image`, `stock`, `sam_matte`, `sam_cutout`, `sam_preview`.
   */
  sourceLabel: z.string().max(60).optional(),
  license: AssetLicense.optional(),
  generation: z
    .object({
      provider: z.string().max(60),
      model: z.string().max(80),
      prompt: z.string().max(4000),
      revision: z.number().int().min(1).default(1),
      parentAssetId: Id.optional(),
      usageEventId: Id.optional(),
    })
    .optional(),
  derivedFromAssetId: Id.optional(),
  /** Thumbnail/poster for video and documents. */
  posterAssetId: Id.optional(),
  /** Render outputs: which composition version produced this asset. */
  render: z.object({ compositionId: Id, version: z.number().int(), quality: z.enum(["preview", "final"]) }).optional(),
  error: z.string().max(1000).optional(),
});
export type MediaAsset = z.infer<typeof MediaAsset>;

/** SAM 3.1 segmentation/tracking result. Cache key = sourceAssetId + prompt + model. */
export const Segmentation = BaseEntity.extend({
  appId: Id.optional(),
  sourceAssetId: Id,
  sourceSha256: z.string().max(128).optional(),
  prompt: z.string().min(1).max(200),
  model: z.string().max(40).default("sam-3.1"),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  mediaType: z.enum(["image", "video"]),
  objects: z
    .array(
      z.object({
        objectId: z.string().max(40),
        label: z.string().max(80),
        score: Percent01.optional(),
        /** First-frame bbox, normalised. */
        bbox: z.object({ x: Percent01, y: Percent01, w: Percent01, h: Percent01 }).optional(),
        framesTracked: z.number().int().nonnegative().optional(),
      }),
    )
    .default([]),
  /**
   * Mask output as stored assets: `alphaVideo` is a grayscale matte video aligned frame-for-frame
   * with the source (or a PNG for images); `previewAsset` is an overlay preview for the selection UI.
   */
  maskAssetId: Id.optional(),
  /**
   * Subject-only media with alpha, frame-aligned with the source: VP9-alpha WebM for video,
   * PNG for images. The compositions compiler swaps a masked layer's source to this asset.
   */
  cutoutAssetId: Id.optional(),
  previewAssetId: Id.optional(),
  frameCount: z.number().int().nonnegative().optional(),
  fps: z.number().positive().optional(),
  /** 0..1 heuristic: coverage continuity across frames; < 0.5 falls back to unmasked footage. */
  trackingQuality: Percent01.optional(),
  /** User corrections (re-prompt points/boxes) applied. */
  corrections: z.array(z.object({ at: IsoDateTime, kind: z.enum(["prompt", "box", "point"]), value: z.string().max(200) })).default([]),
  /** Objects included in the matte/cutout (empty = all detected objects). */
  selectedObjectIds: z.array(z.string().max(40)).max(16).default([]),
  /** Raw SAM output (special-token text) kept so object re-selection never re-calls SAM. */
  outputAssetId: Id.optional(),
  /** Set when the result came from an earlier identical request (same content hash + prompt): no new SAM call. */
  reusedFromSegmentationId: Id.optional(),
  /** JSON asset holding `ObjectTrack[]` (per-frame bbox/centroid/area per object) for anchoring + effects. */
  tracksAssetId: Id.optional(),
  /** Per-object outputs so effects can target one object (e.g. the phone) while another (the person) is cut out. */
  objectOutputs: z.record(z.string(), z.object({ cutoutAssetId: Id.optional(), matteAssetId: Id.optional() })).default({}),
  usageEventIds: z.array(Id).default([]),
  error: z.string().max(1000).optional(),
});
export type Segmentation = z.infer<typeof Segmentation>;

export const TranscriptTurn = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  speaker: z.string().max(40).optional(),
  text: z.string().max(5000),
});

/** Muse Voice Transcribe output: turn-level timing (not word-level). */
export const Transcript = BaseEntity.extend({
  appId: Id.optional(),
  sourceAssetId: Id,
  sourceSha256: z.string().max(128).optional(),
  model: z.string().max(60).default("muse-voice-transcribe-1.0"),
  purpose: z.enum(["founder_brief", "voice_command", "captions", "upload"]),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  language: z.string().max(16).optional(),
  text: z.string().max(100_000).default(""),
  turns: z.array(TranscriptTurn).max(5000).default([]),
  durationSec: z.number().nonnegative().optional(),
  /** Muse Voice Transcribe mode used: DIARIZATION gives speaker-attributed turns; PUSH_TO_TALK gives text only. */
  mode: z.enum(["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"]).optional(),
  /** Set when copied from an earlier transcript of identical audio (same content hash): no new provider call. */
  reusedFromTranscriptId: Id.optional(),
  usageEventIds: z.array(Id).default([]),
  error: z.string().max(1000).optional(),
});
export type Transcript = z.infer<typeof Transcript>;

// ---------------------------------------------------------------------------
// Media API requests/responses (module D routes: apps/api/src/routes/media.ts)
// ---------------------------------------------------------------------------

/** Explicit consent for processing a recording of a person (stored on the asset licence). */
export const ConsentInput = z.object({ scope: z.string().min(3).max(300) });

export const SegmentRequest = z.object({
  /** SAM concept prompt: a short noun phrase naming one concrete thing ("person", "phone"). */
  prompt: z.string().trim().min(1).max(200),
  consent: ConsentInput.optional(),
});
export type SegmentRequest = z.infer<typeof SegmentRequest>;

const NormPoint = z.object({ x: Percent01, y: Percent01, label: z.enum(["positive", "negative"]).default("positive") });
export const SegmentCorrectionRequest = z.discriminatedUnion("kind", [
  /** Re-run with a different concept prompt. */
  z.object({ kind: z.literal("prompt"), prompt: z.string().trim().min(1).max(200) }),
  /** Refine with a box around the subject (normalised 0..1 of the displayed frame) on a given frame. */
  z.object({ kind: z.literal("box"), frame: z.number().int().min(0).default(0), box: z.object({ x: Percent01, y: Percent01, w: Percent01, h: Percent01 }) }),
  /** Refine with positive/negative clicks (normalised) on a given frame. */
  z.object({ kind: z.literal("point"), frame: z.number().int().min(0).default(0), points: z.array(NormPoint).min(1).max(8) }),
  /** Choose which detected objects the cutout includes (no new SAM call). */
  z.object({ kind: z.literal("objects"), objectIds: z.array(z.string().max(40)).max(16) }),
]);
export type SegmentCorrectionRequest = z.infer<typeof SegmentCorrectionRequest>;

export const TranscribeRequest = z.object({
  purpose: z.enum(["founder_brief", "voice_command", "captions", "upload"]).default("upload"),
  /** Language names, e.g. ["English", "Hindi"]; steers recognition, does not force it. */
  languageBias: z.array(z.string().min(2).max(40)).max(5).optional(),
  /** Terms to bias recognition toward (app name, features). */
  keywords: z.array(z.string().min(1).max(60)).max(50).optional(),
  consent: ConsentInput.optional(),
});
export type TranscribeRequest = z.infer<typeof TranscribeRequest>;

export const ImageGenerateRequest = z.object({
  appId: Id.optional(),
  campaignId: Id.optional(),
  prompt: z.string().trim().min(3).max(4000),
  count: z.number().int().min(1).max(4).default(1),
  size: z.enum(["1024x1024", "1024x1536", "1536x1024"]).default("1024x1536"),
  /** Revise an earlier generated image (keeps revision history). */
  parentAssetId: Id.optional(),
});
export type ImageGenerateRequest = z.infer<typeof ImageGenerateRequest>;

/** Which image provider a request goes to; always named in API responses and stored on assets. */
export const ImageProviderInfo = z.object({
  id: z.enum(["openai", "muse"]),
  label: z.string(),
  model: z.string(),
  /** Why Muse Image was or was not used (geographic policy / deployment setting). */
  museImage: z.object({ eligible: z.boolean(), reason: z.string() }),
});
export type ImageProviderInfo = z.infer<typeof ImageProviderInfo>;

export const StockProviderId = z.enum(["openverse", "pexels", "pixabay"]);
export type StockProviderId = z.infer<typeof StockProviderId>;

export const StockSearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  kind: z.enum(["image", "video"]).default("image"),
  provider: StockProviderId.optional(),
  orientation: z.enum(["portrait", "landscape", "square"]).optional(),
  page: z.coerce.number().int().min(1).max(50).default(1),
  perPage: z.coerce.number().int().min(1).max(30).default(20),
});
export type StockSearchQuery = z.infer<typeof StockSearchQuery>;

export const StockItem = z.object({
  provider: StockProviderId,
  /** Provider's id for the item (used to re-fetch details server-side on import). */
  id: z.string().max(120),
  kind: z.enum(["image", "video"]),
  title: z.string().max(300).optional(),
  previewUrl: HttpUrl,
  pageUrl: HttpUrl,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  creator: z.string().max(200).optional(),
  creatorUrl: HttpUrl.optional(),
  license: z.object({
    type: z.enum(["creative_commons", "stock_license"]),
    /** e.g. "CC BY 4.0", "CC0 1.0", "Pexels License". */
    name: z.string().max(80),
    url: HttpUrl.optional(),
    /** Ready-to-use attribution text (always shown; required for CC BY). */
    attribution: z.string().max(500),
    attributionRequired: z.boolean(),
  }),
});
export type StockItem = z.infer<typeof StockItem>;

export const StockImportRequest = z.object({
  provider: StockProviderId,
  id: z.string().min(1).max(120),
  kind: z.enum(["image", "video"]),
  appId: Id.optional(),
  campaignId: Id.optional(),
});
export type StockImportRequest = z.infer<typeof StockImportRequest>;

export const TtsRequest = z.object({
  appId: Id.optional(),
  text: z.string().trim().min(1).max(4000),
  /** One of the provider's built-in voices. Custom/cloned voices are never accepted. */
  voice: z.string().max(60).optional(),
  compositionId: Id.optional(),
});
export type TtsRequest = z.infer<typeof TtsRequest>;

/** One frame of an object track (normalised 0..1 frame coordinates). */
export const ObjectTrackFrame = z.object({
  /** Seconds from the start of the source clip. */
  t: z.number().min(0),
  visible: z.boolean(),
  bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  centroid: z.object({ x: z.number(), y: z.number() }).optional(),
  /** Mask area as a fraction of the frame. */
  area: z.number().min(0).max(1).optional(),
  score: Percent01.optional(),
});

/** Stored as JSON (asset `Segmentation.tracksAssetId`): `{ fps, frameCount, tracks: ObjectTrack[] }`. */
export const ObjectTrack = z.object({
  objectId: z.string().max(40),
  label: z.string().max(80),
  frames: z.array(ObjectTrackFrame),
});
export type ObjectTrack = z.infer<typeof ObjectTrack>;

export const TracksFile = z.object({ fps: z.number().positive(), frameCount: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive(), tracks: z.array(ObjectTrack) });
export type TracksFile = z.infer<typeof TracksFile>;

/**
 * Object-aware understanding of one real clip (e.g. founder holding a phone): SAM segmentations per
 * prompt (person, phone, hand...), their tracks, and the Voice transcript. Spark's effects director
 * reads this to decide which object-aware effects support the message.
 */
export const ClipAnalysis = BaseEntity.extend({
  appId: Id.optional(),
  sourceAssetId: Id,
  status: z.enum(["queued", "running", "succeeded", "partial", "failed"]),
  prompts: z.array(z.string().min(1).max(60)).min(1).max(6),
  /** prompt → segmentation id */
  segmentationIds: z.record(z.string(), Id).default({}),
  transcriptId: Id.optional(),
  durationSec: z.number().nonnegative().optional(),
  objects: z
    .array(
      z.object({
        key: z.string().max(60),
        label: z.string().max(80),
        segmentationId: Id,
        objectId: z.string().max(40),
        trackingQuality: Percent01.optional(),
        /** Time ranges where the object is visible. */
        presence: z.array(z.object({ startSec: z.number().min(0), endSec: z.number().min(0) })).max(100).default([]),
        /** Typical normalised position, for prompts ("phone mostly lower-right"). */
        meanBbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
      }),
    )
    .default([]),
  jobId: Id.optional(),
  error: z.string().max(1000).optional(),
});
export type ClipAnalysis = z.infer<typeof ClipAnalysis>;
