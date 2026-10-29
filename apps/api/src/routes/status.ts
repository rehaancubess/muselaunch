import { providerStatuses, textRouting } from "@muselaunch/providers";
import { Hono } from "hono";
import type { AppEnv } from "../context";

export const statusRoutes = new Hono<AppEnv>();

/**
 * Honest provider availability (live / restricted / not configured) for the signed-in user, plus which
 * text engine each route uses here (`textRouting`: Muse Spark or Muse Spark Open), so the UI names the
 * model that will run.
 */
statusRoutes.get("/status/providers", async (c) => {
  const p = c.get("platform");
  let country = c.get("country");
  if (!country) country = (await p.db.top("users").get(c.get("user").uid))?.country;
  return c.json({ items: providerStatuses(p, country), country: country ?? null, jobDispatch: p.jobs.dispatchMode, storage: p.storage.driver, db: p.db.driver, textRouting: textRouting(p) });
});
