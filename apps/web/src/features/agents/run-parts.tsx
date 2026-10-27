"use client";
import type { AgentPlan, AgentRun, AgentStep, ModelUsageEvent, ToolInvocation } from "@muselaunch/contracts";
import { Badge, Card, ProgressBar, Section, SourceChip, cn } from "@muselaunch/ui";
import {
  BookmarkPlus,
  Brain,
  ChevronRight,
  CircleAlert,
  Flag,
  Gauge,
  Globe,
  Lightbulb,
  ListChecks,
  MessageSquare,
  Scale,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { formatMs, formatTokens, formatUsd, modelLabel, prettyJson, stepDurationMs } from "./types";

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

function Meter({ label, used, max, format }: { label: string; used: number; max: number; format: (n: number) => string }) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const tone = pct >= 100 ? "danger" : pct >= 80 ? "neutral" : "accent";
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-caption">
        <span className="text-ink-2">{label}</span>
        <span className="tabular text-ink">
          {format(used)} <span className="text-ink-3">/ {format(max)}</span>
        </span>
      </div>
      <ProgressBar value={pct} tone={tone} label={`${label}: ${format(used)} of ${format(max)}`} />
    </div>
  );
}

/** Usage against the run's hard AgentBudget (the agent stops — never crashes — at a limit). */
export function BudgetMeters({ run }: { run: AgentRun }) {
  const u = run.usage;
  const b = run.budget;
  return (
    <Card tone="well" padding="md" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <Meter label="Tool calls" used={u.toolCalls} max={b.maxToolCalls} format={(n) => String(n)} />
      <Meter label="Web searches" used={u.searchCalls} max={b.maxSearchCalls} format={(n) => String(n)} />
      <Meter label="Tokens" used={u.inputTokens + u.outputTokens} max={b.maxTokens} format={formatTokens} />
      <Meter label="Model cost" used={u.costUsd} max={b.maxCostUsd} format={formatUsd} />
      <Meter label="Time" used={u.wallMs} max={b.maxWallMs} format={formatMs} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const TASK_TONE: Record<string, "neutral" | "accent" | "success" | "danger" | "warning" | "outline"> = {
  pending: "outline",
  running: "accent",
  done: "success",
  failed: "danger",
  skipped: "neutral",
};

function PlanList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1.5">
      <h4 className="text-footnote font-semibold uppercase tracking-wide text-ink-3">{title}</h4>
      <ul className="space-y-1 text-body-sm text-ink-2">
        {items.map((x) => (
          <li key={x} className="flex gap-2">
            <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />
            <span className="text-pretty">{x}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Muse Wonder's saved plan: goal, hypotheses, deliverables, measurement and bounded tasks. */
export function PlanCard({ plan }: { plan: AgentPlan }) {
  return (
    <Section title="Plan" description="What Muse Wonder set out to do. Proposed follow-ups only run after your approval.">
      <Card padding="md" className="space-y-5">
        <p className="text-body text-ink text-pretty">{plan.goal}</p>
        {plan.audience ? <p className="text-body-sm text-ink-2">Audience: {plan.audience}</p> : null}
        <div className="grid gap-5 md:grid-cols-3">
          <PlanList title="Hypotheses" items={plan.hypotheses} />
          <PlanList title="Deliverables" items={plan.deliverables} />
          <PlanList title="Measurement" items={plan.measurement} />
        </div>
        {plan.timeline ? <p className="text-body-sm text-ink-2">Timeline: {plan.timeline}</p> : null}
        {plan.tasks.length ? (
          <ol className="divide-y divide-line rounded-lg border border-line">
            {plan.tasks.map((t) => (
              <li key={t.id} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-body-sm font-medium text-ink">{t.title}</p>
                  <p className="line-clamp-2 text-caption text-ink-2">{t.objective}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {t.proposedAction ? <Badge tone="warning">≈{t.proposedAction.estimatedCredits} credits · needs approval</Badge> : null}
                  <Badge tone="neutral">{t.role.replace(/_/g, " ")}</Badge>
                  <Badge tone={TASK_TONE[t.status] ?? "neutral"}>{t.status}</Badge>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Steps timeline
// ---------------------------------------------------------------------------

const TOOL_ICON: Record<string, ReactNode> = {
  search_web: <Search aria-hidden />,
  fetch_page: <Globe aria-hidden />,
  set_plan: <ListChecks aria-hidden />,
  set_strategy: <ListChecks aria-hidden />,
  finish: <Flag aria-hidden />,
};

function stepIcon(step: AgentStep): ReactNode {
  switch (step.kind) {
    case "model_call":
      return <Sparkles aria-hidden />;
    case "tool_call": {
      const name = step.title.split(" ")[0] ?? "";
      if (TOOL_ICON[name]) return TOOL_ICON[name];
      if (name.startsWith("save_")) return <BookmarkPlus aria-hidden />;
      if (name.startsWith("propose_")) return <Lightbulb aria-hidden />;
      return <Wrench aria-hidden />;
    }
    case "plan":
      return <ListChecks aria-hidden />;
    case "decision":
      return <Scale aria-hidden />;
    case "approval_request":
      return <ShieldCheck aria-hidden />;
    case "message":
      return step.title.toLowerCase().includes("memory") ? <Brain aria-hidden /> : <MessageSquare aria-hidden />;
    case "budget_stop":
      return <Gauge aria-hidden />;
    default:
      return <Wrench aria-hidden />;
  }
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-1 text-caption font-medium text-accent-ink hover:underline">
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

function Payload({ value }: { value: unknown }) {
  return <pre className="max-h-80 overflow-auto rounded-md bg-mist p-3 font-mono text-caption whitespace-pre-wrap break-words text-ink-2">{prettyJson(value)}</pre>;
}

/** Every step the agent took, with model, duration, tool arguments/results and citations. */
export function StepTimeline({ steps, tools }: { steps: AgentStep[]; tools: ToolInvocation[] }) {
  const byStep = new Map(tools.map((t) => [t.stepId, t]));
  if (!steps.length) return <p className="text-body-sm text-ink-2">No steps recorded yet.</p>;
  return (
    <ol className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-line">
      {steps.map((s) => {
        const tool = byStep.get(s.id);
        const dur = stepDurationMs(s);
        const failed = s.status === "failed";
        const stop = s.kind === "budget_stop";
        return (
          <li key={s.id} className="relative flex gap-3">
            <span
              className={cn(
                "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-surface [&_svg]:size-4",
                failed ? "border-danger/40 text-danger" : stop ? "border-warning/40 text-warning" : s.kind === "model_call" ? "border-accent/30 text-accent-ink" : "border-line text-ink-2",
              )}
            >
              {stepIcon(s)}
            </span>
            <Card padding="sm" className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-body-sm font-medium text-ink">{s.title}</span>
                {s.model ? <Badge tone="accent">{modelLabel(s.model)}</Badge> : null}
                {failed ? <Badge tone="danger">{s.kind === "tool_call" ? "rejected" : "failed"}</Badge> : null}
                {stop ? <Badge tone="warning">budget stop</Badge> : null}
                <span className="ml-auto text-caption tabular text-ink-3">
                  #{s.index + 1}
                  {dur !== undefined ? ` · ${formatMs(dur)}` : ""}
                </span>
              </div>
              {s.outputSummary && s.kind !== "tool_call" ? <p className="line-clamp-4 text-caption text-ink-2 whitespace-pre-line">{s.outputSummary}</p> : null}
              {s.citations.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {s.citations.slice(0, 8).map((c, i) => (
                    <SourceChip key={`${c.url ?? c.title}-${i}`} source={c} />
                  ))}
                  {s.citations.length > 8 ? <Badge tone="outline">+{s.citations.length - 8} more</Badge> : null}
                </div>
              ) : null}
              {tool ? (
                <div className="flex flex-wrap gap-4">
                  <Disclosure label="Arguments">
                    <Payload value={tool.args} />
                  </Disclosure>
                  <Disclosure label={tool.error ? "Error" : "Result"}>
                    <Payload value={tool.error ?? tool.result} />
                  </Disclosure>
                </div>
              ) : s.inputSummary || (s.kind === "tool_call" && s.outputSummary) ? (
                <Disclosure label="Details">
                  <Payload value={{ input: s.inputSummary, output: s.outputSummary }} />
                </Disclosure>
              ) : null}
            </Card>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Model usage (every metered provider call attributed to this run)
// ---------------------------------------------------------------------------

export function UsageTable({ usage }: { usage: ModelUsageEvent[] }) {
  if (!usage.length) return <p className="text-body-sm text-ink-2">No model calls recorded for this run.</p>;
  const rows = [...usage].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const totals = new Map<string, { calls: number; cost: number; input: number; output: number }>();
  for (const u of rows) {
    const t = totals.get(u.model) ?? { calls: 0, cost: 0, input: 0, output: 0 };
    t.calls++;
    t.cost += u.costUsdEstimate;
    t.input += u.inputTokens ?? 0;
    t.output += u.outputTokens ?? 0;
    totals.set(u.model, t);
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[...totals.entries()].map(([model, t]) => (
          <Card key={model} tone="well" padding="sm" className="min-w-44 space-y-0.5">
            <p className="text-caption text-ink-3">{model}</p>
            <p className="text-body-sm font-medium text-ink">
              {modelLabel(model)} · {t.calls} call{t.calls === 1 ? "" : "s"}
            </p>
            <p className="text-caption tabular text-ink-2">
              {formatTokens(t.input)} in · {formatTokens(t.output)} out · {formatUsd(t.cost)}
            </p>
          </Card>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[640px] text-left text-caption">
          <thead className="bg-mist text-ink-3">
            <tr>
              <th className="px-3 py-2 font-medium">Task</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 text-right font-medium">Input</th>
              <th className="px-3 py-2 text-right font-medium">Cached</th>
              <th className="px-3 py-2 text-right font-medium">Output</th>
              <th className="px-3 py-2 text-right font-medium">Time</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((u) => (
              <tr key={u.id} className={cn(u.status === "error" && "bg-danger-soft/40")}>
                <td className="px-3 py-2 text-ink">
                  <span className="inline-flex items-center gap-1.5">
                    {u.status === "error" ? <CircleAlert aria-hidden className="size-3.5 text-danger" /> : null}
                    {u.task}
                    {u.errorCode ? <span className="text-danger">({u.errorCode})</span> : null}
                  </span>
                </td>
                <td className="px-3 py-2 text-ink-2">
                  <span className="inline-flex items-center gap-1.5">
                    {u.dataMode === "self_hosted" ? <Server aria-hidden className="size-3.5" /> : null}
                    {u.model}
                    {u.dataMode === "self_hosted" ? <span className="text-ink-3">self-hosted</span> : null}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular">{formatTokens(u.inputTokens)}</td>
                <td className="px-3 py-2 text-right tabular text-ink-3">{formatTokens(u.cachedTokens)}</td>
                <td className="px-3 py-2 text-right tabular">{formatTokens(u.outputTokens)}</td>
                <td className="px-3 py-2 text-right tabular">{formatMs(u.runtimeMs)}</td>
                <td className="px-3 py-2 text-right tabular text-ink">{formatUsd(u.costUsdEstimate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-caption text-ink-3">Costs are estimates from token counts and published prices; self-hosted Muse Glimmer calls have no per-token charge.</p>
    </div>
  );
}
