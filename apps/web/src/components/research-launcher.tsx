"use client";
import type { Job, ResearchRun } from "@muselaunch/contracts";
import { Button, ChoiceChips, Dialog, Field, JobProgress, Textarea, useToast } from "@muselaunch/ui";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import type { CreateResearchResponse, Page, ResearchRunResponse } from "@/lib/api-types";
import { WorkspaceCostEstimate } from "@/lib/estimate";
import { useJob } from "@/lib/jobs";
import { relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

type Kind = "opportunities" | "trends" | "competitors" | "audience" | "creators" | "market";
const KINDS: { value: Kind; label: string }[] = [
  { value: "opportunities", label: "Opportunities" },
  { value: "trends", label: "Trends" },
  { value: "competitors", label: "Competitors" },
  { value: "audience", label: "Audience" },
  { value: "creators", label: "Creators" },
];

/**
 * Starts Muse Wonder market research (B: `POST /apps/:appId/research`), shows live progress and links
 * to the agent run trace (plan, searches, citations, cost) once it finishes.
 */
export function ResearchLauncher({ appId }: { appId: string }) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<Kind[]>(["opportunities", "trends", "competitors"]);
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const idem = useRef(newIdempotencyKey("research"));
  const runs = useApiQuery<Page<ResearchRun>>(wsPath(workspaceId, `/apps/${appId}/research`), { query: { limit: 1 } });
  const latest = runs.data?.items[0];
  const live = useJob(workspaceId, job?.id, {
    initial: job,
    onSettled: (j) => {
      void invalidate(wsPath(workspaceId, `/apps/${appId}`));
      if (j.status === "succeeded") toast.success("Research finished", "New findings and opportunities are in your feed, each with its sources.");
    },
  });
  const detail = useApiQuery<ResearchRunResponse>(latest && latest.status !== "queued" && latest.status !== "running" ? wsPath(workspaceId, `/research-runs/${latest.id}`) : null);
  const runId = latest?.agentRunId ?? detail.data?.run.agentRunId;

  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {job && live.job && (live.job.status === "queued" || live.job.status === "running" || live.job.status === "failed") ? (
        <div className="w-64">
          <JobProgress job={live.job} variant="row" onCancel={() => void live.cancel()} onRetry={() => void live.retry()} />
        </div>
      ) : latest ? (
        <p className="text-footnote text-ink-2">
          Last research {relativeTime(latest.completedAt ?? latest.createdAt)}
          {latest.findingCount ? `, ${latest.findingCount} finding${latest.findingCount === 1 ? "" : "s"}` : ""}
          {runId ? (
            <>
              {" "}
              <Link href={routes.app(workspaceId, appId).run(runId)} className="font-medium text-accent hover:underline">
                See how
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {can("content.write") ? (
        <Button icon={<FlaskConical className="size-4" aria-hidden />} onClick={() => setOpen(true)} disabled={live.job?.status === "running" || live.job?.status === "queued"}>
          Research market
        </Button>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Research the market"
        description="Muse Wonder plans the research, searches the web with Muse Spark and saves only findings it can cite. Interpretations are labelled separately from what sources say."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!kinds.length}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.post<CreateResearchResponse>(wsPath(workspaceId, `/apps/${appId}/research`), { kinds, focus: focus.trim() || undefined }, { idempotencyKey: idem.current });
                  setJob(r.job);
                  setOpen(false);
                  idem.current = newIdempotencyKey("research");
                  void invalidate(wsPath(workspaceId, `/apps/${appId}/research`));
                } catch (e) {
                  toast.error("Couldn’t start research", errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Start research
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <fieldset>
            <legend className="mb-3 text-footnote font-medium">Look into</legend>
            <ChoiceChips label="Research areas" multiple value={kinds} onChange={setKinds} options={KINDS} />
          </fieldset>
          <Field label="Focus" optional hint="e.g. “students preparing for exams in India”">
            {(f) => <Textarea id={f.id} aria-describedby={f.describedBy} rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} maxLength={1000} />}
          </Field>
          <WorkspaceCostEstimate operation="research.run" />
        </div>
      </Dialog>
    </div>
  );
}
