"use client";
import type { Channel, OutreachDraft } from "@muselaunch/contracts";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, JobProgress, List, ListRow, Notice, Section, Select, Sheet, Skeleton, SourceChip, StatusPill, Textarea, statusKindOf, useToast } from "@muselaunch/ui";
import { Copy, Mail, PenLine, Plus, Send, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { QueryState } from "@/components/states";
import { BrandGuardianBadge, GuardedApprovalButton } from "@/features/guardian";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { ApprovalCard } from "../publishing/approval-card";
import type { DraftView, JobOut, ProspectView } from "../publishing/types";

const STATUS_LABEL: Record<ProspectView["status"], string> = {
  suggested: "Suggested",
  drafted: "Drafted",
  awaiting_review: "In review",
  contacted: "Contacted",
  replied: "Replied",
  negotiating: "Negotiating",
  declined: "Declined",
  successful: "Successful",
  archived: "Archived",
};
const PIPELINE: ProspectView["status"][] = ["suggested", "drafted", "awaiting_review", "contacted", "replied", "negotiating", "successful"];

/** Creator CRM: prospects with evidence + public contact routes, pitch drafting and approval-gated sending. */
export function ProspectsPanel({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const q = useApiQuery<Page<ProspectView>>(wsPath(workspaceId, `/apps/${appId}/prospects`), { query: status ? { status } : undefined });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          selectSize="sm"
          options={[{ value: "", label: "All stages" }, ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))]}
        />
        <Button variant="outline" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          Add creator
        </Button>
      </div>
      <QueryState query={q} feature="Creators">
        {(page) =>
          page.items.length ? (
            <List label="Creator prospects">
              {page.items.map((p) => (
                <ListRow
                  key={p.id}
                  onClick={() => setOpen(p.id)}
                  title={`${p.displayName ?? p.handle} · ${CHANNEL_LABEL[p.channel]}`}
                  subtitle={`${p.niche}${p.relevanceReasons[0] ? ` · ${p.relevanceReasons[0]}` : ""}`}
                  trailing={
                    <>
                      <Badge tone="outline" title="Relevance score from research">
                        {Math.round(p.relevanceScore)}
                      </Badge>
                      {p.publicContacts.length ? <Badge tone="neutral" icon={<Mail aria-hidden />}>{p.publicContacts.length}</Badge> : <Badge tone="warning">No public contact</Badge>}
                      <StatusPill status={statusKindOf(p.status === "successful" ? "completed" : p.status === "declined" ? "cancelled" : p.status === "contacted" ? "running" : p.status)}>{STATUS_LABEL[p.status]}</StatusPill>
                    </>
                  }
                />
              ))}
            </List>
          ) : (
            <EmptyState
              icon={<Users aria-hidden />}
              title="No creator prospects yet"
              description="Research suggests creators whose audience matches your app, with the public pages that show it. You can also add a creator you know."
            />
          )
        }
      </QueryState>
      <ProspectSheet prospectId={open} onOpenChange={(o) => (o ? null : setOpen(null))} />
      <AddProspectDialog appId={appId} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function AddProspectDialog({ appId, open, onOpenChange }: { appId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [form, setForm] = useState({ channel: "youtube" as Channel, handle: "", url: "", niche: "", displayName: "" });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post(wsPath(workspaceId, `/apps/${appId}/prospects`), { ...form, displayName: form.displayName || undefined });
      await invalidate(wsPath(workspaceId, `/apps/${appId}/prospects`));
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn’t add the creator", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a creator"
      footer={
        <Button onClick={save} loading={saving} disabled={!form.handle || !/^https?:\/\//.test(form.url) || !form.niche}>
          Add
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Channel">
            {({ id }) => <Select id={id} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as Channel })} options={(["youtube", "instagram", "tiktok", "x", "linkedin", "threads", "other"] as Channel[]).map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />}
          </Field>
          <Field label="Handle">{({ id }) => <Input id={id} value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} />}</Field>
        </div>
        <Field label="Public profile URL">{({ id }) => <Input id={id} placeholder="https://" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />}</Field>
        <Field label="What they make" hint="Their niche or format, in your words.">
          {({ id }) => <Input id={id} value={form.niche} onChange={(e) => setForm({ ...form, niche: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

function ProspectSheet({ prospectId, onOpenChange }: { prospectId: string | null; onOpenChange: (o: boolean) => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const path = prospectId ? wsPath(workspaceId, `/prospects/${prospectId}`) : null;
  const q = useApiQuery<{ prospect: ProspectView; drafts: OutreachDraft[] }>(path);
  const [contact, setContact] = useState({ kind: "email", value: "", sourceUrl: "" });
  const [offer, setOffer] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const refresh = () => invalidate(path ?? "", wsPath(workspaceId, "/apps"));
  const job = useJob(workspaceId, jobId, { onSettled: () => void refresh() });

  return (
    <Sheet open={Boolean(prospectId)} onOpenChange={onOpenChange} title={q.data ? (q.data.prospect.displayName ?? q.data.prospect.handle) : "Creator"} description={q.data ? `${CHANNEL_LABEL[q.data.prospect.channel]} · ${q.data.prospect.niche}` : undefined} width="max-w-2xl">
      <div className="space-y-7 p-5">
        {prospectId ? (
          <QueryState query={q} feature="Creator" skeleton={<Skeleton className="h-64 w-full" rounded="xl" />}>
            {({ prospect, drafts }) => (
              <>
                <Section title="Why this creator">
                  <ul className="list-disc space-y-1 pl-5 text-body-sm">
                    {prospect.relevanceReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-1.5">
                    {prospect.evidence.map((s) => (
                      <SourceChip key={s.url ?? s.title} source={s} />
                    ))}
                  </div>
                </Section>

                <Section title="Stage">
                  <Select
                    aria-label="Stage"
                    value={prospect.status}
                    selectSize="sm"
                    onChange={async (e) => {
                      try {
                        await api.patch(wsPath(workspaceId, `/prospects/${prospect.id}`), { status: e.target.value });
                        await refresh();
                      } catch (err) {
                        toast.error("Couldn’t update", errorMessage(err));
                      }
                    }}
                    options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label, disabled: ["drafted", "awaiting_review", "contacted"].includes(value) && value !== prospect.status }))}
                  />
                  <div className="flex flex-wrap gap-1 text-caption text-ink-3">{PIPELINE.map((s) => (s === prospect.status ? <b key={s}>{STATUS_LABEL[s]}</b> : <span key={s}>{STATUS_LABEL[s]}</span>)).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, " → ", el] : [el]), [])}</div>
                </Section>

                <Section title="Public contact routes" description="Only routes the creator lists publicly, each with where it’s listed. MuseLaunch never guesses emails.">
                  {prospect.publicContacts.length ? (
                    <ul className="space-y-2">
                      {prospect.publicContacts.map((c, i) => (
                        <li key={`${c.kind}-${c.value}`} className="flex flex-wrap items-center gap-2 text-body-sm">
                          <Badge tone="outline">{c.kind.replace("_", " ")}</Badge> <span className="font-medium">{c.value}</span> <SourceChip source={c.source} compact />
                          <span className="sr-only">route {i + 1}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Notice tone="neutral">No publicly listed contact route found yet.</Notice>
                  )}
                  {prospect.hiddenUnsourcedContacts ? <p className="text-caption text-ink-3">{prospect.hiddenUnsourcedContacts} unsourced contact suggestion(s) hidden.</p> : null}
                  <div className="grid gap-2 sm:grid-cols-[120px_1fr_1fr_auto] sm:items-end">
                    <Select
                      aria-label="Contact type"
                      selectSize="sm"
                      value={contact.kind}
                      onChange={(e) => setContact({ ...contact, kind: e.target.value })}
                      options={["email", "business_inquiry", "contact_form", "dm", "website"].map((k) => ({ value: k, label: k.replace("_", " ") }))}
                    />
                    <Input className="h-8" placeholder="Contact (as listed)" value={contact.value} onChange={(e) => setContact({ ...contact, value: e.target.value })} aria-label="Contact value" />
                    <Input className="h-8" placeholder="Where it’s listed (URL)" value={contact.sourceUrl} onChange={(e) => setContact({ ...contact, sourceUrl: e.target.value })} aria-label="Source URL" />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!contact.value || !/^https?:\/\//.test(contact.sourceUrl)}
                      onClick={async () => {
                        try {
                          await api.post(wsPath(workspaceId, `/prospects/${prospect.id}/contacts`), contact);
                          setContact({ kind: "email", value: "", sourceUrl: "" });
                          await refresh();
                        } catch (e) {
                          toast.error("Couldn’t add the contact", errorMessage(e));
                        }
                      }}
                    >
                      Add
                    </Button>
                  </div>
                </Section>

                <Section title="Pitches" description="Each pitch references the creator’s real format and only your verified claims. Every send needs its own approval.">
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                    <Field label="Your offer" optional hint="Leave empty and the AI suggests one for you to confirm.">
                      {({ id }) => <Input id={id} placeholder="e.g. A free year of Premium" value={offer} onChange={(e) => setOffer(e.target.value)} />}
                    </Field>
                    <Button
                      icon={<PenLine aria-hidden />}
                      onClick={async () => {
                        try {
                          const r = await api.post<JobOut>(wsPath(workspaceId, `/apps/${prospect.appId}/prospects/draft`), { prospectIds: [prospect.id], offer: offer || undefined }, { idempotent: true });
                          setJobId(r.job.id);
                        } catch (e) {
                          toast.error("Couldn’t start drafting", errorMessage(e));
                        }
                      }}
                    >
                      Draft a pitch
                    </Button>
                  </div>
                  {jobId ? <JobProgress job={job.job} title="Drafting pitch" variant="row" /> : null}
                  <div className="space-y-4">
                    {drafts.map((d) => (
                      <DraftCard key={d.id} draftId={d.id} onChanged={refresh} />
                    ))}
                  </div>
                </Section>
              </>
            )}
          </QueryState>
        ) : null}
      </div>
    </Sheet>
  );
}

function DraftCard({ draftId, onChanged }: { draftId: string; onChanged: () => Promise<unknown> }) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const path = wsPath(workspaceId, `/outreach/drafts/${draftId}`);
  const q = useApiQuery<DraftView>(path);
  const [edit, setEdit] = useState<{ subject: string; body: string; offer: string } | null>(null);
  const [copied, setCopied] = useState<{ to?: { value: string }; subject?: string; body: string; instructions: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const refresh = () => Promise.all([invalidate(path), onChanged()]);
  const job = useJob(workspaceId, jobId, { onSettled: () => void refresh() });
  const run = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name);
    try {
      await fn();
      if (ok) toast.success(ok);
      await refresh();
    } catch (e) {
      toast.error("That didn’t work", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const D = (s: string) => wsPath(workspaceId, `/outreach/drafts/${draftId}${s}`);

  return (
    <QueryState query={q} feature="Draft" skeleton={<Skeleton className="h-40 w-full" rounded="xl" />}>
      {({ draft, approval, snapshotHash }) => (
        <Card tone="raised" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={statusKindOf(draft.status === "sent" ? "completed" : draft.status === "awaiting_approval" ? "needs_approval" : draft.status)}>{draft.status.replace("_", " ")}</StatusPill>
            {draft.to ? (
              <Badge tone="outline" icon={<Mail aria-hidden />}>
                {draft.to.value}
              </Badge>
            ) : (
              <Badge tone="warning">No public contact route</Badge>
            )}
            {draft.offerSource === "ai_suggested" ? <Badge tone="warning">Offer suggested by AI</Badge> : null}
            {draft.validation ? <Badge tone={draft.validation.ok ? "success" : "danger"}>{draft.validation.ok ? `Claims OK (${draft.validation.validator === "spark" ? "Spark check" : "rule check"})` : `${draft.validation.issues.length} claim issue(s)`}</Badge> : null}
          </div>
          {edit ? (
            <div className="space-y-2">
              <Input aria-label="Subject" value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
              <Textarea aria-label="Message" rows={8} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
              <Input aria-label="Offer" value={edit.offer} onChange={(e) => setEdit({ ...edit, offer: e.target.value })} />
              <div className="flex gap-2">
                <Button size="sm" loading={busy === "save"} onClick={() => run("save", async () => (await api.patch(D(""), edit), setEdit(null)), "Saved and re-checked")}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {draft.subject ? <p className="text-body-sm font-semibold">{draft.subject}</p> : null}
              <p className="whitespace-pre-wrap text-body-sm text-ink">{draft.body}</p>
              {draft.offer ? <p className="text-footnote text-ink-2">Offer: {draft.offer}</p> : null}
            </div>
          )}
          {draft.validation && !draft.validation.ok ? (
            <Notice tone="danger" title="Fix before approval">
              <ul className="list-disc pl-4">
                {draft.validation.issues.map((i) => (
                  <li key={`${i.id}:${i.issue}`}>{i.issue}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {["draft", "failed", "awaiting_approval"].includes(draft.status) && !edit ? <BrandGuardianBadge subject={{ entity: "outreachDrafts", id: draft.id }} /> : null}
          {approval && draft.status !== "sent" ? <ApprovalCard approval={approval} currentHash={snapshotHash} compact onDecided={() => void refresh()} /> : null}
          {jobId ? <JobProgress job={job.job} title="Sending" variant="row" /> : null}
          {copied ? (
            <Notice tone="info" title="Send it yourself">
              <ul className="list-disc space-y-1 pl-4">
                {copied.instructions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {draft.status === "sent" ? (
            <p className="text-footnote text-ink-2">
              Sent {draft.sentAt ? new Date(draft.sentAt).toLocaleString() : ""} · {(draft.sendReceipt as { mode?: string } | undefined)?.mode === "manual_confirmed" ? "confirmed by you" : "via Gmail"}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!edit && ["draft", "failed", "awaiting_approval", "approved", "copied_manual"].includes(draft.status) ? (
                <Button size="sm" variant="ghost" icon={<PenLine aria-hidden />} onClick={() => setEdit({ subject: draft.subject ?? "", body: draft.body, offer: draft.offer ?? "" })}>
                  Edit
                </Button>
              ) : null}
              {["draft", "failed"].includes(draft.status) ? (
                // Brand Guardian (module G) gates approval requests; a blocked review asks for an override reason.
                <GuardedApprovalButton size="sm" path={D("/request-approval")} onDone={refresh} disabled={!draft.validation?.ok || !draft.to} />
              ) : null}
              {["approved", "copied_manual"].includes(draft.status) && can("outreach.send") ? (
                <>
                  {draft.to?.kind === "email" ? (
                    <Button size="sm" icon={<Send aria-hidden />} loading={busy === "send"} onClick={() => run("send", async () => setJobId((await api.post<JobOut>(D("/send"), {}, { idempotent: true })).job.id))}>
                      Send via Gmail
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Copy aria-hidden />}
                    loading={busy === "copy"}
                    onClick={() =>
                      run("copy", async () => {
                        const r = await api.post<{ copy: { to?: { value: string }; subject?: string; body: string }; instructions: string[] }>(D("/copy"));
                        await navigator.clipboard?.writeText([r.copy.subject, r.copy.body].filter(Boolean).join("\n\n")).catch(() => undefined);
                        setCopied({ ...r.copy, instructions: r.instructions });
                      }, "Message copied")
                    }
                  >
                    Copy & send manually
                  </Button>
                  <Button size="sm" variant="secondary" loading={busy === "mark"} onClick={() => run("mark", () => api.post(D("/mark-sent"), {}), "Marked as sent")}>
                    Mark as sent
                  </Button>
                </>
              ) : null}
            </div>
          )}
        </Card>
      )}
    </QueryState>
  );
}
