import { handlers as agentHandlers } from "@muselaunch/agents";
import { handlers as analyticsHandlers } from "@muselaunch/analytics";
import { handlers as autopilotHandlers } from "@muselaunch/autopilot";
import { handlers as growthHandlers } from "@muselaunch/growth";
import { handlers as mediaHandlers } from "@muselaunch/media";
import type { HandlerRegistry } from "@muselaunch/platform";
import { handlers as renderHandlers } from "@muselaunch/render";

/**
 * Every job handler, merged from module packages. A job type registered by two modules is a
 * contract violation and fails fast at startup.
 */
function merge(...sources: [string, HandlerRegistry][]): HandlerRegistry {
  const out: Record<string, unknown> = {};
  const owner: Record<string, string> = {};
  for (const [name, reg] of sources) {
    for (const [type, fn] of Object.entries(reg)) {
      if (!fn) continue;
      if (out[type]) throw new Error(`Job type ${type} registered by both ${owner[type]} and ${name}`);
      out[type] = fn;
      owner[type] = name;
    }
  }
  return out as HandlerRegistry;
}

export const handlers: HandlerRegistry = merge(
  ["agents", agentHandlers],
  ["media", mediaHandlers],
  ["render", renderHandlers],
  ["growth", growthHandlers],
  ["analytics", analyticsHandlers],
  ["autopilot", autopilotHandlers],
);
