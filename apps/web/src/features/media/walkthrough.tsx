"use client";
/**
 * Owner: module D (Multimodal media). The walkthrough: ONE long screen recording of the app, tapping
 * through every main feature, that MuseLaunch cuts into labelled clips (shot detection + Muse Spark
 * labels, narration via Muse Voice Transcribe) reused by every video. Personal information is flagged
 * per clip so it is blurred or left out.
 *
 * - <WalkthroughExplainer/>: what to record and why (static; onboarding before the app exists).
 * - <WalkthroughPrompt/>: the optional step with an uploader (App Home, Library, onboarding).
 * - <RecordingSegments/>: a recording's clips as a timeline + list with previews (Library).
 */
import type { AppDnaResponse, CompleteUploadResponse, Page, UploadResponse } from "@/lib/api-types";
import type { Job, MediaAsset, RecordingSegment } from "@muselaunch/contracts";
import { Badge, Button, Checkbox, ErrorState, IconButton, JobProgress, ProgressBar, Skeleton, cn } from "@muselaunch/ui";
import { CheckCircle2, EyeOff, Film, ListVideo, Play, RotateCcw, ShieldAlert, Smartphone, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { api, errorMessage, uploadToSignedUrl, wsPath } from "@/lib/api";
import { useJob } from "@/lib/jobs";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { baseMime, fmtClock } from "./lib";

export type RecordingSegmentsResponse = {
  items: RecordingSegment[];
  nextCursor: null;
  job?: Job | null;
  estimate?: { credits: number; minutes: number; perMinute: number };
  canAnalyze?: boolean;
  reason?: string | null;
};

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_WALKTHROUGH_SEC = 600;
const VOICE_CONSENT = "It's my voice in this recording (or I have permission): transcribe it for clip labels and captions";

const fmtRange = (s: Pick<RecordingSegment, "startSec" | "endSec">) => `${fmtClock(s.startSec)}–${fmtClock(Math.ceil(s.endSec))}`;

function qualityBadge(q: number): { tone: "success" | "warning" | "neutral"; label: string } {
  if (q >= 0.7) return { tone: "success", label: `Strong clip · ${Math.round(q * 100)}%` };
  if (q >= 0.3) return { tone: "neutral", label: `Usable · ${Math.round(q * 100)}%` };
  return { tone: "warning", label: `Not used in videos · ${Math.round(q * 100)}%` };
}

/** What a walkthrough is and why (no upload: also shown before the app exists). */
export function WalkthroughExplainer({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <div className={cn("space-y-3", className)}>
      <ul className="space-y-2.5 text-body-sm text-ink-2">
        <li className="flex gap-2.5">
          <Smartphone className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
          <span className="text-pretty">
            <span className="font-medium text-ink">One iPhone screen recording, 1–5 minutes.</span> Tap through every main feature at a calm pace. Talk while you record if you like.
          </span>
        </li>
        <li className="flex gap-2.5">
          <ListVideo className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
          <span className="text-pretty">
            <span className="font-medium text-ink">MuseLaunch cuts it into labelled clips</span> (Muse Spark names each one and the feature it shows), so every video uses real footage of your app instead of still screenshots.
          </span>
        </li>
        <li className="flex gap-2.5">
          <EyeOff className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
          <span className="text-pretty">
            <span className="font-medium text-ink">Personal info is flagged</span>: notifications, names, emails and numbers are marked so they're blurred or the clip is left out.
          </span>
        </li>
      </ul>
      {compact ? null : <p className="text-footnote text-ink-3 text-pretty">On iPhone: turn on Do Not Disturb, then Control Center → Screen Recording. Recordings up to 10 minutes are cut into clips.</p>}
    </div>
  );
}

/** Seconds of a local video file (null when the browser can't read it). */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    const done = (d: number | null) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    v.src = url;
  });
}

/** Pick → (consent for the voice) → direct upload as an App recording. Processing then cuts it into clips. */
export function WalkthroughUpload({ workspaceId, appId, onUploaded }: { workspaceId: string; appId: string; onUploaded?: (asset: MediaAsset) => void }) {
  const invalidate = useInvalidate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [voice, setVoice] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "uploading" | "finishing" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const pick = async (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!f.type.startsWith("video/")) return setError("Choose a video file (MP4 or MOV from your iPhone).");
    if (f.size > MAX_UPLOAD_BYTES) return setError("Recordings can be up to 1 GB.");
    setFile(f);
    const d = await readDuration(f);
    setDuration(d);
  };

  const upload = async () => {
    if (!file) return;
    const ac = new AbortController();
    abort.current = ac;
    setError(null);
    setState("uploading");
    setPct(0);
    try {
      const created = await api.post<UploadResponse>(wsPath(workspaceId, "/uploads"), {
        filename: file.name,
        mimeType: baseMime(file.type) || "video/mp4",
        bytes: file.size,
        role: "app_recording",
        appId,
        consent: voice ? { scope: VOICE_CONSENT } : undefined,
      });
      await uploadToSignedUrl(created.upload, file, setPct, ac.signal);
      setState("finishing");
      const done = await api.post<CompleteUploadResponse>(wsPath(workspaceId, `/assets/${created.asset.id}/complete`));
      setState("done");
      await invalidate(wsPath(workspaceId, "/assets"), wsPath(workspaceId, `/apps/${appId}/recording-segments`));
      onUploaded?.(done.asset);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        setState("idle");
        setPct(null);
        return;
      }
      setState("idle");
      setError(errorMessage(e));
    }
  };

  const tooLong = duration !== null && duration > MAX_WALKTHROUGH_SEC;
  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/x-m4v,video/webm"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {!file ? (
        <Button variant="secondary" icon={<Film className="size-4" aria-hidden />} onClick={() => inputRef.current?.click()}>
          Choose your walkthrough
        </Button>
      ) : (
        <div className="space-y-3 rounded-xl bg-surface p-3 shadow-raised">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-mist text-ink-2">
              <Film className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-sm font-medium">{file.name}</p>
              <p className="text-caption text-ink-2">
                {duration !== null ? fmtClock(duration) : "Length unknown"}
                {state === "uploading" && pct !== null ? ` · ${pct}% uploaded` : state === "finishing" ? " · processing" : state === "done" ? " · added, cutting into clips" : ""}
              </p>
            </div>
            {state === "done" ? <CheckCircle2 className="size-5 text-success" aria-label="Uploaded" /> : null}
            {state === "uploading" ? (
              <IconButton label="Cancel upload" size="sm" onClick={() => abort.current?.abort()}>
                <X className="size-3.5" aria-hidden />
              </IconButton>
            ) : state === "idle" ? (
              <IconButton label="Choose another file" size="sm" onClick={() => setFile(null)}>
                <X className="size-3.5" aria-hidden />
              </IconButton>
            ) : null}
          </div>
          {tooLong ? <p className="text-footnote text-warning">This recording is longer than 10 minutes. It uploads, but only walkthroughs up to 10 minutes are cut into clips: trim it first for the best result.</p> : null}
          {state === "idle" ? (
            <>
              <Checkbox checked={voice} onCheckedChange={setVoice} label="I talk in this recording" description="It's my voice, or I have permission. Muse Voice Transcribe adds what you say to each clip. Leave off for a silent recording." />
              <div className="flex justify-end">
                <Button size="sm" onClick={() => void upload()}>
                  Upload walkthrough
                </Button>
              </div>
            </>
          ) : null}
          {state === "uploading" || state === "finishing" ? <ProgressBar value={state === "finishing" ? null : pct} label={`Uploading ${file.name}`} /> : null}
        </div>
      )}
      {error ? <p className="text-footnote text-danger">{error}</p> : null}
    </div>
  );
}

/** App recordings of the app (newest first) and its clips. */
export function useWalkthroughs(workspaceId: string, appId: string) {
  const recordings = useApiQuery<Page<MediaAsset>>(appId ? wsPath(workspaceId, "/assets") : null, {
    query: { appId, role: "app_recording", limit: 20 },
    refetchInterval: (q) => (q.state.data?.items.some((a) => a.status === "uploaded" || a.status === "processing") ? 4000 : false),
  });
  const items = (recordings.data?.items ?? []).filter((a) => a.status !== "deleted" && a.status !== "pending_upload");
  // Poll for the first clips while a fresh recording is being cut (≤ 15 min after upload).
  const fresh = items.some((a) => Date.now() - Date.parse(a.createdAt) < 15 * 60_000);
  const segments = useApiQuery<RecordingSegmentsResponse>(appId && items.length ? wsPath(workspaceId, `/apps/${appId}/recording-segments`) : null, {
    refetchInterval: (q) => (fresh && !q.state.data?.items.length ? 6000 : false),
  });
  return { recordings: items, segments: segments.data?.items ?? [], loading: recordings.isLoading };
}

/**
 * The optional "Record one walkthrough of your app" step. `card` (App Home: dismissible, hidden once a
 * walkthrough exists unless it's still being cut), `inline` (Library, onboarding).
 */
export function WalkthroughPrompt({
  workspaceId,
  appId,
  variant = "card",
  canWrite = true,
  className,
}: {
  workspaceId: string;
  appId: string;
  variant?: "card" | "inline";
  /** Editors only (onboarding: the person who just created the workspace). */
  canWrite?: boolean;
  className?: string;
}) {
  const { recordings, segments, loading } = useWalkthroughs(workspaceId, appId);
  const dismissKey = `ml.walkthrough.dismissed.${appId}`;
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(variant === "card" && window.localStorage.getItem(dismissKey) === "1");
    } catch {
      setDismissed(false);
    }
  }, [dismissKey, variant]);
  if (loading || !canWrite) return null;
  const latest = recordings[0];
  const clips = latest ? segments.filter((s) => s.assetId === latest.id) : [];
  if (latest) {
    // Already recorded: a short status line (the clips themselves live in the Library). Home hides it once clips exist.
    if (variant === "card" && (dismissed || clips.length)) return null;
    return (
      <div className={cn("flex items-center gap-3 rounded-2xl bg-mist/70 px-4 py-3", className)}>
        <ListVideo className="size-5 shrink-0 text-ink-2" aria-hidden />
        <p className="min-w-0 flex-1 text-body-sm text-ink-2">
          {clips.length ? (
            <>
              <span className="font-medium text-ink">Walkthrough ready:</span> {clips.length} clip{clips.length === 1 ? "" : "s"} labelled for your videos.
            </>
          ) : latest.status === "failed" ? (
            "Your walkthrough couldn't be processed. Open it in the Library to see why."
          ) : (
            "Your walkthrough is uploaded and is being cut into clips. Open it to follow along."
          )}
        </p>
        <Button size="sm" variant="ghost" asChild>
          <Link href={`${routes.app(workspaceId, appId).library}?asset=${encodeURIComponent(latest.id)}`}>View</Link>
        </Button>
      </div>
    );
  }
  if (variant === "card" && dismissed) return null;
  return (
    <section aria-labelledby={`walkthrough-${appId}`} className={cn(variant === "card" ? "rounded-2xl bg-surface p-5 shadow-raised sm:p-6" : "rounded-2xl bg-mist/60 p-5", className)}>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          <Smartphone className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`walkthrough-${appId}`} className="text-headline font-semibold text-ink">
              Record one walkthrough of your app
            </h2>
            <Badge tone="outline">Optional</Badge>
          </div>
          <p className="text-body-sm text-ink-2 text-pretty">The best videos show your real app moving. One recording is enough for every video MuseLaunch makes.</p>
        </div>
        {variant === "card" ? (
          <IconButton
            label="Not now"
            size="sm"
            onClick={() => {
              try {
                window.localStorage.setItem(dismissKey, "1");
              } catch {
                /* per-viewer convenience only */
              }
              setDismissed(true);
            }}
          >
            <X className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
      </div>
      <WalkthroughExplainer className="mb-5" />
      <WalkthroughUpload workspaceId={workspaceId} appId={appId} />
    </section>
  );
}

function FeatureChips({ ids, names }: { ids: string[]; names: Map<string, string> }) {
  if (!ids.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Badge key={id} tone="accent" title={id}>
          {names.get(id) ?? "Feature"}
        </Badge>
      ))}
    </span>
  );
}

function Keyframe({ workspaceId, assetId, className }: { workspaceId: string; assetId?: string; className?: string }) {
  const url = useAssetUrl(workspaceId, assetId);
  return (
    <span className={cn("block shrink-0 overflow-hidden rounded-md bg-mist", className)}>
      {url.data?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url.data.url} alt="" loading="lazy" className="size-full object-cover" />
      ) : null}
    </span>
  );
}

/**
 * A recording's clips: timeline (width = duration, colour = quality, outline = personal info) and a list
 * with stills, labels, feature chips, quality and privacy warnings. Selecting a clip plays just that
 * range (`#t=start,end`). Runs or re-runs the breakdown, with its credit cost.
 */
export function RecordingSegments({ workspaceId, appId, asset }: { workspaceId: string; appId: string; asset: MediaAsset }) {
  const { can } = useWorkspace();
  const invalidate = useInvalidate();
  const path = wsPath(workspaceId, `/apps/${appId}/recording-segments`);
  const q = useApiQuery<RecordingSegmentsResponse>(path, { query: { assetId: asset.id } });
  const dna = useApiQuery<AppDnaResponse>(wsPath(workspaceId, `/apps/${appId}/dna`));
  const names = useMemo(() => new Map((dna.data?.profile?.features ?? []).map((f) => [f.id, f.name])), [dna.data]);
  const running = q.data?.job && (q.data.job.status === "queued" || q.data.job.status === "running") ? q.data.job : null;
  const job = useJob(workspaceId, running?.id, { initial: running, onSettled: () => void invalidate(path, wsPath(workspaceId, "/assets"), wsPath(workspaceId, `/apps/${appId}/dna`)) });
  const video = useAssetUrl(workspaceId, asset.status === "ready" ? asset.id : null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const sel = items.find((s) => s.id === selected) ?? null;
  const total = asset.durationSec ?? items[items.length - 1]?.endSec ?? 1;
  const canWrite = can("content.write");

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(wsPath(workspaceId, `/apps/${appId}/media/${asset.id}/analyze-recording`), {}, { idempotent: true });
      await invalidate(path);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (q.isLoading) return <Skeleton className="h-28 w-full" rounded="lg" />;
  if (q.error) return <ErrorState compact message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const flagged = items.filter((s) => s.privacy.flagged).length;
  const lastJob = job.job ?? q.data?.job ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-body-sm font-semibold">Clips from this walkthrough</p>
          <p className="text-footnote text-ink-2 text-pretty">
            {items.length
              ? `${items.length} clip${items.length === 1 ? "" : "s"}, labelled by Muse Spark from the recording${items.some((s) => s.narration) ? " and what you said (Muse Voice Transcribe)" : ""}. Videos pick clips by feature.`
              : "MuseLaunch finds each shot, labels it with Muse Spark and links it to your App DNA features."}
          </p>
        </div>
        {canWrite && q.data?.canAnalyze && !running ? (
          <Button size="sm" variant={items.length ? "ghost" : "primary"} loading={busy} icon={items.length ? <RotateCcw className="size-3.5" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />} onClick={() => void run()}>
            {items.length ? "Re-run" : "Cut into clips"}
            {q.data?.estimate ? ` · ${q.data.estimate.credits} credits` : ""}
          </Button>
        ) : null}
      </div>
      {q.data?.reason && !items.length ? <p className="text-footnote text-ink-2">{q.data.reason}</p> : null}
      {error ? <p className="text-footnote text-danger">{error}</p> : null}
      {running ? <JobProgress job={job.job ?? running} title="Cutting the walkthrough into clips" onCancel={() => void job.cancel()} cancelling={job.cancelling} /> : null}
      {!running && lastJob?.status === "failed" ? <ErrorState compact message={lastJob.error?.userMessage ?? lastJob.error?.message ?? "The breakdown didn't finish."} /> : null}

      {items.length ? (
        <>
          {sel && video.data?.url ? (
            <figure className="space-y-2">
              <video key={sel.id} src={`${video.data.url}#t=${sel.startSec},${sel.endSec}`} controls autoPlay muted playsInline className="max-h-[44vh] w-full rounded-lg bg-black object-contain" />
              <figcaption className="text-caption text-ink-2">
                {fmtRange(sel)} · {sel.label}
                {sel.privacy.flagged ? " · personal info: blurred in videos" : ""}
              </figcaption>
            </figure>
          ) : null}
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-mist" role="list" aria-label="Clips on the recording's timeline">
            {items.map((s, i) => {
              const gap = i === 0 ? s.startSec : s.startSec - items[i - 1]!.endSec;
              return (
                <span key={s.id} role="listitem" className="flex h-full" style={{ width: `${((s.endSec - s.startSec + Math.max(0, gap)) / total) * 100}%` }}>
                  <span className="h-full" style={{ width: `${(Math.max(0, gap) / (s.endSec - s.startSec + Math.max(0, gap))) * 100}%` }} />
                  <button
                    type="button"
                    title={`${fmtRange(s)} ${s.label}`}
                    aria-label={`Play ${s.label}`}
                    onClick={() => setSelected(s.id)}
                    className={cn(
                      "h-full flex-1 border-r border-surface transition-opacity hover:opacity-80",
                      s.quality >= 0.7 ? "bg-accent" : s.quality >= 0.3 ? "bg-accent/45" : "bg-ink-3/40",
                      s.privacy.flagged && "bg-warning",
                      s.id === selected && "ring-2 ring-inset ring-ink",
                    )}
                  />
                </span>
              );
            })}
          </div>
          {flagged ? (
            <p className="flex items-start gap-2 text-footnote text-warning">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {flagged} clip{flagged === 1 ? " shows" : "s show"} personal information. Flagged areas are blurred when a clip is used; clips without marked areas are left out.
            </p>
          ) : null}
          <ol className="divide-y divide-line overflow-hidden rounded-xl bg-surface shadow-raised">
            {items.map((s) => {
              const qb = qualityBadge(s.quality);
              return (
                <li key={s.id}>
                  <button type="button" onClick={() => setSelected(s.id)} className={cn("flex w-full gap-3 px-3 py-3 text-left transition-colors hover:bg-mist/60", s.id === selected && "bg-mist/70")}>
                    <span className="relative">
                      <Keyframe workspaceId={workspaceId} assetId={s.keyframeAssetId} className="h-[72px] w-[40px]" />
                      <Play className="absolute inset-0 m-auto size-4 text-white drop-shadow" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 space-y-1.5">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-body-sm font-medium text-ink">{s.label}</span>
                        <span className="text-caption tabular text-ink-3">{fmtRange(s)}</span>
                      </span>
                      {s.screen ? <span className="block text-caption text-ink-2">{s.screen}</span> : null}
                      <span className="flex flex-wrap items-center gap-1">
                        <FeatureChips ids={s.featureIds} names={names} />
                        <Badge tone={qb.tone}>{qb.label}</Badge>
                        {s.privacy.flagged ? (
                          <Badge tone="warning" icon={<ShieldAlert aria-hidden />} title={s.privacy.notes}>
                            {s.privacy.regions.length ? "Personal info: blurred" : "Personal info: left out"}
                          </Badge>
                        ) : null}
                      </span>
                      {s.narration ? <span className="block text-caption italic text-ink-2 line-clamp-2">“{s.narration}”</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </div>
  );
}
