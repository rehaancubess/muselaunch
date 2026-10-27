"use client";
import type { Claim, Job } from "@muselaunch/contracts";
import {
  Badge,
  Button,
  EmptyState,
  JobProgress,
  PipelineSteps,
  Section,
  Skeleton,
  StatusPill,
  humanizeStatus,
  statusKindOf,
  useToast,
  type PipelineStep,
  type StepState,
} from "@muselaunch/ui";
import { ArrowLeft, Copy, FileArchive, Lightbulb, MessageSquareText, Package } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { PageContainer } from "@/components/page-container";
import { QueryState } from "@/components/states";
import { api, errorMessage, isRouteMissing, newIdempotencyKey, wsPath } from "@/lib/api";
import type { AppDnaResponse, CampaignDetailResponse, JobResponse, Page } from "@/lib/api-types";
import { isActive, useJob } from "@/lib/jobs";
import { CHANNEL_LABEL, GOAL_LABEL, relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { CompositionCard } from "./composition-card";
import { ConceptCard } from "./concept-card";

function pipelineStates(d: CampaignDetailResponse, activeTypes: Set<string>): Partial<Record<PipelineStep, StepState>> {
  const { campaign, variants, storyboards, compositions } = d;
  const rendered = compositions.some((c) => c.status === "rendered" || c.status === "approved");
  const approved = compositions.some((c) => c.status === "approved") || ["approved", "scheduled", "live", "completed"].includes(campaign.status);
  const failed = compositions.some((c) => c.status === "failed");
  const s: Partial<Record<PipelineStep, StepState>> = {};
  s.research = variants.length || d.brief ? "done" : activeTypes.has("research.run") || activeTypes.has("strategy.run") || campaign.status === "planning" ? "active" : "pending";
  s.concept = variants.length ? (variants.some((v) => v.status === "selected" || v.status === "produced") ? "done" : "attention") : activeTypes.has("campaign.generate_concepts") ? "active" : "pending";
  s.storyboard = storyboards.length ? "done" : activeTypes.has("storyboard.generate") ? "active" : "pending";
  s.assets = compositions.length ? "done" : storyboards.length ? "active" : "pending";
  s.composition = compositions.length ? "done" : activeTypes.has("composition.build") ? "active" : "pending";
  s.render = rendered ? "done" : failed ? "failed" : activeTypes.has("render.preview") || activeTypes.has("render.final") || compositions.some((c) => c.status === "rendering") ? "active" : "pending";
  s.review = approved ? "done" : rendered ? "attention" : "pending";
  return s;
}

function LiveJob({ workspaceId, job, onSettled }: { workspaceId: string; job: Job; onSettled: () => void }) {
  const toast = useToast();
  const live = useJob(workspaceId, job.id, { initial: job, onSettled });
  return (
    <div className="rounded-xl bg-surface p-4 shadow-raised">
      <JobProgress
        job={live.job}
        variant="row"
        onCancel={() => live.cancel().catch((e) => toast.error("Couldn’t cancel", errorMessage(e)))}
        onRetry={() => live.retry().catch((e) => toast.error("Couldn’t retry", errorMessage(e)))}
        cancelling={live.cancelling}
        retrying={live.retrying}
      />
    </div>
  );
}

function CopyPacks({ data }: { data: CampaignDetailResponse }) {
  const toast = useToast();
  if (!data.copyPacks.length) return null;
  return (
    <Section title="Captions & copy" description="Checked against your verified claims before it’s shown here.">
      <div className="grid gap-3 md:grid-cols-2">
        {data.copyPacks.map((p) => (
          <div key={p.id} className="space-y-3 rounded-xl bg-surface p-4 shadow-raised">
            <div className="flex items-center justify-between gap-2">
              <p className="text-body-sm font-semibold">{CHANNEL_LABEL[p.channel]}</p>
              {p.validation ? (
                <StatusPill status={p.validation.ok ? "success" : "attention"}>{p.validation.ok ? "Claims checked" : `${p.validation.issues.length} to fix`}</StatusPill>
              ) : (
                <StatusPill status="queued">Not checked</StatusPill>
              )}
            </div>
            <ul className="space-y-2">
              {p.items.slice(0, 4).map((it) => (
                <li key={it.id} className="group flex items-start gap-2 rounded-lg bg-mist/70 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-caption text-ink-3">{humanizeStatus(it.kind)}</p>
                    <p className="whitespace-pre-line text-footnote text-ink">{it.text}</p>
                    {p.validation?.issues.filter((x) => x.itemId === it.id).map((x, i) => (
                      <p key={i} className="mt-1 text-caption text-warning">
                        {x.issue}
                      </p>
                    ))}
                  </div>
                  <button
                    type="button"
                    aria-label="Copy text"
                    className="shrink-0 rounded-full p-1 text-ink-3 opacity-0 transition-opacity hover:bg-white hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => navigator.clipboard.writeText(it.text).then(() => toast.success("Copied"))}
                  >
                    <Copy className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ExportButton({ workspaceId, campaignId, onJob, disabled }: { workspaceId: string; campaignId: string; onJob: (j: Job) => void; disabled: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const idem = useRef(newIdempotencyKey("export"));
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      loading={busy}
      icon={<Package className="size-3.5" aria-hidden />}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api.post<JobResponse>(wsPath(workspaceId, `/campaigns/${campaignId}/export`), { includeCopy: true }, { idempotencyKey: idem.current });
          onJob(r.job);
          idem.current = newIdempotencyKey("export");
        } catch (e) {
          toast.error(isRouteMissing(e) ? "Export isn’t available in this build yet" : "Couldn’t start the export", isRouteMissing(e) ? undefined : errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      Export package
    </Button>
  );
}

export function CampaignPage({ workspaceId, appId, campaignId }: { workspaceId: string; appId: string; campaignId: string }) {
  const { can } = useWorkspace();
  const invalidate = useInvalidate();
  const path = wsPath(workspaceId, `/campaigns/${campaignId}`);
  const [startedJobs, setStartedJobs] = useState<Job[]>([]);
  const jobs = useApiQuery<Page<Job>>(wsPath(workspaceId, "/jobs"), { query: { appId, limit: 40 }, refetchInterval: 5000 });
  const campaignJobs = (jobs.data?.items ?? []).filter((j) => (j.payload as { campaignId?: string })?.campaignId === campaignId);
  const active = [...startedJobs.filter((s) => !campaignJobs.some((j) => j.id === s.id)), ...campaignJobs.filter(isActive)];
  const failedRecent = campaignJobs.filter((j) => j.status === "failed").slice(0, 2);
  const detail = useApiQuery<CampaignDetailResponse>(path, { refetchInterval: active.length ? 4000 : false });
  const dna = useApiQuery<AppDnaResponse>(wsPath(workspaceId, `/apps/${appId}/dna`), { retry: false });
  const claims = useMemo(() => new Map<string, Claim>((dna.data?.claims ?? []).map((c) => [c.id, c])), [dna.data]);
  const activeTypes = new Set(active.map((j) => j.type));
  const r = routes.app(workspaceId, appId);
  const refresh = () => void invalidate(path, wsPath(workspaceId, "/jobs"));

  return (
    <PageContainer width="wide">
      <Link href={r.creator} className="mb-6 inline-flex items-center gap-1.5 text-footnote font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> Creator
      </Link>
      <QueryState
        query={detail}
        feature="This campaign"
        skeleton={
          <div className="space-y-8">
            <Skeleton className="h-9 w-80" />
            <Skeleton className="h-16 w-full" rounded="xl" />
            <div className="grid gap-4 md:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-80" rounded="xl" />
              ))}
            </div>
          </div>
        }
      >
        {(d) => {
          const { campaign, variants, compositions, brief } = d;
          return (
            <div className="space-y-12">
              <header className="space-y-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="text-title-1 font-semibold text-balance">{campaign.name}</h1>
                      <StatusPill status={statusKindOf(campaign.status)}>{humanizeStatus(campaign.status)}</StatusPill>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="outline">{GOAL_LABEL[campaign.goal]}</Badge>
                      {campaign.channels.map((c) => (
                        <Badge key={c} tone="neutral">
                          {CHANNEL_LABEL[c]}
                        </Badge>
                      ))}
                      <span className="text-caption text-ink-3">Started {relativeTime(campaign.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {campaign.strategyRunId ? (
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={r.run(campaign.strategyRunId)}>
                          <Lightbulb className="size-3.5" aria-hidden />
                          How Muse planned this
                        </Link>
                      </Button>
                    ) : null}
                    <ExportButton workspaceId={workspaceId} campaignId={campaignId} onJob={(j) => setStartedJobs((x) => [j, ...x])} disabled={!compositions.length || !can("content.write")} />
                  </div>
                </div>
                {campaign.request ? (
                  <p className="flex max-w-3xl items-start gap-2 text-body text-ink-2">
                    <MessageSquareText className="mt-1 size-4 shrink-0 text-ink-3" aria-hidden />
                    <span className="text-pretty">“{campaign.request}”</span>
                  </p>
                ) : null}
              </header>

              <div className="rounded-2xl bg-mist/60 px-5 py-6 sm:px-8">
                <PipelineSteps states={pipelineStates(d, activeTypes)} />
              </div>

              {active.length || failedRecent.length ? (
                <div className="space-y-2" aria-label="Running work">
                  {active.map((j) => (
                    <LiveJob key={j.id} workspaceId={workspaceId} job={j} onSettled={refresh} />
                  ))}
                  {!active.length
                    ? failedRecent.map((j) => <LiveJob key={j.id} workspaceId={workspaceId} job={j} onSettled={refresh} />)
                    : null}
                </div>
              ) : null}

              {brief ? (
                <Section title="Brief">
                  <dl className="grid gap-x-8 gap-y-5 rounded-xl bg-surface p-5 shadow-raised sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      { t: "Audience", v: brief.audience.description },
                      { t: "Angle", v: brief.angle },
                      { t: "Why it’s different", v: brief.usp },
                      { t: "Call to action", v: brief.cta },
                    ].map((x) => (
                      <div key={x.t}>
                        <dt className="text-caption text-ink-3">{x.t}</dt>
                        <dd className="mt-0.5 text-body-sm text-ink text-pretty">{x.v}</dd>
                      </div>
                    ))}
                  </dl>
                </Section>
              ) : null}

              <Section title="Concepts" description={variants.length ? "Each takes a different strategic angle. Select the ones worth testing, then produce them." : undefined}>
                {variants.length ? (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {variants.map((v) => (
                      <ConceptCard
                        key={v.id}
                        variant={v}
                        campaignId={campaignId}
                        workspaceId={workspaceId}
                        claims={claims}
                        runHref={v.generatedByRunId ? r.run(v.generatedByRunId) : undefined}
                        canEdit={can("content.write")}
                        onJob={(j) => setStartedJobs((x) => [j, ...x])}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-2xl bg-mist/60">
                    <EmptyState
                      icon={<Lightbulb aria-hidden />}
                      title={active.length ? "Muse is working on concepts" : "No concepts yet"}
                      description={active.length ? "Research comes first, so every concept can point to what it’s based on. Progress is shown above." : "Concept generation didn’t produce results. Check the activity above and retry."}
                    />
                  </div>
                )}
              </Section>

              <Section title="Compositions" description={compositions.length ? "Editable videos and stills. Open one in the Studio to edit by conversation or by hand." : undefined}>
                {compositions.length ? (
                  <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">
                    {compositions.map((c) => (
                      <CompositionCard key={c.id} composition={c} workspaceId={workspaceId} />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-line-strong">
                    <EmptyState size="sm" icon={<FileArchive aria-hidden />} title="Nothing produced yet" description="Produce a selected concept and its storyboard, composition and preview render appear here." />
                  </div>
                )}
              </Section>

              <CopyPacks data={d} />
            </div>
          );
        }}
      </QueryState>
    </PageContainer>
  );
}
