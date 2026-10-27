import { AgentBudget, type AgentKind, type AgentPlan, type AgentRun, type AgentStep, type AgentUsage, type EntityRef, type ErrorInfo, type SourceRef } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import type { JobContext } from "@muselaunch/platform";
import type { CallContext, LlmTextResult } from "@muselaunch/providers";
import { brief, clip, nowIso } from "./util";

type StepKind = AgentStep["kind"];

/**
 * Records an AgentRun with its steps and tool invocations, tracks usage against the run's
 * AgentBudget, and reports (never crashes on) budget exhaustion. One recorder per job attempt;
 * the run doc is created idempotently so retries continue the same run.
 */
export class RunRecorder {
  readonly usage: AgentUsage;
  readonly budget: AgentBudget;
  private index = 0;
  private readonly startedMs: number;

  private constructor(
    private readonly ws: WorkspaceDb,
    public run: AgentRun,
    private readonly actor: string,
    private readonly base: Omit<CallContext, "task">,
    startIndex: number,
  ) {
    this.usage = { ...run.usage };
    this.budget = run.budget;
    this.index = startIndex;
    this.startedMs = Date.now() - run.usage.wallMs;
  }

  get id() {
    return this.run.id;
  }

  static async start(
    ctx: JobContext,
    input: { id?: string; kind: AgentKind; model: string; goal: string; budget?: Partial<AgentBudget>; parentRunId?: string; appId?: string },
  ): Promise<RunRecorder> {
    const ws = ctx.ws;
    const repo = ws.collection("agentRuns");
    const id = input.id ?? repo.newId();
    const existing = await repo.get(id);
    let run: AgentRun;
    if (existing) {
      run = await repo.update(id, { status: "running", jobId: ctx.job.id, error: undefined, startedAt: existing.startedAt ?? nowIso() }, { actor: ctx.actor });
    } else {
      run = await repo.create(
        {
          id,
          appId: input.appId ?? ctx.appId,
          kind: input.kind,
          model: input.model,
          status: "running",
          goal: clip(input.goal, 4000),
          budget: AgentBudget.parse(input.budget ?? {}),
          parentRunId: input.parentRunId,
          jobId: ctx.job.id,
          startedAt: nowIso(),
        },
        { actor: ctx.actor },
      );
    }
    const steps = await ws.collection("agentSteps").list({ where: [["runId", "==", id]], orderBy: { field: "index", dir: "asc" }, limit: 200 });
    const last = steps.items[steps.items.length - 1];
    return new RunRecorder(ws, run, ctx.actor, { workspaceId: ctx.workspaceId, appId: input.appId ?? ctx.appId, jobId: ctx.job.id, agentRunId: id, actor: ctx.actor, signal: ctx.signal }, last ? last.index + 1 : 0);
  }

  callCtx(task: string): CallContext {
    return { ...this.base, task };
  }

  /** Add a model call's metered usage to the run totals. */
  addModelUsage(r: Pick<LlmTextResult, "usage" | "costUsd" | "searchCalls">): void {
    this.usage.inputTokens += r.usage.inputTokens;
    this.usage.outputTokens += r.usage.outputTokens;
    this.usage.costUsd += r.costUsd;
    this.usage.searchCalls += r.searchCalls;
  }

  /** Returns the exhausted limit, or null when the run may continue. */
  budgetStop(next: { toolCalls?: number; searchCalls?: number } = {}): string | null {
    const b = this.budget;
    const u = this.usage;
    if (u.toolCalls + (next.toolCalls ?? 0) > b.maxToolCalls) return `tool call limit (${b.maxToolCalls})`;
    if (u.searchCalls + (next.searchCalls ?? 0) > b.maxSearchCalls) return `search limit (${b.maxSearchCalls})`;
    if (u.inputTokens + u.outputTokens >= b.maxTokens) return `token limit (${b.maxTokens})`;
    if (u.costUsd >= b.maxCostUsd) return `cost limit ($${b.maxCostUsd})`;
    if (Date.now() - this.startedMs >= b.maxWallMs) return `time limit (${Math.round(b.maxWallMs / 1000)}s)`;
    return null;
  }

  async step(input: {
    kind: StepKind;
    title: string;
    status?: AgentStep["status"];
    model?: string;
    input?: unknown;
    output?: unknown;
    citations?: SourceRef[];
    startedAt?: string;
  }): Promise<AgentStep> {
    const started = input.startedAt ?? nowIso();
    return this.ws.collection("agentSteps").create(
      {
        runId: this.run.id,
        index: this.index++,
        kind: input.kind,
        title: clip(input.title, 300),
        status: input.status ?? "succeeded",
        model: input.model,
        inputSummary: input.input === undefined ? undefined : brief(input.input, 4000),
        outputSummary: input.output === undefined ? undefined : brief(input.output, 8000),
        citations: (input.citations ?? []).slice(0, 30),
        startedAt: started,
        endedAt: nowIso(),
      },
      { actor: this.actor },
    );
  }

  /** Record a model call as a step and fold its usage into the run. */
  async modelStep(title: string, r: LlmTextResult, input?: unknown, output?: unknown): Promise<AgentStep> {
    this.addModelUsage(r);
    return this.step({ kind: "model_call", title, model: r.model, input, output: output ?? r.text, citations: r.citations });
  }

  async tool(stepId: string, tool: string, args: Record<string, unknown>, outcome: { result?: unknown; error?: ErrorInfo }, durationMs: number): Promise<void> {
    this.usage.toolCalls++;
    await this.ws.collection("toolInvocations").create(
      { runId: this.run.id, stepId, tool, args: trimArgs(args), result: outcome.result === undefined ? undefined : JSON.parse(safeJson(outcome.result)), error: outcome.error, durationMs: Math.max(0, Math.round(durationMs)) },
      { actor: this.actor },
    );
  }

  async budgetStopStep(reason: string): Promise<void> {
    await this.step({ kind: "budget_stop", title: `Stopped: ${reason}`, status: "skipped", output: { usage: this.usage, budget: this.budget } });
  }

  async save(patch: { plan?: AgentPlan; outputRefs?: EntityRef[]; memoryRefs?: string[] }): Promise<void> {
    this.usage.wallMs = Date.now() - this.startedMs;
    this.run = await this.ws.collection("agentRuns").update(this.run.id, { ...patch, usage: this.usage }, { actor: this.actor });
  }

  async finish(status: AgentRun["status"], patch: { plan?: AgentPlan; outputRefs?: EntityRef[]; memoryRefs?: string[]; error?: ErrorInfo; pendingApprovalId?: string } = {}): Promise<AgentRun> {
    this.usage.wallMs = Date.now() - this.startedMs;
    this.run = await this.ws.collection("agentRuns").update(this.run.id, { ...patch, status, usage: this.usage, finishedAt: nowIso() }, { actor: this.actor });
    return this.run;
  }
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 6000 ? JSON.stringify({ truncated: s.slice(0, 5900) }) : s;
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function trimArgs(args: Record<string, unknown>): Record<string, unknown> {
  const s = safeJson(args);
  return s.length > 4000 ? { truncated: s.slice(0, 3900) } : (JSON.parse(s) as Record<string, unknown>);
}
