"use client";
import type { Role, WorkspaceMember } from "@muselaunch/contracts";
import { Avatar, Badge, Button, Dialog, Field, IconButton, Input, Notice, PageHeader, Section, Select, Skeleton, Switch, Tooltip, useToast } from "@muselaunch/ui";
import { Check, Copy, UserMinus, UserPlus } from "lucide-react";
import { useState } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { InviteResponse, Page } from "@/lib/api-types";
import { useAuth } from "@/lib/auth/auth-provider";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";

const ROLE_HELP: Record<Exclude<Role, "owner">, string> = {
  admin: "Manage members, billing and settings, and approve content",
  editor: "Create campaigns, edit videos and manage the Library",
  viewer: "View everything, change nothing",
};

function MemberRow({ m, me, canManage, isOwner, path }: { m: WorkspaceMember; me?: string; canManage: boolean; isOwner: boolean; path: string }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const update = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.patch(`${path}/${m.id}`, body);
      await invalidate(path);
    } catch (e) {
      toast.error("Couldn’t update member", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const self = m.userId === me;
  const editable = canManage && m.role !== "owner" && !self;
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={m.displayName ?? m.email} size={36} />
        <div className="min-w-0">
          <p className="truncate text-body-sm font-medium">
            {m.displayName ?? m.email ?? m.userId}
            {self ? <span className="font-normal text-ink-3"> (you)</span> : null}
          </p>
          {m.displayName && m.email ? <p className="truncate text-footnote text-ink-2">{m.email}</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 md:justify-end">
        <Tooltip content={isOwner ? "Can publish posts and send outreach after approval" : "Only the owner can grant publishing"}>
          <label className="flex items-center gap-2 text-footnote text-ink-2">
            <Switch checked={m.role === "owner" || m.canPublish} disabled={!isOwner || m.role === "owner" || busy} onCheckedChange={(v) => update({ canPublish: v })} label={`Allow ${m.email ?? "member"} to publish`} />
            Publish
          </label>
        </Tooltip>
        <Tooltip content={isOwner ? "Can connect and disconnect social and analytics accounts" : "Only the owner can grant account access"}>
          <label className="flex items-center gap-2 text-footnote text-ink-2">
            <Switch checked={m.role === "owner" || m.canManageAccounts} disabled={!isOwner || m.role === "owner" || busy} onCheckedChange={(v) => update({ canManageAccounts: v })} label={`Allow ${m.email ?? "member"} to manage accounts`} />
            Accounts
          </label>
        </Tooltip>
        {m.role === "owner" ? (
          <Badge tone="neutral" className="w-28 justify-center">
            Owner
          </Badge>
        ) : (
          <div className="w-28">
            <Select aria-label="Role" selectSize="sm" value={m.role} disabled={!editable || busy} onChange={(e) => update({ role: e.target.value })} options={(["admin", "editor", "viewer"] as const).map((r) => ({ value: r, label: r[0]!.toUpperCase() + r.slice(1) }))} />
          </div>
        )}
        {editable ? (
          <IconButton label={`Remove ${m.email ?? "member"}`} size="sm" onClick={() => setConfirm(true)}>
            <UserMinus className="size-4" aria-hidden />
          </IconButton>
        ) : (
          <span className="w-7" aria-hidden />
        )}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        size="sm"
        title={`Remove ${m.displayName ?? m.email ?? "this member"}?`}
        description="They lose access to this workspace immediately. Their work stays."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.del(`${path}/${m.id}`);
                  await invalidate(path);
                  setConfirm(false);
                } catch (e) {
                  toast.error("Couldn’t remove", errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove
            </Button>
          </>
        }
      />
    </li>
  );
}

function InviteDialog({ open, onOpenChange, workspaceId }: { open: boolean; onOpenChange: (v: boolean) => void; workspaceId: string }) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Exclude<Role, "owner">>("editor");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InviteResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setResult(null);
      setEmail("");
      setCopied(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={result ? "Share this invite link" : "Invite a teammate"}
      description={result ? `Email delivery isn’t set up yet, so send this link to ${result.invite.email} yourself. It works once and expires in 7 days.` : "They’ll sign in with this email address to join."}
      footer={
        result ? (
          <Button onClick={() => close(false)}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!/^\S+@\S+\.\S+$/.test(email)}
              onClick={async () => {
                setBusy(true);
                try {
                  setResult(await api.post<InviteResponse>(wsPath(workspaceId, "/invites"), { email: email.trim(), role }));
                } catch (e) {
                  toast.error("Couldn’t create the invite", errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create invite
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-mist p-2 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-footnote text-ink">{result.acceptUrl}</code>
            <Button
              size="sm"
              variant={copied ? "secondary" : "primary"}
              icon={copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              onClick={() =>
                navigator.clipboard.writeText(result.acceptUrl).then(
                  () => setCopied(true),
                  () => toast.error("Couldn’t copy", "Select the link and copy it manually."),
                )
              }
            >
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
          <p className="text-footnote text-ink-2">This link is shown only now. Create a new invite if it’s lost.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Email">{(f) => <Input id={f.id} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus placeholder="teammate@studio.dev" />}</Field>
          <Field label="Role" hint={ROLE_HELP[role]}>
            {(f) => <Select id={f.id} aria-describedby={f.describedBy} value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, "owner">)} options={(["admin", "editor", "viewer"] as const).map((r) => ({ value: r, label: r[0]!.toUpperCase() + r.slice(1) }))} />}
          </Field>
          <p className="text-footnote text-ink-2">Publishing and account access are granted separately by the owner after they join.</p>
        </div>
      )}
    </Dialog>
  );
}

export default function TeamPage() {
  const { workspaceId, can, member } = useWorkspace();
  const { user } = useAuth();
  const path = wsPath(workspaceId, "/members");
  const q = useApiQuery<Page<WorkspaceMember>>(path);
  const [inviteOpen, setInviteOpen] = useState(false);
  const canManage = can("members.manage");
  return (
    <div className="space-y-10">
      <PageHeader
        title="Team"
        description="Roles decide what people can make. Publishing and connecting accounts are separate permissions only the owner can grant."
        className="pb-0"
        actions={
          canManage ? (
            <Button icon={<UserPlus className="size-4" aria-hidden />} onClick={() => setInviteOpen(true)}>
              Invite
            </Button>
          ) : null
        }
      />
      <Section title="Members">
        <QueryState
          query={q}
          feature="Members"
          skeleton={
            <div className="space-y-px overflow-hidden rounded-xl shadow-raised">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-16 rounded-none" />
              ))}
            </div>
          }
        >
          {(data) => (
            <ul className="divide-y divide-line overflow-hidden rounded-xl bg-surface shadow-raised">
              {data.items.map((m) => (
                <MemberRow key={m.id} m={m} me={user?.uid} canManage={canManage} isOwner={member?.role === "owner"} path={path} />
              ))}
            </ul>
          )}
        </QueryState>
        {!canManage ? <Notice>Only owners and admins can invite or change members.</Notice> : null}
      </Section>
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} workspaceId={workspaceId} />
    </div>
  );
}
