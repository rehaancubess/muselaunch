import { wakeDueAutopilots } from "@muselaunch/autopilot";
import { runDueScheduledPosts } from "@muselaunch/growth";
import type { Platform } from "@muselaunch/platform";

/**
 * Single-process modes (JOB_DISPATCH=inline, fixture mode) have no worker, so nothing calls the
 * worker's crons. Run the same functions on an in-process timer: due scheduled posts (only ever
 * approved ones) and Growth Autopilot wake-ups, which also resume loops whose resume step was refused
 * at the time (e.g. the plan's concurrent-task limit was reached when their last job finished).
 */
export function startLocalCrons(p: Platform, intervalMs = 60_000): () => void {
  const crons: Record<string, () => Promise<unknown>> = {
    "publish-due": () => runDueScheduledPosts(p),
    "autopilot-wake": () => wakeDueAutopilots(p),
  };
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
