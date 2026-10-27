import { CreateWorkspaceRequest, UpdateMeRequest } from "@muselaunch/contracts";
import { nowIso } from "@muselaunch/db";
import { Hono } from "hono";
import { body, type AppEnv } from "../context";
import { acceptInvite, createWorkspace, ensureUser } from "../services/workspaces";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/me", async (c) => {
  const p = c.get("platform");
  const user = await ensureUser(p, c.get("user"));
  const rows = await Promise.all(
    user.workspaceIds.map(async (wid) => {
      const [workspace, member] = await Promise.all([p.db.top("workspaces").get(wid), p.db.ws(wid).collection("members").get(user.id)]);
      return workspace && member && member.status === "active" ? { workspace, member } : null;
    }),
  );
  return c.json({ user, workspaces: rows.filter(Boolean) });
});

meRoutes.patch("/me", async (c) => {
  const p = c.get("platform");
  const input = await body(c, UpdateMeRequest);
  const user = await ensureUser(p, c.get("user"));
  if (input.defaultWorkspaceId && !user.workspaceIds.includes(input.defaultWorkspaceId)) input.defaultWorkspaceId = undefined;
  const updated = await p.db.top("users").update(user.id, {
    displayName: input.displayName ?? user.displayName,
    country: input.country?.toUpperCase() ?? user.country,
    defaultWorkspaceId: input.defaultWorkspaceId ?? user.defaultWorkspaceId,
    onboardingCompletedAt: input.onboardingCompleted ? (user.onboardingCompletedAt ?? nowIso()) : user.onboardingCompletedAt,
  });
  return c.json({ user: updated });
});

meRoutes.post("/workspaces", async (c) => {
  const { name } = await body(c, CreateWorkspaceRequest);
  const result = await createWorkspace(c.get("platform"), c.get("user"), name);
  return c.json(result, 201);
});

meRoutes.post("/invites/:token/accept", async (c) => {
  const result = await acceptInvite(c.get("platform"), c.get("user"), c.req.param("token"));
  return c.json(result);
});
