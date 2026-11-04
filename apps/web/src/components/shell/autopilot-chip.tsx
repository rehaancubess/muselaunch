"use client";
import { wsPath } from "@/lib/api";
import { useApiQuery } from "@/lib/query";
import type { AutopilotListItem } from "@/features/autopilot/types";
import { isActive } from "@/features/autopilot/types";

/**
 * The app's running Growth Autopilot loop, if any (one runs per app at a time). The top bar no
 * longer has its own Autopilot chip: its status lives on Creator → Today (the Always-on line, or
 * the run's progress screen), and the Make page links to the run.
 */
export function useActiveAutopilot(workspaceId: string, appId: string | null | undefined) {
  const q = useApiQuery<{ items: AutopilotListItem[] }>(appId ? wsPath(workspaceId, `/apps/${appId}/autopilots`) : null, {
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data?.items.some((a) => isActive(a.status)) ? 15_000 : 60_000),
    retry: false,
  });
  return q.data?.items.find((a) => isActive(a.status)) ?? null;
}
