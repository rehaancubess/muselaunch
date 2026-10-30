"use client";
import type { Job, MediaAsset } from "@muselaunch/contracts";
import { Badge, Button, JobProgress, Notice } from "@muselaunch/ui";
import { Scissors, Smartphone } from "lucide-react";
import { useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useJob } from "@/lib/jobs";
import { useInvalidate } from "@/lib/query";

export const isUiCrop = (a: MediaAsset) => a.sourceLabel === "sam_ui_crop";

/** Small tile badge: SAM cut-outs and designed store images. */
export function ScreenKindBadge({ asset, className }: { asset: MediaAsset; className?: string }) {
  if (isUiCrop(asset))
    return (
      <Badge tone="accent" icon={<Scissors aria-hidden />} className={className} title="The app screen, cut out of a designed store image by SAM 3.1">
        Cut out by SAM 3.1
      </Badge>
    );
  if (asset.role === "screenshot" && asset.screenshotKind === "marketing")
    return (
      <Badge tone="neutral" className={className} title="Designed store image (headline, device frame): shown full screen, never inside another device frame">
        Store image
      </Badge>
    );
  return null;
}

type ExtractResponse = { job: Job | null; pending: number; credits: number };

/**
 * Asset sheet section for screenshots: where a SAM cut-out came from (with a way to open the original),
 * what a designed store image is used for (with its cut-out), or a check for screenshots not yet sorted.
 */
export function ScreenCutoutSection({
  asset,
  items,
  workspaceId,
  canEdit,
  onOpen,
}: {
  asset: MediaAsset;
  items: MediaAsset[];
  workspaceId: string;
  canEdit: boolean;
  onOpen: (assetId: string) => void;
}) {
  const invalidate = useInvalidate();
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const job = useJob(workspaceId, jobId, { onSettled: () => void invalidate(wsPath(workspaceId, "/assets")) });
  if (asset.role !== "screenshot" || asset.kind !== "image" || !asset.isProductTruth || asset.generation) return null;

  const check = async () => {
    if (!asset.appId) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.post<ExtractResponse>(wsPath(workspaceId, `/apps/${asset.appId}/media/extract-ui`), { assetIds: [asset.id] }, { idempotent: true });
      if (r.job) setJobId(r.job.id);
      else setNote("Nothing left to do for this screenshot.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const progress = jobId ? <JobProgress job={job.job} title="Checking the screenshot (Muse Spark) and cutting out the app screen (SAM 3.1)" onRetry={() => void job.retry()} retrying={job.retrying} /> : null;
  const feedback = (
    <>
      {progress}
      {error ? <p className="text-footnote text-danger">{error}</p> : null}
      {note ? <p className="text-footnote text-ink-2">{note}</p> : null}
    </>
  );

  if (isUiCrop(asset)) {
    const original = items.find((a) => a.id === asset.derivedFromAssetId);
    return (
      <Notice
        tone="info"
        icon={<Scissors aria-hidden />}
        title="Cut out by SAM 3.1"
        action={
          asset.derivedFromAssetId ? (
            <Button size="sm" variant="secondary" onClick={() => onOpen(asset.derivedFromAssetId!)}>
              View original
            </Button>
          ) : null
        }
      >
        The real app screen from {original?.title ? `“${original.title}”` : "a designed store image"}, so videos can show it inside a device frame without a frame within a frame.
      </Notice>
    );
  }

  if (asset.screenshotKind === "marketing") {
    const crop = items.find((a) => isUiCrop(a) && a.derivedFromAssetId === asset.id && a.status === "ready");
    return (
      <div className="space-y-3">
        <Notice
          tone="neutral"
          icon={<Smartphone aria-hidden />}
          title="Designed store image"
          action={
            crop ? (
              <Button size="sm" variant="secondary" onClick={() => onOpen(crop.id)}>
                View cut-out
              </Button>
            ) : canEdit && !jobId ? (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void check()}>
                Find the app screen
              </Button>
            ) : null
          }
        >
          {crop
            ? "Muse Spark spotted a headline and device frame. Videos show this image full screen only; SAM 3.1 cut out its app screen for device-frame scenes."
            : "Muse Spark spotted a headline and device frame. Videos show it full screen only, never inside another device frame. No app screen has been cut out of it yet (2 credits)."}
        </Notice>
        {feedback}
      </div>
    );
  }

  if (asset.screenshotKind === "raw_ui") return <p className="text-footnote text-ink-2">Raw app screen (checked by Muse Spark): videos can show it inside a device frame.</p>;

  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-footnote text-ink-2 text-pretty">
          Not checked yet. Muse Spark tells a raw app screen from a designed store image; for store images, SAM 3.1 cuts out the app screen so videos never show a frame within a frame. 2 credits.
        </p>
        {canEdit && !jobId ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void check()}>
            Check
          </Button>
        ) : null}
      </div>
      {feedback}
    </div>
  );
}
