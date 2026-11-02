"use client";
/**
 * "Tell Muse what to change" for one post (Creator → Today's next post, the post sheet): the words go
 * to POST /posts/:id/change, which runs the Studio's AI edit (Muse Spark, scene-scoped, on the
 * editable video) and a new final render, or rewrites the caption and checks it against the app's
 * facts again. The cost is shown before anything is spent (GET /posts/:id/change/estimate); the
 * progress is the real job's; when it's done one line says what changed, and the post waits for
 * approval again. "Edit in detail" opens the full Studio.
 */
import { isPostChangeRunning, type PostChange, type PostChangePart, type ScheduledPost } from "@muselaunch/contracts";
import { ProgressBar, Spinner, cn, useToast } from "@muselaunch/ui";
import { AlertTriangle, Check } from "lucide-react";
import { useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useJob } from "@/lib/jobs";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { TellMuse, type TellMuseChip } from "./tell-muse";

type Estimate = { credits: number; breakdown: { label: string; credits: number }[]; available: number };

const VIDEO_CHIPS: TellMuseChip[] = [
  { key: "shorter", label: "Shorter", text: "Make it shorter" },
  { key: "start", label: "Different start", text: "Try a different start that hooks people faster" },
  { key: "energy", label: "More energetic", text: "Make it more energetic" },
  { key: "caption", label: "Change the caption", target: "caption", text: "" },
];
const CAPTION_CHIPS: TellMuseChip[] = [
  { key: "c-shorter", label: "Shorter", text: "Make the caption shorter" },
  { key: "c-friendly", label: "Friendlier", text: "Make the caption friendlier" },
  { key: "c-question", label: "Start with a question", text: "Start the caption with a question" },
];

const DOING: Record<PostChange["status"], string> = {
  editing: "Muse Spark is changing the video",
  rendering: "Making the new video",
  rewriting: "Muse Spark is rewriting the caption",
  done: "Done",
  failed: "Didn’t work",
};

/** Can this post still change? (Mirrors the API; it re-checks.) */
export const CHANGEABLE: ScheduledPost["status"][] = ["draft", "failed", "awaiting_approval", "scheduled", "manual_post_needed"];

export interface ChangeablePost {
  id: string;
  appId: string;
  status: ScheduledPost["status"];
  compositionId?: string;
  change?: PostChange | null;
}

/** The running change's live progress, from its job. */
export function ChangeProgress({ change }: { change: PostChange }) {
  const { workspaceId } = useWorkspace();
  const job = useJob(workspaceId, change.jobId).job;
  const pct = job?.status === "running" || job?.status === "succeeded" ? Math.round(job.progress?.pct ?? 0) : null;
  const steps = change.part === "video" ? (change.status === "editing" ? "Step 1 of 2" : "Step 2 of 2") : null;
  return (
    <div className="space-y-2 rounded-xl bg-mist/70 px-4 py-3" aria-live="polite">
      <p className="flex items-center gap-2 text-body-sm font-medium text-ink">
        <Spinner size={14} className="shrink-0" />
        <span className="min-w-0 text-pretty">
          {DOING[change.status]}
          {pct !== null && pct > 0 && pct < 100 ? <span className="font-normal text-ink-2"> · {pct}%</span> : null}
        </span>
      </p>
      <ProgressBar value={pct} label={DOING[change.status]} className="h-1" />
      <p className="text-footnote text-ink-2 text-pretty">
        {steps ? `${steps} · ` : ""}“{change.instruction}”. You can leave this page; the post waits for your OK again when it’s ready.
      </p>
    </div>
  );
}

/** One line on the last change: what changed, or why it didn't. */
export function ChangeResult({ change, className }: { change: PostChange; className?: string }) {
  if (change.status === "failed") {
    return (
      <p className={cn("flex items-start gap-2 text-footnote text-ink-2 text-pretty", className)} role="status">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        <span>
          <span className="font-medium text-ink">Not changed: </span>
          {change.note ?? "That didn’t work. Try saying it another way."}
        </span>
      </p>
    );
  }
  if (change.status !== "done") return null;
  return (
    <p className={cn("flex items-start gap-2 text-footnote text-ink-2 text-pretty", className)} role="status">
      <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
      <span>
        <span className="font-medium text-ink">{change.part === "video" ? "Muse changed the video" : "Muse changed the caption"}{change.summary ? ": " : "."}</span>
        {change.summary ? `${change.summary.replace(/[.\s]+$/, "")}.` : null}
        {change.note ? ` ${change.note}` : change.hadApproval ? " It’s waiting for your OK again." : ""}
      </span>
    </p>
  );
}

export function PostTellMuse({ post, autoFocus, className, hideLabel, onStarted }: { post: ChangeablePost; autoFocus?: boolean; className?: string; hideLabel?: boolean; onStarted?: () => void }) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const hasVideo = Boolean(post.compositionId);
  const [part, setPart] = useState<PostChangePart>(hasVideo ? "video" : "caption");
  const [busy, setBusy] = useState(false);
  const running = isPostChangeRunning(post.change);
  const changeable = CHANGEABLE.includes(post.status) && can("content.write");
  const est = useApiQuery<Estimate>(changeable ? wsPath(workspaceId, `/posts/${post.id}/change/estimate`) : null, { query: { part }, staleTime: 60_000, retry: false });
  const short = est.data ? est.data.credits > est.data.available : false;

  const submit = async (instruction: string, opts: { spoken: boolean }) => {
    setBusy(true);
    try {
      await api.post(wsPath(workspaceId, `/posts/${post.id}/change`), { part, instruction, spoken: opts.spoken });
      onStarted?.();
      await invalidate(wsPath(workspaceId, `/apps/${post.appId}/today`), wsPath(workspaceId, `/posts/${post.id}`), wsPath(workspaceId, "/needs-you"), wsPath(workspaceId, "/jobs"));
      return true;
    } catch (e) {
      toast.error("Muse couldn’t start that change", errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!changeable) return post.change ? <ChangeResult change={post.change} className={className} /> : null;
  const cost = est.data ? (short ? `Needs about ${est.data.credits} credits; ${Math.max(0, est.data.available)} left` : `Uses about ${est.data.credits} credits`) : null;
  return (
    <TellMuse
      appId={post.appId}
      className={className}
      hideLabel={hideLabel}
      autoFocus={autoFocus}
      targets={hasVideo ? [{ value: "video", label: "Video" }, { value: "caption", label: "Caption" }] : undefined}
      target={part}
      onTargetChange={(v) => setPart(v as PostChangePart)}
      placeholder={part === "video" ? "e.g. Make the opening shorter" : "e.g. Make it friendlier and shorter"}
      chips={(part === "video" ? VIDEO_CHIPS : hasVideo ? [...CAPTION_CHIPS, { key: "video", label: "Change the video", target: "video", text: "" }] : CAPTION_CHIPS).map((c) => ({ ...c, disabled: running }))}
      busy={busy}
      disabled={running || short}
      onSubmit={(t, o) => submit(t, o)}
      footnote={[cost, part === "video" ? "Only the scenes it needs to touch change" : "Checked against your facts again", "you OK the new version before it posts"].filter(Boolean).join(" · ")}
      detailHref={hasVideo ? routes.app(workspaceId, post.appId).studio(post.compositionId!) : undefined}
    >
      {post.change && running ? <ChangeProgress change={post.change} /> : post.change ? <ChangeResult change={post.change} /> : null}
    </TellMuse>
  );
}
