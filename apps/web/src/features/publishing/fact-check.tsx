"use client";
/**
 * A post the fact check held back, fixed in one tap instead of a dead draft:
 *   "This post mentions racing and bowling, which aren't in your confirmed facts yet."
 *   [Remove it]  [It's true, add it]
 * "Remove it" asks Muse Spark to rewrite the copy without those words; "It's true, add it" records
 * the person's confirmation as a fact (labelled founder-confirmed) and checks the copy again. Either
 * way the server checks the copy again before anything can be approved (POST /posts/:id/facts/*).
 * Shown on the post draft and under the finished video on the Autopilot run screen.
 */
import type { Job } from "@muselaunch/contracts";
import { Button, Spinner, cn, useToast } from "@muselaunch/ui";
import { Check, Eraser, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useJob } from "@/lib/jobs";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import type { PostView } from "./types";

type FixOutcome = { ok?: boolean; approvalId?: string; autopilotId?: string; skipped?: string };

const quoted = (s: string) => `“${s}”`;

/** Fetches the post itself (Autopilot run screen); renders nothing unless the fact check holds it back. */
export function PostFactCheckFix({ postId, className }: { postId: string; className?: string }) {
  const { workspaceId } = useWorkspace();
  const q = useApiQuery<PostView>(wsPath(workspaceId, `/posts/${postId}`), { staleTime: 5_000 });
  if (!q.data) return null;
  return <FactCheckFix view={q.data} className={className} showExcerpt />;
}

/** `showExcerpt`: quote the post's own sentence (where the caption isn't on screen, e.g. the run screen). */
export function FactCheckFix({ view, className, showExcerpt = false }: { view: PostView; className?: string; showExcerpt?: boolean }) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const fc = view.factCheck;
  const post = view.post;
  const running = fc?.fix && (fc.fix.status === "queued" || fc.fix.status === "running") ? fc.fix : null;
  const [started, setStarted] = useState<{ jobId: string; action: "remove" | "recheck" } | null>(null);
  const [busy, setBusy] = useState<"remove" | "confirm" | null>(null);
  const active = started ?? (running ? { jobId: running.jobId, action: running.action } : null);

  const refresh = () =>
    invalidate(
      wsPath(workspaceId, `/posts/${post.id}`),
      wsPath(workspaceId, "/autopilots"),
      wsPath(workspaceId, `/apps/${post.appId}/autopilots`),
      wsPath(workspaceId, "/needs-you"),
      wsPath(workspaceId, `/apps/${post.appId}/calendar`),
      wsPath(workspaceId, `/apps/${post.appId}/dna`),
      wsPath(workspaceId, "/approvals"),
    );
  const job = useJob(workspaceId, active?.jobId, {
    onSettled: (j: Job) => {
      const out = (j.output?.data ?? {}) as FixOutcome;
      setStarted(null);
      if (j.status !== "succeeded") toast.error("That didn’t work", j.error?.userMessage ?? j.error?.message ?? "Try again in a moment.");
      else if (out.ok && out.approvalId) toast.success("Fixed", "The post passes the fact check and is waiting for your OK in Needs you.");
      else if (out.ok) toast.success("Fixed", "The post passes the fact check. You can ask for approval now.");
      else toast.toast({ title: "Still not clear", description: "The fact check still holds this post back. Have a look at what it says now." });
      void refresh();
    },
  });

  if (!fc || (fc.ok && !active)) return null;
  const canRemove = can("content.write");
  const canConfirm = can("content.write") && can("apps.write") && fc.statements.length > 0;
  const approver = can("content.approve");
  const terminal = ["published", "manually_posted", "cancelled", "publishing", "scheduled", "manual_post_needed"].includes(post.status);
  if (terminal) return null;

  const start = async (action: "remove" | "confirm") => {
    setBusy(action);
    try {
      if (action === "remove") {
        const r = await api.post<{ job: Job }>(wsPath(workspaceId, `/posts/${post.id}/facts/remove`), {});
        setStarted({ jobId: r.job.id, action: "remove" });
      } else {
        const r = await api.post<{ job: Job | null; confirmed: boolean }>(wsPath(workspaceId, `/posts/${post.id}/facts/confirm`), {});
        if (r.job) setStarted({ jobId: r.job.id, action: "recheck" });
        else {
          toast.toast({ title: "Added to your facts for review", description: "An owner or admin confirms new facts. The post can go out once they do." });
          void refresh();
        }
      }
    } catch (e) {
      toast.error("That didn’t work", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const working = active && (!job.job || job.job.status === "queued" || job.job.status === "running");
  return (
    <section aria-label="Fact check" className={cn("space-y-3 rounded-2xl bg-warning-soft/70 p-4 ring-1 ring-inset ring-warning/15", className)}>
      <div className="flex gap-3">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-body-sm font-semibold text-ink text-pretty">Check one thing before this goes out</p>
          <p className="text-footnote text-ink-2 text-pretty">{fc.message}</p>
          {showExcerpt && fc.excerpts.length ? <p className="text-footnote text-ink-3 text-pretty">In the post: {fc.excerpts.map(quoted).join(" ")}</p> : null}
        </div>
      </div>
      {working ? (
        <p className="flex items-center gap-2 pl-7 text-footnote text-ink-2" aria-live="polite">
          <Spinner className="size-3.5 shrink-0" />
          <span className="text-pretty">{active?.action === "remove" ? `Rewriting the post without ${fc.issues.flatMap((i) => i.terms).slice(0, 4).join(", ") || "those words"}, then checking it again…` : "Checking the post again with your new fact…"}</span>
        </p>
      ) : canRemove || canConfirm ? (
        <div className="space-y-2 pl-7">
          <div className="flex flex-wrap gap-2">
            {canRemove ? (
              <Button size="sm" variant="outline" icon={<Eraser className="size-3.5" aria-hidden />} loading={busy === "remove"} disabled={busy !== null} onClick={() => void start("remove")}>
                Remove it
              </Button>
            ) : null}
            {canConfirm ? (
              <Button size="sm" variant="ink" icon={<Check className="size-3.5" aria-hidden />} loading={busy === "confirm"} disabled={busy !== null} onClick={() => void start("confirm")}>
                It’s true, add it
              </Button>
            ) : null}
          </div>
          {canConfirm ? (
            <p className="text-caption text-ink-3 text-pretty">
              “It’s true” adds {fc.statements.length === 1 ? "this fact" : "these facts"} to About your app, marked as confirmed by you{approver ? "" : " and sent to an owner or admin to confirm"}: {fc.statements.map(quoted).join(" ")}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="pl-7 text-footnote text-ink-2">Ask an editor to fix it.</p>
      )}
    </section>
  );
}
