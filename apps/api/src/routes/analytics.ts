import {
  CommitImportRequest,
  ConnectRevenueCatRequest,
  CreateExperimentRequest,
  CreateImportRequest,
  CreateTrackedLinkRequest,
  InsightsQuery,
  ManualObservationRequest,
  MetricName,
  MetricSource,
} from "@muselaunch/contracts";
import {
  acceptRecommendation,
  connectRevenueCat,
  createExperiment,
  createImportPreview,
  createTrackedLink,
  disconnectAnalyticsAccount,
  dismissRecommendation,
  insightsOverview,
  recordManualObservation,
  remapImport,
  rollbackImport,
  setLinkActive,
  updateExperiment,
} from "@muselaunch/analytics";
import { AppError } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, idempotencyKey, query, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * Owner: module F (Analytics): connections, observations, CSV import, tracked links, experiments, recommendations.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * Use requireCap(...) for writes, body(c, Schema) for input, and return contract-shaped JSON.
 */
export const analyticsRoutes = new Hono<AppEnv>();

const ws = (c: Ctx) => c.get("platform").db.ws(c.get("workspaceId"));

async function appOf(c: Ctx) {
  return ws(c).collection("apps").getOrThrow(c.req.param("appId")!);
}

// ---------------------------------------------------------------------------
// Connections (RevenueCat)
// ---------------------------------------------------------------------------

analyticsRoutes.post("/apps/:appId/analytics/revenuecat", requireCap("accounts.manage"), async (c) => {
  const app = await appOf(c);
  const input = await body(c, ConnectRevenueCatRequest.omit({ appId: true }));
  const out = await connectRevenueCat(c.get("platform"), c.get("workspaceId"), { ...input, appId: app.id }, actorOf(c));
  // Never echo the key back.
  return c.json({ account: out.account, job: out.job }, 201);
});

analyticsRoutes.get("/apps/:appId/analytics/connections", async (c) => {
  const app = await appOf(c);
  const page = await ws(c).collection("connectedAccounts").list({ limit: 200 });
  const items = page.items.filter((a) => (!a.appId || a.appId === app.id) && (a.purposes.includes("analytics") || a.capabilities.includes("read_insights") || a.capabilities.includes("read_revenue")));
  return c.json({ items: items.map(({ secretId: _s, ...rest }) => rest), nextCursor: null });
});

analyticsRoutes.post("/analytics/connections/:id/sync", requireCap("analytics.write"), async (c) => {
  const p = c.get("platform");
  const account = await ws(c).collection("connectedAccounts").getOrThrow(c.req.param("id"));
  if (!account.appId) throw new AppError("BAD_REQUEST", "Connection isn't linked to an app");
  if (account.status !== "connected") throw new AppError("CONFLICT", `Connection is ${account.status}`, { userMessage: "Reconnect this account first." });
  const job = await p.jobs.create(c.get("workspaceId"), "analytics.sync", { connectionId: account.id, appId: account.appId }, {
    actor: actorOf(c),
    appId: account.appId,
    idempotencyKey: idempotencyKey(c, `sync:${account.id}:${Math.floor(Date.now() / 60_000)}`),
    credits: { operation: "analytics.sync" },
  });
  return c.json({ job }, 202);
});

analyticsRoutes.delete("/analytics/connections/:id", requireCap("accounts.manage"), async (c) => {
  const account = await disconnectAnalyticsAccount(c.get("platform"), c.get("workspaceId"), c.req.param("id"), actorOf(c));
  const { secretId: _s, ...rest } = account;
  return c.json({ account: rest });
});

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

const ObservationsQuery = z.object({
  metric: MetricName.optional(),
  source: MetricSource.optional(),
  campaignId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
});

analyticsRoutes.get("/apps/:appId/observations", async (c) => {
  const app = await appOf(c);
  const q = query(c, ObservationsQuery);
  const where: [string, "==" | ">=" | "<", unknown][] = [["appId", "==", app.id]];
  if (q.metric) where.push(["metric", "==", q.metric]);
  if (q.from) where.push(["windowStart", ">=", new Date(q.from).toISOString()]);
  if (q.to) where.push(["windowStart", "<", new Date(q.to).toISOString()]);
  const page = await ws(c).collection("metricObservations").list({ where, orderBy: { field: "windowStart", dir: "desc" }, limit: q.limit, cursor: q.cursor });
  const items = page.items.filter((o) => (!q.source || o.source === q.source) && (!q.campaignId || o.campaignId === q.campaignId));
  return c.json({ items, nextCursor: page.nextCursor });
});

analyticsRoutes.post("/apps/:appId/observations", requireCap("analytics.write"), async (c) => {
  const app = await appOf(c);
  const input = await body(c, ManualObservationRequest);
  const out = await recordManualObservation(c.get("platform"), c.get("workspaceId"), app.id, input, actorOf(c));
  return c.json(out, 201);
});

analyticsRoutes.delete("/observations/:id", requireCap("analytics.write"), async (c) => {
  const repo = ws(c).collection("metricObservations");
  const o = await repo.getOrThrow(c.req.param("id"));
  if (!o.provenance.imported) throw new AppError("FORBIDDEN", "Synced or measured observations can't be deleted", { userMessage: "Only imported or manually entered numbers can be deleted." });
  await repo.delete(o.id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CSV imports
// ---------------------------------------------------------------------------

analyticsRoutes.post("/apps/:appId/imports", requireCap("analytics.write"), async (c) => {
  const app = await appOf(c);
  const input = await body(c, CreateImportRequest);
  const out = await createImportPreview(c.get("platform"), c.get("workspaceId"), app.id, input, actorOf(c));
  return c.json(out, 201);
});

analyticsRoutes.get("/apps/:appId/imports", async (c) => {
  const app = await appOf(c);
  const page = await ws(c).collection("importBatches").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50, cursor: c.req.query("cursor") });
  return c.json(page);
});

analyticsRoutes.get("/imports/:id", async (c) => {
  const batch = await ws(c).collection("importBatches").getOrThrow(c.req.param("id"));
  return c.json({ batch });
});

analyticsRoutes.patch("/imports/:id", requireCap("analytics.write"), async (c) => {
  const input = await body(c, CommitImportRequest);
  const batch = await remapImport(c.get("platform"), c.get("workspaceId"), c.req.param("id"), input, actorOf(c));
  return c.json({ batch });
});

analyticsRoutes.post("/imports/:id/commit", requireCap("analytics.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const raw = await c.req.text();
  const input = raw.trim() ? CommitImportRequest.parse(JSON.parse(raw)) : {};
  let batch = await ws(c).collection("importBatches").getOrThrow(c.req.param("id"));
  if (batch.kind !== "csv") throw new AppError("BAD_REQUEST", "Only CSV imports are committed");
  if (batch.status === "committed") throw new AppError("CONFLICT", "Already committed");
  if (input.mapping || input.options) batch = await remapImport(p, wid, batch.id, input, actorOf(c));
  const job = await p.jobs.create(wid, "analytics.import_csv", { appId: batch.appId, importBatchId: batch.id }, {
    actor: actorOf(c),
    appId: batch.appId,
    idempotencyKey: `import:${batch.id}:${batch.updatedAt}`,
    credits: { operation: "analytics.import_csv" },
  });
  return c.json({ batch, job }, 202);
});

analyticsRoutes.delete("/imports/:id", requireCap("analytics.write"), async (c) => {
  const out = await rollbackImport(c.get("platform"), c.get("workspaceId"), c.req.param("id"), actorOf(c));
  return c.json(out);
});

// ---------------------------------------------------------------------------
// Tracked links
// ---------------------------------------------------------------------------

const publicUrl = (c: Ctx, slug: string) => `${(process.env.LINK_PUBLIC_BASE_URL ?? c.get("platform").cfg.API_PUBLIC_URL).replace(/\/$/, "")}/r/${slug}`;

analyticsRoutes.post("/campaigns/:campaignId/links", requireCap("analytics.write"), async (c) => {
  const input = await body(c, CreateTrackedLinkRequest);
  const link = await createTrackedLink(c.get("platform"), c.get("workspaceId"), c.req.param("campaignId"), input, actorOf(c));
  return c.json({ link, publicUrl: publicUrl(c, link.slug) }, 201);
});

analyticsRoutes.get("/campaigns/:campaignId/links", async (c) => {
  await ws(c).collection("campaigns").getOrThrow(c.req.param("campaignId"));
  const page = await ws(c).collection("attributionLinks").list({ where: [["campaignId", "==", c.req.param("campaignId")]], limit: 200 });
  return c.json({ items: page.items.map((l) => ({ ...l, publicUrl: publicUrl(c, l.slug) })), nextCursor: null });
});

analyticsRoutes.get("/apps/:appId/links", async (c) => {
  const app = await appOf(c);
  const page = await ws(c).collection("attributionLinks").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  return c.json({ items: page.items.map((l) => ({ ...l, publicUrl: publicUrl(c, l.slug) })), nextCursor: page.nextCursor });
});

analyticsRoutes.patch("/links/:id", requireCap("analytics.write"), async (c) => {
  const input = await body(c, z.object({ active: z.boolean() }));
  const link = await setLinkActive(c.get("platform"), c.get("workspaceId"), c.req.param("id"), input.active, actorOf(c));
  return c.json({ link: { ...link, publicUrl: publicUrl(c, link.slug) } });
});

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

analyticsRoutes.get("/apps/:appId/insights/overview", async (c) => {
  const app = await appOf(c);
  const q = query(c, InsightsQuery);
  return c.json(await insightsOverview(c.get("platform"), c.get("workspaceId"), app.id, q));
});

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

analyticsRoutes.get("/apps/:appId/experiments", async (c) => {
  const app = await appOf(c);
  const page = await ws(c).collection("experiments").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100, cursor: c.req.query("cursor") });
  return c.json(page);
});

analyticsRoutes.post("/apps/:appId/experiments", requireCap("analytics.write"), async (c) => {
  const app = await appOf(c);
  const input = await body(c, CreateExperimentRequest);
  const experiment = await createExperiment(c.get("platform"), c.get("workspaceId"), app.id, input, actorOf(c));
  return c.json({ experiment }, 201);
});

analyticsRoutes.get("/experiments/:id", async (c) => {
  const experiment = await ws(c).collection("experiments").getOrThrow(c.req.param("id"));
  const results = await ws(c).collection("experimentResults").list({ where: [["experimentId", "==", experiment.id]], limit: 20 });
  results.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json({ experiment, results: results.items });
});

analyticsRoutes.patch("/experiments/:id", requireCap("analytics.write"), async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be JSON");
  }
  const experiment = await updateExperiment(c.get("platform"), c.get("workspaceId"), c.req.param("id"), raw, actorOf(c));
  return c.json({ experiment });
});

analyticsRoutes.post("/experiments/:id/analyze", requireCap("analytics.write"), async (c) => {
  const p = c.get("platform");
  const experiment = await ws(c).collection("experiments").getOrThrow(c.req.param("id"));
  const job = await p.jobs.create(c.get("workspaceId"), "experiment.analyze", { appId: experiment.appId, experimentId: experiment.id }, {
    actor: actorOf(c),
    appId: experiment.appId,
    idempotencyKey: idempotencyKey(c),
    credits: { operation: "experiment.analyze" },
  });
  return c.json({ job }, 202);
});

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

analyticsRoutes.get("/apps/:appId/recommendations", async (c) => {
  const app = await appOf(c);
  const status = c.req.query("status");
  const page = await ws(c).collection("recommendations").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 });
  return c.json({ items: status ? page.items.filter((r) => r.status === status) : page.items, nextCursor: page.nextCursor });
});

analyticsRoutes.post("/apps/:appId/recommendations/generate", requireCap("analytics.write"), async (c) => {
  const p = c.get("platform");
  const app = await appOf(c);
  const job = await p.jobs.create(c.get("workspaceId"), "recommendations.generate", { appId: app.id }, {
    actor: actorOf(c),
    appId: app.id,
    idempotencyKey: idempotencyKey(c),
    credits: { operation: "recommendations.generate" },
  });
  return c.json({ job }, 202);
});

analyticsRoutes.post("/recommendations/:id/accept", requireCap("analytics.write"), async (c) => {
  return c.json(await acceptRecommendation(c.get("platform"), c.get("workspaceId"), c.req.param("id"), actorOf(c)));
});

analyticsRoutes.post("/recommendations/:id/dismiss", requireCap("analytics.write"), async (c) => {
  const raw = await c.req.text();
  const input = raw.trim() ? z.object({ reason: z.string().max(500).optional() }).parse(JSON.parse(raw)) : {};
  const recommendation = await dismissRecommendation(c.get("platform"), c.get("workspaceId"), c.req.param("id"), input.reason, actorOf(c));
  return c.json({ recommendation });
});
