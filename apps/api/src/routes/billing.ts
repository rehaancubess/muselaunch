import { PlanId, UpgradeRequestInput } from "@muselaunch/contracts";
import {
  adminSetPlan,
  currentSubscription,
  ensurePeriodAllowance,
  isAdmin,
  listUpgradeRequests,
  opsSummary,
  paymentProvider,
  planFor,
  quotaUsage,
  recordUpgradeRequest,
  usageSummary,
} from "@muselaunch/analytics";
import { AppError } from "@muselaunch/platform";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { actorOf, body, query, requireCap, type AppEnv } from "../context";

/**
 * Owner: module F (Platform): plans, subscriptions, usage dashboards, admin operations.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * Use requireCap(...) for writes, body(c, Schema) for input, and return contract-shaped JSON.
 */
export const billingRoutes = new Hono<AppEnv>();

const PAYMENTS_MESSAGE = "Payments aren't enabled in the beta. Request an upgrade and an operator will switch your plan; nothing is charged.";

billingRoutes.get("/billing/plans", async (c) => {
  const p = c.get("platform");
  const workspace = c.get("workspace");
  await ensurePeriodAllowance(p, workspace.id, workspace);
  const subscription = await currentSubscription(p, workspace);
  const payments = paymentProvider(p);
  return c.json({
    plans: Object.values(p.credits.plans),
    current: { plan: planFor(p, workspace.planId), subscription },
    payments: { enabled: payments.enabled, provider: payments.id, message: payments.enabled ? undefined : PAYMENTS_MESSAGE },
    allowancePolicy: "Each billing period (calendar month, UTC) your available credits are topped up to your plan's monthly credits. Unused credits don't accumulate beyond that.",
    creditPrices: p.credits.prices,
  });
});

billingRoutes.get("/billing/subscription", async (c) => {
  const p = c.get("platform");
  return c.json({ subscription: await currentSubscription(p, c.get("workspace")) });
});

billingRoutes.get("/billing/quotas", async (c) => {
  const p = c.get("platform");
  const workspace = c.get("workspace");
  await ensurePeriodAllowance(p, workspace.id, workspace);
  return c.json(await quotaUsage(p, workspace.id, workspace));
});

const UsageQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.enum(["model", "provider", "task", "day"]).default("model"),
});

billingRoutes.get("/billing/usage/summary", async (c) => {
  const p = c.get("platform");
  const q = query(c, UsageQuery);
  const to = q.to ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(q.to) ? `${q.to}T00:00:00Z` : q.to) + (/^\d{4}-\d{2}-\d{2}$/.test(q.to) ? 86_400_000 : 0) : Date.now();
  const from = q.from ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(q.from) ? `${q.from}T00:00:00Z` : q.from) : to - 30 * 86_400_000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new AppError("BAD_REQUEST", "Invalid range");
  if (to - from > 400 * 86_400_000) throw new AppError("BAD_REQUEST", "Range can be at most 400 days");
  return c.json(await usageSummary(p, c.get("workspaceId"), { from, to, groupBy: q.groupBy }));
});

billingRoutes.post("/billing/upgrade-request", requireCap("billing.manage"), async (c) => {
  const p = c.get("platform");
  const input = await body(c, UpgradeRequestInput);
  return c.json(await recordUpgradeRequest(p, c.get("workspace"), input, actorOf(c)), 201);
});

billingRoutes.get("/billing/upgrade-requests", async (c) => {
  return c.json({ items: await listUpgradeRequests(c.get("platform"), c.get("workspaceId")) });
});

/** Explicit: there is no checkout in the beta (never a fake success). */
billingRoutes.post("/billing/checkout", requireCap("billing.manage"), async (c) => {
  const p = c.get("platform");
  const input = await body(c, z.object({ planId: PlanId }));
  const out = await paymentProvider(p).createCheckout({ workspaceId: c.get("workspaceId"), planId: input.planId, successUrl: p.cfg.PUBLIC_WEB_URL, cancelUrl: p.cfg.PUBLIC_WEB_URL });
  return c.json(out);
});

// ---------------------------------------------------------------------------
// Operator (ADMIN_UIDS) — also mountable at /v1/admin by the integrator.
// ---------------------------------------------------------------------------

/** Non-admins get 404 so the admin surface can't be discovered. */
const adminOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdmin(c.get("user").uid)) throw new AppError("NOT_FOUND", `Route ${c.req.method} ${c.req.path} not found`);
  await next();
};

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", adminOnly);

adminRoutes.get("/ops", async (c) => c.json(await opsSummary(c.get("platform"))));

adminRoutes.get("/upgrade-requests", async (c) => c.json({ items: await listUpgradeRequests(c.get("platform")) }));

adminRoutes.post("/workspaces/:targetId/plan", async (c) => {
  const input = await body(c, z.object({ planId: PlanId, note: z.string().max(500).optional() }));
  return c.json(await adminSetPlan(c.get("platform"), c.req.param("targetId"), input.planId, `admin:${actorOf(c)}`, input.note));
});

adminRoutes.post("/workspaces/:targetId/credits", async (c) => {
  const p = c.get("platform");
  const input = await body(c, z.object({ delta: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0), reason: z.string().min(3).max(200), idempotencyKey: z.string().min(8).max(120) }));
  const target = await p.db.top("workspaces").get(c.req.param("targetId"));
  if (!target) throw new AppError("NOT_FOUND", "Workspace not found");
  const balance = await p.credits.adjust(target.id, input.delta, { reason: input.reason, idempotencyKey: input.idempotencyKey, actor: `admin:${actorOf(c)}` });
  return c.json({ balance });
});

billingRoutes.route("/admin", adminRoutes);
