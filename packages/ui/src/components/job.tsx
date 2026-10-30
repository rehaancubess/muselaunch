"use client";
import type { Job } from "@muselaunch/contracts";
import { Check, RotateCcw, X, AlertTriangle, Minus } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { cn } from "../cn";
import { StatusPill, humanizeStatus, statusKindOf } from "./badge";
import { ProgressBar } from "./feedback";

const JOB_LABELS: Record<string, string> = {
  "app.import": "Importing app listing",
  "app.analyze": "Analysing App DNA",
  "research.run": "Researching market",
  "strategy.run": "Planning strategy",
  "campaign.generate_concepts": "Generating concepts",
  "storyboard.generate": "Writing storyboard",
  "storyboard.resolve_media": "Finding lifestyle b-roll",
  "composition.build": "Building composition",
  "composition.edit": "Applying AI edit",
  "composition.variants": "Making variants",
  "copy.generate": "Writing copy",
  "render.preview": "Rendering preview",
  "render.final": "Rendering final video",
  "package.export": "Packaging export",
  "media.probe": "Processing upload",
  "media.segment": "Segmenting subject (SAM)",
  "media.transcribe": "Transcribing audio",
  "media.image_generate": "Generating image",
  "media.tts": "Generating narration",
  "discover.refresh": "Refreshing Discover",
  "outreach.draft": "Drafting outreach",
  "outreach.send": "Sending outreach",
  "publish.post": "Publishing post",
  "analytics.sync": "Syncing analytics",
  "analytics.import_csv": "Importing CSV",
  "analytics.youtube_channel": "Analysing YouTube channel",
  "experiment.analyze": "Analysing experiment",
  "recommendations.generate": "Generating recommendations",
  "memory.ingest": "Updating brand memory",
};

export function jobLabel(type: string): string {
  return JOB_LABELS[type] ?? humanizeStatus(type.replace(/\./g, " "));
}

export interface JobProgressProps {
  job: Pick<Job, "id" | "type" | "status" | "progress" | "error" | "attempts" | "maxAttempts" | "cancelRequested"> | null | undefined;
  title?: ReactNode;
  onCancel?: () => void;
  onRetry?: () => void;
  cancelling?: boolean;
  retrying?: boolean;
  /** Compact row for trays; default is a full block. */
  variant?: "block" | "row";
  className?: string;
  /** Shown while job is null (e.g. connecting). */
  placeholder?: string;
}

/** Live job status: stage, percentage, cancel while running, retry after failure. */
export function JobProgress({ job, title, onCancel, onRetry, cancelling, retrying, variant = "block", className, placeholder = "Starting…" }: JobProgressProps) {
  const status = job?.status ?? "queued";
  const running = status === "queued" || status === "running";
  const failed = status === "failed";
  const pct = job?.progress?.pct ?? 0;
  const stage = job ? (job.cancelRequested && running ? "Cancelling…" : job.progress?.message || humanizeStatus(job.progress?.stage ?? status)) : placeholder;
  const label = title ?? (job ? jobLabel(job.type) : "Job");
  const tone = failed ? "danger" : status === "succeeded" ? "success" : status === "cancelled" ? "neutral" : "accent";

  return (
    <div className={cn(variant === "block" ? "space-y-3" : "space-y-2", className)} aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className={cn("truncate font-medium text-ink", variant === "block" ? "text-body" : "text-body-sm")}>{label}</p>
          <p className={cn("text-footnote", failed ? "text-danger" : "text-ink-2", !failed ? "truncate" : variant === "row" ? "line-clamp-2" : "text-pretty")}>{failed ? (job?.error?.userMessage ?? job?.error?.message ?? "Something went wrong") : stage}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {running && status === "running" ? <span className="text-footnote tabular text-ink-2">{Math.round(pct)}%</span> : null}
          {!running ? <StatusPill status={statusKindOf(status)}>{humanizeStatus(status)}</StatusPill> : null}
          {running && onCancel && !job?.cancelRequested ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              aria-label="Cancel job"
              title="Cancel"
              className="inline-flex size-7 items-center justify-center rounded-full text-ink-3 hover:bg-mist hover:text-ink disabled:opacity-50"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null}
          {failed && onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-mist px-2.5 text-footnote font-medium text-ink hover:bg-mist-2 disabled:opacity-50"
            >
              <RotateCcw className={cn("size-3", retrying && "animate-spin")} aria-hidden /> Retry
            </button>
          ) : null}
        </div>
      </div>
      {running || status === "succeeded" ? <ProgressBar value={status === "queued" && pct === 0 ? null : status === "succeeded" ? 100 : pct} tone={tone} label={typeof label === "string" ? label : "Progress"} /> : null}
      {failed && job?.error?.retryable === false && variant === "block" ? (
        <p className="text-footnote text-ink-3">Credits reserved for this job were released.</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- PipelineSteps

export const PIPELINE_STEPS = ["research", "concept", "storyboard", "assets", "composition", "render", "review"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export type StepState = "done" | "active" | "pending" | "failed" | "skipped" | "attention";

const STEP_LABEL: Record<PipelineStep, string> = {
  research: "Research",
  concept: "Concepts",
  storyboard: "Storyboard",
  assets: "Assets",
  composition: "Composition",
  render: "Render",
  review: "Review",
};

export interface PipelineStepsProps {
  states: Partial<Record<PipelineStep, StepState>>;
  details?: Partial<Record<PipelineStep, ReactNode>>;
  className?: string;
  orientation?: "horizontal" | "vertical" | "auto";
}

function StepDot({ state, index }: { state: StepState; index: number }) {
  return (
    <span
      className={cn(
        "relative flex size-7 shrink-0 items-center justify-center rounded-full text-caption font-semibold tabular transition-colors duration-300",
        state === "done" && "bg-ink text-white",
        state === "active" && "bg-accent text-white",
        state === "attention" && "bg-warning text-white",
        state === "failed" && "bg-danger text-white",
        state === "pending" && "bg-surface text-ink-3 ring-1 ring-inset ring-line-strong",
        state === "skipped" && "bg-mist text-ink-3",
      )}
    >
      {state === "active" ? <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-accent/30 [animation-duration:1.8s]" /> : null}
      {state === "done" ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : state === "failed" ? <X className="size-3.5" strokeWidth={3} aria-hidden /> : state === "attention" ? <AlertTriangle className="size-3.5" aria-hidden /> : state === "skipped" ? <Minus className="size-3.5" aria-hidden /> : <span className="relative">{index + 1}</span>}
    </span>
  );
}

/** research → concept → storyboard → assets → composition → render → review */
export function PipelineSteps({ states, details, className, orientation = "auto" }: PipelineStepsProps) {
  const horizontal = (
    <ol className={cn("items-start", orientation === "auto" ? "hidden md:flex" : "flex")} aria-label="Campaign pipeline">
      {PIPELINE_STEPS.map((s, i) => {
        const st = states[s] ?? "pending";
        return (
          <Fragment key={s}>
            <li className="flex min-w-0 flex-col items-center gap-2 text-center" aria-current={st === "active" ? "step" : undefined}>
              <StepDot state={st} index={i} />
              <div className="space-y-0.5">
                <p className={cn("text-footnote font-medium", st === "pending" || st === "skipped" ? "text-ink-3" : "text-ink")}>{STEP_LABEL[s]}</p>
                {details?.[s] ? <p className="max-w-28 text-caption text-ink-2">{details[s]}</p> : null}
              </div>
            </li>
            {i < PIPELINE_STEPS.length - 1 ? (
              <li aria-hidden className="mt-3.5 h-px min-w-4 flex-1 bg-line-strong">
                <span className={cn("block h-px bg-ink transition-[width] duration-500 ease-out", st === "done" ? "w-full" : "w-0")} />
              </li>
            ) : null}
          </Fragment>
        );
      })}
    </ol>
  );
  const vertical = (
    <ol className={cn("space-y-0", orientation === "auto" ? "md:hidden" : "")} aria-label="Campaign pipeline">
      {PIPELINE_STEPS.map((s, i) => {
        const st = states[s] ?? "pending";
        return (
          <li key={s} className="relative flex gap-3 pb-4 last:pb-0" aria-current={st === "active" ? "step" : undefined}>
            {i < PIPELINE_STEPS.length - 1 ? <span aria-hidden className={cn("absolute left-3.5 top-7 bottom-0 w-px", st === "done" ? "bg-ink" : "bg-line-strong")} /> : null}
            <StepDot state={st} index={i} />
            <div className="min-w-0 pt-1">
              <p className={cn("text-body-sm font-medium", st === "pending" || st === "skipped" ? "text-ink-3" : "text-ink")}>{STEP_LABEL[s]}</p>
              {details?.[s] ? <p className="text-footnote text-ink-2">{details[s]}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
  return (
    <div className={className}>
      {orientation !== "vertical" ? horizontal : null}
      {orientation !== "horizontal" ? vertical : null}
    </div>
  );
}
