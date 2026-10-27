import { can, type Approval, type ApprovalAction, type Capability, type EntityRef, type OutreachDraft, type ScheduledPost, type WorkspaceMember } from "@muselaunch/contracts";
import { nowIso, type WorkspaceDb } from "@muselaunch/db";
import { AppError } from "@muselaunch/platform";
import { DAY_MS, hashOf } from "./util";

/**
 * Approval checkpoints (spec principle 4). An approval authorises ONE exact snapshot of a subject:
 * any content change produces a different hash, so execution refuses it. Approvals are consumed
 * by the action they authorise and never reused.
 */

export const APPROVAL_TTL_MS = 14 * DAY_MS;

/** Capability the approver needs for each action. */
export const APPROVER_CAP: Record<ApprovalAction, Capability> = {
  publish: "publish",
  outreach_send: "outreach.send",
  account_change: "accounts.manage",
  spend: "billing.manage",
  claim_use: "content.approve",
  render_over_budget: "content.approve",
  agent_continue: "content.approve",
};

/** Content snapshot of a post: everything that ends up on the channel (not the time slot). */
export async function postSnapshot(ws: WorkspaceDb, post: ScheduledPost) {
  const assets = await ws.collection("mediaAssets").getMany([...post.assetIds, ...(post.thumbnailAssetId ? [post.thumbnailAssetId] : [])]);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const assetFingerprint = (id: string) => {
    const a = byId.get(id);
    return a ? { id, sha256: a.sha256, bytes: a.bytes, path: a.sha256 ? undefined : a.storagePath, status: a.status } : { id, missing: true };
  };
  const snapshot = {
    v: 1,
    kind: "scheduledPost",
    id: post.id,
    channel: post.channel,
    mode: post.mode,
    accountId: post.accountId,
    title: post.title,
    caption: post.caption,
    tags: post.tags,
    visibility: post.visibility,
    containsSyntheticMedia: post.containsSyntheticMedia,
    compositionId: post.compositionId,
    compositionVersion: post.compositionVersion,
    assets: post.assetIds.map(assetFingerprint),
    thumbnail: post.thumbnailAssetId ? assetFingerprint(post.thumbnailAssetId) : undefined,
    trackingLinkId: post.trackingLinkId,
  };
  return { snapshot, hash: hashOf(snapshot) };
}

export function draftSnapshot(draft: OutreachDraft) {
  const snapshot = { v: 1, kind: "outreachDraft", id: draft.id, prospectId: draft.prospectId, channel: draft.channel, to: draft.to ? { kind: draft.to.kind, value: draft.to.value } : undefined, subject: draft.subject, body: draft.body, offer: draft.offer };
  return { snapshot, hash: hashOf(snapshot) };
}

/** Current hash of an approval subject, or null when this module can't compute it (other modules' subjects). */
export async function currentSubjectHash(ws: WorkspaceDb, subject: EntityRef): Promise<string | null> {
  if (subject.entity === "scheduledPosts") {
    const post = await ws.collection("scheduledPosts").get(subject.id);
    return post ? (await postSnapshot(ws, post)).hash : "missing";
  }
  if (subject.entity === "outreachDrafts") {
    const d = await ws.collection("outreachDrafts").get(subject.id);
    return d ? draftSnapshot(d).hash : "missing";
  }
  return null;
}

const isExpired = (a: Approval, now = Date.now()) => Boolean(a.expiresAt && Date.parse(a.expiresAt) < now);

/** Pending/approved approvals for a subject (newest first). */
async function approvalsFor(ws: WorkspaceDb, subject: EntityRef, appId?: string): Promise<Approval[]> {
  const page = await ws.collection("approvals").list(appId ? { where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 } : { limit: 500 });
  return page.items.filter((a) => a.subject.entity === subject.entity && a.subject.id === subject.id);
}

/** Expire every open approval of a subject (content changed or post cancelled). */
export async function expireApprovals(ws: WorkspaceDb, subject: EntityRef, appId: string | undefined, actor: string, note: string): Promise<number> {
  let n = 0;
  for (const a of await approvalsFor(ws, subject, appId)) {
    if (a.status === "pending" || a.status === "approved") {
      await ws.collection("approvals").update(a.id, { status: "expired", note: note.slice(0, 1000) }, { actor });
      n++;
    }
  }
  return n;
}

/** Create (or return the identical pending) approval request for the subject's current snapshot. */
export async function requestApproval(
  ws: WorkspaceDb,
  input: { appId?: string; action: ApprovalAction; subject: EntityRef; hash: string; summary: string; actor: string; estimate?: Approval["estimate"] },
): Promise<Approval> {
  const existing = await approvalsFor(ws, input.subject, input.appId);
  const same = existing.find((a) => (a.status === "pending" || a.status === "approved") && a.snapshotHash === input.hash && a.action === input.action && !isExpired(a));
  if (same) return same;
  for (const a of existing) {
    if (a.status === "pending" || a.status === "approved") await ws.collection("approvals").update(a.id, { status: "expired", note: "Superseded by a newer request" }, { actor: input.actor });
  }
  return ws.collection("approvals").create(
    {
      appId: input.appId,
      action: input.action,
      subject: input.subject,
      snapshotHash: input.hash,
      summary: input.summary.slice(0, 1000),
      requestedBy: input.actor,
      status: "pending",
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      estimate: input.estimate,
    },
    { actor: input.actor },
  );
}

/**
 * Approve or reject. The client must echo the snapshot hash it displayed, and (for subjects this
 * module owns) that hash must still match the subject's current content, so nobody approves a
 * version they did not see.
 */
export async function decideApproval(
  ws: WorkspaceDb,
  member: WorkspaceMember,
  approvalId: string,
  input: { decision: "approved" | "rejected"; snapshotHash?: string; note?: string },
): Promise<Approval> {
  const a = await ws.collection("approvals").getOrThrow(approvalId);
  const cap = APPROVER_CAP[a.action];
  if (!can(member, cap)) throw new AppError("FORBIDDEN", `Approving ${a.action} requires the ${cap} permission`);
  if (a.status !== "pending") throw new AppError("CONFLICT", `Approval is ${a.status}`);
  if (isExpired(a)) {
    await ws.collection("approvals").update(a.id, { status: "expired" }, { actor: member.userId });
    throw new AppError("CONFLICT", "Approval request expired; request a new one");
  }
  if (input.decision === "approved") {
    if (!input.snapshotHash || input.snapshotHash !== a.snapshotHash) {
      throw new AppError("CONFLICT", "Snapshot hash does not match the requested version", { userMessage: "This content changed since approval was requested. Review the latest version." });
    }
    const current = await currentSubjectHash(ws, a.subject);
    if (current !== null && current !== a.snapshotHash) {
      await ws.collection("approvals").update(a.id, { status: "expired", note: "Content changed after the request" }, { actor: member.userId });
      throw new AppError("CONFLICT", "Subject changed since approval was requested (stale snapshot)", { userMessage: "This content changed since approval was requested. Request approval again." });
    }
  }
  return ws.collection("approvals").update(a.id, { status: input.decision, decidedBy: member.userId, decidedAt: nowIso(), note: input.note?.slice(0, 1000) }, { actor: member.userId });
}

/**
 * Gate for any external action. Throws APPROVAL_REQUIRED unless `approvalId` is an approved,
 * unexpired approval of exactly this action + subject + current snapshot hash, decided by a member
 * who still holds the required capability.
 */
export async function assertApproved(ws: WorkspaceDb, input: { approvalId?: string; action: ApprovalAction; subject: EntityRef; hash: string; allowConsumedBy?: string }): Promise<Approval> {
  const required = (msg: string, userMessage?: string) => new AppError("APPROVAL_REQUIRED", msg, { userMessage: userMessage ?? "This needs an approval of the exact current version first.", retryable: false });
  if (!input.approvalId) throw required("No approval on record");
  const a = await ws.collection("approvals").get(input.approvalId);
  if (!a) throw required("Approval not found");
  if (a.action !== input.action || a.subject.entity !== input.subject.entity || a.subject.id !== input.subject.id) throw required("Approval is for a different action or subject");
  if (a.status === "consumed" && input.allowConsumedBy) return a;
  if (a.status !== "approved") throw required(`Approval is ${a.status}`);
  if (isExpired(a)) throw required("Approval expired", "The approval expired. Request a new one.");
  if (a.snapshotHash !== input.hash) throw required("Content changed after approval (stale snapshot)", "This content changed after it was approved. Request approval again.");
  const approver = a.decidedBy ? await ws.collection("members").get(a.decidedBy) : null;
  if (!approver || !can(approver, APPROVER_CAP[a.action])) throw required("The approver no longer has permission for this action", "The person who approved this no longer has permission. Ask someone with publishing rights to approve.");
  return a;
}

export async function consumeApproval(ws: WorkspaceDb, approvalId: string, actor: string, note?: string): Promise<void> {
  const a = await ws.collection("approvals").get(approvalId);
  if (a && a.status === "approved") await ws.collection("approvals").update(approvalId, { status: "consumed", note: note?.slice(0, 1000) ?? a.note }, { actor });
}
