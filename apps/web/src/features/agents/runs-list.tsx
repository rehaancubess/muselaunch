"use client";
import type { AgentRun } from "@muselaunch/contracts";
import { Badge, EmptyState, List, ListRow, StatusPill, humanizeStatus, statusKindOf } from "@muselaunch/ui";
import { Bot } from "lucide-react";
import { QueryState } from "@/components/states";
import { wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { relativeTime } from "@/lib/labels";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { formatUsd, modelLabel, RUN_KIND_LABEL } from "./types";

/** Recent agent runs for an app (GET /apps/:appId/agent-runs), each linking to its trace. */
export function AgentRunsList({ workspaceId, appId, limit = 20 }: { workspaceId: string; appId: string; limit?: number }) {
  const query = useApiQuery<Page<AgentRun>>(wsPath(workspaceId, `/apps/${appId}/agent-runs`), {
    query: { limit },
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === "running" || r.status === "queued") ? 4000 : false),
  });
  return (
    <QueryState query={query} feature="Agent runs">
      {(page) =>
        page.items.length ? (
          <List label="Agent runs">
            {page.items.map((r) => (
              <ListRow
                key={r.id}
                href={routes.app(workspaceId, appId).run(r.id)}
                leading={<Bot aria-hidden className="size-4 text-ink-3" />}
                title={RUN_KIND_LABEL[r.kind] ?? r.kind}
                subtitle={<span className="line-clamp-1">{r.goal}</span>}
                trailing={
                  <span className="flex items-center gap-2">
                    <Badge tone="neutral">{modelLabel(r.model)}</Badge>
                    <span className="hidden text-caption tabular text-ink-3 sm:inline">{formatUsd(r.usage.costUsd)}</span>
                    <span className="hidden text-caption text-ink-3 md:inline">{relativeTime(r.createdAt)}</span>
                    <StatusPill status={statusKindOf(r.status)}>{humanizeStatus(r.status)}</StatusPill>
                  </span>
                }
              />
            ))}
          </List>
        ) : (
          <EmptyState icon={<Bot aria-hidden />} title="No agent runs yet" description="Runs appear here when Muse Wonder or Muse Spark works on this app — research, App DNA, concepts, storyboards and edits." />
        )
      }
    </QueryState>
  );
}
