"use client";
/**
 * One Create run, in plain words: the five steps (Writing the idea → Planning the video → Making it →
 * Checking facts and brand → Finishing) with real progress from the jobs, and, when the server
 * stopped for the person, its decision right here (credits, a plan limit, the facts or brand check, a
 * longer video, a day without progress, a failed step). Finished: the video with Open it and Post it.
 * Everything shown comes from the server's read model; the buttons answer its decision.
 */
import type { CreateRunDecision } from "@muselaunch/contracts";
import { Button, Input, ProgressBar, Spinner, cn } from "@muselaunch/ui";
import { ArrowUpRight, Check, Play, RotateCcw, Send, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { STEP_LABEL, STEPS, clock, isMoving, needsPerson, stepState, type FinishedVideo, type StepKey } from "./plan";
import type { CreateRun, CreateRunsState } from "./runs";

function StepIcon({ state }: { state: ReturnType<typeof stepState> | "attention" }) {
  if (state === "attention")
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-warning-soft text-[13px] font-bold text-warning" aria-hidden>
        !
      </span>
    );
  if (state === "done")
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-white">
        <Check className="size-3.5" strokeWidth={3} aria-hidden />
      </span>
    );
  if (state === "current")
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Spinner size={14} className="text-current" />
      </span>
    );
  if (state === "failed")
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
        <X className="size-3.5" strokeWidth={3} aria-hidden />
      </span>
    );
  return <span className="size-6 shrink-0 rounded-full border-2 border-line-strong" aria-hidden />;
}

function headline(run: CreateRun): string {
  if (run.status === "done") return "Your video is ready";
  if (run.status === "failed") return "Your video stopped";
  if (run.status === "stopped" || run.decision?.kind === "resume") return "Your video is waiting";
  if (run.status === "needs_you") return "Your video needs you";
  return "Making your video";
}

export function RunPanel({ run, finished, actions, appId, onPost }: { run: CreateRun; finished?: FinishedVideo; actions: CreateRunsState; appId: string; onPost: (v: FinishedVideo) => void }) {
  const { workspaceId, can } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const canWrite = can("content.write");
  const busy = actions.busy[run.campaignId];
  const can_ = (a: Parameters<CreateRunsState["resolve"]>[1]) => canWrite && run.actions.includes(a);

  return (
    <section aria-labelledby={`run-${run.campaignId}`} aria-live="polite" className="space-y-5 rounded-2xl bg-surface p-5 shadow-raised sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {run.status === "done" && finished ? <DonePoster video={finished} href={r.studio(finished.compositionId)} /> : null}
        <div className="min-w-0 flex-1 space-y-1.5">
          <h2 id={`run-${run.campaignId}`} className="text-title-3 font-semibold text-ink">
            {headline(run)}
          </h2>
          <p className="text-body-sm text-ink-2 text-pretty">
            {run.ideaTitle ? (
              <>
                <span className="font-medium text-ink">“{run.ideaTitle}”</span>
                {run.ideaCount > 1 ? (run.status === "done" ? ` · The best fit of the ${run.ideaCount} ideas Muse wrote.` : ` · Muse wrote ${run.ideaCount} ideas and is making the one that fits best.`) : null}
              </>
            ) : (
              <>“{run.request}”</>
            )}
          </p>
          {run.ideaCount > 1 || run.compositionId ? (
            <Link href={r.campaign(run.campaignId)} className="inline-flex min-h-11 items-center gap-1 text-footnote font-medium text-accent hover:underline sm:min-h-0">
              {run.ideaCount > 1 ? "See every idea" : "Details"}
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </div>
      </div>

      {run.status !== "done" ? (
        <>
          <ProgressBar value={run.pct} label="Progress" tone={run.status === "failed" ? "danger" : "accent"} />
          <ol className="grid gap-2.5 sm:grid-cols-5 sm:gap-3">
            {STEPS.map((s) => {
              const state = stepState(run, s);
              const current = state === "current" || state === "failed";
              return (
                <li key={s} className="flex items-start gap-2.5 sm:flex-col sm:gap-2">
                  <StepIcon state={state === "current" ? (needsPerson(run) ? "attention" : isMoving(run) ? "current" : "todo") : state} />
                  <div className="min-w-0">
                    <p className={cn("text-body-sm", current ? "font-semibold text-ink" : state === "done" ? "text-ink" : "text-ink-3")}>{STEP_LABEL[s]}</p>
                    {current && run.detail ? <p className="text-caption text-ink-3 first-letter:uppercase">{run.detail}</p> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}

      {run.status === "failed" && run.failure ? (
        <Decision tone="danger" text={run.failure.message}>
          {can_("retry") ? (
            <Button size="lg" variant="outline" icon={<RotateCcw className="size-4" aria-hidden />} loading={busy === "retry"} onClick={() => void actions.resolve(run, "retry")}>
              Try again
            </Button>
          ) : (
            <Button size="lg" variant="outline" asChild>
              <Link href={r.campaign(run.campaignId)}>Open the details</Link>
            </Button>
          )}
        </Decision>
      ) : run.status === "waiting" && run.wait ? (
        <Decision tone="wait" text={`One moment: ${run.wait.reason} Muse tries again by itself.`} />
      ) : run.status === "needs_you" && run.decision ? (
        <DecisionBox run={run} decision={run.decision} actions={actions} appId={appId} allowed={can_} />
      ) : run.status === "stopped" ? (
        <Decision text={`You left this video at “${STEP_LABEL[run.stage as StepKey] ?? "a step"}”. It stays in the editor; Muse carries on only if you continue it.`}>
          {can_("retry") ? (
            <Button size="lg" onClick={() => void actions.resolve(run, "retry")} loading={busy === "retry"}>
              Continue
            </Button>
          ) : null}
        </Decision>
      ) : null}

      {run.status === "done" && run.compositionId ? (
        <div className="flex flex-wrap gap-2">
          <Button size="lg" asChild>
            <Link href={r.studio(run.compositionId)}>
              <Play className="size-4" aria-hidden />
              Open it
            </Link>
          </Button>
          {canWrite && finished ? (
            <Button size="lg" variant="outline" icon={<Send className="size-4" aria-hidden />} onClick={() => onPost(finished)}>
              Post it
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className="text-caption text-ink-3">
        {run.status === "done" ? "Change anything by telling Muse in the editor. Nothing is posted without your OK." : "It keeps going even when MuseLaunch is closed. Nothing is posted without your OK."}
        <span className="mx-1.5" aria-hidden>
          ·
        </span>
        Muse Spark plans it · HyperFrames renders it
      </p>
    </section>
  );
}

function Decision({ text, tone = "attention", children }: { text: string; tone?: "attention" | "danger" | "wait"; children?: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-xl px-4 py-3.5 sm:flex-row sm:items-center", tone === "danger" ? "bg-danger-soft" : tone === "wait" ? "bg-mist" : "bg-warning-soft")}>
      {tone === "wait" ? <Spinner size={16} className="shrink-0 text-ink-2" /> : null}
      <p className={cn("min-w-0 flex-1 text-body-sm text-pretty", tone === "danger" ? "text-danger" : tone === "wait" ? "text-ink-2" : "text-ink")}>{text}</p>
      {children ? <div className="flex shrink-0 flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}

function DecisionBox({ run, decision, actions, appId, allowed }: { run: CreateRun; decision: CreateRunDecision; actions: CreateRunsState; appId: string; allowed: (a: Parameters<CreateRunsState["resolve"]>[1]) => boolean }) {
  const { workspaceId } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const busy = actions.busy[run.campaignId];
  const studio = run.compositionId ? r.studio(run.compositionId) : null;
  const again = (label = "Try again", primary = false) =>
    allowed("retry") ? (
      <Button size="lg" variant={primary ? "primary" : "outline"} icon={primary ? undefined : <RotateCcw className="size-4" aria-hidden />} loading={busy === "retry"} onClick={() => void actions.resolve(run, "retry")}>
        {label}
      </Button>
    ) : null;
  const open = (label = "Open it to fix") =>
    studio ? (
      <Button size="lg" variant="outline" asChild>
        <Link href={studio}>{label}</Link>
      </Button>
    ) : null;

  switch (decision.kind) {
    case "limit":
      return (
        <Decision text={decision.message}>
          <Button size="lg" variant="outline" asChild>
            <Link href={routes.settings.credits(workspaceId)}>See your plan</Link>
          </Button>
          {again()}
        </Decision>
      );
    case "credits":
      return (
        <Decision text={`Not enough credits for the next step. ${decision.message}`}>
          <Button size="lg" variant="outline" asChild>
            <Link href={routes.settings.credits(workspaceId)}>Credits</Link>
          </Button>
          {again()}
        </Decision>
      );
    case "spend":
      return (
        <Decision text={decision.message}>
          {allowed("approve_spend") ? (
            <Button size="lg" onClick={() => void actions.resolve(run, "approve_spend")} loading={busy === "approve_spend"}>
              Finish it · {decision.credits} credits
            </Button>
          ) : null}
          {open("Open it")}
        </Decision>
      );
    case "fix":
      return (
        <Decision text={decision.message}>
          {open()}
          {again()}
        </Decision>
      );
    case "brand":
      return (
        <div className="space-y-3 rounded-xl bg-warning-soft px-4 py-3.5">
          <p className="text-body-sm text-ink text-pretty">
            <span className="font-medium">The brand check found something: </span>
            {decision.message}
          </p>
          {asking ? (
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (reason.trim().length >= 3) void actions.resolve(run, "override", { reason: reason.trim() });
              }}
            >
              <label htmlFor={`why-${run.campaignId}`} className="sr-only">
                Why it’s fine to finish it
              </label>
              <Input id={`why-${run.campaignId}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it’s fine (kept with the brand check)" maxLength={500} className="h-11 min-w-0 flex-1" autoFocus />
              <Button size="lg" type="submit" disabled={reason.trim().length < 3} loading={busy === "override"}>
                Finish it
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              {open()}
              {allowed("override") ? (
                <Button size="lg" variant="ghost" onClick={() => setAsking(true)}>
                  Finish it anyway…
                </Button>
              ) : null}
              {again()}
            </div>
          )}
        </div>
      );
    case "resume":
    case "permission":
      return <Decision text={decision.message}>{again("Continue", true)}</Decision>;
    default:
      return (
        <Decision tone="danger" text={decision.message}>
          {again()}
        </Decision>
      );
  }
}

function DonePoster({ video, href }: { video: FinishedVideo; href: string }) {
  const { workspaceId } = useWorkspace();
  const poster = useAssetUrl(workspaceId, video.posterAssetId);
  const wide = (video.width ?? 0) > (video.height ?? 0);
  return (
    <Link href={href} className={cn("group relative block shrink-0 overflow-hidden rounded-xl bg-ink shadow-raised focus-visible:outline-none focus-visible:shadow-focus", wide ? "aspect-video w-full sm:w-56" : "aspect-[9/16] w-32")} aria-label={`Open ${video.title}`}>
      {poster.data?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster.data.url} alt="" className="size-full object-cover" />
      ) : null}
      <span className="absolute bottom-2 left-2 flex size-8 items-center justify-center rounded-full bg-white/90 text-ink">
        <Play className="ml-0.5 size-3.5 fill-current" aria-hidden />
      </span>
      {video.durationSec ? <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-medium tabular text-white">{clock(video.durationSec)}</span> : null}
    </Link>
  );
}
