"use client";
import type { Composition } from "@muselaunch/contracts";
import { Badge, Button, StatusPill, cn, humanizeStatus, statusKindOf } from "@muselaunch/ui";
import { Download, Film, PenSquare, Send } from "lucide-react";
import Link from "next/link";
import { useAssetUrl } from "@/components/app-icon";
import { relativeTime } from "@/lib/labels";
import { routes } from "@/lib/routes";

const ASPECT_CLASS: Record<string, string> = { "9:16": "aspect-[9/16]", "1:1": "aspect-square", "4:5": "aspect-[4/5]", "16:9": "aspect-video" };

/** Composition tile with poster, render status and Studio / download actions. */
export function CompositionCard({ composition: c, workspaceId, onPost }: { composition: Composition; workspaceId: string; onPost?: (finalAssetId?: string) => void }) {
  const thumb = useAssetUrl(workspaceId, c.thumbnailAssetId);
  const renderAsset = c.lastRender?.assetId;
  const download = useAssetUrl(workspaceId, c.lastRender?.quality === "final" ? renderAsset : null, { download: true });
  const r = routes.app(workspaceId, c.appId);
  return (
    <article className="group flex flex-col gap-3">
      <Link href={r.studio(c.id)} className={cn("relative block overflow-hidden rounded-xl bg-mist shadow-raised focus-visible:outline-none focus-visible:shadow-focus", c.aspectRatio === "16:9" ? "aspect-video" : "aspect-[4/5]")}>
        <span className="absolute inset-0 flex items-center justify-center p-4">
          <span className={cn("relative h-full max-h-full overflow-hidden rounded-lg bg-ink/5", ASPECT_CLASS[c.aspectRatio] ?? "aspect-[9/16]", c.aspectRatio === "16:9" && "h-auto w-full")}>
            {thumb.data?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumb.data.url} alt="" className="size-full object-cover" />
            ) : (
              <span className="flex size-full flex-col items-center justify-center gap-1.5 text-ink-3">
                <Film className="size-5" aria-hidden />
                <span className="text-caption">{c.status === "rendering" ? "Rendering…" : "No preview yet"}</span>
              </span>
            )}
          </span>
        </span>
        <span className="absolute left-3 top-3 flex gap-1">
          <Badge tone="neutral" className="bg-white/90 backdrop-blur">
            {c.aspectRatio}
          </Badge>
        </span>
      </Link>
      <div className="flex items-start justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <p className="truncate text-body-sm font-medium">{c.title}</p>
          <p className="text-caption text-ink-2">
            Version {c.currentVersion}, edited {relativeTime(c.updatedAt)}
          </p>
        </div>
        <StatusPill status={statusKindOf(c.status)}>{humanizeStatus(c.status)}</StatusPill>
      </div>
      <div className="flex flex-wrap gap-x-1 gap-y-2 px-0.5">
        <Button size="sm" variant="secondary" asChild>
          <Link href={r.studio(c.id)}>
            <PenSquare className="size-3.5" aria-hidden />
            Edit in Studio
          </Link>
        </Button>
        {download.data?.url ? (
          <Button size="sm" variant="ghost" asChild>
            <a href={download.data.url} download>
              <Download className="size-3.5" aria-hidden />
              {c.kind === "video" ? "MP4" : "PNG"}
            </a>
          </Button>
        ) : null}
        {onPost ? (
          <Button size="sm" variant="ghost" icon={<Send className="size-3.5" aria-hidden />} onClick={() => onPost(c.lastRender?.quality === "final" ? c.lastRender.assetId : undefined)}>
            Post
          </Button>
        ) : null}
      </div>
    </article>
  );
}
