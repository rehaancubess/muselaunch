"use client";
import type { Approval, Capability } from "@muselaunch/contracts";
import { Badge, Button, Card, Notice, StatusPill, Textarea, statusKindOf, useToast } from "@muselaunch/ui";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useMemberName, useWorkspace } from "@/lib/workspace";

const CAP: Record<Approval["action"], Capability> = {
  publish: "publish",
  outreach_send: "outreach.send",
  account_change: "accounts.manage",
  spend: "billing.manage",
  claim_use: "content.approve",
  render_over_budget: "content.approve",
  agent_continue: "content.approve",
};

const ACTION_LABEL: Record<Approval["action"], string> = {
  publish: "Publishing",
  outreach_send: "Creator outreach",
  account_change: "Account change",
  spend: "Spend",
  claim_use: "Claim use",
  render_over_budget: "Render over budget",
  agent_continue: "Agent step",
};

/**
 * Approval checkpoint. Approving echoes the snapshot hash of the exact version on screen; the API
 * refuses it if the content changed meanwhile. Shown wherever an external action waits for a person.
 */
export function ApprovalCard({ approval, currentHash, onDecided, compact }: { approval: Approval; currentHash?: string; onDecided?: () => void; compact?: boolean }) {
  const { workspaceId, can } = useWorkspace();
  const nameOf = useMemberName();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const allowed = can(CAP[approval.action]);
  const stale = Boolean(currentHash && currentHash !== approval.snapshotHash);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    try {
      await api.post(wsPath(workspaceId, `/approvals/${approval.id}/${decision}`), { snapshotHash: approval.snapshotHash, note: note || undefined });
      toast.toast({ tone: decision === "approve" ? "success" : "neutral", title: decision === "approve" ? "Approved" : "Rejected" });
      onDecided?.();
    } catch (e) {
      toast.error("Couldn’t record the decision", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card tone="well" padding={compact ? "sm" : "md"} className="space-y-3">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ink-2" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body-sm font-semibold">{ACTION_LABEL[approval.action]} approval</span>
            <StatusPill status={statusKindOf(approval.status === "pending" ? "needs_approval" : approval.status)}>{approval.status === "consumed" ? "Used" : approval.status[0]!.toUpperCase() + approval.status.slice(1)}</StatusPill>
            <Badge tone="outline" title={approval.snapshotHash}>
              Version {approval.snapshotHash.replace("sha256:", "").slice(0, 8)}
            </Badge>
          </div>
          <p className="text-footnote text-ink-2 text-pretty">{approval.summary}</p>
          {approval.decidedBy ? (
            <p className="text-caption text-ink-3">
              {approval.status === "rejected" ? "Rejected" : "Approved"} by {nameOf(approval.decidedBy)}
              {approval.decidedAt ? ` · ${new Date(approval.decidedAt).toLocaleString()}` : ""}
              {approval.note ? ` · “${approval.note}”` : ""}
            </p>
          ) : null}
        </div>
      </div>
      {stale ? <Notice tone="warning">The content changed after this request. Request approval again for the current version.</Notice> : null}
      {approval.status === "pending" && !stale ? (
        allowed ? (
          <div className="space-y-2">
            {!compact ? <Textarea rows={2} placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Approval note" /> : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => decide("approve")} loading={busy === "approve"} disabled={Boolean(busy)}>
                Approve this version
              </Button>
              <Button size="sm" variant="outline" onClick={() => decide("reject")} loading={busy === "reject"} disabled={Boolean(busy)}>
                Reject
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-footnote text-ink-2">Waiting for someone with the “{CAP[approval.action]}” permission to approve.</p>
        )
      ) : null}
    </Card>
  );
}
