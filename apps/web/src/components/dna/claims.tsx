"use client";
import type { AppEvidence, Claim, ReviewState } from "@muselaunch/contracts";
import { Badge, Button, Dialog, EmptyState, Field, IconButton, SegmentedControl, StatusPill, Textarea, Tooltip, cn, useToast } from "@muselaunch/ui";
import { AlertTriangle, Check, MessageSquareQuote, Pencil, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useInvalidate } from "@/lib/query";
import { EvidencePopover } from "./evidence";

type Filter = "needs_review" | "verified" | "rejected" | "all";

const STATE_LABEL: Record<ReviewState, string> = { verified: "Verified", needs_review: "Needs review", rejected: "Rejected" };

function ClaimRow({ claim, evidence, workspaceId, appId, canEdit, canApprove }: { claim: Claim; evidence: AppEvidence[]; workspaceId: string; appId: string; canEdit: boolean; canApprove: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState<ReviewState | "edit" | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(claim.text);

  const patch = async (body: Record<string, unknown>, which: ReviewState | "edit") => {
    setBusy(which);
    try {
      await api.patch(wsPath(workspaceId, `/apps/${appId}/claims/${claim.id}`), body);
      await invalidate(wsPath(workspaceId, `/apps/${appId}/dna`));
      if (which === "verified") toast.success("Claim verified", "It can now be used in creative.");
      if (which === "rejected") toast.toast({ title: "Claim rejected", description: "Muse won’t use it." });
      if (which === "edit") setEditing(false);
    } catch (e) {
      toast.error("Couldn’t update the claim", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="group flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1 space-y-2">
        <p className={cn("text-body text-ink text-pretty", claim.state === "rejected" && "text-ink-3 line-through decoration-ink-3/60")}>{claim.text}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={claim.state === "verified" ? "success" : claim.state === "rejected" ? "failed" : "attention"}>{STATE_LABEL[claim.state]}</StatusPill>
          {claim.speculative ? (
            <Tooltip content="This claim goes beyond its evidence. Verify it only if you can back it up.">
              <span>
                <Badge tone="warning" icon={<AlertTriangle aria-hidden />}>
                  Beyond evidence
                </Badge>
              </span>
            </Tooltip>
          ) : null}
          <Badge tone="outline">{claim.origin === "user" ? "Added by you" : claim.origin === "agent" ? "Suggested by Muse" : "Extracted"}</Badge>
          <span className="text-caption tabular text-ink-3">{Math.round(claim.confidence * 100)}% confidence</span>
          <EvidencePopover workspaceId={workspaceId} items={evidence} />
        </div>
      </div>
      {canEdit ? (
        <div className="flex shrink-0 items-center gap-1.5 sm:pt-0.5">
          <IconButton label="Edit claim" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" aria-hidden />
          </IconButton>
          {canApprove && claim.state !== "rejected" ? (
            <Button size="sm" variant="ghost" loading={busy === "rejected"} onClick={() => patch({ state: "rejected" }, "rejected")} icon={<X className="size-3.5" aria-hidden />}>
              Reject
            </Button>
          ) : null}
          {canApprove && claim.state !== "verified" ? (
            <Button size="sm" variant="secondary" loading={busy === "verified"} onClick={() => patch({ state: "verified" }, "verified")} icon={<Check className="size-3.5" aria-hidden />}>
              Verify
            </Button>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Edit claim"
        description="Edited claims go back to review. Keep them specific and provable."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button loading={busy === "edit"} disabled={!text.trim() || text.trim() === claim.text} onClick={() => patch({ text: text.trim(), state: "needs_review" }, "edit")}>
              Save claim
            </Button>
          </>
        }
      >
        <Field label="Claim">{(f) => <Textarea id={f.id} rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />}</Field>
      </Dialog>
    </li>
  );
}

/** Verified product-claim library: verify / reject / edit, with evidence. */
export function ClaimsSection({ claims, evidence, workspaceId, appId, canEdit, canApprove }: { claims: Claim[]; evidence: AppEvidence[]; workspaceId: string; appId: string; canEdit: boolean; canApprove: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const counts = useMemo(() => ({ needs_review: claims.filter((c) => c.state === "needs_review").length, verified: claims.filter((c) => c.state === "verified").length, rejected: claims.filter((c) => c.state === "rejected").length }), [claims]);
  const [filter, setFilter] = useState<Filter>(counts.needs_review ? "needs_review" : "all");
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [saving, setSaving] = useState(false);
  const byId = useMemo(() => new Map(evidence.map((e) => [e.id, e])), [evidence]);
  const shown = claims.filter((c) => filter === "all" || c.state === filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<Filter>
          label="Filter claims"
          size="sm"
          value={filter}
          onChange={setFilter}
          items={[
            { value: "needs_review", label: `To review ${counts.needs_review}` },
            { value: "verified", label: `Verified ${counts.verified}` },
            { value: "rejected", label: `Rejected ${counts.rejected}` },
            { value: "all", label: "All" },
          ]}
        />
        {canEdit ? (
          <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setAdding(true)}>
            Add claim
          </Button>
        ) : null}
      </div>
      {canEdit && !canApprove && counts.needs_review ? <p className="text-footnote text-ink-2">An owner or admin verifies claims. You can edit wording or add new ones.</p> : null}
      {shown.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl bg-surface shadow-raised">
          {shown.map((c) => (
            <ClaimRow key={c.id} claim={c} evidence={c.evidenceIds.map((id) => byId.get(id)).filter((x): x is AppEvidence => Boolean(x))} workspaceId={workspaceId} appId={appId} canEdit={canEdit} canApprove={canApprove} />
          ))}
        </ul>
      ) : (
        <div className="rounded-xl bg-mist/60">
          <EmptyState
            size="sm"
            icon={<MessageSquareQuote aria-hidden />}
            title={claims.length ? "Nothing in this view" : "No claims yet"}
            description={claims.length ? "Switch filters to see other claims." : "Claims are statements creative can make about your app. They appear after analysis, or add your own."}
          />
        </div>
      )}
      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Add a claim"
        description={canApprove ? "Something true about your app you want campaigns to say, like “Syncs across iPhone and Mac”. Claims you add are verified straight away." : "Something true about your app you want campaigns to say, like “Syncs across iPhone and Mac”. It starts in review."}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              loading={saving}
              disabled={newText.trim().length < 4}
              onClick={async () => {
                setSaving(true);
                try {
                  await api.post(wsPath(workspaceId, `/apps/${appId}/claims`), { text: newText.trim() });
                  await invalidate(wsPath(workspaceId, `/apps/${appId}/dna`));
                  setNewText("");
                  setAdding(false);
                  toast.success("Claim added");
                } catch (e) {
                  toast.error("Couldn’t add the claim", errorMessage(e));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Add claim
            </Button>
          </>
        }
      >
        <Field label="Claim">{(f) => <Textarea id={f.id} rows={3} value={newText} onChange={(e) => setNewText(e.target.value)} maxLength={500} autoFocus />}</Field>
      </Dialog>
    </div>
  );
}
