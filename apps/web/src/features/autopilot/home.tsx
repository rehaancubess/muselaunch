"use client";
/**
 * The app's Home when Autopilot is on (the Creator tab opens here): what the AI is doing now, what it
 * has made, and what needs you. One primary action per state; everything else ("See every
 * decision", "Create a campaign myself") is secondary. Data: /apps/:appId/autopilots,
 * /autopilots/:id, /apps/:appId/autopilot/auto (one-tap start), /needs-you?appId=, /compositions.
 */
import type { AutopilotAutoPlan, Campaign, Composition } from "@muselaunch/contracts";
import { Button, Card, List, ListRow, Notice, ProgressBar, Skeleton, Spinner, StatusPill, cn, statusKindOf, useToast } from "@muselaunch/ui";
import { ArrowUpRight, Check, Clapperboard, Compass, FlaskConical, Pause, Play, Plus, Rocket, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { CompositionCard } from "@/components/creator/composition-card";
import { api, ApiError, errorMessage, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { CHANNEL_LABEL, GOAL_LABEL, campaignStatusLabel, relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate, useMutation } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useCurrentApp, useWorkspace } from "@/lib/workspace";
import { NeedsYouList, useNeedsYou } from "./needs-you";
import { isActive, isWorking, STATUS_COPY, statusKind, type AutopilotDetail, type AutopilotListItem } from "./types";

/** The loop's stages as six plain steps. */
const PHASES: { label: string; stages: string[] }[] = [
  { label: "Learn your app", stages: ["understand"] },
  { label: "Research", stages: ["research", "select_audience", "hypothesis"] },
  { label: "Make videos", stages: ["plan_creative", "produce"] },
  { label: "Check & render", stages: ["verify", "render"] },
  { label: "Draft posts", stages: ["schedule"] },
  { label: "Measure", stages: ["measure", "learn", "done"] },
];

function phaseIndex(stage: string) {
  return Math.max(
    0,
    PHASES.findIndex((p) => p.stages.includes(stage)),
  );
}

function Phases({ detail }: { detail: AutopilotDetail }) {
  const ap = detail.autopilot;
  const cur = ap.status === "completed" ? PHASES.length : phaseIndex(ap.stage);
  return (
    <div className="space-y-2">
      <ol className="grid grid-cols-6 gap-1.5" aria-label="Progress">
        {PHASES.map((p, i) => {
          const state = i < cur ? "done" : i > cur ? "pending" : ap.status === "failed" ? "failed" : ap.status === "awaiting_user" ? "attention" : ap.status === "cancelled" || ap.status === "paused" ? "pending" : "active";
          return (
            <li key={p.label} className="min-w-0 space-y-1.5" aria-current={state === "active" || state === "attention" ? "step" : undefined}>
              <span
                className={cn(
                  "block h-1.5 rounded-full transition-colors",
                  state === "done" && "bg-ink",
                  state === "active" && "animate-pulse bg-accent",
                  state === "attention" && "bg-warning",
                  state === "failed" && "bg-danger",
                  state === "pending" && "bg-mist-2",
                )}
              />
              <span className={cn("hidden truncate text-caption sm:block", state === "pending" ? "text-ink-3" : "font-medium text-ink")}>{p.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="text-caption text-ink-2 sm:hidden">{cur >= PHASES.length ? "All steps done" : `Step ${cur + 1} of ${PHASES.length}: ${PHASES[cur]!.label}`}</p>
    </div>
  );
}

/** "Now: …" — what the AI is doing this minute, in plain words. */
function nowLine(detail: AutopilotDetail, needs: number): string {
  const ap = detail.autopilot;
  switch (ap.status) {
    case "running":
    case "waiting_on_jobs":
      return detail.waitingFor || `${PHASES[phaseIndex(ap.stage)]!.label}…`;
    case "awaiting_user":
      return "Waiting for your decision below.";
    case "sleeping":
      return needs ? `${detail.waitingFor}. Approve the posts below so there’s something to measure.` : detail.waitingFor;
    case "paused":
      return ap.error?.userMessage ?? "Paused. Nothing new starts until you resume.";
    case "failed":
      return ap.error?.userMessage ?? "The run stopped.";
    case "completed":
      return "This run is complete. Start another whenever you like.";
    case "cancelled":
      return "This run was cancelled. What it made is kept.";
  }
}

function useLoopAction(detail: AutopilotDetail | undefined) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (action: "pause" | "resume") => api.post(wsPath(workspaceId, `/autopilots/${detail!.autopilot.id}/${action}`), {}),
    onSuccess: async (_d, action) => {
      toast.success(action === "pause" ? "Paused" : "Resumed", action === "pause" ? "Running jobs finish; nothing new starts." : undefined);
      await invalidate(wsPath(workspaceId, "/autopilots"), wsPath(workspaceId, `/apps/${detail!.autopilot.appId}/autopilots`));
    },
    onError: (e) => toast.error("That didn’t work", errorMessage(e)),
  });
}

function RunCard({ detail, needs }: { detail: AutopilotDetail; needs: number }) {
  const { workspaceId, can } = useWorkspace();
  const ap = detail.autopilot;
  const r = routes.app(workspaceId, ap.appId);
  const act = useLoopAction(detail);
  const working = isWorking(ap.status);
  const pct = Math.min(100, (ap.spent.credits / Math.max(1, ap.budget.maxCredits)) * 100);
  const dnaAuto = ap.log.some((e) => e.summary.startsWith("Accepted your App DNA automatically"));
  return (
    <Card padding="lg" className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={ap.status === "sleeping" && needs ? "attention" : statusKind(ap.status)}>{ap.status === "awaiting_user" || (ap.status === "sleeping" && needs) ? "Needs you" : STATUS_COPY[ap.status]}</StatusPill>
        <span className="text-caption text-ink-3">Growth Autopilot · started {relativeTime(ap.createdAt)}</span>
      </div>
      <div className="space-y-2">
        <h2 className="text-title-2 font-semibold text-balance">{ap.goal}</h2>
        <p className="flex items-start gap-2 text-body text-ink-2" aria-live="polite">
          {working ? <Spinner className="mt-1 size-3.5 shrink-0" /> : null}
          <span className="text-pretty">
            <span className="font-medium text-ink">Now: </span>
            {nowLine(detail, needs)}
          </span>
        </p>
      </div>
      <Phases detail={detail} />
      <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-xs">
          <p className="text-caption text-ink-2">
            <span className="tabular font-medium text-ink">{ap.spent.credits}</span> of {ap.budget.maxCredits} credits used · {ap.budget.variants} video{ap.budget.variants > 1 ? "s" : ""}
          </p>
          <ProgressBar value={pct} tone={pct >= 90 ? "danger" : "accent"} label="Budget used" />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {dnaAuto ? (
            <Link href={r.brand} className="text-footnote font-medium text-accent hover:underline">
              Review App DNA
            </Link>
          ) : null}
          <Link href={`${r.autopilot}?loop=${encodeURIComponent(ap.id)}`} className="inline-flex items-center gap-0.5 text-footnote font-medium text-accent hover:underline">
            See every decision
            <ArrowUpRight className="size-3" aria-hidden />
          </Link>
          {can("content.write") && (ap.status === "paused" || ap.status === "failed") ? (
            <Button size="sm" icon={<Play className="size-3.5" aria-hidden />} loading={act.isPending} onClick={() => act.mutate("resume")}>
              {ap.status === "failed" ? "Try again" : "Resume"}
            </Button>
          ) : can("content.write") && (working || ap.status === "sleeping") ? (
            <Button size="sm" variant="ghost" icon={<Pause className="size-3.5" aria-hidden />} loading={act.isPending} onClick={() => act.mutate("pause")}>
              Pause
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** Videos, research, the experiment and posts this run produced. */
function MadeForYou({ detail }: { detail: AutopilotDetail }) {
  const { workspaceId } = useWorkspace();
  const ap = detail.autopilot;
  const r = routes.app(workspaceId, ap.appId);
  const comps = useApiQuery<Page<Composition>>(ap.campaignId ? wsPath(workspaceId, "/compositions") : null, {
    query: ap.campaignId ? { campaignId: ap.campaignId, limit: 12 } : undefined,
    refetchInterval: isWorking(ap.status) ? 8000 : false,
  });
  const ours = (comps.data?.items ?? []).filter((c) => ap.compositionIds.includes(c.id));
  const reviewOf = (id: string) => detail.reviews.filter((x) => x.subject.id === id).sort((a, b) => (b.subjectVersion ?? 0) - (a.subjectVersion ?? 0))[0];
  const rows: { icon: React.ReactNode; title: string; sub: string; href: string }[] = [];
  if (ap.audience || detail.findings.length)
    rows.push({
      icon: <Compass aria-hidden />,
      title: "Audience and research",
      sub: `${ap.audience ? `${ap.audience.description}. ` : ""}${detail.findings.length ? `Based on ${detail.findings.length} cited finding${detail.findings.length > 1 ? "s" : ""}; every finding links to its source.` : "Every finding links to its source."}`,
      href: r.discover,
    });
  if (ap.hypothesis) rows.push({ icon: <FlaskConical aria-hidden />, title: "Experiment", sub: ap.hypothesis.statement, href: r.insights });
  if (detail.posts.length)
    rows.push({
      icon: <Send aria-hidden />,
      title: `${detail.posts.length} post${detail.posts.length > 1 ? "s" : ""} drafted`,
      sub: detail.posts
        .map(
          (x) =>
            `${CHANNEL_LABEL[x.channel] ?? x.channel}${x.scheduledAt ? ` ${new Date(x.scheduledAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}` : ""}: ${x.status === "awaiting_approval" ? "awaiting your approval" : x.status.replace(/_/g, " ")}`,
        )
        .join(" · "),
      href: r.calendar,
    });
  if (!ours.length && !rows.length) return null;
  return (
    <section className="space-y-4" aria-labelledby="made-for-you">
      <div className="flex items-end justify-between gap-3">
        <h2 id="made-for-you" className="text-headline font-semibold">
          Made for you
        </h2>
        {ap.campaignId ? (
          <Link href={r.campaign(ap.campaignId)} className="inline-flex items-center gap-0.5 text-footnote font-medium text-accent hover:underline">
            Open campaign
            <ArrowUpRight className="size-3" aria-hidden />
          </Link>
        ) : null}
      </div>
      {ours.length ? (
        <div className="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-3">
          {ours.map((c) => {
            const rv = reviewOf(c.id);
            return (
              <CompositionCard
                key={c.id}
                composition={c}
                workspaceId={workspaceId}
                badge={
                  rv ? (
                    <StatusPill status={rv.status === "passed" ? "success" : rv.status === "warnings" ? "attention" : rv.status === "blocked" || rv.status === "failed" ? "failed" : "running"}>
                      {rv.status === "passed" ? "On brand" : rv.status === "warnings" ? "On brand, with notes" : rv.status === "blocked" ? "Brand Guardian blocked" : "Checking brand"}
                    </StatusPill>
                  ) : null
                }
              />
            );
          })}
        </div>
      ) : ap.compositionIds.length || ap.stage === "produce" ? (
        <div className="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-3">
          {Array.from({ length: Math.max(1, ap.budget.variants) }, (_, i) => (
            <Skeleton key={i} className="aspect-[4/5] w-full" rounded="xl" />
          ))}
        </div>
      ) : null}
      {rows.length ? (
        <List label="What this run produced">
          {rows.map((x) => (
            <ListRow key={x.title} href={x.href} leading={<span className="flex size-9 items-center justify-center rounded-lg bg-mist text-ink-2 [&_svg]:size-4">{x.icon}</span>} title={x.title} subtitle={x.sub} />
          ))}
        </List>
      ) : null}
    </section>
  );
}

/** No run yet (or the last one ended): one tap to start, with an honest cost and a smaller run when credits are short. */
function StartRun({ appId, previous }: { appId: string; previous?: AutopilotListItem | null }) {
  const { workspaceId, can } = useWorkspace();
  const { app } = useCurrentApp();
  const toast = useToast();
  const invalidate = useInvalidate();
  const plan = useApiQuery<{ plan: AutopilotAutoPlan }>(wsPath(workspaceId, `/apps/${appId}/autopilot/auto`), { retry: false });
  const start = useMutation({
    mutationFn: (variants?: number) => api.post<{ autopilot: { id: string } }>(wsPath(workspaceId, `/apps/${appId}/autopilot/auto`), variants ? { variants } : {}),
    onSuccess: async () => {
      toast.success("Growth Autopilot started", "It learns your app and researches first. You’ll only be asked before anything is posted or extra is spent.");
      await invalidate(wsPath(workspaceId, `/apps/${appId}/autopilot`), wsPath(workspaceId, "/needs-you"), wsPath(workspaceId));
    },
    onError: (e) => toast.error("Couldn’t start", e instanceof ApiError ? e.userMessage : errorMessage(e)),
  });
  const p = plan.data?.plan;
  const canStart = can("content.write");
  return (
    <Card padding="lg" className="space-y-5">
      <div className="flex items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-white">
          <Rocket className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 space-y-1">
          <h2 className="text-title-3 font-semibold text-balance">{previous ? "Start another run" : `Let MuseLaunch grow ${app?.name ?? "your app"}`}</h2>
          <p className="text-body-sm text-ink-2 text-pretty">It researches your market, makes {p?.variants ?? 2} short videos, checks them against your brand and drafts posts. You approve anything public and any extra spend.</p>
        </div>
      </div>
      {plan.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : p ? (
        <div className="space-y-4 sm:pl-15">
          <dl className="grid gap-x-6 gap-y-2 text-body-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-ink-3">Goal</dt>
            <dd className="text-ink">{p.goal}</dd>
            <dt className="text-ink-3">Budget</dt>
            <dd className="tabular text-ink">
              ≈{p.needed} credits <span className="text-ink-3">of {p.available.toLocaleString()} available</span>
            </dd>
          </dl>
          {p.shortfall ? (
            <Notice tone="warning" title={p.shortfall.kind === "credits" ? "Not enough credits for a full run" : "Above your per-run limit"}>
              {p.shortfall.message}
              {p.smaller ? ` A smaller run with ${p.smaller.variants} video uses ≈${p.smaller.needed} credits.` : ""}
            </Notice>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {p.fits ? (
              <Button size="lg" icon={<Sparkles className="size-4" aria-hidden />} disabled={!canStart} loading={start.isPending} onClick={() => start.mutate(undefined)}>
                Start Growth Autopilot
              </Button>
            ) : p.smaller ? (
              <Button size="lg" icon={<Sparkles className="size-4" aria-hidden />} disabled={!canStart} loading={start.isPending} onClick={() => start.mutate(p.smaller!.variants)}>
                Start a smaller run
              </Button>
            ) : (
              <Button size="lg" variant="secondary" asChild>
                <Link href={routes.settings.credits(workspaceId)}>Get credits</Link>
              </Button>
            )}
            {!canStart ? <p className="text-footnote text-ink-2">Viewers can follow runs but not start them.</p> : null}
          </div>
          {p.notes.length ? <p className="text-footnote text-ink-3 text-pretty">{p.notes.join(" ")}</p> : null}
        </div>
      ) : plan.error ? (
        <Notice tone="danger">{errorMessage(plan.error)}</Notice>
      ) : null}
    </Card>
  );
}

function CampaignList({ appId }: { appId: string }) {
  const { workspaceId, can } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const campaigns = useApiQuery<Page<Campaign>>(wsPath(workspaceId, `/apps/${appId}/campaigns`));
  const items = campaigns.data?.items ?? [];
  return (
    <section className="space-y-4" aria-labelledby="your-campaigns">
      <div className="flex items-end justify-between gap-3">
        <h2 id="your-campaigns" className="text-headline font-semibold">
          Campaigns
        </h2>
        {can("content.write") ? (
          <Button size="sm" variant="ghost" asChild>
            <Link href={r.newCampaign}>
              <Plus className="size-3.5" aria-hidden />
              Create a campaign myself
            </Link>
          </Button>
        ) : null}
      </div>
      {campaigns.isLoading ? (
        <Skeleton className="h-16 w-full" rounded="xl" />
      ) : items.length ? (
        <List label="Campaigns">
          {items.slice(0, 6).map((c) => (
            <ListRow
              key={c.id}
              href={r.campaign(c.id)}
              leading={
                <span className="flex size-9 items-center justify-center rounded-lg bg-mist text-ink-2">
                  <Clapperboard className="size-4" aria-hidden />
                </span>
              }
              title={c.name}
              subtitle={`${GOAL_LABEL[c.goal]}, started ${relativeTime(c.createdAt)}`}
              trailing={<StatusPill status={statusKindOf(c.status)}>{campaignStatusLabel(c.status)}</StatusPill>}
            />
          ))}
        </List>
      ) : (
        <p className="text-body-sm text-ink-2">Campaigns Growth Autopilot makes show up here. You can also plan one yourself.</p>
      )}
    </section>
  );
}

function RunSkeleton() {
  return (
    <div className="space-y-8" aria-busy>
      <Skeleton className="h-56 w-full" rounded="xl" />
      <Skeleton className="h-40 w-full" rounded="xl" />
    </div>
  );
}

/** Autopilot Home: one run, what it needs from you, what it made. */
export function AutopilotHome({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const invalidate = useInvalidate();
  const list = useApiQuery<{ items: AutopilotListItem[] }>(wsPath(workspaceId, `/apps/${appId}/autopilots`), {
    refetchInterval: (q) => (q.state.data?.items.some((a) => isActive(a.status)) ? 8000 : false),
  });
  const latest = list.data?.items[0] ?? null;
  const active = list.data?.items.find((a) => isActive(a.status)) ?? null;
  const shown = active ?? latest;
  const detail = useApiQuery<AutopilotDetail>(shown ? wsPath(workspaceId, `/autopilots/${shown.id}`) : null, {
    refetchInterval: (q) => {
      const s = q.state.data?.autopilot.status;
      return s && isWorking(s) ? 3000 : s === "awaiting_user" || s === "sleeping" ? 10_000 : false;
    },
  });
  const needs = useNeedsYou(workspaceId, appId);
  const needItems = needs.data?.items ?? [];
  // Keep the Needs-you list and the run list in step with the run's status.
  const status = detail.data?.autopilot.status;
  useEffect(() => {
    if (status) void invalidate(wsPath(workspaceId, "/needs-you"), wsPath(workspaceId, `/apps/${appId}/autopilots`));
  }, [status, appId, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps -- useInvalidate returns a new function each render

  if (list.isLoading || (shown && detail.isLoading)) return <RunSkeleton />;
  const d = detail.data;
  const ended = !active;
  return (
    <div className="space-y-10">
      {d && !ended ? <RunCard detail={d} needs={needItems.length} /> : <StartRun appId={appId} previous={latest} />}

      {needItems.length ? (
        <section className="space-y-4" aria-labelledby="needs-you">
          <div className="space-y-0.5">
            <h2 id="needs-you" className="flex items-center gap-2 text-headline font-semibold">
              Needs you
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-semibold tabular text-white">{needItems.length}</span>
            </h2>
            <p className="text-footnote text-ink-2">Only the things MuseLaunch never does on its own: posting, outreach and spending past a run’s budget.</p>
          </div>
          <NeedsYouList items={needItems} />
        </section>
      ) : d && !ended ? (
        <p className="flex items-center gap-2 text-footnote text-ink-2">
          <Check className="size-3.5 text-success" aria-hidden />
          Nothing needs you right now. You’ll be asked before anything is posted or extra is spent.
        </p>
      ) : null}

      {d ? (
        <div className="space-y-3">
          {ended ? (
            <p className="text-footnote text-ink-3">
              Last run: {d.autopilot.goal} · {STATUS_COPY[d.autopilot.status].toLowerCase()} {relativeTime(d.autopilot.updatedAt)}
            </p>
          ) : null}
          <MadeForYou detail={d} />
        </div>
      ) : null}

      <CampaignList appId={appId} />
    </div>
  );
}
