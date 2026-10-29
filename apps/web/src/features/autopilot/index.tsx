"use client";
/**
 * Owner: module B (Intelligence). Growth Autopilot: start a bounded loop (goal, budget, variants,
 * iterations, auto-approve threshold, typical cost), then follow it stage by stage — Muse Wonder's
 * decisions with citation chips, delegated jobs with live progress, verification incl. Brand
 * Guardian findings, spend/continue checkpoints, budget meter, outputs and iteration history.
 * Data: /apps/:appId/autopilot(s), /autopilots/:id (+ /pause /resume /cancel /checkpoint/approve|reject).
 */
import { Button, EmptyState, List, ListRow, Skeleton, StatusPill } from "@muselaunch/ui";
import { Plus, Sparkles } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { QueryState } from "@/components/states";
import { wsPath } from "@/lib/api";
import { useSparkOpenRouting } from "@/lib/engines";
import { relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { LoopView } from "./loop-view";
import { StartCard } from "./start-card";
import { isActive, isWorking, STATUS_COPY, statusKind, type AutopilotDetail, type AutopilotListItem } from "./types";

export { autopilotPath } from "./types";

function LoopSkeleton() {
  return (
    <div className="space-y-6" aria-busy>
      <Skeleton className="h-40 w-full" rounded="xl" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Skeleton className="h-80 w-full" rounded="xl" />
        <Skeleton className="h-56 w-full" rounded="xl" />
      </div>
    </div>
  );
}

function SelectedLoop({ id }: { id: string }) {
  const { workspaceId } = useWorkspace();
  const query = useApiQuery<AutopilotDetail>(wsPath(workspaceId, `/autopilots/${id}`), {
    // Live while it works; slower while it waits on you or on the measurement window.
    refetchInterval: (q) => {
      const s = q.state.data?.autopilot.status;
      if (!s) return false;
      if (isWorking(s)) return 2500;
      if (s === "awaiting_user" || s === "paused") return 10_000;
      if (s === "sleeping") return 60_000;
      return false;
    },
  });
  // Keep the loop list and the top-bar chip in step with the loop's status as it changes.
  const invalidate = useInvalidate();
  const status = query.data?.autopilot.status;
  const appId = query.data?.autopilot.appId;
  useEffect(() => {
    if (status && appId) void invalidate(wsPath(workspaceId, `/apps/${appId}/autopilots`));
  }, [status, appId, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps -- useInvalidate returns a new function each render
  return (
    <QueryState query={query} feature="Growth Autopilot" skeleton={<LoopSkeleton />}>
      {(detail) => <LoopView detail={detail} />}
    </QueryState>
  );
}

function History({ items, selected, onSelect }: { items: AutopilotListItem[]; selected: string | null; onSelect: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-headline font-semibold">Loops</h2>
      <List label="Growth Autopilot loops">
        {items.map((a) => (
          <ListRow
            key={a.id}
            onClick={() => onSelect(a.id)}
            className={a.id === selected ? "bg-mist/70" : undefined}
            title={a.goal}
            subtitle={a.lastLog ? a.lastLog.summary : `Started ${relativeTime(a.createdAt)}`}
            trailing={
              <>
                <span className="hidden text-caption tabular text-ink-3 sm:inline">
                  {a.spent.credits}/{a.budget.maxCredits} cr · {relativeTime(a.updatedAt)}
                </span>
                <StatusPill status={statusKind(a.status)}>{STATUS_COPY[a.status]}</StatusPill>
              </>
            }
          />
        ))}
      </List>
    </section>
  );
}

export default function AutopilotRoot({ appId, initialGoal }: { appId: string; initialGoal?: string }) {
  const { workspaceId, can } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const list = useApiQuery<{ items: AutopilotListItem[] }>(wsPath(workspaceId, `/apps/${appId}/autopilots`), {
    refetchInterval: (q) => (q.state.data?.items.some((a) => isWorking(a.status)) ? 10_000 : false),
  });
  const choose = (id: string | null) => router.replace(id ? `${pathname}?loop=${encodeURIComponent(id)}` : `${pathname}?new=1`, { scroll: false });
  // ?goal= (from the Creator home card / ⌘K) pre-fills a new loop; an active loop still takes precedence.

  return (
    <QueryState query={list} feature="Growth Autopilot" skeleton={<LoopSkeleton />}>
      {({ items }) => {
        const active = items.find((a) => isActive(a.status));
        const wantsNew = params.get("new") === "1" || Boolean(initialGoal && !params.get("loop"));
        const selected = params.get("loop") ?? (wantsNew ? null : (active?.id ?? null));
        const showStart = !selected && !active;
        return (
          <div className="space-y-10">
            {selected ? (
              <>
                {!active && can("content.write") ? (
                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" icon={<Plus aria-hidden />} onClick={() => choose(null)}>
                      New loop
                    </Button>
                  </div>
                ) : null}
                <SelectedLoop key={selected} id={selected} />
              </>
            ) : showStart ? (
              <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
                <StartCard appId={appId} initialGoal={initialGoal} onStarted={(id) => choose(id)} />
                <HowItWorks />
              </div>
            ) : (
              <EmptyState icon={<Sparkles aria-hidden />} title="A loop is already running" description="One Growth Autopilot runs per app at a time." action={<Button onClick={() => choose(active!.id)}>Open it</Button>} />
            )}
            <History items={items} selected={selected} onSelect={(id) => choose(id)} />
          </div>
        );
      }}
    </QueryState>
  );
}

function HowItWorks() {
  const open = useSparkOpenRouting();
  const routed = open?.configured ? open.tasks.filter((t) => t === "copy.generate" || t === "composition.variant_briefs" || t === "composition.edit.scoped") : [];
  const openNote = open?.configured
    ? ` Muse Spark Open (open weights via Baseten) ${routed.length ? `writes ${routed.map((t) => (t === "copy.generate" ? "post copy" : t === "composition.variant_briefs" ? "variant briefs" : "scene edits")).join(" and ")}` : "is on standby"}${open.fallback ? " and steps in when the Meta Model API is limited, shown in each run" : ""}.`
    : "";
  const steps = [
    ["Researches", "your audience, trends and competitors — every finding links to its source."],
    ["Decides", "who to reach and one testable hypothesis, citing the research."],
    ["Makes", "distinct video variants, checked for lint, claims and brand fit."],
    ["Asks", "before spending beyond your limits, and before any post goes out."],
    ["Measures", "real results only, and says so when there's no data yet."],
    ["Learns", "lessons for your brand memory and the next iteration."],
  ];
  return (
    <aside className="space-y-4 rounded-xl bg-mist/60 p-6">
      <p className="text-footnote font-medium text-ink-2">How the loop works</p>
      <ol className="space-y-3">
        {steps.map(([verb, rest], i) => (
          <li key={verb} className="flex gap-3 text-body-sm">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface text-caption font-semibold tabular text-ink shadow-raised">{i + 1}</span>
            <span className="text-ink-2 text-pretty">
              <span className="font-medium text-ink">{verb}</span> {rest}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-footnote text-ink-3 text-pretty">
        Muse Wonder orchestrates; Muse Spark writes and edits; the Brand Guardian (Muse Glimmer) reviews.{openNote} Every model call is metered against your credits.
      </p>
    </aside>
  );
}
