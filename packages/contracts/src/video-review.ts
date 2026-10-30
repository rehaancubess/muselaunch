import { z } from "zod";
import { Actor, BaseEntity, Id, IsoDateTime } from "./common";

/**
 * Spark video review: Muse Spark (multimodal) watches frames of a RENDERED video (not the composition
 * document) and reports what a viewer would actually see: unreadable hooks, cut-off text, a device
 * frame inside another device frame, blank or broken frames, repetition, pacing, the CTA, brand fit and
 * honesty. Deterministic measurements (reading speed, uniform frames, marketing screenshots inside a
 * device frame, reused media) run alongside and are labelled `measured`.
 *
 * Template-agnostic: scenes are read from the composition document, frames are sampled from the MP4.
 */

/** What a finding is about (the rubric). */
export const VideoReviewCheck = z.enum([
  "hook_readability",
  "legibility",
  "safe_zone",
  "device_frame",
  "broken_frame",
  "repetition",
  "pacing",
  "cta",
  "brand_fit",
  "honesty",
  "other",
]);
export type VideoReviewCheck = z.infer<typeof VideoReviewCheck>;

export const VIDEO_REVIEW_CHECKS = VideoReviewCheck.options;

export const VideoReviewSeverity = z.enum(["blocker", "warn", "info"]);
export type VideoReviewSeverity = z.infer<typeof VideoReviewSeverity>;

/** One frame sampled from the render (stored as a derived image asset so the UI can show it). */
export const VideoReviewFrame = z.object({
  /** Short reference used by findings and in the prompt: "f1", "f2"… in time order. */
  ref: z.string().regex(/^f\d{1,2}$/),
  atSec: z.number().min(0),
  sceneId: Id.optional(),
  /** first = the very first frame; mid = a scene's mid-point; early/late = extra samples of a long scene. */
  kind: z.enum(["first", "mid", "early", "late"]),
  assetId: Id.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type VideoReviewFrame = z.infer<typeof VideoReviewFrame>;

/** What happened to a finding afterwards (a scene-scoped fix requested from it). */
export const VideoReviewResolution = z.object({
  state: z.enum(["fix_requested"]),
  patchId: Id.optional(),
  by: Actor,
  at: IsoDateTime,
});

export const VideoReviewFinding = z.object({
  id: z.string().max(40),
  /** Scene the issue is in; absent for an issue with the whole video. */
  sceneId: Id.optional(),
  severity: VideoReviewSeverity,
  check: VideoReviewCheck,
  issue: z.string().max(600),
  /** Concrete instruction for a scene-scoped edit (used by "Fix these scenes" and the Autopilot fix round). */
  fixInstruction: z.string().max(600),
  /** Frame that shows it (VideoReviewFrame.ref). */
  frameRef: z.string().max(12).optional(),
  /** `spark` = Muse Spark looked at the frames; `measured` = a deterministic measurement. */
  source: z.enum(["spark", "measured"]),
  /** The measured value behind a `measured` finding (e.g. "4.6 words/s"). */
  measurement: z.string().max(200).optional(),
  resolution: VideoReviewResolution.optional(),
});
export type VideoReviewFinding = z.infer<typeof VideoReviewFinding>;

export const VideoReview = BaseEntity.extend({
  appId: Id,
  compositionId: Id,
  /** Composition version the render was made from. */
  version: z.number().int().min(1),
  /** The rendered MP4 that was watched. */
  renderAssetId: Id,
  renderQuality: z.enum(["preview", "final"]).optional(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  /** Set only when Spark actually reviewed the frames (never on a failed review). */
  verdict: z.enum(["pass", "warnings", "blockers"]).optional(),
  /** Spark's overall score, 0–10. */
  score: z.number().min(0).max(10).optional(),
  summary: z.string().max(2000).default(""),
  frames: z.array(VideoReviewFrame).max(16).default([]),
  findings: z.array(VideoReviewFinding).max(60).default([]),
  /** Spark's verdict per rubric item ("unclear" when the frames can't show it). */
  rubric: z.array(z.object({ check: VideoReviewCheck, verdict: z.enum(["ok", "issue", "unclear"]), note: z.string().max(300).optional() })).max(20).default([]),
  /** The model that answered (Muse Spark, or Muse Spark Open when it stood in visibly). */
  reviewer: z.object({ model: z.string().max(80).optional(), label: z.string().max(120).optional(), note: z.string().max(300).optional() }).default({}),
  /** Who asked: a person in the Studio, or the Growth Autopilot. */
  requestedFrom: z.enum(["studio", "autopilot", "api"]).default("api"),
  agentRunId: Id.optional(),
  jobId: Id.optional(),
  /** Patches created from this review's findings (Studio "Fix these scenes", Autopilot fix round). */
  fixPatchIds: z.array(Id).max(20).default([]),
  checkedAt: IsoDateTime.optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  error: z.string().max(1000).optional(),
});
export type VideoReview = z.infer<typeof VideoReview>;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** `POST /compositions/:id/video-reviews`: watch the render of a version (defaults: current version, its final render, else its preview render). */
export const CreateVideoReviewRequest = z.object({
  version: z.number().int().min(1).optional(),
  renderAssetId: Id.optional(),
  /** Watch again even when this render was already reviewed. */
  rerun: z.boolean().default(false),
});
export type CreateVideoReviewRequest = z.infer<typeof CreateVideoReviewRequest>;

/** `POST /video-reviews/:id/fix`: a scene-scoped AI edit from these findings (default: every open blocker and warning tied to a scene). */
export const FixVideoReviewRequest = z.object({
  findingIds: z.array(z.string().max(40)).max(30).optional(),
});
export type FixVideoReviewRequest = z.infer<typeof FixVideoReviewRequest>;
