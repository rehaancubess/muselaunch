import { UpdatePostToRequest, UpdateQuickSetupRequest } from "@muselaunch/contracts";
import { Hono } from "hono";
import { actorOf, body, requireCap, type AppEnv, type Ctx } from "../context";
import { audit } from "../services/workspaces";

/**
 * The first-run quick setup's answers per app. Mounted under /v1/workspaces/:workspaceId
 * (membership enforced).
 *
 *  - PUT /apps/:appId/post-to      "Where do you post?": the channels Autopilot drafts posts for, or
 *                                  "I'll post myself" (manual). Nothing here connects or posts.
 *  - PUT /apps/:appId/quick-setup  finished or dismissed: the quick setup isn't offered again.
 *
 * SECURITY: both are content work, the same capability as starting Autopilot or changing Always on
 * (content.write); viewers can't change them. Connecting an account stays its own flow
 * (accounts.manage), and every post keeps its publish approval whatever is chosen here.
 */
export const appSetupRoutes = new Hono<AppEnv>();

const apps = (c: Ctx) => c.get("platform").db.ws(c.get("workspaceId")).collection("apps");

/** PUT /apps/:appId/post-to { channels, manual } → { app } */
appSetupRoutes.put("/apps/:appId/post-to", requireCap("content.write"), async (c) => {
  const app = await apps(c).getOrThrow(c.req.param("appId"));
  const input = await body(c, UpdatePostToRequest);
  const actor = actorOf(c);
  // "I'll post myself" is its own answer: it clears the platforms (and no account is ever attached).
  const channels = input.manual ? [] : [...new Set(input.channels)];
  const postTo = { channels, manual: input.manual, updatedBy: actor, updatedAt: new Date().toISOString() };
  const updated = await apps(c).update(app.id, { postTo }, { actor });
  await audit(c.get("platform"), c.get("workspaceId"), actor, "app.post_to_updated", { from: app.postTo ? { channels: app.postTo.channels, manual: app.postTo.manual } : null, to: { channels, manual: input.manual } }, { entity: "apps", id: app.id });
  return c.json({ app: updated });
});

/** PUT /apps/:appId/quick-setup { status: "done" | "dismissed" } → { app } */
appSetupRoutes.put("/apps/:appId/quick-setup", requireCap("content.write"), async (c) => {
  const app = await apps(c).getOrThrow(c.req.param("appId"));
  const input = await body(c, UpdateQuickSetupRequest);
  const actor = actorOf(c);
  // The first answer sticks: a second tab finishing it later doesn't turn "dismissed" into "done" or back.
  if (app.quickSetup) return c.json({ app });
  const updated = await apps(c).update(app.id, { quickSetup: { status: input.status, at: new Date().toISOString(), by: actor } }, { actor });
  return c.json({ app: updated });
});
