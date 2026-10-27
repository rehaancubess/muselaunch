import type { Autopilot } from "@muselaunch/contracts";
import type { Platform } from "@muselaunch/platform";
import { enqueueStep } from "./step";
import { isTerminalJob, nowMs, resumeKey } from "./state";

const installed = new WeakSet<Platform>();

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

/**
 * Job lifecycle hook: when a job a Growth Autopilot is waiting on reaches a terminal state (or
 * pauses for approval), enqueue the loop's next `autopilot.step`. The idempotency key is derived
 * from the awaited job set, so concurrent completions enqueue exactly one resume step.
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
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { workspaces, woken, resumed };
}
