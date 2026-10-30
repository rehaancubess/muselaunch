"use client";
import { Badge, Button, EmptyState, ErrorState, Notice, ProvenanceBadge, SegmentedControl, Skeleton, Tooltip, cn, provenanceOfOrigin } from "@muselaunch/ui";
import { Film, ImageIcon, Music, Plus, Replace } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { wsPath } from "@/lib/api";
import type { Page, SignedUrl } from "@/lib/api-types";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import type { BrollStatusResponse, MediaProvidersResponse } from "./broll";
import { GeneratePane } from "./generate-pane";
import { mediaLayer } from "./ops";
import { StockPane } from "./stock-pane";
import type { Composition, CompositionDoc, Layer, MediaAsset, PatchOp, Scene } from "./types";

type Filter = "product" | "media" | "all";
type Source = "library" | "stock" | "generate";

function Thumb({ workspaceId, asset }: { workspaceId: string; asset: MediaAsset }) {
  const thumbId = asset.kind === "image" ? asset.id : asset.posterAssetId;
  const url = useApiQuery<SignedUrl>(thumbId ? wsPath(workspaceId, `/assets/${thumbId}/url`) : null, { staleTime: 30 * 60_000 });
  if (!thumbId) {
    return <div className="grid size-full place-items-center bg-mist text-ink-3">{asset.kind === "video" ? <Film className="size-5" aria-hidden /> : asset.kind === "audio" ? <Music className="size-5" aria-hidden /> : <ImageIcon className="size-5" aria-hidden />}</div>;
  }
  if (!url.data) return <Skeleton className="size-full" rounded="sm" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url.data.url} alt={asset.title ?? asset.originalFilename ?? "Media"} className="size-full object-cover" loading="lazy" draggable={false} />;
}

/**
 * Media drawer. Library: the app's real screenshots/recordings and other media; selecting an item
 * replaces the selected layer's media (device frames accept only real product media) or adds it to
 * the scene. Stock: licensed lifestyle b-roll (Pexels / Pixabay / Openverse). Generate: a labelled
 * AI still. Stock and generated media go into the scene's background or media layer, never a device.
 * When the scene's storyboard asked for b-roll that couldn't be found, the reason is shown here.
 */
export function AssetsDrawer({
  workspaceId,
  appId,
  doc,
  scene,
  layer,
  onPatch,
  disabled,
  composition,
}: {
  workspaceId: string;
  appId: string;
  doc: CompositionDoc;
  scene: Scene | null;
  layer: Layer | null;
  onPatch: (ops: PatchOp[], summary: string) => void;
  disabled?: boolean;
  composition?: Pick<Composition, "storyboardId" | "campaignId">;
}) {
  const [source, setSource] = useState<Source>("library");
  const [stockQuery, setStockQuery] = useState<{ q: string; kind: "video" | "image"; nonce: number }>();
  const [genPrompt, setGenPrompt] = useState<{ q: string; nonce: number }>();
  const list = useApiQuery<Page<MediaAsset>>(wsPath(workspaceId, "/assets"), { query: { appId, limit: 120 } });
  const providers = useApiQuery<MediaProvidersResponse>(source === "library" ? null : wsPath(workspaceId, "/media/providers"), { staleTime: 5 * 60_000 });
  const broll = useApiQuery<BrollStatusResponse>(composition?.storyboardId ? wsPath(workspaceId, `/storyboards/${composition.storyboardId}/broll`) : null, { staleTime: 60_000 });

  const byId = useMemo(() => new Map((list.data?.items ?? []).map((a) => [a.id, a])), [list.data]);
  // Unknown assets count as product media, so stock never replaces something we can't identify.
  const isProductMedia = useCallback((id: string) => {
    const a = byId.get(id);
    return !a || a.isProductTruth || a.role === "founder_clip";
  }, [byId]);

  // The storyboard asked for b-roll in this scene but none could be attached: say why (once the scene has media, stop).
  const missing = useMemo(() => {
    if (!scene?.storyboardSceneId) return [];
    const hasBroll = !!scene.background.assetId || scene.layers.some((l) => (l.type === "image" || l.type === "video") && !isProductMedia(l.assetId));
    if (hasBroll) return [];
    return (broll.data?.items ?? []).filter((i) => i.sceneId === scene.storyboardSceneId && !i.assetId && i.unresolved);
  }, [scene, broll.data, isProductMedia]);

  const shared = { workspaceId, appId, campaignId: composition?.campaignId, doc, scene, layer, providers: providers.data, isProductMedia, onPatch, disabled };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-line px-3 pb-2 pt-3">
        <SegmentedControl<Source>
          label="Media source"
          size="sm"
          fullWidth
          value={source}
          onChange={setSource}
          items={[
            { value: "library", label: "Library" },
            { value: "stock", label: "Stock" },
            { value: "generate", label: "Generate" },
          ]}
        />
        {missing.length ? (
          <Notice
            tone="info"
            title="No b-roll for this scene yet"
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const h = missing[0]!;
                  if (h.kind === "generated_image") {
                    setGenPrompt({ q: h.query ?? "", nonce: Date.now() });
                    setSource("generate");
                  } else {
                    setStockQuery({ q: h.query ?? "", kind: h.kind === "stock_video" ? "video" : "image", nonce: Date.now() });
                    setSource("stock");
                  }
                }}
              >
                {missing[0]!.kind === "generated_image" ? "Generate" : "Search stock"}
              </Button>
            }
          >
            {missing.map((h) => (
              <p key={`${h.kind}:${h.query}`} className="text-caption">
                {h.unresolved}
              </p>
            ))}
          </Notice>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {source === "library" ? (
          <LibraryPane workspaceId={workspaceId} appId={appId} doc={doc} scene={scene} layer={layer} onPatch={onPatch} disabled={disabled} list={list} onStock={() => setSource("stock")} />
        ) : source === "stock" ? (
          providers.error ? <ErrorState className="m-3" compact message={providers.error.userMessage} onRetry={() => providers.refetch()} /> : <StockPane {...shared} initialQuery={stockQuery} />
        ) : providers.error ? (
          <ErrorState className="m-3" compact message={providers.error.userMessage} onRetry={() => providers.refetch()} />
        ) : (
          <GeneratePane {...shared} initialPrompt={genPrompt} />
        )}
      </div>
    </div>
  );
}

function LibraryPane({
  workspaceId,
  appId,
  doc,
  scene,
  layer,
  onPatch,
  disabled,
  list,
  onStock,
}: {
  workspaceId: string;
  appId: string;
  doc: CompositionDoc;
  scene: Scene | null;
  layer: Layer | null;
  onPatch: (ops: PatchOp[], summary: string) => void;
  disabled?: boolean;
  list: ReturnType<typeof useApiQuery<Page<MediaAsset>>>;
  onStock: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("product");
  const items = useMemo(() => {
    const usable = (list.data?.items ?? []).filter((a) => (a.status === "ready" || a.status === "uploaded") && ["image", "video"].includes(a.kind) && !["render", "preview", "thumbnail", "mask", "package"].includes(a.role));
    if (filter === "product") return usable.filter((a) => a.isProductTruth);
    if (filter === "media") return usable.filter((a) => !a.isProductTruth);
    return usable;
  }, [list.data, filter]);

  const replaceable = layer && (layer.type === "device" || layer.type === "image" || layer.type === "video");
  const act = (a: MediaAsset) => {
    if (!scene) return;
    if (replaceable && layer) {
      if (layer.type === "device") {
        if (!a.isProductTruth) return;
        onPatch([{ op: "update_layer", sceneId: scene.id, layerId: layer.id, set: { screenAssetId: a.id, screenKind: a.kind === "video" ? "video" : "image" } }], "Replace screen");
      } else if (layer.type === "image" && a.kind === "image") {
        onPatch([{ op: "update_layer", sceneId: scene.id, layerId: layer.id, set: { assetId: a.id } }], "Replace image");
      } else if (layer.type === "video" && a.kind === "video") {
        onPatch([{ op: "update_layer", sceneId: scene.id, layerId: layer.id, set: { assetId: a.id } }], "Replace clip");
      }
      return;
    }
    const l = mediaLayer(a, { width: doc.width, height: doc.height });
    if (l) onPatch([{ op: "add_layer", sceneId: scene.id, layer: l }], `Add ${a.isProductTruth ? "real screen" : a.kind}`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-line px-3 py-3">
        <SegmentedControl<Filter>
          label="Media filter"
          size="sm"
          fullWidth
          value={filter}
          onChange={setFilter}
          items={[
            { value: "product", label: "Screens" },
            { value: "media", label: "Media" },
            { value: "all", label: "All" },
          ]}
        />
        <p className="text-caption text-ink-3">
          {replaceable ? (layer?.type === "device" ? "Pick a real screenshot or recording for the selected device." : "Pick media to replace the selected layer.") : scene ? `Click to add to ${scene.name}.` : "Select a scene first."}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {list.isLoading ? (
          <div className="grid grid-cols-2 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="aspect-[9/16]" />
            ))}
          </div>
        ) : list.error ? (
          <ErrorState compact message={list.error.userMessage} onRetry={() => list.refetch()} />
        ) : !items.length ? (
          <EmptyState
            size="sm"
            icon={<ImageIcon aria-hidden />}
            title={filter === "product" ? "No screenshots yet" : "No media yet"}
            description={
              filter === "product" ? (
                <>
                  Upload real screenshots and screen recordings in the{" "}
                  <Link className="text-accent hover:underline" href={routes.app(workspaceId, appId).library}>
                    library
                  </Link>
                  .
                </>
              ) : (
                <>
                  Find licensed b-roll in{" "}
                  <button type="button" className="text-accent hover:underline" onClick={onStock}>
                    Stock
                  </button>
                  , generate an image, or upload your own in the{" "}
                  <Link className="text-accent hover:underline" href={routes.app(workspaceId, appId).library}>
                    library
                  </Link>
                  .
                </>
              )
            }
          />
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {items.map((a) => {
              const blocked = !!(replaceable && layer?.type === "device" && !a.isProductTruth) || (replaceable && layer?.type === "image" && a.kind !== "image") || (replaceable && layer?.type === "video" && a.kind !== "video");
              const current = layer && ((layer.type === "device" && layer.screenAssetId === a.id) || ((layer.type === "image" || layer.type === "video") && layer.assetId === a.id));
              const btn = (
                <button
                  type="button"
                  disabled={disabled || blocked || !scene}
                  onClick={() => act(a)}
                  className={cn(
                    "group relative block w-full overflow-hidden rounded-lg border bg-mist text-left transition",
                    current ? "border-accent ring-2 ring-accent/30" : "border-line hover:border-line-strong",
                    (blocked || !scene) && "cursor-not-allowed opacity-45",
                  )}
                  aria-label={`${replaceable ? "Use" : "Add"} ${a.title ?? a.originalFilename ?? a.role}`}
                >
                  <div className="aspect-[9/16] w-full overflow-hidden">
                    <Thumb workspaceId={workspaceId} asset={a} />
                  </div>
                  <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-surface/90 text-ink opacity-0 shadow-raised transition group-hover:opacity-100">
                    {replaceable ? <Replace className="size-3.5" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
                  </span>
                  <div className="flex flex-wrap items-center gap-1 p-1.5">
                    {a.isProductTruth ? <Badge tone="success">Real</Badge> : <ProvenanceBadge kind={provenanceOfOrigin(a.origin)} detail={a.license?.attribution ?? a.license?.provider} />}
                    {a.kind === "video" ? <Badge tone="neutral">{a.durationSec ? `${Math.round(a.durationSec)}s` : "video"}</Badge> : null}
                  </div>
                </button>
              );
              return <li key={a.id}>{blocked && layer?.type === "device" ? <Tooltip content="Only real screenshots and recordings can appear inside a device frame.">{btn}</Tooltip> : btn}</li>;
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
