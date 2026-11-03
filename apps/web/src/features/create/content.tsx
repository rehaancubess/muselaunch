"use client";
/**
 * Create → Your content: the videos being made (their step and progress, or "Needs you") and the
 * finished ones, newest first: the poster (the frame where the hook is fully on screen), a play
 * button and the length. A video opens the simple Studio (Tell Muse, Edit in detail); Post it opens
 * the existing new-post flow (a draft that waits for approval). All videos / Scheduled one tap away.
 */
import { Skeleton, cn } from "@muselaunch/ui";
import { ArrowRight, CalendarClock, Clapperboard, Play, Send } from "lucide-react";
import Link from "next/link";
import { useAssetUrl } from "@/components/app-icon";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { STEP_LABEL, clock, isWait, type FinishedVideo } from "./plan";
import type { CreateRun } from "./runs";

const TILE = "relative block aspect-[9/16] w-full overflow-hidden rounded-xl";

function VideoTile({ video, href, onPost, canPost }: { video: FinishedVideo; href: string; onPost: () => void; canPost: boolean }) {
  const { workspaceId } = useWorkspace();
  const poster = useAssetUrl(workspaceId, video.posterAssetId);
  const vertical = !(video.width && video.height) || video.height > video.width;
  return (
    <li className="min-w-0 space-y-2">
      <Link href={href} className={cn(TILE, "group bg-ink shadow-raised focus-visible:outline-none focus-visible:shadow-focus")} aria-label={`Open ${video.title}`}>
        {poster.data?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster.data.url} alt="" className={cn("size-full transition-transform duration-300 group-hover:scale-[1.03]", vertical ? "object-cover" : "object-contain")} />
        ) : (
          <span className="flex size-full items-center justify-center text-white/50">
            <Clapperboard className="size-6" aria-hidden />
          </span>
        )}
        <span className="absolute bottom-2.5 left-2.5 flex size-9 items-center justify-center rounded-full bg-black/45 text-white ring-1 ring-white/70 backdrop-blur-sm transition-colors group-hover:bg-black/60">
          <Play className="ml-0.5 size-4 fill-current" aria-hidden />
        </span>
        {video.durationSec ? <span className="absolute bottom-3 right-2.5 rounded-full bg-black/55 px-2 py-0.5 text-caption font-medium tabular text-white">{clock(video.durationSec)}</span> : null}
      </Link>
      <div className="flex items-start gap-1 px-0.5">
        <p className="line-clamp-2 min-w-0 flex-1 text-footnote text-ink-2" title={video.title}>
          {video.title}
        </p>
      </div>
      {canPost ? (
        <button type="button" onClick={onPost} className="-ml-1 inline-flex min-h-11 items-center gap-1.5 rounded-full px-1 text-footnote font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus sm:min-h-8">
          <Send className="size-3.5" aria-hidden />
          Post it
        </button>
      ) : null}
    </li>
  );
}

function RunTile({ run, onOpen, active }: { run: CreateRun; onOpen: () => void; active: boolean }) {
  const v = run.view;
  const needsYou = Boolean(v.failure || (run.problem && !isWait(run.problem)) || v.stale);
  const label = v.step === "done" ? "Ready" : needsYou ? (v.failure ? "Stopped" : "Needs you") : STEP_LABEL[run.busy === "final" ? "check" : v.step];
  return (
    <li className="min-w-0 space-y-2">
      <button
        type="button"
        onClick={onOpen}
        aria-current={active || undefined}
        className={cn(
          TILE,
          "flex flex-col items-center justify-center gap-3 border bg-[linear-gradient(160deg,var(--ml-accent-soft),var(--ml-surface)_70%)] px-3 text-center focus-visible:outline-none focus-visible:shadow-focus",
          active ? "border-accent" : "border-line",
        )}
      >
        <span className={cn("rounded-full px-2.5 py-1 text-caption font-semibold", needsYou ? "bg-warning-soft text-warning" : "bg-surface text-accent-ink shadow-raised")}>{label}</span>
        {!needsYou ? <span className="text-title-3 font-semibold tabular text-ink">{v.pct}%</span> : null}
        <span className="absolute inset-x-3 bottom-3 h-1 overflow-hidden rounded-full bg-mist-2" aria-hidden>
          <span className={cn("block h-full rounded-full", needsYou ? "bg-warning" : "bg-accent")} style={{ width: `${Math.max(4, v.pct)}%` }} />
        </span>
      </button>
      <p className="line-clamp-2 px-0.5 text-footnote text-ink-2">{v.ideaTitle ?? run.campaign.request ?? run.campaign.name}</p>
    </li>
  );
}

export function YourContent({
  appId,
  runs,
  videos,
  loading,
  focusId,
  onOpenRun,
  onPost,
  canPost,
}: {
  appId: string;
  runs: CreateRun[];
  videos: FinishedVideo[];
  loading: boolean;
  focusId: string | null;
  onOpenRun: (campaignId: string) => void;
  onPost: (v: FinishedVideo) => void;
  canPost: boolean;
}) {
  const { workspaceId } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  // Finished runs show as their video; the rest show where they are.
  const making = runs.filter((x) => x.view.step !== "done");
  const empty = !loading && !making.length && !videos.length;
  return (
    <section aria-labelledby="create-content" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h2 id="create-content" className="text-title-3 font-semibold text-ink">
          Your content
        </h2>
        <nav aria-label="More videos" className="flex items-center gap-4 text-footnote font-medium">
          <Link href={r.scheduled} className="inline-flex min-h-11 items-center gap-1.5 text-ink-2 hover:text-ink">
            <CalendarClock className="size-4 text-ink-3" aria-hidden />
            Scheduled
          </Link>
          <Link href={r.videos} className="inline-flex min-h-11 items-center gap-1 text-accent hover:underline">
            All videos
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </nav>
      </div>
      {loading && !videos.length && !making.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] sm:gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-[9/16] w-full" rounded="xl" />
          ))}
        </div>
      ) : empty ? (
        <p className="rounded-xl bg-mist/60 px-4 py-4 text-body-sm text-ink-2 text-pretty">Your videos show up here once they’re made. Each one opens in the editor, where you can change anything by telling Muse.</p>
      ) : (
        <ul aria-label="Your videos" className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] sm:gap-x-4">
          {making.map((run) => (
            <RunTile key={run.campaign.id} run={run} active={focusId === run.campaign.id} onOpen={() => onOpenRun(run.campaign.id)} />
          ))}
          {videos.map((v) => (
            <VideoTile key={v.compositionId} video={v} href={r.studio(v.compositionId)} onPost={() => onPost(v)} canPost={canPost} />
          ))}
        </ul>
      )}
    </section>
  );
}
