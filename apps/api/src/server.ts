import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const { serve } = await import("@hono/node-server");
const { createPlatform, createRunner } = await import("@muselaunch/platform");
const { buildApp } = await import("./app");

const { installAnalyticsHooks } = await import("@muselaunch/analytics");
const { installCampaignHooks } = await import("@muselaunch/agents");
const { installAutopilotHooks } = await import("@muselaunch/autopilot");

const platform = createPlatform();
// Plan quotas, monthly credit top-ups and ops counters (module F).
installAnalyticsHooks(platform);
// Growth Autopilot (module B): job cancellations/terminal transitions made by the API resume waiting loops.
installAutopilotHooks(platform);
// Campaigns move from "producing" to "review" when their storyboard → build → preview chains finish (module B).
installCampaignHooks(platform);
if (platform.cfg.JOB_DISPATCH === "inline") {
  // Single-process mode: the API also executes jobs (local demos only).
  const { handlers } = await import("@muselaunch/worker/registry");
  createRunner(platform, handlers, "api-inline");
  // No worker in this mode, so run its crons here (due posts, Growth Autopilot wake-ups).
  const { startLocalCrons } = await import("./local-cron");
  if (process.env.LOCAL_CRON !== "0") startLocalCrons(platform);
}

const app = buildApp(platform);
const port = Number(process.env.PORT ?? platform.cfg.API_PORT);
serve({ fetch: app.fetch, port }, () => {
  platform.log.info({ port, db: platform.db.driver, storage: platform.storage.driver, jobs: platform.jobs.dispatchMode }, "MuseLaunch API listening");
});
