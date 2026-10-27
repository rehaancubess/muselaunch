import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { serve } = await import("@hono/node-server");
const { createPlatform, createRunner } = await import("@muselaunch/platform");
const { buildApp } = await import("./app");

const platform = createPlatform();
if (platform.cfg.JOB_DISPATCH === "inline") {
  // Single-process mode: the API also executes jobs (local demos only).
  const { handlers } = await import("@muselaunch/worker/registry");
  createRunner(platform, handlers, "api-inline");
}

const app = buildApp(platform);
const port = Number(process.env.PORT ?? platform.cfg.API_PORT);
serve({ fetch: app.fetch, port }, () => {
  platform.log.info({ port, db: platform.db.driver, storage: platform.storage.driver, jobs: platform.jobs.dispatchMode }, "MuseLaunch API listening");
});
