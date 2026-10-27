"use client";
import { Badge, Button, Checkbox, Field, Input, JobProgress, Notice, ProvenanceBadge, Sheet, Skeleton, StatusPill, statusKindOf, useToast } from "@muselaunch/ui";
import { CheckCircle2, Copy, Download, ExternalLink, Package, Send, Undo2, X } from "lucide-react";
import { useState } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useJob } from "@/lib/jobs";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useMemberName, useWorkspace } from "@/lib/workspace";
import { ApprovalCard } from "./approval-card";
import type { JobOut, ManualPackage, PostView } from "./types";

export const POST_STATUS_KIND = (s: string) =>
  s === "published" || s === "manually_posted" ? "success" : s === "manual_post_needed" || s === "awaiting_approval" ? "attention" : s === "publishing" ? "running" : s === "scheduled" ? "success" : statusKindOf(s);

function copyText(text: string, toast: ReturnType<typeof useToast>) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success("Copied"),
    () => toast.error("Couldn’t copy", "Select the text and copy it manually."),
  );
}

/** One post: status, preflight, approval, API publish or the manual checklist + "Mark as posted". */
export function PostSheet({ postId, onOpenChange }: { postId: string | null; onOpenChange: (open: boolean) => void }) {
  const { workspaceId } = useWorkspace();
  const path = postId ? wsPath(workspaceId, `/posts/${postId}`) : null;
  const q = useApiQuery<PostView>(path, { refetchInterval: (query) => (query.state.data?.post.status === "publishing" ? 4000 : false) });
  return (
    <Sheet open={Boolean(postId)} onOpenChange={onOpenChange} title={q.data ? `${CHANNEL_LABEL[q.data.post.channel]} post` : "Post"} description={q.data?.statusLabel} width="max-w-xl">
      <div className="p-5">
        {postId ? (
          <QueryState query={q} feature="Post" skeleton={<Skeleton className="h-64 w-full" rounded="xl" />}>
            {(view) => <PostBody view={view} />}
          </QueryState>
        ) : null}
      </div>
    </Sheet>
  );
}

function PostBody({ view }: { view: PostView }) {
  const { workspaceId, can } = useWorkspace();
  const nameOf = useMemberName();
  const toast = useToast();
  const invalidate = useInvalidate();
  const { post, approval, publication, account, preflight } = view;
  const [busy, setBusy] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const refresh = () => invalidate(wsPath(workspaceId, `/posts/${post.id}`), wsPath(workspaceId, `/apps/${post.appId}/calendar`), wsPath(workspaceId, "/approvals"));
  const job = useJob(workspaceId, jobId, { onSettled: () => void refresh() });

  const act = async (name: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(name);
    try {
      await fn();
      if (done) toast.success(done);
      await refresh();
    } catch (e) {
      toast.error("That didn’t work", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const P = (suffix: string) => wsPath(workspaceId, `/posts/${post.id}${suffix}`);
  const terminal = ["published", "manually_posted", "cancelled"].includes(post.status);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={POST_STATUS_KIND(post.status)}>{view.statusLabel}</StatusPill>
        {post.mode === "api" ? <Badge tone="outline">Via API{account ? ` · ${account.displayName}` : ""}</Badge> : <ProvenanceBadge kind="manual_only" label="You post it" />}
        {post.containsSyntheticMedia ? <Badge tone="accent">AI-media disclosure on</Badge> : null}
        <Badge tone="neutral">{post.visibility}</Badge>
      </div>

      <section className="space-y-2">
        {post.title ? <p className="text-headline font-semibold">{post.title}</p> : null}
        <p className="whitespace-pre-wrap text-body-sm text-ink">{post.caption}</p>
        {post.tags.length ? <p className="text-footnote text-ink-2">{post.tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ")}</p> : null}
        <p className="text-caption text-ink-3">
          {post.scheduledAt ? `Scheduled ${new Date(post.scheduledAt).toLocaleString()} (${post.timezone})` : "No time set"}
          {post.suggestedTimeReason ? ` · Suggestion: ${post.suggestedTimeReason}` : ""}
        </p>
      </section>

      {publication ? (
        <Notice tone="success" icon={<CheckCircle2 aria-hidden />} title={publication.mode === "api" ? "Published via API" : "Posted manually (you confirmed it)"}>
          <div className="space-y-1">
            {publication.remoteUrl ? (
              <a className="inline-flex items-center gap-1 underline" href={publication.remoteUrl} target="_blank" rel="noopener noreferrer">
                Open post <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}
            <p className="text-caption">
              {publication.mode === "api" ? `Receipt: ${publication.remoteId}` : `Confirmed by ${nameOf(publication.confirmedBy)}`} · {new Date(publication.publishedAt).toLocaleString()}
            </p>
            {Array.isArray((publication.receipt as { notes?: string[] } | undefined)?.notes)
              ? ((publication.receipt as { notes: string[] }).notes.map((n) => (
                  <p key={n} className="text-caption">
                    {n}
                  </p>
                )))
              : null}
          </div>
        </Notice>
      ) : null}

      {post.lastError && !terminal ? <Notice tone={post.status === "failed" ? "danger" : "warning"}>{post.lastError}</Notice> : null}
      {preflight.errors.length && !terminal ? (
        <Notice tone="danger" title="Fix before approval">
          <ul className="list-disc pl-4">
            {preflight.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {preflight.warnings.length && !terminal ? (
        <Notice tone="warning">
          <ul className="list-disc pl-4">
            {preflight.warnings.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {approval ? <ApprovalCard approval={approval} currentHash={view.snapshotHash} onDecided={() => void refresh()} /> : null}
      {jobId ? <JobProgress job={job.job} title="Publishing" onRetry={undefined} /> : null}

      {!terminal ? (
        <div className="flex flex-wrap gap-2">
          {["draft", "failed"].includes(post.status) || (post.status === "awaiting_approval" && approval?.status !== "pending") ? (
            <Button onClick={() => act("request", () => api.post(P("/request-approval")), "Approval requested")} loading={busy === "request"} disabled={preflight.errors.length > 0}>
              Request approval
            </Button>
          ) : null}
          {post.mode === "api" && post.status === "scheduled" ? (
            <Button
              icon={<Send aria-hidden />}
              disabled={!can("publish")}
              loading={busy === "publish"}
              onClick={() =>
                act("publish", async () => {
                  const r = await api.post<JobOut>(P("/publish"), {}, { idempotent: true });
                  setJobId(r.job.id);
                })
              }
            >
              Publish now
            </Button>
          ) : null}
          {post.mode === "api" && !["publishing"].includes(post.status) ? (
            <Button variant="outline" icon={<Undo2 aria-hidden />} loading={busy === "manual"} onClick={() => act("manual", () => api.post(P("/switch-to-manual")), "Switched to manual posting")}>
              Post manually instead
            </Button>
          ) : null}
          {post.status !== "publishing" ? (
            <Button variant="ghost" icon={<X aria-hidden />} loading={busy === "cancel"} onClick={() => act("cancel", () => api.post(P("/cancel")), "Post cancelled")}>
              Cancel post
            </Button>
          ) : null}
        </div>
      ) : null}

      {(post.mode === "manual" || post.status === "manual_post_needed") && !terminal ? <ManualChecklist postId={post.id} canPost={can("publish")} approved={post.status === "manual_post_needed"} onDone={refresh} /> : null}
    </div>
  );
}

function ManualChecklist({ postId, canPost, approved, onDone }: { postId: string; canPost: boolean; approved: boolean; onDone: () => Promise<unknown> }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const path = wsPath(workspaceId, `/posts/${postId}/manual`);
  const q = useApiQuery<ManualPackage>(path, { refetchInterval: (query) => (query.state.data?.package && ["queued", "running"].includes(query.state.data.package.status) ? 4000 : false) });
  const invalidate = useInvalidate();
  const [done, setDone] = useState<Record<number, boolean>>({});
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [reminder, setReminder] = useState("");

  const markPosted = async () => {
    setBusy("mark");
    try {
      await api.post(wsPath(workspaceId, `/posts/${postId}/mark-posted`), { url });
      toast.success("Marked as posted", "Insights will attribute this post’s results.");
      await onDone();
    } catch (e) {
      toast.error("Couldn’t mark as posted", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <QueryState query={q} feature="Posting package">
      {(m) => (
        <section className="space-y-4 rounded-xl border border-line p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-body font-semibold">Post it yourself</h3>
            <ProvenanceBadge kind="manual_only" />
          </div>
          <ol className="space-y-2">
            {m.instructions.map((s, i) => (
              <li key={s}>
                <Checkbox checked={Boolean(done[i])} onCheckedChange={(v) => setDone((d) => ({ ...d, [i]: v }))} label={<span className="text-body-sm">{s}</span>} />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            {m.downloads.map((d) => (
              <Button key={d.assetId} asChild size="sm" variant="secondary">
                <a href={d.url} download={d.filename}>
                  <Download className="size-3.5" aria-hidden /> {d.filename}
                </a>
              </Button>
            ))}
            <Button size="sm" variant="secondary" icon={<Copy aria-hidden />} onClick={() => copyText([m.copy.title, m.copy.caption, m.copy.trackingUrl].filter(Boolean).join("\n\n"), toast)}>
              Copy caption
            </Button>
            {m.package?.url ? (
              <Button asChild size="sm" variant="secondary">
                <a href={m.package.url}>
                  <Package className="size-3.5" aria-hidden /> Export package (.zip)
                </a>
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                icon={<Package aria-hidden />}
                loading={busy === "pkg" || (m.package ? ["queued", "running"].includes(m.package.status) : false)}
                onClick={async () => {
                  setBusy("pkg");
                  try {
                    await api.post(wsPath(workspaceId, `/posts/${postId}/package`), {}, { idempotent: true });
                    await invalidate(path);
                  } catch (e) {
                    toast.error("Couldn’t start the export", errorMessage(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Build export package
              </Button>
            )}
          </div>
          {m.package?.status === "failed" ? <Notice tone="warning">The export package couldn’t be built ({m.package.error ?? "error"}). The direct downloads above still work.</Notice> : null}
          {m.copy.trackingUrl ? <p className="text-footnote text-ink-2">Tracked link for this post: {m.copy.trackingUrl}</p> : null}

          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Link to the published post" hint={approved ? "Paste the post URL after it’s live." : "Approve this post first."}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!approved || !canPost} />}
            </Field>
            <Button onClick={markPosted} loading={busy === "mark"} disabled={!approved || !canPost || !/^https?:\/\//.test(url)}>
              Mark as posted
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Reminder" optional hint={m.post.reminderAt ? `Set for ${new Date(m.post.reminderAt).toLocaleString()} (shown in the calendar)` : "Shown in the calendar when it’s due."}>
              {({ id }) => <Input id={id} type="datetime-local" value={reminder} onChange={(e) => setReminder(e.target.value)} />}
            </Field>
            <Button
              variant="outline"
              disabled={!reminder}
              loading={busy === "rem"}
              onClick={async () => {
                setBusy("rem");
                try {
                  await api.post(wsPath(workspaceId, `/posts/${postId}/reminder`), { at: new Date(reminder).toISOString() });
                  toast.success("Reminder set");
                  await invalidate(path);
                } catch (e) {
                  toast.error("Couldn’t set the reminder", errorMessage(e));
                } finally {
                  setBusy(null);
                }
              }}
            >
              Remind me
            </Button>
          </div>
        </section>
      )}
    </QueryState>
  );
}
