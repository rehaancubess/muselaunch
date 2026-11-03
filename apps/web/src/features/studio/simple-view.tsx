"use client";
/**
 * The simple Studio (default): the live preview, one "Tell Muse what to change" box (typed or spoken,
 * with one-tap suggestions), the scenes as a strip, the status that matters (Brand check, sound) and
 * Render / Download / Post. Every change goes through the same APIs as the full editor (scene-scoped
 * AI edits reviewed before they apply, validated Brand check fixes, versions with undo); everything
 * else stays one tap away behind "Edit in detail".
 *
 * Stills (posts, carousels, thumbnails, store sets; one scene = one slide): the preview parks on the
 * selected slide (no playback), the strip is a slide strip ("Change slide 3 only"), the suggestions
 * are about headlines, screens and backgrounds, there is no sound, hooks or length, and Finish renders
 * one image per slide (Download all, Schedule post).
 */
import type { CompositionDoc, Job, VideoReview, VideoReviewFinding } from "@muselaunch/contracts";
import { Button, IconButton, JobProgress, Notice, Spinner, Tooltip, cn, useToast } from "@muselaunch/ui";
import { CalendarClock, ChevronLeft, ChevronRight, Clapperboard, Download, Redo2, Send, SlidersHorizontal, Undo2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { SlideImage } from "@/components/creator/slide-gallery";
import { SchedulePostDialog } from "@/features/create/schedule";
import type { ApplyFindingResponse } from "@/features/guardian/use-guardian";
import { TellMuse } from "@/features/change/tell-muse";
import { NewPostDialog } from "@/features/publishing/new-post";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useAiEditCommand } from "@/lib/commands";
import { useTextEngine } from "@/lib/engines";
import { fetchEstimate } from "@/lib/estimate";
import { useJob } from "@/lib/jobs";
import type { AppDnaResponse } from "@/lib/api-types";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { downloadSlides } from "@/lib/slides";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { OBJECT_SUGGESTIONS, TurnView, useAiEdits } from "./ai-panel";
import type { SoundState } from "./audio-panel";
import type { ClipObject } from "./clips";
import { HooksDialog } from "./hooks-dialog";
import { isStillDoc, slideAssetIds, stillChips, stillNoun, wholeLabel } from "./stills";
import { sceneStarts, totalDuration } from "./ops";
import { PreviewPlayer, type PlayerHandle } from "./preview";
import { SceneStrip, settledAt } from "./scene-strip";
import { BrandLine, MadeWith, SoundLine } from "./simple-status";
import { downloadAsset, RenderDialog, VersionsPopover } from "./topbar";
import type { CommitResponse, CompositionResponse, MediaAsset, PreviewResponse } from "./types";
import type { VideoReviewsResponse } from "./video-review-panel";

type BrandProp = Parameters<typeof BrandLine>[0]["brand"];

export interface SimpleStudioProps {
  workspaceId: string;
  appId: string;
  compositionId: string;
  base: string;
  data: CompositionResponse;
  saving: boolean;
  preview: { data?: PreviewResponse; isLoading: boolean; error?: { userMessage?: string } | null; refetch: () => unknown };
  player: RefObject<PlayerHandle | null>;
  time: number;
  onTime: (t: number) => void;
  seek: (t: number) => void;
  sceneId: string | null;
  onSceneId: (id: string | null) => void;
  brand: BrandProp;
  videoReviews: { data?: VideoReviewsResponse; refetch: () => unknown };
  assets: MediaAsset[];
  objects: ClipObject[];
  trackedLabels: string[];
  clipAnalysisIds: string[];
  issueScenes: Set<string>;
  onApplied: (r: CommitResponse) => void;
  onUndo: () => void;
  onRedo: () => void;
  onRestore: (v: number) => void;
  onRefresh: () => void;
  /** Open the full editor, optionally on one of its tabs. */
  onDetail: (tab?: string) => void;
}

const RANK: Record<VideoReviewFinding["severity"], number> = { blocker: 2, warn: 1, info: 0 };
/** Plain words for a finding of Spark's video review (the chip runs its own fix instruction). */
const FINDING_CHIP: Record<VideoReviewFinding["check"], string> = {
  hook_readability: "Make the opening easier to read",
  legibility: "Make the text easier to read",
  safe_zone: "Move text away from the edges",
  device_frame: "Fix the phone frame",
  broken_frame: "Fix the blank moment",
  repetition: "Make it less repetitive",
  pacing: "Fix the pacing",
  cta: "Make the ending clearer",
  brand_fit: "Make it feel more on-brand",
  honesty: "Keep to the facts",
  other: "",
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

interface Chip {
  key: string;
  label: string;
  /** Longer explanation (tooltip). */
  hint?: string;
  fromSpark?: boolean;
  act: () => void;
}

export function SimpleStudio(props: SimpleStudioProps) {
  const { workspaceId, appId, compositionId, base, data, preview, player, time, onTime, seek, sceneId, onSceneId, onDetail } = props;
  const doc = data.version.doc;
  const c = data.composition;
  const review = props.videoReviews.data?.current ?? null;
  // Real frames of this exact version (Spark watched its render): per scene, the one closest to where
  // the scene has settled (its text and device are on screen).
  const frames = useMemo(() => {
    const out: Record<string, string> = {};
    const urls = props.videoReviews.data?.frameUrls ?? {};
    if (review?.status !== "succeeded" || review.version !== c.currentVersion) return out;
    const starts = sceneStarts(doc);
    const best = new Map<string, number>();
    for (const f of review.frames) {
      const i = doc.scenes.findIndex((s) => s.id === f.sceneId);
      if (i < 0 || !urls[f.ref]) continue;
      const d = Math.abs(f.atSec - ((starts[i] ?? 0) + settledAt(doc.scenes[i]!)));
      if (d < (best.get(f.sceneId!) ?? Infinity)) {
        best.set(f.sceneId!, d);
        out[f.sceneId!] = urls[f.ref]!;
      }
    }
    return out;
  }, [review, props.videoReviews.data?.frameUrls, c.currentVersion, doc]);
  const portrait = doc.height >= doc.width;
  const still = isStillDoc(doc);
  // Stills: real images of the last still render of this exact version, per slide (preview or final).
  const last = data.lastRender;
  const slideImages = useMemo(() => {
    const out: Record<string, string> = {};
    if (!still || !last?.assetId || last.version !== c.currentVersion) return out;
    const ids = slideAssetIds(last.assetId, doc.scenes.length);
    doc.scenes.forEach((sc, i) => (out[sc.id] = ids[i]!));
    return out;
  }, [still, last, c.currentVersion, doc.scenes]);
  const sceneIndex = sceneId ? doc.scenes.findIndex((x) => x.id === sceneId) : -1;
  const selectSlide = (i: number) => {
    const sc = doc.scenes[Math.max(0, Math.min(doc.scenes.length - 1, i))];
    if (!sc) return;
    onSceneId(sc.id);
    seek((sceneStarts(doc)[doc.scenes.indexOf(sc)] ?? 0) + settledAt(sc));
  };
  const brandReviewer = props.brand.latest && props.brand.latest.status !== "queued" && props.brand.latest.status !== "running" && props.brand.latest.status !== "failed" ? props.brand.latest.reviewer : null;

  return (
    <div className="flex min-h-[calc(100dvh-var(--ml-topbar-h))] flex-col bg-mist lg:h-[calc(100dvh-var(--ml-topbar-h))]">
      <SimpleHeader workspaceId={workspaceId} appId={appId} base={base} data={data} saving={props.saving} onUndo={props.onUndo} onRedo={props.onRedo} onRestore={props.onRestore} onDetail={() => onDetail()} />
      {doc.kind === "video" ? <HooksDialog workspaceId={workspaceId} appId={appId} base={base} composition={c} trigger={null} /> : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
        <main className="flex min-w-0 flex-col gap-4 px-4 pb-3 pt-4 lg:min-h-0 lg:px-8 lg:pt-6">
          {preview.data?.missingAssetIds.length ? (
            <Notice tone="warning">
              {preview.data.missingAssetIds.length} media file{preview.data.missingAssetIds.length === 1 ? " is" : "s are"} missing or still uploading; they appear blank in the preview.
            </Notice>
          ) : null}
          {/* Phones: short enough that the scene strip sits above the tab bar on the first screen. */}
          <div className={cn("min-h-0", portrait ? "h-[max(260px,min(calc(100dvh_-_var(--ml-topbar-h)_-_22.5rem_-_env(safe-area-inset-bottom)),560px))] md:h-[min(58dvh,560px)]" : "h-[min(40dvh,420px)] sm:h-[min(52dvh,520px)]", "lg:h-auto lg:flex-1")}>
            <PreviewPlayer
              ref={player}
              html={preview.data?.html}
              width={doc.width}
              height={doc.height}
              durationSec={data.durationSec}
              // Stills park on the first slide's settled frame until one is picked.
              posterSec={still ? settledAt(doc.scenes[0]!) : preview.data?.posterSec}
              loading={preview.isLoading}
              error={preview.error?.userMessage}
              onRetry={() => void preview.refetch()}
              onTime={onTime}
              still={still}
              stillControls={
                still && doc.scenes.length > 1 ? (
                  <>
                    <IconButton label="Previous slide" variant="secondary" disabled={sceneIndex <= 0} onClick={() => selectSlide(sceneIndex - 1)}>
                      <ChevronLeft className="size-4" aria-hidden />
                    </IconButton>
                    <span className="min-w-24 text-center text-footnote font-medium tabular text-ink-2" aria-live="polite">
                      {sceneIndex >= 0 ? `Slide ${sceneIndex + 1} of ${doc.scenes.length}` : `${doc.scenes.length} slides`}
                    </span>
                    <IconButton label="Next slide" variant="secondary" disabled={sceneIndex >= doc.scenes.length - 1} onClick={() => selectSlide(sceneIndex + 1)}>
                      <ChevronRight className="size-4" aria-hidden />
                    </IconButton>
                  </>
                ) : null
              }
            />
          </div>
          <SceneStrip
            doc={doc}
            time={time}
            selectedId={sceneId}
            issues={props.issueScenes}
            frames={still ? {} : frames}
            images={slideImages}
            onSelect={(id, at) => {
              onSceneId(id);
              if (id) seek(at);
              else if (still) seek(settledAt(doc.scenes[0]!));
            }}
          />
        </main>
        <aside className="flex min-w-0 flex-col border-t border-line bg-surface lg:min-h-0 lg:border-l lg:border-t-0" aria-label="Change and share">
          <div className="space-y-5 px-4 py-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-5">
            <ChangeBox {...props} review={review} />
            <div className="divide-y divide-line border-y border-line">
              <BrandLine
                workspaceId={workspaceId}
                compositionId={compositionId}
                version={c.currentVersion}
                brand={props.brand}
                onApplied={(r: ApplyFindingResponse) => props.onApplied({ composition: r.composition, version: r.version })}
                onDetails={() => onDetail("brand")}
                disabled={props.saving}
              />
              {still ? null : <SoundLine workspaceId={workspaceId} base={base} version={c.currentVersion} onCommitted={props.onApplied} onRefresh={props.onRefresh} onDetails={() => onDetail("sound")} disabled={props.saving} />}
            </div>
          </div>
          <div className="space-y-3 border-t border-line px-4 pb-5 pt-4 lg:px-5">
            <ShareActions workspaceId={workspaceId} appId={appId} base={base} data={data} 
              onRendered={props.onRefresh}
              onDetail={() => {
                // Open the full editor on the first scene that blocks the final render.
                const sid = data.lint.find((i) => i.level === "error" && i.sceneId)?.sceneId;
                if (sid) onSceneId(sid);
                onDetail("edit");
              }}
            />
            <MadeWith workspaceId={workspaceId} appId={appId} base={base} doc={doc} assets={props.assets} objects={props.objects} brandReviewer={brandReviewer} videoReview={review} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function SimpleHeader({ workspaceId, appId, base, data, saving, onUndo, onRedo, onRestore, onDetail }: { workspaceId: string; appId: string; base: string; data: CompositionResponse; saving: boolean; onUndo: () => void; onRedo: () => void; onRestore: (v: number) => void; onDetail: () => void }) {
  const c = data.composition;
  const back = c.campaignId ? routes.app(workspaceId, appId).campaign(c.campaignId) : routes.app(workspaceId, appId).create();
  return (
    <header className="flex items-center gap-1.5 border-b border-line bg-surface px-2 py-2 sm:gap-2 sm:px-3">
      <Link href={back} className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-footnote text-ink-2 hover:bg-mist hover:text-ink">
        <ChevronLeft className="size-4" aria-hidden />
        <span className="sr-only sm:not-sr-only">{c.campaignId ? "Campaign" : "Create"}</span>
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-body-sm font-semibold text-ink sm:text-headline">{c.title}</h1>
        <p className="flex items-center gap-1.5 text-caption tabular text-ink-3">
          v{c.currentVersion} · {data.version.doc.aspectRatio} ·{" "}
          {isStillDoc(data.version.doc) ? `${data.version.doc.scenes.length} ${data.version.doc.scenes.length === 1 ? "image" : "slides"}` : `${Math.round(data.durationSec * 10) / 10}s`}
          {saving ? <Spinner size={12} label="Saving" /> : null}
        </p>
      </div>
      <Tooltip content="Undo (⌘Z)">
        <IconButton label="Undo" onClick={onUndo} disabled={data.version.parentVersion === null || saving}>
          <Undo2 className="size-[18px]" aria-hidden />
        </IconButton>
      </Tooltip>
      <Tooltip content="Redo (⇧⌘Z)">
        <IconButton label="Redo" className="hidden sm:inline-flex" onClick={onRedo} disabled={!c.redoStack.length || saving}>
          <Redo2 className="size-[18px]" aria-hidden />
        </IconButton>
      </Tooltip>
      <VersionsPopover base={base} current={c.currentVersion} onRestore={onRestore} />
      <Button size="sm" variant="secondary" className="ml-1" icon={<SlidersHorizontal className="size-4" aria-hidden />} onClick={onDetail}>
        Edit in detail
      </Button>
    </header>
  );
}

function ChangeBox({
  workspaceId,
  appId,
  compositionId,
  base,
  data,
  saving,
  sceneId,
  onSceneId,
  review,
  videoReviews,
  trackedLabels,
  clipAnalysisIds,
  onApplied,
  onUndo,
  onRefresh,
}: SimpleStudioProps & { review: VideoReview | null }) {
  const doc = data.version.doc;
  const still = isStillDoc(doc);
  const { can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  // The app's features, for "Add a slide about …" (same query as Create and About your app).
  const dna = useApiQuery<AppDnaResponse>(still ? wsPath(workspaceId, `/apps/${appId}/dna`) : null, { retry: false, staleTime: 60_000 });
  const features = useMemo(() => (dna.data?.profile?.features ?? []).map((f) => f.name.trim()).filter(Boolean), [dna.data]);
  const scope = sceneId && doc.scenes.some((s) => s.id === sceneId) ? [sceneId] : [];
  const sceneIndex = doc.scenes.findIndex((s) => s.id === sceneId);
  const scene = doc.scenes[sceneIndex];
  const engine = useTextEngine(scope.length ? "composition.edit.scoped" : "composition.edit");
  const { turns, sending, send, run } = useAiEdits({ base, baseVersion: data.composition.currentVersion, clipAnalysisIds });
  const [credits, setCredits] = useState<number | null>(null);
  const [musicJob, setMusicJob] = useState<{ id: string; mood: string } | null>(null);
  const music = useJob(workspaceId, musicJob?.id ?? null, {
    onSettled: (j) => {
      onRefresh();
      void invalidate(`${base}/sound`);
      if (j.status === "succeeded") toast.success("New music", `${musicJob?.mood ?? "A new mood"}, composed for this video. Undo brings the old music back.`);
    },
  });
  const canWrite = can("content.write");
  const disabled = saving || !canWrite;

  useEffect(() => {
    let alive = true;
    fetchEstimate(workspaceId, { operation: "composition.edit", params: {} })
      .then((e) => alive && setCredits(e.credits))
      .catch(() => alive && setCredits(null));
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  // ⌘K "Edit video" from the command palette lands here in the simple view.
  useAiEditCommand(
    useCallback(
      (cmd) => {
        if (cmd.compositionId === compositionId && cmd.instruction.trim()) void send(cmd.instruction.trim(), []);
      },
      [compositionId, send],
    ),
  );


  /** Spark's "Fix these scenes": a scene-scoped edit proposed from the findings, reviewed like any edit. */
  const fixFindings = useCallback(
    (r: VideoReview, fs: VideoReviewFinding[], label: string) =>
      run(label, [...new Set(fs.map((f) => f.sceneId).filter((id): id is string => Boolean(id)))], async () => {
        const out = await api.post<{ job: Job; patch: { id: string } }>(wsPath(workspaceId, `/video-reviews/${r.id}/fix`), { findingIds: fs.map((f) => f.id) }, { idempotent: true });
        void videoReviews.refetch();
        return out;
      }),
    [run, workspaceId, videoReviews],
  );

  const changeMusic = useCallback(async () => {
    try {
      const s = await api.get<SoundState>(`${base}/sound`, { query: { v: data.composition.currentVersion } });
      const cur = s.tracks.find((t) => t.kind === "music");
      const moods = s.moods.filter((m) => m.id !== cur?.mood);
      const next = moods[Math.floor(Math.random() * moods.length)] ?? s.moods[0];
      if (!next) return;
      const r = await api.post<{ job: Job }>(`${base}/sound/music`, { baseVersion: data.composition.currentVersion, mood: next.id, ...(cur ? { volume: cur.volume } : {}) });
      setMusicJob({ id: r.job.id, mood: next.label });
    } catch (e) {
      toast.error("Couldn't change the music", errorMessage(e));
    }
  }, [base, data.composition.currentVersion, toast]);

  const chips = useMemo<Chip[]>(() => {
    if (still) return stillChips(doc, scene?.id ?? null, features).map((x) => ({ key: x.key, label: x.label, hint: x.hint, act: () => void send(x.instruction, x.sceneIds) }));
    const out: Chip[] = [];
    const first = doc.scenes[0];
    const sparkScenes = new Set<string>();
    // Spark watched the render of this exact version: its open findings become one-tap fixes.
    if (review?.status === "succeeded" && review.version === data.composition.currentVersion) {
      const open = review.findings.filter((f) => !f.resolution && f.sceneId && doc.scenes.some((s) => s.id === f.sceneId)).sort((a, b) => RANK[b.severity] - RANK[a.severity]);
      // One chip per kind of problem (e.g. the phone frame in 2 scenes), worst first.
      const groups = new Map<string, VideoReviewFinding[]>();
      for (const f of open) {
        const k = f.check === "other" ? `other:${f.id}` : f.check;
        groups.set(k, [...(groups.get(k) ?? []), f]);
      }
      for (const [k, fs] of [...groups].slice(0, 2)) {
        const base = FINDING_CHIP[fs[0]!.check] || clip(fs[0]!.fixInstruction, 40);
        const label = fs.length > 1 ? `${base} in ${fs.length} scenes` : base;
        for (const f of fs) sparkScenes.add(f.sceneId!);
        out.push({ key: `spark:${k}`, label, hint: `Muse Spark watched the render: ${fs.map((f) => f.issue).join(" · ")}`, fromSpark: true, act: () => void fixFindings(review, fs, label) });
      }
    }
    if (scene) out.push({ key: "punchier", label: "Make this scene punchier", act: () => void send(`Make the scene "${scene.name}" punchier`, [scene.id]) });
    if (trackedLabels.length) out.push({ key: "behind", label: OBJECT_SUGGESTIONS[0]!, act: () => void send(OBJECT_SUGGESTIONS[0]!, []) });
    if (first && !sparkScenes.has(first.id)) out.push({ key: "opening", label: "Make the opening more engaging", act: () => void send("Make the opening more engaging", [first.id]) });
    const total = totalDuration(doc);
    if (doc.kind === "video" && total >= 8) {
      const target = Math.max(6, Math.round(total * 0.75));
      out.push({ key: "shorter", label: "Make it shorter", hint: `About ${target} seconds, keeping the call to action`, act: () => void send(`Make the whole video shorter: about ${target} seconds, keeping the call to action`, []) });
    }
    if (doc.audio.some((a) => a.kind === "music" && a.sourceLabel === "original_music")) out.push({ key: "music", label: "Change the music", hint: "New original music in another mood (free)", act: () => void changeMusic() });
    return out.slice(0, 4);
  }, [doc, still, features, review, data.composition.currentVersion, scene, trackedLabels.length, fixFindings, send, changeMusic]);

  const musicRunning = music.job && (music.job.status === "queued" || music.job.status === "running");

  return (
    <TellMuse
      appId={appId}
      placeholder={still ? (scene ? "e.g. Make this headline shorter" : "e.g. Use calmer colours on every slide") : scene ? "e.g. Make this scene more exciting" : "e.g. Show my app on an animated iPhone"}
      busy={sending}
      disabled={disabled}
      onSubmit={(v, o) => {
        void send(v, scope, o.spoken);
      }}
      headerRight={
        scene ? (
          <button
            type="button"
            onClick={() => onSceneId(null)}
            className="inline-flex max-w-[55%] shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-caption font-medium text-accent-ink hover:bg-accent-soft/70 focus-visible:outline-none focus-visible:shadow-focus"
            aria-label={still ? `Change slide ${sceneIndex + 1} only. Change ${wholeLabel(doc).toLowerCase()} instead` : `Only scene ${sceneIndex + 1} (${scene.name}). Change the whole video instead`}
            title={still ? undefined : scene.name}
          >
            <span className="truncate">{still ? `Change slide ${sceneIndex + 1} only` : `Only scene ${sceneIndex + 1}`}</span>
            <X className="size-3.5 shrink-0" aria-hidden />
          </button>
        ) : (
          <span className="shrink-0 rounded-full bg-mist px-2.5 py-1 text-caption font-medium text-ink-2">{wholeLabel(doc)}</span>
        )
      }
      chips={canWrite ? chips.map((chip) => ({ key: chip.key, label: chip.label, hint: chip.hint, fromSpark: chip.fromSpark, act: chip.act, disabled: saving || (chip.key === "music" && !!musicRunning) })) : []}
      footnote={<span title={engine.label}>{engine.name === "The AI" ? "AI edit" : engine.name} · you approve each change{credits !== null ? ` · ${credits} credit${credits === 1 ? "" : "s"}` : ""}</span>}
    >
      {music.job && music.job.status !== "succeeded" ? <JobProgress job={music.job} variant="row" title={`Composing ${musicJob?.mood ?? "new"} music`} onRetry={() => void music.retry()} retrying={music.retrying} /> : null}

      {turns.length ? (
        <ul className="space-y-4" aria-live="polite" aria-label="Your changes">
          {turns.map((t) => (
            <TurnView
              key={t.id}
              turn={t}
              workspaceId={workspaceId}
              base={base}
              doc={doc as CompositionDoc}
              onApplied={(r) => {
                onApplied(r);
                void invalidate(`${base}/patches`);
              }}
              onUndo={onUndo}
              onPatchReady={() => void invalidate(`${base}/patches`)}
              disabled={saving}
            />
          ))}
        </ul>
      ) : null}
    </TellMuse>
  );
}

function ShareActions({ workspaceId, appId, base, data, onRendered, onDetail }: { workspaceId: string; appId: string; base: string; data: CompositionResponse; onRendered: () => void; onDetail: () => void }) {
  const { can } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const [posting, setPosting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const c = data.composition;
  const doc = data.version.doc;
  const last = data.lastRender;
  const errors = data.lint.filter((i) => i.level === "error");
  const ready = !!last && last.version === c.currentVersion && last.quality === "final" && !!last.assetId;
  const olderFinal = !!last && !ready && last.quality === "final" && !!last.assetId;
  const isVideo = doc.kind === "video";
  const noun = stillNoun(doc);
  const slides = isVideo ? [] : ready ? slideAssetIds(last!.assetId!, doc.scenes.length) : [];
  const download = (assetId: string) => downloadAsset(workspaceId, assetId).catch((e) => toast.error("Download failed", errorMessage(e)));
  const downloadAll = async () => {
    setDownloading(true);
    try {
      const how = await downloadSlides(workspaceId, { assetIds: slides, campaignId: c.campaignId, compositionId: c.id });
      if (how === "zip") toast.success("Downloaded", `All ${slides.length} slides in one ZIP, with the captions Muse wrote.`);
    } catch (e) {
      toast.error("Download failed", errorMessage(e));
    } finally {
      setDownloading(false);
    }
  };
  const status =
    c.status === "rendering"
      ? "Rendering…"
      : ready
        ? isVideo
          ? `Ready to post · ${last!.asset.width && last!.asset.height ? `${last!.asset.width}×${last!.asset.height}` : "final"}${last!.asset.durationSec ? ` · ${Math.round(last!.asset.durationSec * 10) / 10}s` : ""}`
          : `Ready · ${doc.scenes.length} ${doc.scenes.length === 1 ? "image" : "images"}${last!.asset.width && last!.asset.height ? ` at ${last!.asset.width}×${last!.asset.height}` : ""}`
        : last && last.version === c.currentVersion
          ? `Quick preview rendered. Render the final ${isVideo ? "video" : "images"} to download or post.`
          : last
            ? `Changed since the last render (v${last.version}). Render this version to download or post it.`
            : `Not rendered yet. Render the final ${isVideo ? "video" : "images"} to download or post.`;
  const storeSet = noun === "screenshots";
  return (
    <section aria-label="Render and share" className="space-y-2.5">
      <p className="text-footnote text-ink-2" aria-live="polite">
        {status}
        {olderFinal ? (
          <>
            {" "}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => void (isVideo ? download(last!.assetId!) : downloadEachSlideOf(workspaceId, last!.assetId!, doc.scenes.length, toast))}>
              Download v{last!.version}
            </button>
          </>
        ) : null}
      </p>
      {!isVideo && ready && slides.length > 1 ? (
        <ol aria-label={`The final ${noun}`} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          {slides.map((id, i) => (
            <li key={id} className="shrink-0">
              <button type="button" onClick={() => void download(id)} className="group relative block w-12 overflow-hidden rounded-md shadow-raised focus-visible:outline-none focus-visible:shadow-focus" style={{ aspectRatio: `${doc.width} / ${doc.height}` }} aria-label={`Download slide ${i + 1}`} title={`Download slide ${i + 1}`}>
                <SlideImage assetId={id} alt="" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition group-hover:bg-black/35 group-hover:opacity-100 group-focus-visible:bg-black/35 group-focus-visible:opacity-100">
                  <Download className="size-3.5" aria-hidden />
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {errors.length && !ready ? (
        <div className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-footnote font-medium text-ink">
              {errors.length === 1 ? "1 thing" : `${errors.length} things`} to fix before the final render
            </p>
            <p className="line-clamp-2 text-caption text-ink-2" title={errors[0]!.message}>
              {errors[0]!.message}
            </p>
          </div>
          <Button size="sm" variant="ghost" className="shrink-0" onClick={onDetail}>
            Show me
          </Button>
        </div>
      ) : null}
      <div className={cn("grid gap-2", storeSet ? "grid-cols-2" : "grid-cols-3")}>
        <RenderDialog
          workspaceId={workspaceId}
          base={base}
          data={data}
          onRendered={onRendered}
          trigger={
            <Button variant={ready ? "secondary" : "primary"} icon={<Clapperboard className="size-4" aria-hidden />} disabled={!can("content.write")}>
              {isVideo ? "Render" : "Finish"}
            </Button>
          }
        />
        <Button
          variant={ready ? "primary" : "secondary"}
          icon={<Download className="size-4" aria-hidden />}
          disabled={!ready}
          loading={downloading}
          onClick={() => ready && void (isVideo || slides.length < 2 ? download(last!.assetId!) : downloadAll())}
        >
          {isVideo || slides.length < 2 ? "Download" : "Download all"}
        </Button>
        {storeSet ? null : (
          <Button variant="secondary" icon={isVideo ? <Send className="size-4" aria-hidden /> : <CalendarClock className="size-4" aria-hidden />} disabled={!ready || !can("content.write")} onClick={() => setPosting(true)}>
            {isVideo ? "Post" : "Schedule"}
          </Button>
        )}
      </div>
      {isVideo ? (
        <NewPostDialog
          appId={appId}
          open={posting}
          onOpenChange={setPosting}
          initialCampaignId={c.campaignId}
          initialAssetId={ready ? last!.assetId : undefined}
          onCreated={() =>
            toast.toast({
              title: "Draft post created",
              description: "Nothing is posted yet: ask for approval in Scheduled, then MuseLaunch posts it or you post it yourself.",
              action: { label: "Open Scheduled", onClick: () => router.push(routes.app(workspaceId, appId).scheduled) },
            })
          }
        />
      ) : (
        <SchedulePostDialog
          appId={appId}
          target={posting && ready && c.campaignId ? { type: "stills", compositionId: c.id, assetIds: slides, campaignId: c.campaignId, title: c.title, width: last!.asset.width ?? doc.width, height: last!.asset.height ?? doc.height, version: last!.version, renderedAt: last!.at } : null}
          onClose={() => setPosting(false)}
        />
      )}
    </section>
  );
}

/** An older final render's slides, each on its own. */
async function downloadEachSlideOf(workspaceId: string, firstAssetId: string, n: number, toast: ReturnType<typeof useToast>) {
  try {
    await downloadSlides(workspaceId, { assetIds: slideAssetIds(firstAssetId, n) });
  } catch (e) {
    toast.error("Download failed", errorMessage(e));
  }
}
