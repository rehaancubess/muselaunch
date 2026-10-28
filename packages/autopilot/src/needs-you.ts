/**
 * "Needs you": the only things a person has to decide — publishing a post, sending outreach,
 * spending beyond a run's budget, or letting a loop continue — gathered into one list for one-tap
 * decisions. Read-only: every item names the existing decision route, which keeps its own permission
 * check (publish / outreach.send / billing.manage / content.approve) and snapshot-hash check.
 */
import { can, type Approval, type Capability, type NeedsYouItem, type WorkspaceMember } from "@muselaunch/contracts";
import { APPROVER_CAP, currentSubjectHash } from "@muselaunch/growth";
import type { Platform } from "@muselaunch/platform";
import { reasonText } from "./state";

type Member = Pick<WorkspaceMember, "role" | "canPublish" | "canManageAccounts" | "status">;

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ""));
const CHANNEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", linkedin: "LinkedIn", threads: "Threads", facebook: "Facebook", reddit: "Reddit", producthunt: "Product Hunt" };
const channelName = (c: string) => CHANNEL[c] ?? c.replace(/_/g, " ");

export async function needsYou(p: Platform, workspaceId: string, member: Member, opts: { appId?: string; limit?: number } = {}): Promise<{ items: NeedsYouItem[]; count: number }> {
  const ws = p.db.ws(workspaceId);
  const now = Date.now();
  const pending = (await ws.collection("approvals").list({ where: [["status", "==", "pending"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter(
    (a) => (!opts.appId || a.appId === opts.appId) && !(a.expiresAt && Date.parse(a.expiresAt) < now),
  );
  const ids = (entity: string) => [...new Set(pending.filter((a) => a.subject.entity === entity).map((a) => a.subject.id))];
  const [autopilots, posts, drafts, runs] = await Promise.all([
    ws.collection("autopilots").getMany(ids("autopilots")),
    ws.collection("scheduledPosts").getMany(ids("scheduledPosts")),
    ws.collection("outreachDrafts").getMany(ids("outreachDrafts")),
    ws.collection("agentRuns").getMany(ids("agentRuns")),
  ]);
  const comps = await ws.collection("compositions").getMany([...new Set(posts.flatMap((x) => (x.compositionId ? [x.compositionId] : [])))]);
  const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const [apMap, postMap, draftMap, runMap, compMap] = [byId(autopilots), byId(posts), byId(drafts), byId(runs), byId(comps)];
  const has = (cap: Capability) => can(member, cap);

  const items: NeedsYouItem[] = [];
  for (const a of pending) {
    const base = { id: a.id, action: a.action, appId: a.appId, createdAt: a.createdAt, subject: a.subject, credits: a.estimate?.credits, stale: false } satisfies Partial<NeedsYouItem>;
    const cap = APPROVER_CAP[a.action];
    const item = await toItem(a, base, cap);
    if (item) items.push(item);
  }
  // Decisions that block a running loop first, then posts in the order they'd go out.
  const rank = (i: NeedsYouItem) => (i.kind === "spend" || i.kind === "decision" ? 0 : 1);
  items.sort((a, b) => rank(a) - rank(b) || (a.preview?.scheduledAt ?? "\uffff").localeCompare(b.preview?.scheduledAt ?? "\uffff") || b.createdAt.localeCompare(a.createdAt));
  const limited = items.slice(0, opts.limit ?? 50);
  return { items: limited, count: items.length };

  async function toItem(a: Approval, base: Pick<NeedsYouItem, "id" | "action" | "appId" | "createdAt" | "subject" | "credits" | "stale">, cap: Capability): Promise<NeedsYouItem | null> {
    const appPath = a.appId ? `/a/${a.appId}` : "";
    switch (a.subject.entity) {
      case "autopilots": {
        const ap = apMap.get(a.subject.id);
        // Only the loop's live checkpoint is decidable; older requests were superseded.
        if (!ap || ap.status !== "awaiting_user" || ap.waitingOn.approvalId !== a.id) return null;
        const spend = a.action === "spend";
        return {
          ...base,
          kind: spend ? "spend" : "decision",
          autopilotId: ap.id,
          title: spend ? `Approve spending${a.estimate?.credits ? ` ≈${a.estimate.credits} credits` : ""}` : reasonText(ap.waitingOn.reason) || "Let Growth Autopilot continue?",
          summary: clip(a.summary, 1000),
          requiredCap: cap,
          // The checkpoint routes require content.approve plus the action's approver capability.
          canDecide: has("content.approve") && has(cap),
          approve: { path: `/autopilots/${ap.id}/checkpoint/approve`, body: {} },
          reject: { path: `/autopilots/${ap.id}/checkpoint/reject`, body: {} },
          reviewPath: `${appPath}/autopilot?loop=${encodeURIComponent(ap.id)}`,
        };
      }
      case "scheduledPosts": {
        const post = postMap.get(a.subject.id);
        if (!post || post.status !== "awaiting_approval" || post.approvalId !== a.id) return null;
        const current = await currentSubjectHash(ws, a.subject);
        const stale = current !== null && current !== a.snapshotHash;
        const comp = post.compositionId ? compMap.get(post.compositionId) : undefined;
        return {
          ...base,
          stale,
          kind: "post",
          title: `Post to ${channelName(post.channel)}${comp ? `: “${clip(comp.title, 80)}”` : ""}`,
          summary: clip(a.summary, 1000),
          requiredCap: cap,
          canDecide: has(cap),
          // Approving echoes the snapshot hash shown here; the route refuses it if the post changed.
          approve: stale ? null : { path: `/approvals/${a.id}/approve`, body: { snapshotHash: a.snapshotHash } },
          reject: { path: `/approvals/${a.id}/reject`, body: {} },
          reviewPath: `${appPath}/calendar`,
          preview: { channel: post.channel, caption: clip(post.caption, 2200), scheduledAt: post.scheduledAt, compositionId: post.compositionId, compositionTitle: comp ? clip(comp.title, 200) : undefined },
        };
      }
      case "outreachDrafts": {
        const d = draftMap.get(a.subject.id);
        if (!d || d.status !== "awaiting_approval" || d.approvalId !== a.id) return null;
        const current = await currentSubjectHash(ws, a.subject);
        const stale = current !== null && current !== a.snapshotHash;
        return {
          ...base,
          stale,
          kind: "outreach",
          title: `Send outreach${d.to ? ` to ${clip(d.to.value, 80)}` : ""}`,
          summary: clip(a.summary, 1000),
          requiredCap: cap,
          canDecide: has(cap),
          approve: stale ? null : { path: `/approvals/${a.id}/approve`, body: { snapshotHash: a.snapshotHash } },
          reject: { path: `/approvals/${a.id}/reject`, body: {} },
          reviewPath: `${appPath}/discover`,
          preview: { to: d.to?.value, subjectLine: d.subject ? clip(d.subject, 300) : undefined, caption: clip(d.body, 600) },
        };
      }
      case "agentRuns": {
        const run = runMap.get(a.subject.id);
        if (!run || run.status !== "needs_approval" || run.pendingApprovalId !== a.id) return null;
        return {
          ...base,
          kind: a.action === "spend" ? "spend" : "decision",
          title: a.action === "spend" ? `Approve spending${a.estimate?.credits ? ` ≈${a.estimate.credits} credits` : ""}` : "Approve Muse Wonder’s plan",
          summary: clip(a.summary, 1000),
          requiredCap: cap,
          canDecide: has(cap),
          approve: { path: `/agent-runs/${run.id}/approve`, body: {} },
          reject: { path: `/agent-runs/${run.id}/reject`, body: {} },
          reviewPath: `${appPath}/runs/${run.id}`,
        };
      }
      default:
        return null;
    }
  }
}
