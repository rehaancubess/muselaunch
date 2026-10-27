import type { Job, JobType, Plan, PlanId, Subscription, UpgradeRequestInput, UpgradeRequestRecord, UsageSummary, UsageSummaryRow, Workspace } from "@muselaunch/contracts";
import { UpgradeRequestRecord as UpgradeRequestRecordSchema } from "@muselaunch/contracts";
import { newId, nowIso } from "@muselaunch/db";
import { AppError, type CreateJobOptions, type Platform } from "@muselaunch/platform";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Plans & subscription
// ---------------------------------------------------------------------------

export function planFor(p: Platform, planId: string | undefined): Plan {
  return p.credits.plans[(planId ?? "free") as PlanId] ?? p.credits.plans.free;
}

/** Calendar-month UTC period (used until a payment provider supplies real periods). */
export function calendarPeriod(now = new Date()): { start: string; end: string } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export const SUBSCRIPTION_DOC_ID = "current";

/** The stored subscription, or an honest "no paid subscription" view for the beta. */
export async function currentSubscription(p: Platform, workspace: Workspace): Promise<Subscription & { stored: boolean }> {
  const sub = await p.db.ws(workspace.id).collection("subscriptions").get(SUBSCRIPTION_DOC_ID);
  const period = calendarPeriod();
  if (sub && Date.parse(sub.currentPeriodEnd) > Date.now()) return { ...sub, stored: true };
  if (sub) return { ...sub, currentPeriodStart: period.start, currentPeriodEnd: period.end, stored: true };
  return {
    id: SUBSCRIPTION_DOC_ID,
    workspaceId: workspace.id,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    createdBy: "system",
    planId: (workspace.planId as PlanId) ?? "free",
    status: "none",
    provider: "none",
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    stored: false,
  };
}

const PeriodMarker = z.object({ periodStart: z.string(), planId: z.string(), granted: z.number().int(), at: z.string() });

/**
 * Monthly allowance: at the start of each period the available balance is topped up to the plan's
 * monthly credits (unused credits don't pile up beyond the allowance). Idempotent per period via
 * the ledger idempotency key; the signup grant covers the period the workspace was created in.
 */
export async function ensurePeriodAllowance(p: Platform, workspaceId: string, workspace?: Workspace | null): Promise<{ granted: number; periodStart: string; reason: string }> {
  const ws = workspace ?? (await p.db.top("workspaces").get(workspaceId));
  if (!ws) return { granted: 0, periodStart: "", reason: "workspace not found" };
  const sub = await currentSubscription(p, ws);
  const periodStart = sub.currentPeriodStart;
  const marker = p.db.ws(workspaceId).state("billing.period", PeriodMarker);
  const seen = await marker.get();
  if (seen && seen.periodStart === periodStart) return { granted: 0, periodStart, reason: "already granted this period" };
  const balance = await p.credits.balance(workspaceId);
  if (Date.parse(balance.periodStart) >= Date.parse(periodStart) && !seen) {
    await marker.set({ periodStart, planId: sub.planId, granted: 0, at: nowIso() });
    return { granted: 0, periodStart, reason: "signup grant covers this period" };
  }
  const plan = planFor(p, sub.planId);
  const amount = Math.max(0, plan.monthlyCredits - balance.available - balance.reserved);
  if (amount > 0) await p.credits.grant(workspaceId, amount, { reason: `${plan.name} monthly credits (${periodStart.slice(0, 7)})`, idempotencyKey: `period:${periodStart}`, actor: "system:billing" });
  await marker.set({ periodStart, planId: plan.id, granted: amount, at: nowIso() });
  return { granted: amount, periodStart, reason: amount ? "topped up to plan allowance" : "balance already at or above allowance" };
}

// ---------------------------------------------------------------------------
// Payments (none in the beta)
// ---------------------------------------------------------------------------

export interface PaymentProvider {
  readonly id: "none" | "stripe" | "razorpay" | "lemonsqueezy";
  readonly enabled: boolean;
  createCheckout(input: { workspaceId: string; planId: PlanId; successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
}

/** Honest adapter: payments are not enabled, so nothing pretends a checkout succeeded. */
export const noPayments: PaymentProvider = {
  id: "none",
  enabled: false,
  async createCheckout() {
    throw new AppError("PROVIDER_NOT_CONFIGURED", "Payments are not enabled in the beta", { userMessage: "Payments aren't enabled in the beta. Send an upgrade request and we'll switch your plan." });
  },
};

export function paymentProvider(_p: Platform): PaymentProvider {
  return noPayments;
}

const UpgradeList = z.object({ items: z.array(UpgradeRequestRecordSchema) });

export async function recordUpgradeRequest(p: Platform, workspace: Workspace, input: UpgradeRequestInput, actor: string): Promise<{ request: UpgradeRequestRecord; paymentsEnabled: false; message: string }> {
  if (!p.credits.plans[input.planId]) throw new AppError("BAD_REQUEST", "Unknown plan");
  const request: UpgradeRequestRecord = { id: newId("upg"), workspaceId: workspace.id, planId: input.planId, fromPlanId: workspace.planId, requestedBy: actor, note: input.note, status: "recorded", createdAt: nowIso() };
  await p.db.runTransaction(async (tx) => {
    const local = await tx.getState(workspace.id, "billing.upgradeRequests", UpgradeList);
    const global = await tx.getGlobal("billing.upgradeRequests", UpgradeList);
    tx.setState(workspace.id, "billing.upgradeRequests", UpgradeList, { items: [request, ...(local?.items ?? [])].slice(0, 20) });
    tx.setGlobal("billing.upgradeRequests", UpgradeList, { items: [request, ...(global?.items ?? [])].slice(0, 200) });
  });
  return { request, paymentsEnabled: false, message: "Payments aren't enabled in the beta. Your request is recorded and an operator will switch your plan; nothing has been charged." };
}

export async function listUpgradeRequests(p: Platform, workspaceId?: string): Promise<UpgradeRequestRecord[]> {
  const doc = workspaceId ? await p.db.ws(workspaceId).state("billing.upgradeRequests", UpgradeList).get() : await p.db.global("billing.upgradeRequests", UpgradeList).get();
  return doc?.items ?? [];
}

/** Operator action: set a workspace's plan manually (provider "manual") and grant the allowance difference. */
export async function adminSetPlan(p: Platform, targetWorkspaceId: string, planId: PlanId, actor: string, note?: string): Promise<{ workspace: Workspace; subscription: Subscription; granted: number }> {
  const workspace = await p.db.top("workspaces").get(targetWorkspaceId);
  if (!workspace) throw new AppError("NOT_FOUND", "Workspace not found");
  const from = planFor(p, workspace.planId);
  const to = planFor(p, planId);
  const updated = await p.db.top("workspaces").update(targetWorkspaceId, { planId });
  const period = calendarPeriod();
  const repo = p.db.ws(targetWorkspaceId).collection("subscriptions");
  const fields = { planId, status: "active" as const, provider: "manual" as const, currentPeriodStart: period.start, currentPeriodEnd: period.end };
  const { entity, created } = await repo.createIfAbsent({ id: SUBSCRIPTION_DOC_ID, ...fields }, { actor });
  const subscription = created ? entity : await repo.update(SUBSCRIPTION_DOC_ID, fields, { actor });
  const diff = to.monthlyCredits - from.monthlyCredits;
  if (diff > 0) await p.credits.grant(targetWorkspaceId, diff, { reason: `Plan changed to ${to.name}`, idempotencyKey: `plan-change:${period.start}:${from.id}->${to.id}`, actor });
  await p.db.ws(targetWorkspaceId).collection("auditLog").create({ action: "billing.plan_changed", target: { entity: "subscriptions", id: SUBSCRIPTION_DOC_ID }, data: { from: from.id, to: to.id, note } }, { actor });
  await p.db.runTransaction(async (tx) => {
    const local = await tx.getState(targetWorkspaceId, "billing.upgradeRequests", UpgradeList);
    const global = await tx.getGlobal("billing.upgradeRequests", UpgradeList);
    const mark = (r: UpgradeRequestRecord) => (r.workspaceId === targetWorkspaceId && r.status === "recorded" && r.planId === planId ? { ...r, status: "applied" as const } : r);
    if (local) tx.setState(targetWorkspaceId, "billing.upgradeRequests", UpgradeList, { items: local.items.map(mark) });
    if (global) tx.setGlobal("billing.upgradeRequests", UpgradeList, { items: global.items.map(mark) });
  });
  return { workspace: updated, subscription, granted: Math.max(0, diff) };
}

// ---------------------------------------------------------------------------
// Quotas (plan limits) — installed as a JobService hook
// ---------------------------------------------------------------------------

/** Jobs that never count towards the concurrency limit (cheap/system work triggered implicitly). */
export const CONCURRENCY_EXEMPT: ReadonlySet<JobType> = new Set<JobType>(["media.probe", "memory.ingest", "analytics.sync", "analytics.import_csv"]);
const DAILY_LIMITED: Partial<Record<JobType, "finalRendersPerDay" | "researchRunsPerDay">> = { "render.final": "finalRendersPerDay", "research.run": "researchRunsPerDay" };
const QuotaDay = z.object({ finalRendersPerDay: z.number().int().nonnegative().default(0), researchRunsPerDay: z.number().int().nonnegative().default(0), updatedAt: z.string() });
const quotaKey = (iso: string) => `quota.day.${iso.slice(0, 10)}`;
/** Jobs not updated for this long are treated as stuck and don't block new work. */
const ACTIVE_STALE_MS = 30 * 60_000;

export async function activeJobs(p: Platform, workspaceId: string): Promise<Job[]> {
  const page = await p.db.ws(workspaceId).collection("jobs").list({ where: [["status", "in", ["queued", "running"]]], limit: 200 });
  const now = Date.now();
  return page.items.filter((j) => !CONCURRENCY_EXEMPT.has(j.type) && now - Date.parse(j.updatedAt) < ACTIVE_STALE_MS);
}

export async function quotaUsage(p: Platform, workspaceId: string, workspace?: Workspace | null) {
  const ws = workspace ?? (await p.db.top("workspaces").get(workspaceId));
  const plan = planFor(p, ws?.planId);
  const day = (await p.db.ws(workspaceId).state(quotaKey(nowIso()), QuotaDay).get()) ?? { finalRendersPerDay: 0, researchRunsPerDay: 0 };
  const active = await activeJobs(p, workspaceId);
  return {
    plan,
    day: nowIso().slice(0, 10),
    timezone: "UTC",
    concurrentJobs: { used: active.length, limit: plan.limits.concurrentJobs },
    finalRendersPerDay: { used: day.finalRendersPerDay, limit: plan.limits.finalRendersPerDay },
    researchRunsPerDay: { used: day.researchRunsPerDay, limit: plan.limits.researchRunsPerDay },
  };
}

export async function enforceQuota(p: Platform, input: { workspaceId: string; type: JobType; opts: CreateJobOptions }): Promise<void | (() => Promise<void>)> {
  const workspace = await p.db.top("workspaces").get(input.workspaceId);
  const plan = planFor(p, workspace?.planId);
  await ensurePeriodAllowance(p, input.workspaceId, workspace).catch((err) => p.log.warn({ err }, "period allowance check failed"));
  // Chained children (parentJobId) run under their parent's slot. A user retry also carries a
  // parentJobId (audit link), so it is checked explicitly: otherwise cancel → retry bypassed the limit.
  if ((!input.opts.parentJobId || input.opts.retryOfJobId) && !CONCURRENCY_EXEMPT.has(input.type)) {
    const active = await activeJobs(p, input.workspaceId);
    if (active.length >= plan.limits.concurrentJobs) {
      throw new AppError("QUOTA_EXCEEDED", `Concurrent job limit ${plan.limits.concurrentJobs} reached`, {
        userMessage: `Your ${plan.name} plan runs up to ${plan.limits.concurrentJobs} tasks at once. Wait for one to finish, or request an upgrade.`,
        details: { quota: "concurrentJobs", limit: plan.limits.concurrentJobs, used: active.length },
      });
    }
  }
  const limitKey = DAILY_LIMITED[input.type];
  if (!limitKey) return;
  const limit = plan.limits[limitKey];
  const key = quotaKey(nowIso());
  await p.db.runTransaction(async (tx) => {
    const cur = (await tx.getState(input.workspaceId, key, QuotaDay)) ?? { finalRendersPerDay: 0, researchRunsPerDay: 0, updatedAt: nowIso() };
    if (cur[limitKey] >= limit) {
      const what = limitKey === "finalRendersPerDay" ? "final renders" : "research runs";
      throw new AppError("QUOTA_EXCEEDED", `Daily ${what} limit ${limit} reached`, {
        userMessage: `Your ${plan.name} plan includes ${limit} ${what} per day (UTC). This resets at midnight UTC, or you can request an upgrade.`,
        details: { quota: limitKey, limit, used: cur[limitKey] },
      });
    }
    tx.setState(input.workspaceId, key, QuotaDay, { ...cur, [limitKey]: cur[limitKey] + 1, updatedAt: nowIso() });
  });
  return () => releaseDailySlot(p, input.workspaceId, limitKey, key);
}

async function releaseDailySlot(p: Platform, workspaceId: string, limitKey: "finalRendersPerDay" | "researchRunsPerDay", key: string): Promise<void> {
  await p.db.runTransaction(async (tx) => {
    const cur = await tx.getState(workspaceId, key, QuotaDay);
    if (!cur) return;
    tx.setState(workspaceId, key, QuotaDay, { ...cur, [limitKey]: Math.max(0, cur[limitKey] - 1), updatedAt: nowIso() });
  });
}

/** Failed/cancelled daily-limited work gives its slot back (the user didn't get the output). */
export async function releaseQuotaOnFailure(p: Platform, e: { workspaceId: string; job: Job; to: Job["status"] }): Promise<void> {
  if (e.to !== "failed" && e.to !== "cancelled") return;
  const limitKey = DAILY_LIMITED[e.job.type];
  if (!limitKey) return;
  await releaseDailySlot(p, e.workspaceId, limitKey, quotaKey(e.job.queuedAt));
}

// ---------------------------------------------------------------------------
// Usage summary
// ---------------------------------------------------------------------------

const emptyRow = (key: string): UsageSummaryRow => ({ key, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, images: 0, frames: 0, audioSeconds: 0, costUsd: 0 });

export async function usageSummary(p: Platform, workspaceId: string, input: { from: number; to: number; groupBy: UsageSummary["groupBy"]; cap?: number }): Promise<UsageSummary> {
  const ws = p.db.ws(workspaceId);
  const fromIso = new Date(input.from).toISOString();
  const toIso = new Date(input.to).toISOString();
  const rows = new Map<string, UsageSummaryRow>();
  const totals = emptyRow("total");
  let scanned = 0;
  let cursor: string | null = null;
  const cap = input.cap ?? 20_000;
  do {
    const page = await ws.collection("modelUsage").list({ where: [["createdAt", ">=", fromIso], ["createdAt", "<", toIso]], orderBy: { field: "createdAt", dir: "desc" }, limit: 500, cursor });
    for (const e of page.items) {
      const key = input.groupBy === "model" ? `${e.provider}/${e.model}` : input.groupBy === "provider" ? e.provider : input.groupBy === "task" ? e.task : e.createdAt.slice(0, 10);
      const row = rows.get(key) ?? emptyRow(key);
      for (const r of [row, totals]) {
        r.calls++;
        if (e.status === "error") r.errors++;
        r.inputTokens += e.inputTokens ?? 0;
        r.outputTokens += e.outputTokens ?? 0;
        r.images += e.images ?? 0;
        r.frames += e.frames ?? 0;
        r.audioSeconds += e.audioSeconds ?? 0;
        r.costUsd += e.costUsdEstimate;
      }
      rows.set(key, row);
    }
    scanned += page.items.length;
    cursor = page.nextCursor;
  } while (cursor && scanned < cap);

  const credits = { consumed: 0, granted: 0, released: 0 };
  let lc: string | null = null;
  let ledgerScanned = 0;
  do {
    const page = await ws.collection("creditLedger").list({ where: [["createdAt", ">=", fromIso], ["createdAt", "<", toIso]], orderBy: { field: "createdAt", dir: "desc" }, limit: 500, cursor: lc });
    for (const l of page.items) {
      if (l.type === "consume") credits.consumed += l.credits;
      else if (l.type === "grant") credits.granted += l.credits;
      else if (l.type === "release") credits.released += l.credits;
    }
    ledgerScanned += page.items.length;
    lc = page.nextCursor;
  } while (lc && ledgerScanned < cap);

  const roundRow = (r: UsageSummaryRow): UsageSummaryRow => ({ ...r, costUsd: Math.round(r.costUsd * 1e6) / 1e6, audioSeconds: Math.round(r.audioSeconds * 100) / 100 });
  const sorted = [...rows.values()].map(roundRow).sort((a, b) => (input.groupBy === "day" ? a.key.localeCompare(b.key) : b.costUsd - a.costUsd || b.calls - a.calls));
  return {
    range: { from: fromIso, to: toIso },
    groupBy: input.groupBy,
    rows: sorted,
    totals: roundRow(totals),
    credits,
    truncated: Boolean(cursor),
    costDefinition: "Estimated provider cost in USD recorded per call from token/image/frame/audio counts at list prices (MuseLaunch's cost, not your credit price).",
  };
}
