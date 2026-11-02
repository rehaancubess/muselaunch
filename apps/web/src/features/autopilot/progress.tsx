"use client";
/**
 * The run as one calm screen: what Autopilot is doing in plain steps (each finished step with its
 * real one-line result), the finished video(s) to play, download and post, what needs you, and
 * what the run is testing. Everything comes from GET /autopilots/:id (`progress` is derived from
 * real jobs and records server-side; nothing here animates fake progress). The detailed log, stage
 * rail and model calls stay behind "Show details" (LoopView) / "See every step" (Home).
 */
import type { AutopilotFinishedVideo, AutopilotProgress, AutopilotProgressStep, NeedsYouItem } from "@muselaunch/contracts";
import { Button, Dialog, Notice, SegmentedControl, Spinner, cn, useToast } from "@muselaunch/ui";
import { AlertTriangle, ArrowUpRight, Check, Download, Hand, Pause, PenSquare, Play, RotateCcw, Send } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { PostFactCheckFix } from "@/features/publishing/fact-check";
import { NewPostDialog } from "@/features/publishing/new-post";
import { api, errorMessage, wsPath } from "@/lib/api";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useInvalidate, useMutation } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { RecordingFirst, useRecordingState } from "./media-ask";
import { NeedsYouCard, NeedsYouList } from "./needs-you";
import { doingLine, showRecordingFirst } from "./progress-lines";
import { isActive, isWorking, type AutopilotDetail } from "./types";

type Step = AutopilotProgressStep;
type Source = AutopilotProgress["source"];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const READ_LABEL: Record<NonNullable<Source>, string> = {
  app_store: "Reading your App Store page",
  google_play: "Reading your Google Play page",
  website: "Reading your website",
  description: "Reading your description",
};

/** The step's name, the same whether it's waiting, running or done (the dot shows the state). */
export function stepLabel(step: Step, source: Source, videos: number): string {
  switch (step.key) {
    case "read":
      return source ? READ_LABEL[source] : "Reading about your app";
    case "learn":
      return "Learning what your app does";
    case "research":
      return "Finding what your audience talks about";
    case "ideas":
      return "Writing video ideas";
    case "make":
      return videos === 1 ? "Making your video" : "Making your videos";
    case "check":
      return "Checking facts and brand";
    case "finish":
      return videos === 1 ? "Finishing the video" : "Finishing the videos";
    case "ready":
      return "Ready";
  }
}

/** One-line real result of a finished step (only facts the server measured). */
export function stepResult(step: Step, source: Source): string | null {
  const f = step.facts;
  switch (step.key) {
    case "read":
      if (f.screenshots) return `Saved ${plural(f.screenshots, "screenshot")}`;
      return source === "website" ? "Read the page" : source === "description" ? "Saved your description" : "Read the listing";
    case "learn":
      if (f.features === undefined) return null;
      return `Found ${plural(f.features, "feature")}, ${plural(f.audiences ?? 0, "audience")}${f.facts ? ` and ${plural(f.facts, "confirmed fact")}` : ""}`;
    case "research":
      return f.findings !== undefined ? `${plural(f.findings, "finding")}, each with its source` : null;
    case "ideas":
      if (!f.ideas) return null;
      return `${plural(f.ideas, "idea")}${f.picked ? `, picked ${f.picked} to test` : ""}`;
    case "make":
      return f.videos ? `${plural(f.videos, "video")} made` : null;
    case "check": {
      const total = (f.passed ?? 0) + (f.withNotes ?? 0) + (f.blocked ?? 0);
      if (!total) return null;
      const fixed = f.fixed ? `, fixed ${plural(f.fixed, "issue")} on its own` : "";
      if (f.blocked) return `${f.blocked} of ${total} held back by the brand check${fixed}`;
      if (f.withNotes) return `Passed, ${plural(f.withNotes, "video")} with notes${fixed}`;
      return `Brand check passed${fixed}`;
    }
    case "finish":
      return f.rendered ? `${plural(f.rendered, "MP4")} ready` : null;
    case "ready":
      return f.posts ? `${plural(f.posts, "post")} drafted for your OK` : "Done";
  }
}

/** The current step's line: what it's doing (doingLine) plus the real progress of the jobs behind it (done count, %). */
function liveLine(step: Step, stage: string, waitingFor: string | undefined, source: Source, media: AutopilotProgress["media"] | undefined): string {
  const l = step.live;
  const what = stage === "select_audience" ? "Choosing who to reach" : stage === "hypothesis" ? "Deciding what to test" : waitingFor?.startsWith("[produce:screens]") ? (waitingFor.includes("walkthrough") ? "Cutting your screen recording into clips first" : "Finding the real app screens in your screenshots first") : doingLine(step.key, source, media);
  if (!l) return what;
  const parts = [what, l.total > 1 ? `${l.done} of ${l.total} done` : null, typeof l.pct === "number" && l.pct > 0 && l.pct < 100 ? `${l.pct}%` : null].filter(Boolean);
  return parts.join(" · ");
}

const STATE_SR: Record<Step["state"], string> = { done: "Done", active: "In progress", needs_you: "Waiting for you", paused: "Paused", failed: "Didn’t finish", pending: "Not started", skipped: "Skipped", stopped: "Stopped" };

function StepDot({ state }: { state: Step["state"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex size-6 shrink-0 items-center justify-center rounded-full transition-colors duration-300 [&_svg]:size-3.5",
        state === "done" && "bg-ink text-white",
        state === "active" && "bg-accent text-white",
        state === "needs_you" && "bg-warning text-white",
        state === "failed" && "bg-danger text-white",
        (state === "paused" || state === "stopped") && "bg-mist-2 text-ink-2",
        (state === "pending" || state === "skipped") && "bg-surface text-ink-3 ring-1 ring-inset ring-line-strong",
      )}
    >
      {state === "done" ? <Check strokeWidth={3} /> : state === "failed" ? <AlertTriangle /> : state === "needs_you" ? <Hand /> : state === "paused" ? <Pause /> : state === "active" ? <span className="size-2 rounded-full bg-white" /> : null}
      {state === "active" ? <span className="absolute inset-0 animate-ping rounded-full bg-accent/30 [animation-duration:1.8s] motion-reduce:hidden" /> : null}
    </span>
  );
}

/** The plain steps, top to bottom. Finished steps show their real result; the current one its live line. */
export function RunSteps({ detail, className }: { detail: AutopilotDetail; className?: string }) {
  const { workspaceId } = useWorkspace();
  const ap = detail.autopilot;
  const { steps, source, media } = detail.progress;
  const videos = ap.compositionIds.length || ap.budget.variants;
  // New wording first; older runs logged "Accepted your App DNA automatically".
  const dnaAuto = ap.log.some((e) => e.summary.startsWith("Accepted what we learned about your app automatically") || e.summary.startsWith("Accepted your App DNA automatically"));
  return (
    <ol className={cn("space-y-0", className)} aria-label="What Autopilot is doing">
      {steps
        .filter((s) => s.state !== "skipped")
        .map((s, i, all) => {
          const current = s.state !== "done" && s.state !== "pending";
          const result = s.state === "done" ? stepResult(s, source) : null;
          const live = s.state === "active" ? liveLine(s, ap.stage, ap.waitingOn.reason, source, media) : null;
          return (
            <li key={s.key} className="relative flex gap-3 pb-5 last:pb-0" aria-current={current ? "step" : undefined}>
              {i < all.length - 1 ? <span aria-hidden className={cn("absolute bottom-0 left-3 top-7 w-px", s.state === "done" ? "bg-ink/70" : "bg-line-strong")} /> : null}
              <StepDot state={s.state} />
              <div className="min-w-0 flex-1 pt-0.5">
                <p className={cn("text-body-sm text-pretty", s.state === "pending" ? "text-ink-3" : "font-medium text-ink")}>
                  {stepLabel(s, source, videos)}
                  <span className="sr-only">: {STATE_SR[s.state]}</span>
                </p>
                {result ? (
                  <p className="text-footnote text-ink-2 text-pretty">
                    {result}
                    {s.key === "learn" && dnaAuto ? (
                      <>
                        {" · "}
                        <Link href={routes.app(workspaceId, ap.appId).brand} className="font-medium text-accent hover:underline">
                          Check what we learned
                        </Link>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {live ? (
                  <p className="flex items-center gap-1.5 text-footnote text-ink-2" aria-live="polite">
                    {s.state === "active" ? <Spinner className="size-3 shrink-0" /> : null}
                    <span className="min-w-0 text-pretty">{live}</span>
                  </p>
                ) : null}
                {s.state === "needs_you" ? <p className="text-footnote text-warning">{media?.ask === "waiting" && s.key === "make" ? "Waiting for you: a screen recording of your app, then Continue." : "Waiting for your decision below."}</p> : null}
                {s.state === "paused" ? <p className="text-footnote text-ink-2">Paused. Nothing new starts until you resume.</p> : null}
                {s.state === "stopped" ? <p className="text-footnote text-ink-2">Stopped before this step.</p> : null}
                {s.state === "failed" ? <p className="text-footnote text-danger text-pretty">{ap.error?.userMessage ?? ap.error?.message ?? "This step didn’t finish."}</p> : null}
              </div>
            </li>
          );
        })}
    </ol>
  );
}

/** "Made with Muse Wonder · Muse Spark · …": only the models that really ran for this run. */
export function MadeWith({ names, className }: { names: string[]; className?: string }) {
  if (!names.length) return null;
  return <p className={cn("text-caption text-ink-3 text-pretty", className)}>Made with {names.join(" · ")}</p>;
}

function useRunAction(detail: AutopilotDetail) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const ap = detail.autopilot;
  const readFailed = detail.progress.steps.find((s) => s.key === "read")?.state === "failed";
  return useMutation({
    mutationFn: async (action: "resume" | "retry") => {
      // A failed import is read again first; the run then waits for it instead of starting over.
      if (action === "retry" && readFailed) await api.post(wsPath(workspaceId, `/apps/${ap.appId}/import`), {}).catch(() => undefined);
      return api.post(wsPath(workspaceId, `/autopilots/${ap.id}/resume`), {});
    },
    onSuccess: async (_d, action) => {
      toast.success(action === "retry" ? "Trying again" : "Resumed", "Autopilot carries on from where it stopped.");
      await invalidate(wsPath(workspaceId, `/autopilots/${ap.id}`), wsPath(workspaceId, `/apps/${ap.appId}/autopilots`));
    },
    onError: (e) => toast.error("That didn’t work", errorMessage(e)),
  });
}

/** One finished MP4: play it, download it, post it (the existing approval flow), or edit it. */
function VideoPanel({ detail, needs }: { detail: AutopilotDetail; needs: NeedsYouItem[] }) {
  const { workspaceId, can } = useWorkspace();
  const ap = detail.autopilot;
  const videos = detail.progress.videos;
  const [picked, setPicked] = useState<string | null>(null);
  const v = videos.find((x) => x.compositionId === picked) ?? videos[0];
  const expected = ap.compositionIds.length || ap.budget.variants;
  if (!v) {
    const making = ["produce", "verify", "render"].includes(ap.stage) && isWorking(ap.status);
    const note = expected > 1 ? "Your first video shows up here as soon as it’s rendered." : "Your video shows up here as soon as it’s rendered.";
    const icon = making ? <Spinner className="size-4 shrink-0 text-ink-3" /> : <Play className="size-5 shrink-0 text-ink-3" aria-hidden />;
    return (
      <div className="mx-auto w-full lg:max-w-[300px]">
        {/* Phones: a slim line instead of an empty 9:16 frame. */}
        <div className="flex items-center gap-3 rounded-2xl bg-mist/70 px-4 py-3 lg:hidden">
          {icon}
          <p className="text-footnote text-ink-2 text-pretty">{note}</p>
        </div>
        <div className="hidden aspect-[9/16] w-full flex-col items-center justify-center gap-2 rounded-2xl bg-mist/70 p-6 text-center lg:flex">
          {icon}
          <p className="text-footnote text-ink-2 text-pretty">{note}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-[320px] space-y-3">
      {videos.length > 1 ? (
        <SegmentedControl label="Video" size="sm" fullWidth value={v.compositionId} onChange={(id) => setPicked(id)} items={videos.map((x, i) => ({ value: x.compositionId, label: `Video ${i + 1}` }))} />
      ) : null}
      <FinishedVideo key={v.assetId} video={v} detail={detail} needs={needs} canPost={can("content.write")} workspaceId={workspaceId} />
      {videos.length < expected && isWorking(ap.status) ? <p className="text-center text-caption text-ink-3">{expected - videos.length} more on the way.</p> : null}
    </div>
  );
}

function FinishedVideo({ video: v, detail, needs, canPost, workspaceId }: { video: AutopilotFinishedVideo; detail: AutopilotDetail; needs: NeedsYouItem[]; canPost: boolean; workspaceId: string }) {
  const ap = detail.autopilot;
  const r = routes.app(workspaceId, ap.appId);
  const src = useAssetUrl(workspaceId, v.assetId);
  const poster = useAssetUrl(workspaceId, v.posterAssetId);
  const dl = useAssetUrl(workspaceId, v.assetId, { download: true });
  const [posting, setPosting] = useState(false);
  const post = detail.posts.find((x) => x.compositionId === v.compositionId);
  const item = needs.find((n) => n.kind === "post" && (n.subject.id === post?.id || n.preview?.compositionId === v.compositionId));
  const posted = post && ["scheduled", "published", "manually_posted", "manual_post_needed", "publishing"].includes(post.status);
  // The run drafts this video's post itself (schedule stage): until then "Post it" would only make a duplicate.
  const upcoming = !post && isActive(ap.status) && ["produce", "verify", "render", "schedule"].includes(ap.stage);
  const writing = upcoming;
  const ratio = v.aspectRatio === "16:9" ? "aspect-video" : v.aspectRatio === "1:1" ? "aspect-square" : v.aspectRatio === "4:5" ? "aspect-[4/5]" : "aspect-[9/16]";
  let postNote: ReactNode = null;
  if (posted) postNote = post.status === "published" || post.status === "manually_posted" ? "Posted." : post.status === "manual_post_needed" ? "Approved: ready for you to post." : `Approved${post.scheduledAt ? `: goes out ${new Date(post.scheduledAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}.`;
  else if (writing) postNote = ap.stage === "schedule" ? "Writing the post…" : "Autopilot drafts the post once the videos are checked. You approve it before it goes out.";
  else if (post && !item && post.status !== "cancelled")
    postNote = (
      <>
        {post.status === "failed" ? "Posting didn’t work." : post.status === "draft" ? "Saved as a draft." : "The post is waiting for approval."}{" "}
        <Link href={r.scheduled} className="font-medium text-accent hover:underline">
          Open Scheduled
        </Link>
      </>
    );
  return (
    <figure className="space-y-3">
      <div className={cn("relative w-full overflow-hidden rounded-2xl bg-ink shadow-raised", ratio)}>
        {src.data?.url ? (
          <video className="size-full object-contain" src={src.data.url} poster={poster.data?.url} controls playsInline preload="metadata" aria-label={`${v.title}${v.durationSec ? `, ${Math.round(v.durationSec)} seconds` : ""}`} />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner className="size-4 text-white/70" />
          </span>
        )}
      </div>
      <figcaption className="space-y-0.5 px-0.5">
        <p className="text-body-sm font-medium text-ink text-pretty">{v.title}</p>
        <p className="text-caption text-ink-3">
          {v.durationSec ? `${Math.round(v.durationSec)} s · ` : ""}
          {v.aspectRatio} · other sizes in the editor
        </p>
      </figcaption>
      <div className="flex flex-wrap items-center gap-2">
        {canPost && item ? (
          <Button size="sm" icon={<Send className="size-3.5" aria-hidden />} onClick={() => setPosting(true)}>
            Post it
          </Button>
        ) : canPost && !post && !writing ? (
          <Button size="sm" icon={<Send className="size-3.5" aria-hidden />} onClick={() => setPosting(true)}>
            Post it
          </Button>
        ) : null}
        {dl.data?.url ? (
          <Button size="sm" variant="secondary" asChild>
            <a href={dl.data.url} download>
              <Download className="size-3.5" aria-hidden />
              Download
            </a>
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" asChild>
          <Link href={r.studio(v.compositionId)}>
            <PenSquare className="size-3.5" aria-hidden />
            Edit
          </Link>
        </Button>
      </div>
      {postNote ? <p className="text-footnote text-ink-2">{postNote}</p> : null}
      {/* A draft the fact check held back: fix it here in one tap (renders nothing otherwise). */}
      {post && !item && (post.status === "draft" || post.status === "failed") ? <PostFactCheckFix postId={post.id} /> : null}
      {item ? (
        <Dialog open={posting} onOpenChange={setPosting} title="Post this video" description="Check the caption and time. It goes out only after you approve it.">
          <NeedsYouCard item={item} />
          {item.preview?.channel ? <p className="mt-3 text-caption text-ink-3">Channel: {CHANNEL_LABEL[item.preview.channel as keyof typeof CHANNEL_LABEL] ?? item.preview.channel}. Change it, or the caption, with Review.</p> : null}
        </Dialog>
      ) : !post ? (
        <NewPostDialog appId={ap.appId} open={posting} onOpenChange={setPosting} onCreated={() => setPosting(false)} initialCampaignId={ap.campaignId} initialAssetId={v.assetId} />
      ) : null}
    </figure>
  );
}

/** What the run needs from you (posts, outreach, spend, decisions), from GET /needs-you. */
export function runNeeds(detail: AutopilotDetail, items: NeedsYouItem[]): NeedsYouItem[] {
  const postIds = new Set(detail.posts.map((x) => x.id));
  return items.filter((i) => i.autopilotId === detail.autopilot.id || postIds.has(i.subject.id));
}

function headline(detail: AutopilotDetail, needs: number, first: boolean): { title: string; sub: string } {
  const ap = detail.autopilot;
  const { videos, steps } = detail.progress;
  const many = (ap.compositionIds.length || ap.budget.variants) > 1;
  const cur = steps.findIndex((s) => s.state !== "done" && s.state !== "skipped");
  const shown = steps.filter((s) => s.state !== "skipped");
  const at = cur >= 0 ? shown.indexOf(steps[cur]!) + 1 : shown.length;
  const posts = detail.posts.filter((x) => x.status === "awaiting_approval").length;
  switch (ap.status) {
    case "running":
    case "waiting_on_jobs":
      return {
        title: videos.length ? (videos.length > 1 ? "Your videos are coming in" : "Your first video is ready") : `Making your ${first ? "first " : ""}video${many ? "s" : ""}`,
        sub: `Step ${at} of ${shown.length}. You can leave this page: Autopilot keeps working, and nothing is posted without you.`,
      };
    case "awaiting_user":
      if (detail.progress.media?.ask === "waiting") return { title: "Add a screen recording to make your videos", sub: "Your videos show your real app. Add a screen recording below, then press Continue." };
      return { title: "Autopilot needs a decision", sub: "One decision below, then it carries on." };
    case "sleeping":
      return {
        title: videos.length ? (videos.length > 1 ? "Your videos are ready" : "Your video is ready") : "Waiting for results",
        sub: posts
          ? `${plural(posts, "post")} ${posts === 1 ? "is" : "are"} waiting for your OK. Nothing is posted without you.`
          : needs
            ? "A few things are waiting for you below."
            : `Results are read from your connected analytics${ap.waitingOn.until ? ` on ${new Date(ap.waitingOn.until).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}. Nothing is estimated.`,
      };
    case "paused":
      return { title: "Paused", sub: ap.error?.userMessage ?? "Nothing new starts until you resume. What it made is kept." };
    case "failed":
      return { title: "Autopilot stopped", sub: "Something didn’t finish. Everything it made so far is kept." };
    case "completed":
      return { title: "This run is complete", sub: "Start another whenever you like." };
    case "cancelled":
      return { title: "This run was cancelled", sub: "What it made is kept." };
  }
}

/**
 * The calm screen for one run. `details` is the slot behind "Show details" (the log, stage rail and
 * model calls); without it a link opens the run's own page. `headingLevel` keeps the outline right
 * where the page already has an h1 (the app's Home).
 */
export function RunProgress({
  detail,
  needs,
  first = false,
  headingLevel = 1,
  details,
  detailsOpen = false,
  detailsHref,
  aside,
}: {
  detail: AutopilotDetail;
  needs: NeedsYouItem[];
  first?: boolean;
  headingLevel?: 1 | 2;
  details?: ReactNode;
  detailsOpen?: boolean;
  detailsHref?: string;
  aside?: ReactNode;
}) {
  const { workspaceId, can } = useWorkspace();
  const ap = detail.autopilot;
  const r = routes.app(workspaceId, ap.appId);
  const mine = runNeeds(detail, needs);
  // Waiting for footage and a recording is now in: Continue is the next step.
  const rec = useRecordingState(workspaceId, detail.progress.media?.ask === "waiting" ? ap.appId : null);
  const footageIn = rec.state === "processing" || rec.state === "ready";
  const { title, sub } = footageIn
    ? { title: "Your recording is in", sub: can("content.approve") ? "Press Continue below to make your videos with it." : "An owner or admin presses Continue to make the videos with it." }
    : headline(detail, mine.length, first);
  const act = useRunAction(detail);
  const [open, setOpen] = useState(detailsOpen);
  const allDone = detail.progress.steps.every((s) => s.state === "done" || s.state === "skipped");
  const [stepsOpen, setStepsOpen] = useState(!allDone);
  const H = headingLevel === 1 ? "h1" : "h2";
  const hasVideo = detail.progress.videos.length > 0;
  // No screenshots or recordings yet (e.g. added from a website): ask for a recording up front, not after a failure.
  const [askedEarly, setAskedEarly] = useState(false);
  const ask = detail.progress.media?.ask;
  if (ask === "early" && !askedEarly) setAskedEarly(true);
  const recordingFirst = showRecordingFirst({ ask, shownBefore: askedEarly, status: ap.status, videosBuilt: ap.compositionIds.length });
  return (
    <div className="space-y-10">
      {/* Phones: headline → video → the rest. Desktop: headline and the rest on the left, the video beside them. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <header className="min-w-0 space-y-2 lg:col-start-1 lg:row-start-1">
          <H className={cn("font-semibold text-balance", headingLevel === 1 ? "text-title-1" : "text-title-2")}>{title}</H>
          <p className="max-w-xl text-body text-ink-2 text-pretty" aria-live="polite">
            {sub}
          </p>
          {can("content.write") && (ap.status === "failed" || ap.status === "paused") ? (
            <div className="pt-2">
              <Button icon={ap.status === "failed" ? <RotateCcw className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />} loading={act.isPending} onClick={() => act.mutate(ap.status === "failed" ? "retry" : "resume")}>
                {ap.status === "failed" ? "Try again" : "Resume"}
              </Button>
            </div>
          ) : null}
        </header>

        <aside className="min-w-0 space-y-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:pt-1" aria-label={hasVideo ? "Your videos" : "Your video"}>
          <VideoPanel detail={detail} needs={mine} />
          {aside}
        </aside>

        <div className="min-w-0 space-y-8 lg:col-start-1 lg:row-start-2">
          {recordingFirst ? <RecordingFirst appId={ap.appId} source={detail.progress.source} /> : null}

          {mine.length ? (
            <section className="space-y-3" aria-labelledby={`needs-${ap.id}`}>
              <h3 id={`needs-${ap.id}`} className="flex items-center gap-2 text-headline font-semibold">
                Needs you
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-semibold tabular text-white">{mine.length}</span>
              </h3>
              <NeedsYouList items={mine} />
            </section>
          ) : isWorking(ap.status) && !recordingFirst ? (
            <p className="flex items-start gap-2 text-footnote text-ink-2 text-pretty">
              <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
              Nothing needs you right now. You’ll be asked before anything is posted or extra credits are spent.
            </p>
          ) : null}

          <section className="space-y-4" aria-label="Steps">
            {allDone ? (
              <button type="button" aria-expanded={stepsOpen} onClick={() => setStepsOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-footnote font-medium text-ink-2 hover:text-ink">
                <Check className="size-3.5 text-success" aria-hidden />
                {stepsOpen ? "Hide the steps" : "All steps done. Show them"}
              </button>
            ) : null}
            {stepsOpen ? <RunSteps detail={detail} /> : null}
          </section>

          {ap.hypothesis || ap.audience ? (
            <section className="space-y-1.5 rounded-2xl bg-mist/60 p-5" aria-labelledby={`testing-${ap.id}`}>
              <h3 id={`testing-${ap.id}`} className="text-footnote font-medium text-ink-2">
                What we’re testing
              </h3>
              {ap.hypothesis ? <p className="text-body-sm text-ink text-pretty">{ap.hypothesis.statement}</p> : null}
              {ap.audience ? <p className="text-footnote text-ink-2 text-pretty">Who it’s for: {ap.audience.description}</p> : null}
              <p className="pt-1 text-footnote text-ink-3 text-pretty">
                Results come from your real analytics once posts are live.{" "}
                <Link href={r.insights} className="font-medium text-accent hover:underline">
                  Insights
                </Link>
              </p>
            </section>
          ) : null}
        </div>
      </div>

      <div className="space-y-4 border-t border-line pt-5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <MadeWith names={detail.progress.madeWith} />
          {details ? (
            <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-footnote font-medium text-accent hover:underline">
              {open ? "Hide details" : "Show details"}
            </button>
          ) : detailsHref ? (
            <Link href={detailsHref} className="inline-flex items-center gap-0.5 text-footnote font-medium text-accent hover:underline">
              Show details
              <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          ) : null}
        </div>
        {details && open ? <div className="pt-2">{details}</div> : null}
      </div>
      {ap.status === "failed" && !can("content.write") ? <Notice tone="neutral">Ask an editor to try again.</Notice> : null}
    </div>
  );
}
