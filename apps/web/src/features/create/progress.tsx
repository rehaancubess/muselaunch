"use client";
/**
 * One Create run, in plain words: the five steps (Writing the idea → Planning the video → Making it →
 * Checking facts and brand → Finishing) with real progress from the jobs, and, when a step needs the
 * person, the decision right here (credits, a plan limit, the brand check, a fix, a longer video).
 * Finished: the video with Open it and Post it.
 */
import { Button, Input, ProgressBar, Spinner, cn } from "@muselaunch/ui";
import { ArrowUpRight, Check, Play, RotateCcw, Send, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { STEP_LABEL, STEPS, clock, isWait, stepState, type ActionProblem, type FinishedVideo, type StepKey } from "./plan";
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
  const v = run.view;
  if (v.step === "done") return "Your video is ready";
  if (v.failure) return "Your video stopped";
  if (run.problem && !isWait(run.problem)) return "Your video needs you";
  if (v.stale) return "Your video is waiting";
  return "Making your video";
}

export function RunPanel({ run, finished, actions, appId, onPost }: { run: CreateRun; finished?: FinishedVideo; actions: CreateRunsState; appId: string; onPost: (v: FinishedVideo) => void }) {
  const { workspaceId, can } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const v = run.view;
  const canWrite = can("content.write");
  const needsYou = Boolean(run.problem && !isWait(run.problem));
  // Something is happening: a job runs, Create is taking a step, a short wait, or the next step is about to start.
  const working = v.working || Boolean(run.busy) || (run.problem ? isWait(run.problem) : false) || (run.mine && Boolean(v.next) && !v.stale && !run.problem);
  // While the final render request runs, the route checks facts and the brand first; its answers belong to that step.
  const atCheck = run.busy === "final" || (run.problem && ["brand", "fix", "spend"].includes(run.problem.kind) && v.step !== "done");
  const shown = atCheck ? { ...v, step: "check" as const, detail: undefined } : v;

  return (
    <section aria-labelledby={`run-${run.campaign.id}`} aria-live="polite" className="space-y-5 rounded-2xl bg-surface p-5 shadow-raised sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {v.step === "done" && finished ? <DonePoster video={finished} href={r.studio(finished.compositionId)} /> : null}
        <div className="min-w-0 flex-1 space-y-1.5">
          <h2 id={`run-${run.campaign.id}`} className="text-title-3 font-semibold text-ink">
            {headline(run)}
          </h2>
          <p className="text-body-sm text-ink-2 text-pretty">
            {v.ideaTitle ? (
              <>
                <span className="font-medium text-ink">“{v.ideaTitle}”</span>
                {v.ideaCount > 1 ? (v.step === "done" ? ` · The best fit of the ${v.ideaCount} ideas Muse wrote.` : ` · Muse wrote ${v.ideaCount} ideas and is making the one that fits best.`) : null}
              </>
            ) : (
              <>“{run.campaign.request ?? run.campaign.name}”</>
            )}
          </p>
          {v.ideaCount > 1 || v.compositionId ? (
            <Link href={r.campaign(run.campaign.id)} className="inline-flex min-h-11 items-center gap-1 text-footnote font-medium text-accent hover:underline sm:min-h-0">
              {v.ideaCount > 1 ? "See every idea" : "Details"}
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </div>
      </div>

      {v.step !== "done" ? (
        <>
          <ProgressBar value={v.pct} label="Progress" tone={v.failure ? "danger" : "accent"} />
          <ol className="grid gap-2.5 sm:grid-cols-5 sm:gap-3">
            {STEPS.map((s) => {
              const state = stepState(shown, s);
              const current = state === "current" || state === "failed";
              return (
                <li key={s} className="flex items-start gap-2.5 sm:flex-col sm:gap-2">
                  <StepIcon state={state === "current" ? (needsYou || v.stale ? "attention" : working ? "current" : "todo") : state} />
                  <div className="min-w-0">
                    <p className={cn("text-body-sm", current ? "font-semibold text-ink" : state === "done" ? "text-ink" : "text-ink-3")}>{STEP_LABEL[s]}</p>
                    {current && shown.detail ? <p className="text-caption text-ink-3 first-letter:uppercase">{shown.detail}</p> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}

      {v.failure ? (
        <Decision tone="danger" text={v.failure.message}>
          {v.failure.retry && v.failure.jobId && canWrite ? (
            <Button size="lg" variant="outline" icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => void actions.retry(run, v.failure!.jobId!)}>
              Try again
            </Button>
          ) : (
            <Button size="lg" variant="outline" asChild>
              <Link href={r.campaign(run.campaign.id)}>Open the details</Link>
            </Button>
          )}
        </Decision>
      ) : run.problem ? (
        <ProblemBox run={run} problem={run.problem} actions={actions} appId={appId} canWrite={canWrite} />
      ) : v.stale && v.next ? (
        <Decision text={`This video stopped at “${STEP_LABEL[v.step as StepKey]}”. Muse doesn’t carry on with an older video by itself.`}>
          {canWrite ? (
            <Button size="lg" onClick={() => void actions.continueRun(run)} loading={run.busy !== null}>
              Continue
            </Button>
          ) : null}
        </Decision>
      ) : !run.mine && v.next && v.step !== "done" ? (
        <Decision text="A teammate started this video. It carries on on their screen, or continue it here.">
          {canWrite ? (
            <Button size="lg" variant="outline" onClick={() => void actions.continueRun(run)} loading={run.busy !== null}>
              Continue
            </Button>
          ) : null}
        </Decision>
      ) : null}

      {v.step === "done" && v.compositionId ? (
        <div className="flex flex-wrap gap-2">
          <Button size="lg" asChild>
            <Link href={r.studio(v.compositionId)}>
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
        {v.step === "done" ? "Change anything by telling Muse in the editor. Nothing is posted without your OK." : "It keeps going while MuseLaunch is open. Nothing is posted without your OK."}
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

function ProblemBox({ run, problem, actions, appId, canWrite }: { run: CreateRun; problem: ActionProblem; actions: CreateRunsState; appId: string; canWrite: boolean }) {
  const { workspaceId } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const studio = run.view.compositionId ? r.studio(run.view.compositionId) : null;
  const again = canWrite ? (
    <Button size="lg" variant="outline" icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => actions.clear(run.campaign.id)}>
      Try again
    </Button>
  ) : null;
  const open = studio ? (
    <Button size="lg" variant="outline" asChild>
      <Link href={studio}>Open it to fix</Link>
    </Button>
  ) : null;

  switch (problem.kind) {
    case "busy":
      return <Decision tone="wait" text={`One moment: ${problem.message}`} />;
    case "limit":
      return problem.wait ? (
        <Decision tone="wait" text={`Waiting for another task to finish. ${problem.message}`} />
      ) : (
        <Decision text={problem.message}>
          <Button size="lg" variant="outline" asChild>
            <Link href={routes.settings.credits(workspaceId)}>See your plan</Link>
          </Button>
          {again}
        </Decision>
      );
    case "credits":
      return (
        <Decision text={`Not enough credits for the next step. ${problem.message}`}>
          <Button size="lg" variant="outline" asChild>
            <Link href={routes.settings.credits(workspaceId)}>Credits</Link>
          </Button>
          {again}
        </Decision>
      );
    case "spend":
      return (
        <Decision text={`The video came out longer than you chose, so finishing it costs ${problem.credits} credits (you saw ${problem.shown}).`}>
          {canWrite ? (
            <Button size="lg" onClick={() => void actions.continueRun(run, { approveSpend: true })} loading={run.busy !== null}>
              Finish it · {problem.credits} credits
            </Button>
          ) : null}
          {studio ? (
            <Button size="lg" variant="outline" asChild>
              <Link href={studio}>Open it</Link>
            </Button>
          ) : null}
        </Decision>
      );
    case "fix":
      return (
        <Decision text={problem.message}>
          {open}
          {again}
        </Decision>
      );
    case "brand":
      return (
        <div className="space-y-3 rounded-xl bg-warning-soft px-4 py-3.5">
          <p className="text-body-sm text-ink text-pretty">
            <span className="font-medium">The brand check found something: </span>
            {problem.message}
          </p>
          {asking ? (
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (reason.trim().length >= 3) void actions.continueRun(run, { overrideReason: reason.trim() });
              }}
            >
              <label htmlFor={`why-${run.campaign.id}`} className="sr-only">
                Why it’s fine to finish it
              </label>
              <Input id={`why-${run.campaign.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it’s fine (kept with the brand check)" maxLength={500} className="h-11 min-w-0 flex-1" autoFocus />
              <Button size="lg" type="submit" disabled={reason.trim().length < 3} loading={run.busy !== null}>
                Finish it
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              {open}
              {problem.canOverride && canWrite ? (
                <Button size="lg" variant="ghost" onClick={() => setAsking(true)}>
                  Finish it anyway…
                </Button>
              ) : null}
              {again}
            </div>
          )}
        </div>
      );
    default:
      return (
        <Decision tone="danger" text={problem.message}>
          {again}
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
