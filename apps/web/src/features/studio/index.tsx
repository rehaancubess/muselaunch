"use client";
/**
 * Owner: module C (Video Studio). Rendered by
 * apps/web/src/app/w/[workspaceId]/a/[appId]/creator/studio/[compositionId]/page.tsx (full-bleed).
 *
 * Live HyperFrames preview of the compiled composition, multi-track timeline, inspector, media drawer
 * and the conversational AI editor. Every edit is a validated PatchOp committed as a new version
 * (undo/redo/restore); renders and exports run as background jobs with live progress.
 */
import { Button, ErrorState, Notice, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@muselaunch/ui";
import { ScanEye, ScanSearch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandGuardianPanel, useBrandReviews } from "@/features/guardian";
import { wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { useApiQuery } from "@/lib/query";
import { emitAiEdit, useAiEditCommand } from "@/lib/commands";
import { useCurrentApp } from "@/lib/workspace";
import { AiPanel } from "./ai-panel";
import { AssetsDrawer } from "./assets-drawer";
import { ClipPanel } from "./clip-panel";
import { clipObjects, docAnalysisIds, pickDemo, useClips } from "./clips";
import { Inspector } from "./inspector";
import { sceneAt, sceneStarts, splitSceneOps } from "./ops";
import { PreviewPlayer, type PlayerHandle } from "./preview";
import { Timeline } from "./timeline";
import { StudioTopbar } from "./topbar";
import { TrackOverlay } from "./track-overlay";
import type { LintIssue, MediaAsset, PatchOp } from "./types";
import { usePreview, useStudio } from "./use-studio";
import { openVideoBlockers, useVideoReviews, VideoReviewPanel } from "./video-review-panel";

export interface StudioRootProps {
  compositionId: string;
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export default function StudioRoot({ compositionId }: StudioRootProps) {
  const { workspaceId, appId } = useCurrentApp();
  const studio = useStudio(workspaceId, compositionId);
  const data = studio.data;
  const doc = data?.version.doc;
  const preview = usePreview(studio.base, data?.composition.currentVersion);
  const player = useRef<PlayerHandle>(null);
  const [time, setTime] = useState(0);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [layerId, setLayerId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState("edit");
  const [showTracks, setShowTracks] = useState(false);
  // Clip intelligence: SAM-tracked objects of founder clips (anchors, effects, Spark context).
  const clips = useClips(studio.base);
  const objects = useMemo(() => clipObjects(clips.data?.items), [clips.data]);
  const clipAnalysisIds = useMemo(() => (doc ? docAnalysisIds(doc, clips.data?.items) : []), [doc, clips.data]);
  const trackedLabels = useMemo(() => [...new Set(objects.filter((o) => clipAnalysisIds.includes(o.analysisId)).map((o) => o.label))], [objects, clipAnalysisIds]);
  // Same query (and cache entry) as the media drawer.
  const assets = useApiQuery<Page<MediaAsset>>(appId ? wsPath(workspaceId, "/assets") : null, { query: { appId, limit: 120 } });
  const demo = useMemo(() => pickDemo(assets.data?.items ?? []), [assets.data]);
  // ⌘K "Edit video" while another tab is open: switch to Ask Muse, then re-deliver once it's mounted.
  useAiEditCommand(
    useCallback(
      (cmd) => {
        if (cmd.compositionId !== compositionId || rightTab === "ai") return;
        setRightTab("ai");
        setTimeout(() => emitAiEdit(cmd), 80);
      },
      [compositionId, rightTab],
    ),
  );

  // Keep selection valid across versions (scenes/layers can be removed by edits or undo).
  const scene = useMemo(() => (doc ? (doc.scenes.find((s) => s.id === sceneId) ?? null) : null), [doc, sceneId]);
  const layer = useMemo(() => (scene && layerId ? (scene.layers.find((l) => l.id === layerId) ?? null) : null), [scene, layerId]);
  const activeScene = scene ?? (doc ? (sceneAt(doc, time)?.scene ?? null) : null);

  const onPatch = useCallback((ops: PatchOp[], summary: string) => void studio.patch(ops, summary), [studio]);
  const seek = useCallback((t: number) => {
    setTime(t);
    player.current?.seek(t);
  }, []);
  const selectScene = useCallback(
    (id: string) => {
      setSceneId(id);
      setLayerId(null);
    },
    [],
  );
  const selectLayer = useCallback(
    (sid: string, lid: string | null, opts?: { keepTab?: boolean }) => {
      setSceneId(sid);
      setLayerId(lid);
      if (!opts?.keepTab) setRightTab("edit");
      if (doc && lid) {
        const i = doc.scenes.findIndex((s) => s.id === sid);
        const l = doc.scenes[i]?.layers.find((x) => x.id === lid);
        const start = sceneStarts(doc)[i] ?? 0;
        const enter = l?.animation.enter;
        // Park the playhead where the layer is fully visible.
        if (l) seek(start + Math.min(doc.scenes[i]!.durationSec - 0.05, l.timing.start + (enter ? enter.delaySec + enter.durationSec : 0) + 0.15));
      }
    },
    [doc, seek],
  );
  // Brand Guardian (module G): the review of the current version highlights affected scenes/layers
  // on the timeline + inspector, and "Show" on a finding selects it without leaving the Brand tab.
  const brand = useBrandReviews(workspaceId, { entity: "compositions", id: compositionId }, data?.composition.currentVersion);
  const brandOpen = useMemo(() => (brand.latest?.findings ?? []).filter((f) => !f.resolution && f.severity !== "info"), [brand.latest]);
  // Spark video review (Track 4): Spark watched the render of this version; blockers badge the tab.
  const videoReviews = useVideoReviews(studio.base, data?.composition.currentVersion);
  const videoBlockers = openVideoBlockers(videoReviews.data?.current);
  const lint = useMemo<LintIssue[]>(
    () => [...(data?.lint ?? []), ...brandOpen.filter((f) => f.location?.sceneId).map((f) => ({ level: f.severity === "block" ? ("error" as const) : ("warning" as const), sceneId: f.location!.sceneId, layerId: f.location!.layerId, message: `Brand: ${f.message}` }))],
    [data?.lint, brandOpen],
  );
  const focusFinding = useCallback(
    (loc: { sceneId?: string; layerId?: string }) => {
      if (!doc || !loc.sceneId) return;
      if (loc.layerId) selectLayer(loc.sceneId, loc.layerId, { keepTab: true });
      else {
        selectScene(loc.sceneId);
        const i = doc.scenes.findIndex((s) => s.id === loc.sceneId);
        if (i >= 0) seek((sceneStarts(doc)[i] ?? 0) + Math.min(0.5, doc.scenes[i]!.durationSec / 2));
      }
    },
    [doc, selectLayer, selectScene, seek],
  );
  const showInVideo = useCallback(
    (sid: string | undefined, atSec: number | undefined) => {
      if (sid) selectScene(sid);
      if (atSec !== undefined) seek(atSec);
      else if (sid && doc) {
        const i = doc.scenes.findIndex((s) => s.id === sid);
        if (i >= 0) seek((sceneStarts(doc)[i] ?? 0) + doc.scenes[i]!.durationSec / 2);
      }
    },
    [doc, selectScene, seek],
  );
  const selectIssue = useCallback(
    (i: LintIssue) => {
      if (i.sceneId && i.layerId) selectLayer(i.sceneId, i.layerId);
      else if (i.sceneId) selectScene(i.sceneId);
    },
    [selectLayer, selectScene],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !doc) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void studio.redo();
        else void studio.undo();
      } else if (e.key === " ") {
        e.preventDefault();
        player.current?.toggle();
      } else if (e.key.toLowerCase() === "s" && !mod) {
        const at = sceneAt(doc, time);
        const ops = at ? splitSceneOps(at.scene, time - at.start) : null;
        if (ops && at) onPatch(ops, `Split ${at.scene.name}`);
      } else if ((e.key === "Backspace" || e.key === "Delete") && scene && layer && !layer.locked) {
        e.preventDefault();
        onPatch([{ op: "remove_layer", sceneId: scene.id, layerId: layer.id }], "Delete layer");
        setLayerId(null);
      } else if (e.key === "Escape") {
        setLayerId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, time, scene, layer, studio, onPatch]);

  if (studio.query.isLoading) {
    return (
      <div className="grid h-[calc(100dvh-var(--ml-topbar-h))] grid-rows-[48px_1fr_220px] gap-px bg-line">
        <Skeleton className="rounded-none" />
        <div className="grid grid-cols-[1fr_340px] gap-px">
          <Skeleton className="rounded-none" />
          <Skeleton className="rounded-none" />
        </div>
        <Skeleton className="rounded-none" />
      </div>
    );
  }
  if (studio.query.error || !data || !doc) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <ErrorState title={studio.query.error?.status === 404 ? "This video doesn't exist" : "The studio didn't load"} message={studio.query.error?.userMessage} onRetry={() => studio.query.refetch()} />
      </div>
    );
  }

  const disabled = studio.saving;
  const mediaPanel = <AssetsDrawer workspaceId={workspaceId} appId={appId} doc={doc} scene={activeScene} layer={layer} onPatch={onPatch} disabled={disabled} />;
  return (
    <div className="flex min-h-[calc(100dvh-var(--ml-topbar-h))] flex-col bg-mist lg:h-[calc(100dvh-var(--ml-topbar-h))]">
      <StudioTopbar
        workspaceId={workspaceId}
        appId={appId}
        base={studio.base}
        data={data}
        saving={studio.saving}
        onUndo={() => void studio.undo()}
        onRedo={() => void studio.redo()}
        onRestore={(v) => void studio.restore(v)}
        onRendered={() => void studio.refresh()}
        onSelectIssue={selectIssue}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[272px_minmax(0,1fr)_360px]">
        <aside className="hidden min-h-0 border-r border-line bg-surface xl:block" aria-label="Media">
          {mediaPanel}
        </aside>
        <main className="flex min-h-[52vh] min-w-0 flex-col p-4 lg:min-h-0">
          {preview.data?.missingAssetIds.length ? (
            <Notice tone="warning" className="mb-3">
              {preview.data.missingAssetIds.length} media file{preview.data.missingAssetIds.length === 1 ? " is" : "s are"} missing or still uploading; they appear blank in the preview.
            </Notice>
          ) : null}
          <PreviewPlayer
            ref={player}
            html={preview.data?.html}
            width={doc.width}
            height={doc.height}
            durationSec={data.durationSec}
            posterSec={preview.data?.posterSec}
            loading={preview.isLoading}
            error={preview.error?.userMessage}
            onRetry={() => preview.refetch()}
            onTime={setTime}
            overlay={showTracks && objects.length ? <TrackOverlay doc={doc} time={time} objects={objects} tracks={clips.data?.tracks ?? {}} /> : null}
            controls={
              <>
                {objects.length ? (
                  <Button size="sm" variant={showTracks ? "secondary" : "ghost"} icon={<ScanSearch className="size-4" aria-hidden />} onClick={() => setShowTracks((v) => !v)} aria-pressed={showTracks}>
                    Tracking
                  </Button>
                ) : null}
                <Button size="sm" variant={rightTab === "review" ? "secondary" : "ghost"} icon={<ScanEye className="size-4" aria-hidden />} onClick={() => setRightTab("review")}>
                  Review with Spark
                </Button>
              </>
            }
          />
        </main>
        <aside className="flex min-h-[420px] flex-col border-l border-line bg-surface lg:min-h-0" aria-label="Edit panel">
          <Tabs value={rightTab} onValueChange={setRightTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList label="Edit panel" className="gap-4 overflow-x-auto px-3 [scrollbar-width:none] [&>*]:shrink-0 [&>*]:whitespace-nowrap">
              <TabsTrigger value="edit">Inspector</TabsTrigger>
              <TabsTrigger value="ai">Ask Muse</TabsTrigger>
              <TabsTrigger value="clip">Clip</TabsTrigger>
              <TabsTrigger value="brand" count={brandOpen.length || undefined}>
                Brand
              </TabsTrigger>
              <TabsTrigger value="review" count={videoBlockers || undefined}>
                Review
              </TabsTrigger>
              <TabsTrigger value="media" className="xl:hidden">
                Media
              </TabsTrigger>
            </TabsList>
            <TabsContent value="edit" className="min-h-0 flex-1 overflow-y-auto">
              <Inspector doc={doc} scene={activeScene} layer={layer} lint={lint} onPatch={onPatch} onSelectLayer={selectLayer} objects={objects} disabled={disabled} />
            </TabsContent>
            <TabsContent value="ai" className="min-h-0 flex-1">
              <AiPanel
                workspaceId={workspaceId}
                base={studio.base}
                compositionId={compositionId}
                doc={doc}
                baseVersion={data.composition.currentVersion}
                selectedSceneId={activeScene?.id ?? null}
                appId={appId}
                clipAnalysisIds={clipAnalysisIds}
                trackedLabels={trackedLabels}
                onApplied={studio.applyCommit}
                onUndo={() => void studio.undo()}
                disabled={disabled}
              />
            </TabsContent>
            <TabsContent value="clip" className="min-h-0 flex-1 overflow-y-auto">
              <ClipPanel
                doc={doc}
                scene={activeScene}
                items={clips.data?.items}
                loading={clips.isLoading}
                error={clips.error?.userMessage}
                onRetry={() => void clips.refetch()}
                demo={demo}
                overlay={showTracks}
                onOverlay={setShowTracks}
                onPatch={onPatch}
                onAnalysed={() => {
                  void clips.refetch();
                  setShowTracks(true);
                }}
                disabled={disabled}
              />
            </TabsContent>
            <TabsContent value="brand" className="min-h-0 flex-1">
              <BrandGuardianPanel
                className="h-full"
                subject={{ entity: "compositions", id: compositionId }}
                version={data.composition.currentVersion}
                onApplied={(r) => studio.applyCommit({ composition: r.composition, version: r.version })}
                onFocus={focusFinding}
              />
            </TabsContent>
            <TabsContent value="review" className="min-h-0 flex-1">
              <VideoReviewPanel
                className="h-full"
                workspaceId={workspaceId}
                base={studio.base}
                doc={doc}
                version={data.composition.currentVersion}
                onShow={showInVideo}
                onApplied={studio.applyCommit}
                onUndo={() => void studio.undo()}
                disabled={disabled}
              />
            </TabsContent>
            <TabsContent value="media" className="min-h-0 flex-1 xl:hidden">
              {mediaPanel}
            </TabsContent>
          </Tabs>
        </aside>
      </div>
      <div className="h-[236px] shrink-0">
        <Timeline
          doc={doc}
          time={time}
          selectedSceneId={activeScene?.id ?? null}
          selectedLayerId={layer?.id ?? null}
          lint={lint}
          onSelectScene={selectScene}
          onSelectLayer={selectLayer}
          onSeek={seek}
          onPatch={onPatch}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
