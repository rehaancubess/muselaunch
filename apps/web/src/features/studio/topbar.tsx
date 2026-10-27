"use client";
import type { AspectRatio, Job } from "@muselaunch/contracts";
import {
  Badge,
  Button,
  CostEstimate,
  Dialog,
  IconButton,
  Input,
  JobProgress,
  Notice,
  Popover,
  SegmentedControl,
  Spinner,
  StatusPill,
  Switch,
  Tooltip,
  humanizeStatus,
  statusKindOf,
  useToast,
} from "@muselaunch/ui";
import { AlertTriangle, ChevronLeft, Download, History, Package, Redo2, Clapperboard, Undo2, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BrandGuardianBadge, BrandOverrideForm, brandBlockOf, type ReviewBrief } from "@/features/guardian";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { EstimateResponse, Page, SignedUrl } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useVersions } from "./use-studio";
import type { Composition, CompositionResponse, LintIssue, RenderResponse } from "./types";

const ASPECTS: AspectRatio[] = ["9:16", "1:1", "16:9", "4:5"];
const SOURCE_LABEL: Record<string, string> = { generated: "Generated", user_edit: "Your edit", ai_edit: "AI edit", revert: "Restored", duplicate: "Variant" };

function rel(iso: string) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

async function downloadAsset(workspaceId: string, assetId: string) {
  const { url } = await api.get<SignedUrl>(wsPath(workspaceId, `/assets/${assetId}/url`), { query: { download: 1 } });
  window.open(url, "_blank", "noopener");
}

function JobBlock({ workspaceId, job, onDone, title }: { workspaceId: string; job: Job; onDone?: (j: Job) => void; title?: string }) {
  const live = useJob(workspaceId, job.id, { initial: job, onSettled: onDone });
  return <JobProgress job={live.job ?? job} title={title} onCancel={() => void live.cancel()} onRetry={() => void live.retry()} cancelling={live.cancelling} retrying={live.retrying} />;
}

function RenderDialog({ workspaceId, base, data, onRendered }: { workspaceId: string; base: string; data: CompositionResponse; onRendered: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [quality, setQuality] = useState<"preview" | "final">("final");
  const [job, setJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Brand Guardian (module G): a blocked review of this version needs an override reason (logged).
  const [block, setBlock] = useState<ReviewBrief | null>(null);
  const errors = data.lint.filter((i) => i.level === "error");
  const isVideo = data.version.doc.kind === "video";
  const last = data.lastRender;
  const start = async (overrideReason?: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.post<RenderResponse>(`${base}/render`, { quality, version: data.composition.currentVersion, ...(overrideReason ? { override: { reason: overrideReason } } : {}) }, { idempotent: true });
      setBlock(null);
      setJob(r.job);
    } catch (e) {
      const b = brandBlockOf(e);
      if (b) setBlock(b);
      else setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setJob(null);
          setBlock(null);
        }
      }}
      trigger={
        <Button size="sm" icon={<Clapperboard className="size-4" aria-hidden />}>
          Render
        </Button>
      }
      title="Render video"
      description={`Version ${data.composition.currentVersion} · ${data.version.doc.aspectRatio} · ${Math.round(data.durationSec * 10) / 10}s`}
      footer={
        job || block ? (
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void start()} loading={submitting} disabled={quality === "final" && errors.length > 0}>
              {quality === "final" ? "Render final" : "Render preview"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {block && !job ? (
          <BrandOverrideForm block={block} actionLabel="render" busy={submitting} onOverride={(reason) => void start(reason)} onCancel={() => setOpen(false)} />
        ) : !job ? (
          <>
            <SegmentedControl<"preview" | "final">
              label="Quality"
              fullWidth
              value={quality}
              onChange={setQuality}
              items={[
                { value: "preview", label: "Quick preview" },
                { value: "final", label: isVideo ? `Final ${data.version.doc.width}×${data.version.doc.height}` : "Final images" },
              ]}
            />
            <p className="text-footnote text-ink-2">
              {quality === "preview" ? "Half-resolution MP4 for checking motion and timing." : isVideo ? "Full-quality H.264 MP4 rendered with HyperFrames, ready to publish." : "One PNG per slide at full resolution."}
            </p>
            {quality === "final" ? (
              <CostEstimate
                operation="render.final"
                params={{ durationSec: data.durationSec }}
                fetchEstimate={(req) => api.post<EstimateResponse>(wsPath(workspaceId, "/estimate"), req)}
                note="Charged per started 15 seconds. Unused credits return if the render fails or is cancelled; re-rendering an unchanged version is free."
              />
            ) : null}
            {quality === "final" ? <BrandGuardianBadge subject={{ entity: "compositions", id: data.composition.id }} version={data.composition.currentVersion} /> : null}
            {quality === "final" && errors.length ? (
              <Notice tone="danger" title={`Fix ${errors.length} issue${errors.length === 1 ? "" : "s"} first`}>
                <ul className="list-disc pl-4">
                  {errors.slice(0, 4).map((e, i) => (
                    <li key={i}>{e.message}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            {error ? <Notice tone="danger">{error}</Notice> : null}
          </>
        ) : (
          <JobBlock
            workspaceId={workspaceId}
            job={job}
            title={quality === "final" ? "Rendering final video" : "Rendering preview"}
            onDone={(j) => {
              onRendered();
              if (j.status === "succeeded") toast.success(quality === "final" ? "Final render ready" : "Preview render ready");
            }}
          />
        )}
        {last ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-mist px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-body-sm font-medium">
                Latest {last.quality} render · v{last.version}
              </p>
              <p className="text-caption text-ink-2">
                {last.asset.width && last.asset.height ? `${last.asset.width}×${last.asset.height} · ` : ""}
                {last.asset.durationSec ? `${Math.round(last.asset.durationSec * 10) / 10}s · ` : ""}
                {rel(last.at)}
              </p>
            </div>
            <Button size="sm" variant="secondary" icon={<Download className="size-4" aria-hidden />} onClick={() => last.assetId && downloadAsset(workspaceId, last.assetId).catch((e) => toast.error("Download failed", errorMessage(e)))}>
              Download
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function ExportDialog({ workspaceId, campaignId }: { workspaceId: string; campaignId: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [includeCopy, setIncludeCopy] = useState(true);
  const [job, setJob] = useState<Job | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.post<{ job: Job }>(wsPath(workspaceId, `/campaigns/${campaignId}/export`), { includeCopy }, { idempotent: true });
      setJob(r.job);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setJob(null);
          setAssetId(null);
        }
      }}
      trigger={
        <Button size="sm" variant="secondary" icon={<Package className="size-4" aria-hidden />}>
          Export
        </Button>
      }
      title="Export publishing package"
      description="A ZIP with the final videos, cover frames, captions (SRT), channel copy, posting instructions and media attributions. Nothing is posted for you."
      footer={
        assetId ? (
          <Button icon={<Download className="size-4" aria-hidden />} onClick={() => downloadAsset(workspaceId, assetId).catch((e) => toast.error("Download failed", errorMessage(e)))}>
            Download ZIP
          </Button>
        ) : job ? null : (
          <Button onClick={start} loading={submitting}>
            Build package
          </Button>
        )
      }
    >
      <div className="space-y-3">
        {!job ? (
          <div className="flex items-center justify-between">
            <span className="text-body-sm">Include captions and copy</span>
            <Switch checked={includeCopy} onCheckedChange={setIncludeCopy} label="Include copy" />
          </div>
        ) : (
          <JobBlock
            workspaceId={workspaceId}
            job={job}
            title="Packaging"
            onDone={(j) => {
              const id = j.output?.data?.assetId;
              if (j.status === "succeeded" && typeof id === "string") setAssetId(id);
            }}
          />
        )}
        <p className="text-footnote text-ink-2">Only final renders are included. Render each format you want to post first.</p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Dialog>
  );
}

function AudienceDialog({ workspaceId, appId, base }: { workspaceId: string; appId: string; base: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState(["", "", ""]);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<string[]>([]);
  const valid = targets.map((t) => t.trim()).filter(Boolean);
  const start = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.post<{ job: Job }>(`${base}/variants`, { mode: "audience", targets: valid }, { idempotent: true });
      setJob(r.job);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="ghost" icon={<Users className="size-4" aria-hidden />}>
          Audience versions
        </Button>
      }
      title="Make versions for different audiences"
      description="Each version is a copy of this video whose on-screen text Muse Spark adapts for that audience, using only verified claims. You review each change before applying it."
      footer={
        job ? null : (
          <Button onClick={start} loading={submitting} disabled={!valid.length}>
            Create {valid.length || ""} version{valid.length === 1 ? "" : "s"}
          </Button>
        )
      }
    >
      {!job ? (
        <div className="space-y-2">
          {targets.map((t, i) => (
            <Input key={i} value={t} placeholder={["e.g. Freelance designers juggling clients", "e.g. Students during exam season", "e.g. Remote engineering managers"][i]} onChange={(e) => setTargets(targets.map((x, k) => (k === i ? e.target.value : x)))} maxLength={200} aria-label={`Audience ${i + 1}`} />
          ))}
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </div>
      ) : (
        <div className="space-y-3">
          <JobBlock workspaceId={workspaceId} job={job} title="Creating versions" onDone={(j) => setCreated((j.output?.refs ?? []).filter((r) => r.entity === "compositions").map((r) => r.id))} />
          {created.length ? (
            <ul className="space-y-1.5">
              {created.map((id, i) => (
                <li key={id} className="flex items-center justify-between gap-2 rounded-md bg-mist px-3 py-2 text-body-sm">
                  <span className="truncate">{valid[i] ?? id}</span>
                  <Button size="sm" variant="secondary" onClick={() => router.push(routes.app(workspaceId, appId).studio(id))}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function AspectSwitch({ workspaceId, appId, base, composition }: { workspaceId: string; appId: string; base: string; composition: Composition }) {
  const router = useRouter();
  const toast = useToast();
  const rootId = composition.derivedFromCompositionId ?? composition.id;
  const siblings = useApiQuery<Page<Composition>>(wsPath(workspaceId, "/compositions"), { query: composition.campaignId ? { campaignId: composition.campaignId } : { appId } });
  const [pending, setPending] = useState<{ ar: AspectRatio; job: Job } | null>(null);
  const family = (siblings.data?.items ?? []).filter((c) => c.id === rootId || c.derivedFromCompositionId === rootId);
  const byAspect = new Map<string, Composition>();
  for (const c of [...family].sort((a, b) => (a.id === rootId ? -1 : b.id === rootId ? 1 : 0))) if (!byAspect.has(c.aspectRatio)) byAspect.set(c.aspectRatio, c);
  byAspect.set(composition.aspectRatio, composition);
  const go = async (ar: AspectRatio) => {
    const existing = byAspect.get(ar);
    if (existing) {
      if (existing.id !== composition.id) router.push(routes.app(workspaceId, appId).studio(existing.id));
      return;
    }
    try {
      const sourceBase = rootId === composition.id ? base : wsPath(workspaceId, `/compositions/${rootId}`);
      const r = await api.post<{ job: Job }>(`${sourceBase}/variants`, { mode: "aspect", targets: [ar] }, { idempotent: true });
      setPending({ ar, job: r.job });
    } catch (e) {
      toast.error("Couldn't create that format", errorMessage(e));
    }
  };
  return (
    <div className="flex items-center gap-2">
      <SegmentedControl<AspectRatio>
        label="Format"
        size="sm"
        value={composition.aspectRatio}
        onChange={(v) => void go(v)}
        items={ASPECTS.map((ar) => ({ value: ar, label: byAspect.has(ar) ? ar : <span className="text-ink-3">{ar}</span> }))}
      />
      {pending ? (
        <PendingVariant
          workspaceId={workspaceId}
          job={pending.job}
          onDone={(j) => {
            const id = (j.output?.refs ?? []).find((r) => r.entity === "compositions")?.id;
            setPending(null);
            void siblings.refetch();
            if (j.status === "succeeded" && id) router.push(routes.app(workspaceId, appId).studio(id));
            else if (j.status !== "succeeded") toast.error("Couldn't create that format", j.error?.userMessage ?? j.error?.message);
          }}
        />
      ) : null}
    </div>
  );
}

function PendingVariant({ workspaceId, job, onDone }: { workspaceId: string; job: Job; onDone: (j: Job) => void }) {
  useJob(workspaceId, job.id, { initial: job, onSettled: onDone });
  return (
    <span className="flex items-center gap-1.5 text-footnote text-ink-2">
      <Spinner size={14} /> Re-laying out…
    </span>
  );
}

function VersionsPopover({ base, current, onRestore }: { base: string; current: number; onRestore: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  const versions = useVersions(base, open);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label="Version history"
      className="w-80 p-0"
      trigger={
        <IconButton label="Version history">
          <History className="size-[18px]" aria-hidden />
        </IconButton>
      }
    >
      <div className="border-b border-line px-4 py-3 text-body-sm font-semibold">Versions</div>
      <ul className="max-h-[60dvh] overflow-y-auto py-1">
        {versions.isLoading ? (
          <li className="px-4 py-3">
            <Spinner />
          </li>
        ) : (
          versions.data?.items.map((v) => (
            <li key={v.id} className="flex items-start justify-between gap-2 px-4 py-2.5 hover:bg-mist">
              <div className="min-w-0">
                <p className="text-body-sm font-medium">
                  v{v.version} <span className="font-normal text-ink-2">· {SOURCE_LABEL[v.source] ?? v.source}</span>
                </p>
                <p className="truncate text-caption text-ink-2">{v.summary}</p>
                <p className="text-caption text-ink-3">{rel(v.createdAt)}</p>
              </div>
              {v.version === current ? (
                <Badge tone="accent">Current</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onRestore(v.version);
                    setOpen(false);
                  }}
                >
                  Restore
                </Button>
              )}
            </li>
          ))
        )}
      </ul>
    </Popover>
  );
}

function IssuesPopover({ lint, onSelect }: { lint: LintIssue[]; onSelect: (i: LintIssue) => void }) {
  const errors = lint.filter((i) => i.level === "error").length;
  if (!lint.length) return null;
  return (
    <Popover
      align="end"
      label="Issues"
      className="w-80 p-0"
      trigger={
        <Button size="sm" variant="ghost" icon={<AlertTriangle className={errors ? "size-4 text-danger" : "size-4 text-warning"} aria-hidden />}>
          {lint.length}
        </Button>
      }
    >
      <div className="border-b border-line px-4 py-3 text-body-sm font-semibold">
        {errors ? `${errors} must be fixed before the final render` : "Suggestions"}
      </div>
      <ul className="max-h-[60dvh] overflow-y-auto py-1">
        {lint.map((i, k) => (
          <li key={k}>
            <button type="button" className="flex w-full gap-2 px-4 py-2 text-left text-footnote hover:bg-mist" onClick={() => onSelect(i)}>
              <span className={i.level === "error" ? "mt-1 size-1.5 shrink-0 rounded-full bg-danger" : "mt-1 size-1.5 shrink-0 rounded-full bg-warning"} />
              <span>{i.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

export function StudioTopbar({
  workspaceId,
  appId,
  base,
  data,
  saving,
  onUndo,
  onRedo,
  onRestore,
  onRendered,
  onSelectIssue,
}: {
  workspaceId: string;
  appId: string;
  base: string;
  data: CompositionResponse;
  saving: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onRestore: (v: number) => void;
  onRendered: () => void;
  onSelectIssue: (i: LintIssue) => void;
}) {
  const c = data.composition;
  const back = c.campaignId ? routes.app(workspaceId, appId).campaign(c.campaignId) : routes.app(workspaceId, appId).creator;
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2">
      <Link href={back} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-footnote text-ink-2 hover:bg-mist hover:text-ink">
        <ChevronLeft className="size-4" aria-hidden /> {c.campaignId ? "Campaign" : "Creator"}
      </Link>
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-headline font-semibold">{c.title}</h1>
        <StatusPill status={statusKindOf(c.status)}>{humanizeStatus(c.status)}</StatusPill>
        <span className="tabular text-footnote text-ink-3">v{c.currentVersion}</span>
        {saving ? <Spinner size={14} label="Saving" /> : null}
      </div>
      <div className="flex flex-1 flex-wrap items-center justify-end gap-1.5">
        <AspectSwitch workspaceId={workspaceId} appId={appId} base={base} composition={c} />
        <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden />
        <Tooltip content="Undo (⌘Z)">
          <IconButton label="Undo" onClick={onUndo} disabled={data.version.parentVersion === null || saving}>
            <Undo2 className="size-[18px]" aria-hidden />
          </IconButton>
        </Tooltip>
        <Tooltip content="Redo (⇧⌘Z)">
          <IconButton label="Redo" onClick={onRedo} disabled={!c.redoStack.length || saving}>
            <Redo2 className="size-[18px]" aria-hidden />
          </IconButton>
        </Tooltip>
        <VersionsPopover base={base} current={c.currentVersion} onRestore={onRestore} />
        <IssuesPopover lint={data.lint} onSelect={onSelectIssue} />
        <AudienceDialog workspaceId={workspaceId} appId={appId} base={base} />
        {c.campaignId ? <ExportDialog workspaceId={workspaceId} campaignId={c.campaignId} /> : null}
        <RenderDialog workspaceId={workspaceId} base={base} data={data} onRendered={onRendered} />
      </div>
    </header>
  );
}
