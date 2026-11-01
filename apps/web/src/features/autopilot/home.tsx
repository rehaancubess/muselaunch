"use client";
/**
 * The app's Home when Autopilot is on (the Creator tab opens here), outcome first: the current run
 * as plain steps with real results, the videos it made (play, download, post), what needs you and
 * what it's testing. The decision log, stage rail and model calls are one tap away ("Show details"
 * opens the run's page). No run going: a one-tap start with defaults. Data: /apps/:appId/autopilots,
 * /autopilots/:id, /apps/:appId/autopilot/auto, /needs-you?appId=, /apps/:appId/campaigns.
 */
import type { Campaign } from "@muselaunch/contracts";
import { Button, List, ListRow, Skeleton, StatusPill, statusKindOf } from "@muselaunch/ui";
import { Clapperboard, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { GOAL_LABEL, campaignStatusLabel, relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { NeedsYouList, useNeedsYou } from "./needs-you";
import { RunProgress, runNeeds } from "./progress";
import { StartCard } from "./start-card";
import { isActive, isWorking, type AutopilotDetail, type AutopilotListItem } from "./types";

function CampaignList({ appId }: { appId: string }) {
  const { workspaceId, can } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const campaigns = useApiQuery<Page<Campaign>>(wsPath(workspaceId, `/apps/${appId}/campaigns`));
  const items = campaigns.data?.items ?? [];
  return (
    <section className="space-y-4" aria-labelledby="your-campaigns">
      <div className="flex flex-wrap items-end justify-between gap-3">
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
        <p className="text-body-sm text-ink-2">Campaigns Autopilot makes show up here. You can also plan one yourself.</p>
      )}
    </section>
  );
}

function RunSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_320px]" aria-busy>
      <div className="space-y-6">
        <Skeleton className="h-8 w-2/3" rounded="lg" />
        <Skeleton className="h-64 w-full" rounded="xl" />
      </div>
      <Skeleton className="mx-auto aspect-[9/16] w-full max-w-[300px]" rounded="xl" />
    </div>
  );
}

/** Autopilot Home: the run (or a one-tap start), what needs you, the campaigns. */
export function AutopilotHome({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const invalidate = useInvalidate();
  const r = routes.app(workspaceId, appId);
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
  const stage = detail.data?.autopilot.stage;
  useEffect(() => {
    if (status) void invalidate(wsPath(workspaceId, "/needs-you"), wsPath(workspaceId, `/apps/${appId}/autopilots`));
  }, [status, stage, appId, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps -- useInvalidate returns a new function each render

  if (list.isLoading || (shown && detail.isLoading)) return <RunSkeleton />;
  const d = detail.data;
  const ran = d ? runNeeds(d, needItems) : [];
  const others = needItems.filter((i) => !ran.includes(i));
  const ended = !active;
  const showRun = d && (!ended || d.autopilot.status === "failed" || d.progress.videos.length > 0);
  return (
    <div className="space-y-12">
      {d && showRun ? <RunProgress detail={d} needs={needItems} first={(list.data?.items.length ?? 0) <= 1} headingLevel={2} detailsHref={`${r.autopilot}?loop=${encodeURIComponent(d.autopilot.id)}&details=1`} /> : null}

      {others.length ? (
        <section className="space-y-4" aria-labelledby="needs-you">
          <div className="space-y-0.5">
            <h2 id="needs-you" className="flex items-center gap-2 text-headline font-semibold">
              {ran.length ? "Also needs you" : "Needs you"}
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-semibold tabular text-white">{others.length}</span>
            </h2>
            <p className="text-footnote text-ink-2">Only what MuseLaunch never does on its own: posting, outreach and spending past a run’s budget.</p>
          </div>
          <NeedsYouList items={others} />
        </section>
      ) : null}

      {ended && d?.autopilot.status !== "failed" ? <StartCard appId={appId} again={Boolean(latest)} /> : null}
      {ended && d?.autopilot.status === "failed" ? (
        <p className="text-footnote text-ink-2">
          Rather start over?{" "}
          <Link href={`${r.autopilot}?new=1`} className="font-medium text-accent hover:underline">
            Start a new run
          </Link>
        </p>
      ) : null}

      <CampaignList appId={appId} />
    </div>
  );
}
