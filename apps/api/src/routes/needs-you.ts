import { needsYou } from "@muselaunch/autopilot";
import { Id } from "@muselaunch/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { query, type AppEnv } from "../context";

/**
 * "Needs you": the approvals that really need a person (publish a post, send outreach, approve spend,
 * let a loop continue), for the top-bar badge and the app Home. Mounted under
 * /v1/workspaces/:workspaceId (membership enforced). Read-only for every member: each item says
 * whether the caller can decide it, and names the existing decision route, which re-checks the
 * permission (publish / outreach.send / billing.manage / content.approve) and the content snapshot.
 */
export const needsYouRoutes = new Hono<AppEnv>();

/** GET /needs-you?appId= → { items: NeedsYouItem[], count } */
needsYouRoutes.get("/needs-you", async (c) => {
  const q = query(c, z.object({ appId: Id.optional(), limit: z.coerce.number().int().min(1).max(50).default(50) }));
  if (q.appId) await c.get("platform").db.ws(c.get("workspaceId")).collection("apps").getOrThrow(q.appId);
  return c.json(await needsYou(c.get("platform"), c.get("workspaceId"), c.get("member"), { appId: q.appId, limit: q.limit }));
});
