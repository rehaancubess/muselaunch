import { z } from "zod";
import { BaseEntity, Id } from "./common";

export const ProviderId = z.enum(["meta", "openai", "glimmer", "stock", "tts", "web", "publishing", "analytics", "render"]);
export type ProviderId = z.infer<typeof ProviderId>;

/** Canonical Meta model ids (verify against /v1/models at runtime). */
export const META_MODELS = {
  wonder: "muse-wonder-1.0",
  spark: "muse-spark-1.3",
  sam: "sam-3.1",
  voice: "muse-voice-transcribe-1.0",
  image: "muse-image-1.0",
} as const;

export const UsageOperation = z.enum([
  "responses",
  "chat",
  "messages",
  "image_generate",
  "image_edit",
  "asr",
  "asr_realtime",
  "segmentation",
  "file_upload",
  "embedding",
  "search",
  "tts",
  "render",
  "http",
]);

/**
 * ModelUsageEvent (spec 4.12): one per provider invocation. Written even on error.
 * `traceAssetPath` points at a redacted request/response record kept for the demo/audit.
 */
export const ModelUsageEvent = BaseEntity.extend({
  provider: ProviderId,
  model: z.string().max(80),
  operation: UsageOperation,
  task: z.string().max(120),
  requestId: z.string().max(200).optional(),
  appId: Id.optional(),
  jobId: Id.optional(),
  agentRunId: Id.optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  images: z.number().int().nonnegative().optional(),
  frames: z.number().int().nonnegative().optional(),
  audioSeconds: z.number().nonnegative().optional(),
  runtimeMs: z.number().int().nonnegative(),
  costUsdEstimate: z.number().nonnegative(),
  status: z.enum(["ok", "error"]),
  errorCode: z.string().max(120).optional(),
  cacheHit: z.boolean().default(false),
  dataMode: z.enum(["standard", "self_hosted", "third_party"]),
  traceAssetPath: z.string().max(1024).optional(),
});
export type ModelUsageEvent = z.infer<typeof ModelUsageEvent>;
