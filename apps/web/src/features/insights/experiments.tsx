"use client";
import type { Experiment, ExperimentResult, Job, MetricName as MetricNameT } from "@muselaunch/contracts";
import { MetricName } from "@muselaunch/contracts";
import { Badge, Button, Card, CostEstimate, Dialog, EmptyState, Field, Input, JobProgress, Notice, Section, Select, Sheet, StatusPill, Textarea, statusKindOf, useToast, type EstimateResult } from "@muselaunch/ui";
import { FlaskConical, Plus } from "lucide-react";
import { useState } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { ConfidencePill, IdChips, fmtDate } from "./shared";

const METRIC_OPTIONS = MetricName.options.map((m) => ({ value: m, label: m.replace(/_/g, " ") }));
/** A test's status in plain words. */
const TEST_STATUS: Record<Experiment["status"], string> = { proposed: "Not started", running: "Running", analyzing: "Analysing", concluded: "Finished", abandoned: "Stopped" };
export const fetchEstimate = (workspaceId: string) => (req: { operation: string; params: Record<string, unknown> }) => api.post<EstimateResult>(wsPath(workspaceId, "/estimate"), req);

export function ExperimentsView({ workspaceId, appId, openId, onOpen }: { workspaceId: string; appId: string; openId: string | null; onOpen: (id: string | null) => void }) {
  const { can } = useWorkspace();
  const list = useApiQuery<Page<Experiment>>(wsPath(workspaceId, `/apps/${appId}/experiments`));
  const [creating, setCreating] = useState(false);
  return (
    <Section
      title="Tests"
      description="What you're testing, the measured results, and what MuseLaunch can and can't conclude from them."
      actions={
        can("analytics.write") ? (
          <Button size="sm" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            New test
          </Button>
        ) : null
      }
    >
      <QueryState query={list} feature="Tests">
        {(data) =>
          data.items.length ? (
            <Card padding="none">
              <ul className="divide-y divide-line">
                {data.items.map((e) => (
                  <li key={e.id}>
                    <button type="button" onClick={() => onOpen(e.id)} className="flex w-full flex-col gap-1 px-5 py-3.5 text-left hover:bg-mist/60 focus-visible:outline-none focus-visible:shadow-focus sm:flex-row sm:items-center sm:justify-between">
                      <span className="min-w-0">
                        <span className="block truncate text-body-sm font-medium">{e.title}</span>
                        <span className="block truncate text-footnote text-ink-2">
                          {e.variants.length} versions · measured by {e.primaryMetric.replace(/_/g, " ")}
                          {e.proposedByRecommendationId ? " · from a recommendation" : ""}
                        </span>
                      </span>
                      <StatusPill status={statusKindOf(e.status === "concluded" ? "succeeded" : e.status === "abandoned" ? "cancelled" : e.status === "running" ? "running" : "queued")}>{TEST_STATUS[e.status] ?? e.status}</StatusPill>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          ) : (
            <Card tone="well">
              <EmptyState icon={<FlaskConical aria-hidden />} title="No tests yet" description="Start one yourself, or accept a recommendation in What to try next to turn it into a test." />
            </Card>
          )
        }
      </QueryState>
      <CreateExperimentDialog workspaceId={workspaceId} appId={appId} open={creating} onOpenChange={setCreating} onCreated={(id) => {
        setCreating(false);
        void list.refetch();
        onOpen(id);
      }} />
      <ExperimentSheet workspaceId={workspaceId} experimentId={openId} onClose={() => onOpen(null)} onChanged={() => void list.refetch()} />
    </Section>
  );
}

function CreateExperimentDialog({ workspaceId, appId, open, onOpenChange, onCreated }: { workspaceId: string; appId: string; open: boolean; onOpenChange: (v: boolean) => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ title: "", hypothesis: "", primaryMetric: "clicks", a: "Current version", b: "New version" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ experiment: Experiment }>(wsPath(workspaceId, `/apps/${appId}/experiments`), {
        title: f.title,
        hypothesis: f.hypothesis,
        primaryMetric: f.primaryMetric,
        variants: [
          { key: "a", label: f.a, isControl: true },
          { key: "b", label: f.b },
        ],
        status: "running",
      });
      onCreated(res.experiment.id);
    } catch (err) {
      toast.error("Couldn’t create the test", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New test"
      description="Two versions, one thing to measure. Add the numbers for each version afterwards."
      footer={
        <Button onClick={() => void submit()} loading={busy} disabled={!f.title.trim() || !f.hypothesis.trim() || !f.a.trim() || !f.b.trim()}>
          Create
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Title">{(ids) => <Input id={ids.id} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Question hook vs demo-first" />}</Field>
        <Field label="What we’re testing" hint="What you expect to happen, e.g. a question in the first line gets more clicks.">{(ids) => <Textarea id={ids.id} rows={2} value={f.hypothesis} onChange={(e) => setF({ ...f, hypothesis: e.target.value })} />}</Field>
        <Field label="Measured by">{(ids) => <Select id={ids.id} options={METRIC_OPTIONS} value={f.primaryMetric} onChange={(e) => setF({ ...f, primaryMetric: e.target.value })} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Version A (the one to beat)">{(ids) => <Input id={ids.id} value={f.a} onChange={(e) => setF({ ...f, a: e.target.value })} />}</Field>
          <Field label="Version B">{(ids) => <Input id={ids.id} value={f.b} onChange={(e) => setF({ ...f, b: e.target.value })} />}</Field>
        </div>
      </div>
    </Dialog>
  );
}

type ExperimentDetail = { experiment: Experiment; results: ExperimentResult[] };

function ExperimentSheet({ workspaceId, experimentId, onClose, onChanged }: { workspaceId: string; experimentId: string | null; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const detail = useApiQuery<ExperimentDetail>(experimentId ? wsPath(workspaceId, `/experiments/${experimentId}`) : null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [decision, setDecision] = useState("");
  const job = useJob(workspaceId, jobId, { onSettled: () => void detail.refetch() });
  const exp = detail.data?.experiment;
  const result = detail.data?.results[0];

  const analyze = async () => {
    try {
      const res = await api.post<{ job: Job }>(wsPath(workspaceId, `/experiments/${experimentId}/analyze`), {}, { idempotencyKey: newIdempotencyKey("exa") });
      setJobId(res.job.id);
    } catch (err) {
      toast.error("Analysis didn’t start", errorMessage(err));
    }
  };
  const patch = async (body: Record<string, unknown>) => {
    try {
      await api.patch(wsPath(workspaceId, `/experiments/${experimentId}`), body);
      void detail.refetch();
      onChanged();
    } catch (err) {
      toast.error("Couldn’t update", errorMessage(err));
    }
  };

  return (
    <Sheet open={Boolean(experimentId)} onOpenChange={(o) => !o && onClose()} title={exp?.title ?? "Test"} description={exp?.hypothesis} width="max-w-2xl">
      {exp ? (
        <div className="space-y-6 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={statusKindOf(exp.status === "concluded" ? "succeeded" : exp.status === "abandoned" ? "cancelled" : exp.status === "running" ? "running" : "queued")}>{TEST_STATUS[exp.status] ?? exp.status}</StatusPill>
            <Badge tone="outline">Measured by {exp.primaryMetric.replace(/_/g, " ")}</Badge>
            {exp.variants.map((v) => (
              <Badge key={v.key}>
                {v.key.toUpperCase()}: {v.label}
                {v.isControl ? " (the one to beat)" : ""}
              </Badge>
            ))}
          </div>

          {can("analytics.write") && exp.status !== "concluded" && exp.status !== "abandoned" ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void analyze()} disabled={Boolean(jobId && job.job && !["succeeded", "failed", "cancelled"].includes(job.job.status))}>
                  Analyze with Muse Spark
                </Button>
                <CostEstimate operation="experiment.analyze" fetchEstimate={fetchEstimate(workspaceId)} note="Not charged when there's no data to analyse." />
              </div>
              {jobId ? <JobProgress job={job.job} title="Analysing" onRetry={() => void job.retry()} retrying={job.retrying} /> : null}
              <VariantNumberForm workspaceId={workspaceId} experiment={exp} onSaved={() => void detail.refetch()} />
            </div>
          ) : null}

          {result ? <ResultView result={result} /> : <Notice>No analysis yet. Add the numbers for each version, then analyse.</Notice>}

          {can("analytics.write") && exp.status !== "concluded" && exp.status !== "abandoned" ? (
            <Card tone="well" className="space-y-3">
              <Field label="Decision" hint="Recorded as a lesson in your brand memory so future recommendations take it into account.">
                {(ids) => <Textarea id={ids.id} rows={2} value={decision} onChange={(e) => setDecision(e.target.value)} placeholder="Keep founder-on-camera hooks for launch posts" />}
              </Field>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void patch({ status: "concluded", decision })} disabled={!decision.trim()}>
                  Finish test
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void patch({ status: "abandoned" })}>
                  Stop test
                </Button>
              </div>
            </Card>
          ) : exp.decision ? (
            <Notice tone="success" title="Decision">
              {exp.decision}
            </Notice>
          ) : null}
        </div>
      ) : (
        <div className="p-5">
          <QueryState query={detail} feature="Test">
            {() => null}
          </QueryState>
        </div>
      )}
    </Sheet>
  );
}

function VariantNumberForm({ workspaceId, experiment, onSaved }: { workspaceId: string; experiment: Experiment; onSaved: () => void }) {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ variantKey: experiment.variants[0]?.key ?? "a", metric: experiment.primaryMetric, value: "", from: today, to: today, definition: "", scope: "platform_reported" });
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Add a number for a version
      </Button>
    );
  const save = async () => {
    setBusy(true);
    try {
      await api.post(wsPath(workspaceId, `/apps/${experiment.appId}/observations`), {
        metric: f.metric as MetricNameT,
        value: Number(f.value),
        windowStart: `${f.from}T00:00:00Z`,
        windowEnd: new Date(new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000).toISOString(),
        experimentId: experiment.id,
        variantKey: f.variantKey,
        campaignId: experiment.campaignId,
        attribution: f.scope,
        definition: f.definition,
      });
      toast.success("Saved", "Labelled “Manual” and linked to this version.");
      setF({ ...f, value: "" });
      onSaved();
    } catch (err) {
      toast.error("Couldn’t save", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Version">{(ids) => <Select id={ids.id} options={experiment.variants.map((v) => ({ value: v.key, label: `${v.key.toUpperCase()}: ${v.label}` }))} value={f.variantKey} onChange={(e) => setF({ ...f, variantKey: e.target.value })} />}</Field>
        <Field label="Metric">{(ids) => <Select id={ids.id} options={METRIC_OPTIONS} value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })} />}</Field>
        <Field label="Value">{(ids) => <Input id={ids.id} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />}</Field>
        <Field label="From (UTC)">{(ids) => <Input id={ids.id} type="date" max={today} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
        <Field label="To (UTC, inclusive)">{(ids) => <Input id={ids.id} type="date" max={today} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field>
        <Field label="Scope">
          {(ids) => (
            <Select
              id={ids.id}
              value={f.scope}
              onChange={(e) => setF({ ...f, scope: e.target.value })}
              options={[
                { value: "platform_reported", label: "This post's platform stats" },
                { value: "aggregate", label: "Whole account" },
              ]}
            />
          )}
        </Field>
      </div>
      <Field label="Source of the number">{(ids) => <Input id={ids.id} value={f.definition} onChange={(e) => setF({ ...f, definition: e.target.value })} placeholder="TikTok post analytics → link clicks" />}</Field>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} loading={busy} disabled={!f.value.trim() || Number.isNaN(Number(f.value)) || f.definition.trim().length < 3}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Done
        </Button>
      </div>
    </Card>
  );
}

function ResultView({ result }: { result: ExperimentResult }) {
  const metrics = [...new Set(result.perVariant.flatMap((v) => v.metrics.map((m) => m.metric)))];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <ConfidencePill confidence={result.confidence} />
        <span className="text-footnote text-ink-3">
          Analysed {fmtDate(result.createdAt, true)} UTC{result.model ? ` · ${result.model}` : " · no model call (nothing to analyse)"}
        </span>
      </div>
      <p className="text-body-sm text-pretty">{result.summary}</p>

      <table className="w-full text-left text-body-sm">
        <thead className="text-footnote text-ink-3">
          <tr>
            <th className="py-1.5 font-medium">Version</th>
            {metrics.map((m) => (
              <th key={m} className="py-1.5 text-right font-medium">
                {m.replace(/_/g, " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {result.perVariant.map((v) => (
            <tr key={v.key}>
              <td className="py-1.5 font-medium">{v.key === "baseline" ? "Baseline" : v.key.toUpperCase()}</td>
              {metrics.map((m) => {
                const cell = v.metrics.find((x) => x.metric === m);
                return (
                  <td key={m} className="py-1.5 text-right tabular" title={cell?.note}>
                    {cell?.value ?? <span className="text-ink-3">not measured</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="space-y-2">
        <p className="text-footnote font-semibold uppercase tracking-wide text-ink-2">Measured</p>
        {result.measured.length ? (
          <ul className="space-y-2">
            {result.measured.map((m, i) => (
              <li key={i} className="space-y-1 text-body-sm">
                <p>{m.text}</p>
                <IdChips ids={m.observationIds} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body-sm text-ink-3">No measured results we could check.</p>
        )}
      </div>
      {result.hypotheses.length ? (
        <div className="space-y-2">
          <p className="text-footnote font-semibold uppercase tracking-wide text-ink-2">Possible reasons (not measured)</p>
          <ul className="list-disc space-y-1 pl-5 text-body-sm text-ink-2">
            {result.hypotheses.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.limitations.length ? (
        <div className="space-y-2">
          <p className="text-footnote font-semibold uppercase tracking-wide text-ink-2">Limitations</p>
          <ul className="list-disc space-y-1 pl-5 text-body-sm text-ink-2">
            {result.limitations.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.validation && (result.validation.droppedMeasured || result.validation.movedToHypotheses || result.validation.confidenceCapped) ? (
        <Notice tone="info" title="Checked by MuseLaunch">
          <ul className="list-disc space-y-0.5 pl-4">
            {result.validation.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}
