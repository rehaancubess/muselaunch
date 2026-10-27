import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const csv = z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

/**
 * All runtime configuration. Every value has a local-dev default so `pnpm dev` works with
 * only provider keys filled in. Production deploys must set the ones marked REQUIRED-PROD.
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["local", "staging", "production"]).default("local"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  API_PUBLIC_URL: z.string().default("http://localhost:8080"),
  API_PORT: z.coerce.number().default(8080),
  WORKER_PORT: z.coerce.number().default(8081),
  /** Comma-separated worker pools this worker process serves: agents,media,render. */
  WORKER_POOLS: csv.default(["agents", "media", "render"]),

  // Data
  DB_DRIVER: z.enum(["memory", "firestore"]).optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIRESTORE_DATABASE_ID: z.string().optional(),

  // Storage
  STORAGE_DRIVER: z.enum(["local", "gcs"]).default("local"),
  STORAGE_BUCKET: z.string().optional(),
  LOCAL_STORAGE_DIR: z.string().default(".data/storage"),
  /** HMAC key for local signed URLs. REQUIRED-PROD when STORAGE_DRIVER=local. */
  STORAGE_SIGNING_SECRET: z.string().min(16).default("dev-only-insecure-signing-secret"),

  // Auth
  AUTH_MODE: z.enum(["firebase", "dev"]).default("firebase"),
  /** Accept `Bearer dev:<uid>:<email>` tokens. Never honoured when NODE_ENV=production. */
  AUTH_DEV_TOKENS: bool.default(false),

  // Jobs
  JOB_DISPATCH: z.enum(["inline", "http", "cloudtasks"]).default("http"),
  WORKER_URL: z.string().default("http://localhost:8081"),
  WORKER_URL_AGENTS: z.string().optional(),
  WORKER_URL_MEDIA: z.string().optional(),
  WORKER_URL_RENDER: z.string().optional(),
  /** Shared secret for http dispatch to workers (REQUIRED-PROD for http mode). */
  WORKER_SHARED_SECRET: z.string().min(16).default("dev-only-insecure-worker-secret"),
  TASKS_LOCATION: z.string().default("us-central1"),
  TASKS_QUEUE_AGENTS: z.string().default("muselaunch-agents"),
  TASKS_QUEUE_MEDIA: z.string().default("muselaunch-media"),
  TASKS_QUEUE_RENDER: z.string().default("muselaunch-render"),
  /** Service account Cloud Tasks uses to mint OIDC tokens for the worker. */
  TASKS_INVOKER_SA: z.string().optional(),

  // Meta Model API
  META_API_KEY: z.string().optional(),
  META_BASE_URL: z.string().default("https://api.meta.ai/v1"),
  META_MODEL_WONDER: z.string().default("muse-wonder-1.0"),
  META_MODEL_SPARK: z.string().default("muse-spark-1.3"),
  META_MODEL_SAM: z.string().default("sam-3.1"),
  META_MODEL_VOICE: z.string().default("muse-voice-transcribe-1.0"),
  META_MODEL_IMAGE: z.string().default("muse-image-1.0"),
  META_TIMEOUT_MS: z.coerce.number().default(180_000),

  // Muse Glimmer (self-hosted, OpenAI-compatible)
  GLIMMER_BASE_URL: z.string().optional(),
  GLIMMER_API_KEY: z.string().optional(),
  GLIMMER_MODEL: z.string().default("muse-glimmer"),
  GLIMMER_LABEL: z.string().default("self-hosted"),

  // Images
  /** Image generation provider. `muse` is only used when the eligibility gate passes. */
  IMAGE_PROVIDER: z.enum(["openai", "muse", "none"]).default("openai"),
  MUSE_IMAGE_ENABLED: bool.default(false),
  /** Where the operator accesses Meta from (ISO country). Muse Image is never called if restricted. */
  OPERATOR_COUNTRY: z.string().length(2).default("IN"),
  MUSE_IMAGE_RESTRICTED_COUNTRIES: csv.default(["IN"]),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-1"),
  OPENAI_TTS_MODEL: z.string().default("gpt-4o-mini-tts"),

  // Optional third-party media
  PEXELS_API_KEY: z.string().optional(),
  PIXABAY_API_KEY: z.string().optional(),

  // Spend & safety
  GLOBAL_DAILY_SPEND_CEILING_USD: z.coerce.number().default(40),
  WORKSPACE_MONTHLY_SPEND_CEILING_USD: z.coerce.number().default(25),
  /** Write redacted request/response traces of every model call (demo/audit evidence). */
  TRACE_MODEL_IO: bool.default(true),
  /** base64 32-byte key for encrypting OAuth tokens. REQUIRED-PROD. */
  TOKEN_ENCRYPTION_KEY: z.string().optional(),

  PLANS_JSON: z.string().optional(),
  CREDIT_PRICES_JSON: z.string().optional(),
  /** Credits granted to a new workspace. */
  SIGNUP_CREDITS: z.coerce.number().int().default(300),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { fresh?: boolean } = {}): Config {
  if (cached && !opts.fresh && env === process.env) return cached;
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production") assertProductionSafe(cfg);
  if (env === process.env) cached = cfg;
  return cfg;
}

function assertProductionSafe(cfg: Config) {
  const problems: string[] = [];
  if (cfg.AUTH_MODE !== "firebase") problems.push("AUTH_MODE must be firebase");
  if (cfg.STORAGE_DRIVER === "local" && cfg.STORAGE_SIGNING_SECRET.startsWith("dev-only")) problems.push("STORAGE_SIGNING_SECRET must be set");
  if (cfg.JOB_DISPATCH === "http" && cfg.WORKER_SHARED_SECRET.startsWith("dev-only")) problems.push("WORKER_SHARED_SECRET must be set");
  if (cfg.JOB_DISPATCH === "inline") problems.push("JOB_DISPATCH=inline is not allowed in production");
  if (!cfg.TOKEN_ENCRYPTION_KEY) problems.push("TOKEN_ENCRYPTION_KEY must be set");
  if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join("; ")}`);
}

/** Muse Image eligibility (Meta Geographic Use Policy §2.2): operator AND end user must be outside restricted countries. */
export function museImageEligible(cfg: Config, endUserCountry: string | undefined): { eligible: boolean; reason: string } {
  if (!cfg.MUSE_IMAGE_ENABLED) return { eligible: false, reason: "Muse Image is disabled for this deployment" };
  const restricted = new Set(cfg.MUSE_IMAGE_RESTRICTED_COUNTRIES.map((c) => c.toUpperCase()));
  if (restricted.has(cfg.OPERATOR_COUNTRY.toUpperCase())) return { eligible: false, reason: `Muse Image cannot be accessed from ${cfg.OPERATOR_COUNTRY}` };
  if (!endUserCountry) return { eligible: false, reason: "End-user country unknown" };
  if (restricted.has(endUserCountry.toUpperCase())) return { eligible: false, reason: `Muse Image is not available to users in ${endUserCountry}` };
  return { eligible: true, reason: "eligible" };
}
