import { z } from "zod";
import { AspectRatio, Channel, Id, IsoDateTime } from "./common";

/**
 * Create runs ("What would you like to make?" → Generate video): ONE finished video from a request.
 * The SERVER moves every run along (packages/autopilot/src/create-runner.ts), from job-completion
 * hooks and a one-minute safety sweep, acting as the person who started it (their permissions, the
 * workspace's credits, one idempotency key per step). Clients (the web Create page, the phone app)
 * only WATCH a run and RESOLVE the decisions it stops at. Nothing here ever posts anything: posting
 * stays in the existing approval flow.
 *
 * The steps, in order:
 *   idea   campaign.generate_concepts (started by POST /apps/:appId/campaigns with origin "create")
 *   plan   the best-fitting idea is selected and produced: storyboard.generate in the chosen format/length
 *   make   storyboard.resolve_media → composition.build → render.preview
 *   check  the facts check (lint) → the final render's real price vs what was shown → the Brand check
 *   finish render.final → done (a ready final render of the video)
 *
 * HTTP API (all under /v1/workspaces/:workspaceId; workspace membership is enforced for every route):
 *
 *   GET  /apps/:appId/create-runs?limit=6        → CreateRunsResponse   (any member; newest first, last 7 days)
 *   GET  /create-runs/:campaignId                → { run: CreateRunView } (any member)
 *   POST /create-runs/:campaignId/resolve        → 202 { run: CreateRunView }
 *        body ResolveCreateRunRequest; needs `content.write` (the capability of the routes it stands in
 *        for: produce, the final render, a Brand-check override, a job retry). A stale `stepKey` (the
 *        video changed since the decision was shown) → 409 CONFLICT; read the run again.
 *
 * Decisions also appear in GET /needs-you (and Home): kind "decision", action "create_run", subject
 * { entity: "campaigns", id }, approve/reject naming the resolve route above.
 */

/** Where a run is (the five steps, then done). */
export const CreateRunStage = z.enum(["idea", "plan", "make", "check", "finish", "done"]);
export type CreateRunStage = z.infer<typeof CreateRunStage>;
export const CREATE_RUN_STEPS = ["idea", "plan", "make", "check", "finish"] as const satisfies readonly CreateRunStage[];

/**
 * The run's state, in one word:
 *  - working:   a job of this run is queued/running, or the server is about to take the next step;
 *  - waiting:   a passing problem (too many tasks at once, the Brand check still running, a hiccup):
 *               the server tries again by itself (`wait.until`);
 *  - needs_you: a decision only a person can make (`decision`);
 *  - failed:    a job of this run failed or was stopped (`failure`, with Try again);
 *  - stopped:   the person chose to leave it unfinished (Continue picks it up again);
 *  - done:      a ready final render exists (`video`).
 */
export const CreateRunStatus = z.enum(["working", "waiting", "needs_you", "failed", "stopped", "done"]);
export type CreateRunStatus = z.infer<typeof CreateRunStatus>;

/**
 * Why a run stopped for a person:
 *  - credits:    not enough credits for the next step (add credits, then Try again);
 *  - limit:      a plan limit that doesn't clear in a moment (daily final renders, the monthly allowance);
 *  - fix:        the facts check (lint) found blocking issues in the video (fix it in the editor, Try again);
 *  - brand:      the Brand check blocked the final render (fix it, or finish it anyway with a reason);
 *  - spend:      the video came out longer, so finishing it costs more than "Generate video" showed;
 *  - permission: the person it acts as can no longer make videos here (an editor continues it as themselves);
 *  - resume:     nothing moved it for a day; it doesn't carry on (or spend) without the person;
 *  - error:      the step was refused for another reason (the message says why).
 */
export const CreateDecisionKind = z.enum(["credits", "limit", "fix", "brand", "spend", "permission", "resume", "error"]);
export type CreateDecisionKind = z.infer<typeof CreateDecisionKind>;

export const CreateRunDecision = z.object({
  kind: CreateDecisionKind,
  /** The exact step it stopped at: `produce:<variantId>` or `final:<compositionId>:v<version>`. */
  stepKey: z.string().max(200),
  stage: CreateRunStage,
  /** Plain words for the person (from the refusing route, the Brand check or the price check). */
  message: z.string().max(1000),
  at: IsoDateTime,
  /** spend: what finishing costs now; credits: what the step needs. */
  credits: z.number().int().nonnegative().optional(),
  /** spend: what "Generate video" showed for the final render. */
  shown: z.number().int().nonnegative().optional(),
  /** brand: a person with `content.write` may finish it anyway with a reason. */
  canOverride: z.boolean().optional(),
  compositionId: Id.optional(),
  version: z.number().int().positive().optional(),
  reviewId: Id.optional(),
});
export type CreateRunDecision = z.infer<typeof CreateRunDecision>;

export const CreateRunFailure = z.object({
  stage: CreateRunStage,
  message: z.string().max(1000),
  /** The failed (or stopped) job; "retry" runs it again. */
  jobId: Id.optional(),
  canRetry: z.boolean(),
});
export type CreateRunFailure = z.infer<typeof CreateRunFailure>;

/**
 * Stored on the campaign (`Campaign.createRun`): only what the server alone knows. Everything else
 * (stage, progress, failures, the finished video) is derived from the stored records every time.
 */
export const CreateRunState = z.object({
  /** Who pressed "Generate video" (the step keys are theirs, so a step can only ever start once). */
  startedBy: Id,
  /** Whose permissions the next step runs with: the starter, or the editor who last resolved a decision. */
  actingAs: Id,
  /** Cached summary for lists and the sweep (the read model re-derives it). */
  status: CreateRunStatus.default("working"),
  stage: CreateRunStage.default("idea"),
  decision: CreateRunDecision.optional(),
  failure: CreateRunFailure.optional(),
  /** waiting: try again after this (passing problems). */
  waitUntil: IsoDateTime.optional(),
  waitReason: z.string().max(300).optional(),
  /** busy: a task slot or the Brand check (a finished job tries again at once); glitch: an unexpected error (waited out a few times, then it asks). */
  waitKind: z.enum(["busy", "glitch"]).optional(),
  /** Passing problems in a row (backoff); reset when a step goes through. */
  waits: z.number().int().nonnegative().default(0),
  /** The person OK'd a final render that costs more than shown (that exact version and price). */
  approvedSpend: z.object({ stepKey: z.string().max(200), credits: z.number().int().nonnegative(), by: Id, at: IsoDateTime }).optional(),
  /** The person's reason to finish past a blocked Brand check (that exact version only; also stored on the review + audit log). */
  override: z.object({ stepKey: z.string().max(200), reason: z.string().max(500), by: Id, at: IsoDateTime }).optional(),
  /** Jobs the server started for this run (concepts, plan, final render). */
  jobIds: z.array(Id).max(20).default([]),
  /** Last time a person or the server moved it (a run nobody moved for a day waits for the person). */
  touchedAt: IsoDateTime,
  doneAt: IsoDateTime.optional(),
  /** Short lease so a hook, the sweep and a person's decision never take a step at the same time. */
  lease: z.object({ token: z.string().max(64), until: IsoDateTime }).optional(),
  /** Something changed while the lease was held: the holder looks again before letting go. */
  again: z.boolean().optional(),
});
export type CreateRunState = z.infer<typeof CreateRunState>;

/** The finished video of a run (a ready final render). */
export const CreateRunVideo = z.object({
  assetId: Id,
  posterAssetId: Id.optional(),
  version: z.number().int().optional(),
  durationSec: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  renderedAt: IsoDateTime.optional(),
});
export type CreateRunVideo = z.infer<typeof CreateRunVideo>;

/** What a client resolves a run with (POST /create-runs/:campaignId/resolve). */
export const CreateRunAction = z.enum(["retry", "approve_spend", "override", "stop"]);
export type CreateRunAction = z.infer<typeof CreateRunAction>;

/** One Create run as any client shows it (built from stored records + the server's decision). */
export const CreateRunView = z.object({
  campaignId: Id,
  appId: Id,
  /** What the person asked for, verbatim. */
  request: z.string().max(4000),
  /** The campaign's short name (Muse Spark's, once the ideas are written). */
  name: z.string().max(160),
  kind: z.enum(["promote", "feature"]),
  format: z.object({ aspectRatio: AspectRatio, lengthSec: z.number().positive().optional(), channel: Channel.optional() }),
  startedBy: Id,
  createdAt: IsoDateTime,
  stage: CreateRunStage,
  status: CreateRunStatus,
  /** 0–100 over the whole run (real job progress). */
  pct: z.number().int().min(0).max(100),
  /** The running job's own words ("rendering video"), when it has some. */
  detail: z.string().max(200).optional(),
  ideaTitle: z.string().max(200).optional(),
  ideaCount: z.number().int().nonnegative(),
  variantId: Id.optional(),
  compositionId: Id.optional(),
  decision: CreateRunDecision.nullable(),
  failure: CreateRunFailure.nullable(),
  wait: z.object({ until: IsoDateTime.optional(), reason: z.string().max(300) }).nullable(),
  video: CreateRunVideo.nullable(),
  /** What the caller may do now (empty without `content.write`). */
  actions: z.array(CreateRunAction),
});
export type CreateRunView = z.infer<typeof CreateRunView>;

export const CreateRunsResponse = z.object({ items: z.array(CreateRunView) });
export type CreateRunsResponse = z.infer<typeof CreateRunsResponse>;

/**
 * POST /create-runs/:campaignId/resolve
 *  - retry:         take the stopped step again (after adding credits, a fix in the editor, a failed
 *                   job: runs it again; a stopped or day-old run: continues it);
 *  - approve_spend: finish it at the price in the `spend` decision (that exact version);
 *  - override:      finish it past the Brand check with `reason` (that exact version; kept with the review);
 *  - stop:          leave it unfinished (the video stays editable; "retry" continues it later).
 * `stepKey`: the decision's step key the client showed (required for approve_spend and override).
 */
export const ResolveCreateRunRequest = z
  .object({
    action: CreateRunAction,
    stepKey: z.string().max(200).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .refine((r) => r.action !== "override" || Boolean(r.reason), { message: "Say why it’s fine to finish it (a few words).", path: ["reason"] })
  .refine((r) => (r.action !== "override" && r.action !== "approve_spend") || Boolean(r.stepKey), { message: "stepKey is required", path: ["stepKey"] });
export type ResolveCreateRunRequest = z.infer<typeof ResolveCreateRunRequest>;

export const ResolveCreateRunResponse = z.object({ run: CreateRunView });
export type ResolveCreateRunResponse = z.infer<typeof ResolveCreateRunResponse>;
