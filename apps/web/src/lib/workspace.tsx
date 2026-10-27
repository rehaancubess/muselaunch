"use client";
import type { App, Capability, CreditBalance, Workspace, WorkspaceMember } from "@muselaunch/contracts";
import { capabilitiesFor } from "@muselaunch/contracts";
import { useParams } from "next/navigation";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { wsPath, type ApiError } from "./api";
import type { MeResponse, Page, WorkspaceResponse } from "./api-types";
import { useApiQuery } from "./query";

/** Route params for workspace/app pages. */
export function useRouteIds(): { workspaceId: string; appId?: string } {
  const p = useParams<{ workspaceId?: string; appId?: string }>();
  return { workspaceId: String(p?.workspaceId ?? ""), appId: p?.appId ? String(p.appId) : undefined };
}

export function useMe() {
  return useApiQuery<MeResponse>("/v1/me", { staleTime: 60_000 });
}

export interface WorkspaceContextValue {
  workspaceId: string;
  workspace: Workspace | null;
  member: WorkspaceMember | null;
  credits: CreditBalance | null;
  caps: Set<Capability>;
  can: (cap: Capability) => boolean;
  apps: App[];
  appsLoading: boolean;
  /** Current app (from the URL) if any. */
  app: App | null;
  loading: boolean;
  error: ApiError | null;
  refetch: () => void;
}

const WorkspaceCtx = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const { appId } = useRouteIds();
  const ws = useApiQuery<WorkspaceResponse>(workspaceId ? wsPath(workspaceId) : null, { staleTime: 30_000 });
  const apps = useApiQuery<Page<App>>(workspaceId ? wsPath(workspaceId, "/apps") : null, {
    staleTime: 15_000,
    // Keep importing apps fresh so names/icons appear when the import finishes.
    refetchInterval: (q) => (q.state.data?.items.some((a) => a.status === "importing") ? 4000 : false),
  });

  const value = useMemo<WorkspaceContextValue>(() => {
    const member = ws.data?.member ?? null;
    const caps = member ? capabilitiesFor(member) : new Set<Capability>();
    const list = apps.data?.items ?? [];
    return {
      workspaceId,
      workspace: ws.data?.workspace ?? null,
      member,
      credits: ws.data?.credits ?? null,
      caps,
      can: (c) => caps.has(c),
      apps: list,
      appsLoading: apps.isLoading,
      app: appId ? (list.find((a) => a.id === appId) ?? null) : null,
      loading: ws.isLoading,
      error: (ws.error ?? apps.error ?? null) as ApiError | null,
      refetch: () => {
        void ws.refetch();
        void apps.refetch();
      },
    };
  }, [workspaceId, appId, ws.data, ws.isLoading, ws.error, apps.data, apps.isLoading, apps.error, ws, apps]);

  return <WorkspaceCtx.Provider value={value}>{children}</WorkspaceCtx.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceCtx);
  if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ctx;
}

/** Current app; throws if used outside an app route. */
export function useCurrentApp(): { app: App | null; appId: string; workspaceId: string; loading: boolean } {
  const { appId, workspaceId } = useRouteIds();
  const ctx = useWorkspace();
  if (!appId) throw new Error("useCurrentApp must be used under /w/[workspaceId]/a/[appId]");
  return { app: ctx.app, appId, workspaceId, loading: ctx.appsLoading };
}
