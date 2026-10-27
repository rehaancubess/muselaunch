"use client";
import type { Job } from "@muselaunch/contracts";
import { EmptyState, ErrorState, IconButton, JobProgress, Popover, Skeleton, cn, useToast } from "@muselaunch/ui";
import { Activity } from "lucide-react";
import { useState } from "react";
import { errorMessage, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { isActive, useJob } from "@/lib/jobs";
import { useApiQuery } from "@/lib/query";

function relTime(iso?: string) {
  if (!iso) return "";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function TrayRow({ workspaceId, initial }: { workspaceId: string; initial: Job }) {
  const toast = useToast();
  const live = useJob(workspaceId, isActive(initial) ? initial.id : null, { initial });
  const job = live.job ?? initial;
  return (
    <li className="px-4 py-3">
      <JobProgress
        job={job}
        variant="row"
        cancelling={live.cancelling}
        retrying={live.retrying}
        onCancel={() => live.cancel().catch((e) => toast.error("Couldn't cancel", errorMessage(e)))}
        onRetry={async () => {
          try {
            await live.retry();
          } catch (e) {
            toast.error("Couldn't retry", errorMessage(e));
          }
        }}
      />
      <p className="mt-1 text-caption text-ink-3">{relTime(job.queuedAt ?? job.createdAt)}</p>
    </li>
  );
}

/** Top-bar tray: recent jobs with live progress, cancel and retry. */
export function JobsTray({ workspaceId, appId }: { workspaceId: string; appId?: string }) {
  const [open, setOpen] = useState(false);
  const jobs = useApiQuery<Page<Job>>(wsPath(workspaceId, "/jobs"), {
    query: { limit: 20, appId },
    refetchInterval: (q) => (q.state.data?.items.some(isActive) ? 4000 : open ? 15_000 : 30_000),
  });
  const active = jobs.data?.items.filter(isActive).length ?? 0;
  const failed = jobs.data?.items.filter((j) => j.status === "failed" && Date.now() - Date.parse(j.updatedAt) < 3600_000).length ?? 0;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label="Background jobs"
      className="w-[min(380px,calc(100vw-24px))] p-0"
      trigger={
        <IconButton label={active ? `${active} job${active === 1 ? "" : "s"} running` : "Jobs"} className="relative">
          <Activity className={cn("size-[18px]", active && "text-accent")} aria-hidden />
          {active ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular text-white">{active}</span>
          ) : failed ? (
            <span className="absolute right-1 top-1 size-2 rounded-full bg-danger ring-2 ring-white" aria-hidden />
          ) : null}
        </IconButton>
      }
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <p className="text-body-sm font-semibold">Activity</p>
        <p className="text-footnote text-ink-2">{active ? `${active} running` : "Nothing running"}</p>
      </div>
      <div className="max-h-[min(480px,70dvh)] overflow-y-auto">
        {jobs.isLoading ? (
          <div className="space-y-4 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-1.5 w-full" rounded="full" />
              </div>
            ))}
          </div>
        ) : jobs.error ? (
          <ErrorState compact className="m-3" message={errorMessage(jobs.error)} onRetry={() => jobs.refetch()} retrying={jobs.isFetching} />
        ) : !jobs.data?.items.length ? (
          <EmptyState size="sm" icon={<Activity aria-hidden />} title="No activity yet" description="Imports, research, renders and other background work show up here with live progress." />
        ) : (
          <ul className="divide-y divide-line">
            {jobs.data.items.map((j) => (
              <TrayRow key={j.id} workspaceId={workspaceId} initial={j} />
            ))}
          </ul>
        )}
      </div>
    </Popover>
  );
}
