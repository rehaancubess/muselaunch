"use client";
/**
 * Today's "Next post": the next post waiting on the person, big (the video, the caption, when and
 * where), with three actions: Looks good (the same publish approval as Needs you: same route,
 * permission and snapshot check), Change ("Tell Muse what to change") and Skip ("Not this one").
 * A channel that isn't connected says so and offers the post-it-yourself path (download + copy).
 * Other waiting posts are a compact "Then:" list; tapping one shows it big.
 */
import { isPostChangeRunning, type TodayPost } from "@muselaunch/contracts";
import { Button, Spinner, cn, useToast } from "@muselaunch/ui";
import { Check, Copy, Download, Info, PenLine, Play, SkipForward } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { basisLabel } from "@/features/autopilot/always-on";
import { useNeedsYouDecision, WHO } from "@/features/autopilot/needs-you";
import { ChangeProgress, ChangeResult, PostTellMuse } from "@/features/change/post-change";
import { PostSheet } from "@/features/publishing/post-sheet";
import { CHANNEL_LABEL } from "@/lib/labels";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

/** "Thu 7 PM" in the workspace's time zone (":00" dropped). */
export function whenShort(iso: string | undefined, tz: string | undefined, withDate = false): string {
  if (!iso) return "No time set";
  return new Date(iso).toLocaleString("en-US", { weekday: "short", ...(withDate ? { month: "short", day: "numeric" } : {}), hour: "numeric", minute: "2-digit", timeZone: tz || "UTC" }).replace(":00", "");
}

/** "Thu 7 PM · Instagram · suggested time" (the time's reason only when it's stored). */
export function whereWhen(post: Pick<TodayPost, "scheduledAt" | "channel" | "timeBasis">, tz?: string): string {
  return [whenShort(post.scheduledAt, tz), CHANNEL_LABEL[post.channel] ?? post.channel, basisLabel(post.timeBasis)].filter(Boolean).join(" · ");
}

function eyebrow(post: TodayPost): { text: string; tone: "accent" | "warning" | "neutral" } {
  if (isPostChangeRunning(post.change)) return { text: "Muse is changing this post", tone: "accent" };
  if (post.decision) return { text: post.decision.stale ? "Changed since you were asked" : "Waiting for your OK", tone: "warning" };
  if (post.status === "manual_post_needed") return { text: "Ready for you to post", tone: "accent" };
  return { text: post.blocked ? "Not ready yet" : "Draft", tone: "neutral" };
}

/** The post's video, playable in place (poster first, so the page stays calm). */
export function PostVideo({ post, className }: { post: Pick<TodayPost, "video" | "compositionTitle" | "caption">; className?: string }) {
  const { workspaceId } = useWorkspace();
  const src = useAssetUrl(workspaceId, post.video?.kind === "video" ? post.video.assetId : null);
  const poster = useAssetUrl(workspaceId, post.video?.posterAssetId ?? (post.video?.kind === "image" ? post.video.assetId : null));
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const v = post.video;
  const ratio = v?.width && v.height ? (v.width > v.height ? "aspect-video" : v.width === v.height ? "aspect-square" : "aspect-[9/16]") : "aspect-[9/16]";
  const label = `${post.compositionTitle ?? "Video"}${v?.durationSec ? `, ${Math.round(v.durationSec)} seconds` : ""}`;
  return (
    <div className={cn("relative w-full overflow-hidden rounded-xl bg-ink shadow-raised", ratio, className)}>
      {v?.kind === "video" && src.data?.url ? (
        <>
          <video
            ref={ref}
            className="size-full object-cover"
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
              className="group absolute inset-0 flex items-center justify-center focus-visible:outline-none"
              aria-label={`Play ${label}`}
            >
              <span className="flex size-12 items-center justify-center rounded-full bg-white/90 text-ink shadow-float transition-transform group-hover:scale-105 group-focus-visible:shadow-focus">
                <Play className="ml-0.5 size-5 fill-current" aria-hidden />
              </span>
              {v.durationSec ? <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-medium tabular text-white">{Math.round(v.durationSec)}s</span> : null}
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
  return (
    <Button
      size={size}
      variant="secondary"
      icon={<Copy className="size-4" aria-hidden />}
      onClick={() =>
        void navigator.clipboard?.writeText(post.copyText).then(
          () => toast.success("Caption copied", post.copyText.includes("http") ? "With its tracked link, so Insights can count the clicks." : undefined),
          () => toast.error("Couldn’t copy", "Open the post and copy the caption by hand."),
        )
      }
    >
      Copy caption
    </Button>
  );
}

function DownloadVideo({ post, size = "md", primary }: { post: TodayPost; size?: "md" | "lg"; primary?: boolean }) {
  const { workspaceId } = useWorkspace();
  const dl = useAssetUrl(workspaceId, post.video?.assetId, { download: true });
  if (!dl.data?.url) return null;
  return (
    <Button size={size} variant={primary ? "primary" : "secondary"} asChild>
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
  const [changing, setChanging] = useState(false);
  const [more, setMore] = useState(false);
  const [sheet, setSheet] = useState(false);
  const decision = useDecisionOrNull(post.decision);
  const running = isPostChangeRunning(post.change);
  const top = eyebrow(post);
  const channel = CHANNEL_LABEL[post.channel] ?? post.channel;
  const manual = post.mode === "manual";
  const longCaption = post.caption.length > 110 || post.caption.includes("\n");
  const r = routes.app(workspaceId, appId);

  return (
    <article aria-labelledby={`next-${post.id}`} className="overflow-hidden rounded-2xl bg-surface shadow-raised">
      <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-4 p-4 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-6 sm:p-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <PostVideo post={post} className="self-start" />
        <div className="min-w-0 space-y-3">
          <p className={cn("inline-flex items-center gap-1.5 text-footnote font-semibold", top.tone === "warning" ? "text-warning" : top.tone === "accent" ? "text-accent" : "text-ink-2")}>
            <span className={cn("size-1.5 rounded-full", top.tone === "warning" ? "bg-warning" : top.tone === "accent" ? "bg-accent" : "bg-ink-3")} aria-hidden />
            {top.text}
          </p>
          <h3 id={`next-${post.id}`} className="text-headline font-semibold text-ink text-pretty sm:text-title-3">
            {whereWhen(post, tz)}
            {post.timeReason ? (
              <span className="sr-only">. Why this time: {post.timeReason}</span>
            ) : null}
          </h3>
          {post.timeReason ? (
            <p className="hidden items-start gap-1.5 text-footnote text-ink-3 sm:flex" title={post.timeReason}>
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="line-clamp-2 text-pretty">{post.timeReason}</span>
            </p>
          ) : null}
          <div>
            <p id={`cap-${post.id}`} className={cn("whitespace-pre-line break-words text-body-sm text-ink-2 sm:text-body", !more && "line-clamp-2")}>
              {post.title ? <span className="font-medium text-ink">{post.title} · </span> : null}
              {post.caption}
            </p>
            {longCaption ? (
              <button type="button" aria-expanded={more} aria-controls={`cap-${post.id}`} onClick={() => setMore((m) => !m)} className="min-h-11 text-footnote font-medium text-accent hover:underline sm:min-h-0">
                {more ? "less" : "more"}
              </button>
            ) : null}
          </div>
          {post.compositionTitle ? <p className="hidden text-caption text-ink-3 sm:block">Video: {post.compositionTitle}</p> : null}
        </div>
      </div>

      <div className="space-y-4 border-t border-line px-4 pb-4 pt-4 sm:px-6 sm:pb-6">
        {manual && post.status !== "manual_post_needed" ? (
          <div className="flex items-start gap-2.5 rounded-xl bg-mist/70 px-3.5 py-3 text-footnote text-ink-2">
            <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
            <p className="text-pretty">
              <span className="font-medium text-ink">{channel} isn’t connected, so MuseLaunch won’t post this for you.</span> After you OK it, download the video and copy the caption to post it yourself.{" "}
              <Link href={`${r.scheduled}?connections=1`} className="font-medium text-accent hover:underline" title={post.manualReason}>
                Connections
              </Link>
            </p>
          </div>
        ) : null}

        {running ? null : post.decision && decision ? (
          post.decision.canDecide && post.decision.approve && !post.decision.stale ? (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
              <Button size="lg" className="col-span-2 sm:min-w-44" icon={<Check className="size-4" aria-hidden />} loading={decision.busy === "approve"} disabled={Boolean(decision.busy)} onClick={() => void decision.decide("approve")}>
                Looks good
              </Button>
              {post.canChange ? (
                <Button size="lg" variant="secondary" icon={<PenLine className="size-4" aria-hidden />} aria-expanded={changing} onClick={() => setChanging((c) => !c)}>
                  Change
                </Button>
              ) : null}
              {post.decision.reject ? (
                <Button size="lg" variant="ghost" icon={<SkipForward className="size-4" aria-hidden />} loading={decision.busy === "reject"} disabled={Boolean(decision.busy)} onClick={() => void decision.decide("reject")} className={cn(!post.canChange && "col-span-2")}>
                  Skip
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-footnote text-ink-2">{post.decision.stale ? "This post changed after it was sent for approval. Open it to see the latest version." : `Waiting for ${WHO[post.decision.requiredCap] ?? "someone with permission"} to OK it.`}</p>
              {post.canChange ? (
                <Button size="lg" variant="secondary" icon={<PenLine className="size-4" aria-hidden />} aria-expanded={changing} onClick={() => setChanging((c) => !c)}>
                  Change
                </Button>
              ) : null}
            </div>
          )
        ) : post.status === "manual_post_needed" ? (
          <div className="space-y-3">
            <p className="text-footnote text-ink-2 text-pretty">You OK’d it. Post it on {channel} yourself, then paste the link so Insights can count its results.</p>
            <div className="flex flex-wrap gap-2">
              <DownloadVideo post={post} size="lg" primary />
              <CopyCaption post={post} size="lg" />
              <Button size="lg" variant="ghost" onClick={() => setSheet(true)}>
                I posted it
              </Button>
              {post.canChange ? (
                <Button size="lg" variant="ghost" icon={<PenLine className="size-4" aria-hidden />} aria-expanded={changing} onClick={() => setChanging((c) => !c)}>
                  Change
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {post.blocked ? <p className="min-w-0 flex-1 text-footnote text-ink-2 text-pretty">{post.blocked}</p> : null}
            <Button size="lg" variant="secondary" onClick={() => setSheet(true)}>
              Open the post
            </Button>
          </div>
        )}

        {manual && post.decision && !running ? (
          <div className="flex flex-wrap gap-2">
            <DownloadVideo post={post} />
            <CopyCaption post={post} />
          </div>
        ) : null}

        {running && post.change ? (
          <ChangeProgress change={post.change} />
        ) : changing ? (
          <PostTellMuse post={{ id: post.id, appId, status: post.status, compositionId: post.compositionId, change: post.change }} autoFocus onStarted={() => setChanging(false)} className="border-t border-line pt-4" />
        ) : post.change ? (
          <ChangeResult change={post.change} />
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <button type="button" onClick={() => setSheet(true)} className="min-h-11 text-footnote font-medium text-ink-2 hover:text-ink sm:min-h-0">
            Post details
          </button>
          {post.compositionId ? (
            <Link href={r.studio(post.compositionId)} className="inline-flex min-h-11 items-center text-footnote font-medium text-ink-2 hover:text-ink sm:min-h-0">
              Edit the video in detail
            </Link>
          ) : null}
        </div>
      </div>
      <PostSheet postId={sheet ? post.id : null} onOpenChange={(o) => setSheet(o)} />
    </article>
  );
}

/** The decision hook needs an item; Today's posts may not have one. */
function useDecisionOrNull(item: TodayPost["decision"]) {
  const d = useNeedsYouDecision(item ?? PLACEHOLDER);
  return item ? d : null;
}
const PLACEHOLDER = { id: "none", kind: "post", action: "publish", title: "", summary: "", createdAt: new Date(0).toISOString(), subject: { entity: "none", id: "none" }, requiredCap: "publish", canDecide: false, stale: false, approve: null, reject: null } as NonNullable<TodayPost["decision"]>;

/** The other waiting posts, one line each. */
export function ThenList({ posts, onPick }: { posts: TodayPost[]; onPick: (id: string) => void }) {
  const { workspace } = useWorkspace();
  const tz = workspace?.settings.defaultTimezone;
  if (!posts.length) return null;
  return (
    <section aria-labelledby="then-heading" className="space-y-2">
      <h3 id="then-heading" className="text-footnote font-semibold text-ink-2">
        Then
      </h3>
      <ul className="divide-y divide-line overflow-hidden rounded-xl bg-surface shadow-raised">
        {posts.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onPick(p.id)} className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-mist/60 focus-visible:outline-none focus-visible:shadow-focus">
              <span className="w-[76px] shrink-0 text-footnote font-medium tabular text-ink">{whenShort(p.scheduledAt, tz)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-sm text-ink">{p.caption.split("\n")[0]}</span>
                <span className="block truncate text-caption text-ink-3">
                  {[CHANNEL_LABEL[p.channel] ?? p.channel, basisLabel(p.timeBasis), eyebrow(p).text].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="shrink-0 text-footnote font-medium text-accent">Show</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
