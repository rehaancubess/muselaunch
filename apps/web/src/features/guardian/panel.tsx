"use client";
import type { BrandFinding, BrandReview } from "@muselaunch/contracts";
import { Button, EmptyState, ErrorState, Input, Notice, Skeleton, Spinner, cn, useToast } from "@muselaunch/ui";
import { Check, ChevronDown, Crosshair, RotateCcw, ShieldCheck, Wand2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError, errorMessage, isRouteMissing } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { CATEGORY_LABEL, EngineBadge, EvidenceChips, ReviewStatus, SEVERITY_LABEL, SourceTag, formatLatency, relTime, truncate } from "./parts";
import { isRunning, useBrandReviews, useEvidence, useGuardianActions, type ApplyFindingResponse, type GuardianSubject } from "./use-guardian";

export interface BrandGuardianPanelProps {
  subject: GuardianSubject;
  /** Compositions: the version to review (defaults to the current one server-side). */
  version?: number;
  /** A one-click fix created a new composition version. */
  onApplied?: (r: ApplyFindingResponse) => void;
  /** Highlight the scene/layer a finding is about (Studio). */
  onFocus?: (loc: NonNullable<BrandFinding["location"]>) => void;
  className?: string;
}

const ORDER: BrandFinding["severity"][] = ["block", "warn", "info"];
const DOT: Record<BrandFinding["severity"], string> = { block: "bg-danger", warn: "bg-warning", info: "bg-ink-3" };

/**
 * Brand Guardian: Muse Glimmer (running locally) + deterministic rules check this exact version
 * against the brand kit, verified claims and team memory. Findings are grouped by severity, cite
 * their evidence, and can be fixed in one click (validated patch → new version) or dismissed
 * (remembered, so the next review adapts).
 */
export function BrandGuardianPanel({ subject, version, onApplied, onFocus, className }: BrandGuardianPanelProps) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const { query, latest, glimmer } = useBrandReviews(workspaceId, subject, version);
  const actions = useGuardianActions(workspaceId);
  const evidence = useEvidence(workspaceId, latest?.appId ?? null);
  const canWrite = can("content.write");

  const run = async (rerun: boolean) => {
    try {
      await actions.run(subject, { version, rerun });
    } catch (e) {
      toast.error("Couldn't start the review", errorMessage(e));
    }
  };

  if (query.isLoading) {
    return (
      <div className={cn("space-y-3 p-4", className)}>
        <Skeleton className="h-16 w-full" rounded="lg" />
        <Skeleton className="h-24 w-full" rounded="lg" />
        <Skeleton className="h-24 w-full" rounded="lg" />
      </div>
    );
  }
  if (query.error) {
    if (isRouteMissing(query.error)) return <EmptyState className={className} size="sm" icon={<ShieldCheck aria-hidden />} title="Brand Guardian isn't in this build" description="Nothing is simulated in the meantime." />;
    return <ErrorState className={className} compact title="Brand review didn't load" message={errorMessage(query.error)} onRetry={() => void query.refetch()} />;
  }

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <header className="space-y-2 border-b border-line px-4 pb-3 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-ink">
              <ShieldCheck className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-headline font-semibold text-ink">Brand Guardian</h2>
              <p className="text-caption text-ink-2">Checks {subject.entity === "compositions" ? `version ${latest?.subjectVersion ?? version ?? ""}` : "this content"} against your brand kit, claims and memory.</p>
            </div>
          </div>
          {latest && !isRunning(latest) && canWrite ? (
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" aria-hidden />} loading={actions.busy === "run"} onClick={() => void run(true)} aria-label="Run the review again">
              Re-run
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <EngineBadge reviewer={latest && !isRunning(latest) ? latest.reviewer : null} glimmer={glimmer} />
          {latest && !isRunning(latest) && latest.latencyMs !== undefined ? <span className="text-caption text-ink-3">{formatLatency(latest.latencyMs)}</span> : null}
          {latest?.checkedAt ? <span className="text-caption text-ink-3">· {relTime(latest.checkedAt)}</span> : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!latest ? (
          <EmptyState
            size="sm"
            icon={<ShieldCheck aria-hidden />}
            title="Not reviewed yet"
            description={glimmer?.configured ? "Muse Glimmer reviews this privately on your GPU in a few seconds, alongside the brand rules. Final renders and approvals are checked automatically too." : "Glimmer isn't connected, so the deterministic brand rules will review it. Final renders and approvals are checked automatically too."}
            action={
              canWrite ? (
                <Button size="sm" loading={actions.busy === "run"} onClick={() => void run(false)}>
                  Review now · 1 credit
                </Button>
              ) : undefined
            }
          />
        ) : isRunning(latest) ? (
          <div className="flex items-center gap-3 rounded-xl bg-mist px-3.5 py-3">
            <Spinner size={18} label="Reviewing" />
            <div className="min-w-0">
              <p className="text-body-sm font-medium text-ink">{glimmer?.configured ? "Muse Glimmer is reviewing locally…" : "Checking brand rules…"}</p>
              <p className="text-caption text-ink-2">Brand kit, verified claims and team memory</p>
            </div>
          </div>
        ) : latest.status === "failed" ? (
          <Notice tone="danger" title="The review didn't finish" action={canWrite ? <Button size="sm" variant="secondary" onClick={() => void run(true)}>Retry</Button> : undefined}>
            {latest.error ?? "Try again."}
          </Notice>
        ) : (
          <ReviewBody review={latest} subject={subject} canWrite={canWrite} canApprove={can("content.approve")} actions={actions} evidence={evidence} onApplied={onApplied} onFocus={onFocus} />
        )}
      </div>
    </div>
  );
}

function ReviewBody({
  review,
  subject,
  canWrite,
  canApprove,
  actions,
  evidence,
  onApplied,
  onFocus,
}: {
  review: BrandReview;
  subject: GuardianSubject;
  canWrite: boolean;
  canApprove: boolean;
  actions: ReturnType<typeof useGuardianActions>;
  evidence: ReturnType<typeof useEvidence>;
  onApplied?: (r: ApplyFindingResponse) => void;
  onFocus?: (loc: NonNullable<BrandFinding["location"]>) => void;
}) {
  const open = review.findings.filter((f) => !f.resolution);
  const resolved = review.findings.filter((f) => f.resolution);
  const groups = useMemo(() => ORDER.map((sev) => ({ sev, items: open.filter((f) => f.severity === sev) })).filter((g) => g.items.length), [open]);
  const [showResolved, setShowResolved] = useState(false);
  return (
    <>
      <div className={cn("space-y-1.5 rounded-xl px-3.5 py-3", review.status === "blocked" ? "bg-danger-soft" : review.status === "warnings" ? "bg-warning-soft" : "bg-success-soft")}>
        <div className="flex items-center gap-2">
          <ReviewStatus status={review.status} />
          {review.subjectVersion ? <span className="text-caption text-ink-2">v{review.subjectVersion}</span> : null}
        </div>
        <p className="text-footnote text-ink">{review.summary}</p>
        {review.reviewer.engine === "rules" && review.reviewer.note ? <p className="text-caption text-ink-2">{review.reviewer.note}</p> : null}
      </div>

      {groups.map((g) => (
        <section key={g.sev} className="space-y-2" aria-label={SEVERITY_LABEL[g.sev]}>
          <h3 className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-ink-2">
            <span className={cn("size-1.5 rounded-full", DOT[g.sev])} aria-hidden />
            {SEVERITY_LABEL[g.sev]} · {g.items.length}
          </h3>
          {g.items.map((f) => (
            <FindingCard key={f.id} review={review} finding={f} subject={subject} canWrite={canWrite} canApprove={canApprove} actions={actions} evidence={evidence} onApplied={onApplied} onFocus={onFocus} />
          ))}
        </section>
      ))}

      {!open.length ? (
        <p className="flex items-center gap-2 text-footnote text-ink-2">
          <Check className="size-4 text-success" aria-hidden />
          Nothing left to fix in this {subject.entity === "compositions" ? "version" : "content"}.
        </p>
      ) : null}

      {review.overrides.length ? (
        <Notice tone="neutral" title="Overrides (logged)">
          <ul className="space-y-1">
            {review.overrides.map((o) => (
              <li key={`${o.at}:${o.by}`} className="text-caption">
                {o.action === "render_final" ? "Final render" : "Approval request"} by {o.by} · {relTime(o.at)} — “{truncate(o.reason, 140)}”
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {resolved.length ? (
        <section className="space-y-2">
          <button type="button" className="flex items-center gap-1 text-caption font-semibold uppercase tracking-wide text-ink-3 hover:text-ink-2" onClick={() => setShowResolved((v) => !v)} aria-expanded={showResolved}>
            <ChevronDown className={cn("size-3.5 transition-transform", !showResolved && "-rotate-90")} aria-hidden />
            Resolved · {resolved.length}
          </button>
          {showResolved
            ? resolved.map((f) => (
                <div key={f.id} className="rounded-lg border border-line px-3 py-2">
                  <p className="text-footnote text-ink-2 line-through decoration-ink-3/40">{f.message}</p>
                  <p className="mt-0.5 text-caption text-ink-3">
                    {f.resolution!.state === "applied" ? `Fixed${f.resolution!.resultVersion ? ` in v${f.resolution!.resultVersion}` : ""}` : "Dismissed — remembered for next time"}
                    {f.resolution!.reason ? ` · “${truncate(f.resolution!.reason, 80)}”` : ""}
                    {f.resolution!.preferenceId && evidence.preference(f.resolution!.preferenceId) ? ` · ${truncate(evidence.preference(f.resolution!.preferenceId)!.text, 80)}` : ""}
                  </p>
                </div>
              ))
            : null}
        </section>
      ) : null}
    </>
  );
}

function FindingCard({
  review,
  finding: f,
  subject,
  canWrite,
  canApprove,
  actions,
  evidence,
  onApplied,
  onFocus,
}: {
  review: BrandReview;
  finding: BrandFinding;
  subject: GuardianSubject;
  canWrite: boolean;
  canApprove: boolean;
  actions: ReturnType<typeof useGuardianActions>;
  evidence: ReturnType<typeof useEvidence>;
  onApplied?: (r: ApplyFindingResponse) => void;
  onFocus?: (loc: NonNullable<BrandFinding["location"]>) => void;
}) {
  const toast = useToast();
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const fixable = subject.entity === "compositions" && (f.suggestedOps?.length ?? 0) > 0;
  const canDismiss = canWrite && (f.severity !== "block" || canApprove);
  const loc = f.location;
  const focusable = Boolean(onFocus && loc && (loc.sceneId || loc.layerId));

  const apply = async () => {
    try {
      const r = await actions.apply(review.id, f.id);
      onApplied?.(r);
      toast.success(`Fixed in version ${r.version.version}`, "Brand Guardian is checking the new version.");
    } catch (e) {
      const stale = e instanceof ApiError && e.details?.reason === "brand_review_stale";
      toast.error(stale ? "This review is out of date" : "Couldn't apply the fix", stale ? "The video changed since this review. Re-run it to get fresh fixes." : errorMessage(e));
    }
  };
  const dismiss = async () => {
    try {
      await actions.dismiss(review.id, f.id, reason.trim());
      setDismissing(false);
      toast.success("Dismissed and remembered", "Future reviews won't flag this again.");
    } catch (e) {
      toast.error("Couldn't dismiss", errorMessage(e));
    }
  };

  return (
    <article
      className={cn("space-y-2 rounded-lg border bg-surface p-3 transition-colors", f.severity === "block" ? "border-danger/30" : "border-line", focusable && "hover:border-line-strong")}
      onMouseEnter={focusable ? () => onFocus!(loc!) : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-semibold text-ink-2">{CATEGORY_LABEL[f.category]}</span>
        <SourceTag source={f.source} />
      </div>
      <p className="text-body-sm text-ink">{f.message}</p>
      {f.quote && !f.message.includes(f.quote) ? <p className="w-fit max-w-full truncate rounded bg-mist px-1.5 py-0.5 font-mono text-caption text-ink-2">“{f.quote}”</p> : null}
      {f.suggestion ? <p className="text-footnote text-ink-2">{f.suggestion}</p> : null}
      <EvidenceChips finding={f} claim={evidence.claim} preference={evidence.preference} />
      {dismissing ? (
        <div className="space-y-2 pt-1">
          <Input aria-label="Why is this fine?" placeholder="Why is this fine? (remembered for next time)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void dismiss()} autoFocus />
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" loading={actions.busy === `dismiss:${f.id}`} onClick={() => void dismiss()}>
              Dismiss & remember
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {fixable && canWrite ? (
            <Button size="sm" icon={<Wand2 className="size-4" aria-hidden />} loading={actions.busy === `apply:${f.id}`} disabled={actions.busy !== null} onClick={() => void apply()}>
              Apply fix
            </Button>
          ) : null}
          {focusable ? (
            <Button size="sm" variant="ghost" icon={<Crosshair className="size-4" aria-hidden />} onClick={() => onFocus!(loc!)}>
              Show
            </Button>
          ) : null}
          {canDismiss ? (
            <Button size="sm" variant="ghost" icon={<X className="size-4" aria-hidden />} disabled={actions.busy !== null} onClick={() => setDismissing(true)}>
              Dismiss
            </Button>
          ) : f.severity === "block" && canWrite ? (
            <span className="text-caption text-ink-3">Only owners and admins can dismiss blocking issues.</span>
          ) : null}
        </div>
      )}
    </article>
  );
}
