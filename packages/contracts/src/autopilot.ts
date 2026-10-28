import { z } from "zod";
import { BaseEntity, EntityRef, ErrorInfo, Id, IsoDateTime } from "./common";

/**
 * Growth Autopilot: a bounded, auditable autonomous marketing loop orchestrated by Muse Wonder.
 *
 *   understand → research → select_audience → hypothesis → plan_creative → produce → verify
 *   → (checkpoint) render → schedule → (checkpoint per post) → measure → learn → next iteration
 *
 * Each stage is executed by the `autopilot.step` job, which delegates real work to existing jobs
 * (research.run, campaign.generate_concepts, storyboard.generate, brand.review, render.final,
 * experiment.analyze, recommendations.generate) and then waits for them. Wonder makes the decisions
 * (with tools + citations); every decision, action and checkpoint is logged. External actions
 * (publishing, outreach) always require per-item human approval; spend beyond the budget or the
 * auto-approve threshold pauses at a checkpoint.
 */
export const AutopilotStage = z.enum([
  "understand",
  "research",
  "select_audience",
  "hypothesis",
  "plan_creative",
  "produce",
  "verify",
  "render",
  "schedule",
  "measure",
  "learn",
  "done",
]);
export type AutopilotStage = z.infer<typeof AutopilotStage>;

export const AutopilotStatus = z.enum(["running", "waiting_on_jobs", "awaiting_user", "sleeping", "paused", "completed", "failed", "cancelled"]);

export const AutopilotLogEntry = z.object({
  at: IsoDateTime,
  stage: AutopilotStage,
  kind: z.enum(["decision", "action", "observation", "checkpoint", "verification", "error", "budget"]),
  summary: z.string().max(1200),
  refs: z.array(EntityRef).max(20).default([]),
  agentRunId: Id.optional(),
});

export const Autopilot = BaseEntity.extend({
  appId: Id,
  /** The user's outcome, e.g. "More trial starts from students in the US". */
  goal: z.string().min(1).max(1000),
  status: AutopilotStatus,
  stage: AutopilotStage,
  iteration: z.number().int().min(1).default(1),
  budget: z.object({
    maxCredits: z.number().int().positive(),
    maxIterations: z.number().int().min(1).max(5).default(1),
    /** Credits a single delegated step may spend without asking (0 = always ask). */
    autoApproveCredits: z.number().int().nonnegative().default(0),
    variants: z.number().int().min(1).max(3).default(2),
  }),
  spent: z.object({ credits: z.number().int().nonnegative().default(0), usd: z.number().nonnegative().default(0) }).default({ credits: 0, usd: 0 }),
  audience: z
    .object({ segmentId: Id.optional(), description: z.string().max(1000), rationale: z.string().max(2000), findingIds: z.array(Id).default([]) })
    .optional(),
  hypothesis: z.object({ statement: z.string().max(1000), primaryMetric: z.string().max(80), experimentId: Id.optional() }).optional(),
  researchRunId: Id.optional(),
  campaignId: Id.optional(),
  variantIds: z.array(Id).default([]),
  compositionIds: z.array(Id).default([]),
  reviewIds: z.array(Id).default([]),
  scheduledPostIds: z.array(Id).default([]),
  recommendationIds: z.array(Id).default([]),
  /** What the loop is waiting for before the next step. */
  waitingOn: z
    .object({ jobIds: z.array(Id).default([]), approvalId: Id.optional(), until: IsoDateTime.optional(), reason: z.string().max(500).optional() })
    .default({ jobIds: [] }),
  /** Wonder runs that made this loop's decisions. */
  agentRunIds: z.array(Id).default([]),
  log: z.array(AutopilotLogEntry).max(400).default([]),
  error: ErrorInfo.optional(),
  /**
   * Set when MuseLaunch started the run on its own (Autopilot is on by default). `goal`: the goal is
   * provisional and is refined from App DNA once it exists; `acceptDna`: App DNA is accepted
   * automatically when it's ready (the founder can review it any time).
   */
  auto: z.object({ goal: z.boolean().default(false), acceptDna: z.boolean().default(false) }).optional(),
});
export type Autopilot = z.infer<typeof Autopilot>;

export const StartAutopilotRequest = z.object({
  goal: z.string().min(1).max(1000),
  maxCredits: z.number().int().positive().max(2000).default(150),
  maxIterations: z.number().int().min(1).max(3).default(1),
  autoApproveCredits: z.number().int().nonnegative().max(200).default(0),
  variants: z.number().int().min(1).max(3).default(2),
});

/** `POST /apps/:appId/autopilot/auto`: start with MuseLaunch's defaults (goal, budget, approvals). */
export const StartAutoAutopilotRequest = z.object({
  /** Fewer variants = a smaller run (offered when credits are short). Default 2. */
  variants: z.number().int().min(1).max(3).optional(),
});

/**
 * What an automatic run would use, and whether it fits (`GET /apps/:appId/autopilot/auto`).
 * Budget = one full iteration (estimateAutopilot, renders priced at up to 30 s) plus room for the
 * automatic fix rounds; the run never spends past it without a person approving.
 */
export const AutopilotAutoPlan = z.object({
  goal: z.string().max(1000),
  /** false = provisional goal; it's refined from App DNA once the app has been analysed. */
  goalFromDna: z.boolean(),
  variants: z.number().int().min(1).max(3),
  maxIterations: z.number().int().min(1).max(3),
  /** The run's budget (hard ceiling; more needs a person's approval). */
  maxCredits: z.number().int().nonnegative(),
  /** Final renders under this many credits run without asking (0 = always ask). */
  autoApproveCredits: z.number().int().nonnegative(),
  /** Credits still needed to learn the app before the run (App DNA analysis not started yet). */
  setupCredits: z.number().int().nonnegative(),
  /** maxCredits + setupCredits. */
  needed: z.number().int().nonnegative(),
  /** The workspace's available credits right now. */
  available: z.number().int(),
  fits: z.boolean(),
  shortfall: z.object({ kind: z.enum(["credits", "per_run_limit"]), message: z.string().max(500) }).optional(),
  /** A smaller run (fewer variants) that fits, offered when the default doesn't. */
  smaller: z.object({ variants: z.number().int().min(1).max(3), maxCredits: z.number().int(), needed: z.number().int() }).nullable(),
  breakdown: z.array(z.object({ label: z.string(), credits: z.number() })),
  /** Plain-language notes, e.g. why renders will still ask first. */
  notes: z.array(z.string().max(300)).default([]),
});
export type AutopilotAutoPlan = z.infer<typeof AutopilotAutoPlan>;

/** Result of trying to start an automatic run (also returned by `POST /apps` when Autopilot is on). */
export const AutopilotAutoStart = z.object({
  started: z.boolean(),
  autopilotId: Id.optional(),
  jobId: Id.optional(),
  plan: AutopilotAutoPlan.optional(),
  code: z.enum(["insufficient_credits", "per_run_limit", "no_source", "forbidden", "already_running", "error"]).optional(),
  /** Why it didn't start, in plain language. */
  reason: z.string().max(500).optional(),
});
export type AutopilotAutoStart = z.infer<typeof AutopilotAutoStart>;

/**
 * "Needs you": the approvals that really need a person (publish a post, send outreach, spend beyond a
 * budget, continue a loop), ready for one-tap decisions. `approve`/`reject` name the existing decision
 * routes (relative to the workspace), which keep their own permission and snapshot checks.
 */
export const NeedsYouItem = z.object({
  /** The approval id. */
  id: Id,
  kind: z.enum(["post", "outreach", "spend", "decision"]),
  action: z.string().max(40),
  appId: Id.optional(),
  title: z.string().max(200),
  summary: z.string().max(1000),
  createdAt: IsoDateTime,
  credits: z.number().int().nonnegative().optional(),
  subject: EntityRef,
  autopilotId: Id.optional(),
  /** Capability needed to decide; `canDecide` = the caller holds it. */
  requiredCap: z.string().max(40),
  canDecide: z.boolean(),
  /** The content changed after approval was requested: review it and request again. */
  stale: z.boolean().default(false),
  approve: z.object({ path: z.string().max(300), body: z.record(z.string(), z.unknown()).default({}) }).nullable(),
  reject: z.object({ path: z.string().max(300), body: z.record(z.string(), z.unknown()).default({}) }).nullable(),
  /** Where to review it in full (path under the web app's /w/:workspaceId). */
  reviewPath: z.string().max(300).optional(),
  preview: z
    .object({
      channel: z.string().max(40).optional(),
      caption: z.string().max(2200).optional(),
      scheduledAt: IsoDateTime.optional(),
      compositionId: Id.optional(),
      compositionTitle: z.string().max(200).optional(),
      to: z.string().max(320).optional(),
      subjectLine: z.string().max(300).optional(),
    })
    .optional(),
});
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;
export const NeedsYouResponse = z.object({ items: z.array(NeedsYouItem), count: z.number().int().nonnegative() });
export type NeedsYouResponse = z.infer<typeof NeedsYouResponse>;
