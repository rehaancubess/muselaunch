"use client";
/**
 * Creator → Today: one calm page, top to bottom. While the first run is still making the first
 * videos it's that run's progress screen (unchanged). After that:
 *
 *   Next post (big: video, caption, when and where; Looks good / Change / Skip) + "Then:"
 *   Needs you (everything else waiting on the person, the same cards as the Needs you tab)
 *   How it's going (one line, up to 3 measured numbers) → Insights
 *   Muse found (the top 1–2 ideas) → Discover
 *   Your videos (the newest finished videos) → Videos, Scheduled
 *   Keep it going (Always on is off) — or the Always-on status line under the title when it's on
 *
 * The run's log, what it's testing, campaigns and step rails stay one tap away ("Details", Make).
 * Data: GET /apps/:appId/today (posts, other decisions, videos), /apps/:appId/autopilots,
 * /autopilots/:id, /always-on, /insights/overview, /discover/feed.
 */
import { isPostChangeRunning, type TodayResponse } from "@muselaunch/contracts";
import { Notice, Skeleton } from "@muselaunch/ui";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppIcon } from "@/components/app-icon";
import { DOING, NeedsYouList, useNeedsYou } from "@/features/autopilot/needs-you";
import { MadeWith, RunProgress } from "@/features/autopilot/progress";
import { isActive, isWorking, type AutopilotDetail, type AutopilotListItem } from "@/features/autopilot/types";
import { WalkthroughPrompt } from "@/features/media/walkthrough";
import { errorMessage, wsPath } from "@/lib/api";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useCurrentApp, useWorkspace } from "@/lib/workspace";
import { Composer } from "./composer";
import { NextPostCard, ThenList } from "./next-post";
import { AllClear, AlwaysOnLine, HowItsGoing, KeepItGoing, MuseFound, SectionHead, YourVideos } from "./sections";

function TodaySkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-8" aria-busy>
      <Skeleton className="h-10 w-48" rounded="lg" />
      <Skeleton className="h-72 w-full" rounded="xl" />
      <Skeleton className="h-24 w-full" rounded="xl" />
    </div>
  );
}

export function TodayPage() {
  const { app, appId, workspaceId } = useCurrentApp();
  const { workspace, can } = useWorkspace();
  const invalidate = useInvalidate();
  const r = routes.app(workspaceId, appId);
  const autopilotOn = workspace?.settings.autopilot?.enabled ?? true;
  const appName = app?.name && app.name !== "New app" ? app.name : "your app";

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
  const today = useApiQuery<TodayResponse>(wsPath(workspaceId, `/apps/${appId}/today`), {
    refetchInterval: (q) => (q.state.data?.posts.some((p) => isPostChangeRunning(p.change)) ? 3000 : 15_000),
  });
  const needs = useNeedsYou(workspaceId, appId);
  const [picked, setPicked] = useState<string | null>(null);

  // Keep Today in step with the run (new posts, decisions) as it moves on.
  const status = detail.data?.autopilot.status;
  const stage = detail.data?.autopilot.stage;
  useEffect(() => {
    if (status) void invalidate(wsPath(workspaceId, `/apps/${appId}/today`), wsPath(workspaceId, "/needs-you"));
  }, [status, stage, appId, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps -- useInvalidate returns a new function each render

  if (list.isLoading || (shown && detail.isLoading) || today.isLoading) return <TodaySkeleton />;

  const d = detail.data;
  // The first run is still making the first videos: its own calm progress screen, as before.
  const firstRun = Boolean(d && (list.data?.items.length ?? 0) <= 1 && d.progress.videos.length === 0 && (isActive(d.autopilot.status) || d.autopilot.status === "failed"));
  if (d && firstRun) {
    return (
      <div className="pb-6">
        <RunProgress detail={d} needs={needs.data?.items ?? []} first headingLevel={1} detailsHref={`${r.autopilot}?loop=${encodeURIComponent(d.autopilot.id)}&details=1`} />
      </div>
    );
  }

  const posts = today.data?.posts ?? [];
  const next = posts.find((p) => p.id === picked) ?? posts[0];
  const rest = posts.filter((p) => p.id !== next?.id);
  const others = today.data?.needs ?? [];
  const working = active && isWorking(active.status) ? `Muse is ${DOING[active.stage].toLowerCase()} now. New posts show up here for your OK.` : null;
  const runLink = shown ? `${r.autopilot}?loop=${encodeURIComponent(shown.id)}&details=1` : r.autopilot;

  return (
    <div className="mx-auto max-w-3xl space-y-10 pb-6 md:space-y-12">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <AppIcon app={app} workspaceId={workspaceId} size={40} />
          <div className="min-w-0">
            <h1 className="text-title-2 font-semibold text-ink md:text-title-1">Today</h1>
            <p className="truncate text-footnote text-ink-2">{appName}</p>
          </div>
        </div>
        <AlwaysOnLine appId={appId} />
      </header>

      {today.error ? <Notice tone="warning">Couldn’t load what’s waiting: {errorMessage(today.error)}</Notice> : null}

      <section aria-labelledby="today-next" className="space-y-3">
        {next ? (
          <>
            <SectionHead id="today-next" title="Next post">
              {posts.length > 1 ? <p className="text-footnote text-ink-2">{posts.length} posts are waiting for you.</p> : null}
            </SectionHead>
            <NextPostCard key={next.id} post={next} appId={appId} />
            <ThenList posts={rest} onPick={setPicked} />
          </>
        ) : (
          <>
            <h2 id="today-next" className="sr-only">
              Next post
            </h2>
            <AllClear appId={appId} working={working} />
          </>
        )}
      </section>

      {!autopilotOn && can("content.write") ? (
        <section aria-labelledby="today-make" className="space-y-3">
          <SectionHead id="today-make" title={`Make something for ${appName}`} href={r.make} more="Campaigns" />
          <Composer appName={appName} href={(t) => (t ? `${r.newCampaign}?request=${encodeURIComponent(t)}` : r.newCampaign)} />
        </section>
      ) : null}

      {others.length ? (
        <section aria-labelledby="today-needs" className="space-y-3">
          <SectionHead id="today-needs" title="Also needs you" href={routes.needsYou(workspaceId, appId)} more="Needs you">
            <p className="text-footnote text-ink-2">Only what Muse never does on its own.</p>
          </SectionHead>
          <NeedsYouList items={others} compact />
        </section>
      ) : null}

      <HowItsGoing appId={appId} />
      <MuseFound appId={appId} />
      <YourVideos appId={appId} videos={today.data?.videos ?? []} />
      <KeepItGoing appId={appId} />
      <WalkthroughPrompt workspaceId={workspaceId} appId={appId} variant="card" canWrite={can("content.write")} />

      <footer className="space-y-3 border-t border-line pt-5">
        {d ? <MadeWith names={d.progress.madeWith} /> : null}
        <nav aria-label="More in Creator" className="flex flex-wrap items-center gap-x-5 gap-y-1 text-footnote">
          <Link href={runLink} className="inline-flex min-h-11 items-center gap-0.5 font-medium text-accent hover:underline sm:min-h-0">
            Details
            <ArrowUpRight className="size-3" aria-hidden />
          </Link>
          <Link href={r.make} className="inline-flex min-h-11 items-center text-ink-2 hover:text-ink sm:min-h-0">
            Make
          </Link>
          <Link href={r.videos} className="inline-flex min-h-11 items-center text-ink-2 hover:text-ink sm:min-h-0">
            Videos
          </Link>
          <Link href={r.scheduled} className="inline-flex min-h-11 items-center text-ink-2 hover:text-ink sm:min-h-0">
            Scheduled
          </Link>
        </nav>
      </footer>
    </div>
  );
}
