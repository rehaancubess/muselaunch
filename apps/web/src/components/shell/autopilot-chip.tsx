"use client";
import { cn } from "@muselaunch/ui";
import { Rocket } from "lucide-react";
import Link from "next/link";
import { wsPath } from "@/lib/api";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import type { AutopilotListItem } from "@/features/autopilot/types";
import { isActive, STATUS_COPY } from "@/features/autopilot/types";

/** The app's running Growth Autopilot loop, if any (one runs per app at a time). */
export function useActiveAutopilot(workspaceId: string, appId: string | null | undefined) {
  const q = useApiQuery<{ items: AutopilotListItem[] }>(appId ? wsPath(workspaceId, `/apps/${appId}/autopilots`) : null, {
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data?.items.some((a) => isActive(a.status)) ? 15_000 : 60_000),
    retry: false,
  });
  return q.data?.items.find((a) => isActive(a.status)) ?? null;
}

/**
 * Top-bar status for a running Growth Autopilot: always one click from its checkpoints. Hidden when
 * no loop is active, so the bar stays quiet.
 */
export function AutopilotChip({ workspaceId, appId }: { workspaceId: string; appId: string | null | undefined }) {
  const active = useActiveAutopilot(workspaceId, appId);
  if (!appId || !active) return null;
  const needsYou = active.status === "awaiting_user";
  const label = STATUS_COPY[active.status];
  return (
    <Link
      href={`${routes.app(workspaceId, appId).autopilot}?loop=${encodeURIComponent(active.id)}`}
      prefetch={false}
      aria-label={`Growth Autopilot: ${label}`}
      title={active.goal}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-footnote transition-colors focus-visible:outline-none focus-visible:shadow-focus",
        needsYou ? "border-warning/40 bg-warning-soft text-ink hover:border-warning/70" : "border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink",
      )}
    >
      <Rocket className={cn("size-3.5", needsYou ? "text-warning" : "text-accent")} aria-hidden />
      <span className="hidden sm:inline">Autopilot</span>
      <span className={cn("size-1.5 rounded-full", needsYou ? "bg-warning" : active.status === "paused" ? "bg-ink-3" : "animate-pulse bg-accent")} aria-hidden />
      <span className="hidden font-medium xl:inline">{label}</span>
    </Link>
  );
}
