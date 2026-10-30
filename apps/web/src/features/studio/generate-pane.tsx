"use client";
/**
 * Studio "Generate image" tab: an AI still for the selected scene (backgrounds, moods, scenes). The
 * provider is named before you spend (Muse Image only where eligible, otherwise the licensed
 * alternative), the cost is estimated, and every result is labelled AI-generated. Prompts asking for
 * the app's interface are refused by the API: real screenshots are the only product truth.
 */
import type { Job } from "@muselaunch/contracts";
import { Button, Field, JobProgress, Notice, ProvenanceBadge, Skeleton, Textarea, useToast } from "@muselaunch/ui";
import { Plus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { AssetResponse, SignedUrl } from "@/lib/api-types";
import { WorkspaceCostEstimate } from "@/lib/estimate";
import { useJob } from "@/lib/jobs";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { imageSizeForDoc, mediaTarget, placeMediaOps, targetLabel, type ImageGenerateResponse, type MediaProvidersResponse } from "./broll";
import type { CompositionDoc, Layer, MediaAsset, PatchOp, Scene } from "./types";

function Result({ workspaceId, asset }: { workspaceId: string; asset: MediaAsset }) {
  const url = useApiQuery<SignedUrl>(wsPath(workspaceId, `/assets/${asset.id}/url`), { staleTime: 30 * 60_000 });
  if (!url.data) return <Skeleton className="aspect-[2/3] w-full" rounded="lg" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url.data.url} alt={asset.generation?.prompt ?? "AI-generated image"} className="w-full rounded-lg border border-line object-cover" draggable={false} />;
}

export function GeneratePane({
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
  initialPrompt,
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
  /** Pre-fill from a scene's unresolved b-roll hint. */
  initialPrompt?: { q: string; nonce: number };
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [prompt, setPrompt] = useState("");
  useEffect(() => {
    if (initialPrompt) setPrompt(initialPrompt.q);
  }, [initialPrompt]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<MediaAsset | null>(null);
  const image = providers?.image;
  const size = imageSizeForDoc(doc);

  const live = useJob(workspaceId, job?.id ?? null, {
    initial: job,
    onSettled: (j) => {
      if (j.status !== "succeeded") return;
      const id = (j.output?.data as { assetIds?: string[] } | undefined)?.assetIds?.[0];
      if (!id) return;
      void api
        .get<AssetResponse>(wsPath(workspaceId, `/assets/${id}`))
        .then((r) => {
          setResult(r.asset);
          void invalidate(wsPath(workspaceId, "/assets"));
        })
        .catch((e) => toast.error("Couldn't load the image", errorMessage(e)));
    },
  });

  const generate = async () => {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const r = await api.post<ImageGenerateResponse>(wsPath(workspaceId, "/images/generate"), { appId, campaignId, prompt: prompt.trim(), count: 1, size }, { idempotent: true });
      setJob(r.job);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const target = scene ? mediaTarget(scene, layer, isProductMedia) : null;
  const running = !!live.job && (live.job.status === "queued" || live.job.status === "running");

  if (!providers) return <Skeleton className="m-3 h-32" rounded="lg" />;
  if (image?.state !== "live") {
    return (
      <div className="p-3">
        <Notice tone="info" title="Image generation isn’t connected">
          <p>{image?.message ?? "Image generation isn’t available on this deployment."}</p>
          <p className="mt-1 text-caption">Set OPENAI_API_KEY on the server to enable it. Stock photos and your own uploads work without it.</p>
        </Notice>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <form
        className="space-y-3 border-b border-line px-3 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (prompt.trim().length >= 3 && !running) void generate();
        }}
      >
        <Field label="Describe the image" hint="Backgrounds, moods, people and places. Not your app’s screens: those always come from real screenshots." error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Textarea id={id} aria-describedby={describedBy} invalid={invalid} rows={3} value={prompt} maxLength={1000} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. a calm desk at golden hour with a cup of tea, soft focus" />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-1.5">
          <ProvenanceBadge kind="generated" label="AI-generated" detail={`${image.provider!.label} · ${image.provider!.model}`} />
          <span className="text-caption text-ink-3">
            {image.provider!.label} · {size.replace("x", "×")}
          </span>
        </div>
        <WorkspaceCostEstimate operation="media.image_generate" params={{ count: 1 }} />
        <Button type="submit" className="w-full" icon={<Sparkles className="size-4" aria-hidden />} loading={submitting} disabled={disabled || prompt.trim().length < 3 || running}>
          Generate image
        </Button>
        {image.provider!.museImage && !image.provider!.museImage.eligible ? <p className="text-caption text-ink-3">Muse Image isn’t used here ({image.provider!.museImage.reason}); {image.provider!.label} is the licensed alternative.</p> : null}
      </form>

      <div className="space-y-3 p-3">
        {live.job && !result ? <JobProgress job={live.job} title="Generating image" onCancel={() => void live.cancel()} onRetry={() => void live.retry().then((j) => j && setJob(j))} cancelling={live.cancelling} retrying={live.retrying} /> : null}
        {result ? (
          <div className="space-y-2">
            <Result workspaceId={workspaceId} asset={result} />
            <div className="flex items-center gap-1.5">
              <ProvenanceBadge kind="generated" label="AI-generated" detail={result.license?.provider} />
              <span className="truncate text-caption text-ink-3">{result.license?.provider}</span>
            </div>
            <Button
              size="sm"
              className="w-full"
              icon={<Plus className="size-3.5" aria-hidden />}
              disabled={disabled || !scene}
              onClick={() => {
                if (!scene || !target) return;
                const { ops, summary } = placeMediaOps(scene, target, result);
                onPatch(ops, summary);
              }}
            >
              {scene && target ? `${targetLabel(target, "image")} in ${scene.name}` : "Select a scene first"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
