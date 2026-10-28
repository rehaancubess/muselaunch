import { autopilotSettings } from "@muselaunch/autopilot";
import { InviteMemberRequest, UpdateMemberRequest } from "@muselaunch/contracts";
import { AppError } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, assertCap, body, requireCap, type AppEnv } from "../context";
import { audit, createInvite } from "../services/workspaces";

/** Workspace settings, members and invites. Mounted under /v1/workspaces/:workspaceId. */
export const workspaceRoutes = new Hono<AppEnv>();

workspaceRoutes.get("/", async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const balance = await p.credits.balance(wid);
  return c.json({ workspace: c.get("workspace"), member: c.get("member"), credits: balance });
});

const UpdateWorkspace = z.object({
  name: z.string().min(1).max(120).optional(),
  settings: z
    .object({
      defaultTimezone: z.string().max(64).optional(),
      defaultLocale: z.string().max(16).optional(),
      /** Growth Autopilot defaults. `maxCreditsPerRun: null` removes the limit. */
      autopilot: z
        .object({ enabled: z.boolean().optional(), autoApproveRenders: z.boolean().optional(), maxCreditsPerRun: z.number().int().positive().max(2000).nullable().optional() })
        .strict()
        .optional(),
    })
    .optional(),
});

/**
 * Workspace settings (workspace.manage). Autopilot spend settings — letting renders run without
 * asking, and the per-run credit limit — pre-authorise spending, so changing them also needs
 * billing.manage (same rule as the start route's auto-approve threshold).
 */
workspaceRoutes.patch("/", requireCap("workspace.manage"), async (c) => {
  const p = c.get("platform");
  const input = await body(c, UpdateWorkspace);
  const ws = c.get("workspace");
  const ap = input.settings?.autopilot;
  if (ap && (ap.autoApproveRenders !== undefined || ap.maxCreditsPerRun !== undefined)) assertCap(c, "billing.manage");
  const { autopilot: _ignored, ...rest } = input.settings ?? {};
  const current = autopilotSettings(ws);
  const maxCreditsPerRun = ap?.maxCreditsPerRun === undefined ? current.maxCreditsPerRun : (ap.maxCreditsPerRun ?? undefined);
  const autopilot = { enabled: ap?.enabled ?? current.enabled, autoApproveRenders: ap?.autoApproveRenders ?? current.autoApproveRenders, ...(maxCreditsPerRun ? { maxCreditsPerRun } : {}) };
  const updated = await p.db.top("workspaces").update(ws.id, { name: input.name ?? ws.name, settings: { ...ws.settings, ...rest, autopilot } });
  await audit(p, ws.id, actorOf(c), "workspace.updated", input);
  return c.json({ workspace: updated });
});

workspaceRoutes.get("/members", async (c) => {
  const p = c.get("platform");
  const page = await p.db.ws(c.get("workspaceId")).collection("members").list({ limit: 100 });
  return c.json({ items: page.items.filter((m) => m.status === "active") });
});

workspaceRoutes.post("/invites", requireCap("members.manage"), async (c) => {
  const p = c.get("platform");
  const input = await body(c, InviteMemberRequest);
  const wid = c.get("workspaceId");
  const plan = p.credits.plans[c.get("workspace").planId as keyof typeof p.credits.plans] ?? p.credits.plans.free;
  const members = (await p.db.ws(wid).collection("members").list({ limit: 200 })).items.filter((m) => m.status === "active");
  if (members.length >= plan.limits.members) throw new AppError("QUOTA_EXCEEDED", `Plan allows ${plan.limits.members} members`);
  const { invite, url } = await createInvite(p, wid, actorOf(c), input.email, input.role);
  // Email delivery is not configured in the beta: the inviter shares the link (shown once).
  return c.json({ invite: { ...invite, tokenHash: undefined }, acceptUrl: url, delivery: "copy_link" }, 201);
});

workspaceRoutes.patch("/members/:uid", requireCap("members.manage"), async (c) => {
  const p = c.get("platform");
  const input = await body(c, UpdateMemberRequest);
  const wid = c.get("workspaceId");
  const target = await p.db.ws(wid).collection("members").getOrThrow(c.req.param("uid"));
  if (target.role === "owner") throw new AppError("FORBIDDEN", "The owner's role can't be changed");
  if ((input.canPublish !== undefined || input.canManageAccounts !== undefined) && c.get("member").role !== "owner") {
    throw new AppError("FORBIDDEN", "Only the owner can grant publishing or account permissions");
  }
  const updated = await p.db.ws(wid).collection("members").update(target.id, input, { actor: actorOf(c) });
  await audit(p, wid, actorOf(c), "member.updated", { uid: target.id, ...input });
  return c.json({ member: updated });
});

workspaceRoutes.delete("/members/:uid", requireCap("members.manage"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const target = await p.db.ws(wid).collection("members").getOrThrow(c.req.param("uid"));
  if (target.role === "owner") throw new AppError("FORBIDDEN", "The owner can't be removed");
  await p.db.ws(wid).collection("members").update(target.id, { status: "removed", canPublish: false, canManageAccounts: false }, { actor: actorOf(c) });
  const profile = await p.db.top("users").get(target.id);
  if (profile) await p.db.top("users").update(target.id, { workspaceIds: profile.workspaceIds.filter((w) => w !== wid) });
  await audit(p, wid, actorOf(c), "member.removed", { uid: target.id });
  return c.json({ ok: true });
});

workspaceRoutes.get("/audit", requireCap("workspace.manage"), async (c) => {
  const p = c.get("platform");
  const page = await p.db.ws(c.get("workspaceId")).collection("auditLog").list({ orderBy: { field: "createdAt", dir: "desc" }, limit: 100 });
  return c.json(page);
});
