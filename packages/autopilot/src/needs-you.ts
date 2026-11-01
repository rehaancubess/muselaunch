/**
 * "Needs you": the only things a person has to decide, gathered into one list for one-tap decisions:
 *  - approvals: publishing a post, sending outreach, spending beyond a run's budget, or letting a loop
 *    continue. Every item names the existing decision route, which keeps its own permission check
 *    (publish / outreach.send / billing.manage / content.approve) and snapshot-hash check;
 *  - App DNA ("About your app") waiting for review (`apps.dnaStatus = needs_review`);
 *  - a video whose current version the Brand Guardian blocks (no one-tap route: the item links to the
 *    video in the Studio, where fixes and overrides keep their own checks).
 * Read-only: nothing here changes state.
 */
import { isTerminalReview, reviewsFor } from "@muselaunch/agents";
import { can, type App, type Approval, type Autopilot, type BrandReview, type Capability, type Composition, type NeedsYouItem, type WorkspaceMember } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { APPROVER_CAP, currentSubjectHash } from "@muselaunch/growth";
import type { Platform } from "@muselaunch/platform";
import { reasonText } from "./state";

type Member = Pick<WorkspaceMember, "role" | "canPublish" | "canManageAccounts" | "status">;

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ""));
const CHANNEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", linkedin: "LinkedIn", threads: "Threads", facebook: "Facebook", reddit: "Reddit", producthunt: "Product Hunt" };
const channelName = (c: string) => CHANNEL[c] ?? c.replace(/_/g, " ");

/** Loops that are working right now (not waiting on a person, not stopped). */
const WORKING: readonly Autopilot["status"][] = ["running", "waiting_on_jobs"];

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
  const loops = loopLoader(ws);
  items.push(...(await appDnaItems(ws, opts.appId, has, loops)));
  items.push(...(await brandCheckItems(ws, opts.appId, has, loops)));
  // Decisions that block a running loop first, then "About your app" (it shapes everything made next),
  // then blocked videos, then posts in the order they'd go out.
  const RANK: Record<NeedsYouItem["kind"], number> = { spend: 0, decision: 0, app_dna: 1, brand_check: 2, post: 3, outreach: 3 };
  items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.preview?.scheduledAt ?? "￿").localeCompare(b.preview?.scheduledAt ?? "￿") || b.createdAt.localeCompare(a.createdAt));
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
          title: spend ? `Approve spending${a.estimate?.credits ? ` ≈${a.estimate.credits} credits` : ""}` : reasonText(ap.waitingOn.reason) || "Let Autopilot continue?",
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
          // Creator → Scheduled (the old /calendar URL redirects there too).
          reviewPath: `${appPath}/creator/scheduled`,
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
          title: a.action === "spend" ? `Approve spending${a.estimate?.credits ? ` ≈${a.estimate.credits} credits` : ""}` : "Approve the plan",
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

/** An app's recent loops, loaded once per app. */
function loopLoader(ws: WorkspaceDb) {
  const cache = new Map<string, Promise<Autopilot[]>>();
  return (appId: string) => {
    let hit = cache.get(appId);
    if (!hit) {
      hit = ws
        .collection("autopilots")
        .list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 10 })
        .then((pg) => pg.items);
      cache.set(appId, hit);
    }
    return hit;
  };
}

type Loops = ReturnType<typeof loopLoader>;

/**
 * App DNA waiting for review (the hands-on path: "I'll do it myself"). Skipped while an automatic
 * Autopilot run is working on the app, because that run accepts App DNA on its own (the founder can
 * still review it any time in About your app).
 */
async function appDnaItems(ws: WorkspaceDb, appId: string | undefined, has: (c: Capability) => boolean, loops: Loops): Promise<NeedsYouItem[]> {
  const apps: App[] = appId
    ? [await ws.collection("apps").get(appId)].filter((a): a is App => Boolean(a))
    : (await ws.collection("apps").list({ where: [["dnaStatus", "==", "needs_review"]], limit: 50 })).items;
  const out: NeedsYouItem[] = [];
  for (const app of apps) {
    if (app.dnaStatus !== "needs_review" || app.status === "archived") continue;
    const accepting = (await loops(app.id)).some((ap) => ap.auto?.acceptDna && WORKING.includes(ap.status));
    if (accepting) continue;
    const [profile, toCheck] = await Promise.all([
      ws.collection("brandProfiles").get(app.id),
      ws.collection("claims").list({ where: [["appId", "==", app.id], ["state", "==", "needs_review"]], limit: 200 }),
    ]);
    const facts = toCheck.items.length;
    const name = app.name && app.name !== "New app" ? app.name : "your app";
    out.push({
      id: app.id,
      kind: "app_dna",
      action: "dna_review",
      appId: app.id,
      title: clip(`Check what we learned about ${name}`, 200),
      summary: `We read your listing and screenshots and wrote down what ${name} does and who it’s for. A quick check keeps every video true.${facts ? ` ${facts} fact${facts === 1 ? "" : "s"} to check.` : ""}`,
      createdAt: profile?.updatedAt ?? app.updatedAt,
      subject: { entity: "apps", id: app.id },
      // Confirming (POST /apps/:appId/dna/confirm) needs apps.write; verifying facts needs content.approve.
      requiredCap: "apps.write",
      canDecide: has("apps.write"),
      stale: false,
      approve: null,
      reject: null,
      reviewPath: `/a/${app.id}/brand`,
      preview: { factsToCheck: facts },
    });
  }
  return out;
}

const openBlocks = (r: BrandReview) => r.findings.filter((f) => f.severity === "block" && f.resolution?.state !== "dismissed");

/**
 * Videos whose CURRENT version the Brand Guardian blocks (final render and approval requests refuse
 * them until fixed or overridden with a reason). Skipped: reviews someone already overrode, older
 * versions, and videos an Autopilot run is fixing right now (its own fix rounds).
 */
async function brandCheckItems(ws: WorkspaceDb, appId: string | undefined, has: (c: Capability) => boolean, loops: Loops): Promise<NeedsYouItem[]> {
  const where: [string, "==", string][] = [["status", "==", "blocked"]];
  if (appId) where.push(["appId", "==", appId]);
  const blocked = (await ws.collection("brandReviews").list({ where, limit: 200 })).items.filter((r) => r.subject.entity === "compositions" && !r.overrides.length);
  if (!blocked.length) return [];
  const comps = new Map((await ws.collection("compositions").getMany([...new Set(blocked.map((r) => r.subject.id))])).map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: NeedsYouItem[] = [];
  for (const r of blocked) {
    const comp: Composition | undefined = comps.get(r.subject.id);
    if (!comp || seen.has(comp.id) || r.subjectVersion !== comp.currentVersion) continue;
    // The newest finished review of this exact version decides (a re-review may have passed).
    const latest = (await reviewsFor(ws, { entity: "compositions", id: comp.id }, { version: comp.currentVersion, contentHash: "" })).find(isTerminalReview);
    if (!latest || latest.status !== "blocked" || latest.overrides.length) continue;
    const blocks = openBlocks(latest);
    if (!blocks.length) continue;
    const fixing = (await loops(comp.appId)).some((ap) => WORKING.includes(ap.status) && ap.compositionIds.includes(comp.id));
    if (fixing) continue;
    seen.add(comp.id);
    const first = blocks[0]!;
    out.push({
      id: latest.id,
      kind: "brand_check",
      action: "brand_review",
      appId: comp.appId,
      title: clip(`“${clip(comp.title, 80)}” didn’t pass the Brand check`, 200),
      summary: clip(`${first.message}${blocks.length > 1 ? ` (+${blocks.length - 1} more)` : ""} Fix it in the editor, or go ahead with a reason.`, 1000),
      createdAt: latest.checkedAt ?? latest.updatedAt,
      subject: { entity: "compositions", id: comp.id },
      // Fixing in the Studio (and overriding for a render) needs content.write.
      requiredCap: "content.write",
      canDecide: has("content.write"),
      stale: false,
      approve: null,
      reject: null,
      reviewPath: `/a/${comp.appId}/creator/studio/${comp.id}`,
      preview: { compositionId: comp.id, compositionTitle: clip(comp.title, 200), blockingIssues: blocks.length },
    });
  }
  return out;
}
