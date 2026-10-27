"use client";
import type { AppEvidence } from "@muselaunch/contracts";
import { Badge, Popover, Skeleton, SourceChip, cn } from "@muselaunch/ui";
import { FileSearch, ImageOff } from "lucide-react";
import type { ReactNode } from "react";
import { useAssetUrl } from "@/components/app-icon";

/** Thumbnail of a workspace image asset (signed URL), with loading and broken states. */
export function AssetThumb({ workspaceId, assetId, className, alt = "", onClick }: { workspaceId: string; assetId: string; className?: string; alt?: string; onClick?: () => void }) {
  const url = useAssetUrl(workspaceId, assetId);
  const inner = url.isLoading ? (
    <Skeleton className="size-full" rounded="md" />
  ) : url.data?.url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url.data.url} alt={alt} className="size-full object-cover" loading="lazy" />
  ) : (
    <span className="flex size-full items-center justify-center text-ink-3">
      <ImageOff className="size-4" aria-hidden />
    </span>
  );
  const cls = cn("relative block shrink-0 overflow-hidden rounded-md bg-mist shadow-[0_0_0_0.5px_rgb(0_0_0/0.1)]", className);
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, "transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:shadow-focus")} aria-label={alt || "Open image"}>
      {inner}
    </button>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

/** Evidence list for a claim/feature: fact, source chip, linked screenshot. */
export function EvidenceList({ workspaceId, items }: { workspaceId: string; items: AppEvidence[] }) {
  if (!items.length) return <p className="text-footnote text-ink-2">No evidence is linked. Treat this as unverified until you add a source.</p>;
  return (
    <ul className="space-y-3">
      {items.map((e) => (
        <li key={e.id} className="flex gap-3">
          {e.assetId ? <AssetThumb workspaceId={workspaceId} assetId={e.assetId} className="h-16 w-9" alt="Screenshot evidence" /> : null}
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-footnote text-ink">{e.fact}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <SourceChip source={e.source} compact />
              {e.reviewState === "verified" ? <Badge tone="success">Verified</Badge> : e.reviewState === "rejected" ? <Badge tone="danger">Rejected</Badge> : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function EvidencePopover({ workspaceId, items, trigger }: { workspaceId: string; items: AppEvidence[]; trigger?: ReactNode }) {
  return (
    <Popover
      label="Evidence"
      align="start"
      className="w-[min(380px,calc(100vw-24px))]"
      trigger={
        trigger ?? (
          <button type="button" className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-caption font-medium text-ink-2 hover:bg-mist hover:text-ink">
            <FileSearch className="size-3.5" aria-hidden />
            {items.length ? `${items.length} source${items.length === 1 ? "" : "s"}` : "No sources"}
          </button>
        )
      }
    >
      <p className="mb-3 text-footnote font-semibold">Evidence</p>
      <EvidenceList workspaceId={workspaceId} items={items} />
    </Popover>
  );
}
