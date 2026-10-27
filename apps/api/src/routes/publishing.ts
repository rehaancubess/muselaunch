import { brandGate, reviewBrief } from "@muselaunch/agents";
import { can, GuardedApprovalRequest, Id } from "@muselaunch/contracts";
import {
  calendar,
  CalendarQuery,
  cancelPost,
  copyForManual,
  createPost,
  CreatePostRequest,
  currentSubjectHash,
  decideApproval,
  disconnectAccount,
  draftView,
  enqueuePublish,
  enqueueSend,
  manualPackage,
  markPosted,
  MarkPostedRequest,
  markSent,
  MarkSentRequest,
  onDraftApprovalDecided,
  onPostApprovalDecided,
  postView,
  providerCatalog,
  ReminderRequest,
  requestDraftApproval,
  requestPackage,
  requestPostApproval,
  resetDraftSend,
  revalidateDraft,
  setReminder,
  startConnection,
  suggestTimes,
  SuggestTimesQuery,
  switchToManual,
  updateDraft,
  UpdateDraftRequest,
  updatePost,
  UpdatePostRequest,
} from "@muselaunch/growth";
import { AppError } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, query, requireCap, type AppEnv, type Ctx } from "../context";
import { audit } from "../services/workspaces";

/**
 * Owner: module E (Growth): calendar, scheduled posts, approvals, connections, publications, outreach drafts.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * External actions need the member capability (publish / outreach.send / accounts.manage) AND an
 * approved Approval matching the exact content snapshot.
 */
export const publishingRoutes = new Hono<AppEnv>();

const wsOf = (c: Ctx) => c.get("platform").db.ws(c.get("workspaceId"));
const p = (c: Ctx) => c.get("platform");
const wid = (c: Ctx) => c.get("workspaceId");

async function app(c: Ctx) {
  return wsOf(c).collection("apps").getOrThrow(Id.parse(c.req.param("appId")));
}
const tzDefault = (c: Ctx) => c.get("workspace").settings.defaultTimezone ?? "UTC";

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

publishingRoutes.get("/connections", async (c) => {
  const items = (await wsOf(c).collection("connectedAccounts").list({ limit: 200 })).items.map(({ secretId: _secret, ...a }) => ({ ...a, hasCredentials: Boolean(_secret) }));
  return c.json({ items, providers: providerCatalog(p(c)) });
});

publishingRoutes.post("/connections/:provider/start", requireCap("accounts.manage"), async (c) => {
  const input = await body(c, z.object({ appId: Id.optional() }).default({}));
  if (input.appId) await wsOf(c).collection("apps").getOrThrow(input.appId);
  const out = await startConnection(p(c), wid(c), actorOf(c), c.req.param("provider"), { appId: input.appId });
  await audit(p(c), wid(c), actorOf(c), "connection.started", { provider: out.provider });
  return c.json(out);
});

publishingRoutes.delete("/connections/:id", requireCap("accounts.manage"), async (c) => {
  return c.json(await disconnectAccount(p(c), wid(c), c.req.param("id"), actorOf(c)));
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

publishingRoutes.get("/approvals", async (c) => {
  const status = c.req.query("status");
  const appId = c.req.query("appId");
  const ws = wsOf(c);
  const page = status
    ? await ws.collection("approvals").list({ where: [["status", "==", status]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })
    : appId
      ? await ws.collection("approvals").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })
      : await ws.collection("approvals").list({ limit: 200 });
  const items = page.items.filter((a) => !appId || a.appId === appId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json({ items, nextCursor: null });
});

publishingRoutes.get("/approvals/:id", async (c) => {
  const ws = wsOf(c);
  const approval = await ws.collection("approvals").getOrThrow(c.req.param("id"));
  const current = await currentSubjectHash(ws, approval.subject);
  let subject: unknown = null;
  if (approval.subject.entity === "scheduledPosts") subject = (await postView(p(c), wid(c), approval.subject.id).catch(() => null))?.post ?? null;
  if (approval.subject.entity === "outreachDrafts") subject = (await draftView(ws, approval.subject.id).catch(() => null)) ?? null;
  return c.json({ approval, subject, currentHash: current, stale: current !== null && current !== approval.snapshotHash });
});

const DecideRequest = z.object({ snapshotHash: z.string().max(128).optional(), note: z.string().max(1000).optional() });

publishingRoutes.post("/approvals/:id/approve", async (c) => {
  const input = await body(c, DecideRequest);
  const ws = wsOf(c);
  const approval = await decideApproval(ws, c.get("member"), c.req.param("id"), { decision: "approved", snapshotHash: input.snapshotHash, note: input.note });
  const [post, draft] = await Promise.all([onPostApprovalDecided(ws, approval, actorOf(c)), onDraftApprovalDecided(ws, approval, actorOf(c))]);
  await audit(p(c), wid(c), actorOf(c), "approval.approved", { approvalId: approval.id, action: approval.action, subject: approval.subject, snapshotHash: approval.snapshotHash });
  return c.json({ approval, post, draft });
});

publishingRoutes.post("/approvals/:id/reject", async (c) => {
  const input = await body(c, DecideRequest);
  const ws = wsOf(c);
  const approval = await decideApproval(ws, c.get("member"), c.req.param("id"), { decision: "rejected", note: input.note });
  const [post, draft] = await Promise.all([onPostApprovalDecided(ws, approval, actorOf(c)), onDraftApprovalDecided(ws, approval, actorOf(c))]);
  await audit(p(c), wid(c), actorOf(c), "approval.rejected", { approvalId: approval.id, action: approval.action, subject: approval.subject });
  return c.json({ approval, post, draft });
});

// ---------------------------------------------------------------------------
// Posts, calendar, publications
// ---------------------------------------------------------------------------

publishingRoutes.get("/apps/:appId/posts", async (c) => {
  const a = await app(c);
  const status = c.req.query("status");
  const campaignId = c.req.query("campaignId");
  const ws = wsOf(c);
  const page = status
    ? await ws.collection("scheduledPosts").list({ where: [["appId", "==", a.id], ["status", "==", status]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })
    : await ws.collection("scheduledPosts").list({ where: [["appId", "==", a.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  return c.json({ items: page.items.filter((x) => !campaignId || x.campaignId === campaignId), nextCursor: null });
});

publishingRoutes.post("/apps/:appId/posts", requireCap("content.write"), async (c) => {
  const a = await app(c);
  const input = await body(c, CreatePostRequest);
  return c.json(await createPost(p(c), wid(c), a.id, input, actorOf(c)), 201);
});

publishingRoutes.get("/apps/:appId/posts/suggested-times", async (c) => {
  const a = await app(c);
  return c.json(await suggestTimes(wsOf(c), a.id, query(c, SuggestTimesQuery), tzDefault(c)));
});

publishingRoutes.get("/apps/:appId/calendar", async (c) => {
  const a = await app(c);
  return c.json(await calendar(wsOf(c), a.id, query(c, CalendarQuery), tzDefault(c)));
});

publishingRoutes.get("/apps/:appId/publications", async (c) => {
  const a = await app(c);
  const page = await wsOf(c).collection("publications").list({ where: [["appId", "==", a.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  return c.json({ items: page.items, nextCursor: null });
});

publishingRoutes.get("/posts/:id", async (c) => c.json(await postView(p(c), wid(c), c.req.param("id"))));

publishingRoutes.patch("/posts/:id", requireCap("content.write"), async (c) => {
  const input = await body(c, UpdatePostRequest);
  return c.json(await updatePost(p(c), wid(c), c.req.param("id"), input, actorOf(c)));
});

/**
 * Brand Guardian gate (module G) for approval requests: attach the latest review of the exact
 * post/draft content (reviewing it now if there is none). A `blocked` review needs
 * `override.reason` from someone with this route's capability (content.write); overrides are stored
 * on the review and audited. Publishing/sending still needs an approver's decision afterwards.
 */
async function guardianGate(c: Ctx, subject: { entity: "scheduledPosts" | "outreachDrafts"; id: string }) {
  let raw: unknown = {};
  try {
    raw = await c.req.json();
  } catch {
    raw = {}; // body is optional
  }
  const input = GuardedApprovalRequest.parse(raw ?? {});
  const gate = await brandGate(p(c), wid(c), { subject, override: input.override, actor: actorOf(c), canOverride: can(c.get("member"), "content.write"), action: "request_approval" });
  return { ...reviewBrief(gate.review), overridden: gate.overridden };
}

publishingRoutes.post("/posts/:id/request-approval", requireCap("content.write"), async (c) => {
  const brandReview = await guardianGate(c, { entity: "scheduledPosts", id: c.req.param("id") });
  return c.json({ ...(await requestPostApproval(p(c), wid(c), c.req.param("id"), actorOf(c))), brandReview });
});

publishingRoutes.post("/posts/:id/publish", requireCap("publish"), async (c) => {
  const out = await enqueuePublish(p(c), wid(c), c.req.param("id"), actorOf(c));
  await audit(p(c), wid(c), actorOf(c), "post.publish_requested", { postId: out.post.id, jobId: out.job.id });
  return c.json(out, 202);
});

publishingRoutes.post("/posts/:id/switch-to-manual", requireCap("content.write"), async (c) => c.json({ post: await switchToManual(wsOf(c), c.req.param("id"), actorOf(c)) }));

publishingRoutes.post("/posts/:id/cancel", requireCap("content.write"), async (c) => c.json({ post: await cancelPost(wsOf(c), c.req.param("id"), actorOf(c)) }));

publishingRoutes.get("/posts/:id/manual", async (c) => c.json(await manualPackage(p(c), wid(c), c.req.param("id"))));

publishingRoutes.post("/posts/:id/package", requireCap("content.write"), async (c) => c.json(await requestPackage(p(c), wid(c), c.req.param("id"), actorOf(c)), 202));

publishingRoutes.post("/posts/:id/mark-posted", requireCap("publish"), async (c) => {
  const input = await body(c, MarkPostedRequest);
  const out = await markPosted(p(c), wid(c), c.req.param("id"), input, actorOf(c));
  await audit(p(c), wid(c), actorOf(c), "post.manually_posted", { postId: out.post.id, url: input.url });
  return c.json(out);
});

publishingRoutes.post("/posts/:id/reminder", requireCap("content.write"), async (c) => {
  const input = await body(c, ReminderRequest);
  if (input.at && Date.parse(input.at) < Date.now() - 60_000) throw new AppError("BAD_REQUEST", "Reminder time is in the past");
  return c.json({ post: await setReminder(wsOf(c), c.req.param("id"), input.at, actorOf(c)) });
});

// ---------------------------------------------------------------------------
// Outreach drafts
// ---------------------------------------------------------------------------

publishingRoutes.get("/apps/:appId/outreach/drafts", async (c) => {
  const a = await app(c);
  const prospectId = c.req.query("prospectId");
  const page = await wsOf(c).collection("outreachDrafts").list({ where: [["appId", "==", a.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  return c.json({ items: page.items.filter((d) => !prospectId || d.prospectId === prospectId), nextCursor: null });
});

publishingRoutes.get("/outreach/drafts/:id", async (c) => c.json(await draftView(wsOf(c), c.req.param("id"))));

publishingRoutes.patch("/outreach/drafts/:id", requireCap("content.write"), async (c) => {
  const input = await body(c, UpdateDraftRequest);
  return c.json({ draft: await updateDraft(p(c), wid(c), c.req.param("id"), input, actorOf(c)) });
});

publishingRoutes.post("/outreach/drafts/:id/validate", requireCap("content.write"), async (c) => c.json({ draft: await revalidateDraft(p(c), wid(c), c.req.param("id"), actorOf(c)) }));

publishingRoutes.post("/outreach/drafts/:id/request-approval", requireCap("content.write"), async (c) => {
  const brandReview = await guardianGate(c, { entity: "outreachDrafts", id: c.req.param("id") });
  return c.json({ ...(await requestDraftApproval(p(c), wid(c), c.req.param("id"), actorOf(c))), brandReview });
});

publishingRoutes.post("/outreach/drafts/:id/send", requireCap("outreach.send"), async (c) => {
  const out = await enqueueSend(p(c), wid(c), c.req.param("id"), actorOf(c));
  await audit(p(c), wid(c), actorOf(c), "outreach.send_requested", { draftId: out.draft.id, jobId: out.job.id });
  return c.json(out, 202);
});

publishingRoutes.post("/outreach/drafts/:id/copy", requireCap("outreach.send"), async (c) => c.json(await copyForManual(p(c), wid(c), c.req.param("id"), actorOf(c))));

publishingRoutes.post("/outreach/drafts/:id/mark-sent", requireCap("outreach.send"), async (c) => {
  const input = await body(c, MarkSentRequest.default({}));
  const draft = await markSent(p(c), wid(c), c.req.param("id"), input, actorOf(c));
  await audit(p(c), wid(c), actorOf(c), "outreach.marked_sent", { draftId: draft.id });
  return c.json({ draft });
});

publishingRoutes.post("/outreach/drafts/:id/reset-send", requireCap("outreach.send"), async (c) => c.json({ draft: await resetDraftSend(wsOf(c), c.req.param("id"), actorOf(c)) }));

