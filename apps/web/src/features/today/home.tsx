"use client";
/**
 * Home: one calm page, top to bottom. While the first run is still making the first videos (nothing
 * drafted yet) it's that run's progress screen with its quick setup (unchanged). After that:
 *
 *   "Your content is ready" + "N posts to review" (or the honest variant: "You're all caught up" +
 *   Create something new)
 *   Next post (video, title, channel, caption, suggested time; Schedule post / Edit / Skip)
 *   Coming up (the other posts on Home and what's already scheduled) + Create something new
 *   Also waiting on you (every other decision: the same cards as Needs you)
 *   Always on (the status line, or one gentle "Keep it going"), and which models made it
 *
 * Data: GET /apps/:appId/today (posts, other decisions), /apps/:appId/calendar (scheduled posts),
 * /apps/:appId/autopilots, /autopilots/:id, /always-on, /needs-you.
 */
import { isPostChangeRunning, type TodayResponse } from "@muselaunch/contracts";
import { Button, Notice, Skeleton } from "@muselaunch/ui";
import { ArrowUpRight, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { DOING, NeedsYouList, useNeedsYou } from "@/features/autopilot/needs-you";
import { MadeWith, RunProgress } from "@/features/autopilot/progress";
import { isActive, isWorking, type AutopilotDetail, type AutopilotListItem } from "@/features/autopilot/types";
import { errorMessage, wsPath } from "@/lib/api";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useCurrentApp, useWorkspace } from "@/lib/workspace";
import { ComingUp } from "./coming-up";
import { homeHeadline } from "./home-lines";
import { NextPostCard } from "./next-post";
import { AlwaysOnLine, KeepItGoing, RecordingOffer } from "./sections";

/** The Meta models MuseLaunch is built on (shown when there's no run yet to name what it really used). */
const BUILT_ON = ["Muse Wonder", "Muse Spark", "Muse Spark Open", "SAM 3.1", "Muse Glimmer"];

function HomeSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-8" aria-busy>
      <div className="space-y-2">
        <Skeleton className="h-9 w-72 max-w-full" rounded="lg" />
        <Skeleton className="h-5 w-40" rounded="lg" />
      </div>
      <Skeleton className="h-64 w-full" rounded="xl" />
      <Skeleton className="h-36 w-full" rounded="xl" />
    </div>
  );
}

export function HomePage() {
  const { appId, workspaceId } = useCurrentApp();
  const { can } = useWorkspace();
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
  const today = useApiQuery<TodayResponse>(wsPath(workspaceId, `/apps/${appId}/today`), {
    refetchInterval: (q) => (q.state.data?.posts.some((p) => isPostChangeRunning(p.change)) ? 3000 : 15_000),
  });
  const needs = useNeedsYou(workspaceId, appId);

  // Keep Home in step with the run (new posts, decisions) as it moves on.
  const status = detail.data?.autopilot.status;
  const stage = detail.data?.autopilot.stage;
  useEffect(() => {
    if (status) void invalidate(wsPath(workspaceId, `/apps/${appId}/today`), wsPath(workspaceId, "/needs-you"));
  }, [status, stage, appId, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps -- useInvalidate returns a new function each render

  if (list.isLoading || (shown && detail.isLoading) || today.isLoading) return <HomeSkeleton />;

  const d = detail.data;
  // The first run is still making the first videos (no posts drafted yet): its own calm progress
  // screen, with the quick setup. Once it waits for results, or has posts, it's Home.
  const s = d?.autopilot.status;
  const firstRun = Boolean(d && s && (list.data?.items.length ?? 0) <= 1 && d.posts.length === 0 && (isWorking(s) || s === "awaiting_user" || s === "paused" || s === "failed"));
  if (d && firstRun) {
    return (
      <div className="pb-6">
        <RunProgress detail={d} needs={needs.data?.items ?? []} first headingLevel={1} detailsHref={`${r.autopilot}?loop=${encodeURIComponent(d.autopilot.id)}&details=1`} />
      </div>
    );
  }

  const posts = today.data?.posts ?? [];
  const [next, ...rest] = posts;
  const others = today.data?.needs ?? [];
  const working = active && isWorking(active.status) ? `Muse is ${DOING[active.stage].toLowerCase()} now. New posts show up here for your OK.` : null;
  const head = homeHeadline(
    posts.map((p) => ({ status: p.status, waiting: Boolean(p.decision), changing: isPostChangeRunning(p.change) })),
    { working: Boolean(working) },
  );
  const canWrite = can("content.write");
  const runLink = shown ? `${r.autopilot}?loop=${encodeURIComponent(shown.id)}&details=1` : null;

  return (
    <div className="mx-auto max-w-3xl space-y-10 pb-6 md:space-y-12">
      <header className="space-y-1.5">
        <h1 className="text-title-2 font-semibold text-ink text-balance md:text-title-1">{head.title}</h1>
        <p className="text-body text-ink-2 md:text-headline md:font-normal" aria-live="polite">
          {head.caughtUp && working ? working : head.sub}
        </p>
        {head.caughtUp && canWrite ? (
          <div className="pt-4">
            <Button size="lg" asChild>
              <Link href={r.create()}>
                <Plus className="size-4" aria-hidden />
                Create something new
              </Link>
            </Button>
          </div>
        ) : null}
      </header>

      {today.error ? <Notice tone="warning">Couldn’t load what’s waiting: {errorMessage(today.error)}</Notice> : null}

      {next ? (
        <section aria-labelledby="home-next">
          <h2 id="home-next" className="sr-only">
            Next post
          </h2>
          <NextPostCard key={next.id} post={next} appId={appId} />
        </section>
      ) : null}

      <ComingUp appId={appId} posts={rest} hasNext={Boolean(next)} showCreate={!head.caughtUp && canWrite} />

      {others.length ? (
        <section aria-labelledby="home-needs" className="space-y-3">
          <div className="space-y-0.5">
            <h2 id="home-needs" className="text-title-3 font-semibold text-ink">
              Also waiting on you
            </h2>
            <p className="text-footnote text-ink-2">Only what Muse never does on its own.</p>
          </div>
          <NeedsYouList items={others} compact />
        </section>
      ) : null}

      <RecordingOffer appId={appId} />

      <footer className="space-y-3 border-t border-line pt-5">
        <AlwaysOnLine appId={appId} />
        <KeepItGoing appId={appId} line />
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
          {d?.progress.madeWith.length ? <MadeWith names={d.progress.madeWith} /> : <p className="text-caption text-ink-3 text-pretty">Built on {BUILT_ON.join(" · ")}</p>}
          {runLink ? (
            <Link href={runLink} className="inline-flex min-h-11 items-center gap-0.5 text-footnote font-medium text-accent hover:underline sm:min-h-0">
              How Muse made these
              <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
