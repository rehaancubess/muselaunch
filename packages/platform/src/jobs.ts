import { createHash } from "node:crypto";
import { JOB_POOLS, JobPayloads, TERMINAL_JOB_STATUSES, type EntityRef, type ErrorInfo, type Job, type JobPayload, type JobType, type TaskEnvelope } from "@muselaunch/contracts";
import { newId, nowIso, type Db, type WorkspaceDb } from "@muselaunch/db";
import type { z } from "zod";
import type { Config } from "./config";
import type { CreditService } from "./credits";
import { AppError, toAppError } from "./errors";
import type { Logger } from "./logger";
import type { Platform } from "./platform";

// ---------------------------------------------------------------------------
// Handler contract (implemented by module packages, registered by the worker)
// ---------------------------------------------------------------------------

export interface JobResult {
  refs?: EntityRef[];
  data?: Record<string, unknown>;
  /** Credits to charge (≤ reserved). Defaults to the full reservation. */
  creditsUsed?: number;
  /** `needs_approval`: work paused for a human decision; reservation is released. */
  status?: "succeeded" | "needs_approval";
}

export interface JobContext<T extends JobType = JobType> {
  readonly job: Job;
  readonly type: T;
  readonly payload: JobPayload<T>;
  readonly workspaceId: string;
  readonly appId?: string;
  /** Full service container: storage, credits, usage, secrets, cfg. Use with metaClient(platform) etc. */
  readonly platform: Platform;
  readonly db: Db;
  readonly ws: WorkspaceDb;
  readonly log: Logger;
  /** Aborted when the user cancels or the lease is lost. Pass to providers/renderers. */
  readonly signal: AbortSignal;
  /** Actor string for writes made by this job: `job:<id>`. */
  readonly actor: string;
  /** The user who created the job (for permission-scoped follow-ups). */
  readonly requestedBy: string;
  progress(pct: number, stage: string, message?: string): Promise<void>;
  log_event(message: string, ref?: EntityRef): Promise<void>;
  throwIfCancelled(): void;
  /** Enqueue a follow-up job in the same workspace (chained pipelines). */
  enqueue<U extends JobType>(type: U, payload: z.input<(typeof JobPayloads)[U]>, opts?: Omit<CreateJobOptions, "actor" | "parentJobId">): Promise<Job>;
}

export type JobHandler<T extends JobType = JobType> = (ctx: JobContext<T>) => Promise<JobResult | void>;
export type HandlerRegistry = { [T in JobType]?: JobHandler<T> };

export interface CreateJobOptions {
  actor: string;
  appId?: string;
  /** Same key ⇒ same job (returns existing). Defaults to a fresh key. */
  idempotencyKey?: string;
  /** Credits to hold while the job runs. `amount` wins; otherwise estimated from `operation` + `params`. */
  credits?: { operation: string; amount?: number; params?: Record<string, unknown> };
  maxAttempts?: number;
  parentJobId?: string;
  agentRunId?: string;
  dependsOn?: string[];
  /** Create without dispatching (caller dispatches later). */
  deferDispatch?: boolean;
}

export interface Dispatcher {
  readonly mode: "inline" | "http" | "cloudtasks";
  dispatch(env: TaskEnvelope): Promise<void>;
}

const jobIdFor = (type: string, key: string) => `job_${createHash("sha256").update(`${type}:${key}`).digest("hex").slice(0, 24)}`;

// ---------------------------------------------------------------------------
// Job service (state machine over the `jobs` collection)
// ---------------------------------------------------------------------------

export class JobService {
  private dispatcher: Dispatcher | undefined;
  private eventSeq = 0;

  constructor(
    private readonly db: Db,
    private readonly credits: CreditService,
    private readonly log: Logger,
  ) {}

  setDispatcher(d: Dispatcher) {
    this.dispatcher = d;
  }
  get dispatchMode() {
    return this.dispatcher?.mode;
  }

  async create<T extends JobType>(workspaceId: string, type: T, payload: z.input<(typeof JobPayloads)[T]>, opts: CreateJobOptions): Promise<Job> {
    const parsed = (JobPayloads[type] as z.ZodTypeAny).parse(payload) as Record<string, unknown>;
    const key = opts.idempotencyKey ?? `auto:${newId("k")}`;
    const id = jobIdFor(type, key);
    const repo = this.db.ws(workspaceId).collection("jobs");
    const existing = await repo.get(id);
    if (existing) return existing;

    let reservation: Job["reservation"];
    if (opts.credits) {
      const amount = opts.credits.amount ?? this.credits.estimate(opts.credits.operation, { ...parsed, ...opts.credits.params }).credits;
      if (amount > 0) {
        const r = await this.credits.reserve(workspaceId, amount, { operation: opts.credits.operation, idempotencyKey: `job:${id}`, actor: opts.actor, jobId: id });
        reservation = { reservationId: r.reservationId, credits: r.credits };
      }
    }
    const now = nowIso();
    const { entity: job, created } = await repo.createIfAbsent(
      {
        id,
        type,
        appId: opts.appId ?? (typeof parsed.appId === "string" ? parsed.appId : undefined),
        status: "queued",
        idempotencyKey: key,
        payload: parsed,
        progress: { pct: 0, stage: "queued" },
        attempts: 0,
        maxAttempts: opts.maxAttempts ?? 3,
        cancelRequested: false,
        dependsOn: opts.dependsOn ?? [],
        parentJobId: opts.parentJobId,
        agentRunId: opts.agentRunId,
        reservation,
        queuedAt: now,
      },
      { actor: opts.actor },
    );
    if (!created) return job;
    await this.event(workspaceId, id, { kind: "status", status: "queued", message: `Queued ${type}` });
    if (!opts.deferDispatch) await this.dispatch(job);
    return job;
  }

  async dispatch(job: Job): Promise<void> {
    if (!this.dispatcher) throw new AppError("INTERNAL", "No job dispatcher configured");
    await this.dispatcher.dispatch({ workspaceId: job.workspaceId, jobId: job.id, type: job.type, attempt: job.attempts });
  }

  get(workspaceId: string, jobId: string) {
    return this.db.ws(workspaceId).collection("jobs").get(jobId);
  }

  /** Worker: take a lease. Returns null when the job should not run (done, busy, cancelled). */
  async claim(workspaceId: string, jobId: string, workerId: string, leaseMs: number): Promise<Job | null> {
    let releaseReservation: string | undefined;
    const result = await this.db.runTransaction(async (tx) => {
      const job = await tx.get(workspaceId, "jobs", jobId);
      if (!job) return null;
      if (TERMINAL_JOB_STATUSES.includes(job.status) || job.status === "needs_approval") return null;
      const now = Date.now();
      if (job.status === "running" && job.leaseOwner !== workerId && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > now) return null;
      if (job.cancelRequested) {
        tx.update(workspaceId, "jobs", jobId, { status: "cancelled", finishedAt: nowIso(), leaseOwner: undefined, leaseExpiresAt: undefined }, { actor: workerId });
        releaseReservation = job.reservation?.reservationId;
        return null;
      }
      if (job.attempts >= job.maxAttempts) {
        tx.update(
          workspaceId,
          "jobs",
          jobId,
          { status: "failed", finishedAt: nowIso(), error: job.error ?? { code: "MAX_ATTEMPTS", message: "Retry limit reached", retryable: false, userMessage: "This task kept failing. Please retry." } },
          { actor: workerId },
        );
        releaseReservation = job.reservation?.reservationId;
        return null;
      }
      return tx.update(
        workspaceId,
        "jobs",
        jobId,
        {
          status: "running",
          attempts: job.attempts + 1,
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now + leaseMs).toISOString(),
          startedAt: job.startedAt ?? nowIso(),
          progress: { ...job.progress, stage: job.progress.stage === "queued" ? "starting" : job.progress.stage },
        },
        { actor: workerId },
      );
    });
    if (releaseReservation) await this.credits.release(workspaceId, releaseReservation, { actor: workerId, reason: "Job cancelled or exhausted retries" });
    if (result) await this.event(workspaceId, jobId, { kind: "status", status: "running", message: `Attempt ${result.attempts}` });
    return result;
  }

  async heartbeat(workspaceId: string, jobId: string, workerId: string, leaseMs: number): Promise<{ cancelRequested: boolean }> {
    const job = await this.db.ws(workspaceId).collection("jobs").update(jobId, { leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(), leaseOwner: workerId }, { actor: workerId });
    return { cancelRequested: job.cancelRequested };
  }

  async progress(workspaceId: string, jobId: string, pct: number, stage: string, message?: string): Promise<void> {
    const progress = { pct: Math.max(0, Math.min(100, Math.round(pct))), stage: stage.slice(0, 80), message: message?.slice(0, 500) };
    await this.db.ws(workspaceId).collection("jobs").update(jobId, { progress }, { actor: "system" });
    await this.event(workspaceId, jobId, { kind: "progress", progress });
  }

  async complete(workspaceId: string, job: Job, result: JobResult, workerId: string): Promise<Job> {
    const needsApproval = result.status === "needs_approval";
    const charged = needsApproval ? 0 : Math.min(result.creditsUsed ?? job.reservation?.credits ?? 0, job.reservation?.credits ?? 0);
    const updated = await this.db.ws(workspaceId).collection("jobs").update(
      job.id,
      {
        status: needsApproval ? "needs_approval" : "succeeded",
        progress: { pct: 100, stage: needsApproval ? "awaiting approval" : "done" },
        output: { refs: result.refs ?? [], data: result.data },
        finishedAt: nowIso(),
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        creditsCharged: charged,
        error: undefined,
      },
      { actor: workerId },
    );
    if (job.reservation) {
      if (needsApproval) await this.credits.release(workspaceId, job.reservation.reservationId, { actor: workerId, reason: "Paused for approval" });
      else await this.credits.settle(workspaceId, job.reservation.reservationId, charged, { actor: workerId });
    }
    await this.event(workspaceId, job.id, { kind: "status", status: updated.status, message: needsApproval ? "Waiting for your approval" : "Completed" });
    return updated;
  }

  /** Record a failure. Returns "retry" when the job will be redelivered. */
  async fail(workspaceId: string, job: Job, err: AppError, workerId: string): Promise<"retry" | "failed"> {
    const info: ErrorInfo = err.toInfo();
    const willRetry = err.retryable && job.attempts < job.maxAttempts;
    await this.db.ws(workspaceId).collection("jobs").update(
      job.id,
      willRetry
        ? { status: "queued", error: info, leaseOwner: undefined, leaseExpiresAt: undefined, progress: { ...job.progress, stage: "retrying", message: info.userMessage } }
        : { status: "failed", error: info, finishedAt: nowIso(), leaseOwner: undefined, leaseExpiresAt: undefined },
      { actor: workerId },
    );
    if (!willRetry && job.reservation) await this.credits.release(workspaceId, job.reservation.reservationId, { actor: workerId, reason: `Job failed: ${info.code}` });
    await this.event(workspaceId, job.id, { kind: willRetry ? "log" : "error", status: willRetry ? "queued" : "failed", message: `${info.code}: ${info.userMessage ?? info.message}` });
    return willRetry ? "retry" : "failed";
  }

  async markCancelled(workspaceId: string, job: Job, actor: string): Promise<void> {
    await this.db.ws(workspaceId).collection("jobs").update(job.id, { status: "cancelled", finishedAt: nowIso(), leaseOwner: undefined, leaseExpiresAt: undefined }, { actor });
    if (job.reservation) await this.credits.release(workspaceId, job.reservation.reservationId, { actor, reason: "Job cancelled" });
    await this.event(workspaceId, job.id, { kind: "status", status: "cancelled", message: "Cancelled" });
  }

  /** User cancel: queued jobs stop immediately; running jobs are signalled. */
  async requestCancel(workspaceId: string, jobId: string, actor: string): Promise<Job> {
    const job = await this.db.ws(workspaceId).collection("jobs").getOrThrow(jobId);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) return job;
    if (job.status === "queued" || job.status === "needs_approval") {
      await this.markCancelled(workspaceId, job, actor);
      return (await this.get(workspaceId, jobId))!;
    }
    const updated = await this.db.ws(workspaceId).collection("jobs").update(jobId, { cancelRequested: true }, { actor });
    await this.event(workspaceId, jobId, { kind: "log", message: "Cancellation requested" });
    return updated;
  }

  /** Retry a failed/cancelled job as a fresh job (new reservation, audit link via parentJobId). */
  async retry(workspaceId: string, jobId: string, actor: string, credits?: CreateJobOptions["credits"]): Promise<Job> {
    const job = await this.db.ws(workspaceId).collection("jobs").getOrThrow(jobId);
    if (job.status !== "failed" && job.status !== "cancelled") throw new AppError("CONFLICT", `Job is ${job.status}; only failed or cancelled jobs can be retried`);
    return this.create(workspaceId, job.type, job.payload as never, {
      actor,
      appId: job.appId,
      parentJobId: job.id,
      agentRunId: job.agentRunId,
      idempotencyKey: `${job.idempotencyKey}:retry:${newId("r")}`,
      credits: credits ?? (job.reservation ? { operation: job.type, amount: job.reservation.credits } : undefined),
      maxAttempts: job.maxAttempts,
    });
  }

  async event(workspaceId: string, jobId: string, e: { kind: "status" | "progress" | "log" | "artifact" | "error"; status?: Job["status"]; progress?: Job["progress"]; message?: string; ref?: EntityRef }) {
    try {
      const seq = Date.now() * 1000 + (this.eventSeq++ % 1000);
      await this.db.ws(workspaceId).collection("jobEvents").create({ jobId, seq, ...e }, { actor: "system" });
    } catch (err) {
      this.log.warn({ err, jobId }, "failed to append job event");
    }
  }

  async listEvents(workspaceId: string, jobId: string, afterSeq = 0) {
    const page = await this.db.ws(workspaceId).collection("jobEvents").list({ where: [["jobId", "==", jobId]], orderBy: { field: "seq", dir: "asc" }, limit: 200 });
    return page.items.filter((e) => e.seq > afterSeq);
  }
}

// ---------------------------------------------------------------------------
// Runner (worker side)
// ---------------------------------------------------------------------------

export type RunOutcome = "succeeded" | "needs_approval" | "failed" | "retry" | "cancelled" | "skipped";

export class JobRunner {
  constructor(
    private readonly deps: { db: Db; jobs: JobService; log: Logger; platform: Platform },
    private readonly handlers: HandlerRegistry,
    readonly workerId: string,
    private readonly leaseMs = 15 * 60_000,
  ) {}

  canHandle(type: JobType) {
    return Boolean(this.handlers[type]);
  }

  async execute(env: TaskEnvelope): Promise<RunOutcome> {
    const { db, jobs, log: rootLog } = this.deps;
    const log = rootLog.child({ jobId: env.jobId, workspaceId: env.workspaceId, type: env.type });
    const job = await jobs.claim(env.workspaceId, env.jobId, this.workerId, this.leaseMs);
    if (!job) return "skipped";
    const handler = this.handlers[job.type] as JobHandler | undefined;
    if (!handler) {
      await jobs.fail(env.workspaceId, job, new AppError("INTERNAL", `No handler registered for ${job.type}`, { retryable: false }), this.workerId);
      return "failed";
    }

    const ac = new AbortController();
    const repo = db.ws(env.workspaceId).collection("jobs");
    const unwatch = repo.watch(job.id, (doc) => {
      if (doc?.cancelRequested && !ac.signal.aborted) ac.abort(new AppError("CANCELLED", "Cancelled by user"));
    });
    const hb = setInterval(() => {
      jobs.heartbeat(env.workspaceId, job.id, this.workerId, this.leaseMs).catch((err) => log.warn({ err }, "heartbeat failed"));
    }, Math.max(5_000, Math.floor(this.leaseMs / 3)));
    hb.unref?.();

    let lastProgressAt = 0;
    let lastStage = "";
    const ctx: JobContext = {
      job,
      type: job.type,
      payload: (JobPayloads[job.type] as z.ZodTypeAny).parse(job.payload) as never,
      workspaceId: env.workspaceId,
      appId: job.appId,
      platform: this.deps.platform,
      db,
      ws: db.ws(env.workspaceId),
      log,
      signal: ac.signal,
      actor: `job:${job.id}`,
      requestedBy: job.createdBy,
      progress: async (pct, stage, message) => {
        const now = Date.now();
        if (stage === lastStage && now - lastProgressAt < 1500 && pct < 100) return;
        lastProgressAt = now;
        lastStage = stage;
        await jobs.progress(env.workspaceId, job.id, pct, stage, message).catch((err) => log.warn({ err }, "progress update failed"));
      },
      log_event: (message, ref) => jobs.event(env.workspaceId, job.id, { kind: ref ? "artifact" : "log", message, ref }),
      throwIfCancelled: () => {
        if (ac.signal.aborted) throw new AppError("CANCELLED", "Cancelled by user");
      },
      enqueue: (type, payload, opts) =>
        jobs.create(env.workspaceId, type, payload, { ...opts, actor: job.createdBy, parentJobId: job.id, appId: opts?.appId ?? job.appId }),
    };

    try {
      const result = (await handler(ctx)) ?? {};
      if (ac.signal.aborted) {
        await jobs.markCancelled(env.workspaceId, job, this.workerId);
        return "cancelled";
      }
      const done = await jobs.complete(env.workspaceId, job, result, this.workerId);
      return done.status === "needs_approval" ? "needs_approval" : "succeeded";
    } catch (raw) {
      const err = toAppError(raw);
      if (ac.signal.aborted || err.code === "CANCELLED") {
        await jobs.markCancelled(env.workspaceId, job, this.workerId);
        return "cancelled";
      }
      log.error({ err: { code: err.code, message: err.message, stack: err.stack } }, "job failed");
      return jobs.fail(env.workspaceId, job, err, this.workerId);
    } finally {
      clearInterval(hb);
      unwatch();
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatchers
// ---------------------------------------------------------------------------

/** Runs jobs in-process (tests, single-process demos). Retries with exponential backoff. */
export class InlineDispatcher implements Dispatcher {
  readonly mode = "inline" as const;
  private runner: JobRunner | undefined;
  private readonly inflight = new Set<Promise<unknown>>();
  constructor(private readonly opts: { baseDelayMs?: number } = {}) {}
  setRunner(r: JobRunner) {
    this.runner = r;
  }
  async dispatch(env: TaskEnvelope): Promise<void> {
    const run = async (attempt: number): Promise<void> => {
      if (!this.runner) throw new Error("InlineDispatcher has no runner");
      const outcome = await this.runner.execute(env);
      if (outcome === "retry" && attempt < 8) {
        await new Promise((r) => setTimeout(r, (this.opts.baseDelayMs ?? 1000) * 2 ** attempt));
        await run(attempt + 1);
      }
    };
    const p = new Promise<void>((resolve) => setImmediate(resolve)).then(() => run(0)).catch(() => {});
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
  }
  /** Test helper: wait for all in-flight jobs (including chained ones). */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }
}

function workerUrlFor(cfg: Config, type: JobType): string {
  const pool = JOB_POOLS[type];
  const specific = pool === "agents" ? cfg.WORKER_URL_AGENTS : pool === "media" ? cfg.WORKER_URL_MEDIA : cfg.WORKER_URL_RENDER;
  return (specific ?? cfg.WORKER_URL).replace(/\/$/, "");
}

/** Local multi-process: POST to the worker; retries on 5xx / connection errors. */
export class HttpDispatcher implements Dispatcher {
  readonly mode = "http" as const;
  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}
  async dispatch(env: TaskEnvelope): Promise<void> {
    const url = `${workerUrlFor(this.cfg, env.type)}/tasks/execute`;
    const attempt = async (n: number): Promise<void> => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-worker-secret": this.cfg.WORKER_SHARED_SECRET },
          body: JSON.stringify(env),
        });
        if (res.status >= 500 && n < 6) throw new Error(`worker responded ${res.status}`);
      } catch (err) {
        if (n >= 6) {
          this.log.error({ err, env }, "job dispatch failed permanently");
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** n));
        return attempt(n + 1);
      }
    };
    // Fire and forget: the worker processes synchronously and the job doc carries the state.
    void attempt(0);
  }
}

/** Production: Cloud Tasks HTTP targets with OIDC auth to private Cloud Run workers. */
export class CloudTasksDispatcher implements Dispatcher {
  readonly mode = "cloudtasks" as const;
  private client: import("@google-cloud/tasks").CloudTasksClient | undefined;
  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}
  async dispatch(env: TaskEnvelope): Promise<void> {
    const { CloudTasksClient } = await import("@google-cloud/tasks");
    this.client ??= new CloudTasksClient();
    const pool = JOB_POOLS[env.type];
    const queue = pool === "agents" ? this.cfg.TASKS_QUEUE_AGENTS : pool === "media" ? this.cfg.TASKS_QUEUE_MEDIA : this.cfg.TASKS_QUEUE_RENDER;
    const project = this.cfg.FIREBASE_PROJECT_ID;
    if (!project) throw new AppError("PROVIDER_NOT_CONFIGURED", "FIREBASE_PROJECT_ID is required for Cloud Tasks");
    const parent = this.client.queuePath(project, this.cfg.TASKS_LOCATION, queue);
    const base = workerUrlFor(this.cfg, env.type);
    try {
      await this.client.createTask({
        parent,
        task: {
          name: `${parent}/tasks/${env.jobId}-a${env.attempt ?? 0}`,
          dispatchDeadline: { seconds: pool === "render" ? 1800 : 900 },
          httpRequest: {
            httpMethod: "POST",
            url: `${base}/tasks/execute`,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify(env)).toString("base64"),
            oidcToken: this.cfg.TASKS_INVOKER_SA ? { serviceAccountEmail: this.cfg.TASKS_INVOKER_SA, audience: base } : undefined,
          },
        },
      });
    } catch (err) {
      if ((err as { code?: number }).code === 6) return; // ALREADY_EXISTS: deduped
      this.log.error({ err, env }, "cloud tasks dispatch failed");
      throw new AppError("PROVIDER_UNAVAILABLE", "Could not queue background work", { cause: err });
    }
  }
}
