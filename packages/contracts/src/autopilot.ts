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
});
export type Autopilot = z.infer<typeof Autopilot>;

export const StartAutopilotRequest = z.object({
  goal: z.string().min(1).max(1000),
  maxCredits: z.number().int().positive().max(2000).default(150),
  maxIterations: z.number().int().min(1).max(3).default(1),
  autoApproveCredits: z.number().int().nonnegative().max(200).default(0),
  variants: z.number().int().min(1).max(3).default(2),
});
