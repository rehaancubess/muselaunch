"use client";
import type { Campaign } from "@muselaunch/contracts";
import { Button, EmptyState, List, ListRow, Notice, Section, Skeleton, StatusPill, statusKindOf } from "@muselaunch/ui";
import { Clapperboard, Info, Plus, Rocket } from "lucide-react";
import Link from "next/link";
import { QueryState } from "@/components/states";
import { CreatorFrame } from "@/components/creator/creator-tabs";
import { AgentRunsList } from "@/features/agents";
import { AlwaysOnStatusLine, AlwaysOnWeek, useAlwaysOn } from "@/features/autopilot/always-on";
import { STATUS_COPY, statusKind } from "@/features/autopilot/types";
import { WalkthroughPrompt } from "@/features/media/walkthrough";
import { Composer } from "@/features/today/composer";
import { useActiveAutopilot } from "@/components/shell/autopilot-chip";
import { wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { CHANNEL_LABEL, GOAL_LABEL, campaignStatusLabel, relativeTime } from "@/lib/labels";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useCurrentApp, useWorkspace } from "@/lib/workspace";

function CampaignRows({ items, wid, appId }: { items: Campaign[]; wid: string; appId: string }) {
  const r = routes.app(wid, appId);
  return (
    <List label="Campaigns">
      {items.map((c) => (
        <ListRow
          key={c.id}
          href={r.campaign(c.id)}
          leading={
            <span className="flex size-10 items-center justify-center rounded-lg bg-mist text-ink-2">
              <Clapperboard className="size-[18px]" aria-hidden />
            </span>
          }
          title={c.name}
          subtitle={`${GOAL_LABEL[c.goal]}${c.channels.length ? ` for ${c.channels.map((ch) => CHANNEL_LABEL[ch]).join(", ")}` : ""}, started ${relativeTime(c.createdAt)}`}
          trailing={<StatusPill status={statusKindOf(c.status)}>{campaignStatusLabel(c.status)}</StatusPill>}
        />
      ))}
    </List>
  );
}

/** Autopilot entry: start one, or jump back into the running loop (one per app). */
function AutopilotCard({ workspaceId, appId }: { workspaceId: string; appId: string }) {
  const r = routes.app(workspaceId, appId);
  const active = useActiveAutopilot(workspaceId, appId);
  const always = useAlwaysOn(workspaceId, appId).data;
  const needsYou = active?.status === "awaiting_user";
  return (
    <Link
      href={active ? `${r.autopilot}?loop=${encodeURIComponent(active.id)}` : r.autopilot}
      className="group mb-10 flex flex-col gap-4 rounded-2xl bg-mist/70 p-5 transition-colors hover:bg-mist focus-visible:outline-none focus-visible:shadow-focus sm:flex-row sm:items-center sm:p-6"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-white">
        <Rocket className="size-5" aria-hidden />
      </span>
      {active ? (
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-headline font-semibold text-ink">Autopilot is running</span>
            <StatusPill status={statusKind(active.status)}>{STATUS_COPY[active.status]}</StatusPill>
          </span>
          <span className="block truncate text-body-sm text-ink-2">{active.goal}</span>
          <span className="block text-footnote text-ink-3 text-pretty">{needsYou ? "It’s waiting for a decision from you." : (active.lastLog?.summary ?? "Working within your budget.")}</span>
          {always?.settings.enabled ? <AlwaysOnStatusLine status={always} /> : null}
        </span>
      ) : (
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-headline font-semibold text-ink">Or let Autopilot do it</span>
          <span className="block text-body-sm text-ink-2 text-pretty">
            Give it a goal. It researches your audience with sources, picks what to test, makes and checks the videos, and drafts posts for your approval, within a credit budget you set.
          </span>
          <span className="block text-caption text-ink-3">Planned by Muse Wonder, made with Muse Spark.</span>
        </span>
      )}
      <span className="inline-flex h-9 shrink-0 items-center gap-2 self-start rounded-full bg-ink px-4 text-body-sm font-medium text-white transition-colors group-hover:bg-ink/85 sm:self-center">
        {active ? (needsYou ? "See the decision" : "Open Autopilot") : "Start Autopilot"}
      </span>
    </Link>
  );
}

/**
 * Creator → Make (behind Today, for people who want to steer): plan a campaign yourself, start or
 * open Autopilot, every campaign and the recent AI activity. Today is the Creator tab's first page.
 */
export default function CreatorMakePage() {
  return (
    <CreatorFrame current="make">
      <ManualCreator />
    </CreatorFrame>
  );
}

function ManualCreator() {
  const { app, appId, workspaceId } = useCurrentApp();
  const { can } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const campaigns = useApiQuery<Page<Campaign>>(wsPath(workspaceId, `/apps/${appId}/campaigns`), {
    refetchInterval: (q) => (q.state.data?.items.some((c) => c.status === "planning" || c.status === "producing") ? 5000 : false),
  });
  const appName = app?.name ?? "your app";
  const dnaReady = app?.dnaStatus === "confirmed";

  return (
    <div className="mx-auto max-w-[1120px]">
      <div className="mx-auto max-w-3xl pb-14 pt-2 md:pt-4">
        <h1 className="mb-6 text-center text-title-1 font-semibold text-balance md:text-display">What should we make for {appName}?</h1>
        {can("content.write") ? (
          <Composer appName={appName} href={(t) => (t ? `${r.newCampaign}?request=${encodeURIComponent(t)}` : r.newCampaign)} />
        ) : (
          <Notice>You have view access in this workspace. Ask an owner or admin for editor access to create campaigns.</Notice>
        )}
      </div>

      <AutopilotCard workspaceId={workspaceId} appId={appId} />

      {!dnaReady ? (
        <Notice
          tone={app?.dnaStatus === "failed" ? "danger" : "info"}
          icon={<Info aria-hidden />}
          className="mb-10"
          title={
            app?.dnaStatus === "needs_review"
              ? "Check what we learned about your app"
              : app?.dnaStatus === "drafting" || app?.status === "importing"
                ? "We’re learning about your app"
                : app?.dnaStatus === "failed"
                  ? "We couldn’t finish learning about your app"
                  : "Tell us about your app"
          }
          action={
            <Button size="sm" variant="secondary" asChild>
              <Link href={r.about}>{app?.dnaStatus === "needs_review" ? "Check it" : "Open"}</Link>
            </Button>
          }
        >
          Videos only say things you’ve confirmed. Check your features, audiences and facts first for the best results.
        </Notice>
      ) : null}

      <WalkthroughPrompt workspaceId={workspaceId} appId={appId} variant="card" canWrite={can("content.write")} className="mb-10" />

      <AlwaysOnWeek appId={appId} show="on" className="mb-10" />

      <Section
        title="Campaigns"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href={r.autopilot}>
                <Rocket className="size-3.5" aria-hidden />
                Autopilot
              </Link>
            </Button>
            {can("content.write") ? (
              <Button variant="secondary" size="sm" asChild>
                <Link href={r.newCampaign}>
                  <Plus className="size-3.5" aria-hidden />
                  New campaign
                </Link>
              </Button>
            ) : null}
          </div>
        }
      >
        <QueryState
          query={campaigns}
          feature="Campaigns"
          skeleton={
            <div className="space-y-px overflow-hidden rounded-xl shadow-raised">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 bg-surface px-4 py-3">
                  <Skeleton className="size-10" rounded="lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          }
        >
          {(data) =>
            data.items.length ? (
              <CampaignRows items={data.items} wid={workspaceId} appId={appId} />
            ) : (
              <div className="rounded-2xl bg-mist/60">
                <EmptyState
                  icon={<Clapperboard aria-hidden />}
                  title="No campaigns yet"
                  description="Describe what you want above. We research the market, suggest a few different ideas, then write, plan and make the videos you choose."
                />
              </div>
            )
          }
        </QueryState>
      </Section>

      <Section title="Recent AI activity" description="What MuseLaunch did for this app: plans, sources, tool calls and cost for each run. Planned by Muse Wonder, written by Muse Spark." className="mt-14">
        <AgentRunsList workspaceId={workspaceId} appId={appId} limit={5} />
      </Section>
    </div>
  );
}
