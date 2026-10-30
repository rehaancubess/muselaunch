"use client";
/**
 * Studio "Stock" tab: search Pexels, Pixabay or Openverse, preview, see the licence and attribution,
 * and add a photo or clip to the selected scene (its background or media layer). Imports are
 * downloaded into the workspace by the API (no hotlinking); the licence comes from the provider again
 * server-side. Providers without a key say so instead of failing.
 */
import { Badge, Button, EmptyState, ErrorState, Input, Notice, ProvenanceBadge, SegmentedControl, Skeleton, Tooltip, cn, useToast } from "@muselaunch/ui";
import { ExternalLink, Film, ImageIcon, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { AssetResponse } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { docOrientation, fmtDuration, mediaTarget, placeMediaOps, targetLabel, type MediaProvidersResponse, type StockImportResponse, type StockItem, type StockProviderId, type StockSearchResponse } from "./broll";
import type { CompositionDoc, Layer, MediaAsset, PatchOp, Scene } from "./types";

type Kind = "video" | "image";

const NO_KEY: Record<StockProviderId, string> = {
  pexels: "Add a Pexels API key (PEXELS_API_KEY) to search Pexels photos and video.",
  pixabay: "Add a Pixabay API key (PIXABAY_API_KEY) to search Pixabay photos and video.",
  openverse: "Openverse is unavailable.",
};

export function StockPane({
  workspaceId,
  appId,
  campaignId,
  doc,
  scene,
  layer,
  providers,
  isProductMedia,
  onPatch,
  disabled,
  initialQuery,
}: {
  workspaceId: string;
  appId: string;
  campaignId?: string;
  doc: CompositionDoc;
  scene: Scene | null;
  layer: Layer | null;
  providers: MediaProvidersResponse | undefined;
  isProductMedia: (assetId: string) => boolean;
  onPatch: (ops: PatchOp[], summary: string) => void;
  disabled?: boolean;
  initialQuery?: { q: string; kind: Kind; nonce: number };
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const stock = providers?.stock ?? [];
  const live = (kind: Kind) => stock.filter((p) => p.state === "live" && p.kinds.includes(kind));
  const videoReady = live("video").length > 0;
  const [kind, setKind] = useState<Kind>("video");
  const [provider, setProvider] = useState<StockProviderId | null>(null);
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ key: string; jobId: string | null } | null>(null);

  // Without a video provider, start on photos (Openverse needs no key).
  useEffect(() => {
    if (providers && !videoReady) setKind("image");
  }, [providers, videoReady]);
  // "Search stock" from a scene's b-roll notice pre-fills the query.
  useEffect(() => {
    if (!initialQuery) return;
    const k = initialQuery.kind === "video" && !videoReady ? "image" : initialQuery.kind;
    setKind(k);
    setText(initialQuery.q);
    setSubmitted(initialQuery.q.slice(0, 100));
  }, [initialQuery, videoReady]);

  const forKind = stock.filter((p) => p.kinds.includes(kind));
  const active = provider && forKind.some((p) => p.id === provider && p.state === "live") ? provider : (live(kind)[0]?.id ?? null);
  const orientation = docOrientation(doc);
  const search = useApiQuery<StockSearchResponse>(submitted && active ? wsPath(workspaceId, "/stock/search") : null, {
    query: { q: submitted ?? "", kind, provider: active ?? undefined, orientation, perPage: 24 },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const target = scene ? mediaTarget(scene, layer, isProductMedia) : null;
  const place = (asset: MediaAsset) => {
    if (!scene || !target) return;
    const { ops, summary } = placeMediaOps(scene, target, asset);
    onPatch(ops, summary);
    void invalidate(wsPath(workspaceId, "/assets"));
  };

  // Imports run media.probe (normalisation + poster) before the media is placed.
  const probe = useJob(workspaceId, adding?.jobId ?? null, {
    onSettled: (j) => {
      const assetId = adding?.key.split("|")[1];
      setAdding(null);
      if (j.status !== "succeeded" || !assetId) {
        toast.error("Couldn't add that file", j.error?.userMessage ?? "Processing failed. Try another result.");
        return;
      }
      void api
        .get<AssetResponse>(wsPath(workspaceId, `/assets/${assetId}`))
        .then((r) => place(r.asset))
        .catch((e) => toast.error("Couldn't add that file", errorMessage(e)));
    },
  });

  const add = async (item: StockItem) => {
    const key = `${item.provider}:${item.id}`;
    setAdding({ key, jobId: null });
    try {
      const r = await api.post<StockImportResponse>(wsPath(workspaceId, "/stock/import"), { provider: item.provider, id: item.id, kind: item.kind, appId, campaignId });
      if (r.asset.status === "ready" || !r.job) {
        setAdding(null);
        place(r.asset);
      } else setAdding({ key: `${key}|${r.asset.id}`, jobId: r.job.id });
    } catch (e) {
      setAdding(null);
      toast.error("Couldn't add that file", errorMessage(e));
    }
  };

  const items = search.data?.items ?? [];
  const busyKey = adding?.key.split("|")[0];
  const placeHint = !scene ? "Select a scene first." : `${targetLabel(target!, kind)} in ${scene.name}.`;
  const unavailable = useMemo(() => forKind.filter((p) => p.state !== "live"), [forKind]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2.5 border-b border-line px-3 py-3">
        <SegmentedControl<Kind>
          label="Stock type"
          size="sm"
          fullWidth
          value={kind}
          onChange={(k) => {
            setKind(k);
            setProvider(null);
          }}
          items={[
            { value: "video", label: "Video", icon: <Film className="size-3.5" aria-hidden /> },
            { value: "image", label: "Photos", icon: <ImageIcon className="size-3.5" aria-hidden /> },
          ]}
        />
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const q = text.trim().slice(0, 100);
            if (q) setSubmitted(q);
          }}
        >
          <Input className="flex-1" inputSize="md" leading={<Search aria-hidden />} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === "video" ? "e.g. student studying at night" : "e.g. cosy desk with coffee"} aria-label="Search stock" maxLength={100} disabled={!active} />
          <Button type="submit" size="md" variant="secondary" disabled={!active || !text.trim()}>
            Search
          </Button>
        </form>
        {forKind.length > 1 ? (
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Stock provider">
            {forKind.map((p) => {
              const on = p.id === active;
              const chip = (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={p.state !== "live"}
                  onClick={() => setProvider(p.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-caption font-medium transition",
                    on ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:border-line-strong",
                    p.state !== "live" && "cursor-not-allowed opacity-50",
                  )}
                >
                  {p.label.replace(" (Creative Commons)", "")}
                </button>
              );
              return p.state === "live" ? chip : <Tooltip key={p.id} content={NO_KEY[p.id]}>{chip}</Tooltip>;
            })}
          </div>
        ) : null}
        <p className="text-caption text-ink-3">{placeHint}</p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {!providers ? (
          <Skeleton className="h-20 w-full" rounded="lg" />
        ) : !active ? (
          <Notice tone="info" title={kind === "video" ? "Stock video isn’t connected" : "Stock photos aren’t connected"}>
            <p>{kind === "video" ? "Add a Pexels API key (PEXELS_API_KEY) or a Pixabay key (PIXABAY_API_KEY) to search stock video." : "No stock photo provider is available on this deployment."}</p>
            {kind === "video" && live("image").length ? (
              <Button className="mt-2" size="sm" variant="secondary" onClick={() => setKind("image")}>
                Search Openverse photos instead
              </Button>
            ) : null}
          </Notice>
        ) : !submitted ? (
          <EmptyState
            size="sm"
            icon={kind === "video" ? <Film aria-hidden /> : <ImageIcon aria-hidden />}
            title="Lifestyle b-roll"
            description="Moods, people and places around your app. Every result shows its licence and is credited in your exports. Your app’s screens always come from real screenshots."
          />
        ) : search.isLoading ? (
          <div className="grid grid-cols-2 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="aspect-[9/16]" />
            ))}
          </div>
        ) : search.error ? (
          <ErrorState compact message={search.error.userMessage} onRetry={() => search.refetch()} />
        ) : !items.length ? (
          <EmptyState size="sm" icon={<Search aria-hidden />} title="No results" description="Try fewer, simpler words (for example “desk night” instead of a full sentence)." />
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {items.map((item) => {
              const key = `${item.provider}:${item.id}`;
              const busy = busyKey === key;
              return (
                <li key={key} className="overflow-hidden rounded-lg border border-line bg-surface">
                  <div className="relative aspect-[9/16] w-full overflow-hidden bg-mist">
                    {/* Provider preview for browsing only; "Add" downloads the file into your workspace. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.previewUrl} alt={item.title ?? `${item.kind} by ${item.creator ?? "unknown"}`} className="size-full object-cover" loading="lazy" referrerPolicy="no-referrer" draggable={false} />
                    {item.kind === "video" && item.durationSec !== undefined ? (
                      <Badge tone="neutral" className="absolute bottom-1.5 left-1.5">
                        {fmtDuration(item.durationSec)}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="space-y-1.5 p-1.5">
                    <div className="flex items-center gap-1">
                      <ProvenanceBadge kind="stock" label={item.license.name} detail={item.license.attributionRequired ? "Attribution required" : "No attribution required (credited anyway)"} />
                    </div>
                    <p className="line-clamp-2 text-caption text-ink-3" title={item.license.attribution}>
                      {item.license.attribution}{" "}
                      <a href={item.pageUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center text-accent hover:underline" aria-label={`Open on ${item.provider}`}>
                        <ExternalLink className="size-3" aria-hidden />
                      </a>
                    </p>
                    <Button size="sm" variant="secondary" className="w-full" icon={<Plus className="size-3.5" aria-hidden />} loading={busy} disabled={disabled || !scene || (!!adding && !busy)} onClick={() => void add(item)}>
                      Add to scene
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {probe.job && adding ? <p className="text-caption text-ink-3">Preparing the file ({probe.job.progress.stage})…</p> : null}
        {unavailable.length && active ? <p className="text-caption text-ink-3">{unavailable.map((p) => NO_KEY[p.id]).join(" ")}</p> : null}
      </div>
    </div>
  );
}
