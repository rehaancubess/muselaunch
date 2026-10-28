import { can, type Autopilot, type Job } from "@muselaunch/contracts";
import { toAppError, type Platform } from "@muselaunch/platform";
import { autopilotSettings } from "./defaults";
import { enqueueStep } from "./step";
import { isTerminalJob, nowMs, resumeKey } from "./state";

const installed = new WeakSet<Platform>();
/** A "running" loop with no step in flight for this long is considered stalled and re-entered. */
const STALL_MS = 60_000;

/** Resume every loop waiting on `jobId` once all of its awaited jobs are terminal. */
async function resumeWaiting(p: Platform, workspaceId: string, appId: string, jobId: string): Promise<number> {
  const ws = p.db.ws(workspaceId);
  const waiting = await ws.collection("autopilots").list({ where: [["appId", "==", appId], ["status", "==", "waiting_on_jobs"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 });
  let n = 0;
  for (const ap of waiting.items) {
    if (!ap.waitingOn.jobIds.includes(jobId)) continue;
    const jobs = await ws.collection("jobs").getMany(ap.waitingOn.jobIds);
    if (jobs.length !== ap.waitingOn.jobIds.length || !jobs.every(isTerminalJob)) continue;
    await enqueueStep(p, ap, resumeKey(ap));
    n++;
  }
  return n;
}

/** Jobs that bring in new measured results (RevenueCat sync, CSV import). */
const MEASURED_DATA_JOBS = new Set<Job["type"]>(["analytics.sync", "analytics.import_csv"]);
/** At most one automatic recommendations run per app in this window. */
export const AUTO_RECOMMEND_COOLDOWN_MS = 6 * 3_600_000;

/**
 * Autopilot on: when new measured data arrives for an app (a sync or CSV import that wrote
 * observations), generate recommendations from it automatically — the same `recommendations.generate`
 * job as the Insights button, charged to the workspace's credits and attributed to whoever brought the
 * data in (if they may still run analytics). Skips quietly when off, unchanged, cooling down or short
 * of credits; never invents data (the job only reads measured observations).
 */
export async function autoRecommendOnNewData(p: Platform, workspaceId: string, job: Job): Promise<Job | null> {
  if (!MEASURED_DATA_JOBS.has(job.type) || job.status !== "succeeded" || !job.appId) return null;
  const data = (job.output?.data ?? {}) as { observationCount?: number; observations?: number; alreadyCommitted?: boolean };
  const written = data.observationCount ?? data.observations ?? 0;
  if (!written || data.alreadyCommitted) return null;
  const workspace = await p.db.top("workspaces").get(workspaceId);
  if (!autopilotSettings(workspace).enabled) return null;
  const ws = p.db.ws(workspaceId);
  const member = await ws.collection("members").get(job.createdBy);
  if (!member || !can(member, "analytics.write")) return null;
  const recent = await ws.collection("jobs").list({ where: [["appId", "==", job.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 });
  const now = Date.now();
  if (recent.items.some((j) => j.type === "recommendations.generate" && (j.status === "queued" || j.status === "running" || now - Date.parse(j.createdAt) < AUTO_RECOMMEND_COOLDOWN_MS))) return null;
  try {
    return await p.jobs.create(workspaceId, "recommendations.generate", { appId: job.appId }, { actor: member.userId, appId: job.appId, idempotencyKey: `auto-recs:${job.id}`, credits: { operation: "recommendations.generate" } });
  } catch (raw) {
    const e = toAppError(raw);
    p.log.info({ workspaceId, appId: job.appId, code: e.code }, "automatic recommendations skipped");
    return null;
  }
}

/**
 * Job lifecycle hook: when a job a Growth Autopilot is waiting on reaches a terminal state (or
 * pauses for approval), enqueue the loop's next `autopilot.step`. The idempotency key is derived
 * from the awaited job set, so concurrent completions enqueue exactly one resume step. With
 * Autopilot on, new measured data also triggers recommendations (autoRecommendOnNewData).
 * Install once per process (API and worker).
 */
export function installAutopilotHooks(p: Platform): () => void {
  if (installed.has(p)) return () => {};
  installed.add(p);
  const off = p.jobs.addHooks({
    onStatus: async ({ workspaceId, job, to }) => {
      if (job.type === "autopilot.step" || !job.appId) return;
      if (!isTerminalJob({ status: to })) return;
      await resumeWaiting(p, workspaceId, job.appId, job.id);
      if (to === "succeeded" && MEASURED_DATA_JOBS.has(job.type)) await autoRecommendOnNewData(p, workspaceId, job);
    },
  });
  return () => {
    installed.delete(p);
    off();
  };
}

/**
 * Cron: wake loops whose sleep (measure window) is over, and resume any loop whose awaited jobs
 * all finished but whose hook was missed (e.g. a process restart). Safe to call every few minutes.
 */
export async function wakeDueAutopilots(p: Platform): Promise<{ workspaces: number; woken: number; resumed: number }> {
  let cursor: string | null | undefined;
  let workspaces = 0;
  let woken = 0;
  let resumed = 0;
  const now = nowMs(p);
  do {
    const page = await p.db.top("workspaces").list({ limit: 100, cursor });
    for (const w of page.items) {
      workspaces++;
      const ws = p.db.ws(w.id);
      const sleeping = await ws.collection("autopilots").list({ where: [["status", "==", "sleeping"]], limit: 100 });
      for (const ap of sleeping.items) {
        if (!ap.waitingOn.until || Date.parse(ap.waitingOn.until) > now) continue;
        await enqueueStep(p, ap, `autopilot:${ap.id}:wake:${ap.waitingOn.until}`);
        woken++;
      }
      const waiting = await ws.collection("autopilots").list({ where: [["status", "==", "waiting_on_jobs"]], limit: 100 });
      for (const ap of waiting.items as Autopilot[]) {
        const jobs = await ws.collection("jobs").getMany(ap.waitingOn.jobIds);
        if (jobs.length === ap.waitingOn.jobIds.length && jobs.every(isTerminalJob)) {
          await enqueueStep(p, ap, resumeKey(ap));
          resumed++;
        }
      }
      // A loop left "running" with no step queued or running (its next step couldn't be enqueued,
      // or the process restarted mid-step): re-enter the current stage. Stage work is idempotent.
      const running = (await ws.collection("autopilots").list({ where: [["status", "==", "running"]], limit: 100 })).items.filter((ap) => now - Date.parse(ap.updatedAt) > STALL_MS);
      if (running.length) {
        const active = (await ws.collection("jobs").list({ where: [["status", "in", ["queued", "running"]]], limit: 200 })).items;
        for (const ap of running) {
          if (active.some((j) => j.type === "autopilot.step" && (j.payload as { autopilotId?: string }).autopilotId === ap.id)) continue;
          await enqueueStep(p, ap, `autopilot:${ap.id}:repair:${ap.updatedAt}`);
          resumed++;
        }
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { workspaces, woken, resumed };
}
