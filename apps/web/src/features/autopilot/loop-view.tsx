"use client";
import { Badge, Button, Card, Notice, ProgressBar, SegmentedControl, Spinner, StatusPill, Textarea, cn, humanizeStatus, useToast } from "@muselaunch/ui";
import { ArrowUpRight, Check, Hand, Pause, Play, Square, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { CHANNEL_LABEL, relativeTime } from "@/lib/labels";
import { useInvalidate, useMutation } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { IterationTimeline, railStates, StageRail } from "./timeline";
import { checkpointCap, isActive, isWorking, splitIterations, STAGE_LABEL, STATUS_COPY, statusKind, type AutopilotDetail } from "./types";

const CAP_COPY: Record<string, string> = {
  "billing.manage": "Only members who manage billing can approve spending.",
  "content.approve": "Only owners and admins can decide this checkpoint.",
  publish: "Only members allowed to publish can decide this.",
};

function useLoopActions(detail: AutopilotDetail) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const id = detail.autopilot.id;
  const refresh = () => invalidate(wsPath(workspaceId, `/autopilots/${id}`), wsPath(workspaceId, `/apps/${detail.autopilot.appId}/autopilots`));
  return useMutation({
    mutationFn: ({ action, note }: { action: "pause" | "resume" | "cancel" | "checkpoint/approve" | "checkpoint/reject"; note?: string }) => api.post(wsPath(workspaceId, `/autopilots/${id}/${action}`), note ? { note } : {}),
    onSuccess: async (_d, { action }) => {
      const copy: Record<string, [string, string?]> = {
        pause: ["Autopilot paused", "Running jobs finish; nothing new starts until you resume."],
        resume: ["Autopilot resumed"],
        cancel: ["Autopilot cancelled", "Work it already produced is kept."],
        "checkpoint/approve": ["Approved", "The loop continues from where it stopped."],
        "checkpoint/reject": ["Declined", "The loop is paused. Resume it whenever you’re ready."],
      };
      const [t, d] = copy[action]!;
      toast.success(t, d);
      await refresh();
    },
    onError: (err) => toast.error("That didn’t work", errorMessage(err)),
  });
}

function CheckpointCard({ detail }: { detail: AutopilotDetail }) {
  const { can } = useWorkspace();
  const act = useLoopActions(detail);
  const [note, setNote] = useState("");
  const cp = detail.checkpoint;
  if (!cp) return null;
  const cap = checkpointCap(cp.action);
  const allowed = can(cap);
  const title = cp.action === "spend" ? "Approve spending?" : cp.action === "agent_continue" ? "Continue the loop?" : "Your decision";
  return (
    <Card padding="lg" className="space-y-4 ring-1 ring-warning/30">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning [&_svg]:size-4">
          <Hand aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-headline font-semibold">{title}</h2>
            {cp.estimate?.credits ? <Badge tone="warning">≈{cp.estimate.credits} credits</Badge> : null}
          </div>
          <p className="text-body-sm text-ink-2 text-pretty">{cp.summary}</p>
        </div>
      </div>
      {allowed ? (
        <div className="space-y-3 sm:pl-12">
          <Textarea rows={1} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the log (optional)" aria-label="Note" />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" icon={<X aria-hidden />} loading={act.isPending && act.variables?.action === "checkpoint/reject"} disabled={act.isPending} onClick={() => act.mutate({ action: "checkpoint/reject", note: note.trim() || undefined })}>
              Decline and pause
            </Button>
            <Button icon={<Check aria-hidden />} loading={act.isPending && act.variables?.action === "checkpoint/approve"} disabled={act.isPending} onClick={() => act.mutate({ action: "checkpoint/approve", note: note.trim() || undefined })}>
              Approve
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-footnote text-ink-2 sm:pl-12">{CAP_COPY[cap]} The loop waits here until someone who can decides.</p>
      )}
    </Card>
  );
}

function BudgetCard({ detail }: { detail: AutopilotDetail }) {
  const ap = detail.autopilot;
  const pct = Math.min(100, (ap.spent.credits / ap.budget.maxCredits) * 100);
  const reserved = detail.jobs.filter((j) => j.status === "queued" || j.status === "running").reduce((n, j) => n + (j.reservation?.credits ?? 0), 0);
  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-footnote font-medium text-ink-2">Budget</p>
        <p className="text-caption text-ink-3">
          Iteration {ap.iteration} of {ap.budget.maxIterations}
        </p>
      </div>
      <p className="tabular">
        <span className="text-title-2 font-semibold">{ap.spent.credits}</span>
        <span className="text-body-sm text-ink-2"> / {ap.budget.maxCredits} credits</span>
      </p>
      <ProgressBar value={pct} tone={pct >= 90 ? "danger" : "accent"} label="Budget used" />
      <dl className="space-y-1 text-footnote">
        {reserved ? (
          <div className="flex justify-between gap-2">
            <dt className="text-ink-2">Held by running jobs</dt>
            <dd className="tabular text-ink">{reserved}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-2">
          <dt className="text-ink-2">Model calls (metered)</dt>
          <dd className="tabular text-ink">${ap.spent.usd.toFixed(ap.spent.usd < 1 ? 3 : 2)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-2">Renders run without asking</dt>
          <dd className="tabular text-ink">{ap.budget.autoApproveCredits ? `≤ ${ap.budget.autoApproveCredits} cr` : "Never"}</dd>
        </div>
      </dl>
    </Card>
  );
}

function SideLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-0.5 text-footnote font-medium text-accent hover:underline">
      {children}
      <ArrowUpRight className="size-3" aria-hidden />
    </Link>
  );
}

function OutputsCard({ detail, workspaceId }: { detail: AutopilotDetail; workspaceId: string }) {
  const ap = detail.autopilot;
  const app = routes.app(workspaceId, ap.appId);
  const exp = detail.experiment;
  if (!exp && !detail.compositions.length && !detail.posts.length && !ap.audience) return null;
  const reviewOf = (id: string) => detail.reviews.filter((r) => r.subject.id === id).sort((a, b) => (b.subjectVersion ?? 0) - (a.subjectVersion ?? 0))[0];
  return (
    <Card className="space-y-5">
      {ap.audience ? (
        <section className="space-y-1">
          <p className="text-footnote font-medium text-ink-2">Audience</p>
          <p className="text-body-sm text-ink">{ap.audience.description}</p>
        </section>
      ) : null}
      {exp ? (
        <section className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-footnote font-medium text-ink-2">Experiment</p>
            <SideLink href={app.insights}>Insights</SideLink>
          </div>
          {ap.hypothesis ? <p className="text-body-sm text-ink text-pretty">{ap.hypothesis.statement}</p> : null}
          <ul className="space-y-0.5">
            {exp.variants.map((v) => (
              <li key={v.key} className="flex gap-2 text-footnote text-ink-2">
                <span className="w-6 shrink-0 font-semibold uppercase text-ink">{v.key}</span>
                <span className="min-w-0 truncate">{v.label}</span>
              </li>
            ))}
          </ul>
          <p className="text-caption text-ink-3">
            Primary metric: {humanizeStatus(exp.primaryMetric)}
            {exp.launchWindow?.end ? ` · measured until ${new Date(exp.launchWindow.end).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
          </p>
        </section>
      ) : null}
      {detail.compositions.length ? (
        <section className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-footnote font-medium text-ink-2">Videos</p>
            {ap.campaignId ? <SideLink href={app.campaign(ap.campaignId)}>Campaign</SideLink> : null}
          </div>
          <ul className="space-y-1">
            {detail.compositions.map((c) => {
              const r = reviewOf(c.id);
              return (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <Link href={app.studio(c.id)} className="min-w-0 truncate text-body-sm text-ink hover:text-accent">
                    {c.title} <span className="text-ink-3">v{c.currentVersion}</span>
                  </Link>
                  {r ? <StatusPill status={r.status === "passed" ? "success" : r.status === "warnings" ? "attention" : r.status === "blocked" || r.status === "failed" ? "failed" : "running"}>{r.status === "passed" ? "On brand" : humanizeStatus(r.status)}</StatusPill> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {detail.posts.length ? (
        <section className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-footnote font-medium text-ink-2">Posts</p>
            <SideLink href={app.calendar}>Calendar</SideLink>
          </div>
          <ul className="space-y-1">
            {detail.posts.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-2 text-footnote">
                <span className="text-ink">
                  {CHANNEL_LABEL[x.channel] ?? x.channel}
                  {x.scheduledAt ? <span className="text-ink-3"> · {new Date(x.scheduledAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span> : null}
                </span>
                <StatusPill status={x.status === "awaiting_approval" ? "attention" : x.status === "published" || x.status === "manually_posted" ? "success" : x.status === "failed" ? "failed" : "idle"}>{humanizeStatus(x.status)}</StatusPill>
              </li>
            ))}
          </ul>
          {detail.posts.some((x) => x.status === "awaiting_approval") ? <p className="text-caption text-ink-3">Approve each post in the Calendar. The loop never publishes on its own.</p> : null}
        </section>
      ) : null}
    </Card>
  );
}

function Controls({ detail }: { detail: AutopilotDetail }) {
  const { can } = useWorkspace();
  const act = useLoopActions(detail);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const s = detail.autopilot.status;
  if (!can("content.write") || (!isActive(s) && s !== "failed")) return null;
  const busy = (a: string) => act.isPending && act.variables?.action === a;
  if (confirmCancel)
    return (
      <div className="flex items-center gap-2">
        <span className="text-footnote text-ink-2">Stop this loop for good?</span>
        <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
          Keep
        </Button>
        <Button size="sm" variant="danger" loading={busy("cancel")} onClick={() => act.mutate({ action: "cancel" }, { onSettled: () => setConfirmCancel(false) })}>
          Cancel loop
        </Button>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {s === "paused" || s === "failed" ? (
        <Button size="sm" icon={<Play aria-hidden />} loading={busy("resume")} disabled={act.isPending} onClick={() => act.mutate({ action: "resume" })}>
          {s === "failed" ? "Try again" : "Resume"}
        </Button>
      ) : s !== "awaiting_user" ? (
        <Button size="sm" variant="outline" icon={<Pause aria-hidden />} loading={busy("pause")} disabled={act.isPending} onClick={() => act.mutate({ action: "pause" })}>
          Pause
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" icon={<Square aria-hidden />} disabled={act.isPending} onClick={() => setConfirmCancel(true)}>
        Cancel
      </Button>
    </div>
  );
}

/** One autopilot: where it is, what it decided and why, what it needs from you, and what it produced. */
export function LoopView({ detail }: { detail: AutopilotDetail }) {
  const { workspaceId } = useWorkspace();
  const ap = detail.autopilot;
  const iterations = useMemo(() => splitIterations(ap.log), [ap.log]);
  const liveIndex = Math.min(ap.iteration, iterations.length) - 1;
  const [picked, setPicked] = useState<number | null>(null);
  const shown = picked ?? liveIndex;
  const live = shown === liveIndex;
  const ctx = { detail, workspaceId, appId: ap.appId };
  const now = isWorking(ap.status) ? detail.waitingFor || `${STAGE_LABEL[ap.stage]}…` : ap.status === "sleeping" ? detail.waitingFor : ap.status === "awaiting_user" ? detail.waitingFor || "Waiting for your decision" : null;

  return (
    <div className="space-y-8">
      <Card padding="lg" className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={statusKind(ap.status)}>{STATUS_COPY[ap.status]}</StatusPill>
              <span className="text-caption text-ink-3">
                Started {relativeTime(ap.createdAt)} · {ap.budget.variants} variant{ap.budget.variants > 1 ? "s" : ""}
              </span>
            </div>
            <h2 className="text-title-3 font-semibold text-balance">{ap.goal}</h2>
            {now ? (
              <p className="flex items-center gap-2 text-body-sm text-ink-2">
                {isWorking(ap.status) ? <Spinner className="size-3.5" /> : null}
                <span className="text-pretty">{now}</span>
              </p>
            ) : null}
          </div>
          <Controls detail={detail} />
        </div>
        <StageRail states={railStates(ap, live)} />
      </Card>

      {ap.status === "failed" && ap.error ? (
        <Notice tone="danger" title="The loop stopped">
          {ap.error.userMessage ?? ap.error.message} Everything it made so far is kept. “Try again” resumes from this stage.
        </Notice>
      ) : null}
      {ap.status === "paused" ? (
        <Notice tone="neutral" title="Paused">
          Nothing new starts while the loop is paused. Jobs that were already running finish normally.
        </Notice>
      ) : null}

      <CheckpointCard detail={detail} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0 space-y-4" aria-label="What the loop did">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-headline font-semibold">{live ? "This iteration" : `Iteration ${shown + 1}`}</h2>
              <p className="text-footnote text-ink-2">Decisions cite the research behind them. Tap a stage for details.</p>
            </div>
            {iterations.length > 1 && iterations.some((x) => x.length) ? (
              <SegmentedControl
                label="Iteration"
                size="sm"
                items={iterations.map((_, i) => ({ value: String(i), label: `${i + 1}` }))}
                value={String(shown)}
                onChange={(v) => setPicked(Number(v) === liveIndex ? null : Number(v))}
              />
            ) : null}
          </div>
          <div className={cn("rounded-xl bg-surface p-2 shadow-raised")}>
            <IterationTimeline key={shown} entries={iterations[shown] ?? []} live={live} ctx={ctx} />
          </div>
        </section>
        <aside className="space-y-4">
          <BudgetCard detail={detail} />
          <OutputsCard detail={detail} workspaceId={workspaceId} />
          {detail.runs.length ? (
            <Card className="space-y-2">
              <p className="text-footnote font-medium text-ink-2">Muse Wonder decisions</p>
              <ul className="space-y-1">
                {detail.runs.map((r) => (
                  <li key={r.id}>
                    <Link href={routes.app(workspaceId, ap.appId).run(r.id)} className="flex items-center justify-between gap-2 text-footnote text-ink hover:text-accent">
                      <span className="min-w-0 truncate">{r.goal}</span>
                      <ArrowUpRight className="size-3 shrink-0 text-ink-3" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
