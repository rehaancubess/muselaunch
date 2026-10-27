import type { ModelUsageEvent } from "@muselaunch/contracts";
import { newEntityId, nowIso, type Db } from "@muselaunch/db";
import { z } from "zod";
import type { Config } from "./config";
import { AppError } from "./errors";
import type { Logger } from "./logger";
import type { ObjectStorage } from "./storage";

const SpendCounter = z.object({ usd: z.number().nonnegative(), calls: z.number().int().nonnegative(), updatedAt: z.string() });
type SpendCounter = z.infer<typeof SpendCounter>;

const dayKey = (d = new Date()) => `spend.day.${d.toISOString().slice(0, 10)}`;
const monthKey = (d = new Date()) => `spend.month.${d.toISOString().slice(0, 7)}`;

export type UsageInput = Omit<ModelUsageEvent, "id" | "workspaceId" | "createdAt" | "updatedAt" | "createdBy" | "traceAssetPath" | "cacheHit"> & {
  cacheHit?: boolean;
  actor?: string;
};

export interface TracePayload {
  request: unknown;
  response?: unknown;
  error?: unknown;
}

// Exact key names (snake, kebab and camelCase), so usage counters such as `input_tokens` stay visible.
const SECRET_KEYS =
  /^(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|x[-_]?api[-_]?key|token|bearer|(access|refresh|id|session|upload)[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|password|secret)$/i;

/** Deep-redact secrets and truncate very large strings (base64 media) in traces. */
export function redactForTrace(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth]";
  if (typeof value === "string") {
    if (value.length > 4000) return `${value.slice(0, 200)}…[${value.length} chars truncated]`;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactForTrace(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redactForTrace(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * Records every provider invocation (spec 4.12) and enforces spend ceilings
 * (global daily + per-workspace monthly) before costly calls.
 */
export class UsageMeter {
  private readonly hooks: ((workspaceId: string, event: ModelUsageEvent) => Promise<void>)[] = [];

  /** Observe every recorded usage event (module F ops counters). Errors are logged and swallowed. */
  addHook(fn: (workspaceId: string, event: ModelUsageEvent) => Promise<void>): () => void {
    this.hooks.push(fn);
    return () => {
      const i = this.hooks.indexOf(fn);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  constructor(
    private readonly db: Db,
    private readonly storage: ObjectStorage,
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  /** Throw SPEND_CEILING if this call would exceed a ceiling. Cheap: two doc reads. */
  async guard(workspaceId: string, estimatedUsd: number, workspaceCeilingUsd?: number): Promise<void> {
    const [day, month] = await Promise.all([this.db.global(dayKey(), SpendCounter).get(), this.db.ws(workspaceId).state(monthKey(), SpendCounter).get()]);
    const dayUsd = day?.usd ?? 0;
    const monthUsd = month?.usd ?? 0;
    if (dayUsd + estimatedUsd > this.cfg.GLOBAL_DAILY_SPEND_CEILING_USD) {
      this.log.warn({ dayUsd, estimatedUsd }, "global daily spend ceiling reached");
      throw new AppError("SPEND_CEILING", "Global daily spend ceiling reached", { details: { scope: "global" } });
    }
    const ceiling = workspaceCeilingUsd ?? this.cfg.WORKSPACE_MONTHLY_SPEND_CEILING_USD;
    if (monthUsd + estimatedUsd > ceiling) {
      throw new AppError("SPEND_CEILING", "Workspace monthly spend ceiling reached", {
        details: { scope: "workspace", monthUsd, ceiling },
        userMessage: "This workspace has reached its monthly AI spend safety limit.",
      });
    }
  }

  /** Persist the usage event, bump spend counters, and (optionally) write a redacted trace. */
  async record(workspaceId: string, input: UsageInput, trace?: TracePayload): Promise<ModelUsageEvent> {
    const id = newEntityId("modelUsage");
    let traceAssetPath: string | undefined;
    if (trace && this.cfg.TRACE_MODEL_IO) {
      traceAssetPath = `workspaces/${workspaceId}/traces/${nowIso().slice(0, 10)}/${id}.json`;
      try {
        const body = JSON.stringify({ id, at: nowIso(), provider: input.provider, model: input.model, operation: input.operation, task: input.task, ...(redactForTrace(trace) as object) }, null, 2);
        await this.storage.put(traceAssetPath, body, { contentType: "application/json" });
      } catch (err) {
        this.log.warn({ err }, "failed to write model trace");
        traceAssetPath = undefined;
      }
    }
    const { actor, ...rest } = input;
    const event = await this.db.ws(workspaceId).collection("modelUsage").create({ ...rest, id, cacheHit: input.cacheHit ?? false, traceAssetPath }, { actor: actor ?? "system" });
    if (input.costUsdEstimate > 0) {
      try {
        await this.db.runTransaction(async (tx) => {
          const day = await tx.getGlobal(dayKey(), SpendCounter);
          const month = await tx.getState(workspaceId, monthKey(), SpendCounter);
          const bump = (c: SpendCounter | null): SpendCounter => ({ usd: (c?.usd ?? 0) + input.costUsdEstimate, calls: (c?.calls ?? 0) + 1, updatedAt: nowIso() });
          tx.setGlobal(dayKey(), SpendCounter, bump(day));
          tx.setState(workspaceId, monthKey(), SpendCounter, bump(month));
        });
      } catch (err) {
        this.log.error({ err }, "failed to update spend counters");
      }
    }
    for (const h of this.hooks) {
      try {
        await h(workspaceId, event);
      } catch (err) {
        this.log.warn({ err }, "usage hook failed");
      }
    }
    return event;
  }

  async spendSummary(workspaceId: string): Promise<{ todayGlobalUsd: number; monthWorkspaceUsd: number; ceilings: { globalDaily: number; workspaceMonthly: number } }> {
    const [day, month] = await Promise.all([this.db.global(dayKey(), SpendCounter).get(), this.db.ws(workspaceId).state(monthKey(), SpendCounter).get()]);
    return {
      todayGlobalUsd: day?.usd ?? 0,
      monthWorkspaceUsd: month?.usd ?? 0,
      ceilings: { globalDaily: this.cfg.GLOBAL_DAILY_SPEND_CEILING_USD, workspaceMonthly: this.cfg.WORKSPACE_MONTHLY_SPEND_CEILING_USD },
    };
  }
}
