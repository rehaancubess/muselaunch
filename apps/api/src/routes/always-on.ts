import { alwaysOnStatus, decidePace, decideSuggestion, updateAlwaysOn } from "@muselaunch/autopilot";
import { UpdateAlwaysOnRequest } from "@muselaunch/contracts";
import { APPROVER_CAP } from "@muselaunch/growth";
import { AppError } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * "Always on" Growth Autopilot per app (module B, @muselaunch/autopilot always-on.ts). Mounted under
 * /v1/workspaces/:workspaceId (membership enforced).
 *
 * SECURITY: reading the status is open to every member. Changing the setting is content work, the
 * same capability as starting Autopilot (content.write); the pace is checked against the plan
 * server-side. Always on's own Needs-you decisions (a research suggestion, the pace decision) stand
 * in for Autopilot checkpoints (agent_continue), so they need its approver capability
 * (content.approve): editors never decide. Nothing here publishes: every post keeps its own
 * publish approval.
 */
export const alwaysOnRoutes = new Hono<AppEnv>();

const DECIDE_CAP = APPROVER_CAP.agent_continue;
const ws = (c: Ctx) => c.get("platform").db.ws(c.get("workspaceId"));
const Note = z.object({ note: z.string().max(1000).optional() });

async function appOf(c: Ctx) {
  return ws(c).collection("apps").getOrThrow(c.req.param("appId")!);
}

/** Optional JSON body (empty → {}). */
async function optionalNote(c: Ctx): Promise<z.infer<typeof Note>> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    return Note.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof SyntaxError) throw new AppError("BAD_REQUEST", "Request body must be JSON");
    throw err;
  }
}

/** GET /apps/:appId/always-on → AlwaysOnStatus (settings, pace options for the plan, credits, queue, weekly summary). */
alwaysOnRoutes.get("/apps/:appId/always-on", async (c) => {
  const app = await appOf(c);
  return c.json(await alwaysOnStatus(c.get("platform"), c.get("workspaceId"), app.id));
});

/** PUT /apps/:appId/always-on { enabled?, postsPerWeek?, emailSummary? } → { status, start } */
alwaysOnRoutes.put("/apps/:appId/always-on", requireCap("content.write"), async (c) => {
  const app = await appOf(c);
  const input = await body(c, UpdateAlwaysOnRequest);
  return c.json(await updateAlwaysOn(c.get("platform"), c.get("workspaceId"), app.id, input, { member: c.get("member"), actor: actorOf(c) }));
});

/** POST /apps/:appId/always-on/suggestions/:approvalId/approve → a round of videos focused on it. */
alwaysOnRoutes.post("/apps/:appId/always-on/suggestions/:approvalId/approve", requireCap(DECIDE_CAP), async (c) => {
  const app = await appOf(c);
  const out = await decideSuggestion(c.get("platform"), c.get("workspaceId"), app.id, c.req.param("approvalId"), { decision: "approve", note: (await optionalNote(c)).note }, { member: c.get("member"), actor: actorOf(c) });
  return c.json(out, 202);
});

/** POST /apps/:appId/always-on/suggestions/:approvalId/reject → noted (an opportunity is marked dismissed in Discover). */
alwaysOnRoutes.post("/apps/:appId/always-on/suggestions/:approvalId/reject", requireCap(DECIDE_CAP), async (c) => {
  const app = await appOf(c);
  return c.json(await decideSuggestion(c.get("platform"), c.get("workspaceId"), app.id, c.req.param("approvalId"), { decision: "reject", note: (await optionalNote(c)).note }, { member: c.get("member"), actor: actorOf(c) }));
});

/** POST /apps/:appId/always-on/pace/approve → the lower pace offered (or Always on off when already once a week). */
alwaysOnRoutes.post("/apps/:appId/always-on/pace/approve", requireCap(DECIDE_CAP), async (c) => {
  const app = await appOf(c);
  return c.json(await decidePace(c.get("platform"), c.get("workspaceId"), app.id, { decision: "approve", note: (await optionalNote(c)).note }, { member: c.get("member"), actor: actorOf(c) }));
});

/** POST /apps/:appId/always-on/pace/reject → keep the pace (noted); Always on waits for credits. */
alwaysOnRoutes.post("/apps/:appId/always-on/pace/reject", requireCap(DECIDE_CAP), async (c) => {
  const app = await appOf(c);
  return c.json(await decidePace(c.get("platform"), c.get("workspaceId"), app.id, { decision: "reject", note: (await optionalNote(c)).note }, { member: c.get("member"), actor: actorOf(c) }));
});
