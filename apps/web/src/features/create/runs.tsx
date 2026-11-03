"use client";
/**
 * Create runs: the videos "Generate video" started (campaigns with origin "create"), where each one
 * stands (plan.ts runView, from stored records only) and the steps Create takes for the person who
 * started it, the same calls they'd make on the campaign page:
 *
 *   ideas ready   → select the best-fitting idea, POST /campaigns/:id/variants/:vid/produce
 *                   (the chosen format and length) → plan → editable video → preview (existing jobs)
 *   preview ready → POST /compositions/:id/render { quality: "final" } (the route checks facts and
 *                   the brand first, then queues the final render)
 *
 * Nothing else happens on its own: a step that needs a decision (not enough credits, a plan limit,
 * the brand check, a fix, a final video that costs more than shown) waits for the person, a run left
 * for a day doesn't carry on by itself, and nothing is ever posted. Keys are deterministic, so two
 * tabs never start the same step twice. Mounted by the app layout (CreateRunner) so a video keeps
 * moving while the person looks at Home or Results, and by the Create page to show it.
 */
import type { Campaign, Job, MediaAsset } from "@muselaunch/contracts";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ApiError, api, wsPath } from "@/lib/api";
import type { CampaignDetailResponse, EstimateResponse, Page } from "@/lib/api-types";
import { keyFor, useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { RUN_STALE_MS, isWait, overspend, problemFromError, runSettings, runView, type ActionProblem, type NextStep, type RunView } from "./plan";

/** Create runs followed closely (older ones live on Make → Campaigns and Videos). */
const FOLLOW_MS = 7 * 86_400_000;
const MAX_FOLLOWED = 6;
/** A short wait before a step that hit a passing problem (busy brand check, too many tasks) runs again. */
const WAIT_MS = 8_000;

// ---------------------------------------------------------------------------
// What Create is doing for each run (shared by every mounted hook in this tab)
// ---------------------------------------------------------------------------

type Slot = {
  busy: NextStep["kind"] | null;
  problem: ActionProblem | null;
  at: number;
  /** The last step that went through (until the records show it, it isn't sent again). */
  sent?: string;
  /** The person OK'd a final video that costs more than shown (composition:version). */
  approvedSpend?: string;
  /** The person's reason to finish past a blocked brand check (for that composition:version only). */
  override?: { key: string; reason: string };
};
/** How long a step that went through isn't sent again while the records catch up. */
const SENT_MS = 20_000;
const stepKey = (n: NextStep) => (n.kind === "produce" ? `produce:${n.variantId}` : `final:${n.compositionId}:v${n.version}`);
const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version += 1;
  for (const l of listeners) l();
};
const slot = (id: string): Slot => slots.get(id) ?? { busy: null, problem: null, at: 0 };
const setSlot = (id: string, patch: Partial<Slot>) => {
  slots.set(id, { ...slot(id), ...patch });
  emit();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => version;

function toProblem(e: unknown): ActionProblem {
  if (e instanceof ApiError) return problemFromError({ status: e.status, code: e.code, userMessage: e.userMessage, message: e.message, details: e.details });
  return { kind: "error", message: e instanceof Error ? e.message : "That didn’t work." };
}

export interface CreateRun {
  campaign: Campaign;
  view: RunView;
  /** The step Create is taking right now. */
  busy: NextStep["kind"] | null;
  /** What the last step needs from the person (or a short wait). */
  problem: ActionProblem | null;
  /** Started by the signed-in person (Create only moves their own runs along). */
  mine: boolean;
}

export interface CreateRunsState {
  runs: CreateRun[];
  loading: boolean;
  /** Take the run's next step now (Continue, Finish it, Go ahead with a reason). */
  continueRun: (run: CreateRun, opts?: { approveSpend?: boolean; overrideReason?: string }) => Promise<void>;
  /** Run a failed job again (POST /jobs/:id/retry). */
  retry: (run: CreateRun, jobId: string) => Promise<void>;
  /** Forget a problem (e.g. after adding credits) so the step is tried again. */
  clear: (campaignId: string) => void;
}

export function useCreateRuns(appId: string, opts: { act: boolean }): CreateRunsState {
  const { workspaceId, can, member } = useWorkspace();
  const invalidate = useInvalidate();
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const canWrite = can("content.write");

  const list = useApiQuery<Page<Campaign>>(appId ? wsPath(workspaceId, `/apps/${appId}/campaigns`) : null, { staleTime: 20_000 });
  const followed = useMemo(() => {
    const now = Date.now();
    return (list.data?.items ?? []).filter((c) => c.origin === "create" && c.status !== "archived" && now - Date.parse(c.createdAt) < FOLLOW_MS).slice(0, MAX_FOLLOWED);
  }, [list.data]);

  const [jobsQ, finalsQ] = [
    useApiQuery<Page<Job>>(followed.length ? wsPath(workspaceId, "/jobs") : null, {
      query: { appId, limit: 100 },
      refetchInterval: (q) => ((q.state.data?.items ?? []).some((j) => j.status === "queued" || j.status === "running") ? 3_000 : 20_000),
    }),
    useApiQuery<Page<MediaAsset>>(followed.length ? wsPath(workspaceId, "/assets") : null, { query: { appId, role: "render", limit: 60 } }),
  ];
  const jobs = useMemo(() => jobsQ.data?.items ?? [], [jobsQ.data]);
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");

  const details = useQueries({
    queries: followed.map((c) => {
      const path = wsPath(workspaceId, `/campaigns/${c.id}`);
      return {
        queryKey: keyFor(path),
        queryFn: ({ signal }: { signal: AbortSignal }) => api.get<CampaignDetailResponse>(path, { signal }),
        // Closely while the video is being made (the next step follows its records); rarely once it's finished or left.
        refetchInterval: (q: { state: { data?: CampaignDetailResponse } }) => {
          const d = q.state.data;
          const finished = d?.compositions.some((x) => x.lastRender?.quality === "final");
          return finished || Date.now() - Date.parse(c.createdAt) > RUN_STALE_MS ? 60_000 : active || !d ? 3_000 : 5_000;
        },
        staleTime: 2_000,
      };
    }),
  });

  const runs = useMemo<CreateRun[]>(() => {
    const now = Date.now();
    const footageBusy = jobs.some((j) => (j.type === "media.extract_ui" || j.type === "media.analyze_recording") && (j.status === "queued" || j.status === "running"));
    const out: CreateRun[] = [];
    followed.forEach((c, i) => {
      const d = details[i]?.data;
      if (!d) return;
      const view = runView({ campaign: d.campaign, variants: d.variants, compositions: d.compositions, jobs, finals: finalsQ.data?.items ?? [], footageBusy, now });
      const s = slot(c.id);
      out.push({ campaign: d.campaign, view, busy: s.busy, problem: s.problem, mine: Boolean(member && d.campaign.createdBy === member.userId) });
    });
    return out;
    // `version` (the slots) is read through slot(); re-derive when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followed, details.map((q) => q.dataUpdatedAt).join(","), jobs, finalsQ.data, member, version]);

  // useInvalidate returns a new function each render: keep the latest without re-creating the steps.
  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;
  const refresh = useCallback(
    (campaignId: string) => invalidateRef.current(wsPath(workspaceId, `/campaigns/${campaignId}`), wsPath(workspaceId, "/jobs"), wsPath(workspaceId, `/apps/${appId}/campaigns`)),
    [workspaceId, appId],
  );

  /** One step for one run: on its own (the person's runs) or when the person presses Continue / Finish it. */
  const step = useCallback(
    async (run: CreateRun, o: { approveSpend?: boolean; overrideReason?: string } = {}) => {
      const next = run.view.next;
      const id = run.campaign.id;
      if (!next || slot(id).busy) return;
      setSlot(id, { busy: next.kind, problem: null, at: Date.now() });
      try {
        if (next.kind === "produce") {
          const base = wsPath(workspaceId, `/campaigns/${id}/variants/${next.variantId}`);
          if (next.select) await api.post(`${base}/select`);
          await api.post(`${base}/produce`, { aspectRatio: next.aspectRatio, ...(next.targetDurationSec ? { targetDurationSec: next.targetDurationSec } : {}) }, { idempotencyKey: `create-produce-${id}` });
        } else {
          const comp = wsPath(workspaceId, `/compositions/${next.compositionId}`);
          const key = `${next.compositionId}:v${next.version}`;
          if (o.overrideReason) setSlot(id, { override: { key, reason: o.overrideReason } });
          const reason = slot(id).override?.key === key ? slot(id).override!.reason : undefined;
          if (!o.approveSpend && slot(id).approvedSpend !== key) {
            // The final render is priced on the video's real length: ask first if that's more than shown.
            const { durationSec } = await api.get<{ durationSec: number }>(comp);
            const chosen = runSettings(run.campaign).lengthSec;
            const [actual, shown] = await Promise.all([
              api.post<EstimateResponse>(wsPath(workspaceId, "/estimate"), { operation: "render.final", params: { durationSec } }),
              chosen ? api.post<EstimateResponse>(wsPath(workspaceId, "/estimate"), { operation: "render.final", params: { durationSec: chosen } }) : Promise.resolve(null),
            ]);
            const over = overspend(actual.credits, shown?.credits);
            if (over) {
              setSlot(id, { busy: null, problem: { kind: "spend", ...over }, at: Date.now() });
              return;
            }
          } else setSlot(id, { approvedSpend: key });
          await api.post(`${comp}/render`, { quality: "final", version: next.version, ...(reason ? { override: { reason } } : {}) }, { idempotencyKey: `create-final-${next.compositionId}-v${next.version}` });
        }
        setSlot(id, { busy: null, problem: null, at: Date.now(), sent: stepKey(next) });
      } catch (e) {
        setSlot(id, { busy: null, problem: toProblem(e), at: Date.now() });
      } finally {
        await refresh(id);
      }
    },
    [workspaceId, refresh],
  );

  // Take the next step for the person's own runs (never for a stale run, a failed one, or one waiting on a decision).
  useEffect(() => {
    if (!opts.act || !canWrite) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const run of runs) {
      if (!run.mine || !run.view.next || run.view.stale || run.view.failure || run.busy) continue;
      const p = run.problem;
      if (p && !isWait(p)) continue;
      const s = slot(run.campaign.id);
      const since = Date.now() - s.at;
      const wait = p ? WAIT_MS : s.sent === stepKey(run.view.next) ? SENT_MS : 0;
      if (since < wait) {
        timer = setTimeout(emit, wait - since + 50);
        continue;
      }
      void step(run);
    }
    return () => (timer ? clearTimeout(timer) : undefined);
  }, [runs, opts.act, canWrite, step]);

  // A finished run: show its video in Your content. A decision that's no longer needed (the person
  // finished the video in the editor, say) goes away.
  const doneRef = useRef(new Set<string>());
  useEffect(() => {
    for (const r of runs) if (r.problem && (r.view.step === "done" || (r.view.step === "finish" && r.view.working))) setSlot(r.campaign.id, { problem: null });
  }, [runs]);
  useEffect(() => {
    let fresh = false;
    for (const r of runs) {
      if (r.view.step !== "done" || doneRef.current.has(r.campaign.id)) continue;
      doneRef.current.add(r.campaign.id);
      fresh = true;
    }
    if (fresh) void invalidateRef.current(wsPath(workspaceId, "/assets"), wsPath(workspaceId, "/compositions"));
  }, [runs, workspaceId]);

  const retry = useCallback(
    async (run: CreateRun, jobId: string) => {
      setSlot(run.campaign.id, { busy: null, problem: null, at: Date.now() });
      try {
        await api.post(wsPath(workspaceId, `/jobs/${jobId}/retry`));
      } catch (e) {
        setSlot(run.campaign.id, { problem: toProblem(e), at: Date.now() });
      } finally {
        await refresh(run.campaign.id);
      }
    },
    [workspaceId, refresh],
  );

  const clear = useCallback((campaignId: string) => setSlot(campaignId, { problem: null, at: 0 }), []);

  return { runs, loading: list.isLoading || details.some((d) => d.isLoading), continueRun: step, retry, clear };
}

/** Mounted once per app (layout): moves the person's Create runs along on any page of the app. */
export function CreateRunner({ appId }: { appId: string }) {
  useCreateRuns(appId, { act: true });
  return null;
}
