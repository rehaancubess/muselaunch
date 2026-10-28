import type { AgentRun, Approval, Autopilot, BrandReview, Composition, Experiment, Job, ResearchFinding, ScheduledPost, StartAutopilotRequest } from "@muselaunch/contracts";
import { AppError, type Platform } from "@muselaunch/platform";
import type { z } from "zod";
import { enqueueStep } from "./step";
import { delegatedJobIds, nowMs, reasonText, RETRY_PREFIX, type LogEntry } from "./state";

type StartInput = z.infer<typeof StartAutopilotRequest>;

const ACTIVE: Autopilot["status"][] = ["running", "waiting_on_jobs", "awaiting_user", "sleeping", "paused"];

/** Typical credits per iteration (shown before starting; actual spend is tracked live). */
export function estimateAutopilot(p: Platform, input: { variants: number; maxIterations: number; durationSec?: number }): { perIteration: number; total: number; breakdown: { label: string; credits: number }[] } {
  const e = (op: string, params: Record<string, unknown> = {}) => p.credits.estimate(op, params).credits;
  const v = input.variants;
  const lines = [
    { label: "Research (Muse Wonder, cited)", credits: e("research.run") },
    { label: "Campaign concepts (Muse Spark)", credits: e("campaign.generate_concepts") },
    { label: `Storyboards + editable videos ×${v}`, credits: v * (e("storyboard.generate") + e("composition.build") + e("render.preview")) },
    { label: `Brand Guardian reviews ×${v}`, credits: v * e("brand.review") },
    { label: `Final renders ×${v}`, credits: v * e("render.final", { durationSec: input.durationSec ?? 15 }) },
    { label: `Post copy ×${v}`, credits: v * e("copy.generate") },
    { label: "Experiment analysis + recommendations", credits: e("experiment.analyze") + e("recommendations.generate") },
  ];
  const perIteration = lines.reduce((n, l) => n + l.credits, 0);
  return { perIteration, total: perIteration * input.maxIterations, breakdown: lines };
}

export async function startAutopilot(
  p: Platform,
  workspaceId: string,
  appId: string,
  input: StartInput,
  actor: string,
  opts: { auto?: Autopilot["auto"]; notes?: string[] } = {},
): Promise<{ autopilot: Autopilot; job: Job }> {
  const ws = p.db.ws(workspaceId);
  await ws.collection("apps").getOrThrow(appId);
  const active = await ws.collection("autopilots").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 });
  if (active.items.some((a) => ACTIVE.includes(a.status))) {
    throw new AppError("CONFLICT", "A Growth Autopilot is already active for this app", { userMessage: "This app already has an active Growth Autopilot. Pause or cancel it first." });
  }
  const renders = input.autoApproveCredits ? `final renders run without asking up to ${input.autoApproveCredits} credits` : "final renders ask you first";
  const summary = opts.auto
    ? `Started automatically (Autopilot is on). Goal: “${input.goal}”. Budget ${input.maxCredits} credits for one full run: research, ${input.variants} video${input.variants > 1 ? "s" : ""}, checks, renders, post drafts and analysis; ${renders}. Posts, outreach and anything over budget always wait for your approval.${opts.notes?.length ? ` ${opts.notes.join(" ")}` : ""}`
    : `Started with goal “${input.goal}”. Budget ${input.maxCredits} credits, ${input.maxIterations} iteration(s), ${input.variants} variant(s); renders auto-approved up to ${input.autoApproveCredits} credits. Posts always need your approval.`;
  const autopilot = await ws.collection("autopilots").create(
    {
      appId,
      goal: input.goal,
      status: "running",
      stage: "understand",
      iteration: 1,
      budget: { maxCredits: input.maxCredits, maxIterations: input.maxIterations, autoApproveCredits: input.autoApproveCredits, variants: input.variants },
      waitingOn: { jobIds: [] },
      log: [{ at: new Date(nowMs(p)).toISOString(), stage: "understand", kind: "decision", summary: summary.slice(0, 1200), refs: [] }],
      ...(opts.auto ? { auto: opts.auto } : {}),
    },
    { actor },
  );
  const job = await enqueueStep(p, autopilot, `autopilot:${autopilot.id}:start`);
  return { autopilot, job };
}

async function load(p: Platform, workspaceId: string, id: string): Promise<Autopilot> {
  return p.db.ws(workspaceId).collection("autopilots").getOrThrow(id);
}

function entry(stage: Autopilot["stage"], kind: LogEntry["kind"], summary: string): LogEntry {
  return { at: new Date().toISOString(), stage, kind, summary, refs: [] };
}

export async function pauseAutopilot(p: Platform, workspaceId: string, id: string, actor: string): Promise<Autopilot> {
  const ap = await load(p, workspaceId, id);
  if (!["running", "waiting_on_jobs", "awaiting_user", "sleeping"].includes(ap.status)) throw new AppError("CONFLICT", `Autopilot is ${ap.status}`);
  return p.db.ws(workspaceId).collection("autopilots").update(id, { status: "paused", log: [...ap.log, entry(ap.stage, "checkpoint", `Paused by you (was ${ap.status.replace(/_/g, " ")}). Delegated jobs already running will finish.`)].slice(-400) }, { actor });
}

export async function resumeAutopilot(p: Platform, workspaceId: string, id: string, actor: string): Promise<{ autopilot: Autopilot; job: Job | null }> {
  const ap = await load(p, workspaceId, id);
  if (ap.status !== "paused" && ap.status !== "failed") throw new AppError("CONFLICT", `Autopilot is ${ap.status}`);
  const ws = p.db.ws(workspaceId);
  const repo = ws.collection("autopilots");
  // Re-enter the stage: awaited jobs and a still-pending checkpoint are kept; a decided/rejected
  // checkpoint is dropped so the stage asks again; failures re-run the stage.
  const approval = ap.waitingOn.approvalId ? await ws.collection("approvals").get(ap.waitingOn.approvalId) : null;
  const pendingCheckpoint = approval?.status === "pending";
  const waitingOn = ap.status === "failed" ? { jobIds: [] } : pendingCheckpoint ? ap.waitingOn : { ...ap.waitingOn, approvalId: undefined };
  const status: Autopilot["status"] = waitingOn.jobIds.length ? "waiting_on_jobs" : waitingOn.until ? "sleeping" : pendingCheckpoint ? "awaiting_user" : "running";
  const updated = await repo.update(id, { status, waitingOn, error: undefined, log: [...ap.log, entry(ap.stage, "checkpoint", ap.status === "failed" ? `${RETRY_PREFIX}: resumed by you at ${ap.stage.replace(/_/g, " ")}.` : `Resumed by you at ${ap.stage.replace(/_/g, " ")}.`)].slice(-400) }, { actor });
  if (status === "awaiting_user") return { autopilot: updated, job: null };
  const job = await enqueueStep(p, updated, `autopilot:${id}:resume-user:${updated.updatedAt}`);
  return { autopilot: updated, job };
}

export async function cancelAutopilot(p: Platform, workspaceId: string, id: string, actor: string): Promise<Autopilot> {
  const ap = await load(p, workspaceId, id);
  if (["completed", "cancelled"].includes(ap.status)) return ap;
  const ws = p.db.ws(workspaceId);
  for (const jobId of ap.waitingOn.jobIds) await p.jobs.requestCancel(workspaceId, jobId, actor).catch(() => {});
  if (ap.waitingOn.approvalId) await ws.collection("approvals").update(ap.waitingOn.approvalId, { status: "expired", note: "Autopilot cancelled" }, { actor }).catch(() => {});
  return ws.collection("autopilots").update(
    id,
    { status: "cancelled", waitingOn: { jobIds: [] }, log: [...ap.log, entry(ap.stage, "checkpoint", "Cancelled by you. Running jobs were asked to stop; drafts and posts already created are kept (nothing is published without approval).")].slice(-400) },
    { actor },
  );
}

/** Approve or reject the loop's pending checkpoint (spend / render / continue). */
export async function decideCheckpoint(p: Platform, workspaceId: string, id: string, input: { decision: "approve" | "reject"; note?: string }, actor: string): Promise<{ autopilot: Autopilot; job: Job | null }> {
  const ws = p.db.ws(workspaceId);
  const ap = await load(p, workspaceId, id);
  if (ap.status !== "awaiting_user" || !ap.waitingOn.approvalId) throw new AppError("CONFLICT", "This autopilot isn't waiting for a decision");
  const approval = await ws.collection("approvals").getOrThrow(ap.waitingOn.approvalId);
  if (approval.status !== "pending" || approval.subject.entity !== "autopilots" || approval.subject.id !== id) throw new AppError("CONFLICT", `Checkpoint is ${approval.status}`);
  const now = new Date().toISOString();
  await ws.collection("approvals").update(approval.id, { status: input.decision === "approve" ? "approved" : "rejected", decidedBy: actor, decidedAt: now, note: input.note?.slice(0, 1000) }, { actor });
  const what = reasonText(ap.waitingOn.reason);
  if (input.decision === "reject") {
    const updated = await ws.collection("autopilots").update(
      id,
      { status: "paused", log: [...ap.log, { ...entry(ap.stage, "checkpoint", `You rejected: ${what}${input.note ? ` — “${input.note}”` : ""}. The loop is paused; resume or cancel when ready.`), refs: [{ entity: "approvals", id: approval.id }] }].slice(-400) },
      { actor },
    );
    return { autopilot: updated, job: null };
  }
  const updated = await ws.collection("autopilots").update(id, { log: [...ap.log, { ...entry(ap.stage, "checkpoint", `You approved: ${what}${input.note ? ` — “${input.note}”` : ""}.`), refs: [{ entity: "approvals", id: approval.id }] }].slice(-400) }, { actor });
  const job = await enqueueStep(p, updated, `autopilot:${id}:checkpoint:${approval.id}`);
  return { autopilot: updated, job };
}

export interface AutopilotDetail {
  autopilot: Autopilot;
  /** Human text of what the loop is waiting for (machine tag removed). */
  waitingFor: string;
  runs: Pick<AgentRun, "id" | "kind" | "status" | "goal" | "model" | "usage" | "createdAt">[];
  jobs: Pick<Job, "id" | "type" | "status" | "progress" | "error" | "creditsCharged" | "reservation" | "createdAt" | "finishedAt">[];
  checkpoint: Approval | null;
  reviews: Pick<BrandReview, "id" | "subject" | "subjectVersion" | "status" | "reviewer" | "findings" | "summary" | "overrides">[];
  /** Research findings the loop's decisions cite (with their real sources), for citation chips. */
  findings: Pick<ResearchFinding, "id" | "kind" | "statement" | "confidence" | "evidence">[];
  compositions: Pick<Composition, "id" | "title" | "currentVersion" | "variantId">[];
  posts: Pick<ScheduledPost, "id" | "status" | "channel" | "scheduledAt" | "compositionId">[];
  experiment: Pick<Experiment, "id" | "title" | "status" | "launchWindow" | "variants" | "primaryMetric"> | null;
}

export async function autopilotDetail(p: Platform, workspaceId: string, id: string): Promise<AutopilotDetail> {
  const ws = p.db.ws(workspaceId);
  const autopilot = await load(p, workspaceId, id);
  const jobIds = [...new Set([...delegatedJobIds(autopilot.log), ...autopilot.waitingOn.jobIds])].slice(-150);
  const findingIds = [...new Set(autopilot.log.flatMap((e) => e.refs.filter((r) => r.entity === "researchFindings").map((r) => r.id)).concat(autopilot.audience?.findingIds ?? []))].slice(-60);
  const [runs, jobs, checkpoint, reviews, findings, compositions, posts, experiment] = await Promise.all([
    ws.collection("agentRuns").getMany(autopilot.agentRunIds.slice(-50)),
    ws.collection("jobs").getMany(jobIds),
    autopilot.waitingOn.approvalId ? ws.collection("approvals").get(autopilot.waitingOn.approvalId) : Promise.resolve(null),
    ws.collection("brandReviews").getMany(autopilot.reviewIds.slice(-30)),
    ws.collection("researchFindings").getMany(findingIds),
    ws.collection("compositions").getMany(autopilot.compositionIds.slice(-12)),
    ws.collection("scheduledPosts").getMany(autopilot.scheduledPostIds.slice(-12)),
    autopilot.hypothesis?.experimentId ? ws.collection("experiments").get(autopilot.hypothesis.experimentId) : Promise.resolve(null),
  ]);
  return {
    autopilot,
    waitingFor: reasonText(autopilot.waitingOn.reason),
    runs: runs.map((r) => ({ id: r.id, kind: r.kind, status: r.status, goal: r.goal, model: r.model, usage: r.usage, createdAt: r.createdAt })),
    jobs: jobs.map((j) => ({ id: j.id, type: j.type, status: j.status, progress: j.progress, error: j.error, creditsCharged: j.creditsCharged, reservation: j.reservation, createdAt: j.createdAt, finishedAt: j.finishedAt })),
    checkpoint: checkpoint && checkpoint.status === "pending" ? checkpoint : null,
    reviews: reviews.map((r) => ({ id: r.id, subject: r.subject, subjectVersion: r.subjectVersion, status: r.status, reviewer: r.reviewer, findings: r.findings, summary: r.summary, overrides: r.overrides })),
    findings: findings.filter((f) => f.appId === autopilot.appId).map((f) => ({ id: f.id, kind: f.kind, statement: f.statement, confidence: f.confidence, evidence: f.evidence })),
    compositions: compositions.map((c) => ({ id: c.id, title: c.title, currentVersion: c.currentVersion, variantId: c.variantId })),
    posts: posts.map((x) => ({ id: x.id, status: x.status, channel: x.channel, scheduledAt: x.scheduledAt, compositionId: x.compositionId })),
    experiment: experiment ? { id: experiment.id, title: experiment.title, status: experiment.status, launchWindow: experiment.launchWindow, variants: experiment.variants, primaryMetric: experiment.primaryMetric } : null,
  };
}
