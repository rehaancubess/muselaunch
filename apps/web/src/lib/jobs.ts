"use client";
import type { Job } from "@muselaunch/contracts";
import { TERMINAL_JOB_STATUSES } from "@muselaunch/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, wsPath } from "./api";
import type { JobResponse } from "./api-types";
import { keyFor } from "./query";
import { subscribe } from "./sse";

export const isTerminal = (j: Pick<Job, "status"> | null | undefined) => Boolean(j && (TERMINAL_JOB_STATUSES as readonly string[]).includes(j.status));
export const isActive = (j: Pick<Job, "status"> | null | undefined) => Boolean(j && (j.status === "queued" || j.status === "running"));

/**
 * Jobs that act outside MuseLaunch (publishing, sending email) can't be retried generically: the API
 * requires their own endpoints, which re-check the publish grant and approval. Hide Retry for them.
 */
export const RETRY_ELSEWHERE: Partial<Record<Job["type"], string>> = {
  "publish.post": "Publish it again from the calendar.",
  "outreach.send": "Send the draft again from outreach.",
};
export const canRetryGenerically = (j: Pick<Job, "type"> | null | undefined) => Boolean(j && !RETRY_ELSEWHERE[j.type]);

export interface UseJobResult {
  job: Job | null;
  /** live = SSE stream, polling = fallback, done = terminal, idle = no job id */
  connection: "idle" | "live" | "polling" | "done";
  error: string | null;
  cancel: () => Promise<void>;
  retry: () => Promise<Job | null>;
  cancelling: boolean;
  retrying: boolean;
}

/**
 * Live job state via SSE (`GET .../jobs/:id/events`) with reconnect and polling fallback.
 * Writes into the React Query cache under the job's GET path so other views stay in sync.
 * `onSettled` fires once when the job reaches a terminal status (or needs approval).
 */
export function useJob(workspaceId: string | null | undefined, jobId: string | null | undefined, opts: { initial?: Job | null; onSettled?: (job: Job) => void } = {}): UseJobResult {
  const qc = useQueryClient();
  const path = workspaceId && jobId ? wsPath(workspaceId, `/jobs/${jobId}`) : null;
  const [job, setJob] = useState<Job | null>(() => {
    if (opts.initial && opts.initial.id === jobId) return opts.initial;
    if (!path) return null;
    return qc.getQueryData<JobResponse>(keyFor(path))?.job ?? null;
  });
  const [connection, setConnection] = useState<UseJobResult["connection"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const settledRef = useRef<string | null>(null);
  const onSettled = useRef(opts.onSettled);
  onSettled.current = opts.onSettled;

  useEffect(() => {
    if (!path || !workspaceId || !jobId) {
      setConnection("idle");
      setJob(null);
      return;
    }
    const cached = qc.getQueryData<JobResponse>(keyFor(path))?.job;
    if (cached && cached.id === jobId) setJob(cached);
    const apply = (j: Job) => {
      setJob(j);
      setError(null);
      qc.setQueryData<JobResponse>(keyFor(path), { job: j });
      if ((isTerminal(j) || j.status === "needs_approval") && settledRef.current !== `${j.id}:${j.updatedAt}`) {
        settledRef.current = `${j.id}:${j.updatedAt}`;
        // Refresh lists (jobs tray etc.)
        void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith(wsPath(workspaceId, "/jobs")) && q.queryKey[0] !== path });
        onSettled.current?.(j);
      }
    };
    if (cached && isTerminal(cached) && epoch === 0) {
      setConnection("done");
      return;
    }
    return subscribe<Job>({
      path: `${path}/events`,
      event: "job",
      onData: apply,
      isDone: (j) => isTerminal(j) || j.status === "needs_approval",
      poll: async () => (await api.get<JobResponse>(path)).job,
      onMode: setConnection,
      onError: (e) => setError(errorMessage(e)),
    });
  }, [path, workspaceId, jobId, qc, epoch]);

  const cancel = useCallback(async () => {
    if (!workspaceId || !jobId) return;
    setCancelling(true);
    try {
      const r = await api.post<JobResponse>(wsPath(workspaceId, `/jobs/${jobId}/cancel`));
      setJob(r.job);
    } finally {
      setCancelling(false);
    }
  }, [workspaceId, jobId]);

  const retry = useCallback(async () => {
    if (!workspaceId || !jobId) return null;
    setRetrying(true);
    try {
      const r = await api.post<JobResponse>(wsPath(workspaceId, `/jobs/${jobId}/retry`));
      setJob(r.job);
      settledRef.current = null;
      setEpoch((e) => e + 1);
      return r.job;
    } finally {
      setRetrying(false);
    }
  }, [workspaceId, jobId]);

  return { job, connection, error, cancel, retry, cancelling, retrying };
}
