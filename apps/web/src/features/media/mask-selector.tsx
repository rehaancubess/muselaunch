"use client";
/**
 * Owner: module D (Multimodal media). SAM 3.1 subject selection on an asset:
 * concept prompt → live job → selection preview (subject bright, background dimmed) → pick objects
 * (free re-render) → refine by re-prompt / box / points on any frame. Shows tracking quality and the
 * unmasked-fallback notice, reuse (no new charge) and a credit estimate before every paid action.
 */
import type { Segmentation } from "@muselaunch/contracts";
import { Badge, Button, Card, Checkbox, ChoiceChips, CostEstimate, ErrorState, Input, JobProgress, Notice, SegmentedControl, Skeleton, Switch, cn } from "@muselaunch/ui";
import { Box, Download, MousePointerClick, RefreshCw, ScanFace, Sparkles, Type } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { AssetResponse, Page } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { PERSON_PROMPT, fetchEstimate, qualityOf, useSignedUrl, type CorrectResponse, type SegmentResponse, type SegmentationView } from "./lib";

export interface MaskSelectorProps {
  assetId: string;
  /** Called when a selection succeeds (use `segmentationId` in a layer's `mask`). */
  onSegmentation?: (segmentationId: string) => void;
  /** Open an existing selection instead of the asset's latest one. */
  initialSegmentationId?: string;
  className?: string;
}

const SUGGESTIONS = ["person", "phone", "laptop", "hand", "product"] as const;
type Mode = "prompt" | "box" | "point";
type Pt = { x: number; y: number; label: "positive" | "negative" };
type Rect = { x: number; y: number; w: number; h: number };

export default function MaskSelector({ assetId, onSegmentation, initialSegmentationId, className }: MaskSelectorProps) {
  const { workspaceId: wid, can } = useWorkspace();
  const invalidate = useInvalidate();
  const assetQ = useApiQuery<AssetResponse>(wsPath(wid, `/assets/${assetId}`), {
    refetchInterval: (q) => (q.state.data && ["uploaded", "processing", "pending_upload"].includes(q.state.data.asset.status) ? 3000 : false),
  });
  const asset = assetQ.data?.asset;
  const ready = asset?.status === "ready";
  const source = useSignedUrl(wid, ready ? assetId : null);

  const listQ = useApiQuery<Page<Segmentation>>(initialSegmentationId ? null : wsPath(wid, `/assets/${assetId}/segmentations`));
  const [segId, setSegId] = useState<string | null>(initialSegmentationId ?? null);
  useEffect(() => {
    if (!segId && listQ.data?.items[0]) setSegId(listQ.data.items[0].id);
  }, [segId, listQ.data]);
  const segPath = segId ? wsPath(wid, `/segmentations/${segId}`) : null;
  const segQ = useApiQuery<SegmentationView>(segPath, {
    refetchInterval: (q) => (["queued", "running"].includes(q.state.data?.segmentation.status ?? "") ? 2500 : false),
  });
  const view = segQ.data;
  const seg = view?.segmentation;
  const preview = useSignedUrl(wid, view?.assets.preview?.id);
  const cutout = useSignedUrl(wid, view?.assets.cutout?.id);

  const [jobId, setJobId] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [consent, setConsent] = useState(false);
  const [mode, setMode] = useState<Mode>("prompt");
  const [showSelection, setShowSelection] = useState(true);
  const [frame, setFrame] = useState(0);
  const [box, setBox] = useState<Rect | null>(null);
  const [points, setPoints] = useState<Pt[]>([]);
  const [polarity, setPolarity] = useState<"positive" | "negative">("positive");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const job = useJob(wid, jobId, {
    onSettled: (j) => {
      if (segPath) void invalidate(segPath, wsPath(wid, `/assets/${assetId}/segmentations`), wsPath(wid, "/assets"));
      if (j.status === "succeeded" && segId) onSegmentation?.(segId);
    },
  });

  const isVideo = asset?.kind === "video";
  const fps = asset?.fps ?? 30;
  const frameCount = seg?.frameCount ?? Math.max(1, Math.round((asset?.durationSec ?? 0) * fps));
  const needsConsent = Boolean(asset && !asset.license?.consent && (asset.role === "founder_clip" || PERSON_PROMPT.test(mode === "prompt" ? prompt || seg?.prompt || "" : seg?.prompt || "")));
  const running = seg?.status === "queued" || seg?.status === "running" || job.job?.status === "running" || job.job?.status === "queued";
  const canWrite = can("content.write");
  const estimateParams = useMemo(() => ({ mediaType: asset?.kind, durationSec: asset?.durationSec ?? 0 }), [asset?.kind, asset?.durationSec]);
  useEffect(() => setPicked(seg?.selectedObjectIds?.length ? seg.selectedObjectIds : null), [seg?.id, seg?.updatedAt, seg?.selectedObjectIds]);

  const run = useCallback(
    async (fn: () => Promise<SegmentResponse | CorrectResponse>) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fn();
        setSegId(r.segmentation.id);
        setJobId(r.job?.id ?? null);
        setReused("reused" in r ? r.reused : false);
        setShowSelection(true);
        await invalidate(wsPath(wid, `/segmentations/${r.segmentation.id}`), wsPath(wid, `/assets/${assetId}`));
        if (!r.job && r.segmentation.status === "succeeded") onSegmentation?.(r.segmentation.id);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [wid, assetId, invalidate, onSegmentation],
  );

  const start = (text: string) =>
    run(() => api.post<SegmentResponse>(wsPath(wid, `/assets/${assetId}/segment`), { prompt: text, consent: needsConsent && consent ? { scope: "Permission from the person shown to use their likeness in marketing" } : undefined }, { idempotent: true }));

  const correct = (body: unknown) => segId && run(() => api.post<CorrectResponse>(wsPath(wid, `/segmentations/${segId}/correct`), body, { idempotent: true }));

  if (assetQ.isLoading) return <Skeleton className={cn("h-96 w-full", className)} rounded="xl" />;
  if (assetQ.error || !asset) return <ErrorState message={errorMessage(assetQ.error)} onRetry={() => void assetQ.refetch()} className={className} />;
  if (asset.kind !== "image" && asset.kind !== "video") return <Notice className={className}>Only images and videos can be segmented.</Notice>;

  const q = qualityOf(seg?.trackingQuality);
  const objects = seg?.objects ?? [];
  const chosen = picked ?? objects.map((o) => o.objectId);
  const selectionChanged = Boolean(seg && picked && (picked.length !== (seg.selectedObjectIds.length || objects.length) || picked.some((id) => !(seg.selectedObjectIds.length ? seg.selectedObjectIds : objects.map((o) => o.objectId)).includes(id))));
  const showPreview = mode === "prompt" && showSelection && view?.assets.preview && preview.data?.url && seg?.status === "succeeded";
  const editing = mode !== "prompt";

  return (
    <Card padding="lg" className={cn("space-y-5", className)}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
            <ScanFace className="size-4" aria-hidden />
          </span>
          <div>
            <h3 className="text-headline font-semibold text-ink">Select a subject</h3>
            <p className="text-footnote text-ink-2">Cut out a person or object with SAM 3.1. Compositing happens in your video.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="outline" icon={<Sparkles aria-hidden />}>SAM 3.1 · Meta</Badge>
          {seg?.status === "succeeded" && objects.length ? <Badge tone={q.tone}>{isVideo ? q.label : `Confidence ${Math.round((seg.trackingQuality ?? 0) * 100)}%`}</Badge> : null}
          {reused || seg?.reusedFromSegmentationId ? <Badge tone="success">Reused · no new charge</Badge> : null}
        </div>
      </header>

      {/* Stage */}
      <div className="relative flex min-h-48 items-center justify-center overflow-hidden rounded-xl bg-mist">
        {!ready ? (
          <div className="flex flex-col items-center gap-2 py-16 text-footnote text-ink-2">
            <Skeleton className="h-40 w-64" rounded="lg" />
            Processing upload…
          </div>
        ) : (
          <div className="relative inline-block max-w-full">
            {showPreview ? (
              view!.assets.preview!.kind === "video" ? (
                <video key={preview.data!.url} src={preview.data!.url} className="block max-h-[60vh] max-w-full" autoPlay loop muted playsInline aria-label="Selection preview" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview.data!.url} alt="Selection preview: subject highlighted" className="block max-h-[60vh] max-w-full" />
              )
            ) : source.data?.url ? (
              isVideo ? (
                <FrameVideo url={source.data.url} fps={fps} frame={frame} controls={!editing} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={source.data.url} alt={asset.title ?? "Source image"} className="block max-h-[60vh] max-w-full select-none" draggable={false} />
              )
            ) : (
              <Skeleton className="h-64 w-96 max-w-full" rounded="lg" />
            )}
            {editing ? <EditOverlay mode={mode} box={box} points={points} polarity={polarity} onBox={setBox} onPoint={(p) => setPoints((ps) => [...ps, p].slice(-8))} /> : null}
          </div>
        )}
        {running ? <div className="absolute inset-x-0 bottom-0 h-1 animate-pulse bg-accent/60" aria-hidden /> : null}
      </div>

      {editing && isVideo ? (
        <label className="flex items-center gap-3 text-footnote text-ink-2">
          <span className="w-24 shrink-0 tabular">Frame {frame + 1}/{frameCount}</span>
          <input type="range" min={0} max={Math.max(0, frameCount - 1)} value={frame} onChange={(e) => setFrame(Number(e.target.value))} className="w-full accent-[var(--ml-accent)]" aria-label="Frame to annotate" />
        </label>
      ) : null}

      {seg?.status === "succeeded" && view?.assets.preview ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {mode === "prompt" ? <Switch checked={showSelection} onCheckedChange={setShowSelection} label="Show selection" /> : <span />}
          {cutout.data?.url ? (
            <a href={cutout.data.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-footnote font-medium text-accent hover:underline">
              <Download className="size-3.5" aria-hidden /> Cutout ({view.assets.cutout?.mimeType === "video/webm" ? "WebM with alpha" : "PNG"})
            </a>
          ) : null}
        </div>
      ) : null}

      {jobId && (running || job.job?.status === "failed") ? (
        <JobProgress job={job.job} onCancel={() => void job.cancel()} onRetry={() => void job.retry()} cancelling={job.cancelling} retrying={job.retrying} />
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {seg?.status === "failed" && !jobId ? <Notice tone="danger" title="Selection failed">{seg.error ?? "Try again or use a different prompt."}</Notice> : null}
      {seg?.status === "succeeded" && !objects.length ? (
        <Notice tone="warning" title={`No “${seg.prompt}” found`}>Try a different word, or draw a box around the subject.</Notice>
      ) : null}
      {seg?.status === "succeeded" && objects.length && view?.lowQuality ? (
        <Notice tone="warning" title="Tracking is unreliable in this clip">
          Videos using this selection will show the unmasked clip instead of a flickering cutout. Refine with a box or a few points on a frame where the subject is clear.
        </Notice>
      ) : null}

      {/* Objects */}
      {seg?.status === "succeeded" && objects.length > 1 ? (
        <section className="space-y-2">
          <p className="text-footnote font-medium text-ink-2">Include in cutout</p>
          <ChoiceChips
            label="Objects in the cutout"
            multiple
            value={chosen}
            onChange={(v) => setPicked(v.length ? v : chosen)}
            options={objects.map((o) => ({ value: o.objectId, label: `${o.label}${o.score !== undefined ? ` · ${Math.round(o.score * 100)}%` : ""}${isVideo && o.framesTracked ? ` · ${o.framesTracked} frames` : ""}` }))}
          />
          {selectionChanged ? (
            <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" aria-hidden />} loading={busy} disabled={!canWrite || running} onClick={() => void correct({ kind: "objects", objectIds: chosen })}>
              Update cutout · free
            </Button>
          ) : null}
        </section>
      ) : null}

      {/* Prompt / refine */}
      <section className="space-y-3 border-t border-line pt-4">
        {seg ? (
          <SegmentedControl<Mode>
            label="How to select"
            size="sm"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setBox(null);
              setPoints([]);
            }}
            items={[
              { value: "prompt", label: "Describe", icon: <Type className="size-3.5" aria-hidden /> },
              { value: "box", label: "Draw box", icon: <Box className="size-3.5" aria-hidden /> },
              { value: "point", label: "Click points", icon: <MousePointerClick className="size-3.5" aria-hidden /> },
            ]}
          />
        ) : null}

        {mode === "prompt" ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const text = prompt.trim();
              if (!text) return;
              // A selection already used in a composition is re-prompted in place (its id stays stable);
              // otherwise each prompt is its own cached selection for this file.
              if (initialSegmentationId && seg && seg.prompt !== text) void correct({ kind: "prompt", prompt: text });
              else void start(text);
            }}
          >
            <ChoiceChips label="Suggestions" value={SUGGESTIONS.includes(prompt as (typeof SUGGESTIONS)[number]) ? [prompt] : []} onChange={(v) => setPrompt(v[0] ?? "")} options={SUGGESTIONS.map((s) => ({ value: s, label: s }))} />
            <div className="flex gap-2">
              <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should be cut out? e.g. person, red mug" aria-label="Subject to select" maxLength={120} className="flex-1" />
              <Button type="submit" loading={busy} disabled={!canWrite || !ready || !prompt.trim() || running || (needsConsent && !consent)}>
                Select
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-footnote text-ink-2">
              {mode === "box" ? "Drag a box around the subject" : "Click on the subject to add points"}
              {isVideo ? " on any frame; SAM tracks it through the whole clip." : "."}
            </p>
            {mode === "point" ? (
              <ChoiceChips
                label="Point type"
                value={[polarity]}
                onChange={(v) => setPolarity((v[0] as "positive" | "negative") ?? "positive")}
                options={[
                  { value: "positive", label: "Include" },
                  { value: "negative", label: "Exclude" },
                ]}
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                loading={busy}
                disabled={!canWrite || running || (mode === "box" ? !box || box.w < 0.01 || box.h < 0.01 : !points.length)}
                onClick={() => void correct(mode === "box" ? { kind: "box", frame, box } : { kind: "point", frame, points })}
              >
                Refine selection
              </Button>
              <Button variant="ghost" onClick={() => (setBox(null), setPoints([]))} disabled={!box && !points.length}>
                Clear
              </Button>
            </div>
          </div>
        )}

        {needsConsent ? (
          <Checkbox
            checked={consent}
            onCheckedChange={setConsent}
            label="I have permission from the person shown to use their likeness"
            description="Required before selecting people in recordings. Stored with this file."
          />
        ) : null}
        {ready && canWrite ? <CostEstimate operation="media.segment" params={estimateParams} fetchEstimate={fetchEstimate(wid)} note={mode === "prompt" ? "Repeating the same prompt on the same file reuses the earlier result at no cost." : undefined} /> : null}
        {!canWrite ? <Notice>You have view access only. Ask an editor to make selections.</Notice> : null}
      </section>

      {seg?.status === "succeeded" && objects.length && onSegmentation ? (
        <div className="flex justify-end">
          <Button variant="ink" onClick={() => onSegmentation(seg.id)}>
            Use this cutout
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** Source video that can be scrubbed to an exact frame for annotation (controls hidden while editing). */
function FrameVideo({ url, fps, frame, controls }: { url: string; fps: number; frame: number; controls: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || controls) return;
    v.pause();
    v.currentTime = (frame + 0.5) / fps;
  }, [frame, fps, controls]);
  return <video ref={ref} src={url} className="block max-h-[60vh] max-w-full" controls={controls} muted playsInline preload="auto" aria-label="Source video" />;
}

/** Pointer layer for box/point prompts, in normalised 0..1 coordinates of the displayed media. */
function EditOverlay({ mode, box, points, polarity, onBox, onPoint }: { mode: Mode; box: Rect | null; points: Pt[]; polarity: Pt["label"]; onBox: (r: Rect | null) => void; onPoint: (p: Pt) => void }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const norm = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  return (
    <div
      className={cn("absolute inset-0 touch-none", mode === "box" ? "cursor-crosshair" : "cursor-copy")}
      role="application"
      aria-label={mode === "box" ? "Draw a box around the subject" : "Click to add points"}
      onPointerDown={(e) => {
        const p = norm(e);
        if (mode === "point") return onPoint({ ...p, label: e.altKey ? "negative" : polarity });
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = p;
        onBox({ x: p.x, y: p.y, w: 0, h: 0 });
      }}
      onPointerMove={(e) => {
        if (mode !== "box" || !start.current) return;
        const p = norm(e);
        const s = start.current;
        onBox({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
      }}
      onPointerUp={() => (start.current = null)}
    >
      {box ? (
        <div
          className="pointer-events-none absolute rounded-[4px] border-2 border-accent bg-accent/10 shadow-[0_0_0_9999px_rgb(0_0_0/0.25)]"
          style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
        />
      ) : null}
      {points.map((p, i) => (
        <span
          key={i}
          aria-hidden
          className={cn("pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow", p.label === "positive" ? "bg-success" : "bg-danger")}
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
        />
      ))}
    </div>
  );
}
