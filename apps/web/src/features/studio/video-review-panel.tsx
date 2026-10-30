"use client";
/**
 * Owner: Track 4 (Spark video review). "Spark watched your video": Muse Spark looks at frames of the
 * RENDERED MP4 and reports what viewers would trip over. Findings sit on their frames; "Fix these
 * scenes" asks for a scene-scoped AI edit that is reviewed and applied like any other AI edit.
 * Data: apps/api/src/routes/video-reviews.ts.
 */
import type { CompositionDoc, CompositionPatch, Job, VideoReview, VideoReviewCheck, VideoReviewFinding, VideoReviewSeverity } from "@muselaunch/contracts";
import { Badge, Button, EmptyState, ErrorState, IconButton, JobProgress, Notice, Skeleton, StatusPill, cn, useToast, type BadgeTone, type StatusKind } from "@muselaunch/ui";
import { Check, Crosshair, Film, RotateCcw, ScanEye, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { api, errorMessage, isRouteMissing, wsPath } from "@/lib/api";
import { useJob } from "@/lib/jobs";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { PatchCard } from "./ai-panel";
import type { CommitResponse } from "./types";

export interface VideoReviewsResponse {
  items: VideoReview[];
  current: VideoReview | null;
  version: number;
  frameUrls: Record<string, string>;
  job: Job | null;
  render: { assetId: string; quality: "final" | "preview" } | null;
  supported: boolean;
  engine: { name: string; label: string; configured: boolean };
  credits: number;
}

interface CreateResponse {
  review: VideoReview;
  job: Job | null;
  reused: boolean;
}

interface FixResponse {
  review: VideoReview;
  patch: CompositionPatch;
  job: Job;
}

const isRunning = (r: Pick<VideoReview, "status"> | null | undefined) => r?.status === "queued" || r?.status === "running";

/** Reviews of the composition for a version (polled while Spark is watching). Shared by the tab badge and the panel. */
export function useVideoReviews(base: string, version: number | undefined) {
  return useApiQuery<VideoReviewsResponse>(version ? `${base}/video-reviews` : null, {
    query: { version },
    staleTime: 10_000,
    refetchInterval: (q) => (isRunning(q.state.data?.current) ? 2000 : false),
  });
}

/** Open blockers in the current version's review (tab badge). */
export const openVideoBlockers = (r: VideoReview | null | undefined) => (r?.status === "succeeded" ? r.findings.filter((f) => f.severity === "blocker" && !f.resolution).length : 0);

const CHECK_LABEL: Record<VideoReviewCheck, string> = {
  hook_readability: "Hook readability",
  legibility: "Legibility",
  safe_zone: "Safe zone",
  device_frame: "Device frame",
  broken_frame: "Blank frame",
  repetition: "Repetition",
  pacing: "Pacing",
  cta: "Call to action",
  brand_fit: "Brand fit",
  honesty: "Honesty",
  other: "Other",
};
const SEVERITY: Record<VideoReviewSeverity, { label: string; group: string; tone: BadgeTone; ring: string; dot: string }> = {
  blocker: { label: "Blocker", group: "Blockers", tone: "danger", ring: "ring-danger", dot: "bg-danger" },
  warn: { label: "Warning", group: "Warnings", tone: "warning", ring: "ring-warning", dot: "bg-warning" },
  info: { label: "Note", group: "Notes", tone: "neutral", ring: "ring-ink-3", dot: "bg-ink-3" },
};
const ORDER: VideoReviewSeverity[] = ["blocker", "warn", "info"];
const RANK: Record<VideoReviewSeverity, number> = { info: 0, warn: 1, blocker: 2 };
const VERDICT: Record<NonNullable<VideoReview["verdict"]>, { kind: StatusKind; label: string; bg: string }> = {
  pass: { kind: "success", label: "Looks ready", bg: "bg-success-soft" },
  warnings: { kind: "attention", label: "Worth fixing", bg: "bg-warning-soft" },
  blockers: { kind: "failed", label: "Blockers", bg: "bg-danger-soft" },
};

const secs = (t: number) => `${t.toFixed(1)}s`;
function relTime(iso?: string) {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString();
}
const fixable = (f: VideoReviewFinding, doc: CompositionDoc) => Boolean(f.sceneId && doc.scenes.some((s) => s.id === f.sceneId));

export interface VideoReviewPanelProps {
  workspaceId: string;
  /** Composition API base (`/v1/workspaces/:wid/compositions/:id`). */
  base: string;
  doc: CompositionDoc;
  version: number;
  /** Select a scene and park the playhead (frame time when known). */
  onShow?: (sceneId: string | undefined, atSec: number | undefined) => void;
  onApplied: (r: CommitResponse) => void;
  onUndo: () => void;
  disabled?: boolean;
  className?: string;
}

export function VideoReviewPanel({ workspaceId, base, doc, version, onShow, onApplied, onUndo, disabled, className }: VideoReviewPanelProps) {
  const { can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const q = useVideoReviews(base, version);
  const data = q.data;
  const current = data?.current ?? null;
  const live = useJob(workspaceId, isRunning(current) ? current?.jobId : null, { initial: data?.job, onSettled: () => void q.refetch() });
  const [starting, setStarting] = useState(false);
  const canWrite = can("content.write");

  const run = async (rerun: boolean) => {
    setStarting(true);
    try {
      await api.post<CreateResponse>(`${base}/video-reviews`, { version, rerun }, { idempotent: true });
      await invalidate(`${base}/video-reviews`);
    } catch (e) {
      toast.error("Couldn't start Spark's review", errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  if (q.isLoading) {
    return (
      <div className={cn("space-y-3 p-4", className)}>
        <Skeleton className="h-16 w-full" rounded="lg" />
        <Skeleton className="h-32 w-full" rounded="lg" />
      </div>
    );
  }
  if (q.error || !data) {
    if (isRouteMissing(q.error)) return <EmptyState className={className} size="sm" icon={<ScanEye aria-hidden />} title="Spark video review isn't in this build" description="Nothing is simulated in the meantime." />;
    return <ErrorState className={className} compact title="Spark's review didn't load" message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  }

  const done = current?.status === "succeeded";
  const previous = data.items.find((r) => r.version !== version && r.status === "succeeded");
  const reviewButton = (label: string) => (
    <Button size="sm" icon={<ScanEye className="size-4" aria-hidden />} loading={starting} disabled={disabled || !data.engine.configured} onClick={() => void run(false)}>
      {label} · {data.credits} credits
    </Button>
  );

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <header className="space-y-1 border-b border-line px-4 pb-3 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-ink">
              <ScanEye className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-headline font-semibold text-ink">{done ? "Spark watched your video" : "Review with Spark"}</h2>
              <p className="text-caption text-ink-2">
                {done ? `${current.frames.length} frames · v${current.version} ${current.renderQuality ?? ""} render · ${relTime(current.checkedAt)}` : "Spark watches the rendered video, not the plan."}
              </p>
            </div>
          </div>
          {current && !isRunning(current) && canWrite && data.render ? (
            <IconButton size="sm" label={starting ? "Starting…" : "Watch again"} disabled={starting || disabled || !data.engine.configured} onClick={() => void run(true)}>
              <RotateCcw className={cn("size-4", starting && "animate-spin")} aria-hidden />
            </IconButton>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!data.engine.configured ? (
          <Notice tone="neutral" title="Muse Spark isn't connected here">
            No model can watch the video on this deployment, so nothing is reviewed (and nothing is marked as passed).
          </Notice>
        ) : null}

        {!data.supported ? (
          <EmptyState size="sm" icon={<Film aria-hidden />} title="Spark reviews videos" description="Stills and carousels aren't supported yet." />
        ) : !current ? (
          data.render ? (
            <EmptyState
              size="sm"
              icon={<ScanEye aria-hidden />}
              title={previous ? `Changed since Spark watched v${previous.version}` : "Not watched yet"}
              description={`Spark looks at frames of the ${data.render.quality} render: hooks too fast to read, cut-off text, a phone inside a phone, blank frames, repeats, pacing, the CTA, brand fit and invented claims.`}
              action={canWrite ? reviewButton("Review with Spark") : undefined}
            />
          ) : (
            <EmptyState
              size="sm"
              icon={<Film aria-hidden />}
              title={previous ? `Changed since Spark watched v${previous.version}` : "Render this version first"}
              description="Spark watches the rendered MP4, not the editor preview. Render this version (a preview render is enough, from Render in the top bar), then ask Spark to watch it."
            />
          )
        ) : isRunning(current) ? (
          <JobProgress
            job={live.job ?? data.job}
            variant="row"
            title={`${data.engine.name} is watching your video`}
            placeholder="Queued"
            onCancel={canWrite ? () => void live.cancel() : undefined}
            cancelling={live.cancelling}
          />
        ) : current.status === "failed" ? (
          <Notice
            tone="danger"
            title="Spark couldn't watch this render"
            action={
              canWrite && data.engine.configured ? (
                <Button size="sm" variant="secondary" loading={starting} onClick={() => void run(true)}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {current.error ?? "Try again."} Nothing was reviewed, so this isn't a pass.
          </Notice>
        ) : (
          <ReviewResult
            key={current.id}
            workspaceId={workspaceId}
            base={base}
            review={current}
            doc={doc}
            frameUrls={data.frameUrls}
            canWrite={canWrite}
            onShow={onShow}
            onApplied={onApplied}
            onUndo={onUndo}
            onChanged={() => void q.refetch()}
            disabled={disabled}
          />
        )}

        {previous && !done ? (
          <p className="text-caption text-ink-3">
            Last review: v{previous.version} · {previous.score !== undefined ? `${previous.score}/10` : "no score"} · {relTime(previous.checkedAt)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ReviewResult({
  workspaceId,
  base,
  review,
  doc,
  frameUrls,
  canWrite,
  onShow,
  onApplied,
  onUndo,
  onChanged,
  disabled,
}: {
  workspaceId: string;
  base: string;
  review: VideoReview;
  doc: CompositionDoc;
  frameUrls: Record<string, string>;
  canWrite: boolean;
  onShow?: VideoReviewPanelProps["onShow"];
  onApplied: (r: CommitResponse) => void;
  onUndo: () => void;
  onChanged: () => void;
  disabled?: boolean;
}) {
  const toast = useToast();
  const sceneName = (id?: string) => (id ? (doc.scenes.find((s) => s.id === id)?.name ?? id) : "Whole video");
  const frames = useMemo(() => new Map(review.frames.map((f) => [f.ref, f])), [review.frames]);
  const candidates = review.findings.filter((f) => f.severity !== "info" && fixable(f, doc) && !f.resolution);
  // Every open, scene-tied blocker/warning is in the fix unless the person leaves it out.
  const [left, setLeft] = useState<Set<string>>(() => new Set());
  const chosen = candidates.filter((f) => !left.has(f.id));
  const [fixing, setFixing] = useState(false);
  const [fix, setFix] = useState<{ patchId: string; job: Job | null } | null>(null);
  const fixJob = useJob(workspaceId, fix?.job?.id ?? null, { initial: fix?.job, onSettled: onChanged });
  const patchId = fix?.patchId ?? review.fixPatchIds.at(-1) ?? null;
  const verdict = review.verdict ? VERDICT[review.verdict] : null;
  const worstOnFrame = (ref: string) =>
    review.findings.filter((f) => f.frameRef === ref).reduce<VideoReviewSeverity | null>((w, f) => (!w || RANK[f.severity] > RANK[w] ? f.severity : w), null);
  const portrait = doc.height >= doc.width;

  const requestFix = async () => {
    setFixing(true);
    try {
      const r = await api.post<FixResponse>(wsPath(workspaceId, `/video-reviews/${review.id}/fix`), { findingIds: chosen.map((f) => f.id) }, { idempotent: true });
      setFix({ patchId: r.patch.id, job: r.job });
      onChanged();
      toast.success("Fix requested", "Review the edit below, then apply it. Only the flagged scenes change.");
    } catch (e) {
      toast.error("Couldn't request the fix", errorMessage(e));
    } finally {
      setFixing(false);
    }
  };

  return (
    <>
      <section className={cn("space-y-1.5 rounded-xl px-3.5 py-3", verdict?.bg ?? "bg-mist")} aria-label="Spark's verdict">
        <div className="flex items-center gap-2">
          {review.score !== undefined ? (
            <p className="text-ink">
              <span className="text-title-2 font-semibold tabular">{review.score}</span>
              <span className="text-caption text-ink-2">/10</span>
            </p>
          ) : null}
          {verdict ? <StatusPill status={verdict.kind}>{verdict.label}</StatusPill> : null}
        </div>
        <p className="text-footnote text-ink">{review.summary}</p>
        <p className="text-caption text-ink-2" title={review.reviewer.model}>
          Reviewed by {review.reviewer.label ?? "Muse Spark"} from the pixels{review.reviewer.note ? ` · ${review.reviewer.note}` : ""}
        </p>
      </section>

      {review.rubric.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Checks">
          {review.rubric.map((r) => (
            <li key={r.check}>
              <Badge tone={r.verdict === "ok" ? "success" : r.verdict === "issue" ? "warning" : "neutral"} icon={r.verdict === "ok" ? <Check aria-hidden /> : undefined} title={r.note ?? (r.verdict === "unclear" ? "The frames can't show this" : undefined)}>
                {CHECK_LABEL[r.check]}
                {r.verdict === "unclear" ? " ?" : ""}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      {review.frames.length ? (
        <section className="space-y-2" aria-label="Frames Spark watched">
          <h3 className="text-caption font-semibold uppercase tracking-wide text-ink-2">Frames · {review.frames.length}</h3>
          <ol className={cn("grid gap-1.5", portrait ? "grid-cols-4" : "grid-cols-2")}>
            {review.frames.map((f) => {
              const worst = worstOnFrame(f.ref);
              return (
                <li key={f.ref}>
                  <button
                    type="button"
                    className={cn("group relative block w-full overflow-hidden rounded-md bg-mist text-left ring-offset-1 focus-visible:outline-none focus-visible:shadow-focus", worst ? cn("ring-2", SEVERITY[worst].ring) : "ring-1 ring-line")}
                    style={{ aspectRatio: `${doc.width} / ${doc.height}` }}
                    onClick={() => onShow?.(f.sceneId, f.atSec)}
                    aria-label={`Frame ${f.ref} at ${secs(f.atSec)}, ${sceneName(f.sceneId)}${worst ? `, ${SEVERITY[worst].label.toLowerCase()}` : ""}`}
                  >
                    {frameUrls[f.ref] ? <img src={frameUrls[f.ref]} alt="" className="size-full object-cover" loading="lazy" /> : null}
                    <span className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/60 to-transparent px-1 pb-0.5 pt-3 text-[10px] font-medium leading-3 text-white">
                      <span>{f.ref}</span>
                      <span className="tabular">{secs(f.atSec)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {canWrite && candidates.length ? (
        <section className="space-y-2 rounded-lg border border-line p-3" aria-label="Fix these scenes">
          <div className="flex items-center justify-between gap-2">
            <p className="text-body-sm font-medium text-ink">Fix these scenes</p>
            <Button size="sm" icon={<Wand2 className="size-4" aria-hidden />} loading={fixing} disabled={disabled || !chosen.length || fixing} onClick={() => void requestFix()}>
              Fix {chosen.length} issue{chosen.length === 1 ? "" : "s"}
            </Button>
          </div>
          <p className="text-footnote text-ink-2">Muse proposes a scene-scoped edit from the selected issues. You review it before it's applied; other scenes stay exactly as they are.</p>
        </section>
      ) : null}

      {fix && fixJob.job && fixJob.job.status !== "succeeded" ? (
        <JobProgress job={fixJob.job} variant="row" title="Muse is preparing the fix" onCancel={() => void fixJob.cancel()} onRetry={() => void fixJob.retry()} cancelling={fixJob.cancelling} retrying={fixJob.retrying} />
      ) : patchId && (!fix || fixJob.job?.status === "succeeded" || !fixJob.job) ? (
        <PatchCard base={base} patchId={patchId} doc={doc} onApplied={onApplied} onUndo={onUndo} disabled={disabled} />
      ) : null}

      {ORDER.map((sev) => {
        const items = review.findings.filter((f) => f.severity === sev);
        if (!items.length) return null;
        return (
          <section key={sev} className="space-y-2" aria-label={SEVERITY[sev].group}>
            <h3 className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-ink-2">
              <span className={cn("size-1.5 rounded-full", SEVERITY[sev].dot)} aria-hidden />
              {SEVERITY[sev].group} · {items.length}
            </h3>
            {items.map((f) => (
              <FindingCard
                key={f.id}
                finding={f}
                sceneName={sceneName(f.sceneId)}
                frameUrl={f.frameRef ? frameUrls[f.frameRef] : undefined}
                frameAt={f.frameRef ? frames.get(f.frameRef)?.atSec : undefined}
                aspect={`${doc.width} / ${doc.height}`}
                selectable={canWrite && candidates.some((c) => c.id === f.id)}
                selected={!left.has(f.id)}
                onToggle={() =>
                  setLeft((s) => {
                    const next = new Set(s);
                    if (next.has(f.id)) next.delete(f.id);
                    else next.add(f.id);
                    return next;
                  })
                }
                onShow={onShow}
              />
            ))}
          </section>
        );
      })}

      {!review.findings.length ? (
        <p className="flex items-center gap-2 text-footnote text-ink-2">
          <Check className="size-4 text-success" aria-hidden />
          Spark didn't see anything to fix in this render.
        </p>
      ) : null}
    </>
  );
}

function FindingCard({
  finding: f,
  sceneName,
  frameUrl,
  frameAt,
  aspect,
  selectable,
  selected,
  onToggle,
  onShow,
}: {
  finding: VideoReviewFinding;
  sceneName: string;
  frameUrl?: string;
  frameAt?: number;
  aspect: string;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onShow?: VideoReviewPanelProps["onShow"];
}) {
  const sev = SEVERITY[f.severity];
  return (
    <article className={cn("flex gap-3 rounded-lg border bg-surface p-3", f.severity === "blocker" ? "border-danger/30" : "border-line")}>
      {frameUrl ? (
        <button type="button" className="w-12 shrink-0 self-start overflow-hidden rounded bg-mist ring-1 ring-line focus-visible:outline-none focus-visible:shadow-focus" style={{ aspectRatio: aspect }} onClick={() => onShow?.(f.sceneId, frameAt)} aria-label={`Show frame ${f.frameRef}`}>
          <img src={frameUrl} alt="" className="size-full object-cover" loading="lazy" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={sev.tone}>{sev.label}</Badge>
          <span className="text-caption font-semibold text-ink-2">{CHECK_LABEL[f.check]}</span>
          <span className="text-caption text-ink-3">· {sceneName}</span>
        </div>
        <p className="text-body-sm text-ink">{f.issue}</p>
        <p className="text-footnote text-ink-2">
          <span className="font-medium text-ink">Fix:</span> {f.fixInstruction}
        </p>
        {f.measurement ? <p className="text-caption text-ink-3">Measured: {f.measurement}</p> : null}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {selectable ? (
            <button
              type="button"
              aria-pressed={selected}
              onClick={onToggle}
              className={cn("inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus", selected ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:border-line-strong")}
            >
              {selected ? <Check className="size-3.5" aria-hidden /> : null}
              {selected ? "In the fix" : "Add to fix"}
            </button>
          ) : f.resolution ? (
            <span className="text-caption text-ink-3">Fix requested</span>
          ) : !f.sceneId ? (
            <span className="text-caption text-ink-3">About the whole video: ask Muse to edit it.</span>
          ) : null}
          {onShow && (f.sceneId || frameAt !== undefined) ? (
            <Button size="sm" variant="ghost" icon={<Crosshair className="size-4" aria-hidden />} onClick={() => onShow(f.sceneId, frameAt)}>
              Show
            </Button>
          ) : null}
          <span className={cn("ml-auto rounded px-1.5 py-px text-[11px] font-medium leading-4", f.source === "spark" ? "bg-accent-soft text-accent-ink" : "bg-mist-2 text-ink-2")} title={f.source === "measured" ? "A deterministic measurement, not a model opinion" : "Spark saw this in the frames"}>
            {f.source === "spark" ? "Spark" : "Measured"}
          </span>
        </div>
      </div>
    </article>
  );
}
