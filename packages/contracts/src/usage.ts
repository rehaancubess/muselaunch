import { z } from "zod";
import { BaseEntity, Id } from "./common";

/** `baseten` (additive): Muse Spark Open, Meta's open-weights model served by Baseten Model APIs. */
export const ProviderId = z.enum(["meta", "openai", "glimmer", "stock", "tts", "web", "publishing", "analytics", "render", "baseten"]);
export type ProviderId = z.infer<typeof ProviderId>;

/** Canonical Meta model ids (verify against /v1/models at runtime). */
export const META_MODELS = {
  wonder: "muse-wonder-1.0",
  spark: "muse-spark-1.3",
  sam: "sam-3.1",
  voice: "muse-voice-transcribe-1.0",
  image: "muse-image-1.0",
} as const;

/**
 * Muse Spark Open on Baseten. The hackathon key only works with this exact slug (Baseten's docs show
 * the unversioned `meta-models/muse-spark-open`).
 */
export const SPARK_OPEN_MODEL = "meta-models/muse-spark-open-1026";
/** How Muse Spark Open is named wherever a model name is shown. "Open weights" is said only of Spark Open and Glimmer. */
export const SPARK_OPEN_LABEL = "Muse Spark Open · open weights via Baseten";

export function isSparkOpenModel(model?: string | null): boolean {
  return Boolean(model && /muse-spark-open/i.test(model));
}

/** Friendly model name for UI and run titles (ids stay visible next to it for transparency). */
export function modelDisplayName(model?: string | null, opts: { short?: boolean } = {}): string {
  if (!model) return "";
  // Checked before "muse-spark": a Spark Open id must never be shown as Muse Spark.
  if (isSparkOpenModel(model)) return opts.short ? "Muse Spark Open" : SPARK_OPEN_LABEL;
  if (model.startsWith("muse-wonder")) return "Muse Wonder";
  if (model.startsWith("muse-spark")) return "Muse Spark";
  if (model.includes("glimmer")) return "Muse Glimmer";
  // OpenAI text models only appear while OpenAI stands in for the Meta Model API: say so.
  if (/^gpt-\d/.test(model)) return `OpenAI ${model}`;
  return model;
}

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
  /** Provider quota units consumed (e.g. YouTube Data API units). Free, but limited per project per day. */
  quotaUnits: z.number().int().nonnegative().optional(),
  runtimeMs: z.number().int().nonnegative(),
  costUsdEstimate: z.number().nonnegative(),
  status: z.enum(["ok", "error"]),
  errorCode: z.string().max(120).optional(),
  cacheHit: z.boolean().default(false),
  dataMode: z.enum(["standard", "self_hosted", "third_party"]),
  traceAssetPath: z.string().max(1024).optional(),
});
export type ModelUsageEvent = z.infer<typeof ModelUsageEvent>;
