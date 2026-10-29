import type { HandlerRegistry } from "@muselaunch/platform";
import { experimentAnalyzeHandler } from "./experiments";
import { importCsvHandler } from "./imports";
import { recommendationsHandler } from "./recommendations";
import { analyticsSyncHandler } from "./revenuecat";
import { youtubeChannelHandler } from "./youtube/channel";

/** Job handlers owned by this module. Registered by apps/worker. */
export const handlers: HandlerRegistry = {
  "analytics.sync": analyticsSyncHandler,
  "analytics.import_csv": importCsvHandler,
  "analytics.youtube_channel": youtubeChannelHandler,
  "experiment.analyze": experimentAnalyzeHandler,
  "recommendations.generate": recommendationsHandler,
};

export * from "./billing";
export * from "./csv";
export * from "./experiments";
export * from "./hooks";
export * from "./imports";
export * from "./insights";
export * from "./links";
export * from "./memory";
export * from "./metrics";
export * from "./observations";
export * from "./ops";
export * from "./recommendations";
export * from "./revenuecat";
export * from "./youtube/channel";
export * from "./youtube/social-sync";
export * from "./youtube/stats";
export * from "./youtube/validate";
