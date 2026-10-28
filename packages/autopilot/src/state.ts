import { createHash } from "node:crypto";
import { TERMINAL_JOB_STATUSES, type Approval, type Autopilot, type AutopilotStage, type EntityRef, type Job, type JobPayloads, type JobType } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, type JobContext, type Platform } from "@muselaunch/platform";
import type { z } from "zod";

export type LogEntry = Autopilot["log"][number];
export type Stage = AutopilotStage;

/** What a stage decided the loop should do next. */
export type Outcome =
  | { kind: "advance"; to: Stage }
  | { kind: "wait"; jobIds: string[]; tag: string; reason: string }
  | { kind: "checkpoint"; approvalId: string; tag: string; reason: string }
  | { kind: "sleep"; until: string; tag: string; reason: string }
  | { kind: "done"; summary: string };

export const STAGE_ORDER: Stage[] = ["understand", "research", "select_audience", "hypothesis", "plan_creative", "produce", "verify", "render", "schedule", "measure", "learn", "done"];

/** Statuses after which the loop does nothing until a human acts. */
export const INACTIVE: Autopilot["status"][] = ["completed", "failed", "cancelled", "paused"];

const clocks = new WeakMap<Platform, () => number>();
/** Tests: control time (sleep/wake of the measure stage). */
export function setAutopilotClock(p: Platform, now: () => number): void {
  clocks.set(p, now);
}
export function nowMs(p: Platform): number {
  return (clocks.get(p) ?? Date.now)();
}

/** `waitingOn.reason` carries a machine tag for the stage's sub-phase: "[produce:builds] Building 2 videos". */
export const tagOf = (reason?: string) => reason?.match(/^\[([^\]]+)\]/)?.[1];
export const reasonText = (reason?: string) => (reason ?? "").replace(/^\[[^\]]+\]\s*/, "");

export const isTerminalJob = (j: Pick<Job, "status">) => (TERMINAL_JOB_STATUSES as readonly string[]).includes(j.status) || j.status === "needs_approval";

export const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function hashId(prefix: string, ...parts: (string | number)[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("␟")).digest("hex").slice(0, 24)}`;
}

/** Log prefix written when the user resumes a failed loop; delegated work gets fresh job keys. */
export const RETRY_PREFIX = "Retrying after a failure";

/** Idempotency key for resuming one particular wait (same jobs awaited again later → a new key). */
export const resumeKey = (ap: Pick<Autopilot, "id" | "waitingOn" | "updatedAt">) => `autopilot:${ap.id}:resume:${shortHash(`${[...ap.waitingOn.jobIds].sort().join(",")}@${ap.updatedAt}`)}`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Job refs recorded in the decision log = every job this loop delegated. */
export function delegatedJobIds(log: LogEntry[]): string[] {
  return [...new Set(log.flatMap((e) => e.refs.filter((r) => r.entity === "jobs").map((r) => r.id)))];
}

/**
 * Credits consumed or held by everything this loop started: delegated jobs plus the follow-ups
 * they chained (e.g. storyboard → composition.build → render.preview). Settled jobs count what
 * was charged; open ones count their reservation.
 */
export async function spentCredits(ws: WorkspaceDb, appId: string, log: LogEntry[]): Promise<number> {
  const ids = delegatedJobIds(log);
  if (!ids.length) return 0;
  const direct = await ws.collection("jobs").getMany(ids);
  const set = new Set(ids);
  const recent = (await ws.collection("jobs").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 300 })).items;
  const all = new Map(direct.map((j) => [j.id, j]));
  // two levels of chaining (storyboard → build → preview)
  for (let level = 0; level < 2; level++) {
    for (const j of recent) if (j.parentJobId && set.has(j.parentJobId) && !all.has(j.id) && j.type !== "autopilot.step") all.set(j.id, j);
    for (const id of all.keys()) set.add(id);
  }
  let total = 0;
  for (const j of all.values()) total += isTerminalJob(j) ? (j.creditsCharged ?? 0) : (j.reservation?.credits ?? 0);
  return total;
}

/**
 * One autopilot step's working state: the loaded loop, its decision log additions and field
 * changes, plus helpers to delegate jobs (always logged), gate spend and open checkpoints.
 */
export class LoopEnv {
  readonly entries: LogEntry[] = [];
  readonly patch: Partial<Autopilot> = {};
  readonly runIds: string[] = [];
  usd = 0;
  ap: Autopilot;
  /** Sub-phase tag of the work being done in this step (undefined = stage entry). */
  currentTag: string | undefined;

  constructor(
    readonly ctx: JobContext<"autopilot.step">,
    readonly original: Autopilot,
  ) {
    this.ap = original;
  }

  get p() {
    return this.ctx.platform;
  }
  get ws() {
    return this.ctx.ws;
  }
  get appId() {
    return this.ap.appId;
  }
  get iteration() {
    return this.ap.iteration;
  }
  get tag() {
    return tagOf(this.ap.waitingOn.reason);
  }

  note(kind: LogEntry["kind"], summary: string, refs: EntityRef[] = [], agentRunId?: string): void {
    this.entries.push({ at: new Date(nowMs(this.p)).toISOString(), stage: this.ap.stage, kind, summary: clip(summary, 1200), refs: refs.slice(0, 20), agentRunId });
  }

  set(patch: Partial<Autopilot>): void {
    Object.assign(this.patch, patch);
    this.ap = { ...this.ap, ...patch };
  }

  /** All log entries including this step's additions. */
  get fullLog(): LogEntry[] {
    return [...this.ap.log, ...this.entries];
  }

  /**
   * Enqueue a delegated job with a deterministic key (idempotent) and log it with its ref.
   * After the user resumes a failed loop, work that already succeeded is reused and failed work is
   * re-run through the quota-aware retry path (`retryOfJobId`), never silently duplicated.
   */
  async delegate<T extends JobType>(type: T, payload: z.input<(typeof JobPayloads)[T]>, opts: { key: string; label: string; credits?: { operation: string; params?: Record<string, unknown> } }): Promise<Job> {
    const baseKey = `autopilot:${this.ap.id}:it${this.iteration}:${opts.key}`;
    const retries = this.fullLog.filter((e) => e.summary.startsWith(RETRY_PREFIX)).length;
    const prior = (await this.ws.collection("jobs").getMany(delegatedJobIds(this.fullLog)))
      .filter((j) => j.idempotencyKey === baseKey || j.idempotencyKey.startsWith(`${baseKey}:retry`))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = prior[prior.length - 1];
    if (last && last.status !== "failed" && last.status !== "cancelled") return last;
    const retryOf = last && retries > 0 ? last : undefined;
    const job = await this.ctx.enqueue(type, payload, {
      idempotencyKey: retryOf ? `${baseKey}:retry${retries}` : baseKey,
      retryOfJobId: retryOf?.id,
      credits: opts.credits,
      appId: this.appId,
    });
    if (!prior.some((j) => j.id === job.id)) this.note("action", retryOf ? `${opts.label} (retry)` : opts.label, [{ entity: "jobs", id: job.id }]);
    return job;
  }

  estimate(operation: string, params: Record<string, unknown> = {}): number {
    return this.p.credits.estimate(operation, params).credits;
  }

  async spent(): Promise<number> {
    return spentCredits(this.ws, this.appId, this.fullLog);
  }

  /**
   * Estimated credits for the rest of this iteration, from the current stage on (same price list
   * as `estimateAutopilot`). Automatic fix rounds aren't included: they only happen when a review
   * blocks, so they can still need one more approval.
   */
  restOfIteration(): number {
    const at = STAGE_ORDER.indexOf(this.ap.stage);
    const from = (s: Stage) => STAGE_ORDER.indexOf(s) >= at;
    const v = Math.max(1, this.ap.variantIds.length || this.ap.budget.variants);
    const e = (op: string, params: Record<string, unknown> = {}) => this.estimate(op, params);
    let n = 0;
    if (from("research")) n += e("research.run");
    if (from("plan_creative")) n += e("campaign.generate_concepts");
    if (from("produce")) n += v * (e("storyboard.generate") + e("composition.build") + e("render.preview"));
    if (from("verify")) n += v * e("brand.review");
    if (from("render")) n += v * e("render.final", { durationSec: 15 });
    if (from("schedule")) n += v * e("copy.generate");
    if (from("learn")) n += e("experiment.analyze") + e("recommendations.generate");
    return n;
  }

  /**
   * Budget guard before delegating `credits` of work. Returns a checkpoint when the loop budget
   * would be exceeded, otherwise null. One approval covers the rest of the iteration (not just the
   * next step), so a small budget asks once instead of before every stage.
   */
  async budgetGate(credits: number, what: string, approved: boolean): Promise<Outcome | null> {
    const spent = await this.spent();
    const max = this.ap.budget.maxCredits;
    if (spent + credits <= max) return null;
    const rest = Math.max(credits, this.restOfIteration());
    const raiseTo = Math.max(max, spent + rest);
    if (approved) {
      this.set({ budget: { ...this.ap.budget, maxCredits: raiseTo } });
      this.note("budget", `Budget raised to ${raiseTo} credits after your approval: enough for ${what} and the rest of this iteration (≈${rest}).`);
      return null;
    }
    this.note("budget", `Paused: ${what} needs ≈${credits} credits but only ${Math.max(0, max - spent)} of the ${max}-credit budget remain. The rest of this iteration is estimated at ≈${rest}.`);
    return this.checkpoint(
      "spend",
      `Growth Autopilot needs more credits: ≈${credits} for ${what}, ≈${rest} to finish this iteration (budget ${max}, used ${spent}). Approve to raise the budget to ${raiseTo} credits and continue.`,
      rest,
      `budget@${this.currentTag ?? "enter"}`,
      `Budget reached before ${what}`,
    );
  }

  /** Open an approval checkpoint on this loop (spend / continue). */
  async checkpoint(action: Approval["action"], summary: string, credits: number | undefined, tag: string, reason: string): Promise<Outcome> {
    const approval = await this.ws.collection("approvals").create(
      {
        appId: this.appId,
        action,
        subject: { entity: "autopilots", id: this.ap.id },
        snapshotHash: shortHash(`${this.ap.id}:${this.iteration}:${this.ap.stage}:${tag}:${this.fullLog.length}`),
        summary: clip(summary, 1000),
        requestedBy: `agent:autopilot:${this.ap.id}`,
        status: "pending",
        estimate: credits !== undefined ? { credits } : undefined,
      },
      { actor: this.ctx.actor },
    );
    this.note("checkpoint", reason, [{ entity: "approvals", id: approval.id }]);
    return { kind: "checkpoint", approvalId: approval.id, tag, reason };
  }

  /** Jobs this step waits on, loaded. */
  async jobs(ids = this.ap.waitingOn.jobIds): Promise<Job[]> {
    return this.ws.collection("jobs").getMany(ids);
  }
}

export function fail(code: "PROVIDER_ERROR" | "BAD_REQUEST" | "CONFLICT", message: string, userMessage?: string): AppError {
  return new AppError(code, message, { retryable: false, userMessage: userMessage ?? message });
}
