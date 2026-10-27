import { EstimateRequest } from "@muselaunch/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { body, query, type AppEnv } from "../context";

/** Core credit endpoints used by every module. Plans/subscriptions/admin live in billing.ts (module F). */
export const creditRoutes = new Hono<AppEnv>();

creditRoutes.get("/billing/credits", async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const [balance, ledger, spend] = await Promise.all([p.credits.balance(wid), p.credits.recentLedger(wid, 50), p.usage.spendSummary(wid)]);
  const plan = p.credits.plans[c.get("workspace").planId as keyof typeof p.credits.plans] ?? p.credits.plans.free;
  return c.json({ balance, plan, ledger, spend: { monthUsd: spend.monthWorkspaceUsd, ceilingUsd: spend.ceilings.workspaceMonthly } });
});

creditRoutes.post("/estimate", async (c) => {
  const p = c.get("platform");
  const input = await body(c, EstimateRequest);
  const est = p.credits.estimate(input.operation, input.params);
  const balance = await p.credits.balance(c.get("workspaceId"));
  return c.json({ ...est, available: balance.available });
});

const UsageQuery = z.object({ agentRunId: z.string().optional(), jobId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });

/** Per-call model usage (spec: every invocation traceable and measurable). */
creditRoutes.get("/usage", async (c) => {
  const p = c.get("platform");
  const q = query(c, UsageQuery);
  const where: [string, "==", unknown][] = [];
  if (q.agentRunId) where.push(["agentRunId", "==", q.agentRunId]);
  else if (q.jobId) where.push(["jobId", "==", q.jobId]);
  const page = await p.db.ws(c.get("workspaceId")).collection("modelUsage").list({ where, orderBy: { field: "createdAt", dir: "desc" }, limit: q.limit });
  return c.json(page);
});
