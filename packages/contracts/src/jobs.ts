import { z } from "zod";
import { AspectRatio, BaseEntity, EntityRef, ErrorInfo, Id, IsoDateTime } from "./common";
import { YouTubeChannelRelation } from "./analytics";
import { ResearchKind } from "./research";

/**
 * Every asynchronous unit of work. Payload schemas below are the contract between
 * the API (producer) and workers (consumers). Handlers must be idempotent: a job may be
 * delivered more than once (Cloud Tasks at-least-once); the lease + status guard dedupes.
 */
export const JobPayloads = {
  "app.import": z.object({ appId: Id, importId: Id }),
  "app.analyze": z.object({ appId: Id, importId: Id.optional(), assetIds: z.array(Id).default([]), refresh: z.boolean().default(false) }),
  "research.run": z.object({ appId: Id, researchRunId: Id, kinds: z.array(ResearchKind).min(1) }),
  "strategy.run": z.object({ appId: Id, agentRunId: Id, goal: z.string().max(4000), campaignId: Id.optional() }),
  "campaign.generate_concepts": z.object({ appId: Id, campaignId: Id, count: z.number().int().min(3).max(6).default(3) }),
  "storyboard.generate": z.object({ appId: Id, campaignId: Id, variantId: Id, aspectRatio: AspectRatio.default("9:16"), targetDurationSec: z.number().positive().max(90).default(15) }),
  "composition.build": z.object({ appId: Id, storyboardId: Id, compositionId: Id }),
  "composition.edit": z.object({
    appId: Id,
    compositionId: Id,
    baseVersion: z.number().int().min(1),
    instruction: z.string().min(1).max(2000),
    sceneIds: z.array(Id).default([]),
    patchId: Id,
    autoApply: z.boolean().default(false),
    /** Object-aware context: Spark may use these clips' SAM tracks/mattes + transcript to direct effects. */
    clipAnalysisIds: z.array(Id).max(4).default([]),
  }),
  "composition.variants": z.object({ appId: Id, compositionId: Id, mode: z.enum(["aspect", "audience", "hooks"]), targets: z.array(z.string().max(200)).min(1).max(5) }),
  "copy.generate": z.object({ appId: Id, campaignId: Id, variantId: Id.optional(), channels: z.array(z.string()).min(1) }),
  "render.preview": z.object({ appId: Id, compositionId: Id, version: z.number().int().min(1) }),
  "render.final": z.object({ appId: Id, compositionId: Id, version: z.number().int().min(1), format: z.enum(["mp4", "png", "jpeg"]).default("mp4") }),
  "package.export": z.object({ appId: Id, campaignId: Id, compositionIds: z.array(Id).default([]), includeCopy: z.boolean().default(true) }),
  "media.probe": z.object({ assetId: Id }),
  "media.segment": z.object({ segmentationId: Id }),
  "media.transcribe": z.object({ transcriptId: Id, languageBias: z.array(z.string().max(40)).max(5).optional(), keywords: z.array(z.string().max(60)).max(50).optional() }),
  "media.image_generate": z.object({ appId: Id.optional(), prompt: z.string().min(1).max(4000), count: z.number().int().min(1).max(4).default(1), size: z.enum(["1024x1024", "1024x1536", "1536x1024"]).default("1024x1536"), parentAssetId: Id.optional(), campaignId: Id.optional(), endUserCountry: z.string().length(2).optional() }),
  "media.tts": z.object({ appId: Id.optional(), text: z.string().min(1).max(5000), voice: z.string().max(60).optional(), compositionId: Id.optional() }),
  "discover.refresh": z.object({ appId: Id, trackedCreatorIds: z.array(Id).default([]) }),
  "outreach.draft": z.object({ appId: Id, prospectIds: z.array(Id).min(1).max(20), campaignId: Id.optional(), offer: z.string().max(1000).optional() }),
  "outreach.send": z.object({ draftId: Id, approvalId: Id }),
  "publish.post": z.object({ scheduledPostId: Id, approvalId: Id }),
  "analytics.sync": z.object({ connectionId: Id, appId: Id, since: IsoDateTime.optional() }),
  "analytics.import_csv": z.object({ appId: Id, importBatchId: Id }),
  /** Public YouTube channel analysis: Data API fetch + deterministic stats + labelled AI interpretation. */
  "analytics.youtube_channel": z.object({ appId: Id, channel: z.string().min(2).max(300), relation: YouTubeChannelRelation.default("competitor"), maxVideos: z.number().int().min(5).max(50).default(50) }),
  "experiment.analyze": z.object({ appId: Id, experimentId: Id }),
  "recommendations.generate": z.object({ appId: Id }),
  "memory.ingest": z.object({ appId: Id.optional(), ref: EntityRef }),
  /** SAM on several prompts (person, phone…) + tracks + Voice transcript for one real clip. */
  "media.analyze_clip": z.object({ clipAnalysisId: Id }),
  /** Muse Glimmer Brand Guardian review of a composition version / copy pack / asset. */
  "brand.review": z.object({ appId: Id, reviewId: Id }),
  /** Advance the Growth Autopilot loop by one stage. */
  "autopilot.step": z.object({ autopilotId: Id }),
  /**
   * Walkthrough breakdown: shot detection + Muse Spark labels on sampled frames (+ narration via Muse
   * Voice Transcribe when consent is recorded) → RecordingSegments for one app_recording (replaces earlier ones).
   */
  "media.analyze_recording": z.object({ appId: Id, assetId: Id, transcribe: z.boolean().default(true) }),
  /**
   * Screenshots: Muse Spark classifies raw UI vs designed store image (screenshotKind); SAM 3.1 cuts the
   * app screen out of designed images into a derived `sam_ui_crop` asset. Omit assetIds for all of the app's screenshots.
   */
  "media.extract_ui": z.object({ appId: Id, assetIds: z.array(Id).max(50).optional() }),
} as const;

export type JobType = keyof typeof JobPayloads;
export const JOB_TYPES = Object.keys(JobPayloads) as JobType[];
export const JobTypeSchema = z.enum(JOB_TYPES as [JobType, ...JobType[]]);
export type JobPayload<T extends JobType> = z.infer<(typeof JobPayloads)[T]>;

export const JobStatus = z.enum(["queued", "running", "needs_approval", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];

/** Which worker pool handles a job type (maps to separate Cloud Run services). */
export const JOB_POOLS: Record<JobType, "agents" | "media" | "render"> = {
  "app.import": "agents",
  "app.analyze": "agents",
  "research.run": "agents",
  "strategy.run": "agents",
  "campaign.generate_concepts": "agents",
  "storyboard.generate": "agents",
  "composition.build": "agents",
  "composition.edit": "agents",
  "composition.variants": "agents",
  "copy.generate": "agents",
  "render.preview": "render",
  "render.final": "render",
  "package.export": "render",
  "media.probe": "media",
  "media.segment": "media",
  "media.transcribe": "media",
  "media.image_generate": "media",
  "media.tts": "media",
  "discover.refresh": "agents",
  "outreach.draft": "agents",
  "outreach.send": "agents",
  "publish.post": "agents",
  "analytics.sync": "agents",
  "analytics.import_csv": "agents",
  "analytics.youtube_channel": "agents",
  "experiment.analyze": "agents",
  "recommendations.generate": "agents",
  "memory.ingest": "agents",
  "media.analyze_clip": "media",
  "brand.review": "agents",
  "autopilot.step": "agents",
  "media.analyze_recording": "media",
  "media.extract_ui": "media",
};

export const JobProgress = z.object({
  pct: z.number().min(0).max(100).default(0),
  stage: z.string().max(80).default("queued"),
  message: z.string().max(500).optional(),
});
export type JobProgress = z.infer<typeof JobProgress>;

export const Job = BaseEntity.extend({
  type: JobTypeSchema,
  appId: Id.optional(),
  status: JobStatus,
  /** Unique per workspace; creating the same key twice returns the existing job. */
  idempotencyKey: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()),
  progress: JobProgress.default({ pct: 0, stage: "queued" }),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  leaseOwner: z.string().max(120).optional(),
  leaseExpiresAt: IsoDateTime.optional(),
  cancelRequested: z.boolean().default(false),
  dependsOn: z.array(Id).default([]),
  parentJobId: Id.optional(),
  agentRunId: Id.optional(),
  reservation: z.object({ reservationId: Id, credits: z.number().int().nonnegative() }).optional(),
  /** Credits actually charged at completion. */
  creditsCharged: z.number().int().nonnegative().optional(),
  output: z.object({ refs: z.array(EntityRef).default([]), data: z.record(z.string(), z.unknown()).optional() }).optional(),
  error: ErrorInfo.optional(),
  queuedAt: IsoDateTime,
  startedAt: IsoDateTime.optional(),
  finishedAt: IsoDateTime.optional(),
});
export type Job = z.infer<typeof Job>;

export const JobEvent = BaseEntity.extend({
  jobId: Id,
  seq: z.number().int().nonnegative(),
  kind: z.enum(["status", "progress", "log", "artifact", "error"]),
  status: JobStatus.optional(),
  progress: JobProgress.optional(),
  message: z.string().max(2000).optional(),
  ref: EntityRef.optional(),
});
export type JobEvent = z.infer<typeof JobEvent>;

/** Body of the worker task endpoint (Cloud Tasks / local dispatcher). */
export const TaskEnvelope = z.object({ workspaceId: Id, jobId: Id, type: JobTypeSchema, attempt: z.number().int().optional() });
export type TaskEnvelope = z.infer<typeof TaskEnvelope>;
