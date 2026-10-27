"use client";
import { Button, Dialog, Notice, Spinner, Textarea, cn, useToast } from "@muselaunch/ui";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, errorMessage } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { CATEGORY_LABEL, EngineBadge, ReviewStatus, formatLatency } from "./parts";
import { brandBlockOf, isBrandReviewRunning, isRunning, useBrandReviews, useGuardianActions, type GuardianSubject, type ReviewBrief } from "./use-guardian";

/**
 * Compact Brand Guardian status for render and approval dialogs: the review of this exact
 * version/content, its engine (local Glimmer vs rules only) and the blocking issues, if any.
 * When nothing has been reviewed yet, the gate reviews it automatically on submit.
 */
export function BrandGuardianBadge({ subject, version, className }: { subject: GuardianSubject; version?: number; className?: string }) {
  const { workspaceId } = useWorkspace();
  const { query, latest, glimmer } = useBrandReviews(workspaceId, subject, version);
  const blocking = latest?.findings.filter((f) => f.severity === "block" && f.resolution?.state !== "dismissed") ?? [];
  const warn = latest?.findings.filter((f) => f.severity === "warn" && !f.resolution).length ?? 0;
  const Icon = latest?.status === "blocked" ? ShieldAlert : ShieldCheck;
  return (
    <div className={cn("space-y-2 rounded-xl border border-line bg-surface px-3.5 py-3", className)} aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={cn("size-4", latest?.status === "blocked" ? "text-danger" : "text-accent")} aria-hidden />
        <span className="text-body-sm font-medium text-ink">Brand Guardian</span>
        {query.isLoading ? <Spinner size={14} label="Loading review" /> : latest ? <ReviewStatus status={latest.status} /> : null}
        <EngineBadge reviewer={latest && !isRunning(latest) ? latest.reviewer : null} glimmer={glimmer} />
        {latest?.latencyMs !== undefined && !isRunning(latest) ? <span className="text-caption text-ink-3">{formatLatency(latest.latencyMs)}</span> : null}
      </div>
      {!query.isLoading && !latest ? <p className="text-footnote text-ink-2">Not reviewed yet — Brand Guardian checks it automatically when you continue.</p> : null}
      {latest && isRunning(latest) ? <p className="text-footnote text-ink-2">Reviewing this {version ? `version` : "content"} now…</p> : null}
      {latest && !isRunning(latest) && latest.status !== "failed" ? (
        <p className="text-footnote text-ink-2">
          {blocking.length ? `${blocking.length} blocking issue${blocking.length === 1 ? "" : "s"}: ${blocking[0]!.message}` : warn ? `${warn} warning${warn === 1 ? "" : "s"} to consider.` : "On brand and backed by verified claims."}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Shown when a gated action was refused because the review is `blocked`: the blocking issues and a
 * required reason. Overrides are stored on the review and in the workspace audit log.
 */
export function BrandOverrideForm({ block, actionLabel, busy, onOverride, onCancel }: { block: ReviewBrief; actionLabel: string; busy?: boolean; onOverride: (reason: string) => void; onCancel?: () => void }) {
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  return (
    <div className="space-y-3">
      <Notice tone="danger" icon={<ShieldAlert aria-hidden />} title="Brand Guardian blocked this">
        <ul className="list-disc space-y-0.5 pl-4">
          {block.blocking.slice(0, 5).map((b) => (
            <li key={b.id}>
              <span className="font-medium">{CATEGORY_LABEL[b.category]}:</span> {b.message}
            </li>
          ))}
        </ul>
      </Notice>
      <div className="flex flex-wrap items-center gap-1.5">
        <EngineBadge reviewer={block} />
        {block.latencyMs !== undefined ? <span className="text-caption text-ink-3">{formatLatency(block.latencyMs)}</span> : null}
      </div>
      <label className="block space-y-1.5">
        <span className="text-footnote font-medium text-ink">Reason for overriding</span>
        <Textarea rows={3} value={reason} maxLength={500} placeholder="e.g. Legal confirmed offline mode ships in v2.1" onChange={(e) => setReason(e.target.value)} />
        <span className="block text-caption text-ink-3">Fixing the issue is usually better. Overrides are logged with your name and reason.</span>
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Go back and fix
          </Button>
        ) : null}
        <Button variant="danger" disabled={!ok} loading={busy} onClick={() => onOverride(reason.trim())}>
          Override and {actionLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Drop-in "Request approval" button for posts and outreach drafts. Shows the Brand Guardian status,
 * and when the review is blocked asks for an override reason instead of failing silently.
 */
export function GuardedApprovalButton({
  path,
  onDone,
  disabled,
  size = "md",
  children = "Request approval",
}: {
  path: string;
  onDone?: () => unknown;
  disabled?: boolean;
  size?: "sm" | "md";
  children?: ReactNode;
}) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const actions = useGuardianActions(workspaceId);
  const [busy, setBusy] = useState(false);
  const [block, setBlock] = useState<ReviewBrief | null>(null);
  const submit = async (override?: string) => {
    setBusy(true);
    try {
      const r = await api.post<{ brandReview?: ReviewBrief & { overridden?: boolean } }>(path, override ? { override: { reason: override } } : {});
      setBlock(null);
      toast.success("Approval requested", r.brandReview ? (r.brandReview.overridden ? "Brand Guardian override logged." : `Brand Guardian: ${r.brandReview.status === "passed" ? "on brand" : "warnings noted"}.`) : undefined);
      await onDone?.();
    } catch (e) {
      const b = brandBlockOf(e);
      if (b) setBlock(b);
      else if (isBrandReviewRunning(e)) toast.toast({ title: "Brand Guardian is still reviewing", description: "Try again in a moment." });
      else toast.error("Couldn't request approval", errorMessage(e));
    } finally {
      setBusy(false);
      void actions.refresh();
    }
  };
  return (
    <>
      <Button size={size} loading={busy && !block} disabled={disabled} onClick={() => void submit()}>
        {children}
      </Button>
      <Dialog open={Boolean(block)} onOpenChange={(o) => !o && setBlock(null)} title="Review before approval" description="Brand Guardian checked the exact content you're sending for approval.">
        {block ? <BrandOverrideForm block={block} actionLabel="request approval" busy={busy} onOverride={(reason) => void submit(reason)} onCancel={() => setBlock(null)} /> : null}
      </Dialog>
    </>
  );
}
