"use client";
/**
 * One Create run, in plain words: its steps for what it makes (a video: Writing the idea → Planning
 * the video → Making it → Checking facts and brand → Finishing; a carousel: … Planning the slides →
 * Making the carousel …; a text post: Writing the idea → Writing the post → Checking facts) with real
 * progress from the jobs, and, when the server stopped for the person, its decision right here
 * (credits, a plan limit, the facts or brand check, a longer video, a day without progress, a failed
 * step). Finished: the video (Open it, Post it), the slides (a gallery: Download all, Edit, Schedule
 * post) or the post text (as it will read, its length and fact check: Copy, Schedule post).
 * Everything shown comes from the server's read model; the buttons answer its decision.
 */
import type { CreateRunDecision, CreateRunText } from "@muselaunch/contracts";
import { Button, Input, ProgressBar, Spinner, cn, useToast } from "@muselaunch/ui";
import { ArrowUpRight, CalendarClock, Check, Copy, Download, PenLine, Play, RotateCcw, Send, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { SlideGallery } from "@/components/creator/slide-gallery";
import { TextPostCard } from "@/components/creator/text-post-card";
import { errorMessage } from "@/lib/api";
import { downloadSlides } from "@/lib/slides";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { clock, isMoving, isSlideSet, isThumbnailStills, makeNoun, needsPerson, runMake, stageLabel, stepState, stepsFor, type FinishedStills, type FinishedVideo, type MakeFormat } from "./plan";
import type { CreateRun, CreateRunsState } from "./runs";
import type { ScheduleTarget } from "./schedule";

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

/** "Your carousel is ready", "Your screenshots stopped", "Making your post". */
export function headline(run: Pick<CreateRun, "status" | "decision" | "format">): string {
  const { noun, plural } = makeNoun(runMake(run));
  const is = plural ? "are" : "is";
  const needs = plural ? "need" : "needs";
  if (run.status === "done") return `Your ${noun} ${is} ready`;
  if (run.status === "failed") return `Your ${noun} stopped`;
  if (run.status === "stopped" || run.decision?.kind === "resume") return `Your ${noun} ${is} waiting`;
  if (run.status === "needs_you") return `Your ${noun} ${needs} you`;
  return `Making your ${noun}`;
}

/** The finished stills of a run: the server's (`run.stills`), else what Your content found for its composition. */
function stillsOf(run: CreateRun, found?: FinishedStills): FinishedStills | null {
  if (run.stills?.assetIds.length)
    return { compositionId: run.compositionId ?? found?.compositionId ?? "", assetIds: run.stills.assetIds, campaignId: run.campaignId, title: run.ideaTitle ?? run.name, width: run.stills.width ?? found?.width, height: run.stills.height ?? found?.height, version: run.stills.version ?? found?.version, renderedAt: run.stills.renderedAt ?? found?.renderedAt ?? run.createdAt };
  return found ?? null;
}

export function RunPanel({ run, finished, stills, actions, appId, onSchedule }: { run: CreateRun; finished?: FinishedVideo; stills?: FinishedStills; actions: CreateRunsState; appId: string; onSchedule: (t: ScheduleTarget) => void }) {
  const { workspaceId, can } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const canWrite = can("content.write");
  const busy = actions.busy[run.campaignId];
  const can_ = (a: Parameters<CreateRunsState["resolve"]>[1]) => canWrite && run.actions.includes(a);
  const make = runMake(run);
  const steps = stepsFor(make);
  const noun = makeNoun(make).noun;
  const doneStills = run.status === "done" && make !== "video" && make !== "text_post" ? stillsOf(run, stills) : null;
  const doneText = run.status === "done" && make === "text_post" ? (run.text ?? null) : null;

  return (
    <section aria-labelledby={`run-${run.campaignId}`} aria-live="polite" className="space-y-5 rounded-2xl bg-surface p-5 shadow-raised sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {run.status === "done" && finished && make === "video" ? <DonePoster video={finished} href={r.studio(finished.compositionId)} /> : null}
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
          <ol className={cn("grid gap-2.5 sm:gap-3", steps.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-5")}>
            {steps.map(({ key: s, label }) => {
              const state = stepState(run, s, steps);
              const current = state === "current" || state === "failed";
              return (
                <li key={s} className="flex items-start gap-2.5 sm:flex-col sm:gap-2">
                  <StepIcon state={state === "current" ? (needsPerson(run) ? "attention" : isMoving(run) ? "current" : "todo") : state} />
                  <div className="min-w-0">
                    <p className={cn("text-body-sm", current ? "font-semibold text-ink" : state === "done" ? "text-ink" : "text-ink-3")}>{label}</p>
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
        <Decision text={`You left this ${noun} at “${stageLabel(make, run.stage)}”. ${make === "text_post" ? "Nothing was posted" : "It stays in the editor"}; Muse carries on only if you continue it.`}>
          {can_("retry") ? (
            <Button size="lg" onClick={() => void actions.resolve(run, "retry")} loading={busy === "retry"}>
              Continue
            </Button>
          ) : null}
        </Decision>
      ) : null}

      {doneStills ? <StillsResult stills={doneStills} make={make} studioHref={run.compositionId ? r.studio(run.compositionId) : null} canWrite={canWrite} onSchedule={() => onSchedule({ type: "stills", ...doneStills, campaignId: doneStills.campaignId ?? run.campaignId })} /> : null}
      {doneText ? <TextResult text={doneText} canWrite={canWrite} onSchedule={() => onSchedule({ type: "text", campaignId: run.campaignId, copyPackId: doneText.copyPackId, channel: doneText.channel, text: doneText.text, ok: doneText.ok, title: run.ideaTitle ?? run.name, at: run.createdAt })} /> : null}
      {run.status === "done" && make !== "video" && make !== "text_post" && !doneStills ? (
        <p className="flex items-center gap-2 text-body-sm text-ink-2">
          <Spinner size={14} className="text-ink-3" />
          Loading the finished {isSlideSet(make) ? "slides" : "image"}…
        </p>
      ) : null}

      {run.status === "done" && run.compositionId && make === "video" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="lg" asChild>
            <Link href={r.studio(run.compositionId)}>
              <Play className="size-4" aria-hidden />
              Open it
            </Link>
          </Button>
          {canWrite && finished ? (
            <Button size="lg" variant="outline" icon={<Send className="size-4" aria-hidden />} onClick={() => onSchedule({ type: "video", ...finished })}>
              Post it
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className="text-caption text-ink-3">
        {run.status === "done"
          ? make === "text_post"
            ? "Want it different? Make another, or change the words when you schedule it. Nothing is posted without your OK."
            : "Change anything by telling Muse in the editor. Nothing is posted without your OK."
          : "It keeps going even when MuseLaunch is closed. Nothing is posted without your OK."}
        <span className="mx-1.5" aria-hidden>
          ·
        </span>
        {make === "text_post" ? "Muse Spark writes it · checked against your facts" : "Muse Spark plans it · HyperFrames renders it"}
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

function StillsResult({ stills, make, studioHref, canWrite, onSchedule }: { stills: FinishedStills; make: MakeFormat; studioHref: string | null; canWrite: boolean; onSchedule: () => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const n = stills.assetIds.length;
  const store = make === "store_screenshots";
  return (
    <div className="space-y-4">
      <SlideGallery assetIds={stills.assetIds} width={stills.width} height={stills.height} title={stills.title} />
      {stills.width && stills.height ? (
        <p className="text-caption text-ink-3 tabular">
          {n} {n === 1 ? "image" : "images"} · {stills.width} × {stills.height}
          {store ? " · ready to upload to the store" : ""}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {canWrite && !store ? (
          <Button size="lg" className="col-span-2 sm:col-span-1" icon={<CalendarClock className="size-4 shrink-0" aria-hidden />} onClick={onSchedule}>
            {isThumbnailStills(stills) ? "Use as cover" : "Schedule post"}
          </Button>
        ) : null}
        <Button
          size="lg"
          variant={store || !canWrite ? "primary" : "outline"}
          className={cn(store && "col-span-2 sm:col-span-1")}
          icon={<Download className="size-4 shrink-0" aria-hidden />}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const how = await downloadSlides(workspaceId, { assetIds: stills.assetIds, campaignId: stills.campaignId, compositionId: stills.compositionId || undefined });
              if (how === "zip") toast.success("Downloaded", `All ${n} slides in one ZIP, with the captions Muse wrote.`);
            } catch (e) {
              toast.error("Download failed", errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {n > 1 ? "Download all" : "Download"}
        </Button>
        {studioHref ? (
          <Button size="lg" variant="outline" asChild>
            <Link href={studioHref}>
              <PenLine className="size-4" aria-hidden />
              Edit
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TextResult({ text, canWrite, onSchedule }: { text: CreateRunText; canWrite: boolean; onSchedule: () => void }) {
  const toast = useToast();
  return (
    <div className="space-y-4">
      <TextPostCard text={text.text} channel={text.channel} ok={text.ok} className="max-w-xl bg-canvas shadow-[0_0_0_1px_var(--ml-line)]" />
      {!text.ok ? <p className="text-footnote text-ink-2 text-pretty">The fact check found something to look at. When you schedule it, the post shows what and offers one-tap fixes.</p> : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {canWrite ? (
          <Button size="lg" icon={<CalendarClock className="size-4 shrink-0" aria-hidden />} onClick={onSchedule}>
            Schedule post
          </Button>
        ) : null}
        <Button
          size="lg"
          variant="outline"
          icon={<Copy className="size-4 shrink-0" aria-hidden />}
          onClick={() =>
            void navigator.clipboard?.writeText(text.text).then(
              () => toast.success("Post copied"),
              () => toast.error("Couldn’t copy", "Select the text and copy it by hand."),
            )
          }
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
