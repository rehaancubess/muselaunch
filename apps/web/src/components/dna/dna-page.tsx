"use client";
import type { App, AppEvidence, BrandProfile, Job } from "@muselaunch/contracts";
import {
  Badge,
  Button,
  CostEstimate,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  JobProgress,
  Notice,
  ProvenanceBadge,
  Skeleton,
  SkeletonText,
  SourceChip,
  StatusPill,
  Textarea,
  cn,
  humanizeStatus,
  statusKindOf,
  useToast,
} from "@muselaunch/ui";
import { CheckCircle2, Dna, Pencil, RefreshCw, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { AppIcon } from "@/components/app-icon";
import { PageContainer } from "@/components/page-container";
import { UnavailableState } from "@/components/states";
import VoiceRecorder from "@/features/media/voice-recorder";
import { api, errorMessage, isRouteMissing, newIdempotencyKey, wsPath } from "@/lib/api";
import type { AppDnaResponse, JobResponse, Page } from "@/lib/api-types";
import { fetchEstimate } from "@/lib/estimate";
import { isActive, useJob } from "@/lib/jobs";
import { relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useCurrentApp, useWorkspace } from "@/lib/workspace";
import { BrandKitEditor } from "./brand-kit";
import { ClaimsSection } from "./claims";
import { CompetitorsSection, MemorySection } from "./competitors-memory";
import { AssetThumb, EvidencePopover } from "./evidence";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "founder", label: "Founder brief" },
  { id: "features", label: "Features" },
  { id: "audiences", label: "Audiences" },
  { id: "claims", label: "Claims" },
  { id: "brand", label: "Brand kit" },
  { id: "competitors", label: "Competitors" },
  { id: "memory", label: "Memory" },
] as const;

function DnaSection({ id, title, description, children, actions }: { id: string; title: string; description?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-24 space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-0.5">
          <h2 id={`${id}-h`} className="text-title-3 font-semibold">
            {title}
          </h2>
          {description ? <p className="text-body-sm text-ink-2 text-pretty">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function SourceLinks({ app }: { app: App }) {
  const now = app.updatedAt;
  const links = [
    app.storeUrls.ios ? { url: app.storeUrls.ios, title: "App Store listing" } : null,
    app.storeUrls.android ? { url: app.storeUrls.android, title: "Google Play listing" } : null,
    app.websiteUrl ? { url: app.websiteUrl, title: "Website" } : null,
  ].filter(Boolean) as { url: string; title: string }[];
  if (!links.length) return <span className="text-footnote text-ink-3">No public listing linked</span>;
  return (
    <>
      {links.map((l) => (
        <SourceChip key={l.url} source={{ kind: "store_listing", url: l.url, title: l.title, retrievedAt: now }} compact />
      ))}
    </>
  );
}

/** Re-analyse with a cost estimate first → `POST /apps/:appId/dna/analyze`. */
function AnalyzeDialog({ open, onOpenChange, workspaceId, appId, onStarted, refresh }: { open: boolean; onOpenChange: (v: boolean) => void; workspaceId: string; appId: string; onStarted: (job: Job) => void; refresh: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const idem = useRef(newIdempotencyKey("dna"));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={refresh ? "Re-analyse App DNA" : "Analyse your app"}
      description="Muse Spark reads your listing, screenshots and uploads to draft features, audiences and claims with evidence. Fields you edited are kept."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            icon={<Sparkles className="size-4" aria-hidden />}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<JobResponse>(wsPath(workspaceId, `/apps/${appId}/dna/analyze`), { refresh }, { idempotencyKey: idem.current });
                onStarted(r.job);
                onOpenChange(false);
                idem.current = newIdempotencyKey("dna");
              } catch (e) {
                toast.error("Couldn’t start the analysis", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {refresh ? "Re-analyse" : "Analyse"}
          </Button>
        </>
      }
    >
      <CostEstimate operation="app.analyze" fetchEstimate={(req) => fetchEstimate(workspaceId, req)} />
    </Dialog>
  );
}

function OverviewEditor({ profile, workspaceId, appId, open, onOpenChange }: { profile: BrandProfile; workspaceId: string; appId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [oneLiner, setOneLiner] = useState(profile.oneLiner);
  const [description, setDescription] = useState(profile.description);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Edit overview"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!oneLiner.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.patch(wsPath(workspaceId, `/apps/${appId}/dna`), { oneLiner: oneLiner.trim(), description: description.trim() });
                await invalidate(wsPath(workspaceId, `/apps/${appId}/dna`));
                onOpenChange(false);
              } catch (e) {
                toast.error("Couldn’t save", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="One-liner" hint="One sentence: what it is and who it’s for.">
          {(f) => <Input id={f.id} aria-describedby={f.describedBy} value={oneLiner} onChange={(e) => setOneLiner(e.target.value)} maxLength={240} />}
        </Field>
        <Field label="Description">{(f) => <Textarea id={f.id} rows={7} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />}</Field>
      </div>
    </Dialog>
  );
}

function ReviewAside({ profile, claims, app, workspaceId, appId, canEdit }: { profile: BrandProfile; claims: AppDnaResponse["claims"]; app: App; workspaceId: string; appId: string; canEdit: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const toReview = claims.filter((c) => c.state === "needs_review").length;
  const verified = claims.filter((c) => c.state === "verified").length;
  const confirmed = profile.status === "confirmed";
  return (
    <div className="space-y-5 rounded-xl bg-surface p-5 shadow-raised">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-body-sm font-semibold">Review</p>
          <StatusPill status={confirmed ? "success" : "attention"}>{confirmed ? "Confirmed" : "Draft"}</StatusPill>
        </div>
        <p className="text-footnote text-ink-2">
          {confirmed && profile.confirmedAt ? `Confirmed ${relativeTime(profile.confirmedAt)}. Campaigns use this version.` : "Check the facts, verify claims you can stand behind, then confirm."}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-mist px-3 py-2.5">
          <dt className="text-caption text-ink-2">Verified claims</dt>
          <dd className="text-title-3 font-semibold tabular">{verified}</dd>
        </div>
        <div className={cn("rounded-lg px-3 py-2.5", toReview ? "bg-warning-soft" : "bg-mist")}>
          <dt className={cn("text-caption", toReview ? "text-warning" : "text-ink-2")}>To review</dt>
          <dd className={cn("text-title-3 font-semibold tabular", toReview && "text-warning")}>{toReview}</dd>
        </div>
      </dl>
      {canEdit ? (
        <Button
          className="w-full"
          loading={busy}
          variant={confirmed ? "secondary" : "primary"}
          icon={<CheckCircle2 className="size-4" aria-hidden />}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post(wsPath(workspaceId, `/apps/${appId}/dna/confirm`), { version: profile.version });
              await invalidate(wsPath(workspaceId, `/apps/${appId}/dna`), wsPath(workspaceId, "/apps"));
              toast.success("App DNA confirmed", toReview ? `${toReview} claim${toReview === 1 ? " stays" : "s stay"} unused until verified.` : "Campaigns will use this version.");
            } catch (e) {
              toast.error("Couldn’t confirm", errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirmed ? "Confirm again" : "Confirm App DNA"}
        </Button>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-4">
        {profile.generatedByRunId ? <ProvenanceBadge kind="live_ai" label="Drafted by Muse Spark" /> : null}
        {profile.userEditedPaths.length ? <ProvenanceBadge kind="manual" label={`${profile.userEditedPaths.length} edited by you`} /> : null}
        <span className="text-caption text-ink-3">Version {profile.version}</span>
      </div>
      <nav aria-label="App DNA sections" className="hidden border-t border-line pt-4 lg:block">
        <ul className="space-y-0.5">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="block rounded-md px-2 py-1.5 text-body-sm text-ink-2 hover:bg-mist hover:text-ink">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {app.status === "importing" ? <p className="text-caption text-ink-3">The listing import is still running.</p> : null}
    </div>
  );
}

function FounderBrief({ workspaceId, appId }: { workspaceId: string; appId: string }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  return (
    <VoiceRecorder
      appId={appId}
      purpose="founder_brief"
      onTranscript={() => {
        void invalidate(wsPath(workspaceId, `/apps/${appId}/dna`));
        toast.success("Founder brief added", "Its transcript is now evidence in your App DNA. Re-analyse to fold it into features and claims.");
      }}
    />
  );
}

function ProfileView({ data, app, workspaceId, appId, canEdit, canApprove }: { data: AppDnaResponse & { profile: BrandProfile }; app: App; workspaceId: string; appId: string; canEdit: boolean; canApprove: boolean }) {
  const { profile, evidence, claims } = data;
  const byId = useMemo(() => new Map(evidence.map((e) => [e.id, e])), [evidence]);
  const ev = (ids: string[]) => ids.map((id) => byId.get(id)).filter((x): x is AppEvidence => Boolean(x));
  const [editOverview, setEditOverview] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-14">
        <DnaSection
          id="overview"
          title="Overview"
          actions={
            canEdit ? (
              <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditOverview(true)}>
                Edit
              </Button>
            ) : null
          }
        >
          <div className="space-y-5 rounded-xl bg-surface p-5 shadow-raised sm:p-6">
            <p className="text-title-3 font-medium text-balance">{profile.oneLiner || <span className="text-ink-3">No one-liner yet</span>}</p>
            {profile.description ? <p className="whitespace-pre-line text-body text-ink-2 text-pretty">{profile.description}</p> : null}
            <dl className="grid gap-4 border-t border-line pt-5 sm:grid-cols-3">
              <div>
                <dt className="text-caption text-ink-2">Category</dt>
                <dd className="text-body-sm font-medium">{profile.category ?? app.category ?? "Not set"}</dd>
              </div>
              <div>
                <dt className="text-caption text-ink-2">Platforms</dt>
                <dd className="text-body-sm font-medium">{profile.platforms.length ? profile.platforms.map((p) => (p === "ios" ? "iOS" : p === "macos" ? "macOS" : p[0]!.toUpperCase() + p.slice(1))).join(", ") : "Not set"}</dd>
              </div>
              <div>
                <dt className="text-caption text-ink-2">Business model</dt>
                <dd className="flex items-center gap-1 text-body-sm font-medium">
                  {humanizeStatus(profile.monetization.model)}
                  {profile.monetization.evidenceIds.length ? <EvidencePopover workspaceId={workspaceId} items={ev(profile.monetization.evidenceIds)} /> : null}
                </dd>
              </div>
            </dl>
            {profile.differentiators.length || profile.problems.length ? (
              <div className="grid gap-5 border-t border-line pt-5 sm:grid-cols-2">
                {[
                  { title: "What makes it different", items: profile.differentiators },
                  { title: "Problems it solves", items: profile.problems },
                ].map((g) =>
                  g.items.length ? (
                    <div key={g.title} className="space-y-2">
                      <p className="text-caption text-ink-2">{g.title}</p>
                      <ul className="space-y-2">
                        {g.items.map((it) => (
                          <li key={it.id} className="flex items-start gap-2 text-body-sm">
                            <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />
                            <span className="min-w-0 flex-1">{it.text}</span>
                            <EvidencePopover workspaceId={workspaceId} items={ev(it.evidenceIds)} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null,
                )}
              </div>
            ) : null}
          </div>
        </DnaSection>

        {canEdit ? (
          <DnaSection id="founder" title="Founder brief" description="Explain your app in your own words. Muse Voice Transcribe turns it into evidence you can review here.">
            <FounderBrief workspaceId={workspaceId} appId={appId} />
          </DnaSection>
        ) : null}

        <DnaSection id="features" title="Features" description="Each feature links to the real screenshots or recordings that show it. Generated media is never used as proof.">
          {profile.features.length ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {profile.features.map((f) => (
                <li key={f.id} className="flex gap-4 rounded-xl bg-surface p-4 shadow-raised">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="text-body-sm font-semibold">{f.name}</p>
                    <p className="text-footnote text-ink-2 text-pretty">{f.description}</p>
                    <EvidencePopover workspaceId={workspaceId} items={ev(f.evidenceIds)} />
                  </div>
                  {f.assetIds.length ? (
                    <div className="flex shrink-0 gap-1.5">
                      {f.assetIds.slice(0, 2).map((a) => (
                        <AssetThumb key={a} workspaceId={workspaceId} assetId={a} className="aspect-[9/19.5] w-14" alt={`Screenshot showing ${f.name}`} onClick={() => setPreview(a)} />
                      ))}
                    </div>
                  ) : (
                    <span className="flex aspect-[9/19.5] w-14 shrink-0 items-center justify-center rounded-md border border-dashed border-line-strong text-center text-[10px] leading-tight text-ink-3">No screen</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl bg-mist/60 px-4 py-6 text-center text-body-sm text-ink-2">No features found yet. Upload screenshots in the Library and re-analyse.</p>
          )}
        </DnaSection>

        <DnaSection id="audiences" title="Audiences">
          {profile.audiences.length ? (
            <ul className="grid gap-3 md:grid-cols-2">
              {profile.audiences.map((a) => (
                <li key={a.id} className="space-y-3 rounded-xl bg-surface p-4 shadow-raised">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-body-sm font-semibold">{a.name}</p>
                    <EvidencePopover workspaceId={workspaceId} items={ev(a.evidenceIds)} />
                  </div>
                  <p className="text-footnote text-ink-2 text-pretty">{a.description}</p>
                  {a.painPoints.length || a.motivations.length ? (
                    <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
                      {[
                        { t: "Pain points", xs: a.painPoints },
                        { t: "Motivations", xs: a.motivations },
                      ].map((g) => (
                        <div key={g.t}>
                          <p className="mb-1 text-caption text-ink-3">{g.t}</p>
                          <ul className="space-y-1 text-footnote text-ink">
                            {g.xs.slice(0, 4).map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl bg-mist/60">
              <EmptyState size="sm" icon={<Users aria-hidden />} title="No audiences yet" description="Audiences come from your listing and, later, from research in Discover." />
            </div>
          )}
        </DnaSection>

        <DnaSection id="claims" title="Claims" description="Only verified claims appear in creative. Rejected ones are never used.">
          <ClaimsSection claims={claims} evidence={evidence} workspaceId={workspaceId} appId={appId} canEdit={canEdit} canApprove={canApprove} />
        </DnaSection>

        <DnaSection id="brand" title="Brand kit">
          <BrandKitEditor profile={profile} workspaceId={workspaceId} appId={appId} canEdit={canEdit} />
        </DnaSection>

        <DnaSection id="competitors" title="Competitors">
          <CompetitorsSection workspaceId={workspaceId} appId={appId} canEdit={canEdit} />
        </DnaSection>

        <DnaSection id="memory" title="Memory" description="Preferences Muse Glimmer has learned from your decisions. Turn off anything you don’t want applied.">
          <MemorySection workspaceId={workspaceId} appId={appId} canEdit={canEdit} />
        </DnaSection>
      </div>
      <aside className="order-first lg:order-none">
        <div className="lg:sticky lg:top-20">
          <ReviewAside profile={profile} claims={claims} app={app} workspaceId={workspaceId} appId={appId} canEdit={canEdit} />
        </div>
      </aside>
      <OverviewEditor key={profile.updatedAt} profile={profile} workspaceId={workspaceId} appId={appId} open={editOverview} onOpenChange={setEditOverview} />
      <Dialog open={Boolean(preview)} onOpenChange={(v) => !v && setPreview(null)} title="Screenshot" hideTitle size="md">
        {preview ? <AssetThumb workspaceId={workspaceId} assetId={preview} className="mx-auto aspect-[9/19.5] w-full max-w-[320px] rounded-xl" alt="Screenshot evidence" /> : null}
      </Dialog>
    </div>
  );
}

function AnalysisJob({ workspaceId, job }: { workspaceId: string; job: Job }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const live = useJob(workspaceId, job.id, {
    initial: job,
    onSettled: () => void invalidate(wsPath(workspaceId, `/apps/${job.appId}/dna`), wsPath(workspaceId, "/apps")),
  });
  return (
    <div className="rounded-xl bg-surface p-5 shadow-raised">
      <JobProgress
        job={live.job}
        onCancel={() => live.cancel().catch((e) => toast.error("Couldn’t cancel", errorMessage(e)))}
        onRetry={() => live.retry().catch((e) => toast.error("Couldn’t retry", errorMessage(e)))}
        cancelling={live.cancelling}
        retrying={live.retrying}
      />
    </div>
  );
}

/** App DNA review: facts with evidence, claims, brand kit, competitors and memory. */
export function DnaPage() {
  const { app, appId, workspaceId } = useCurrentApp();
  const { can } = useWorkspace();
  const canEdit = can("apps.write");
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [startedJob, setStartedJob] = useState<Job | null>(null);
  const dna = useApiQuery<AppDnaResponse>(wsPath(workspaceId, `/apps/${appId}/dna`), {
    refetchInterval: (q) => (app?.dnaStatus === "drafting" && !q.state.data?.profile ? 5000 : false),
  });
  const jobs = useApiQuery<Page<Job>>(wsPath(workspaceId, "/jobs"), { query: { appId, limit: 20 }, refetchInterval: 6000 });
  const runningJob = startedJob ?? jobs.data?.items.find((j) => (j.type === "app.analyze" || j.type === "app.import") && isActive(j)) ?? null;
  const lastFailed = jobs.data?.items.find((j) => j.type === "app.analyze" || j.type === "app.import");
  const r = routes.app(workspaceId, appId);

  if (!app) return null;
  const hasProfile = Boolean(dna.data?.profile);

  let body: ReactNode;
  if (dna.isLoading) {
    body = (
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <Skeleton className="h-6 w-40" />
          <div className="space-y-4 rounded-xl bg-surface p-6 shadow-raised">
            <Skeleton className="h-6 w-3/4" />
            <SkeletonText lines={4} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-32" rounded="xl" />
            <Skeleton className="h-32" rounded="xl" />
          </div>
        </div>
        <Skeleton className="h-64" rounded="xl" />
      </div>
    );
  } else if (dna.error && isRouteMissing(dna.error)) {
    body = (
      <div className="space-y-6">
        {runningJob ? <AnalysisJob workspaceId={workspaceId} job={runningJob} /> : null}
        <div className="rounded-2xl bg-mist/60">
          <UnavailableState feature="App DNA analysis" description="Your features, audiences, claims and brand kit will appear here for review once the analysis service is deployed. Nothing is generated in the meantime." />
        </div>
        <div className="flex justify-center">
          <Button variant="secondary" asChild>
            <Link href={r.library}>Upload screenshots to the Library</Link>
          </Button>
        </div>
      </div>
    );
  } else if (dna.error) {
    body = <ErrorState title="App DNA didn’t load" message={errorMessage(dna.error)} onRetry={() => dna.refetch()} retrying={dna.isFetching} reference={dna.error.requestId} />;
  } else if (!hasProfile) {
    body = runningJob ? (
      <div className="mx-auto max-w-xl space-y-4 py-6">
        <AnalysisJob workspaceId={workspaceId} job={runningJob} />
        <p className="text-center text-body-sm text-ink-2">Muse Spark is reading your listing and screenshots. Each fact it finds is linked to where it came from, ready for you to check.</p>
      </div>
    ) : (
      <div className="rounded-2xl bg-mist/60">
        <EmptyState
          size="lg"
          icon={<Dna aria-hidden />}
          title={app.dnaStatus === "failed" ? "The last analysis didn’t finish" : `Let Muse learn ${app.name}`}
          description={
            app.dnaStatus === "failed" && lastFailed?.error?.userMessage
              ? lastFailed.error.userMessage
              : "Muse Spark analyses your listing, screenshots and uploads into features, audiences and claims, each linked to evidence, for you to review and confirm."
          }
          action={
            canEdit ? (
              <Button icon={<Sparkles className="size-4" aria-hidden />} onClick={() => setAnalyzeOpen(true)}>
                {app.dnaStatus === "failed" ? "Try again" : "Analyse app"}
              </Button>
            ) : null
          }
          secondaryAction={
            <Button variant="ghost" asChild>
              <Link href={r.library}>Add screenshots first</Link>
            </Button>
          }
        />
        {canEdit ? (
          <div className="mx-auto max-w-xl px-6 pb-10">
            <FounderBrief workspaceId={workspaceId} appId={appId} />
          </div>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="space-y-8">
        {runningJob ? <AnalysisJob workspaceId={workspaceId} job={runningJob} /> : null}
        {dna.data?.import?.warnings.length ? (
          <Notice tone="warning" title="Some details couldn’t be imported">
            {dna.data.import.warnings.slice(0, 3).join(" ")}
          </Notice>
        ) : null}
        <ProfileView data={dna.data as AppDnaResponse & { profile: BrandProfile }} app={app} workspaceId={workspaceId} appId={appId} canEdit={canEdit} canApprove={can("content.approve")} />
      </div>
    );
  }

  return (
    <PageContainer width="wide">
      <header className="flex flex-col gap-5 pb-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <AppIcon app={app} workspaceId={workspaceId} size={64} />
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-title-1 font-semibold">{app.name}</h1>
              <StatusPill status={statusKindOf(app.dnaStatus === "none" ? "draft" : app.dnaStatus)}>{app.dnaStatus === "none" ? "Not analysed" : humanizeStatus(app.dnaStatus)}</StatusPill>
            </div>
            <p className="text-body text-ink-2">App DNA: what Muse knows about your product, and what it’s allowed to say.</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <SourceLinks app={app} />
            </div>
          </div>
        </div>
        {canEdit && hasProfile ? (
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => setAnalyzeOpen(true)} disabled={Boolean(runningJob)}>
              Re-analyse
            </Button>
          </div>
        ) : null}
      </header>
      {body}
      <AnalyzeDialog open={analyzeOpen} onOpenChange={setAnalyzeOpen} workspaceId={workspaceId} appId={appId} refresh={hasProfile} onStarted={setStartedJob} />
      {!canEdit ? (
        <Badge tone="outline" className="mt-8">
          View only
        </Badge>
      ) : null}
    </PageContainer>
  );
}
