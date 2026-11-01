"use client";
/**
 * Owner: module B (Intelligence). The Autopilot page: one run at a time, outcome first. A run opens
 * on the calm progress screen (plain steps with real results, the finished video, what needs you,
 * what it's testing; the decision log, stage rail, budget and model calls behind "Show details").
 * With no active run: a one-tap start with defaults ("More options" for goal, videos, rounds,
 * budget) and the earlier runs.
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
    <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_320px]" aria-busy>
      <div className="space-y-6">
        <Skeleton className="h-10 w-2/3" rounded="lg" />
        <Skeleton className="h-72 w-full" rounded="xl" />
      </div>
      <Skeleton className="mx-auto aspect-[9/16] w-full max-w-[300px]" rounded="xl" />
    </div>
  );
}

function SelectedLoop({ id, first, openDetails }: { id: string; first: boolean; openDetails: boolean }) {
  const { workspaceId } = useWorkspace();
  const query = useApiQuery<AutopilotDetail>(wsPath(workspaceId, `/autopilots/${id}`), {
    // Live while it works; slower while it waits on you or on the measurement window.
    refetchInterval: (q) => {
      const s = q.state.data?.autopilot.status;
      if (!s) return false;
      if (isWorking(s)) return 2500;
      if (s === "awaiting_user" || s === "paused") return 10_000;
      if (s === "sleeping") return 30_000;
      return false;
    },
  });
  // Keep the run list, the Needs-you list and the top-bar chip in step with the run's status.
  const invalidate = useInvalidate();
  const status = query.data?.autopilot.status;
  const stage = query.data?.autopilot.stage;
  const appId = query.data?.autopilot.appId;
  useEffect(() => {
    if (status && appId) void invalidate(wsPath(workspaceId, `/apps/${appId}/autopilots`), wsPath(workspaceId, "/needs-you"));
  }, [status, stage, appId, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps -- useInvalidate returns a new function each render
  return (
    <QueryState query={query} feature="Autopilot" skeleton={<LoopSkeleton />}>
      {(detail) => <LoopView detail={detail} first={first} openDetails={openDetails} />}
    </QueryState>
  );
}

function History({ items, selected, onSelect }: { items: AutopilotListItem[]; selected: string | null; onSelect: (id: string) => void }) {
  if (items.length < 2 && items[0]?.id === selected) return null;
  if (!items.length) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-headline font-semibold">Runs</h2>
      <List label="Autopilot runs">
        {items.map((a) => (
          <ListRow
            key={a.id}
            onClick={() => onSelect(a.id)}
            className={a.id === selected ? "bg-mist/70" : undefined}
            title={a.goal}
            subtitle={`Started ${relativeTime(a.createdAt)} · ${a.budget.variants} video${a.budget.variants > 1 ? "s" : ""}`}
            trailing={<StatusPill status={statusKind(a.status)}>{STATUS_COPY[a.status]}</StatusPill>}
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
  // ?goal= (from the Creator / ⌘K) pre-fills a new run; an active run still takes precedence.

  return (
    <QueryState query={list} feature="Autopilot" skeleton={<LoopSkeleton />}>
      {({ items }) => {
        const active = items.find((a) => isActive(a.status));
        const wantsNew = params.get("new") === "1" || Boolean(initialGoal && !params.get("loop"));
        const selected = params.get("loop") ?? (wantsNew ? null : (active?.id ?? items[0]?.id ?? null));
        const showStart = !selected && !active;
        const first = items.length <= 1;
        return (
          <div className="space-y-14">
            {selected ? (
              <SelectedLoop key={selected} id={selected} first={first} openDetails={params.get("details") === "1"} />
            ) : showStart ? (
              <div className="space-y-8">
                <header className="space-y-2">
                  <h1 className="text-title-1 font-semibold text-balance">Autopilot</h1>
                  <p className="max-w-xl text-body text-ink-2 text-pretty">Makes videos for your app, checks them and drafts posts. You approve what goes out.</p>
                </header>
                <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
                  <StartCard appId={appId} initialGoal={initialGoal} again={items.length > 0} onStarted={(id) => choose(id)} />
                  <HowItWorks />
                </div>
              </div>
            ) : (
              <EmptyState icon={<Sparkles aria-hidden />} title="A run is already going" description="One Autopilot run per app at a time." action={<Button onClick={() => choose(active!.id)}>Open it</Button>} />
            )}
            {selected && !active && can("content.write") ? (
              <div className="flex justify-start">
                <Button size="sm" variant="outline" icon={<Plus aria-hidden />} onClick={() => choose(null)}>
                  New run
                </Button>
              </div>
            ) : null}
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
    ? ` Muse Spark Open (open weights via Baseten) ${routed.length ? `writes ${routed.map((t) => (t === "copy.generate" ? "post copy" : t === "composition.variant_briefs" ? "video briefs" : "scene edits")).join(" and ")}` : "is on standby"}${open.fallback ? " and steps in when the Meta Model API is limited, shown in each run" : ""}.`
    : "";
  const steps = [
    ["Learns", "your app from its listing or your description."],
    ["Researches", "what your audience talks about. Every finding links to its source."],
    ["Makes", "short videos to compare, from your real screenshots."],
    ["Checks", "facts and brand, and fixes what it can on its own."],
    ["Asks", "before anything is posted or extra credits are spent."],
    ["Learns", "from real results only, and says so when there are none yet."],
  ];
  return (
    <aside className="space-y-4 rounded-xl bg-mist/60 p-6">
      <p className="text-footnote font-medium text-ink-2">How it works</p>
      <ol className="space-y-3">
        {steps.map(([verb, rest], i) => (
          <li key={i} className="flex gap-3 text-body-sm">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface text-caption font-semibold tabular text-ink shadow-raised">{i + 1}</span>
            <span className="text-ink-2 text-pretty">
              <span className="font-medium text-ink">{verb}</span> {rest}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-footnote text-ink-3 text-pretty">
        Muse Wonder plans and decides; Muse Spark writes, plans and edits the videos; SAM 3.1 finds what’s on screen; Muse Voice Transcribe checks the voiceover; the brand check uses Muse Glimmer when it’s connected.{openNote} Every model call is metered.
      </p>
    </aside>
  );
}
