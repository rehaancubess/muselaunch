import { estimatePostChange, requestPostChange, today } from "@muselaunch/autopilot";
import { ChangePostRequest, PostChangePart } from "@muselaunch/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, query, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * Creator → Today and "Tell Muse what to change" (module B, @muselaunch/autopilot today.ts and
 * post-change.ts). Mounted under /v1/workspaces/:workspaceId (membership enforced).
 *
 * SECURITY: reading Today is open to every member (each decision says whether the caller can make
 * it, and "Looks good" calls the existing approval route, which re-checks the publish permission and
 * the snapshot). Asking Muse to change a post is content work (content.write), the same capability
 * as the Studio's AI edit and editing a post; the changed post's approval starts over.
 */
export const todayRoutes = new Hono<AppEnv>();

const ws = (c: Ctx) => c.get("platform").db.ws(c.get("workspaceId"));

/** GET /apps/:appId/today → TodayResponse */
todayRoutes.get("/apps/:appId/today", async (c) => {
  const app = await ws(c).collection("apps").getOrThrow(c.req.param("appId"));
  return c.json(await today(c.get("platform"), c.get("workspaceId"), c.get("member"), app.id));
});

/** GET /posts/:id/change/estimate?part=video|caption → { credits, breakdown, available } (before anything is spent). */
todayRoutes.get("/posts/:id/change/estimate", async (c) => {
  const post = await ws(c).collection("scheduledPosts").getOrThrow(c.req.param("id")); // 404 before anything else
  const q = query(c, z.object({ part: PostChangePart }));
  return c.json(await estimatePostChange(c.get("platform"), c.get("workspaceId"), post.id, q.part));
});

/** POST /posts/:id/change { part, instruction, spoken? } → 202 { post, change, job } */
todayRoutes.post("/posts/:id/change", requireCap("content.write"), async (c) => {
  const input = await body(c, ChangePostRequest);
  return c.json(await requestPostChange(c.get("platform"), c.get("workspaceId"), c.req.param("id"), input, actorOf(c)), 202);
});
