"use client";
/**
 * Create runs, watched: the videos "Generate video" started, as the server reports them
 * (GET /apps/:appId/create-runs: the step, real progress, the decision it stopped at, the finished
 * video). The SERVER takes every step (packages/autopilot/src/create-runner.ts) from job hooks and a
 * one-minute sweep, so a video keeps going with every MuseLaunch tab closed, and the phone app reads
 * the same runs. This page never takes a step itself (a second actor in the browser could only race
 * the server's decisions); its buttons answer a run's decision (POST /create-runs/:id/resolve), and
 * the server then carries on as the person who answered. Nothing is ever posted from here.
 */
import type { CreateRunAction, CreateRunView, CreateRunsResponse, ResolveCreateRunResponse } from "@muselaunch/contracts";
import { useToast } from "@muselaunch/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { isMoving } from "./plan";

/** Create runs followed closely (older ones live on Make → Campaigns and Videos). */
const MAX_FOLLOWED = 6;

export type CreateRun = CreateRunView;

export interface CreateRunsState {
  runs: CreateRun[];
  loading: boolean;
  /** The answer being sent for a run, by campaign id. */
  busy: Record<string, CreateRunAction | undefined>;
  /** Answer the run's decision (Try again, Continue, Finish it, Finish it anyway with a reason, Leave it). */
  resolve: (run: CreateRun, action: CreateRunAction, opts?: { reason?: string }) => Promise<boolean>;
}

export function useCreateRuns(appId: string): CreateRunsState {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const path = appId ? wsPath(workspaceId, `/apps/${appId}/create-runs`) : null;
  const q = useApiQuery<CreateRunsResponse>(path, {
    query: { limit: MAX_FOLLOWED },
    staleTime: 2_000,
    // Closely while a video is being made; rarely once they're finished or waiting for the person.
    refetchInterval: (query) => ((query.state.data?.items ?? []).some(isMoving) ? 3_000 : 20_000),
  });
  const runs = q.data?.items;
  const [busy, setBusy] = useState<Record<string, CreateRunAction | undefined>>({});

  // useInvalidate returns a new function each render: keep the latest.
  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;

  // A run that just finished: its video shows in Your content (and the balance moved).
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!runs) return;
    const done = runs.filter((r) => r.status === "done").map((r) => r.campaignId);
    if (!seen.current) {
      seen.current = new Set(done);
      return;
    }
    const fresh = done.filter((id) => !seen.current!.has(id));
    if (!fresh.length) return;
    for (const id of fresh) seen.current.add(id);
    void invalidateRef.current(wsPath(workspaceId, "/assets"), wsPath(workspaceId, "/compositions"), wsPath(workspaceId, "/billing"), "estimate");
  }, [runs, workspaceId]);

  const resolve = useCallback(
    async (run: CreateRun, action: CreateRunAction, opts: { reason?: string } = {}) => {
      setBusy((b) => ({ ...b, [run.campaignId]: action }));
      try {
        await api.post<ResolveCreateRunResponse>(wsPath(workspaceId, `/create-runs/${run.campaignId}/resolve`), {
          action,
          // The decision the person saw: the server refuses it if the video changed meanwhile.
          ...(run.decision ? { stepKey: run.decision.stepKey } : {}),
          ...(opts.reason ? { reason: opts.reason } : {}),
        });
        return true;
      } catch (e) {
        toast.error("Couldn’t do that", errorMessage(e));
        return false;
      } finally {
        setBusy((b) => ({ ...b, [run.campaignId]: undefined }));
        await invalidateRef.current(wsPath(workspaceId, `/apps/${run.appId}/create-runs`), wsPath(workspaceId, "/needs-you"), wsPath(workspaceId, `/apps/${run.appId}/today`), wsPath(workspaceId, "/billing"), "estimate");
      }
    },
    [workspaceId, toast],
  );

  return { runs: runs ?? [], loading: q.isLoading, busy, resolve };
}
