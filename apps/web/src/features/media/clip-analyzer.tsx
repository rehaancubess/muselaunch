"use client";
/**
 * Owner: module D (Multimodal media). Object-aware clip analysis: SAM 3.1 tracks the objects you
 * name (person, phone…) through a real clip, cuts each one out, and Muse Voice Transcribe adds the
 * transcript. Shows every track on a frame scrubber, per-object cutouts and tracking quality, then
 * hands the analysis to the Studio ("Use in Studio") for object-aware effects.
 */
import type { ClipAnalysis, ObjectTrack, TracksFile } from "@muselaunch/contracts";
import { Badge, Button, Card, Checkbox, ChoiceChips, CostEstimateView, ErrorState, Input, JobProgress, Notice, Skeleton, Switch, cn } from "@muselaunch/ui";
import { Pause, Play, Plus, ScanSearch, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { AssetResponse } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { OBJECT_COLORS, PERSON_PROMPT, fetchTracks, fmtClock, qualityOf, type AnalyzeClipResponse, type ClipAnalysisView, type ClipEstimate } from "./lib";

export interface ClipAnalyzerProps {
  assetId: string;
  /** "Use in Studio": hands the finished analysis to the caller (e.g. composition.edit clipAnalysisIds). */
  onAnalysis?: (analysis: ClipAnalysis) => void;
  className?: string;
}

const SUGGESTED = ["person", "phone", "hand", "laptop", "mug"] as const;
type Obj = ClipAnalysis["objects"][number] & { color: string; track?: ObjectTrack };

export default function ClipAnalyzer({ assetId, onAnalysis, className }: ClipAnalyzerProps) {
  const { workspaceId: wid, can } = useWorkspace();
  const invalidate = useInvalidate();
  const canWrite = can("content.write");
  const assetQ = useApiQuery<AssetResponse>(wsPath(wid, `/assets/${assetId}`), {
    refetchInterval: (q) => (q.state.data && ["uploaded", "processing", "pending_upload"].includes(q.state.data.asset.status) ? 3000 : false),
  });
  const asset = assetQ.data?.asset;
  const listPath = wsPath(wid, `/assets/${assetId}/clip-analyses`);
  const listQ = useApiQuery<{ items: ClipAnalysis[] }>(asset?.status === "ready" ? listPath : null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  useEffect(() => {
    if (!analysisId && listQ.data?.items[0]) setAnalysisId(listQ.data.items[0].id);
  }, [analysisId, listQ.data]);
  const detailPath = analysisId ? wsPath(wid, `/clip-analyses/${analysisId}`) : null;
  const detailQ = useApiQuery<ClipAnalysisView>(detailPath, {
    refetchInterval: (q) => (["queued", "running"].includes(q.state.data?.analysis.status ?? "") ? 3000 : false),
  });
  const view = detailQ.data;
  const analysis = view?.analysis;
  const running = analysis?.status === "queued" || analysis?.status === "running";
  const job = useJob(wid, running ? analysis?.jobId : null, {
    onSettled: () => void invalidate(...[detailPath, listPath].filter((x): x is string => Boolean(x))),
  });

  // --- New analysis form
  const [editing, setEditing] = useState(false);
  const [prompts, setPrompts] = useState<string[]>(["person", "phone"]);
  const [custom, setCustom] = useState("");
  const [transcribe, setTranscribe] = useState(true);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<ClipEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const showForm = !analysis || editing;
  const needsConsent = Boolean(asset && !asset.license?.consent && (asset.role === "founder_clip" || PERSON_PROMPT.test(prompts.join(" ")) || (transcribe && asset.hasAudio !== false)));
  const estimateKey = JSON.stringify([prompts, transcribe]);
  useEffect(() => {
    if (!showForm || !canWrite || asset?.status !== "ready" || !prompts.length) return;
    let alive = true;
    setEstimateError(null);
    const t = setTimeout(() => {
      api
        .post<ClipEstimate>(wsPath(wid, `/assets/${assetId}/analyze-clip/estimate`), { prompts, transcribe })
        .then((e) => alive && setEstimate(e))
        .catch((e) => alive && setEstimateError(errorMessage(e)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey, showForm, canWrite, asset?.status, wid, assetId]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<AnalyzeClipResponse>(
        wsPath(wid, `/assets/${assetId}/analyze-clip`),
        { prompts, transcribe, consent: needsConsent && consent ? { scope: "Permission from the person in this clip to analyse and use their likeness and voice" } : undefined },
        { idempotent: true },
      );
      setAnalysisId(r.analysis.id);
      setEditing(false);
      await invalidate(listPath, wsPath(wid, `/clip-analyses/${r.analysis.id}`), wsPath(wid, `/assets/${assetId}`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const addCustom = () => {
    const t = custom.trim().toLowerCase().slice(0, 60);
    if (t && !prompts.includes(t) && prompts.length < 6) setPrompts([...prompts, t]);
    setCustom("");
  };

  // --- Tracks (fetched via signed URLs once the analysis is done)
  const [tracks, setTracks] = useState<Record<string, TracksFile>>({});
  const tracksKey = view ? JSON.stringify(Object.keys(view.tracksUrls).sort()) + (analysis?.updatedAt ?? "") : "";
  useEffect(() => {
    if (!view || running) return;
    const ac = new AbortController();
    void Promise.all(Object.entries(view.tracksUrls).map(async ([segId, url]) => [segId, await fetchTracks(url, ac.signal)] as const))
      .then((entries) => setTracks(Object.fromEntries(entries)))
      .catch(() => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracksKey, running]);

  const objects: Obj[] = useMemo(
    () =>
      (analysis?.objects ?? []).map((o, i) => ({
        ...o,
        color: OBJECT_COLORS[i % OBJECT_COLORS.length]!,
        track: tracks[o.segmentationId]?.tracks.find((t) => t.objectId === o.objectId),
      })),
    [analysis?.objects, tracks],
  );
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const firstTracks = Object.values(tracks)[0];
  const fps = firstTracks?.fps ?? asset?.fps ?? 30;
  const frameCount = firstTracks?.frameCount ?? Math.max(1, Math.round((asset?.durationSec ?? 0) * fps));

  // --- Player with frame-accurate overlay
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setFrame(Math.min(frameCount - 1, Math.max(0, Math.floor(v.currentTime * fps))));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps, frameCount]);
  const seek = (f: number) => {
    const v = videoRef.current;
    setFrame(f);
    if (v) {
      v.pause();
      v.currentTime = (f + 0.5) / fps;
    }
  };

  const sourceUrl = view?.assets[assetId]?.url;
  const segById = useMemo(() => Object.fromEntries((view?.segmentations ?? []).map((s) => [s.id, s])), [view?.segmentations]);

  if (assetQ.isLoading) return <Skeleton className={cn("h-96 w-full", className)} rounded="xl" />;
  if (assetQ.error || !asset) return <ErrorState message={errorMessage(assetQ.error)} onRetry={() => void assetQ.refetch()} className={className} />;
  if (asset.kind !== "video") return <Notice className={className}>Clip analysis works on video clips.</Notice>;

  return (
    <Card padding="lg" className={cn("space-y-5", className)}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
            <ScanSearch className="size-4" aria-hidden />
          </span>
          <div>
            <h3 className="text-headline font-semibold text-ink">Analyse clip</h3>
            <p className="text-footnote text-ink-2">Track people and objects through your real footage so effects, labels and app inserts can follow them.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="outline" icon={<Sparkles aria-hidden />}>SAM 3.1</Badge>
          <Badge tone="outline">Muse Voice Transcribe</Badge>
          {analysis?.status === "succeeded" ? <Badge tone="success">Ready</Badge> : null}
          {analysis?.status === "partial" ? <Badge tone="warning">Partly analysed</Badge> : null}
        </div>
      </header>

      {asset.status !== "ready" ? (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-mist py-16 text-footnote text-ink-2">
          <Skeleton className="h-40 w-64" rounded="lg" />
          Processing upload…
        </div>
      ) : null}

      {/* Player + tracks overlay */}
      {analysis && sourceUrl ? (
        <div className="space-y-3">
          <div className="flex justify-center overflow-hidden rounded-xl bg-ink">
            <div className="relative inline-block max-w-full">
              <video
                ref={videoRef}
                src={sourceUrl}
                className="block max-h-[56vh] max-w-full"
                playsInline
                preload="auto"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onSeeked={(e) => setFrame(Math.min(frameCount - 1, Math.floor(e.currentTarget.currentTime * fps)))}
                aria-label="Source clip"
              />
              <TrackOverlay objects={objects} frame={frame} hidden={hidden} focus={focus} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="secondary"
              icon={playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
              onClick={() => (playing ? videoRef.current?.pause() : void videoRef.current?.play())}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? "Pause" : "Play"}
            </Button>
            <input type="range" min={0} max={Math.max(0, frameCount - 1)} value={frame} onChange={(e) => seek(Number(e.target.value))} className="w-full accent-[var(--ml-accent)]" aria-label="Frame" />
            <span className="w-24 shrink-0 text-right tabular text-footnote text-ink-2">
              {fmtClock(frame / fps)} · f{frame + 1}
            </span>
          </div>
          <PresenceBars objects={objects} hidden={hidden} duration={analysis.durationSec ?? frameCount / fps} position={frame / fps} onSeek={(sec) => seek(Math.min(frameCount - 1, Math.round(sec * fps)))} />
        </div>
      ) : null}

      {running ? <JobProgress job={job.job} title="Analysing clip" onCancel={() => void job.cancel()} cancelling={job.cancelling} placeholder="Queued…" /> : null}
      {analysis?.status === "failed" ? (
        <Notice tone="danger" title="Analysis failed">
          {analysis.error ?? "Nothing could be tracked."} No tracks were created.
        </Notice>
      ) : null}
      {analysis?.status === "partial" ? <Notice tone="warning" title="Some items couldn't be analysed">{analysis.error}</Notice> : null}
      {analysis && !running && analysis.status !== "failed" && !objects.length ? (
        <Notice tone="warning" title="Nothing found">SAM didn't find {analysis.prompts.map((p) => `“${p}”`).join(" or ")} in this clip. Try other words.</Notice>
      ) : null}

      {/* Objects */}
      {objects.length ? (
        <section className="space-y-2">
          <p className="text-footnote font-medium text-ink-2">Tracked objects</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {objects.map((o) => {
              const q = qualityOf(o.trackingQuality);
              const seg = segById[o.segmentationId];
              const cutoutId = seg?.objectOutputs?.[o.objectId]?.cutoutAssetId;
              const cutout = cutoutId ? view?.assets[cutoutId] : undefined;
              const off = hidden.has(o.key);
              return (
                <li
                  key={o.key}
                  className={cn("flex gap-3 rounded-lg border p-2.5 transition-colors", focus === o.key ? "border-accent bg-accent-soft/40" : "border-line", off && "opacity-55")}
                  onMouseEnter={() => setFocus(o.key)}
                  onMouseLeave={() => setFocus(null)}
                >
                  <div className="relative size-16 shrink-0 overflow-hidden rounded-md bg-[conic-gradient(#e8e8ed_25%,#fff_0_50%,#e8e8ed_0_75%,#fff_0)] bg-[length:12px_12px]">
                    {cutout ? (
                      cutout.kind === "video" ? (
                        <video src={cutout.url} className="size-full object-contain" autoPlay loop muted playsInline aria-label={`Cutout of ${o.label}`} />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={cutout.url} alt={`Cutout of ${o.label}`} className="size-full object-contain" />
                      )
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: o.color }} aria-hidden />
                      <span className="truncate text-body-sm font-medium text-ink">{o.label}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={q.tone}>{q.label}</Badge>
                    </div>
                    <p className="truncate text-caption text-ink-3">{o.presence.length ? o.presence.map((r) => `${r.startSec.toFixed(1)}–${r.endSec.toFixed(1)}s`).join(", ") : "Not visible"}</p>
                  </div>
                  <Switch
                    checked={!off}
                    onCheckedChange={(v) => setHidden((h) => {
                      const n = new Set(h);
                      if (v) n.delete(o.key);
                      else n.add(o.key);
                      return n;
                    })}
                    label={`Show ${o.label}`}
                  />
                </li>
              );
            })}
          </ul>
          {objects.some((o) => (o.trackingQuality ?? 1) < 0.5) ? (
            <p className="text-caption text-ink-3">Objects with low tracking quality fall back to unmasked footage in renders.</p>
          ) : null}
        </section>
      ) : null}

      {view?.transcript?.text ? (
        <section className="space-y-1">
          <p className="text-footnote font-medium text-ink-2">Transcript</p>
          <p className="line-clamp-3 text-body-sm text-ink">{view.transcript.text}</p>
          <p className="text-caption text-ink-3">Turn-level timing from Muse Voice Transcribe.</p>
        </section>
      ) : null}

      {/* Start / re-run */}
      {showForm && asset.status === "ready" ? (
        <section className={cn("space-y-3", analysis && "border-t border-line pt-4")}>
          <p className="text-footnote font-medium text-ink-2">What should we track?</p>
          <ChoiceChips label="Objects to track" multiple value={prompts} onChange={(v) => setPrompts(v.slice(0, 6))} options={[...new Set([...SUGGESTED, ...prompts])].map((s) => ({ value: s, label: s }))} />
          <div className="flex gap-2">
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustom())} placeholder="Add something else, e.g. coffee cup" aria-label="Add an object to track" maxLength={60} className="flex-1" />
            <Button variant="secondary" icon={<Plus className="size-3.5" aria-hidden />} onClick={addCustom} disabled={!custom.trim() || prompts.length >= 6}>
              Add
            </Button>
          </div>
          <Switch checked={transcribe} onCheckedChange={setTranscribe} label="Transcribe speech" />
          {needsConsent ? (
            <Checkbox checked={consent} onCheckedChange={setConsent} label="I have permission from the person in this clip" description="Required to track people and transcribe voices. Stored with the clip." />
          ) : null}
          {canWrite ? <CostEstimateView estimate={estimate} loading={!estimate && !estimateError} error={estimateError} note="Objects and transcripts analysed before for this clip are reused at no cost." /> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button icon={<ScanSearch className="size-4" aria-hidden />} loading={busy} disabled={!canWrite || !prompts.length || (needsConsent && !consent) || Boolean(estimate && estimate.credits > estimate.available)} onClick={() => void start()}>
              Analyse clip
            </Button>
            {analysis ? (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
          {!canWrite ? <Notice>You have view access only. Ask an editor to analyse clips.</Notice> : null}
        </section>
      ) : null}

      {analysis && !running && !showForm ? (
        <div className="flex flex-wrap justify-end gap-2">
          {canWrite ? (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              Track other objects
            </Button>
          ) : null}
          {onAnalysis && (analysis.status === "succeeded" || analysis.status === "partial") && objects.length ? (
            <Button variant="ink" icon={<Wand2 className="size-4" aria-hidden />} onClick={() => onAnalysis(analysis)}>
              Use in Studio
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/** Boxes (current frame) + centroid trail (focused object) in normalised coordinates over the video. */
function TrackOverlay({ objects, frame, hidden, focus }: { objects: Obj[]; frame: number; hidden: Set<string>; focus: string | null }) {
  return (
    <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
      {objects.map((o) => {
        if (hidden.has(o.key) || !o.track) return null;
        const f = o.track.frames[frame];
        const trail =
          focus === o.key
            ? o.track.frames
                .slice(Math.max(0, frame - 60), frame + 1)
                .filter((x) => x.visible && x.centroid)
                .map((x) => `${x.centroid!.x},${x.centroid!.y}`)
                .join(" ")
            : "";
        return (
          <g key={o.key}>
            {trail ? <polyline points={trail} fill="none" stroke={o.color} strokeWidth={2} strokeOpacity={0.7} vectorEffect="non-scaling-stroke" /> : null}
            {f?.visible && f.bbox ? (
              <>
                <rect x={f.bbox.x} y={f.bbox.y} width={f.bbox.w} height={f.bbox.h} fill={o.color} fillOpacity={focus === o.key ? 0.18 : 0.06} stroke={o.color} strokeWidth={focus === o.key ? 3 : 2} vectorEffect="non-scaling-stroke" rx={0.006} />
                {f.centroid ? <circle cx={f.centroid.x} cy={f.centroid.y} r={0.006} fill={o.color} /> : null}
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Presence timeline: one row per object, click to seek. */
function PresenceBars({ objects, hidden, duration, position, onSeek }: { objects: Obj[]; hidden: Set<string>; duration: number; position: number; onSeek: (sec: number) => void }) {
  if (!objects.length || !duration) return null;
  return (
    <div className="space-y-1" aria-label="When each object is visible">
      {objects.map((o) => (
        <div key={o.key} className={cn("flex items-center gap-2", hidden.has(o.key) && "opacity-40")}>
          <span className="w-24 shrink-0 truncate text-caption text-ink-2">{o.label}</span>
          <div
            className="relative h-2.5 flex-1 cursor-pointer rounded-full bg-mist-2"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onSeek(((e.clientX - r.left) / r.width) * duration);
            }}
          >
            {o.presence.map((r, i) => (
              <span key={i} className="absolute inset-y-0 rounded-full" style={{ left: `${(r.startSec / duration) * 100}%`, width: `${Math.max(0.5, ((r.endSec - r.startSec) / duration) * 100)}%`, background: o.color }} />
            ))}
            <span className="absolute -inset-y-0.5 w-0.5 rounded bg-ink" style={{ left: `${Math.min(100, (position / duration) * 100)}%` }} aria-hidden />
          </div>
        </div>
      ))}
    </div>
  );
}
