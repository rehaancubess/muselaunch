"use client";
/**
 * "Clip" tab: clip intelligence for the Studio. Pick a founder clip, analyse it with SAM 3.1 (module
 * D's ClipAnalyzer), then apply object-aware effects to the selected scene in one click. Effects are
 * plain PatchOps on the composition (undoable versions), never re-generated videos.
 */
import type { ClipAnalysis } from "@muselaunch/contracts";
import { Badge, Button, Dialog, EmptyState, ErrorState, Skeleton, Spinner, Switch, cn } from "@muselaunch/ui";
import { Focus, Layers, MonitorSmartphone, ScanSearch, Smartphone, Sparkles, SunMedium, Video } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { ClipAnalyzer, OBJECT_COLORS, qualityOf } from "@/features/media";
import { ONE_CLICK, clipObjects, isHand, isPerson, isPhone, oneClickOps, type ClipItem, type ClipObject, type OneClick } from "./clips";
import type { CompositionDoc, MediaAsset, PatchOp, Scene } from "./types";

const ICONS: Record<OneClick, ReactNode> = {
  "app-behind": <Layers className="size-4" aria-hidden />,
  "spotlight-phone": <Focus className="size-4" aria-hidden />,
  "app-on-phone": <MonitorSmartphone className="size-4" aria-hidden />,
  "glow-me": <SunMedium className="size-4" aria-hidden />,
  "blur-bg": <Sparkles className="size-4" aria-hidden />,
};

const clipName = (a: MediaAsset) => a.title ?? a.originalFilename ?? "Founder clip";
const analysed = (a: ClipAnalysis | null) => !!a && (a.status === "succeeded" || a.status === "partial");

export function objectColor(objects: ClipObject[], o: ClipObject): string {
  const i = objects.findIndex((x) => x.segmentationId === o.segmentationId && x.objectId === o.objectId);
  return OBJECT_COLORS[(i < 0 ? 0 : i) % OBJECT_COLORS.length]!;
}

/** The clip shown in the scene, else the first analysed clip, else the first clip. */
export function defaultClip(items: ClipItem[], scene: Scene | null): ClipItem | undefined {
  const inScene = scene ? items.find((i) => scene.layers.some((l) => l.type === "video" && l.assetId === i.asset.id)) : undefined;
  return inScene ?? items.find((i) => analysed(i.analysis)) ?? items[0];
}

export function ClipPanel({
  doc,
  scene,
  items,
  loading,
  error,
  onRetry,
  demo,
  overlay,
  onOverlay,
  onPatch,
  onAnalysed,
  disabled,
}: {
  doc: CompositionDoc;
  scene: Scene | null;
  items: ClipItem[] | undefined;
  loading: boolean;
  error?: string | null;
  onRetry: () => void;
  demo: MediaAsset | undefined;
  overlay: boolean;
  onOverlay: (v: boolean) => void;
  onPatch: (ops: PatchOp[], summary: string) => void;
  onAnalysed: (a: ClipAnalysis) => void;
  disabled?: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const list = items ?? [];
  const current = list.find((i) => i.asset.id === picked) ?? defaultClip(list, scene);
  const objects = useMemo(() => clipObjects(current ? [current] : []), [current]);
  const all = useMemo(() => clipObjects(list), [list]);
  const targets = useMemo(() => ({ person: objects.find(isPerson), phone: objects.find(isPhone), hand: objects.find(isHand) }), [objects]);

  if (loading && !items) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-16 w-full" rounded="lg" />
        <Skeleton className="h-40 w-full" rounded="lg" />
      </div>
    );
  }
  if (error) return <ErrorState className="m-4" message={error} onRetry={onRetry} />;

  const missing = (needs: (typeof ONE_CLICK)[number]["needs"]): string | null => {
    if (!scene) return "Select a scene first.";
    if (!current || !analysed(current.analysis)) return "Analyse a clip first.";
    if (needs.includes("person") && !targets.person) return "Needs a tracked person in the clip.";
    if (needs.includes("phone") && !targets.phone) return "Needs a tracked phone in the clip.";
    if (needs.includes("demo") && !demo) return "Needs a real app recording or screenshot in Media.";
    return null;
  };
  const apply = (kind: OneClick, label: string) => {
    if (!scene) return;
    const ops = oneClickOps(kind, doc, scene, targets, demo);
    if (ops?.length) onPatch(ops, `${label} (${scene.name})`);
  };

  return (
    <div className="space-y-5 px-4 py-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-body-sm font-semibold text-ink">
          <ScanSearch className="size-4 text-accent" aria-hidden /> Clip intelligence
        </div>
        <p className="text-footnote text-ink-2">SAM 3.1 tracks you and your phone through real footage, so effects and labels follow them frame by frame.</p>
      </header>

      {!list.length ? (
        <EmptyState
          size="sm"
          icon={<Video aria-hidden />}
          title="No founder clip yet"
          description="Upload a clip of you talking about your app in Media and mark it as a founder clip. Analyse it here to unlock object-aware effects."
        />
      ) : (
        <section className="space-y-2" aria-label="Clips">
          <p className="text-caption font-semibold uppercase tracking-wide text-ink-3">Clips</p>
          <ul className="space-y-1.5">
            {list.map((it) => {
              const a = it.analysis;
              const sel = current?.asset.id === it.asset.id;
              const running = a && (a.status === "queued" || a.status === "running");
              return (
                <li key={it.asset.id}>
                  <div className={cn("flex items-center gap-3 rounded-lg border p-2 transition-colors", sel ? "border-accent bg-accent-soft/40" : "border-line hover:border-line-strong")}>
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setPicked(it.asset.id)} aria-pressed={sel}>
                      <span className="relative h-14 w-10 shrink-0 overflow-hidden rounded-md bg-ink">
                        {it.posterUrl ? <img src={it.posterUrl} alt="" className="size-full object-cover" /> : it.url ? <video src={`${it.url}#t=0.5`} preload="metadata" muted playsInline className="size-full object-cover" aria-hidden /> : null}
                      </span>
                      <span className="min-w-0 space-y-0.5">
                        <span className="block truncate text-body-sm font-medium text-ink">{clipName(it.asset)}</span>
                        <span className="flex flex-wrap items-center gap-1">
                          {it.asset.durationSec ? <span className="tabular text-caption text-ink-3">{it.asset.durationSec.toFixed(1)}s</span> : null}
                          {it.usedInDoc ? <Badge tone="outline">In this video</Badge> : null}
                          {analysed(a) ? <Badge tone="success">{a!.objects.length} tracked</Badge> : running ? <Badge tone="accent">Analysing…</Badge> : a?.status === "failed" ? <Badge tone="danger">Failed</Badge> : <Badge>Not analysed</Badge>}
                        </span>
                      </span>
                    </button>
                    {running ? <Spinner size={14} label="Analysing" /> : null}
                    <Button size="sm" variant={analysed(a) ? "ghost" : "secondary"} onClick={() => setAnalyzing(it.asset.id)} disabled={disabled}>
                      {analysed(a) ? "Details" : a?.status === "failed" ? "Retry" : running ? "View" : "Analyse"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {objects.length ? (
        <section className="space-y-2" aria-label="Tracked objects">
          <div className="flex items-center justify-between gap-2">
            <p className="text-caption font-semibold uppercase tracking-wide text-ink-3">Tracked objects</p>
            <label className="flex items-center gap-2 text-footnote text-ink-2">
              Show on preview
              <Switch checked={overlay} onCheckedChange={onOverlay} label="Show tracking on preview" />
            </label>
          </div>
          <ul className="space-y-1">
            {objects.map((o) => {
              const q = qualityOf(o.quality ?? undefined);
              return (
                <li key={`${o.segmentationId}:${o.objectId}`} className="flex items-center gap-2 rounded-md px-1.5 py-1">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: objectColor(all, o) }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{o.label}</span>
                  {!o.hasCutout ? <Badge tone="outline">No cutout</Badge> : null}
                  <Badge tone={q.tone === "neutral" ? "neutral" : q.tone}>{q.label.replace("Tracking ", "")}</Badge>
                </li>
              );
            })}
          </ul>
          {objects.some((o) => o.quality !== null && o.quality < 0.5) ? <p className="text-caption text-ink-3">Effects on low-quality tracks fall back to fixed positions or unmasked footage.</p> : null}
        </section>
      ) : null}

      <section className="space-y-2" aria-label="One-click effects">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-caption font-semibold uppercase tracking-wide text-ink-3">One-click effects</p>
          {scene ? <span className="truncate text-caption text-ink-3">on {scene.name}</span> : null}
        </div>
        <ul className="space-y-1.5">
          {ONE_CLICK.map((e) => {
            const why = missing(e.needs);
            return (
              <li key={e.id}>
                <button
                  type="button"
                  disabled={disabled || !!why}
                  onClick={() => apply(e.id, e.label)}
                  className="group flex w-full items-start gap-3 rounded-lg border border-line px-3 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft/30 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-line disabled:hover:bg-transparent"
                >
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">{ICONS[e.id]}</span>
                  <span className="min-w-0">
                    <span className="block text-body-sm font-medium text-ink">{e.label}</span>
                    <span className="block text-caption text-ink-3">{why ?? e.hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="flex items-start gap-1.5 text-caption text-ink-3">
          <Smartphone className="mt-px size-3.5 shrink-0" aria-hidden />
          Only your real recordings and screenshots appear on screens. Every effect is a normal edit you can tweak, undo or remove.
        </p>
      </section>

      <Dialog open={!!analyzing} onOpenChange={(o) => !o && setAnalyzing(null)} size="xl" title="Analyse clip" description="Track people and objects through this clip. Effects use the tracks and cutouts it produces.">
        {analyzing ? (
          <ClipAnalyzer
            assetId={analyzing}
            onAnalysis={(a) => {
              setPicked(a.sourceAssetId);
              setAnalyzing(null);
              onAnalysed(a);
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
