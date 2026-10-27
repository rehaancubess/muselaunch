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
  previewAssetId: Id.optional(),
  frameCount: z.number().int().nonnegative().optional(),
  fps: z.number().positive().optional(),
  /** 0..1 heuristic: coverage continuity across frames; < 0.5 falls back to unmasked footage. */
  trackingQuality: Percent01.optional(),
  /** User corrections (re-prompt points/boxes) applied. */
  corrections: z.array(z.object({ at: IsoDateTime, kind: z.enum(["prompt", "box", "point"]), value: z.string().max(200) })).default([]),
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
  usageEventIds: z.array(Id).default([]),
  error: z.string().max(1000).optional(),
});
export type Transcript = z.infer<typeof Transcript>;
