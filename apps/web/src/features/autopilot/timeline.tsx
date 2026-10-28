"use client";
import { Badge, ProgressBar, SourceChip, StatusPill, cn, humanizeStatus, jobLabel, statusKindOf } from "@muselaunch/ui";
import type { Autopilot } from "@muselaunch/contracts";
import { AlertTriangle, ArrowUpRight, Bot, Check, ChevronDown, CircleDot, Coins, Eye, Hand, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { relativeTime } from "@/lib/labels";
import { byStage, entityHref, RAIL, railIndex, stageOutcome, type AutopilotDetail, type LogEntry, type LoopStage } from "./types";

type StepState = "done" | "active" | "attention" | "failed" | "pending";

/** Rail state of each stage for the iteration on screen. */
export function railStates(ap: Autopilot, live: boolean): StepState[] {
  if (!live) return RAIL.map(() => "done");
  const cur = railIndex(ap.stage);
  return RAIL.map((_, i) => {
    if (ap.status === "completed") return "done";
    if (i < cur) return "done";
    if (i > cur) return "pending";
    if (ap.status === "failed") return "failed";
    if (ap.status === "awaiting_user") return "attention";
    if (ap.status === "cancelled") return "pending";
    return "active";
  });
}

function Dot({ state, index, small }: { state: StepState; index: number; small?: boolean }) {
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full font-semibold tabular transition-colors duration-300",
        small ? "size-6 text-[11px]" : "size-7 text-caption",
        state === "done" && "bg-ink text-white",
        state === "active" && "bg-accent text-white",
        state === "attention" && "bg-warning text-white",
        state === "failed" && "bg-danger text-white",
        state === "pending" && "bg-mist text-ink-3",
      )}
      aria-hidden
    >
      {state === "done" ? <Check className="size-3.5" /> : state === "failed" ? "!" : index + 1}
      {state === "active" ? <span className="absolute inset-0 animate-ping rounded-full bg-accent/30" /> : null}
    </span>
  );
}

/** Horizontal stage rail: where the loop is, at a glance. */
export function StageRail({ states }: { states: StepState[] }) {
  // On narrow screens the rail scrolls sideways: keep the current stage in view.
  const ref = useRef<HTMLOListElement>(null);
  const current = states.findIndex((st) => st === "active" || st === "attention");
  useEffect(() => {
    const ol = ref.current;
    const li = current >= 0 ? (ol?.children[current] as HTMLElement | undefined) : undefined;
    if (!ol || !li || ol.scrollWidth <= ol.clientWidth) return;
    const left = li.getBoundingClientRect().left - ol.getBoundingClientRect().left + ol.scrollLeft;
    ol.scrollLeft = Math.max(0, left - (ol.clientWidth - li.offsetWidth) / 2);
  }, [current]);
  return (
    <ol ref={ref} className="-mx-1 flex snap-x gap-1 overflow-x-auto px-1 pb-1" aria-label="Autopilot stages">
      {RAIL.map((r, i) => (
        <li key={r.stage} className="flex min-w-[76px] flex-1 snap-start flex-col items-center gap-1.5" aria-current={states[i] === "active" || states[i] === "attention" ? "step" : undefined}>
          <div className="flex w-full items-center">
            <span className={cn("h-px flex-1", i === 0 ? "bg-transparent" : states[i] === "pending" ? "bg-line" : "bg-ink/70")} />
            <Dot state={states[i]!} index={i} />
            <span className={cn("h-px flex-1", i === RAIL.length - 1 ? "bg-transparent" : states[i + 1] === "pending" ? "bg-line" : "bg-ink/70")} />
          </div>
          <span className={cn("text-caption", states[i] === "pending" ? "text-ink-3" : "font-medium text-ink")}>{r.label}</span>
        </li>
      ))}
    </ol>
  );
}

const KIND_ICON: Record<LogEntry["kind"], ReactNode> = {
  decision: <Sparkles aria-hidden />,
  action: <CircleDot aria-hidden />,
  observation: <Eye aria-hidden />,
  verification: <ShieldCheck aria-hidden />,
  checkpoint: <Hand aria-hidden />,
  budget: <Coins aria-hidden />,
  error: <AlertTriangle aria-hidden />,
};

interface Ctx {
  detail: AutopilotDetail;
  workspaceId: string;
  appId: string;
}

function JobInline({ job }: { job: AutopilotDetail["jobs"][number] }) {
  const running = job.status === "queued" || job.status === "running";
  if (running)
    return (
      <div className="mt-2 max-w-sm space-y-1">
        <div className="flex justify-between gap-2 text-footnote text-ink-2">
          <span className="truncate">{job.progress?.message || jobLabel(job.type)}</span>
          {job.status === "running" ? <span className="tabular text-ink-3">{Math.round(job.progress?.pct ?? 0)}%</span> : <span className="text-ink-3">Queued</span>}
        </div>
        <ProgressBar value={job.status === "queued" ? null : (job.progress?.pct ?? 0)} label={jobLabel(job.type)} />
      </div>
    );
  if (job.status === "failed") return <p className="mt-1 text-footnote text-danger">{jobLabel(job.type)} failed: {job.error?.userMessage ?? job.error?.message ?? "unknown error"}</p>;
  return (
    <span className="inline-flex items-center gap-1 text-footnote text-ink-3">
      <StatusPill status={statusKindOf(job.status)}>{humanizeStatus(job.status)}</StatusPill>
      {job.creditsCharged ? <span className="tabular">{job.creditsCharged} cr</span> : null}
    </span>
  );
}

/** Links, citation chips and live job status for an entry's refs. */
function EntryRefs({ entry, ctx }: { entry: LogEntry; ctx: Ctx }) {
  const { detail, workspaceId, appId } = ctx;
  const jobs = entry.refs.filter((r) => r.entity === "jobs").map((r) => detail.jobs.find((j) => j.id === r.id)).filter((j): j is NonNullable<typeof j> => Boolean(j));
  const findings = entry.refs.filter((r) => r.entity === "researchFindings").map((r) => detail.findings.find((f) => f.id === r.id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
  const links: { href: string; label: string }[] = [];
  for (const r of entry.refs) {
    if (r.entity === "jobs" || r.entity === "researchFindings" || r.entity === "approvals") continue;
    const l = entityHref(workspaceId, appId, detail.autopilot, r, detail.reviews);
    if (l && !links.some((x) => x.href === l.href && x.label === l.label)) links.push(l);
  }
  if (!jobs.length && !findings.length && !links.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {findings.length ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Cited research">
          {findings.flatMap((f) => f.evidence.slice(0, 2).map((src, i) => <SourceChip key={`${f.id}:${i}`} source={src} compact className="max-w-[260px]" />))}
        </div>
      ) : null}
      {jobs.map((j) => (
        <JobInline key={j.id} job={j} />
      ))}
      {links.length ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {links.map((l) => (
            <Link key={l.href + l.label} href={l.href} className="inline-flex items-center gap-0.5 text-footnote font-medium text-accent hover:underline">
              {l.label}
              <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EntryRow({ entry, ctx }: { entry: LogEntry; ctx: Ctx }) {
  const decision = entry.kind === "decision";
  const tone = entry.kind === "error" ? "text-danger" : entry.kind === "checkpoint" || entry.kind === "budget" ? "text-warning" : decision ? "text-accent" : "text-ink-3";
  return (
    <li className={cn("flex gap-3 rounded-lg px-3 py-2.5", decision && "bg-accent-soft/60")}>
      <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", tone)}>{entry.kind === "verification" && /blocked|issue|error|unavailable|Left out/i.test(entry.summary) ? <ShieldAlert aria-hidden /> : KIND_ICON[entry.kind]}</span>
      <div className="min-w-0 flex-1">
        {decision ? (
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge tone="accent" icon={<Bot aria-hidden />}>
              Muse Wonder decided
            </Badge>
          </div>
        ) : null}
        <p className={cn("text-body-sm text-pretty", entry.kind === "error" ? "text-danger" : "text-ink")}>{entry.summary}</p>
        <EntryRefs entry={entry} ctx={ctx} />
      </div>
      <time className="shrink-0 pt-0.5 text-caption tabular text-ink-3" dateTime={entry.at}>
        {relativeTime(entry.at)}
      </time>
    </li>
  );
}

const SEVERITY_TONE = { block: "danger", warn: "warning", info: "neutral" } as const;

/** Brand Guardian results for the loop's videos (findings, fixes, human overrides). */
export function GuardianPanel({ ctx }: { ctx: Ctx }) {
  const { detail } = ctx;
  const latest = new Map<string, AutopilotDetail["reviews"][number]>();
  for (const r of detail.reviews) {
    const prev = latest.get(r.subject.id);
    if (!prev || (r.subjectVersion ?? 0) >= (prev.subjectVersion ?? 0)) latest.set(r.subject.id, r);
  }
  if (!latest.size) return null;
  return (
    <div className="space-y-2 rounded-lg bg-mist/60 p-3">
      <p className="text-footnote font-medium text-ink">Brand Guardian</p>
      {[...latest.values()].map((r) => {
        const comp = detail.compositions.find((c) => c.id === r.subject.id);
        const open = r.findings.filter((f) => f.resolution?.state !== "dismissed" && f.resolution?.state !== "applied");
        return (
          <div key={r.id} className="space-y-1.5 rounded-md bg-surface px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="truncate text-body-sm font-medium text-ink">
                {comp?.title ?? "Video"} <span className="text-ink-3">v{r.subjectVersion}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-caption text-ink-3">{r.reviewer.engine === "glimmer" ? "Muse Glimmer · self-hosted" : "Rules only"}</span>
                <StatusPill status={r.status === "passed" ? "success" : r.status === "warnings" ? "attention" : r.status === "blocked" || r.status === "failed" ? "failed" : "running"}>{humanizeStatus(r.status)}</StatusPill>
              </span>
            </div>
            {r.status === "failed" ? <p className="text-footnote text-ink-2">The review couldn’t run. It’s not counted as a pass; the render gate reviews the video again.</p> : null}
            {open.length ? (
              <ul className="space-y-1">
                {open.slice(0, 4).map((f) => (
                  <li key={f.id} className="flex gap-2 text-footnote">
                    <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity === "block" ? "Blocking" : f.severity === "warn" ? "Warning" : "Note"}</Badge>
                    <span className="min-w-0 text-ink-2">
                      {f.message}
                      {f.suggestion ? <span className="text-ink-3"> — {f.suggestion}</span> : null}
                    </span>
                  </li>
                ))}
                {open.length > 4 ? <li className="text-caption text-ink-3">+{open.length - 4} more in Studio</li> : null}
              </ul>
            ) : r.status !== "failed" && r.status !== "queued" && r.status !== "running" ? (
              <p className="text-footnote text-ink-2">No open issues.</p>
            ) : null}
            {r.overrides.length ? <p className="text-caption text-ink-3">Overridden by a person: “{r.overrides[r.overrides.length - 1]!.reason}”</p> : null}
          </div>
        );
      })}
    </div>
  );
}

/** One stage of one iteration: outcome line when collapsed, entries when open. */
function StageGroup({ stage, entries, state, defaultOpen, ctx }: { stage: LoopStage; entries: LogEntry[]; state: StepState; defaultOpen: boolean; ctx: Ctx }) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = RAIL.find((r) => r.stage === stage)!;
  const outcome = stageOutcome(entries);
  const index = RAIL.findIndex((r) => r.stage === stage);
  const decisions = entries.filter((e) => e.kind === "decision").length;
  return (
    <li className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-mist/60">
        <Dot state={state} index={index} small />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-body-sm font-semibold text-ink">{meta.label}</span>
            {decisions ? <span className="text-caption text-accent">{decisions} decision{decisions > 1 ? "s" : ""}</span> : null}
          </span>
          {!open ? <span className={cn("mt-0.5 line-clamp-2 block text-footnote", outcome?.kind === "error" ? "text-danger" : "text-ink-2")}>{outcome?.summary ?? meta.blurb}</span> : <span className="mt-0.5 block text-footnote text-ink-3">{meta.blurb}</span>}
        </span>
        <ChevronDown className={cn("mt-1 size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div className="ml-[34px] space-y-2 pb-3">
          {entries.length ? (
            <ul className="space-y-1">
              {entries.map((e, i) => (
                <EntryRow key={`${e.at}:${i}`} entry={e} ctx={ctx} />
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-footnote text-ink-3">Starting…</p>
          )}
          {stage === "verify" ? <GuardianPanel ctx={ctx} /> : null}
        </div>
      ) : null}
    </li>
  );
}

/** The iteration's story, stage by stage (only stages that happened, plus the current one). */
export function IterationTimeline({ entries, live, ctx }: { entries: LogEntry[]; live: boolean; ctx: Ctx }) {
  const ap = ctx.detail.autopilot;
  const groups = byStage(entries);
  const states = railStates(ap, live);
  const current = railIndex(ap.stage);
  const shown = RAIL.filter((r, i) => groups.has(r.stage) || (live && i === current && ap.stage !== "done"));
  if (!shown.length) return <p className="py-6 text-center text-footnote text-ink-3">Nothing has happened yet.</p>;
  return (
    <ol className="space-y-1">
      {shown.map((r) => {
        const i = RAIL.findIndex((x) => x.stage === r.stage);
        return <StageGroup key={`${r.stage}:${live}`} stage={r.stage} entries={groups.get(r.stage) ?? []} state={states[i]!} defaultOpen={live && i === current} ctx={ctx} />;
      })}
    </ol>
  );
}
