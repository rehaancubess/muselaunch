import { autopilotDetail, autopilotSettings, cancelAutopilot, decideCheckpoint, estimateAutopilot, pauseAutopilot, planAutoStart, resumeAutopilot, startAutoAutopilot, startAutopilot } from "@muselaunch/autopilot";
import { can, StartAutoAutopilotRequest, StartAutopilotRequest } from "@muselaunch/contracts";
import { APPROVER_CAP } from "@muselaunch/growth";
import { AppError } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, query, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * Owner: module B (Intelligence): Growth Autopilot — a bounded autonomous loop orchestrated by
 * Muse Wonder. Mounted under /v1/workspaces/:workspaceId (membership enforced).
 *
 * SECURITY: starting a loop is content work (content.write); every delegated job reserves its own
 * credits within the loop budget. Pre-authorising spend without a checkpoint (autoApproveCredits > 0)
 * requires billing.manage; deciding a checkpoint (approve or reject) requires content.approve plus the
 * approver capability of the checkpoint's action (growth APPROVER_CAP: spend → billing.manage,
 * agent_continue → content.approve), so editors never decide. The loop never
 * publishes or sends: it only drafts posts and requests per-post approval.
 */
export const autopilotRoutes = new Hono<AppEnv>();

const SPEND_CAP = APPROVER_CAP.spend;
const ws = (c: Ctx) => c.get("platform").db.ws(c.get("workspaceId"));

async function autopilotOf(c: Ctx) {
  return ws(c).collection("autopilots").getOrThrow(c.req.param("id")!);
}

/** Optional JSON body (empty body → schema defaults). */
async function optionalBody<S extends z.ZodTypeAny>(c: Ctx, schema: S): Promise<z.infer<S>> {
  const raw = await c.req.text();
  if (!raw.trim()) return schema.parse({});
  try {
    return schema.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof SyntaxError) throw new AppError("BAD_REQUEST", "Request body must be JSON");
    throw err;
  }
}

/** POST /apps/:appId/autopilot → 202 { autopilot, job } */
autopilotRoutes.post("/apps/:appId/autopilot", requireCap("content.write"), async (c) => {
  const app = await ws(c).collection("apps").getOrThrow(c.req.param("appId"));
  const input = await body(c, StartAutopilotRequest);
  if (input.autoApproveCredits > 0 && !can(c.get("member"), SPEND_CAP)) {
    throw new AppError("FORBIDDEN", `Auto-approving spend requires ${SPEND_CAP}`, { userMessage: "Only members who manage billing can let renders run without asking. Set the auto-approve limit to 0." });
  }
  const out = await startAutopilot(c.get("platform"), c.get("workspaceId"), app.id, input, actorOf(c));
  return c.json(out, 202);
});

/**
 * GET /apps/:appId/autopilot/auto → { plan, settings }: what a one-tap run would use (default goal,
 * budget covering one full iteration, pre-approved renders) and whether the credits cover it; when
 * they don't, `plan.smaller` offers a smaller run that fits. Read-only.
 */
autopilotRoutes.get("/apps/:appId/autopilot/auto", async (c) => {
  const app = await ws(c).collection("apps").getOrThrow(c.req.param("appId"));
  const plan = await planAutoStart(c.get("platform"), c.get("workspaceId"), app.id, { member: c.get("member") });
  return c.json({ plan, settings: autopilotSettings(c.get("workspace")) });
});

/**
 * POST /apps/:appId/autopilot/auto { variants? } → 202 { autopilot, job, plan }: start with the
 * defaults (content.write). Renders are pre-approved inside the budget only for members who manage
 * billing (and when the workspace allows it). Short on credits → 402 with details.plan (incl. a
 * smaller run that fits); nothing starts.
 */
autopilotRoutes.post("/apps/:appId/autopilot/auto", requireCap("content.write"), async (c) => {
  const app = await ws(c).collection("apps").getOrThrow(c.req.param("appId"));
  const input = await optionalBody(c, StartAutoAutopilotRequest);
  const out = await startAutoAutopilot(c.get("platform"), c.get("workspaceId"), app.id, { variants: input.variants, member: c.get("member"), actor: actorOf(c) });
  return c.json(out, 202);
});

/** GET /apps/:appId/autopilot/estimate?variants=&maxIterations= → typical credits (before starting). */
autopilotRoutes.get("/apps/:appId/autopilot/estimate", async (c) => {
  await ws(c).collection("apps").getOrThrow(c.req.param("appId"));
  const q = query(c, z.object({ variants: z.coerce.number().int().min(1).max(3).default(2), maxIterations: z.coerce.number().int().min(1).max(3).default(1) }));
  return c.json(estimateAutopilot(c.get("platform"), q));
});

autopilotRoutes.get("/apps/:appId/autopilots", async (c) => {
  const app = await ws(c).collection("apps").getOrThrow(c.req.param("appId"));
  const page = await ws(c).collection("autopilots").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 });
  // List view: the decision log stays on the detail endpoint.
  return c.json({ items: page.items.map(({ log, ...rest }) => ({ ...rest, logCount: log.length, lastLog: log[log.length - 1] ?? null })), nextCursor: page.nextCursor });
});

/** GET /autopilots/:id → { autopilot, waitingFor, runs, jobs, checkpoint, reviews } */
autopilotRoutes.get("/autopilots/:id", async (c) => {
  const ap = await autopilotOf(c);
  return c.json(await autopilotDetail(c.get("platform"), c.get("workspaceId"), ap.id));
});

autopilotRoutes.post("/autopilots/:id/pause", requireCap("content.write"), async (c) => {
  const ap = await autopilotOf(c);
  return c.json({ autopilot: await pauseAutopilot(c.get("platform"), c.get("workspaceId"), ap.id, actorOf(c)) });
});

autopilotRoutes.post("/autopilots/:id/resume", requireCap("content.write"), async (c) => {
  const ap = await autopilotOf(c);
  return c.json(await resumeAutopilot(c.get("platform"), c.get("workspaceId"), ap.id, actorOf(c)), 202);
});

autopilotRoutes.post("/autopilots/:id/cancel", requireCap("content.write"), async (c) => {
  const ap = await autopilotOf(c);
  return c.json({ autopilot: await cancelAutopilot(c.get("platform"), c.get("workspaceId"), ap.id, actorOf(c)) });
});

const Decision = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(1000).optional() });

/**
 * Deciding a checkpoint: every checkpoint action needs at least content.approve (editors never decide),
 * plus the action's own approver capability (spend → billing.manage), for approve AND reject.
 */
async function decide(c: Ctx, input: z.infer<typeof Decision>) {
  const ap = await autopilotOf(c);
  if (ap.status !== "awaiting_user" || !ap.waitingOn.approvalId) throw new AppError("CONFLICT", "This autopilot isn't waiting for a decision");
  const approval = await ws(c).collection("approvals").getOrThrow(ap.waitingOn.approvalId);
  const cap = APPROVER_CAP[approval.action];
  if (!can(c.get("member"), cap)) throw new AppError("FORBIDDEN", `Deciding a ${approval.action} checkpoint requires ${cap}`, { userMessage: approval.action === "spend" ? "Only members who manage billing can approve spending." : "Only members who can approve content can decide this." });
  const out = await decideCheckpoint(c.get("platform"), c.get("workspaceId"), ap.id, input, actorOf(c));
  return c.json(out, input.decision === "approve" ? 202 : 200);
}

/** POST /autopilots/:id/checkpoint { decision: "approve" | "reject", note } */
autopilotRoutes.post("/autopilots/:id/checkpoint", requireCap("content.approve"), async (c) => decide(c, await optionalBody(c, Decision)));
/** Same decision as explicit approve/reject routes (covered by the security inventory's decision-route rule). */
autopilotRoutes.post("/autopilots/:id/checkpoint/approve", requireCap("content.approve"), async (c) => decide(c, { decision: "approve", note: (await optionalBody(c, Decision.pick({ note: true }))).note }));
autopilotRoutes.post("/autopilots/:id/checkpoint/reject", requireCap("content.approve"), async (c) => decide(c, { decision: "reject", note: (await optionalBody(c, Decision.pick({ note: true }))).note }));
