"use client";
/**
 * Today's smaller sections, each a summary of a page that already exists, with "See more":
 *  - How it's going: one plain line and up to 3 measured numbers (insights simple-lines), or one line
 *    when nothing is measured yet. Never estimated.
 *  - Muse found: the top 1–2 ideas (discover picks), each with Make a video.
 *  - Your videos: the newest finished videos in a row → the Studio; "All videos" and "Scheduled".
 *  - Always on: the status line with "Change" (the pace, in place), or one gentle "Keep it going".
 */
import type { InsightsOverview, TodayVideo } from "@muselaunch/contracts";
import { Button, Dialog, Skeleton, cn } from "@muselaunch/ui";
import { ArrowRight, CalendarClock, Clapperboard, Play, Repeat } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { AlwaysOnSettings, AlwaysOnStatusLine, useAlwaysOn } from "@/features/autopilot/always-on";
import { topPicks, type FeedResponse } from "@/features/discover/picks";
import { IdeaCard } from "@/features/discover/simple";
import { fmtNumber } from "@/features/insights/shared";
import { bigNumbers, plainMetricLabel, plainSource } from "@/features/insights/simple-lines";
import { wsPath } from "@/lib/api";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A section heading with its "See more" link. */
export function SectionHead({ id, title, href, more = "See more", children }: { id: string; title: string; href?: string; more?: string; children?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <h2 id={id} className="text-headline font-semibold text-ink">
          {title}
        </h2>
        {children}
      </div>
      {href ? (
        <Link href={href} className="inline-flex min-h-11 shrink-0 items-center gap-1 text-footnote font-medium text-accent hover:underline">
          {more}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// How it's going
// ---------------------------------------------------------------------------

/** "In the last 28 days: 1,240 views, 38 link clicks and 12 installs." from measured numbers only. */
export function howLine(names: string[]): string {
  if (!names.length) return "";
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `In the last 28 days: ${list}.`;
}

export function HowItsGoing({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const query = useMemo(() => {
    const now = Date.now();
    return { from: isoDay(now - 27 * DAY), to: isoDay(now), compare: "prev" };
  }, []);
  const overview = useApiQuery<InsightsOverview>(wsPath(workspaceId, `/apps/${appId}/insights/overview`), { query, staleTime: 60_000, retry: false });
  const shown = overview.data ? bigNumbers(overview.data.metrics) : [];
  const r = routes.app(workspaceId, appId);
  return (
    <section aria-labelledby="today-how" className="space-y-3">
      <SectionHead id="today-how" title="How it’s going" href={r.insights} />
      {overview.isLoading ? (
        <Skeleton className="h-20 w-full" rounded="xl" />
      ) : shown.length ? (
        <>
          <p className="text-body-sm text-ink-2">{howLine(shown.map((m) => (m.value !== null ? `${fmtNumber(m.value, m.unit, m.currency)} ${plainMetricLabel(m).toLowerCase()}` : plainMetricLabel(m).toLowerCase())))}</p>
          <dl className={cn("grid gap-2", shown.length === 1 ? "grid-cols-1" : shown.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
            {shown.map((m) => (
              <div key={m.metric} className="min-w-0 rounded-xl bg-surface px-3 py-3 shadow-raised sm:px-4">
                <dt className="truncate text-caption text-ink-2">{plainMetricLabel(m)}</dt>
                <dd className="text-title-3 font-semibold tabular text-ink">{m.value !== null ? fmtNumber(m.value, m.unit, m.currency) : (m.byCurrency ?? []).map((c) => fmtNumber(c.value, "currency", c.currency)).join(" · ")}</dd>
                {plainSource(m) ? <dd className="truncate text-caption text-ink-3">{plainSource(m)}</dd> : null}
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="rounded-xl bg-mist/60 px-4 py-3 text-body-sm text-ink-2 text-pretty">Nothing measured yet. Real views, clicks and installs show up here once a post is out. Muse never guesses a number.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Muse found
// ---------------------------------------------------------------------------

export function MuseFound({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const feed = useApiQuery<FeedResponse>(wsPath(workspaceId, `/apps/${appId}/discover/feed`), { query: { limit: 50 }, staleTime: 60_000, retry: false });
  const picks = topPicks(feed.data?.items ?? [], 2);
  const r = routes.app(workspaceId, appId);
  if (feed.isLoading) return <Skeleton className="h-40 w-full" rounded="xl" />;
  return (
    <section aria-labelledby="today-found" className="space-y-3">
      <SectionHead id="today-found" title="Muse found" href={r.discover} />
      {picks.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {picks.map((item) => (
            <IdeaCard key={item.id} item={item} appId={appId} compact />
          ))}
        </div>
      ) : (
        <p className="rounded-xl bg-mist/60 px-4 py-3 text-body-sm text-ink-2 text-pretty">No new ideas right now. Discover has everything Muse found, each with where it was found.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Your videos
// ---------------------------------------------------------------------------

function VideoTile({ v, href }: { v: TodayVideo; href: string }) {
  const { workspaceId } = useWorkspace();
  const poster = useAssetUrl(workspaceId, v.posterAssetId);
  const ratio = v.width && v.height && v.width > v.height ? "aspect-video w-[200px]" : v.width && v.height && v.width === v.height ? "aspect-square w-[132px]" : "aspect-[9/16] w-[112px] sm:w-[128px]";
  return (
    <Link href={href} className="group block shrink-0 snap-start space-y-1.5 rounded-xl focus-visible:outline-none focus-visible:shadow-focus" title={v.title}>
      <span className={cn("relative block overflow-hidden rounded-xl bg-ink shadow-raised", ratio)}>
        {poster.data?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster.data.url} alt="" className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        ) : null}
        <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <span className="flex size-9 items-center justify-center rounded-full bg-white/90 text-ink">
            <Play className="ml-0.5 size-4 fill-current" aria-hidden />
          </span>
        </span>
        {v.durationSec ? <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-medium tabular text-white">{Math.round(v.durationSec)}s</span> : null}
      </span>
      <span className={cn("line-clamp-2 text-caption text-ink-2 group-hover:text-ink", ratio.replace(/aspect-\S+/, "").trim())}>{v.title}</span>
    </Link>
  );
}

export function YourVideos({ appId, videos }: { appId: string; videos: TodayVideo[] }) {
  const { workspaceId } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  return (
    <section aria-labelledby="today-videos" className="space-y-3">
      <SectionHead id="today-videos" title="Your videos" href={r.videos} more="All videos" />
      {videos.length ? (
        <ul aria-label="Your newest videos" className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
          {videos.map((v) => (
            <li key={v.compositionId}>
              <VideoTile v={v} href={r.studio(v.compositionId)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl bg-mist/60 px-4 py-3 text-body-sm text-ink-2">Finished videos show up here.</p>
      )}
      <Link href={r.scheduled} className="inline-flex min-h-11 items-center gap-2 text-footnote font-medium text-ink-2 hover:text-ink">
        <CalendarClock className="size-4 text-ink-3" aria-hidden />
        Scheduled posts
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Always on
// ---------------------------------------------------------------------------

function PaceDialog({ appId, open, onOpenChange, title }: { appId: string; open: boolean; onOpenChange: (o: boolean) => void; title: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description="How often Muse makes new posts for you. Every post still waits for your OK." size="lg">
      <AlwaysOnSettings appId={appId} />
    </Dialog>
  );
}

/** "Always on · 3 posts a week · next post Mon 7 PM" + Change (in the page header). */
export function AlwaysOnLine({ appId }: { appId: string }) {
  const { workspaceId, can } = useWorkspace();
  const q = useAlwaysOn(workspaceId, appId);
  const [open, setOpen] = useState(false);
  if (!q.data?.settings.enabled) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <AlwaysOnStatusLine status={q.data} />
      {can("content.write") ? (
        <button type="button" onClick={() => setOpen(true)} className="min-h-11 text-footnote font-medium text-accent hover:underline sm:min-h-0">
          Change
        </button>
      ) : null}
      <PaceDialog appId={appId} open={open} onOpenChange={setOpen} title="Always on" />
    </div>
  );
}

/** Always on is off: one gentle offer. */
export function KeepItGoing({ appId }: { appId: string }) {
  const { workspaceId, can } = useWorkspace();
  const q = useAlwaysOn(workspaceId, appId);
  const [open, setOpen] = useState(false);
  if (!q.data || q.data.settings.enabled || !can("content.write")) return null;
  return (
    <section aria-labelledby="today-keep" className="flex flex-col gap-3 rounded-2xl bg-mist/70 p-4 sm:flex-row sm:items-center sm:p-5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface text-accent shadow-raised">
        <Repeat className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="today-keep" className="text-body font-semibold text-ink">
          Keep it going
        </h2>
        <p className="text-footnote text-ink-2 text-pretty">Muse researches every week and keeps a week of posts ready. You still OK every one.</p>
      </div>
      <Button size="lg" variant="outline" onClick={() => setOpen(true)} className="sm:shrink-0">
        Keep it going
      </Button>
      <PaceDialog appId={appId} open={open} onOpenChange={setOpen} title="Keep it going" />
    </section>
  );
}

/** Nothing waiting: a calm line, with the way to make something new. */
export function AllClear({ appId, working }: { appId: string; working?: string | null }) {
  const { workspaceId, can } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  return (
    <section aria-label="Nothing waiting" className="flex flex-col gap-3 rounded-2xl bg-surface p-5 shadow-raised sm:flex-row sm:items-center sm:p-6">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-title-3 font-semibold text-ink">{working ? "Muse is working on your next posts" : "Nothing needs you right now"}</p>
        <p className="text-body-sm text-ink-2 text-pretty">{working ?? "New posts show up here for your OK. Nothing goes out without you."}</p>
      </div>
      {can("content.write") ? (
        <Button size="lg" variant="secondary" asChild className="sm:shrink-0">
          <Link href={r.make}>
            <Clapperboard className="size-4" aria-hidden />
            Make something new
          </Link>
        </Button>
      ) : null}
    </section>
  );
}
