import { Id } from "@muselaunch/contracts";
import {
  addProspectContact,
  AddContactRequest,
  campaignFromOpportunity,
  competitorProfile,
  createProspect,
  CreateProspectRequest,
  createTracker,
  CreateTrackerRequest,
  CREDITS_PER_TRACKER,
  CreateCampaignFromOpportunity,
  discoverFeed,
  DraftRequest,
  FeedQuery,
  investigateOpportunity,
  InvestigateRequest,
  listProspects,
  MAX_TRACKERS_PER_REFRESH,
  prospectView,
  setOpportunityStatus,
  storyRow,
  updateProspect,
  UpdateProspectRequest,
  updateTracker,
  UpdateTrackerRequest,
} from "@muselaunch/growth";
import { AppError } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, idempotencyKey, query, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * Owner: module E (Growth): Discover feed, opportunities actions, tracked accounts (story row, refresh,
 * competitor profiles), creator prospects (CRM) and outreach drafting.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 */
export const discoverRoutes = new Hono<AppEnv>();

const wsOf = (c: Ctx) => c.get("platform").db.ws(c.get("workspaceId"));

async function app(c: Ctx) {
  const id = Id.parse(c.req.param("appId"));
  return wsOf(c).collection("apps").getOrThrow(id);
}

// ---------------------------------------------------------------------------
// Feed + opportunities
// ---------------------------------------------------------------------------

discoverRoutes.get("/apps/:appId/discover/feed", async (c) => {
  const a = await app(c);
  const q = query(c, FeedQuery);
  return c.json(await discoverFeed(wsOf(c), a.id, q));
});

discoverRoutes.get("/apps/:appId/opportunities/:id", async (c) => {
  const a = await app(c);
  const o = await wsOf(c).collection("opportunities").getOrThrow(c.req.param("id"));
  if (o.appId !== a.id) throw new AppError("NOT_FOUND", "Opportunity not found");
  const findings = await wsOf(c).collection("researchFindings").getMany(o.findingIds);
  return c.json({ opportunity: o, findings });
});

for (const [action, status] of [
  ["save", "saved"],
  ["dismiss", "dismissed"],
  ["restore", "new"],
] as const) {
  discoverRoutes.post(`/apps/:appId/opportunities/:id/${action}`, requireCap("content.write"), async (c) => {
    const a = await app(c);
    return c.json({ opportunity: await setOpportunityStatus(wsOf(c), a.id, c.req.param("id"), status, actorOf(c)) });
  });
}

discoverRoutes.post("/apps/:appId/opportunities/:id/investigate", requireCap("content.write"), async (c) => {
  const a = await app(c);
  const input = await body(c, InvestigateRequest);
  const out = await investigateOpportunity(c.get("platform"), c.get("workspaceId"), a.id, c.req.param("id"), input, { actor: actorOf(c), idempotencyKey: idempotencyKey(c) });
  return c.json(out, 202);
});

discoverRoutes.post("/apps/:appId/opportunities/:id/campaign", requireCap("content.write"), async (c) => {
  const a = await app(c);
  const input = await body(c, CreateCampaignFromOpportunity);
  const out = await campaignFromOpportunity(c.get("platform"), c.get("workspaceId"), a.id, c.req.param("id"), input, { actor: actorOf(c), idempotencyKey: idempotencyKey(c) });
  return c.json(out, 202);
});

// ---------------------------------------------------------------------------
// Tracked accounts
// ---------------------------------------------------------------------------

discoverRoutes.get("/apps/:appId/trackers", async (c) => {
  const a = await app(c);
  const kind = c.req.query("kind");
  const page = await wsOf(c).collection("trackedCreators").list({ where: [["appId", "==", a.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 });
  return c.json({ items: page.items.filter((t) => !kind || t.kind === kind), nextCursor: null });
});

discoverRoutes.get("/apps/:appId/trackers/stories", async (c) => {
  const a = await app(c);
  const page = await wsOf(c).collection("trackedCreators").list({ where: [["appId", "==", a.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 });
  return c.json({ items: storyRow(page.items) });
});

discoverRoutes.post("/apps/:appId/trackers", requireCap("content.write"), async (c) => {
  const a = await app(c);
  const input = await body(c, CreateTrackerRequest);
  return c.json({ tracker: await createTracker(wsOf(c), a.id, input, actorOf(c)) }, 201);
});

const RefreshRequest = z.object({ trackedCreatorIds: z.array(Id).max(MAX_TRACKERS_PER_REFRESH).default([]) });

discoverRoutes.post("/apps/:appId/trackers/refresh", requireCap("content.write"), async (c) => {
  const a = await app(c);
  const input = await body(c, RefreshRequest);
  const ws = wsOf(c);
  const all = (await ws.collection("trackedCreators").list({ where: [["appId", "==", a.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 })).items;
  const ids = input.trackedCreatorIds.length ? input.trackedCreatorIds : all.slice(0, MAX_TRACKERS_PER_REFRESH).map((t) => t.id);
  const known = new Set(all.map((t) => t.id));
  if (!ids.length) throw new AppError("BAD_REQUEST", "Track at least one account first", { userMessage: "Add an account to track first." });
  if (ids.some((id) => !known.has(id))) throw new AppError("NOT_FOUND", "Tracker not found");
  const job = await c.get("platform").jobs.create(c.get("workspaceId"), "discover.refresh", { appId: a.id, trackedCreatorIds: ids }, {
    actor: actorOf(c),
    appId: a.id,
    idempotencyKey: idempotencyKey(c),
    credits: { operation: "discover.refresh", amount: ids.length * CREDITS_PER_TRACKER },
  });
  return c.json({ job }, 202);
});

discoverRoutes.get("/trackers/:id", async (c) => c.json({ tracker: await wsOf(c).collection("trackedCreators").getOrThrow(c.req.param("id")) }));

discoverRoutes.patch("/trackers/:id", requireCap("content.write"), async (c) => {
  const input = await body(c, UpdateTrackerRequest);
  return c.json({ tracker: await updateTracker(wsOf(c), c.req.param("id"), input, actorOf(c)) });
});

discoverRoutes.delete("/trackers/:id", requireCap("content.write"), async (c) => {
  const ws = wsOf(c);
  await ws.collection("trackedCreators").getOrThrow(c.req.param("id"));
  await ws.collection("trackedCreators").delete(c.req.param("id"));
  return c.json({ ok: true });
});

discoverRoutes.get("/trackers/:id/profile", async (c) => {
  const t = await wsOf(c).collection("trackedCreators").getOrThrow(c.req.param("id"));
  if (!t.appId) throw new AppError("NOT_FOUND", "Tracker not found");
  return c.json({ profile: await competitorProfile(wsOf(c), t.appId, { trackerId: t.id }) });
});

discoverRoutes.get("/apps/:appId/discover/competitors/:competitorId", async (c) => {
  const a = await app(c);
  return c.json({ profile: await competitorProfile(wsOf(c), a.id, { competitorId: c.req.param("competitorId") }) });
});

// ---------------------------------------------------------------------------
// Creator prospects (CRM)
// ---------------------------------------------------------------------------

discoverRoutes.get("/apps/:appId/prospects", async (c) => {
  const a = await app(c);
  return c.json({ items: await listProspects(wsOf(c), a.id, c.req.query("status") || undefined), nextCursor: null });
});

discoverRoutes.post("/apps/:appId/prospects", requireCap("content.write"), async (c) => {
  const a = await app(c);
  const input = await body(c, CreateProspectRequest);
  return c.json({ prospect: prospectView(await createProspect(wsOf(c), a.id, input, actorOf(c))) }, 201);
});

discoverRoutes.get("/prospects/:id", async (c) => {
  const ws = wsOf(c);
  const p = await ws.collection("outreachProspects").getOrThrow(c.req.param("id"));
  const drafts = (await ws.collection("outreachDrafts").list({ where: [["appId", "==", p.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((d) => d.prospectId === p.id);
  return c.json({ prospect: prospectView(p), drafts });
});

discoverRoutes.patch("/prospects/:id", requireCap("content.write"), async (c) => {
  const input = await body(c, UpdateProspectRequest);
  return c.json({ prospect: await updateProspect(wsOf(c), c.req.param("id"), input, actorOf(c)) });
});

discoverRoutes.post("/prospects/:id/contacts", requireCap("content.write"), async (c) => {
  const input = await body(c, AddContactRequest);
  return c.json({ prospect: await addProspectContact(wsOf(c), c.req.param("id"), input, actorOf(c)) });
});

discoverRoutes.post("/apps/:appId/prospects/draft", requireCap("content.write"), async (c) => {
  const a = await app(c);
  const input = await body(c, DraftRequest);
  const ws = wsOf(c);
  const prospects = await ws.collection("outreachProspects").getMany(input.prospectIds);
  if (prospects.length !== input.prospectIds.length || prospects.some((x) => x.appId !== a.id)) throw new AppError("NOT_FOUND", "Prospect not found");
  if (input.campaignId) {
    const cpg = await ws.collection("campaigns").getOrThrow(input.campaignId);
    if (cpg.appId !== a.id) throw new AppError("NOT_FOUND", "Campaign not found");
  }
  const job = await c.get("platform").jobs.create(c.get("workspaceId"), "outreach.draft", { appId: a.id, prospectIds: input.prospectIds, campaignId: input.campaignId, offer: input.offer }, {
    actor: actorOf(c),
    appId: a.id,
    idempotencyKey: idempotencyKey(c),
    credits: { operation: "outreach.draft", amount: (c.get("platform").credits.prices["outreach.draft"] ?? 3) * input.prospectIds.length },
  });
  return c.json({ job }, 202);
});
