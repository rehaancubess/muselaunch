"use client";
import type { Composition, CompositionVersion, Layer, MediaAsset } from "@muselaunch/contracts";
import { Button, Dialog, EmptyState, Field, Select, Skeleton, useToast } from "@muselaunch/ui";
import { Clapperboard } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";

type CompositionDetail = { composition: Composition; version: CompositionVersion };

const rand = () => Math.random().toString(36).slice(2, 10);

/** Video layer showing only the segmented subject (SAM cutout), standing in front of the scene. */
export function cutoutLayer(asset: Pick<MediaAsset, "id">, segmentationId: string): Layer {
  return {
    id: `ly_cutout_${rand()}`,
    name: "Founder cutout",
    type: "video",
    assetId: asset.id,
    fit: "contain",
    trimInSec: 0,
    playbackRate: 1,
    muted: true,
    volume: 1,
    radiusPx: 0,
    mask: { segmentationId, mode: "cutout", objectIds: [], feather: 1, fallback: "unmasked" },
    box: { x: 0.04, y: 0.3, w: 0.92, h: 0.7, rotation: 0, opacity: 1, z: 8 },
    timing: { start: 0 },
    animation: { enter: { preset: "slide-up", durationSec: 0.6, delaySec: 0, easing: "smooth" }, loop: "none" },
    locked: false,
    hidden: false,
  } as Layer;
}

/**
 * "Use this cutout": add the SAM cutout of a clip as a new layer in a scene of one of this app's
 * compositions (C: `POST /compositions/:id/patch`), then open it in the Studio.
 */
export function UseCutoutDialog({ open, onOpenChange, workspaceId, appId, asset, segmentationId }: { open: boolean; onOpenChange: (v: boolean) => void; workspaceId: string; appId: string; asset: MediaAsset; segmentationId: string | null }) {
  const toast = useToast();
  const router = useRouter();
  const list = useApiQuery<Page<Composition>>(open ? wsPath(workspaceId, "/compositions") : null, { query: { appId, limit: 50 } });
  const videos = (list.data?.items ?? []).filter((c) => c.kind === "video");
  const [compositionId, setCompositionId] = useState("");
  const detail = useApiQuery<CompositionDetail>(compositionId ? wsPath(workspaceId, `/compositions/${compositionId}`) : null);
  const scenes = detail.data?.version.doc.scenes ?? [];
  const [sceneId, setSceneId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!compositionId && videos[0]) setCompositionId(videos[0].id);
  }, [videos, compositionId]);
  useEffect(() => {
    const preferred = scenes.find((s) => s.template === "founder-cutout" || s.purpose === "founder") ?? scenes[0];
    setSceneId(preferred?.id ?? "");
  }, [detail.data?.version.version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Use this cutout in a video"
      description="Adds the cut-out subject as a new layer in the scene you choose. Other scenes stay exactly as they are, and you can undo it in the Studio."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!segmentationId || !detail.data || !sceneId}
            onClick={async () => {
              if (!segmentationId || !detail.data) return;
              setBusy(true);
              try {
                await api.post(wsPath(workspaceId, `/compositions/${compositionId}/patch`), {
                  baseVersion: detail.data.composition.currentVersion,
                  ops: [{ op: "add_layer", sceneId, layer: cutoutLayer(asset, segmentationId) }],
                  summary: "Add founder cutout",
                });
                toast.success("Cutout added", "Opening the Studio so you can position it.");
                onOpenChange(false);
                router.push(routes.app(workspaceId, appId).studio(compositionId));
              } catch (e) {
                toast.error("Couldn’t add the cutout", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Add to video
          </Button>
        </>
      }
    >
      {list.isLoading ? (
        <Skeleton className="h-20" rounded="lg" />
      ) : !videos.length ? (
        <EmptyState size="sm" icon={<Clapperboard aria-hidden />} title="No videos yet" description="Produce a campaign concept first; its video appears here so you can add the cutout to a scene." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Video">{(f) => <Select id={f.id} value={compositionId} onChange={(e) => setCompositionId(e.target.value)} options={videos.map((c) => ({ value: c.id, label: `${c.title} (${c.aspectRatio})` }))} />}</Field>
          <Field label="Scene">
            {(f) => <Select id={f.id} value={sceneId} onChange={(e) => setSceneId(e.target.value)} disabled={!scenes.length} options={scenes.map((s, i) => ({ value: s.id, label: `${i + 1}. ${s.name ?? s.purpose}` }))} placeholder={detail.isLoading ? "Loading scenes…" : "Choose a scene"} />}
          </Field>
        </div>
      )}
    </Dialog>
  );
}
