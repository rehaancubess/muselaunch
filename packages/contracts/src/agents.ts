import { z } from "zod";
import { BaseEntity, EntityRef, ErrorInfo, Id, IsoDateTime, SourceRef } from "./common";

export const AgentKind = z.enum([
  "growth_strategy",
  "research",
  "app_analysis",
  "campaign_concepts",
  "storyboard",
  "scene_edit",
  "claim_validation",
  "experiment_analysis",
  "outreach_drafting",
  "copywriting",
  "growth_autopilot",
  "brand_review",
  "effects_direction",
]);
export type AgentKind = z.infer<typeof AgentKind>;

/** Specialist roles Wonder may delegate to (spec 4.4). */
export const SpecialistRole = z.enum([
  "research",
  "audience_positioning",
  "creative_strategy",
  "copywriting",
  "claim_validator",
  "production_director",
  "experiment_analyst",
  "outreach_drafting",
]);

export const RunStatus = z.enum(["queued", "running", "needs_approval", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

/** Hard limits per run. Orchestrators must stop (not crash) when any is reached. */
export const AgentBudget = z.object({
  maxToolCalls: z.number().int().positive().default(24),
  maxTokens: z.number().int().positive().default(400_000),
  maxSearchCalls: z.number().int().nonnegative().default(12),
  maxWallMs: z.number().int().positive().default(10 * 60_000),
  maxCostUsd: z.number().positive().default(1.5),
  maxDepth: z.number().int().min(1).max(3).default(2),
});
export type AgentBudget = z.infer<typeof AgentBudget>;

export const AgentUsage = z.object({
  toolCalls: z.number().int().nonnegative().default(0),
  searchCalls: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  wallMs: z.number().int().nonnegative().default(0),
});
export type AgentUsage = z.infer<typeof AgentUsage>;

export const PlanTask = z.object({
  id: Id,
  role: SpecialistRole,
  title: z.string().max(200),
  objective: z.string().max(2000),
  dependsOn: z.array(Id).default([]),
  status: z.enum(["pending", "running", "done", "failed", "skipped"]).default("pending"),
  outputRef: EntityRef.optional(),
  /**
   * A follow-up job the strategist proposes (spend-related). Never executed until a human
   * approves the run's pending Approval; then it is enqueued with its own credit reservation.
   */
  proposedAction: z
    .object({
      type: z.enum(["research.run", "campaign.generate_concepts"]),
      params: z.record(z.string(), z.unknown()).default({}),
      estimatedCredits: z.number().int().nonnegative(),
    })
    .optional(),
});

/** Wonder's saved plan: goals, hypotheses, deliverables, measurement (spec 4.4). */
export const AgentPlan = z.object({
  goal: z.string().max(2000),
  audience: z.string().max(1000).optional(),
  hypotheses: z.array(z.string().max(500)).default([]),
  deliverables: z.array(z.string().max(300)).default([]),
  timeline: z.string().max(1000).optional(),
  measurement: z.array(z.string().max(300)).default([]),
  tasks: z.array(PlanTask).default([]),
});
export type AgentPlan = z.infer<typeof AgentPlan>;

export const AgentRun = BaseEntity.extend({
  appId: Id.optional(),
  kind: AgentKind,
  model: z.string().max(80),
  status: RunStatus,
  goal: z.string().max(4000),
  budget: AgentBudget,
  usage: AgentUsage.default({ toolCalls: 0, searchCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 }),
  plan: AgentPlan.optional(),
  /** Entities this run produced (research findings, brief, variants, patch...). */
  outputRefs: z.array(EntityRef).default([]),
  /** Approval needed before continuing (e.g. spend beyond estimate). */
  pendingApprovalId: Id.optional(),
  parentRunId: Id.optional(),
  jobId: Id.optional(),
  /** Glimmer memory items retrieved and passed to this run. */
  memoryRefs: z.array(Id).default([]),
  error: ErrorInfo.optional(),
  startedAt: IsoDateTime.optional(),
  finishedAt: IsoDateTime.optional(),
});
export type AgentRun = z.infer<typeof AgentRun>;

export const AgentStep = BaseEntity.extend({
  runId: Id,
  index: z.number().int().nonnegative(),
  kind: z.enum(["plan", "model_call", "tool_call", "subtask", "decision", "approval_request", "message", "budget_stop"]),
  title: z.string().max(300),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  model: z.string().max(80).optional(),
  /** Trimmed, redacted summaries; full payloads go to trace storage. */
  inputSummary: z.string().max(4000).optional(),
  outputSummary: z.string().max(8000).optional(),
  citations: z.array(SourceRef).default([]),
  usageEventIds: z.array(Id).default([]),
  traceAssetPath: z.string().max(1024).optional(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.optional(),
});
export type AgentStep = z.infer<typeof AgentStep>;

export const ToolInvocation = BaseEntity.extend({
  runId: Id,
  stepId: Id,
  tool: z.string().max(80),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  error: ErrorInfo.optional(),
  durationMs: z.number().int().nonnegative(),
});
export type ToolInvocation = z.infer<typeof ToolInvocation>;
