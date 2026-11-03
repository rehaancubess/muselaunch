"use client";
/**
 * Home's "Coming up": what goes out next, one row each (a small thumbnail, the title, where and where
 * it stands, the date with a calendar icon, a chevron). Two sources, both stored records:
 *  - the other posts on Home (GET /apps/:appId/today): waiting for your OK, ready for you to post, or
 *    being changed by Muse;
 *  - posts already scheduled to go out through a connected account (GET /apps/:appId/calendar, the
 *    same data as Scheduled), so a post you just scheduled shows here as "Scheduled".
 * A row opens the post (the existing post sheet). "Create something new" sits on the right.
 */
import type { MediaAsset, TodayPost } from "@muselaunch/contracts";
import { Skeleton, cn } from "@muselaunch/ui";
import { CalendarDays, ChevronRight, ImageIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { ChannelMark } from "@/components/channel-mark";
import type { CalendarItem, CalendarResponse } from "@/features/publishing/types";
import { PostSheet } from "@/features/publishing/post-sheet";
import { wsPath } from "@/lib/api";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { shortWhen } from "./home-lines";
import { postTitle, rowState } from "./next-post";

const DAY = 86_400_000;
const MAX_ROWS = 5;

type Row = { id: string; title: string; channel: TodayPost["channel"]; at?: string; state: string; scheduled: boolean; poster?: { assetId?: string; posterAssetId?: string } };

/** A poster for a post's media: an image as is, a video by its poster frame. */
function Thumb({ assetId, posterAssetId }: { assetId?: string; posterAssetId?: string }) {
  const { workspaceId } = useWorkspace();
  // Calendar rows only know the media asset; look up its poster frame (videos) once.
  const asset = useApiQuery<{ asset: MediaAsset }>(!posterAssetId && assetId ? wsPath(workspaceId, `/assets/${assetId}`) : null, { staleTime: 10 * 60_000, retry: false });
  const a = asset.data?.asset;
  const imageId = posterAssetId ?? (a ? (a.kind === "image" ? a.id : a.posterAssetId) : undefined);
  const url = useAssetUrl(workspaceId, imageId);
  return (
    <span className="relative flex h-12 w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-accent-soft shadow-[0_0_0_0.5px_rgb(0_0_0/0.08)]">
      {url.data?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url.data.url} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        <ImageIcon className="size-4 text-accent/60" aria-hidden />
      )}
    </span>
  );
}

/** `posts`: Home's posts after the big one; `hasNext`: there is a big one above. */
export function ComingUp({ appId, posts, hasNext, showCreate }: { appId: string; posts: TodayPost[]; hasNext: boolean; showCreate: boolean }) {
  const { workspaceId, workspace } = useWorkspace();
  const tz = workspace?.settings.defaultTimezone || (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC");
  const r = routes.app(workspaceId, appId);
  const [open, setOpen] = useState<string | null>(null);
  // One window per visit (a new key every render would refetch forever).
  const range = useMemo(() => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    return { from: new Date(now - 60 * 60_000).toISOString(), to: new Date(now + 60 * DAY).toISOString(), timezone: tz };
  }, [tz]);
  const cal = useApiQuery<CalendarResponse>(wsPath(workspaceId, `/apps/${appId}/calendar`), { query: range, staleTime: 15_000, retry: false });

  const onHome = new Set(posts.map((p) => p.id));
  const scheduled: CalendarItem[] = Object.values(cal.data?.days ?? {})
    .flat()
    .filter((i) => (i.status === "scheduled" || i.status === "publishing") && !onHome.has(i.id) && (!i.scheduledAt || Date.parse(i.scheduledAt) >= Date.now() - 60 * 60_000));
  const rows: Row[] = [
    ...posts.map((p) => ({ id: p.id, title: postTitle(p), channel: p.channel, at: p.scheduledAt, state: rowState(p), scheduled: false, poster: { assetId: p.video?.assetId, posterAssetId: p.video?.posterAssetId ?? (p.video?.kind === "image" ? p.video.assetId : undefined) } })),
    ...scheduled.map((i) => ({ id: i.id, title: i.title?.trim() || `${CHANNEL_LABEL[i.channel] ?? i.channel} post`, channel: i.channel, at: i.scheduledAt ?? i.at, state: i.status === "publishing" ? "Posting now" : "Scheduled", scheduled: true, poster: { assetId: i.thumbnailAssetId } })),
  ].sort((a, b) => (a.at ?? "￿").localeCompare(b.at ?? "￿"));
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <section aria-labelledby="home-coming" className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <h2 id="home-coming" className="text-title-3 font-semibold text-ink">
          Coming up
        </h2>
        {showCreate ? (
          <Link href={r.create()} className="inline-flex min-h-11 shrink-0 items-center text-body-sm font-medium text-accent hover:underline sm:min-h-8">
            Create something new
          </Link>
        ) : null}
      </div>
      {cal.isLoading && !posts.length ? (
        <Skeleton className="h-16 w-full" rounded="xl" />
      ) : shown.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-[20px] bg-surface shadow-raised">
          {shown.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => setOpen(row.id)}
                className="flex min-h-[72px] w-full items-center gap-3.5 px-3.5 py-3 text-left transition-colors hover:bg-mist/60 focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ml-accent)] sm:gap-4 sm:px-4"
              >
                <Thumb assetId={row.poster?.assetId} posterAssetId={row.poster?.posterAssetId} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm font-medium text-ink">{row.title}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-ink-2">
                    <ChannelMark channel={row.channel} size={13} />
                    <span className="truncate">
                      {CHANNEL_LABEL[row.channel] ?? row.channel} · <span className={cn(row.scheduled && "font-medium text-success")}>{row.state}</span>
                    </span>
                  </span>
                  {/* Phones: the date on its own line, so it's never cut off. */}
                  <span className="mt-0.5 flex items-center gap-1.5 text-caption tabular text-ink-2 sm:hidden">
                    <CalendarDays className="size-3.5 text-ink-3" aria-hidden />
                    {row.at ? shortWhen(row.at, tz) : "No time set"}
                  </span>
                </span>
                <span className="hidden shrink-0 items-center gap-2 text-footnote tabular text-ink-2 sm:flex">
                  <CalendarDays className="size-4 text-ink-3" aria-hidden />
                  {row.at ? shortWhen(row.at, tz) : "No time set"}
                </span>
                <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-[20px] bg-mist/60 px-4 py-4 text-body-sm text-ink-2 text-pretty">{hasNext ? "Nothing else is lined up yet." : "Nothing is lined up yet."} Scheduled posts show up here.</p>
      )}
      {rows.length > MAX_ROWS || scheduled.length ? (
        <Link href={r.scheduled} className="inline-flex min-h-11 items-center gap-1 text-footnote font-medium text-ink-2 hover:text-ink sm:min-h-8">
          {rows.length > MAX_ROWS ? `All ${rows.length} in Scheduled` : "All scheduled posts"}
          <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}
      <PostSheet postId={open} onOpenChange={(o) => !o && setOpen(null)} />
    </section>
  );
}
