import { Channel, HttpUrl, Id, type Approval, type OutreachDraft, type OutreachProspect } from "@muselaunch/contracts";
import { nowIso, type WorkspaceDb } from "@muselaunch/db";
import { AppError, toAppError, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { HttpClient, providerAdapter } from "@muselaunch/providers";
import { z } from "zod";
import { assertApproved, consumeApproval, draftSnapshot, expireApprovals, requestApproval } from "../approvals";
import { connectedAccountFor, freshTokens } from "../connections";
import { growthDeps } from "../deps";
import { DAY_MS } from "../util";
import { validateDraft } from "./claims";
import { AddContactRequest, prospectView, sanitizeContacts, userContact } from "./contacts";

export const DraftRequest = z.object({ prospectIds: z.array(Id).min(1).max(20), campaignId: Id.optional(), offer: z.string().min(1).max(1000).optional() });

export const UpdateDraftRequest = z.object({
  subject: z.string().max(300).optional(),
  body: z.string().min(1).max(8000).optional(),
  offer: z.string().min(1).max(1000).optional(),
  /** Index into the prospect's sourced public contacts. */
  contactIndex: z.number().int().min(0).max(20).optional(),
});

export const UpdateProspectRequest = z.object({
  status: z.enum(["suggested", "replied", "negotiating", "declined", "successful", "archived"]).optional(),
  notes: z.string().max(2000).optional(),
  outreachAngle: z.string().max(1000).optional(),
});

export const CreateProspectRequest = z.object({
  channel: Channel,
  handle: z.string().min(1).max(120),
  url: HttpUrl,
  displayName: z.string().max(160).optional(),
  niche: z.string().min(1).max(300),
  notes: z.string().max(2000).default(""),
});

export const MarkSentRequest = z.object({ sentAt: z.string().datetime({ offset: true }).optional(), note: z.string().max(500).optional() });

export { AddContactRequest };

const editable = (d: OutreachDraft) => ["draft", "awaiting_approval", "approved", "copied_manual", "failed"].includes(d.status);

async function loadDraft(ws: WorkspaceDb, id: string) {
  return ws.collection("outreachDrafts").getOrThrow(id);
}

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

export async function listProspects(ws: WorkspaceDb, appId: string, status?: string) {
  const page = await ws.collection("outreachProspects").list(
    status ? { where: [["appId", "==", appId], ["status", "==", status]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 } : { where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 },
  );
  return page.items.map(prospectView).sort((a, b) => b.relevanceScore - a.relevanceScore);
}

export async function createProspect(ws: WorkspaceDb, appId: string, input: z.infer<typeof CreateProspectRequest>, actor: string): Promise<OutreachProspect> {
  return ws.collection("outreachProspects").create(
    {
      appId,
      channel: input.channel,
      handle: input.handle.replace(/^@/, ""),
      url: input.url,
      displayName: input.displayName,
      niche: input.niche,
      relevanceScore: 50,
      relevanceReasons: ["Added by you"],
      evidence: [{ kind: "user_input", url: input.url, retrievedAt: nowIso(), title: "Profile added by you" }],
      publicContacts: [],
      status: "suggested",
      notes: input.notes,
    },
    { actor },
  );
}

export async function updateProspect(ws: WorkspaceDb, id: string, input: z.infer<typeof UpdateProspectRequest>, actor: string) {
  return prospectView(await ws.collection("outreachProspects").update(id, input, { actor }));
}

export async function addProspectContact(ws: WorkspaceDb, id: string, input: z.infer<typeof AddContactRequest>, actor: string) {
  const p = await ws.collection("outreachProspects").getOrThrow(id);
  const contact = userContact(input, nowIso());
  const next = sanitizeContacts([...p.publicContacts, contact]).contacts;
  return prospectView(await ws.collection("outreachProspects").update(id, { publicContacts: next.slice(0, 20) }, { actor }));
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export async function updateDraft(p: Platform, wid: string, id: string, input: z.infer<typeof UpdateDraftRequest>, actor: string): Promise<OutreachDraft> {
  const ws = p.db.ws(wid);
  const d = await loadDraft(ws, id);
  if (!editable(d)) throw new AppError("CONFLICT", `Draft is ${d.status}`);
  const patch: Partial<OutreachDraft> = {};
  if (input.subject !== undefined) patch.subject = input.subject;
  if (input.body !== undefined) patch.body = input.body;
  if (input.offer !== undefined) {
    patch.offer = input.offer;
    patch.offerSource = "user";
  }
  if (input.contactIndex !== undefined) {
    const prospect = await ws.collection("outreachProspects").getOrThrow(d.prospectId);
    const c = sanitizeContacts(prospect.publicContacts).contacts[input.contactIndex];
    if (!c) throw new AppError("BAD_REQUEST", "No such public contact route for this creator");
    patch.to = { kind: c.kind, value: c.value, source: c.source };
    patch.channel = c.kind === "email" || c.kind === "business_inquiry" ? "email" : c.kind === "contact_form" ? "contact_form" : c.kind === "dm" ? "dm" : "other";
  }
  const merged = { ...d, ...patch };
  patch.validation = await validateDraft(p, ws, merged);
  if (d.status !== "draft") {
    await expireApprovals(ws, { entity: "outreachDrafts", id }, d.appId, actor, "Draft edited");
    patch.status = "draft";
    patch.approvalId = undefined;
  }
  return ws.collection("outreachDrafts").update(id, patch, { actor });
}

export async function revalidateDraft(p: Platform, wid: string, id: string, actor: string) {
  const ws = p.db.ws(wid);
  const d = await loadDraft(ws, id);
  return ws.collection("outreachDrafts").update(id, { validation: await validateDraft(p, ws, d) }, { actor });
}

export async function requestDraftApproval(p: Platform, wid: string, id: string, actor: string): Promise<{ draft: OutreachDraft; approval: Approval }> {
  const ws = p.db.ws(wid);
  let d = await loadDraft(ws, id);
  if (!["draft", "awaiting_approval", "failed"].includes(d.status)) throw new AppError("CONFLICT", `Draft is ${d.status}`);
  const validation = await validateDraft(p, ws, d);
  d = await ws.collection("outreachDrafts").update(id, { validation }, { actor });
  if (!validation.ok) throw new AppError("VALIDATION_FAILED", "Draft has claim issues", { details: { issues: validation.issues }, userMessage: validation.issues[0]?.issue });
  if (!d.to) throw new AppError("VALIDATION_FAILED", "No publicly listed contact route for this creator", { userMessage: "Add a contact route this creator lists publicly (with its source) before approval." });
  const prospect = await ws.collection("outreachProspects").getOrThrow(d.prospectId);
  const approval = await requestApproval(ws, {
    appId: d.appId,
    action: "outreach_send",
    subject: { entity: "outreachDrafts", id: d.id },
    hash: draftSnapshot(d).hash,
    summary: `Send outreach to ${prospect.displayName ?? prospect.handle} via ${d.to.kind} (${d.to.value}): "${(d.subject ?? d.body).slice(0, 120)}"`,
    actor,
  });
  const draft = await ws.collection("outreachDrafts").update(id, { status: approval.status === "approved" ? "approved" : "awaiting_approval", approvalId: approval.id }, { actor });
  if (prospect.status === "suggested" || prospect.status === "drafted") await ws.collection("outreachProspects").update(prospect.id, { status: "awaiting_review" }, { actor });
  return { draft, approval };
}

export async function onDraftApprovalDecided(ws: WorkspaceDb, approval: Approval, actor: string): Promise<OutreachDraft | null> {
  if (approval.subject.entity !== "outreachDrafts") return null;
  const d = await ws.collection("outreachDrafts").get(approval.subject.id);
  if (!d || d.approvalId !== approval.id || d.status === "sent") return d;
  if (approval.status === "approved") return ws.collection("outreachDrafts").update(d.id, { status: "approved" }, { actor });
  if (approval.status === "rejected") return ws.collection("outreachDrafts").update(d.id, { status: "draft" }, { actor });
  return d;
}

/** Anti-blast limits: per-app daily cap and a minimum gap between sends in the workspace. */
async function assertSendRate(p: Platform, ws: WorkspaceDb, appId: string) {
  const { settings, now } = growthDeps(p);
  const recent = (await ws.collection("outreachDrafts").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 500 })).items.filter((d) => d.sentAt && now() - Date.parse(d.sentAt) < DAY_MS);
  if (recent.length >= settings.outreachDailyLimit) throw new AppError("RATE_LIMITED", `Outreach is limited to ${settings.outreachDailyLimit} messages per app per day`, { retryable: false, userMessage: "You've reached today's outreach limit. Personal, spaced-out messages work better anyway." });
  const last = recent.map((d) => Date.parse(d.sentAt!)).sort((a, b) => b - a)[0];
  if (last && now() - last < settings.outreachMinIntervalSec * 1000) throw new AppError("RATE_LIMITED", "Please wait a moment between outreach messages", { retryable: false, userMessage: `Wait ${settings.outreachMinIntervalSec} seconds between messages.` });
}

async function gate(ws: WorkspaceDb, d: OutreachDraft) {
  return assertApproved(ws, { approvalId: d.approvalId, action: "outreach_send", subject: { entity: "outreachDrafts", id: d.id }, hash: draftSnapshot(d).hash });
}

/** Send via the connected Gmail account (job). Without one: 409 with the manual alternative. */
export async function enqueueSend(p: Platform, wid: string, id: string, actor: string) {
  const ws = p.db.ws(wid);
  const d = await loadDraft(ws, id);
  if (d.status === "sent") throw new AppError("CONFLICT", "Already sent");
  const approval = await gate(ws, d);
  if (d.to?.kind !== "email") throw new AppError("CONFLICT", "This creator's public contact route isn't an email", { userMessage: "Copy the message and send it through the creator's listed route, then mark it as sent." });
  const gmail = await connectedAccountFor(ws, "gmail");
  if (!gmail || !growthDeps(p).settings.creds.gmail) throw new AppError("PROVIDER_NOT_CONFIGURED", "No Gmail account connected", { userMessage: "Connect Gmail to send from MuseLaunch, or copy the message and send it yourself, then mark it as sent." });
  await assertSendRate(p, ws, d.appId);
  const job = await p.jobs.create(wid, "outreach.send", { draftId: d.id, approvalId: approval.id }, { actor, appId: d.appId, idempotencyKey: `outreach.send:${d.id}:${approval.id}`, maxAttempts: 1 });
  return { draft: d, job };
}

/** Manual route: returns the approved text to copy. */
export async function copyForManual(p: Platform, wid: string, id: string, actor: string) {
  const ws = p.db.ws(wid);
  const d = await loadDraft(ws, id);
  if (d.status === "sent") throw new AppError("CONFLICT", "Already sent");
  await gate(ws, d);
  const draft = await ws.collection("outreachDrafts").update(id, { status: "copied_manual" }, { actor });
  return {
    draft,
    copy: { to: d.to, subject: d.subject, body: d.body },
    instructions: [
      d.to ? `Send it through the creator's publicly listed ${d.to.kind.replace("_", " ")}: ${d.to.value} (listed at ${d.to.source.url ?? "their profile"}).` : "Use the creator's publicly listed contact route.",
      "Send one personal message; don't add the creator to mailing lists.",
      "Come back and click “Mark as sent” so the CRM stays accurate.",
    ],
  };
}

/** User confirms they sent the approved message themselves. */
export async function markSent(p: Platform, wid: string, id: string, input: z.infer<typeof MarkSentRequest>, actor: string) {
  const ws = p.db.ws(wid);
  const d = await loadDraft(ws, id);
  if (d.status === "sent") return d;
  // copied_manual / failed keep the approval; the snapshot hash is content-only.
  const approval = await gate(ws, d);
  await assertSendRate(p, ws, d.appId);
  const sentAt = input.sentAt ?? nowIso();
  const draft = await ws.collection("outreachDrafts").update(id, { status: "sent", sentAt, sendReceipt: { mode: "manual_confirmed", confirmedBy: actor, confirmedAt: nowIso(), note: input.note, approvalId: approval.id } }, { actor });
  await consumeApproval(ws, approval.id, actor, "Sent manually");
  await ws.collection("outreachProspects").update(d.prospectId, { status: "contacted" }, { actor });
  return draft;
}

/** `outreach.send`: deliver an approved email draft via the connected Gmail account. */
export async function outreachSendHandler(ctx: JobContext<"outreach.send">): Promise<JobResult> {
  const { ws, payload } = ctx;
  const p = ctx.platform;
  const d = await loadDraft(ws, payload.draftId);
  const ref = { entity: "outreachDrafts", id: d.id };
  if (d.status === "sent") return { refs: [ref], data: { alreadySent: true } };
  // A previous attempt reached Gmail but didn't record the result: never resend blindly.
  if ((d.sendReceipt as { attemptJobId?: string } | undefined)?.attemptJobId && !(d.sendReceipt as { messageId?: string }).messageId) {
    await ws.collection("outreachDrafts").update(d.id, { status: "failed" }, { actor: ctx.actor });
    throw new AppError("PROVIDER_ERROR", "Previous send attempt has an unknown outcome", { retryable: false, userMessage: "We can't confirm whether the email went out. Check your Gmail Sent folder, then mark it as sent or request a new send." });
  }
  if (d.approvalId !== payload.approvalId) throw new AppError("APPROVAL_REQUIRED", "Approval mismatch", { retryable: false });
  const approval = await gate(ws, d);
  if (d.to?.kind !== "email") throw new AppError("CONFLICT", "Recipient is not an email", { retryable: false });
  const account = await connectedAccountFor(ws, "gmail");
  const adapter = providerAdapter("gmail");
  if (!account || !adapter?.sendEmail) throw new AppError("PROVIDER_NOT_CONFIGURED", "Gmail is not connected", { retryable: false });
  const tokens = await freshTokens(p, ws, account, ctx.actor);
  await ws.collection("outreachDrafts").update(d.id, { sendReceipt: { attemptJobId: ctx.job.id, startedAt: nowIso() } }, { actor: ctx.actor });
  try {
    const res = await adapter.sendEmail(
      { to: d.to.value, subject: d.subject ?? "", body: d.body },
      { http: new HttpClient(growthDeps(p).fetch, "Gmail"), tokens, externalAccountId: account.externalAccountId, settings: growthDeps(p).settings.adapter, creds: growthDeps(p).settings.creds.gmail!, sleep: growthDeps(p).sleep, signal: ctx.signal },
    );
    const sentAt = nowIso();
    await ws.collection("outreachDrafts").update(d.id, { status: "sent", sentAt, sendReceipt: { ...res.receipt, attemptJobId: ctx.job.id, from: account.displayName, approvalId: approval.id } }, { actor: ctx.actor });
    await consumeApproval(ws, approval.id, ctx.actor, `Sent via Gmail ${res.messageId}`);
    await ws.collection("outreachProspects").update(d.prospectId, { status: "contacted" }, { actor: ctx.actor });
    return { refs: [ref], data: { messageId: res.messageId } };
  } catch (raw) {
    const err = toAppError(raw);
    // Definite rejections (4xx) mean nothing was sent: clear the attempt marker so the user can retry.
    const definite = !err.retryable && err.code === "PROVIDER_ERROR";
    await ws.collection("outreachDrafts").update(d.id, { status: "failed", sendReceipt: definite ? undefined : d.sendReceipt ?? { attemptJobId: ctx.job.id } }, { actor: ctx.actor });
    throw new AppError(err.code, err.message, { retryable: false, userMessage: err.toInfo().userMessage, details: err.opts.details });
  }
}

/** After an uncertain API send, the user confirms the email did NOT go out (checked Sent folder) to allow a new attempt. */
export async function resetDraftSend(ws: WorkspaceDb, id: string, actor: string) {
  const d = await loadDraft(ws, id);
  if (d.status !== "failed") throw new AppError("CONFLICT", `Draft is ${d.status}`);
  return ws.collection("outreachDrafts").update(id, { sendReceipt: undefined, status: d.approvalId ? "approved" : "draft" }, { actor });
}

export async function draftView(ws: WorkspaceDb, id: string) {
  const draft = await loadDraft(ws, id);
  const [prospect, approval] = await Promise.all([ws.collection("outreachProspects").get(draft.prospectId), draft.approvalId ? ws.collection("approvals").get(draft.approvalId) : null]);
  return { draft, prospect: prospect ? prospectView(prospect) : null, approval, snapshotHash: draftSnapshot(draft).hash };
}

export const OutreachStatusFlow = ["suggested", "drafted", "awaiting_review", "contacted", "replied", "negotiating", "successful"] as const;
