"use client";
/**
 * Discover → "What Muse found": the one job of the main Discover page. A short intro, one
 * "Look again" button (the same cited Muse Wonder research as Research market, with its live
 * progress and when it last ran), the ~5 best ideas for this app as big plain cards (title, why it
 * fits, the real source, Make a video / Not for me), the accounts you follow, and one link to
 * "See everything" (./index.tsx: every finding, filters, saved ideas, creators) so nothing is lost.
 *
 * Data: GET /apps/:appId/discover/feed (ranked by relevance × freshness), /research (latest run),
 * /trackers/stories. Actions: POST /research, /opportunities/:id/{campaign,dismiss,restore}.
 */
import type { Job, ResearchRun } from "@muselaunch/contracts";
import { Avatar, Button, JobProgress, Skeleton, Spinner, cn, useToast } from "@muselaunch/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Clapperboard, Compass, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import type { CreateResearchResponse, Page } from "@/lib/api-types";
import { fetchEstimate } from "@/lib/estimate";
import { useJob } from "@/lib/jobs";
import { CHANNEL_LABEL, relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { isUsed, primarySource, siteName, topPicks, whyLine, type FeedItem, type FeedResponse } from "./picks";
import { AddTrackerDialog, TrackerSheet, type StoryRowItem } from "./trackers";

/** What "Look again" asks Muse Wonder to look into (Research market's default areas). */
const LOOK_AGAIN_KINDS = ["opportunities", "trends", "competitors"] as const;

export default function SimpleDiscover({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const feed = useApiQuery<FeedResponse>(wsPath(workspaceId, `/apps/${appId}/discover/feed`), { query: { limit: 50 } });
  const research = useLookAgain(appId);
  const picks = topPicks(feed.data?.items ?? []);
  const total = feed.data ? feed.data.items.length + (feed.data.nextCursor ? 1 : 0) : 0;

  return (
    <div className="space-y-12">
      <LookAgainBar research={research} />

      <section aria-label="Ideas for your app" className="space-y-4">
        {feed.isLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-48 w-full" rounded="xl" />
            ))}
          </div>
        ) : feed.error ? (
          <div className="rounded-2xl bg-mist/70 px-6 py-10 text-center">
            <p className="text-headline font-semibold">Couldn’t load what Muse found</p>
            <p className="mt-1 text-body-sm text-ink-2">{errorMessage(feed.error)}</p>
            <Button className="mt-4" size="lg" variant="outline" onClick={() => void feed.refetch()} loading={feed.isFetching}>
              Try again
            </Button>
          </div>
        ) : picks.length ? (
          picks.map((item) => <IdeaCard key={item.id} item={item} appId={appId} />)
        ) : (
          <NothingYet looking={research.running} hasOther={total > 0} />
        )}
      </section>

      <FollowedAccounts appId={appId} />

      <div className="flex flex-col gap-3 border-t border-line pt-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-body-sm text-ink-2">{total > picks.length ? `Every finding (${total > 50 ? "more than 50" : total} in all), with filters, saved ideas and creators.` : "Every finding, with filters, saved ideas and creators."}</p>
        <Button asChild size="lg" variant="outline">
          <Link href={routes.app(workspaceId, appId).discoverAll}>
            See everything
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Look again: the existing research action, one tap, honest progress
// ---------------------------------------------------------------------------

function useLookAgain(appId: string) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const idem = useRef(newIdempotencyKey("research"));
  const [started, setStarted] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  // A run started elsewhere (Autopilot, Research market on See everything) shows its progress here too.
  const runs = useApiQuery<Page<ResearchRun>>(wsPath(workspaceId, `/apps/${appId}/research`), { query: { limit: 1 }, refetchInterval: 30_000 });
  const latest = runs.data?.items[0];
  const latestActive = latest && (latest.status === "queued" || latest.status === "running") ? latest : null;
  const jobId = started?.id ?? latestActive?.jobId ?? null;
  const live = useJob(workspaceId, jobId, {
    initial: started,
    onSettled: (j) => {
      void invalidate(wsPath(workspaceId, `/apps/${appId}`));
      if (j.status === "succeeded") toast.success("Muse looked again", "Anything new is on this page, each idea with where Muse found it.");
    },
  });
  const estimate = useQuery({ queryKey: ["estimate", workspaceId, "research.run"], queryFn: () => fetchEstimate(workspaceId, { operation: "research.run", params: {} }), staleTime: 60_000, retry: false });
  // The job being followed: the live one once it reports, else what the start call returned (the
  // stream's first update can lag). A run without a job yet can't be followed (or cancelled).
  const job = live.job && live.job.id === jobId ? live.job : started && started.id === jobId ? started : null;
  const status = job?.status ?? (latestActive?.jobId ? "queued" : null);
  const running = starting || status === "queued" || status === "running";

  const start = async () => {
    setStarting(true);
    try {
      const r = await api.post<CreateResearchResponse>(wsPath(workspaceId, `/apps/${appId}/research`), { kinds: [...LOOK_AGAIN_KINDS] }, { idempotencyKey: idem.current });
      idem.current = newIdempotencyKey("research");
      setStarted(r.job);
      void invalidate(wsPath(workspaceId, `/apps/${appId}/research`));
    } catch (e) {
      toast.error("Muse couldn’t start looking", errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return {
    canRun: can("content.write"),
    start,
    running,
    starting,
    live,
    job,
    latest,
    estimate: estimate.data ?? null,
  };
}

function LookAgainBar({ research }: { research: ReturnType<typeof useLookAgain> }) {
  const { latest, live, job, running, estimate } = research;
  const short = estimate ? estimate.credits > estimate.available : false;
  const showProgress = Boolean(job && (running || job.status === "failed"));
  const done = latest && latest.status !== "queued" && latest.status !== "running" ? latest : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {research.canRun ? (
          <Button size="lg" icon={running ? <Spinner size={16} className="text-current" /> : <RefreshCw className="size-4" aria-hidden />} onClick={() => void research.start()} disabled={running || short}>
            {running ? "Looking…" : "Look again"}
          </Button>
        ) : null}
        <p className="text-footnote text-ink-2">
          {running ? (
            "Muse is checking what’s working for apps like yours. This takes a minute or two."
          ) : done ? (
            `Last looked ${relativeTime(done.completedAt ?? done.createdAt)}`
          ) : (
            "Muse hasn’t looked yet."
          )}
          {!running && estimate && research.canRun ? (
            <>
              <span className="hidden sm:inline"> · </span>
              <span className="block sm:inline">{short ? "Not enough credits to look again" : `Uses about ${estimate.credits} credits`}</span>
            </>
          ) : null}
        </p>
      </div>
      {showProgress ? (
        <div className="rounded-xl bg-mist/70 px-4 py-3">
          <JobProgress job={job} title="Looking for ideas" variant="row" onCancel={() => void live.cancel()} cancelling={live.cancelling} onRetry={() => void live.retry()} retrying={live.retrying} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One idea: title, why it fits, where it was found, two actions
// ---------------------------------------------------------------------------

/** One idea card (also on Creator → Today, `compact`: smaller heading and padding). */
export function IdeaCard({ item, appId, compact }: { item: FeedItem; appId: string; compact?: boolean }) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState<"video" | "dismiss" | null>(null);
  const source = primarySource(item);
  const why = whyLine(item);
  const channels = item.channels.slice(0, 2).map((c) => CHANNEL_LABEL[c]);
  const path = (action: string) => wsPath(workspaceId, `/apps/${appId}/opportunities/${item.refId}/${action}`);

  const makeVideo = async () => {
    setBusy("video");
    try {
      const r = await api.post<{ campaign?: { id: string } }>(path("campaign"), {}, { idempotent: true });
      await invalidate(wsPath(workspaceId, `/apps/${appId}/discover`));
      if (r.campaign) router.push(routes.app(workspaceId, appId).campaign(r.campaign.id));
    } catch (e) {
      toast.error("Couldn’t start the video", errorMessage(e));
      setBusy(null);
    }
  };
  const notForMe = async () => {
    setBusy("dismiss");
    try {
      await api.post(path("dismiss"), {}, { idempotent: true });
      await invalidate(wsPath(workspaceId, `/apps/${appId}/discover`));
      toast.toast({
        title: "Hidden",
        description: "Muse won’t show this idea here again.",
        tone: "neutral",
        action: {
          label: "Undo",
          onClick: () => {
            void api
              .post(path("restore"), {}, { idempotent: true })
              .then(() => invalidate(wsPath(workspaceId, `/apps/${appId}/discover`)))
              .catch((e) => toast.error("Couldn’t bring it back", errorMessage(e)));
          },
        },
      });
    } catch (e) {
      toast.error("That didn’t work", errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <article aria-label={item.title} className={cn("space-y-4 rounded-2xl bg-surface shadow-raised", compact ? "p-4 sm:p-5" : "p-5 sm:p-6")}>
      <div className="space-y-2">
        {channels.length ? <p className="text-footnote font-medium text-ink-2">For {channels.join(" and ")}</p> : null}
        {compact ? <h3 className="text-headline font-semibold text-ink text-balance">{item.title}</h3> : <h2 className="text-title-3 font-semibold text-ink text-balance">{item.title}</h2>}
        {why ? (
          <p className="text-body text-ink-2 text-pretty">
            <span className="font-medium text-ink">Why it fits your app: </span>
            {why}
          </p>
        ) : null}
      </div>
      {source ? (
        source.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="group flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg bg-mist/70 px-3 py-2 text-footnote text-ink-2 hover:bg-mist focus-visible:outline-none focus-visible:shadow-focus"
            title={source.title ?? source.url}
          >
            <Compass className="size-4 shrink-0 text-ink-2" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              Found on <span className="font-medium text-ink">{siteName(source)}</span>
              {source.title ? <span className="text-ink-2"> · {source.title}</span> : null}
            </span>
            <ArrowUpRight className="size-4 shrink-0 text-ink-2 group-hover:text-ink" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          <p className="flex min-h-11 items-center gap-2 rounded-lg bg-mist/70 px-3 py-2 text-footnote text-ink-2">
            <Compass className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
              Found in <span className="font-medium text-ink">{siteName(source)}</span>
            </span>
          </p>
        )
      ) : null}
      {isUsed(item) ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button asChild size="lg" variant="secondary">
            <Link href={routes.app(workspaceId, appId).campaign(item.campaignId!)}>
              <Clapperboard className="size-4" aria-hidden />
              See its videos
            </Link>
          </Button>
          <p className="text-footnote text-ink-2">Muse already made videos from this idea.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" icon={<Clapperboard className="size-4" aria-hidden />} onClick={() => void makeVideo()} loading={busy === "video"} disabled={!can("content.write") || busy !== null}>
            Make a video
          </Button>
          <Button size="lg" variant="ghost" onClick={() => void notForMe()} loading={busy === "dismiss"} disabled={!can("content.write") || busy !== null}>
            Not for me
          </Button>
        </div>
      )}
    </article>
  );
}

function NothingYet({ looking, hasOther }: { looking: boolean; hasOther: boolean }) {
  return (
    <div className="rounded-2xl bg-mist/70 px-6 py-12 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-surface text-ink-2 shadow-raised">{looking ? <Spinner size={18} /> : <Compass className="size-5" aria-hidden />}</div>
      <p className="mt-4 text-headline font-semibold text-ink">{looking ? "Muse is looking" : hasOther ? "No new ideas right now" : "Nothing here yet"}</p>
      <p className="mx-auto mt-1.5 max-w-md text-body-sm text-ink-2 text-pretty">
        {looking
          ? "Ideas for your app appear here as soon as they’re found, each one with the page it came from."
          : hasOther
            ? "You’ve hidden the ideas Muse had. Tap Look again for fresh ones, or see everything Muse found."
            : "Tap Look again and Muse checks what’s working for apps like yours. Every idea links to where it was found."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accounts you follow (the stories row, simplified)
// ---------------------------------------------------------------------------

function FollowedAccounts({ appId }: { appId: string }) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [checkJob, setCheckJob] = useState<Job | null>(null);
  const stories = useApiQuery<{ items: StoryRowItem[] }>(wsPath(workspaceId, `/apps/${appId}/trackers/stories`));
  const live = useJob(workspaceId, checkJob?.id, { initial: checkJob, onSettled: () => void invalidate(wsPath(workspaceId, `/apps/${appId}`), wsPath(workspaceId, "/trackers")) });
  const items = stories.data?.items ?? [];

  const check = async (ids: string[]) => {
    try {
      const r = await api.post<{ job: Job }>(wsPath(workspaceId, `/apps/${appId}/trackers/refresh`), { trackedCreatorIds: ids }, { idempotent: true });
      setCheckJob(r.job);
    } catch (e) {
      toast.error("Couldn’t check that account", errorMessage(e));
    }
  };

  return (
    <section aria-labelledby="following-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="following-heading" className="text-headline font-semibold">
          Accounts you follow
        </h2>
        <p className="text-body-sm text-ink-2">{items.length ? "Tap one to see what they’ve been posting." : "Follow competitors or creators you like, and Muse keeps an eye on what they post."}</p>
      </div>
      {stories.isLoading ? (
        <div className="flex gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="size-16" rounded="full" />
          ))}
        </div>
      ) : items.length ? (
        <ul aria-label="Accounts you follow" className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((s) => (
            <li key={s.id} className="snap-start">
              <button
                type="button"
                onClick={() => setOpen(s.id)}
                title={`${s.displayName} on ${CHANNEL_LABEL[s.channel]}`}
                className="group flex w-[76px] flex-col items-center gap-1.5 rounded-xl py-1 focus-visible:outline-none focus-visible:shadow-focus"
              >
                <span className={cn("flex size-16 items-center justify-center rounded-full p-[2.5px]", s.hasRecent ? "bg-[conic-gradient(from_200deg,var(--ml-accent),#c4a8ff,var(--ml-accent))]" : "bg-line-strong")}>
                  <span className="flex size-full items-center justify-center rounded-full bg-surface p-[2px]">
                    <Avatar name={s.displayName} size={54} />
                  </span>
                </span>
                <span className="w-full truncate text-center text-caption text-ink">{s.displayName}</span>
                <span className="sr-only">{s.hasRecent ? ", new posts" : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {checkJob ? <JobProgress job={live.job} title="Checking what they posted" variant="row" onCancel={() => void live.cancel()} /> : null}
      {can("content.write") ? (
        <Button size="lg" variant="outline" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>
          Follow an account
        </Button>
      ) : null}
      <AddTrackerDialog appId={appId} open={adding} onOpenChange={setAdding} />
      <TrackerSheet trackerId={open} onOpenChange={(o) => (o ? null : setOpen(null))} onRefresh={(ids) => void check(ids)} />
    </section>
  );
}
