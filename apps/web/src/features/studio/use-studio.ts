"use client";
import { useToast } from "@muselaunch/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { ApiError, api, errorMessage, wsPath } from "@/lib/api";
import { keyFor, useApiQuery } from "@/lib/query";
import type { CommitResponse, CompositionResponse, PatchOp, PreviewResponse, VersionsResponse } from "./types";

/**
 * Studio data: the composition + current version, a serialized edit queue (each edit is based on
 * the latest committed version), undo/redo/restore, and the compiled preview for a version.
 */
export function useStudio(workspaceId: string, compositionId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const base = wsPath(workspaceId, `/compositions/${compositionId}`);
  const query = useApiQuery<CompositionResponse>(base, { staleTime: 30_000 });
  const [saving, setSaving] = useState(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const applyCommit = useCallback(
    (r: CommitResponse) => {
      qc.setQueryData<CompositionResponse>(keyFor(base), (old) => (old ? { ...old, composition: r.composition, version: r.version } : old));
      // Lint and versions are recomputed server-side.
      void qc.invalidateQueries({ queryKey: keyFor(base), refetchType: "active" });
      void qc.invalidateQueries({ queryKey: keyFor(`${base}/versions`) });
    },
    [qc, base],
  );

  const run = useCallback(
    <T,>(fn: () => Promise<T>): Promise<T | null> => {
      const next = chain.current.then(async () => {
        setSaving(true);
        try {
          return await fn();
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            toast.error("This video changed in another tab", "We reloaded the latest version. Try your edit again.");
            await qc.invalidateQueries({ queryKey: keyFor(base) });
          } else if (err instanceof ApiError && err.status === 422) {
            const details = (err.details?.errors as string[] | undefined)?.[0];
            toast.error("That edit isn't valid", details ?? err.userMessage);
          } else toast.error("Couldn't save the change", errorMessage(err));
          return null;
        } finally {
          setSaving(false);
        }
      });
      chain.current = next.catch(() => null);
      return next;
    },
    [qc, base, toast],
  );

  const patch = useCallback(
    (ops: PatchOp[], summary = "Edit") =>
      run(async () => {
        const cur = qc.getQueryData<CompositionResponse>(keyFor(base));
        if (!cur) throw new Error("Composition not loaded");
        const r = await api.post<CommitResponse>(`${base}/patch`, { baseVersion: cur.composition.currentVersion, ops, summary: summary.slice(0, 500) });
        applyCommit(r);
        return r;
      }),
    [run, qc, base, applyCommit],
  );

  const undo = useCallback(() => run(async () => applyCommit(await api.post<CommitResponse>(`${base}/undo`))), [run, base, applyCommit]);
  const redo = useCallback(() => run(async () => applyCommit(await api.post<CommitResponse>(`${base}/redo`))), [run, base, applyCommit]);
  const restore = useCallback((v: number) => run(async () => applyCommit(await api.post<CommitResponse>(`${base}/versions/${v}/restore`))), [run, base, applyCommit]);
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: keyFor(base) }), [qc, base]);

  return { query, data: query.data, base, patch, undo, redo, restore, saving, refresh, applyCommit };
}

export function usePreview(base: string, version: number | undefined) {
  return useApiQuery<PreviewResponse>(version ? `${base}/preview` : null, {
    query: { version },
    // Signed media URLs last 30 minutes; refresh well before.
    staleTime: 10 * 60_000,
    refetchInterval: 20 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useVersions(base: string, enabled: boolean) {
  return useApiQuery<VersionsResponse>(`${base}/versions`, { enabled, query: { limit: 50 } });
}
