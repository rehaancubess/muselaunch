"use client";
import type { Experiment, GrowthRecommendation, Job } from "@muselaunch/contracts";
import { Badge, Button, Card, CostEstimate, EmptyState, Input, JobProgress, Section, useToast } from "@muselaunch/ui";
import { Brain, Lightbulb, Sparkles } from "lucide-react";
import { useState } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { fetchEstimate } from "./experiments";

const KIND_LABEL: Record<GrowthRecommendation["kind"], string> = {
  next_experiment: "Next experiment",
  content: "Content",
  channel: "Channel",
  audience: "Audience",
  creator: "Creator",
  stop_doing: "Stop doing",
  other: "Other",
};

const modelName = (id?: string) => (!id ? null : /wonder/i.test(id) ? "Muse Wonder" : /spark/i.test(id) ? "Muse Spark" : id);

export function RecommendationsView({ workspaceId, appId, onOpenExperiment }: { workspaceId: string; appId: string; onOpenExperiment: (id: string) => void }) {
  const toast = useToast();
  const { can, workspace } = useWorkspace();
  // Autopilot on: new measured data (sync / CSV import) generates recommendations on its own; keep the list fresh.
  const auto = workspace?.settings.autopilot?.enabled ?? true;
  const recs = useApiQuery<Page<GrowthRecommendation>>(wsPath(workspaceId, `/apps/${appId}/recommendations`), { refetchInterval: auto ? 20_000 : false });
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(workspaceId, jobId, { onSettled: () => void recs.refetch() });
  const running = Boolean(jobId && job.job && (job.job.status === "queued" || job.job.status === "running"));

  const generate = async () => {
    try {
      const res = await api.post<{ job: Job }>(wsPath(workspaceId, `/apps/${appId}/recommendations/generate`), {}, { idempotencyKey: newIdempotencyKey("rec") });
      setJobId(res.job.id);
    } catch (err) {
      toast.error("Couldn’t start", errorMessage(err));
    }
  };
  const accept = async (r: GrowthRecommendation) => {
    try {
      const res = await api.post<{ recommendation: GrowthRecommendation; experiment: Experiment | null }>(wsPath(workspaceId, `/recommendations/${r.id}/accept`));
      void recs.refetch();
      if (res.experiment) {
        toast.success("Experiment created", res.experiment.title);
        onOpenExperiment(res.experiment.id);
      } else toast.success("Accepted", "Saved to your brand memory.");
    } catch (err) {
      toast.error("Couldn’t accept", errorMessage(err));
    }
  };
  const dismiss = async (r: GrowthRecommendation, reason: string) => {
    try {
      await api.post(wsPath(workspaceId, `/recommendations/${r.id}/dismiss`), { reason: reason || undefined });
      void recs.refetch();
    } catch (err) {
      toast.error("Couldn’t dismiss", errorMessage(err));
    }
  };

  return (
    <Section
      title="What to try next"
      description={`Muse Spark reads your measured results; Muse Wonder proposes the next experiment, using what you've decided before. Recommendations never predict results.${auto ? " Autopilot is on: new results you sync or import generate fresh recommendations automatically." : ""}`}
      actions={
        can("analytics.write") ? (
          <div className="flex items-center gap-3">
            <CostEstimate operation="recommendations.generate" fetchEstimate={fetchEstimate(workspaceId)} />
            <Button size="sm" icon={<Sparkles aria-hidden />} onClick={() => void generate()} loading={running}>
              Generate
            </Button>
          </div>
        ) : null
      }
    >
      {jobId ? <JobProgress job={job.job} title="Generating recommendations" onRetry={() => void job.retry()} retrying={job.retrying} /> : null}
      <QueryState query={recs} feature="Recommendations">
        {(data) => {
          const open = data.items.filter((r) => r.status === "new");
          const past = data.items.filter((r) => r.status !== "new");
          if (!data.items.length)
            return (
              <Card tone="well">
                <EmptyState icon={<Lightbulb aria-hidden />} title="No recommendations yet" description="Generate them once you have some measured data, or to plan your first experiment." />
              </Card>
            );
          return (
            <div className="space-y-4">
              {open.map((r) => (
                <RecommendationCard key={r.id} r={r} canAct={can("analytics.write")} onAccept={() => void accept(r)} onDismiss={(reason) => void dismiss(r, reason)} />
              ))}
              {past.length ? (
                <details className="text-body-sm">
                  <summary className="cursor-pointer text-footnote text-ink-2">Earlier ({past.length})</summary>
                  <ul className="mt-2 space-y-1 text-footnote text-ink-2">
                    {past.map((r) => (
                      <li key={r.id}>
                        <span className="font-medium text-ink">{r.title}</span> — {r.status}
                        {r.dismissReason ? ` (${r.dismissReason})` : ""}
                        {r.experimentId ? (
                          <button type="button" className="ml-2 text-accent hover:underline" onClick={() => onOpenExperiment(r.experimentId!)}>
                            Open experiment
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          );
        }}
      </QueryState>
    </Section>
  );
}

function RecommendationCard({ r, canAct, onAccept, onDismiss }: { r: GrowthRecommendation; canAct: boolean; onAccept: () => void; onDismiss: (reason: string) => void }) {
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const evidence = r.basedOn.observationIds.length + r.basedOn.resultIds.length;
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{KIND_LABEL[r.kind]}</Badge>
        <Badge tone={r.confidence === "low" ? "warning" : "neutral"}>{r.confidence} confidence</Badge>
        {r.usedMemory ? (
          <Badge icon={<Brain aria-hidden />} title="Your remembered preferences or lessons changed this recommendation">
            Used brand memory
          </Badge>
        ) : null}
      </div>
      <p className="text-headline font-semibold">{r.title}</p>
      <p className="whitespace-pre-line text-body-sm text-ink-2">{r.rationale}</p>
      {r.proposedExperiment ? (
        <div className="rounded-lg bg-mist px-4 py-3 text-body-sm">
          <p className="font-medium">{r.proposedExperiment.title}</p>
          <p className="text-ink-2">{r.proposedExperiment.hypothesis}</p>
          <p className="mt-1 text-footnote text-ink-2">
            Measure: {r.proposedExperiment.primaryMetric.replace(/_/g, " ")} · Variants: {r.proposedExperiment.variants.join(" vs ")}
          </p>
        </div>
      ) : null}
      <p className="text-footnote text-ink-3">
        Based on {evidence ? `${r.basedOn.observationIds.length} measured observations and ${r.basedOn.resultIds.length} experiment results` : "no measured results yet"}
        {r.basedOn.preferenceIds.length ? `, ${r.basedOn.preferenceIds.length} memory item${r.basedOn.preferenceIds.length > 1 ? "s" : ""}` : ""}
        {r.models ? ` · ${[modelName(r.models.interpret) && `read by ${modelName(r.models.interpret)}`, modelName(r.models.propose) && `proposed by ${modelName(r.models.propose)}`].filter(Boolean).join(", ")}` : ""}
      </p>
      {canAct ? (
        dismissing ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-72">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not? (helps future recommendations)" aria-label="Reason for dismissing" />
            </div>
            <Button size="sm" variant="outline" onClick={() => onDismiss(reason)}>
              Dismiss
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" onClick={onAccept}>
              {r.proposedExperiment ? "Accept and create experiment" : "Accept"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissing(true)}>
              Dismiss
            </Button>
          </div>
        )
      ) : null}
    </Card>
  );
}
