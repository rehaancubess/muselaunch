"use client";
import type { MediaAsset } from "@muselaunch/contracts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  PageHeader,
  ProvenanceBadge,
  SegmentedControl,
  Sheet,
  Skeleton,
  Spinner,
  StatusPill,
  humanizeStatus,
  provenanceOfOrigin,
  statusKindOf,
  useToast,
} from "@muselaunch/ui";
import { AudioLines, Download, FileText, FolderOpen, Mic, Play, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { PageContainer } from "@/components/page-container";
import MaskSelector from "@/features/media/mask-selector";
import VoiceRecorder from "@/features/media/voice-recorder";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { ROLE_LABEL, formatBytes, formatDuration, relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useCurrentApp, useWorkspace } from "@/lib/workspace";
import { Uploader } from "./uploader";
import { UseCutoutDialog } from "./use-cutout";

type Filter = "all" | "product" | "founder" | "generated" | "renders" | "audio";

const FILTERS: { value: Filter; label: string; test: (a: MediaAsset) => boolean }[] = [
  { value: "all", label: "All", test: (a) => !["mask", "preview", "thumbnail"].includes(a.role) },
  { value: "product", label: "Product", test: (a) => a.isProductTruth || ["screenshot", "app_recording", "icon", "logo", "product_photo"].includes(a.role) },
  { value: "founder", label: "Founder", test: (a) => a.role === "founder_clip" || a.role === "voiceover" },
  { value: "generated", label: "Generated & stock", test: (a) => a.origin === "generated" || a.origin === "stock" },
  { value: "renders", label: "Renders", test: (a) => a.origin === "render" || a.role === "render" || a.role === "package" },
  { value: "audio", label: "Audio", test: (a) => a.kind === "audio" },
];

function Tile({ asset, workspaceId, onOpen }: { asset: MediaAsset; workspaceId: string; onOpen: () => void }) {
  const showImage = asset.kind === "image" && asset.status !== "pending_upload";
  const poster = asset.kind === "video" ? asset.posterAssetId : undefined;
  const url = useAssetUrl(workspaceId, showImage ? asset.id : poster);
  const portrait = (asset.height ?? 0) > (asset.width ?? 0);
  return (
    <button type="button" onClick={onOpen} className="group flex flex-col gap-2 text-left focus-visible:outline-none" aria-label={`Open ${asset.title ?? asset.originalFilename ?? ROLE_LABEL[asset.role]}`}>
      <span className="relative block aspect-square overflow-hidden rounded-xl bg-mist shadow-raised transition-shadow group-hover:shadow-[0_6px_20px_-8px_rgb(16_24_40/0.2),0_0_0_1px_rgb(16_24_40/0.06)] group-focus-visible:shadow-focus">
        {url.data?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url.data.url} alt="" loading="lazy" className={portrait ? "size-full object-contain p-2" : "size-full object-cover"} />
        ) : (
          <span className="flex size-full items-center justify-center text-ink-3">
            {asset.status === "processing" || asset.status === "uploaded" ? (
              <Spinner size={18} />
            ) : asset.kind === "video" ? (
              <Play className="size-6" aria-hidden />
            ) : asset.kind === "audio" ? (
              <AudioLines className="size-6" aria-hidden />
            ) : (
              <FileText className="size-6" aria-hidden />
            )}
          </span>
        )}
        {asset.kind === "video" && asset.durationSec ? (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular text-white">{formatDuration(asset.durationSec)}</span>
        ) : null}
        <span className="absolute left-2 top-2">
          <ProvenanceBadge kind={provenanceOfOrigin(asset.origin)} className="bg-white/90 backdrop-blur" />
        </span>
      </span>
      <span className="min-w-0 px-0.5">
        <span className="block truncate text-footnote font-medium text-ink">{asset.title ?? asset.originalFilename ?? ROLE_LABEL[asset.role]}</span>
        <span className="block text-caption text-ink-2">{ROLE_LABEL[asset.role]}</span>
      </span>
    </button>
  );
}

function Preview({ asset, workspaceId }: { asset: MediaAsset; workspaceId: string }) {
  const url = useAssetUrl(workspaceId, asset.status === "pending_upload" ? null : asset.id);
  if (url.isLoading) return <Skeleton className="aspect-video w-full" rounded="lg" />;
  if (url.error || !url.data) return <ErrorState compact message={url.error ? errorMessage(url.error) : "Preview unavailable"} onRetry={() => url.refetch()} />;
  if (asset.kind === "image" || asset.kind === "mask")
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url.data.url} alt={asset.title ?? ""} className="max-h-[56vh] w-full rounded-lg bg-mist object-contain" />;
  if (asset.kind === "video") return <video src={url.data.url} controls playsInline preload="metadata" className="max-h-[56vh] w-full rounded-lg bg-black" />;
  if (asset.kind === "audio") return <audio src={url.data.url} controls className="w-full" />;
  return (
    <a href={url.data.url} target="_blank" rel="noreferrer" className="text-body-sm text-accent hover:underline">
      Open file
    </a>
  );
}

function AssetSheet({ asset, workspaceId, onClose, canEdit }: { asset: MediaAsset | null; workspaceId: string; onClose: () => void; canEdit: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [segmentationId, setSegmentationId] = useState<string | null>(null);
  const [useOpen, setUseOpen] = useState(false);
  const dl = useAssetUrl(workspaceId, asset && asset.status !== "pending_upload" ? asset.id : null, { download: true });
  if (!asset) return null;
  const rows: [string, string][] = [
    ["Type", `${ROLE_LABEL[asset.role]} (${asset.mimeType})`],
    ["Size", formatBytes(asset.bytes)],
    ...(asset.width && asset.height ? ([["Dimensions", `${asset.width} × ${asset.height}`]] as [string, string][]) : []),
    ...(asset.durationSec ? ([["Duration", formatDuration(asset.durationSec)]] as [string, string][]) : []),
    ["Added", relativeTime(asset.createdAt)],
    ["Licence", asset.license ? humanizeStatus(asset.license.type) : "Unknown"],
  ];
  return (
    <Sheet
      open={Boolean(asset)}
      onOpenChange={(v) => !v && onClose()}
      title={asset.title ?? asset.originalFilename ?? ROLE_LABEL[asset.role]}
      description={asset.isProductTruth ? "Real product media: can be used as evidence" : undefined}
      width="max-w-xl"
      footer={
        <>
          {canEdit ? (
            <Button variant="ghost" className="mr-auto text-danger hover:bg-danger-soft hover:text-danger" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setConfirm(true)}>
              Delete
            </Button>
          ) : null}
          {dl.data?.url ? (
            <Button asChild>
              <a href={dl.data.url} download>
                <Download className="size-4" aria-hidden />
                Download
              </a>
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-6 p-5">
        <Preview asset={asset} workspaceId={workspaceId} />
        <div className="flex flex-wrap gap-1.5">
          <ProvenanceBadge kind={provenanceOfOrigin(asset.origin)} />
          {asset.status !== "ready" ? <StatusPill status={statusKindOf(asset.status)}>{asset.status === "uploaded" ? "Waiting for processing" : humanizeStatus(asset.status)}</StatusPill> : null}
          {asset.license?.consent ? <Badge tone="success">Consent recorded</Badge> : null}
        </div>
        <dl className="divide-y divide-line rounded-xl bg-mist/60 text-body-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
              <dt className="text-ink-2">{k}</dt>
              <dd className="text-right text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        {asset.generation ? (
          <div className="space-y-1.5 rounded-xl border border-line p-4">
            <p className="text-footnote font-semibold">Generated with {asset.generation.provider}</p>
            <p className="text-caption text-ink-2">Model {asset.generation.model}</p>
            <p className="text-footnote text-ink-2">“{asset.generation.prompt}”</p>
          </div>
        ) : null}
        {asset.error ? <ErrorState compact message={asset.error} /> : null}
        {asset.kind === "video" && asset.role !== "render" && asset.role !== "preview" ? (
          <div className="space-y-3 border-t border-line pt-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-body-sm font-semibold">Cut out subject</p>
                <p className="text-footnote text-ink-2">SAM 3.1 tracks a person or object through the clip so it can stand in front of your app.</p>
              </div>
              {segmentationId ? (
                <Button size="sm" onClick={() => setUseOpen(true)}>
                  Use in a video
                </Button>
              ) : null}
            </div>
            <MaskSelector
              assetId={asset.id}
              onSegmentation={(id) => {
                setSegmentationId(id);
                setUseOpen(true);
              }}
            />
            <UseCutoutDialog open={useOpen} onOpenChange={setUseOpen} workspaceId={workspaceId} appId={asset.appId ?? ""} asset={asset} segmentationId={segmentationId} />
          </div>
        ) : null}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        size="sm"
        title="Delete this file?"
        description="It’s removed from storage. Compositions that use it will show it as missing."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.del(wsPath(workspaceId, `/assets/${asset.id}`));
                  await invalidate(wsPath(workspaceId, "/assets"));
                  setConfirm(false);
                  onClose();
                  toast.success("File deleted");
                } catch (e) {
                  toast.error("Couldn’t delete", errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </Sheet>
  );
}

export function LibraryPage() {
  const { appId, workspaceId, app } = useCurrentApp();
  const { can } = useWorkspace();
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [recordOpen, setRecordOpen] = useState(false);
  const q = useApiQuery<Page<MediaAsset>>(wsPath(workspaceId, "/assets"), {
    query: { appId, limit: 120, cursor },
    refetchInterval: (qq) => (qq.state.data?.items.some((a) => a.status === "uploaded" || a.status === "processing") ? 4000 : false),
  });
  const items = useMemo(() => (q.data?.items ?? []).filter(FILTERS.find((f) => f.value === filter)!.test), [q.data, filter]);
  const open = q.data?.items.find((a) => a.id === openId) ?? null;
  const canEdit = can("content.write");

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Library"
        description={`Screenshots, recordings, founder clips, generated media and renders for ${app?.name ?? "this app"}. Every file shows where it came from.`}
        actions={
          canEdit ? (
            <Button variant="secondary" icon={<Mic className="size-4" aria-hidden />} onClick={() => setRecordOpen(true)}>
              Record
            </Button>
          ) : null
        }
      />
      <div className="space-y-10">
        {canEdit ? <Uploader workspaceId={workspaceId} appId={appId} /> : null}
        <div className="space-y-5">
          <div className="overflow-x-auto pb-1">
            <SegmentedControl<Filter> label="Filter files" size="sm" value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
          </div>
          {q.isLoading ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {Array.from({ length: 12 }, (_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="aspect-square" rounded="xl" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          ) : q.error ? (
            <ErrorState title="Files didn’t load" message={errorMessage(q.error)} onRetry={() => q.refetch()} retrying={q.isFetching} />
          ) : items.length ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {items.map((a) => (
                <Tile key={a.id} asset={a} workspaceId={workspaceId} onOpen={() => setOpenId(a.id)} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<FolderOpen aria-hidden />}
              title={filter === "all" ? "No files yet" : "Nothing here yet"}
              description={
                filter === "all"
                  ? "Imported store screenshots appear here automatically. Add screen recordings for demo videos, and a founder clip if you want to appear in them."
                  : filter === "renders"
                    ? "Rendered videos and export packages appear here after you produce a campaign."
                    : filter === "generated"
                      ? "Lifestyle b-roll appears here with its provider and licence: stock from Pexels, Pixabay or Openverse, and labelled AI images. MuseLaunch finds it for your storyboards automatically, and you can search stock or generate an image in the Studio’s media panel."
                      : "Upload files above and set their type."
              }
            />
          )}
          {q.data?.nextCursor ? (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => setCursor(q.data?.nextCursor ?? undefined)}>
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <AssetSheet asset={open} workspaceId={workspaceId} onClose={() => setOpenId(null)} canEdit={canEdit} />
      <Dialog open={recordOpen} onOpenChange={setRecordOpen} title="Record a founder brief" description="Talk through your app. Muse transcribes it and uses it as a brief and for captions.">
        <VoiceRecorder appId={appId} purpose="founder_brief" />
      </Dialog>
    </PageContainer>
  );
}
