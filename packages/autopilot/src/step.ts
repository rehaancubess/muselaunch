import type { Autopilot } from "@muselaunch/contracts";
import { DbError } from "@muselaunch/db";
import { toAppError, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { STAGES, type StepInfo } from "./stages";
import { INACTIVE, isTerminalJob, LoopEnv, nowMs, resumeKey, spentCredits, tagOf, type LogEntry, type Outcome } from "./state";

const LOG_CAP = 400;

/** Enqueue the next `autopilot.step` (deterministic idempotency key). */
export async function enqueueStep(p: Platform, ap: Pick<Autopilot, "id" | "workspaceId" | "appId" | "createdBy">, key: string) {
  return p.jobs.create(ap.workspaceId, "autopilot.step", { autopilotId: ap.id }, { actor: ap.createdBy, appId: ap.appId, idempotencyKey: key });
}

/** Work out what this step should do from the loop's persisted state. */
async function stepInfo(p: Platform, ap: Autopilot): Promise<StepInfo | { skip: string }> {
  const ws = p.db.ws(ap.workspaceId);
  switch (ap.status) {
    case "running":
      return { phase: "enter", approved: false };
    case "waiting_on_jobs": {
      const jobs = await ws.collection("jobs").getMany(ap.waitingOn.jobIds);
      if (jobs.length < ap.waitingOn.jobIds.length || jobs.some((j) => !isTerminalJob(j))) return { skip: "jobs still running" };
      return { phase: "resume", tag: tagOf(ap.waitingOn.reason), approved: false };
    }
    case "sleeping": {
      if (ap.waitingOn.until && Date.parse(ap.waitingOn.until) > nowMs(p)) return { skip: "sleeping" };
      return { phase: "resume", tag: tagOf(ap.waitingOn.reason), approved: false };
    }
    case "awaiting_user": {
      const approval = ap.waitingOn.approvalId ? await ws.collection("approvals").get(ap.waitingOn.approvalId) : null;
      if (!approval || (approval.status !== "approved" && approval.status !== "consumed")) return { skip: "waiting for the user" };
      const tag = tagOf(ap.waitingOn.reason) ?? "";
      if (tag.startsWith("budget@")) {
        const orig = tag.slice("budget@".length);
        return orig === "enter" ? { phase: "enter", approved: true } : { phase: "resume", tag: orig, approved: true };
      }
      return { phase: "approved", tag, approved: true };
    }
    default:
      return { skip: ap.status };
  }
}

function control(ap: Autopilot, o: Outcome): Partial<Autopilot> {
  switch (o.kind) {
    case "advance":
      return { status: "running", stage: o.to, waitingOn: { jobIds: [] } };
    case "wait":
      return { status: "waiting_on_jobs", waitingOn: { jobIds: o.jobIds, reason: `[${o.tag}] ${o.reason}` } };
    case "checkpoint":
      return { status: "awaiting_user", waitingOn: { jobIds: [], approvalId: o.approvalId, reason: `[${o.tag}] ${o.reason}` } };
    case "sleep":
      return { status: "sleeping", waitingOn: { jobIds: [], until: o.until, reason: `[${o.tag}] ${o.reason}` } };
    case "done":
      return { status: "completed", stage: "done", waitingOn: { jobIds: [] } };
  }
  return { stage: ap.stage };
}

/**
 * Persist the step: facts (ids, decisions, log) always; control (status/stage/waitingOn) only if
 * nobody paused/cancelled the loop meanwhile. Optimistic concurrency on `updatedAt`.
 */
async function commit(env: LoopEnv, outcome: Outcome | null, extra: Partial<Autopilot> = {}): Promise<Autopilot> {
  const repo = env.ws.collection("autopilots");
  let base = env.original;
  for (let attempt = 0; attempt < 4; attempt++) {
    const log: LogEntry[] = [...base.log, ...env.entries].slice(-LOG_CAP);
    const spent = await spentCredits(env.ws, env.appId, log);
    const halted = INACTIVE.includes(base.status) && base.status !== env.original.status;
    const ctl = outcome && !halted ? control(base, outcome) : {};
    const patch: Partial<Autopilot> = {
      ...env.patch,
      ...(halted ? { status: base.status, stage: base.stage, waitingOn: base.waitingOn } : {}),
      ...ctl,
      ...(halted ? {} : extra),
      agentRunIds: [...new Set([...base.agentRunIds, ...env.runIds])],
      spent: { credits: spent, usd: Math.round((base.spent.usd + env.usd) * 10_000) / 10_000 },
      log,
    };
    try {
      return await repo.update(base.id, patch, { actor: env.ctx.actor, expectedUpdatedAt: base.updatedAt });
    } catch (err) {
      if (!(err instanceof DbError && err.code === "CONFLICT")) throw err;
      base = await repo.getOrThrow(base.id);
    }
  }
  throw new DbError("CONFLICT", "Autopilot was modified concurrently");
}

/** After persisting, kick the next step (or resume immediately if awaited jobs already finished). */
async function kick(p: Platform, saved: Autopilot, outcome: Outcome): Promise<string | undefined> {
  if (INACTIVE.includes(saved.status)) return undefined;
  if (outcome.kind === "advance") return (await enqueueStep(p, saved, `autopilot:${saved.id}:it${saved.iteration}:${saved.stage}:enter:${saved.log.length}`)).id;
  if (outcome.kind === "wait") {
    const jobs = await p.db.ws(saved.workspaceId).collection("jobs").getMany(saved.waitingOn.jobIds);
    if (jobs.length === saved.waitingOn.jobIds.length && jobs.every(isTerminalJob)) return (await enqueueStep(p, saved, resumeKey(saved.id, saved.waitingOn.jobIds))).id;
  }
  return undefined;
}

/**
 * autopilot.step: advance the Growth Autopilot by one stage transition. Free (credits are reserved
 * by the delegated jobs, within the loop budget). Idempotent: stage work uses deterministic ids and
 * job keys; the loop's control fields are written with optimistic concurrency.
 */
export async function autopilotStepHandler(ctx: JobContext<"autopilot.step">): Promise<JobResult> {
  const p = ctx.platform;
  const ap = await ctx.ws.collection("autopilots").getOrThrow(ctx.payload.autopilotId);
  const info = await stepInfo(p, ap);
  if ("skip" in info) return { creditsUsed: 0, data: { skipped: info.skip, status: ap.status, stage: ap.stage } };
  if (ap.stage === "done") return { creditsUsed: 0, data: { skipped: "done" } };
  const env = new LoopEnv(ctx, ap);
  env.currentTag = info.phase === "enter" ? undefined : info.tag;
  if (info.phase === "approved" || info.approved) {
    if (ap.waitingOn.approvalId) await ctx.ws.collection("approvals").update(ap.waitingOn.approvalId, { status: "consumed" }, { actor: ctx.actor }).catch(() => {});
  }
  let outcome: Outcome;
  try {
    ctx.throwIfCancelled();
    await ctx.progress(10, `${ap.stage.replace(/_/g, " ")}`);
    outcome = await STAGES[ap.stage](env, info);
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code === "CANCELLED") throw err;
    if (err.retryable && ctx.job.attempts < ctx.job.maxAttempts) {
      env.note("error", `Retrying ${ap.stage.replace(/_/g, " ")}: ${err.opts.userMessage ?? err.message}`);
      await commit(env, null).catch(() => {});
      throw err;
    }
    env.note("error", err.opts.userMessage ?? err.message);
    await commit(env, null, { status: "failed", error: err.toInfo() });
    return { creditsUsed: 0, data: { failed: err.code } };
  }
  if (outcome.kind === "done") env.note("decision", `Loop complete: ${outcome.summary}`);
  const saved = await commit(env, outcome);
  const next = await kick(p, saved, outcome);
  await ctx.progress(100, saved.status.replace(/_/g, " "));
  return { creditsUsed: 0, refs: [{ entity: "autopilots", id: saved.id }], data: { stage: saved.stage, status: saved.status, outcome: outcome.kind, nextStepJobId: next } };
}
