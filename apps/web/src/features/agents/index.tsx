"use client";
/**
 * Owner: module B (Intelligence). Agent run trace: plan, steps, tool calls, citations, budget and
 * per-call model usage — the evidence that real Meta models (and self-hosted Glimmer) did the work.
 * Data: GET /agent-runs/:runId → { run, steps, usage, tools }. Approvals: POST /agent-runs/:runId/approve|reject.
 */
import { Badge, Button, Notice, PageHeader, Section, Skeleton, StatusPill, statusKindOf, humanizeStatus, useToast } from "@muselaunch/ui";
import { Bot, Check, X } from "lucide-react";
import Link from "next/link";
import { QueryState } from "@/components/states";
import { api, errorMessage, wsPath } from "@/lib/api";
import { relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate, useMutation } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { BudgetMeters, PlanCard, StepTimeline, UsageTable } from "./run-parts";
import { formatUsd, modelLabel, RUN_KIND_LABEL, type AgentRunDetail } from "./types";

export interface AgentRunViewProps {
  runId: string;
}

function RunSkeleton() {
  return (
    <div className="space-y-6" aria-busy>
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-24 w-full" rounded="xl" />
      <Skeleton className="h-64 w-full" rounded="xl" />
    </div>
  );
}

function ApprovalPanel({ detail, workspaceId }: { detail: AgentRunDetail; workspaceId: string }) {
  const { can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const proposals = detail.run.plan?.tasks.filter((t) => t.proposedAction && t.status === "pending") ?? [];
  const credits = proposals.reduce((n, t) => n + (t.proposedAction?.estimatedCredits ?? 0), 0);
  const decide = useMutation({
    mutationFn: (approve: boolean) => api.post(wsPath(workspaceId, `/agent-runs/${detail.run.id}/${approve ? "approve" : "reject"}`), {}),
    onSuccess: async (_d, approve) => {
      toast.success(approve ? "Approved — follow-ups are running" : "Proposals declined", approve ? "Each follow-up reserves its own credits." : "Muse Wonder will remember this decision.");
      await invalidate(wsPath(workspaceId, "/agent-runs"), wsPath(workspaceId, "/apps"), wsPath(workspaceId, "/jobs"));
    },
    onError: (err) => toast.error("That didn't work", errorMessage(err)),
  });
  if (detail.run.status !== "needs_approval" || !proposals.length) return null;
  const allowed = can("content.write");
  return (
    <Notice
      tone="warning"
      title={`Muse Wonder proposes ${proposals.length} follow-up${proposals.length > 1 ? "s" : ""} (≈${credits} credits)`}
      action={
        allowed ? (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<X aria-hidden />} loading={decide.isPending && decide.variables === false} disabled={decide.isPending} onClick={() => decide.mutate(false)}>
              Decline
            </Button>
            <Button size="sm" icon={<Check aria-hidden />} loading={decide.isPending && decide.variables === true} disabled={decide.isPending} onClick={() => decide.mutate(true)}>
              Approve
            </Button>
          </div>
        ) : undefined
      }
    >
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {proposals.map((t) => (
          <li key={t.id}>
            {t.title} <span className="text-ink-3">(≈{t.proposedAction!.estimatedCredits} credits)</span>
          </li>
        ))}
      </ul>
      {!allowed ? <p className="mt-2">Ask an editor or owner to approve.</p> : null}
    </Notice>
  );
}

function RunBody({ detail, workspaceId }: { detail: AgentRunDetail; workspaceId: string }) {
  const { run, steps, usage } = detail;
  const totalCost = usage.reduce((n, u) => n + u.costUsdEstimate, 0);
  const models = [...new Set(usage.map((u) => u.model))];
  const memoryStep = steps.find((s) => s.kind === "message" && s.title.toLowerCase().includes("memory"));
  const app = run.appId ? routes.app(workspaceId, run.appId) : null;
  return (
    <div className="space-y-10">
      <PageHeader
        leading={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={statusKindOf(run.status)}>{humanizeStatus(run.status)}</StatusPill>
            <Badge tone="accent" icon={<Bot aria-hidden />}>
              {modelLabel(run.model)}
            </Badge>
            <span className="text-caption text-ink-3">
              {run.startedAt ? `Started ${relativeTime(run.startedAt)}` : "Queued"}
              {run.finishedAt ? ` · finished ${relativeTime(run.finishedAt)}` : ""}
            </span>
          </div>
        }
        title={RUN_KIND_LABEL[run.kind] ?? run.kind}
        description={run.goal}
        actions={app ? <Button asChild variant="outline" size="sm"><Link href={app.root}>Back to app</Link></Button> : undefined}
      />

      <ApprovalPanel detail={detail} workspaceId={workspaceId} />
      {run.error ? (
        <Notice tone="danger" title="This run stopped with an error">
          {run.error.userMessage ?? run.error.message}
        </Notice>
      ) : null}
      {steps.some((s) => s.kind === "budget_stop") ? (
        <Notice tone="warning" title="Stopped at its budget">
          The agent hit one of its hard limits and stopped early. Everything it saved before that is kept and sourced.
        </Notice>
      ) : null}

      <Section
        title="Budget"
        description={`${usage.length} metered model call${usage.length === 1 ? "" : "s"} · ${formatUsd(totalCost)} estimated · ${models.map(modelLabel).join(", ") || "no models yet"}${memoryStep ? ` · ${memoryStep.title.replace(/^Brand memory\s*/i, "memory ")}` : ""}`}
      >
        <BudgetMeters run={run} />
      </Section>

      {run.plan ? <PlanCard plan={run.plan} /> : null}

      <Section title="Steps" description="Each model call and tool call, in order. Saved research must cite sources the agent actually retrieved.">
        <StepTimeline steps={steps} tools={detail.tools ?? []} />
      </Section>

      <Section title="Model usage" description="Every provider call attributed to this run, with tokens, time and estimated cost.">
        <UsageTable usage={usage} />
      </Section>
    </div>
  );
}

export default function AgentRunView({ runId }: AgentRunViewProps) {
  const { workspaceId } = useWorkspace();
  const path = workspaceId ? wsPath(workspaceId, `/agent-runs/${runId}`) : null;
  const query = useApiQuery<AgentRunDetail>(path, {
    // Live while the agent works; stop polling once it settles.
    refetchInterval: (q) => {
      const s = q.state.data?.run.status;
      return s === "queued" || s === "running" ? 2500 : false;
    },
  });
  return (
    <QueryState query={query} feature="Agent run" skeleton={<RunSkeleton />}>
      {(detail) => <RunBody detail={detail} workspaceId={workspaceId} />}
    </QueryState>
  );
}

export { AgentRunsList } from "./runs-list";
