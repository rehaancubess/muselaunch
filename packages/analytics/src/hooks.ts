import type { Platform } from "@muselaunch/platform";
import { enforceQuota, releaseQuotaOnFailure } from "./billing";
import { recordJobTransition, recordUsageEvent } from "./ops";

const installed = new WeakSet<Platform>();

/**
 * Wire module F into the platform: plan quotas + monthly allowance before job creation, quota
 * release on failure, and global ops counters from job transitions and usage events.
 * Call once per process after `createPlatform()` (API, worker, tests). Idempotent.
 */
export function installAnalyticsHooks(p: Platform): void {
  if (installed.has(p)) return;
  installed.add(p);
  p.jobs.addHooks({
    beforeCreate: (input) => enforceQuota(p, input),
    onStatus: async (e) => {
      await releaseQuotaOnFailure(p, e).catch((err) => p.log.warn({ err }, "quota release failed"));
      await recordJobTransition(p, e);
    },
  });
  p.usage.addHook((wid, event) => recordUsageEvent(p, wid, event));
}
