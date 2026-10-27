import type { ErrorInfo, Job, ModelUsageEvent } from "@muselaunch/contracts";
import { nowIso } from "@muselaunch/db";
import type { Platform } from "@muselaunch/platform";
import { z } from "zod";
import { listUpgradeRequests } from "./billing";

/**
 * Global ops counters under `ops/*`. Firestore can't query across workspaces through the
 * repository layer, so counters are maintained from JobService/UsageMeter hooks instead of
 * scanning tenants. Gauges are best-effort (at-least-once delivery may drift them slightly);
 * the admin view says so.
 */

const Count = z.number().int().nonnegative().default(0);
const JobsDay = z.object({
  created: Count,
  started: Count,
  succeeded: Count,
  failed: Count,
  cancelled: Count,
  retried: Count,
  needsApproval: Count,
  failedByType: z.record(z.string(), z.number().int()).default({}),
  failedByCode: z.record(z.string(), z.number().int()).default({}),
  updatedAt: z.string(),
});
const JobsActive = z.object({ queued: z.number().int().default(0), running: z.number().int().default(0), updatedAt: z.string() });
const Leases = z.object({ items: z.record(z.string(), z.object({ workspaceId: z.string(), type: z.string(), leaseExpiresAt: z.string().optional(), startedAt: z.string().optional() })).default({}) });
const Failure = z.object({ at: z.string(), workspaceId: z.string(), jobId: z.string(), type: z.string(), code: z.string(), message: z.string() });
const Failures = z.object({ items: z.array(Failure).default([]) });
const ProviderStat = z.object({ calls: z.number().int().default(0), errors: z.number().int().default(0), usd: z.number().default(0) });
const UsageDay = z.object({ byProvider: z.record(z.string(), ProviderStat).default({}), byModel: z.record(z.string(), ProviderStat).default({}), errorCodes: z.record(z.string(), z.number().int()).default({}), updatedAt: z.string() });
const SpendCounter = z.object({ usd: z.number(), calls: z.number().int(), updatedAt: z.string() });

const day = (iso = nowIso()) => iso.slice(0, 10);
const k = {
  jobsDay: (d: string) => `jobs.day.${d}`,
  active: "jobs.active",
  leases: "jobs.leases",
  failures: "jobs.failures",
  usageDay: (d: string) => `usage.day.${d}`,
  spendDay: (d: string) => `spend.day.${d}`,
};

const ACTIVE = new Set<Job["status"]>(["queued", "running"]);

export async function recordJobTransition(p: Platform, e: { workspaceId: string; job: Job; from: Job["status"] | null; to: Job["status"]; error?: ErrorInfo }): Promise<void> {
  const d = day();
  await p.db.runTransaction(async (tx) => {
    const stats = (await tx.getGlobal(k.jobsDay(d), JobsDay)) ?? JobsDay.parse({ updatedAt: nowIso() });
    const active = (await tx.getGlobal(k.active, JobsActive)) ?? { queued: 0, running: 0, updatedAt: nowIso() };
    const leases = (await tx.getGlobal(k.leases, Leases)) ?? { items: {} };
    const failures = e.to === "failed" ? ((await tx.getGlobal(k.failures, Failures)) ?? { items: [] }) : null;

    if (e.from === null) stats.created++;
    if (e.to === "running" && e.from !== "running") stats.started++;
    if (e.to === "succeeded") stats.succeeded++;
    if (e.to === "needs_approval") stats.needsApproval++;
    if (e.to === "cancelled") stats.cancelled++;
    if (e.to === "queued" && e.from === "running") stats.retried++;
    if (e.to === "failed") {
      stats.failed++;
      stats.failedByType[e.job.type] = (stats.failedByType[e.job.type] ?? 0) + 1;
      const code = e.error?.code ?? e.job.error?.code ?? "UNKNOWN";
      stats.failedByCode[code] = (stats.failedByCode[code] ?? 0) + 1;
    }
    stats.updatedAt = nowIso();

    const next = { ...active };
    if (e.from && ACTIVE.has(e.from)) next[e.from as "queued" | "running"] = Math.max(0, next[e.from as "queued" | "running"] - 1);
    if (ACTIVE.has(e.to)) next[e.to as "queued" | "running"] += 1;
    next.updatedAt = nowIso();

    const items = { ...leases.items };
    if (e.to === "running") items[e.job.id] = { workspaceId: e.workspaceId, type: e.job.type, leaseExpiresAt: e.job.leaseExpiresAt, startedAt: e.job.startedAt };
    else delete items[e.job.id];
    const keys = Object.keys(items);
    if (keys.length > 500) for (const id of keys.slice(0, keys.length - 500)) delete items[id];

    tx.setGlobal(k.jobsDay(d), JobsDay, stats);
    tx.setGlobal(k.active, JobsActive, next);
    tx.setGlobal(k.leases, Leases, { items });
    if (failures) {
      const err = e.error ?? e.job.error;
      const entry = { at: nowIso(), workspaceId: e.workspaceId, jobId: e.job.id, type: e.job.type, code: err?.code ?? "UNKNOWN", message: (err?.message ?? "").slice(0, 300) };
      tx.setGlobal(k.failures, Failures, { items: [entry, ...failures.items].slice(0, 50) });
    }
  });
}

export async function recordUsageEvent(p: Platform, _workspaceId: string, e: ModelUsageEvent): Promise<void> {
  const d = day(e.createdAt);
  await p.db.runTransaction(async (tx) => {
    const cur = (await tx.getGlobal(k.usageDay(d), UsageDay)) ?? UsageDay.parse({ updatedAt: nowIso() });
    const bump = (rec: Record<string, z.infer<typeof ProviderStat>>, key: string) => {
      const s = rec[key] ?? { calls: 0, errors: 0, usd: 0 };
      rec[key] = { calls: s.calls + 1, errors: s.errors + (e.status === "error" ? 1 : 0), usd: Math.round((s.usd + e.costUsdEstimate) * 1e6) / 1e6 };
    };
    bump(cur.byProvider, e.provider);
    bump(cur.byModel, `${e.provider}/${e.model}`);
    if (e.status === "error") cur.errorCodes[e.errorCode ?? "UNKNOWN"] = (cur.errorCodes[e.errorCode ?? "UNKNOWN"] ?? 0) + 1;
    cur.updatedAt = nowIso();
    tx.setGlobal(k.usageDay(d), UsageDay, cur);
  });
}

export async function opsSummary(p: Platform, now = new Date()) {
  const today = day(now.toISOString());
  const yesterday = day(new Date(now.getTime() - 86_400_000).toISOString());
  const g = <S extends z.ZodTypeAny>(key: string, s: S) => p.db.global(key, s).get();
  const [spendToday, jobsToday, jobsYesterday, active, leases, failures, usageToday, usageYesterday, upgrades] = await Promise.all([
    g(k.spendDay(today), SpendCounter),
    g(k.jobsDay(today), JobsDay),
    g(k.jobsDay(yesterday), JobsDay),
    g(k.active, JobsActive),
    g(k.leases, Leases),
    g(k.failures, Failures),
    g(k.usageDay(today), UsageDay),
    g(k.usageDay(yesterday), UsageDay),
    listUpgradeRequests(p),
  ]);
  const nowMs = now.getTime();
  const stuck = Object.entries(leases?.items ?? {})
    .filter(([, v]) => v.leaseExpiresAt && Date.parse(v.leaseExpiresAt) < nowMs)
    .map(([jobId, v]) => ({ jobId, ...v, expiredForMin: Math.round((nowMs - Date.parse(v.leaseExpiresAt!)) / 60_000) }));
  const rates = (u: z.infer<typeof UsageDay> | null) =>
    Object.entries(u?.byProvider ?? {}).map(([provider, s]) => ({ provider, calls: s.calls, errors: s.errors, errorRate: s.calls ? Math.round((s.errors / s.calls) * 1000) / 1000 : 0, usd: s.usd }));
  return {
    generatedAt: now.toISOString(),
    spend: { todayUsd: spendToday?.usd ?? 0, todayCalls: spendToday?.calls ?? 0, globalDailyCeilingUsd: p.cfg.GLOBAL_DAILY_SPEND_CEILING_USD, workspaceMonthlyCeilingUsd: p.cfg.WORKSPACE_MONTHLY_SPEND_CEILING_USD, pctOfCeiling: p.cfg.GLOBAL_DAILY_SPEND_CEILING_USD ? Math.round(((spendToday?.usd ?? 0) / p.cfg.GLOBAL_DAILY_SPEND_CEILING_USD) * 1000) / 10 : null },
    jobs: { today: jobsToday, yesterday: jobsYesterday, active: active ?? { queued: 0, running: 0 }, stuckLeases: stuck, note: "Active counts are maintained incrementally from job transitions and may drift slightly after crashes; stuck leases list running jobs whose lease expired." },
    recentFailures: failures?.items ?? [],
    providers: { today: rates(usageToday), yesterday: rates(usageYesterday), errorCodesToday: usageToday?.errorCodes ?? {}, byModelToday: usageToday?.byModel ?? {} },
    upgradeRequests: upgrades.filter((r) => r.status === "recorded").slice(0, 50),
  };
}

export function isAdmin(uid: string): boolean {
  const ids = (process.env.ADMIN_UIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(uid);
}
