import { getCreateRun, listCreateRuns, resolveCreateRun } from "@muselaunch/autopilot";
import { ResolveCreateRunRequest } from "@muselaunch/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, query, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * Create runs ("Generate video"): the read model any client watches (the web Create page, the phone
 * app) and the one route that answers a run's decision. The server takes every step itself
 * (packages/autopilot/src/create-runner.ts); see packages/contracts/src/create-run.ts for the shapes.
 * Mounted under /v1/workspaces/:workspaceId (membership enforced). Reading needs membership only;
 * resolving needs `content.write`, the capability of the routes it stands in for.
 */
export const createRunRoutes = new Hono<AppEnv>();

const ws = (c: Ctx) => c.get("platform").db.ws(c.get("workspaceId"));

/** GET /apps/:appId/create-runs?limit= → { items: CreateRunView[] } (newest first, the last 7 days). */
createRunRoutes.get("/apps/:appId/create-runs", async (c) => {
  const app = await ws(c).collection("apps").getOrThrow(c.req.param("appId"));
  const q = query(c, z.object({ limit: z.coerce.number().int().min(1).max(20).default(6) }));
  return c.json({ items: await listCreateRuns(c.get("platform"), c.get("workspaceId"), app.id, c.get("member"), { limit: q.limit }) });
});

/** GET /create-runs/:campaignId → { run } */
createRunRoutes.get("/create-runs/:campaignId", async (c) => {
  return c.json({ run: await getCreateRun(c.get("platform"), c.get("workspaceId"), c.req.param("campaignId"), c.get("member")) });
});

/** POST /create-runs/:campaignId/resolve { action, stepKey?, reason? } → 202 { run } */
createRunRoutes.post("/create-runs/:campaignId/resolve", requireCap("content.write"), async (c) => {
  const input = await body(c, ResolveCreateRunRequest);
  const run = await resolveCreateRun(c.get("platform"), c.get("workspaceId"), c.req.param("campaignId"), input, actorOf(c), c.get("member"));
  return c.json({ run }, 202);
});
