import { runAlwaysOn, wakeDueAutopilots } from "@muselaunch/autopilot";
import { runDueScheduledPosts } from "@muselaunch/growth";
import { checkPushReceipts, type Platform } from "@muselaunch/platform";

/**
 * The worker's crons, for single-process modes. Same names and functions as apps/worker
 * (`/tasks/cron/:name`) and the Cloud Scheduler jobs in scripts/deploy.ts.
 */
export function localCrons(p: Platform): Record<string, () => Promise<unknown>> {
  return {
    "publish-due": () => runDueScheduledPosts(p),
    "autopilot-wake": () => wakeDueAutopilots(p),
    // Always on: weekly research sweep + suggestions, pace clamp, waking loops whose queue ran low, weekly email.
    // Also: push receipts from Expo (removes the tokens of uninstalled phone apps).
    "always-on": async () => ({ ...(await runAlwaysOn(p)), push: await checkPushReceipts(p) }),
  };
}

/**
 * Single-process modes (JOB_DISPATCH=inline, fixture mode) have no worker, so nothing calls the
 * worker's crons. Run the same functions on an in-process timer: due scheduled posts (only ever
 * approved ones), Growth Autopilot wake-ups, which also resume loops whose resume step was refused
 * at the time (e.g. the plan's concurrent-task limit was reached when their last job finished), and
 * Always on (idempotent: its sweeps and emails are weekly however often it runs).
 */
export function startLocalCrons(p: Platform, intervalMs = 60_000): () => void {
  const crons = localCrons(p);
  let busy = false;
  const tick = setInterval(() => {
    if (busy) return;
    busy = true;
    void Promise.allSettled(Object.entries(crons).map(([name, fn]) => fn().catch((err) => p.log.warn({ err, cron: name }, "local cron failed")))).finally(() => {
      busy = false;
    });
  }, intervalMs);
  tick.unref();
  return () => clearInterval(tick);
}
