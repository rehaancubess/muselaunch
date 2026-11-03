"use client";
/**
 * Create → Your content: what's being made (its step and progress, or "Needs you") and what's
 * finished, newest first. A video: the poster (the frame where the hook is fully on screen), a play
 * button and the length. Stills: slide 1 as the cover, in its own shape, with "Carousel · 6". A text
 * post: its words on a card. Videos and stills open the simple Studio (Tell Muse, Edit in detail); a
 * text post opens its run. Post it / Schedule post drafts a post that waits for approval. All videos /
 * Scheduled one tap away.
 */
import { Skeleton, cn } from "@muselaunch/ui";
import { ArrowRight, CalendarClock, Clapperboard, GalleryHorizontalEnd, Play, Send } from "lucide-react";
import Link from "next/link";
import { useAssetUrl } from "@/components/app-icon";
import { ChannelMark } from "@/components/channel-mark";
import { SlideImage, frameClass } from "@/components/creator/slide-gallery";
import { CHANNEL_LABEL } from "@/lib/labels";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { clock, contentKey, needsPerson, runMake, stageLabel, stillsBadge, type ContentItem, type FinishedStills, type FinishedText, type FinishedVideo } from "./plan";
import type { CreateRun } from "./runs";
import type { ScheduleTarget } from "./schedule";

/** Every tile sits in the same 9:16 cell so the grid stays even; stills and text keep their own shape inside it. */
const TILE = "relative block aspect-[9/16] w-full overflow-hidden rounded-xl";

function PostAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="-ml-1 inline-flex min-h-11 items-center gap-1.5 rounded-full px-1 text-footnote font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus sm:min-h-8">
      {label === "Post it" ? <Send className="size-3.5" aria-hidden /> : <CalendarClock className="size-3.5" aria-hidden />}
      {label}
    </button>
  );
}

function StillsTile({ stills, href, onPost, canPost }: { stills: FinishedStills; href: string; onPost: () => void; canPost: boolean }) {
  const n = stills.assetIds.length;
  const badge = stillsBadge(stills);
  const wide = (stills.width ?? 0) > (stills.height ?? 0);
  return (
    <li className="min-w-0 space-y-2">
      <Link href={href} className={cn(TILE, "group flex items-center justify-center bg-mist p-2.5 focus-visible:outline-none focus-visible:shadow-focus")} aria-label={`Open ${stills.title} (${badge})`}>
        {n > 1 ? (
          // A hint of the next slides behind the cover: it reads as a set at a glance.
          <span className={cn("absolute rounded-lg bg-surface/80 shadow-raised", frameClass(stills.width, stills.height), wide ? "w-[78%] translate-x-2 translate-y-2" : "h-[72%] translate-x-3 rotate-[3deg]")} aria-hidden />
        ) : null}
        <span className={cn("relative block overflow-hidden rounded-lg shadow-raised transition-transform duration-300 group-hover:scale-[1.03]", frameClass(stills.width, stills.height), wide ? "w-full" : "max-h-full w-full")}>
          <SlideImage assetId={stills.assetIds[0]!} alt="" />
        </span>
        <span className="absolute bottom-2.5 left-2.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-caption font-medium text-white backdrop-blur-sm">
          {n > 1 ? <GalleryHorizontalEnd className="size-3" aria-hidden /> : null}
          {badge}
        </span>
      </Link>
      <p className="line-clamp-2 px-0.5 text-footnote text-ink-2" title={stills.title}>
        {stills.title}
      </p>
      {canPost && !badge.startsWith("Screenshots") ? <PostAction label="Schedule post" onClick={onPost} /> : null}
    </li>
  );
}

function TextTile({ text, onOpen, onPost, canPost }: { text: FinishedText; onOpen: () => void; onPost: () => void; canPost: boolean }) {
  return (
    <li className="min-w-0 space-y-2">
      <button type="button" onClick={onOpen} className={cn(TILE, "group flex flex-col bg-surface p-3.5 text-left shadow-raised focus-visible:outline-none focus-visible:shadow-focus")} aria-label={`Open the ${CHANNEL_LABEL[text.channel]} post: ${text.title}`}>
        <span className="flex items-center gap-1.5 text-caption font-medium text-ink-2">
          <ChannelMark channel={text.channel} size={14} />
          {CHANNEL_LABEL[text.channel]}
        </span>
        <span className="mt-2.5 line-clamp-[9] whitespace-pre-line break-words text-footnote text-ink">{text.text}</span>
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" aria-hidden />
        <span className="absolute bottom-2.5 left-3.5 rounded-full bg-mist px-2 py-0.5 text-caption font-medium text-ink-2">Text post</span>
      </button>
      <p className="line-clamp-2 px-0.5 text-footnote text-ink-2">{text.title}</p>
      {canPost ? <PostAction label="Schedule post" onClick={onPost} /> : null}
    </li>
  );
}

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
      {canPost ? <PostAction label="Post it" onClick={onPost} /> : null}
    </li>
  );
}

function RunTile({ run, onOpen, active }: { run: CreateRun; onOpen: () => void; active: boolean }) {
  const v = run;
  const needsYou = needsPerson(run);
  const label = v.status === "done" ? "Ready" : needsYou ? (v.status === "failed" ? "Stopped" : "Needs you") : stageLabel(runMake(run), v.stage);
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
      <p className="line-clamp-2 px-0.5 text-footnote text-ink-2">{v.ideaTitle ?? run.request}</p>
    </li>
  );
}

export function YourContent({
  appId,
  runs,
  items,
  loading,
  focusId,
  onOpenRun,
  onPost,
  canPost,
}: {
  appId: string;
  runs: CreateRun[];
  /** Finished videos, stills and text posts, newest first (plan.ts finishedContent). */
  items: ContentItem[];
  loading: boolean;
  focusId: string | null;
  onOpenRun: (campaignId: string) => void;
  onPost: (t: ScheduleTarget) => void;
  canPost: boolean;
}) {
  const { workspaceId } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  // Finished runs show as what they made; the rest show where they are.
  const making = runs.filter((x) => x.status !== "done");
  const empty = !loading && !making.length && !items.length;
  return (
    <section aria-labelledby="create-content" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h2 id="create-content" className="text-title-3 font-semibold text-ink">
          Your content
        </h2>
        <nav aria-label="More of your content" className="flex items-center gap-4 text-footnote font-medium">
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
      {loading && !items.length && !making.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] sm:gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-[9/16] w-full" rounded="xl" />
          ))}
        </div>
      ) : empty ? (
        <p className="rounded-xl bg-mist/60 px-4 py-4 text-body-sm text-ink-2 text-pretty">What you make shows up here. Videos and images open in the editor, where you can change anything by telling Muse.</p>
      ) : (
        <ul aria-label="Your content" className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] sm:gap-x-4">
          {making.map((run) => (
            <RunTile key={run.campaignId} run={run} active={focusId === run.campaignId} onOpen={() => onOpenRun(run.campaignId)} />
          ))}
          {items.map((c) =>
            c.type === "video" ? (
              <VideoTile key={contentKey(c)} video={c} href={r.studio(c.compositionId)} onPost={() => onPost(c)} canPost={canPost} />
            ) : c.type === "stills" ? (
              <StillsTile key={contentKey(c)} stills={c} href={r.studio(c.compositionId)} onPost={() => onPost(c)} canPost={canPost} />
            ) : (
              <TextTile key={contentKey(c)} text={c} onOpen={() => onOpenRun(c.campaignId)} onPost={() => onPost(c)} canPost={canPost} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}
