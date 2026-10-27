"use client";
/**
 * "Create 3 hooks": composition.variants mode "hooks" copies this video N times and runs a scoped,
 * auto-applied Spark edit on each copy's opening scene (with the clip's tracked objects as context).
 * The results play side by side; every other scene stays identical.
 */
import type { Composition, Job } from "@muselaunch/contracts";
import { Badge, Button, CostEstimateView, Dialog, JobProgress, Notice, SegmentedControl, Textarea, type EstimateResult } from "@muselaunch/ui";
import { ArrowUpRight, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { fetchEstimate } from "@/lib/estimate";
import { useJob } from "@/lib/jobs";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { PreviewPlayer } from "./preview";
import type { CompositionResponse } from "./types";
import { usePreview } from "./use-studio";

interface HookRef {
  compositionId: string;
  brief?: string;
  jobId?: string;
}

const HOOK_TITLE = / — Hook (\d+)$/;
const HOOKS_EVENT = "ml:studio-hooks";

/** Open the hooks dialog preset to `count` directed hooks (e.g. after "…and create three hooks"). The user still confirms the cost. */
export function requestHooks(count = 3) {
  window.dispatchEvent(new CustomEvent(HOOKS_EVENT, { detail: { count: Math.min(5, Math.max(1, Math.round(count))) } }));
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const COUNTED = /\b([1-5]|one|two|three|four|five)\s+(?:different\s+|new\s+|more\s+|alternative\s+|other\s+)*(?:opening\s+)?hooks?\b/i;
const PLURAL = /\b(?:create|make|give|generate|try|write|produce|build)\b[^.]{0,40}\bhooks\b/i;

/** "…and create three different hooks" → 3; null when the instruction doesn't ask for hook versions ("make the hook punchier"). */
export function hooksAskedFor(instruction: string): number | null {
  const m = COUNTED.exec(instruction);
  if (m) return WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
  return PLURAL.test(instruction) ? 3 : null;
}

function HookCard({ workspaceId, appId, hook, index }: { workspaceId: string; appId: string; hook: HookRef; index: number }) {
  const router = useRouter();
  const base = wsPath(workspaceId, `/compositions/${hook.compositionId}`);
  const comp = useApiQuery<CompositionResponse>(base, { staleTime: 10_000 });
  const live = useJob(workspaceId, hook.jobId ?? null, { onSettled: () => void comp.refetch() });
  const version = comp.data?.composition.currentVersion;
  const preview = usePreview(base, version);
  const job = live.job;
  const running = job && (job.status === "queued" || job.status === "running");
  const notConnected = job?.status === "failed" && job.error?.code === "PROVIDER_NOT_CONFIGURED";
  const edited = (version ?? 1) > 1;
  return (
    <li className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-body-sm font-semibold text-ink">Hook {index + 1}</p>
          {hook.brief ? <p className="line-clamp-2 text-caption text-ink-2">{hook.brief}</p> : null}
        </div>
        {edited ? <Badge tone="success">New opening</Badge> : running ? <Badge tone="accent">Directing…</Badge> : null}
      </div>
      <div className="h-[340px] rounded-lg bg-mist p-2">
        {running && !edited ? (
          <div className="flex h-full flex-col justify-center gap-3 px-2">
            <JobProgress job={job} variant="row" title="Muse Spark is writing this hook" onCancel={() => void live.cancel()} cancelling={live.cancelling} />
          </div>
        ) : (
          <PreviewPlayer compact html={preview.data?.html} width={comp.data?.version.doc.width ?? 1080} height={comp.data?.version.doc.height ?? 1920} durationSec={comp.data?.durationSec ?? 0} posterSec={preview.data?.posterSec} loading={preview.isLoading || comp.isLoading} error={preview.error?.userMessage} onRetry={() => preview.refetch()} />
        )}
      </div>
      {notConnected ? (
        <Notice tone="neutral">AI editing isn&apos;t connected on this deployment, so this copy still has the original opening.</Notice>
      ) : job?.status === "failed" ? (
        <Notice tone="danger">The hook edit failed: {job.error?.message ?? "unknown error"}. The copy keeps the original opening.</Notice>
      ) : null}
      <Button size="sm" variant="secondary" icon={<ArrowUpRight className="size-4" aria-hidden />} onClick={() => router.push(routes.app(workspaceId, appId).studio(hook.compositionId))}>
        Open in Studio
      </Button>
    </li>
  );
}

export function HooksDialog({ workspaceId, appId, base, composition }: { workspaceId: string; appId: string; base: string; composition: Composition }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"auto" | "custom">("auto");
  const [autoCount, setAutoCount] = useState(3);
  const [briefs, setBriefs] = useState(["", "", ""]);
  const [job, setJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const listPath = wsPath(workspaceId, "/compositions");
  const siblings = useApiQuery<Page<Composition>>(open ? listPath : null, { query: composition.campaignId ? { campaignId: composition.campaignId } : { appId } });
  const live = useJob(workspaceId, job?.id ?? null, { initial: job, onSettled: () => void siblings.refetch() });
  const custom = briefs.map((b) => b.trim()).filter(Boolean);
  const count = mode === "auto" ? autoCount : custom.length;

  useEffect(() => {
    const on = (e: Event) => {
      const n = (e as CustomEvent<{ count: number }>).detail?.count ?? 3;
      setMode("auto");
      setAutoCount(n);
      setJob(null);
      setError(null);
      setOpen(true);
    };
    window.addEventListener(HOOKS_EVENT, on);
    return () => window.removeEventListener(HOOKS_EVENT, on);
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchEstimate(workspaceId, { operation: "composition.edit", params: {} })
      .then((e) => alive && setEstimate(e))
      .catch(() => alive && setEstimate(null));
    return () => {
      alive = false;
    };
  }, [open, workspaceId]);

  const created: HookRef[] = useMemo(() => {
    const data = live.job?.output?.data as { hooks?: { compositionId: string; brief: string; jobId: string }[] } | undefined;
    return data?.hooks ?? [];
  }, [live.job]);
  const existing: HookRef[] = useMemo(
    () =>
      (siblings.data?.items ?? [])
        .filter((c) => c.derivedFromCompositionId === composition.id && HOOK_TITLE.test(c.title))
        .sort((a, b) => Number(HOOK_TITLE.exec(a.title)?.[1]) - Number(HOOK_TITLE.exec(b.title)?.[1]))
        .map((c) => ({ compositionId: c.id })),
    [siblings.data, composition.id],
  );
  const shown = created.length ? created : job ? [] : existing;

  const start = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.post<{ job: Job }>(`${base}/variants`, { mode: "hooks", targets: mode === "auto" ? [String(autoCount)] : custom }, { idempotent: true });
      setJob(r.job);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };
  const per = estimate?.credits ?? 0;
  const total: EstimateResult | null = estimate ? { credits: per * count, breakdown: [{ label: `${count} hook${count === 1 ? "" : "s"} × Muse Spark edit`, credits: per * count }], available: estimate.available } : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setJob(null);
          setError(null);
        }
      }}
      size="xl"
      trigger={
        <Button size="sm" variant="ghost" icon={<Zap className="size-4" aria-hidden />}>
          Hooks
        </Button>
      }
      title="Try different hooks"
      description="Muse makes copies of this video and directs a new opening scene for each, using your clip's tracked objects. Everything after the opening stays exactly the same."
      footer={
        job && live.job?.status !== "failed" ? null : (
          <>
            {shown.length ? <span className="mr-auto text-caption text-ink-3">Creating again with the same briefs reuses these copies.</span> : null}
            <Button onClick={start} loading={submitting} disabled={!count || (total ? total.credits > total.available : false)} icon={<Zap className="size-4" aria-hidden />}>
              Create {count || ""} hook{count === 1 ? "" : "s"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-5">
        {!job ? (
          <div className="space-y-3">
            <SegmentedControl<"auto" | "custom">
              label="Hook briefs"
              size="sm"
              value={mode}
              onChange={setMode}
              items={[
                { value: "auto", label: `${autoCount} directed hook${autoCount === 1 ? "" : "s"}` },
                { value: "custom", label: "Write my own" },
              ]}
            />
            {mode === "auto" ? (
              <p className="text-footnote text-ink-2">Proven hook styles (outcome first, a sharp question, a pattern interrupt…), one per copy, written from your verified claims.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-3">
                {briefs.map((b, i) => (
                  <Textarea
                    key={i}
                    rows={3}
                    value={b}
                    maxLength={300}
                    placeholder={["e.g. Start mid-action: my phone buzzing with 12 reminders", "e.g. Ask: what if your day planned itself?", "e.g. Show the finished week view first"][i]}
                    onChange={(e) => setBriefs(briefs.map((x, k) => (k === i ? e.target.value : x)))}
                    aria-label={`Hook brief ${i + 1}`}
                  />
                ))}
              </div>
            )}
            <CostEstimateView estimate={total} loading={open && !estimate} note="Charged per hook. Unused credits return if an edit fails." />
            {error ? <Notice tone="danger">{error}</Notice> : null}
          </div>
        ) : live.job && live.job.status !== "succeeded" ? (
          <JobProgress job={live.job} title="Creating hook copies" onCancel={() => void live.cancel()} onRetry={() => void live.retry()} cancelling={live.cancelling} retrying={live.retrying} />
        ) : null}
        {shown.length ? (
          <section className="space-y-2" aria-label="Hooks">
            {!created.length ? <p className="text-caption font-semibold uppercase tracking-wide text-ink-3">Your hooks</p> : null}
            <ul className="grid gap-3 sm:grid-cols-3">
              {shown.map((h, i) => (
                <HookCard key={h.compositionId} workspaceId={workspaceId} appId={appId} hook={h} index={i} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
