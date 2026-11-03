"use client";
/**
 * Home's next post: the next post waiting on the person (the video, its title, where it goes, the
 * caption and when), with three actions: Schedule post (the same publish approval as Needs you: same
 * route, permission and snapshot check), Edit ("Tell Muse what to change", with "Edit in detail ›"
 * to the Studio) and Skip ("Not this one"). A channel that isn't connected says so and offers the
 * post-it-yourself path (download + copy); after scheduling, that post stays here as "Ready for you
 * to post" with the same two buttons.
 *
 * What the post shows: a video plays in place; a single image is the image; several images (a
 * carousel, `TodayPost.images`) are a swipeable slide preview with a counter; a text-only post (no
 * media) is its text, as it will read.
 */
import { isPostChangeRunning, type TodayPost } from "@muselaunch/contracts";
import { Button, Spinner, cn, useToast } from "@muselaunch/ui";
import { CalendarDays, Copy, Download, Info, Play } from "lucide-react";
import { SlideGallery, frameClass } from "@/components/creator/slide-gallery";
import { TextPostCard } from "@/components/creator/text-post-card";
import { downloadEachSlide } from "@/lib/slides";
import Link from "next/link";
import { useRef, useState } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { ChannelName } from "@/components/channel-mark";
import { useNeedsYouDecision, WHO } from "@/features/autopilot/needs-you";
import { ChangeProgress, ChangeResult, PostTellMuse } from "@/features/change/post-change";
import { PostSheet } from "@/features/publishing/post-sheet";
import { CHANNEL_LABEL } from "@/lib/labels";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { clock, postTimeLine, whenInSentence } from "./home-lines";

/** A change that finished in the last day (its one-line result is still news). */
const recent = (iso?: string) => Boolean(iso && Date.now() - Date.parse(iso) < 86_400_000);

/** Every image of a multi-image post (a carousel), in posting order; the first is `video`. */
export type PostImages = { assetId: string; width?: number; height?: number }[];
/** The images of a post (TodayPost.images: absent for a single video or image, and for text posts). */
export const postImages = (post: Pick<TodayPost, "video"> & { images?: PostImages | null }): PostImages => (post.images && post.images.length > 1 ? post.images : []);
/** A post with nothing but its words (a text post: no media; the caption is the post). */
export const isTextOnly = (post: Pick<TodayPost, "video"> & { images?: PostImages | null }) => !post.video && !post.images?.length;

/** The post's name: its title, its video's title, or its caption's first line. */
export function postTitle(post: Pick<TodayPost, "title" | "compositionTitle" | "caption">): string {
  return post.title?.trim() || post.compositionTitle?.trim() || post.caption.split("\n")[0]?.trim() || "Your next post";
}

/** Where the post stands, in a few words (shown when it isn't simply waiting for the person's OK). */
export function postState(post: TodayPost): { text: string; tone: "accent" | "warning" | "neutral" } | null {
  if (isPostChangeRunning(post.change)) return { text: "Muse is changing this post", tone: "accent" };
  if (post.decision) return post.decision.stale ? { text: "Changed since you were asked", tone: "warning" } : !post.decision.canDecide ? { text: "Waiting for approval", tone: "neutral" } : null;
  if (post.status === "manual_post_needed") return { text: "Ready for you to post", tone: "accent" };
  return { text: post.blocked ? "Not ready yet" : "Draft", tone: "neutral" };
}

/** One word or two for a Coming up row. */
export function rowState(post: TodayPost): string {
  if (isPostChangeRunning(post.change)) return "Muse is changing it";
  if (post.decision) return post.decision.stale ? "Changed since you were asked" : "Waiting for your OK";
  if (post.status === "manual_post_needed") return "Ready for you to post";
  return post.blocked ? "Not ready yet" : "Draft";
}

/**
 * The post's video as a thumbnail (poster first, so the page stays calm), playable in place: the
 * frame keeps its shape and the whole video shows while it plays.
 */
export function PostVideo({ post, className }: { post: Pick<TodayPost, "video" | "compositionTitle" | "caption" | "title" | "channel"> & { images?: PostImages | null }; className?: string }) {
  const { workspaceId } = useWorkspace();
  const src = useAssetUrl(workspaceId, post.video?.kind === "video" ? post.video.assetId : null);
  const poster = useAssetUrl(workspaceId, post.video?.posterAssetId ?? (post.video?.kind === "image" ? post.video.assetId : null));
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const v = post.video;
  const label = `${post.compositionTitle ?? postTitle(post)}${v?.durationSec ? `, ${Math.round(v.durationSec)} seconds` : ""}`;
  const images = postImages(post);
  if (images.length) {
    // A carousel: swipe through the real slides, with a counter.
    return <SlideGallery assetIds={images.map((i) => i.assetId)} width={images[0]!.width} height={images[0]!.height} title={post.compositionTitle ?? postTitle(post)} layout="strip" compact slideClassName="!w-full" className={cn("self-start", className)} />;
  }
  if (isTextOnly(post)) {
    // A text post: the words are the post.
    return (
      <div className={cn("relative flex aspect-[4/5] w-full flex-col overflow-hidden rounded-2xl bg-mist p-3 shadow-raised sm:p-4", className)} role="img" aria-label={`Text post: ${post.caption.slice(0, 120)}`}>
        <span className="text-caption font-semibold uppercase tracking-wide text-ink-3">Text post</span>
        <span className="mt-2 line-clamp-[8] whitespace-pre-line break-words text-footnote text-ink sm:line-clamp-[10] sm:text-body-sm">{post.caption}</span>
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-mist to-transparent" aria-hidden />
      </div>
    );
  }
  const shape = v?.kind === "image" ? frameClass(v.width, v.height) : "aspect-[4/5]";
  return (
    <div className={cn("relative w-full overflow-hidden rounded-2xl bg-ink shadow-raised", shape, className)}>
      {v?.kind === "video" && src.data?.url ? (
        <>
          <video
            ref={ref}
            className={cn("size-full", playing ? "object-contain" : "object-cover")}
            src={src.data.url}
            poster={poster.data?.url}
            controls={playing}
            playsInline
            preload="metadata"
            aria-label={label}
            onEnded={() => setPlaying(false)}
          />
          {!playing ? (
            <button
              type="button"
              onClick={() => {
                setPlaying(true);
                void ref.current?.play().catch(() => {});
              }}
              className="group absolute inset-0 focus-visible:outline-none"
              aria-label={`Play ${label}`}
            >
              <span className="absolute bottom-2.5 left-2.5 flex size-10 items-center justify-center rounded-full bg-black/45 text-white ring-1 ring-white/30 backdrop-blur-sm transition-transform group-hover:scale-105 group-focus-visible:shadow-focus">
                <Play className="ml-0.5 size-4 fill-current" aria-hidden />
              </span>
              {v.durationSec ? <span className="absolute bottom-3 right-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold tabular text-white">{clock(v.durationSec)}</span> : null}
            </button>
          ) : null}
        </>
      ) : v?.kind === "image" && poster.data?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster.data.url} alt={post.compositionTitle ?? "Post image"} className="size-full object-cover" />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center">{v ? <Spinner className="size-4 text-white/70" /> : <span className="px-3 text-center text-caption text-white/70">No video on this post</span>}</span>
      )}
    </div>
  );
}

function CopyCaption({ post, size = "md" }: { post: TodayPost; size?: "md" | "lg" }) {
  const toast = useToast();
  const text = isTextOnly(post);
  return (
    <Button
      size={size}
      variant="outline"
      icon={<Copy className="size-4" aria-hidden />}
      onClick={() =>
        void navigator.clipboard?.writeText(post.copyText).then(
          () => toast.success(text ? "Post copied" : "Caption copied", post.copyText.includes("http") ? "With its tracked link, so Results can count the clicks." : undefined),
          () => toast.error("Couldn’t copy", `Open the post and copy the ${text ? "text" : "caption"} by hand.`),
        )
      }
    >
      {text ? "Copy post" : "Copy caption"}
    </Button>
  );
}

function DownloadVideo({ post, size = "md", primary }: { post: TodayPost; size?: "md" | "lg"; primary?: boolean }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const images = postImages(post);
  const dl = useAssetUrl(workspaceId, images.length ? null : post.video?.assetId, { download: true });
  if (images.length)
    return (
      <Button size={size} variant={primary ? "primary" : "outline"} icon={<Download className="size-4" aria-hidden />} onClick={() => void downloadEachSlide(workspaceId, images.map((i) => i.assetId)).catch((e) => toast.error("Download failed", e instanceof Error ? e.message : undefined))}>
        Download {images.length} images
      </Button>
    );
  if (!dl.data?.url) return null;
  return (
    <Button size={size} variant={primary ? "primary" : "outline"} asChild>
      <a href={dl.data.url} download>
        <Download className="size-4" aria-hidden />
        Download {post.video?.kind === "image" ? "image" : "video"}
      </a>
    </Button>
  );
}

/** The one big card. */
export function NextPostCard({ post, appId }: { post: TodayPost; appId: string }) {
  const { workspace, workspaceId } = useWorkspace();
  const tz = workspace?.settings.defaultTimezone;
  const [editing, setEditing] = useState(false);
  const [more, setMore] = useState(false);
  const [sheet, setSheet] = useState(false);
  const channel = CHANNEL_LABEL[post.channel] ?? post.channel;
  const manual = post.mode === "manual";
  const when = post.scheduledAt ? whenInSentence(post.scheduledAt, tz) : null;
  const decision = useDecisionOrNull(post.decision, {
    approved: {
      title: "Post scheduled",
      text: manual
        ? `It’s ready for you to post on ${channel}${when ? ` ${when}` : ""}: ${isTextOnly(post) ? "copy the post here on Home." : postImages(post).length ? "download the images and copy the caption here on Home." : "download the video and copy the caption here on Home."}`
        : `It goes out on ${channel}${when ? ` ${when}` : ""}, through your connected account. It’s under Coming up.`,
    },
  });
  const running = isPostChangeRunning(post.change);
  const state = postState(post);
  // A text post with no title of its own: its words are shown in full below, so the heading says what it is.
  const title = isTextOnly(post) && !post.title?.trim() ? `Your post for ${channel}` : postTitle(post);
  // With no title of its own, the caption's first line is the title: show the rest here.
  const caption = post.title?.trim() || post.compositionTitle?.trim() ? post.caption : post.caption.split("\n").slice(1).join("\n").trim();
  const longCaption = caption.length > 110 || caption.includes("\n");
  // A text post: its words are the post, shown in full as they'll read (no picture column, no caption line).
  const textOnly = isTextOnly(post);
  const r = routes.app(workspaceId, appId);
  const canSchedule = Boolean(post.decision && decision && post.decision.canDecide && post.decision.approve && !post.decision.stale);
  const editButton = post.canChange ? (
    <Button size="lg" variant="outline" aria-expanded={editing} onClick={() => setEditing((c) => !c)}>
      Edit
    </Button>
  ) : null;
  const detailsLink = (
    <button type="button" onClick={() => setSheet(true)} className="col-span-2 min-h-11 justify-self-center rounded-full px-2 text-footnote font-medium text-ink-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-focus sm:ml-auto">
      Post details
    </button>
  );

  return (
    <article aria-labelledby={`next-${post.id}`} className="rounded-[22px] bg-surface p-4 shadow-raised sm:p-5">
      <div className={cn("grid gap-x-4 gap-y-5 sm:gap-x-6", textOnly ? "grid-cols-1" : "grid-cols-[104px_minmax(0,1fr)] sm:grid-cols-[176px_minmax(0,1fr)]")}>
        {textOnly ? null : <PostVideo post={post} className="self-start sm:row-span-2" />}

        <div className="min-w-0 space-y-2 sm:pt-1">
          {state ? (
            <p className={cn("inline-flex items-center gap-1.5 text-footnote font-semibold", state.tone === "warning" ? "text-warning" : state.tone === "accent" ? "text-accent" : "text-ink-2")}>
              <span className={cn("size-1.5 rounded-full", state.tone === "warning" ? "bg-warning" : state.tone === "accent" ? "bg-accent" : "bg-ink-3")} aria-hidden />
              {state.text}
            </p>
          ) : null}
          <h3 id={`next-${post.id}`} className="text-headline font-semibold text-ink text-pretty sm:text-title-3">
            {title}
          </h3>
          <ChannelName channel={post.channel} className="text-body-sm text-ink" />
          <div className={cn((!caption || textOnly) && "hidden")}>
            <p id={`cap-${post.id}`} className={cn("break-words text-body-sm text-ink-2", more ? "whitespace-pre-line" : "line-clamp-2")}>
              {more ? caption : caption.replace(/\s+/g, " ")}
            </p>
            {longCaption ? (
              <button type="button" aria-expanded={more} aria-controls={`cap-${post.id}`} onClick={() => setMore((m) => !m)} className="min-h-11 text-footnote font-medium text-accent hover:underline sm:min-h-0">
                {more ? "less" : "more"}
              </button>
            ) : null}
          </div>
          <p className="flex items-start gap-2 pt-0.5 text-footnote text-ink-2" title={post.timeReason}>
            <CalendarDays className="mt-px size-4 shrink-0 text-ink-3" aria-hidden />
            <span className="text-pretty">
              {postTimeLine(post, tz)}
              {post.timeReason ? <span className="sr-only">. Why this time: {post.timeReason}</span> : null}
            </span>
          </p>
        </div>

        {textOnly ? <TextPostCard text={post.caption} channel={post.channel} className="bg-canvas shadow-[0_0_0_1px_var(--ml-line)]" /> : null}

        <div className={cn("min-w-0 space-y-4", textOnly ? "" : "col-span-2 sm:col-span-1 sm:col-start-2 sm:self-end")}>
          {/* What Muse is doing to this post, or what it just changed: first, so it's seen. */}
          {running && post.change ? <ChangeProgress change={post.change} /> : post.change && !editing && recent(post.change.finishedAt) ? <ChangeResult change={post.change} waiting={Boolean(post.decision)} /> : null}

          {running ? null : post.decision && decision ? (
            canSchedule ? (
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                <Button size="lg" className="col-span-2 sm:min-w-40" loading={decision.busy === "approve"} disabled={Boolean(decision.busy)} onClick={() => void decision.decide("approve")}>
                  Schedule post
                </Button>
                {editButton}
                {post.decision.reject ? (
                  <Button size="lg" variant="ghost" loading={decision.busy === "reject"} disabled={Boolean(decision.busy)} onClick={() => void decision.decide("reject")} className={cn(!post.canChange && "col-span-2")}>
                    Skip
                  </Button>
                ) : null}
                {detailsLink}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 basis-48 text-footnote text-ink-2 text-pretty">
                  {post.decision.stale ? "This post changed after it was sent for approval. Open it to see the latest version." : `Waiting for ${WHO[post.decision.requiredCap] ?? "someone with permission"} to schedule it.`}
                </p>
                {editButton}
                {detailsLink}
              </div>
            )
          ) : post.status === "manual_post_needed" ? (
            <div className="space-y-3">
              <p className="text-footnote text-ink-2 text-pretty">Scheduled. Post it on {channel} yourself{when ? ` ${when}` : ""}, then paste the link so Results can count what it brings in.</p>
              <div className="flex flex-wrap gap-2">
                <DownloadVideo post={post} size="lg" primary />
                <CopyCaption post={post} size="lg" />
                <Button size="lg" variant="ghost" onClick={() => setSheet(true)}>
                  I posted it
                </Button>
                {editButton}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              {post.blocked ? <p className="min-w-0 flex-1 basis-48 text-footnote text-ink-2 text-pretty">{post.blocked}</p> : null}
              <Button size="lg" variant="outline" onClick={() => setSheet(true)}>
                Open the post
              </Button>
            </div>
          )}
        </div>
      </div>

      {editing && !running ? (
        <PostTellMuse post={{ id: post.id, appId, status: post.status, compositionId: post.compositionId, change: post.change, stills: post.video?.kind === "image" }} autoFocus onStarted={() => setEditing(false)} className="mt-5 border-t border-line pt-5" />
      ) : null}

      {/* Not connected: say so plainly, with the post-it-yourself path right there. */}
      {manual && post.status !== "manual_post_needed" && !running ? (
        <div className="mt-5 space-y-3 rounded-2xl bg-mist/70 px-4 py-3.5">
          <p className="flex items-start gap-2.5 text-footnote text-ink-2 text-pretty">
            <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
            <span>
              <span className="font-medium text-ink">{channel} isn’t connected, so you post this one yourself.</span> After you schedule it, {textOnly ? "copy the post" : postImages(post).length ? "download the images and copy the caption" : `download the ${post.video?.kind === "image" ? "image" : "video"} and copy the caption`}.{" "}
              <Link href={`${r.scheduled}?connections=1`} className="font-medium text-accent hover:underline" title={post.manualReason}>
                Connect {channel}
              </Link>
            </span>
          </p>
          <div className="flex flex-wrap gap-2 sm:pl-6">
            <DownloadVideo post={post} />
            <CopyCaption post={post} />
          </div>
        </div>
      ) : null}

      <PostSheet postId={sheet ? post.id : null} onOpenChange={(o) => setSheet(o)} />
    </article>
  );
}

/** The decision hook needs an item; a post may not have one. */
function useDecisionOrNull(item: TodayPost["decision"], said: Parameters<typeof useNeedsYouDecision>[1]) {
  const d = useNeedsYouDecision(item ?? PLACEHOLDER, said);
  return item ? d : null;
}
const PLACEHOLDER = { id: "none", kind: "post", action: "publish", title: "", summary: "", createdAt: new Date(0).toISOString(), subject: { entity: "none", id: "none" }, requiredCap: "publish", canDecide: false, stale: false, approve: null, reject: null } as NonNullable<TodayPost["decision"]>;
