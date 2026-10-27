import { decideStrategy } from "@muselaunch/agents";
import { AgentBudget, Channel, CreateCampaignRequest, Id, ProduceVariantRequest, ResearchKind } from "@muselaunch/contracts";
import { APPROVER_CAP } from "@muselaunch/growth";
import { AppError } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, idempotencyKey, query, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * Owner: module B (Intelligence): campaigns, concepts, briefs, storyboards, copy packs, research,
 * strategy runs, agent runs. Mounted under /v1/workspaces/:workspaceId (membership enforced).
 */
export const campaignRoutes = new Hono<AppEnv>();

/** Optional JSON body (empty body → schema defaults). */
async function optionalBody<S extends z.ZodTypeAny>(c: Ctx, schema: S): Promise<z.infer<S>> {
  const raw = await c.req.text();
  if (!raw.trim()) return schema.parse({});
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be JSON");
  }
  return schema.parse(value);
}

const ws = (c: Ctx) => c.get("platform").db.ws(c.get("workspaceId"));
const appOf = (c: Ctx) => ws(c).collection("apps").getOrThrow(c.req.param("appId")!);

async function campaignOf(c: Ctx) {
  return ws(c).collection("campaigns").getOrThrow(c.req.param("campaignId") ?? c.req.param("id")!);
}

async function variantOf(c: Ctx, campaignId: string) {
  const v = await ws(c).collection("campaignVariants").getOrThrow(c.req.param("variantId")!);
  if (v.campaignId !== campaignId) throw new AppError("NOT_FOUND", "Variant not found");
  return v;
}

async function requireDna(c: Ctx, appId: string) {
  if (!(await ws(c).collection("brandProfiles").get(appId))) {
    throw new AppError("CONFLICT", "App DNA is required first", { userMessage: "Build your App DNA first (import your listing or describe your app)." });
  }
}

const List = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(512).optional() });

// ---------------------------------------------------------------------------
// Campaigns, concepts, production, copy
// ---------------------------------------------------------------------------

campaignRoutes.get("/apps/:appId/campaigns", async (c) => {
  const app = await appOf(c);
  const q = query(c, List);
  const page = await ws(c).collection("campaigns").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: q.limit, cursor: q.cursor });
  return c.json({ items: page.items.filter((x) => x.status !== "archived"), nextCursor: page.nextCursor });
});

/** POST /apps/:appId/campaigns → 202 { campaign, job } (Muse Spark concepts). */
campaignRoutes.post("/apps/:appId/campaigns", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const app = await appOf(c);
  const input = await body(c, CreateCampaignRequest);
  await requireDna(c, app.id);
  if (input.opportunityIds.length) {
    const opps = await ws(c).collection("opportunities").getMany(input.opportunityIds);
    if (opps.length !== input.opportunityIds.length || opps.some((o) => o.appId !== app.id)) throw new AppError("BAD_REQUEST", "opportunityIds must belong to this app");
  }
  const actor = actorOf(c);
  const name = input.request.split(/\r?\n/)[0]!.replace(/\s+/g, " ").trim().slice(0, 80) || "New campaign";
  const campaign = await ws(c).collection("campaigns").create(
    { appId: app.id, name, goal: input.goal, request: input.request, channels: input.channels, deliverables: input.deliverables ?? [], opportunityIds: input.opportunityIds, creditCap: input.creditCap, status: "planning" },
    { actor },
  );
  const job = await p.jobs.create(c.get("workspaceId"), "campaign.generate_concepts", { appId: app.id, campaignId: campaign.id, count: input.conceptCount }, { actor, appId: app.id, idempotencyKey: idempotencyKey(c, `concepts:${campaign.id}`), credits: { operation: "campaign.generate_concepts" } });
  return c.json({ campaign, job }, 202);
});

/** GET /campaigns/:campaignId → { campaign, brief, variants, storyboards, compositions, copyPacks } */
campaignRoutes.get("/campaigns/:campaignId", async (c) => {
  const campaign = await campaignOf(c);
  const byCampaign = { where: [["campaignId", "==", campaign.id]] as const, orderBy: { field: "createdAt", dir: "desc" as const }, limit: 100 };
  const [brief, variants, storyboards, compositions, copyPacks] = await Promise.all([
    campaign.briefId ? ws(c).collection("campaignBriefs").get(campaign.briefId) : Promise.resolve(null),
    ws(c).collection("campaignVariants").list(byCampaign),
    ws(c).collection("storyboards").list(byCampaign),
    ws(c).collection("compositions").list(byCampaign),
    ws(c).collection("copyPacks").list(byCampaign),
  ]);
  return c.json({ campaign, brief, variants: variants.items.reverse(), storyboards: storyboards.items, compositions: compositions.items, copyPacks: copyPacks.items });
});

/** Select a concept (remembered as an accepted angle). */
campaignRoutes.post("/campaigns/:id/variants/:variantId/select", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const campaign = await campaignOf(c);
  const variant = await variantOf(c, campaign.id);
  const actor = actorOf(c);
  const updated = variant.status === "proposed" || variant.status === "rejected" ? await ws(c).collection("campaignVariants").update(variant.id, { status: "selected" }, { actor }) : variant;
  const updatedCampaign = campaign.selectedVariantIds.includes(variant.id) ? campaign : await ws(c).collection("campaigns").update(campaign.id, { selectedVariantIds: [...campaign.selectedVariantIds, variant.id] }, { actor });
  await p.jobs.create(c.get("workspaceId"), "memory.ingest", { appId: campaign.appId, ref: { entity: "campaignVariants", id: variant.id } }, { actor, appId: campaign.appId, idempotencyKey: `memory.ingest:variant:${variant.id}:selected` });
  return c.json({ variant: updated, campaign: updatedCampaign });
});

/** Reject a concept (remembered as a rejected angle so future concepts avoid it). */
campaignRoutes.post("/campaigns/:id/variants/:variantId/reject", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const campaign = await campaignOf(c);
  const variant = await variantOf(c, campaign.id);
  const actor = actorOf(c);
  const updated = await ws(c).collection("campaignVariants").update(variant.id, { status: "rejected" }, { actor });
  const updatedCampaign = await ws(c).collection("campaigns").update(campaign.id, { selectedVariantIds: campaign.selectedVariantIds.filter((x) => x !== variant.id) }, { actor });
  await p.jobs.create(c.get("workspaceId"), "memory.ingest", { appId: campaign.appId, ref: { entity: "campaignVariants", id: variant.id } }, { actor, appId: campaign.appId, idempotencyKey: `memory.ingest:variant:${variant.id}:rejected` });
  return c.json({ variant: updated, campaign: updatedCampaign });
});

/** POST /campaigns/:id/variants/:variantId/produce (202): storyboard → composition build. */
campaignRoutes.post("/campaigns/:id/variants/:variantId/produce", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const campaign = await campaignOf(c);
  const variant = await variantOf(c, campaign.id);
  if (variant.status === "rejected") throw new AppError("CONFLICT", "This concept was rejected; select it again first");
  const input = await body(c, ProduceVariantRequest);
  const job = await p.jobs.create(
    c.get("workspaceId"),
    "storyboard.generate",
    { appId: campaign.appId, campaignId: campaign.id, variantId: variant.id, aspectRatio: input.aspectRatio, targetDurationSec: input.targetDurationSec },
    { actor: actorOf(c), appId: campaign.appId, idempotencyKey: idempotencyKey(c), credits: { operation: "storyboard.generate" } },
  );
  return c.json({ job }, 202);
});

/** POST /campaigns/:id/copy (202): channel-native copy packs, claim-validated. */
campaignRoutes.post("/campaigns/:id/copy", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const campaign = await campaignOf(c);
  const input = await body(c, z.object({ variantId: Id.optional(), channels: z.array(Channel).min(1).max(10) }));
  if (input.variantId) {
    const v = await ws(c).collection("campaignVariants").getOrThrow(input.variantId);
    if (v.campaignId !== campaign.id) throw new AppError("NOT_FOUND", "Variant not found");
  }
  const job = await p.jobs.create(c.get("workspaceId"), "copy.generate", { appId: campaign.appId, campaignId: campaign.id, variantId: input.variantId, channels: input.channels }, { actor: actorOf(c), appId: campaign.appId, idempotencyKey: idempotencyKey(c), credits: { operation: "copy.generate" } });
  return c.json({ job }, 202);
});

// ---------------------------------------------------------------------------
// Research (Muse Wonder) and strategy
// ---------------------------------------------------------------------------

const ResearchRequest = z.object({
  kinds: z.array(ResearchKind).min(1).max(6).default(["opportunities", "trends", "competitors"]),
  countries: z.array(z.string().length(2)).max(10).default([]),
  languages: z.array(z.string().min(2).max(16)).max(5).default([]),
  channels: z.array(Channel).max(10).default([]),
  competitorIds: z.array(Id).max(10).default([]),
  focus: z.string().max(1000).optional(),
});

/** POST /apps/:appId/research (202) → { researchRun, job } */
campaignRoutes.post("/apps/:appId/research", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const app = await appOf(c);
  const input = await body(c, ResearchRequest);
  await requireDna(c, app.id);
  if (input.competitorIds.length) {
    const comps = await ws(c).collection("competitors").getMany(input.competitorIds);
    if (comps.length !== input.competitorIds.length || comps.some((x) => x.appId !== app.id)) throw new AppError("BAD_REQUEST", "competitorIds must belong to this app");
  }
  const actor = actorOf(c);
  const researchRun = await ws(c).collection("researchRuns").create(
    { appId: app.id, kinds: input.kinds, status: "queued", inputs: { countries: input.countries.map((x) => x.toUpperCase()), languages: input.languages, channels: input.channels, competitorIds: input.competitorIds, focus: input.focus } },
    { actor },
  );
  const job = await p.jobs.create(c.get("workspaceId"), "research.run", { appId: app.id, researchRunId: researchRun.id, kinds: input.kinds }, { actor, appId: app.id, idempotencyKey: idempotencyKey(c, `research:${researchRun.id}`), credits: { operation: "research.run" } });
  const updated = await ws(c).collection("researchRuns").update(researchRun.id, { jobId: job.id }, { actor });
  return c.json({ researchRun: updated, job }, 202);
});

campaignRoutes.get("/apps/:appId/research", async (c) => {
  const app = await appOf(c);
  const q = query(c, List);
  const page = await ws(c).collection("researchRuns").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: q.limit, cursor: q.cursor });
  return c.json({ items: page.items, nextCursor: page.nextCursor });
});

campaignRoutes.get("/research-runs/:runId", async (c) => {
  const run = await ws(c).collection("researchRuns").getOrThrow(c.req.param("runId"));
  const findings = await ws(c).collection("researchFindings").list({ where: [["runId", "==", run.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  return c.json({ run, findings: findings.items });
});

/** POST /apps/:appId/strategy (202) → { run, job }: Muse Wonder growth plan; spend needs approval. */
campaignRoutes.post("/apps/:appId/strategy", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const app = await appOf(c);
  const input = await body(c, z.object({ goal: z.string().min(3).max(4000), campaignId: Id.optional() }));
  await requireDna(c, app.id);
  if (input.campaignId) {
    const cp = await ws(c).collection("campaigns").getOrThrow(input.campaignId);
    if (cp.appId !== app.id) throw new AppError("NOT_FOUND", "Campaign not found");
  }
  const actor = actorOf(c);
  const run = await ws(c).collection("agentRuns").create(
    { appId: app.id, kind: "growth_strategy", model: p.cfg.META_MODEL_WONDER, status: "queued", goal: input.goal, budget: AgentBudget.parse({ maxSearchCalls: 4, maxToolCalls: 16, maxCostUsd: 1 }) },
    { actor },
  );
  const job = await p.jobs.create(c.get("workspaceId"), "strategy.run", { appId: app.id, agentRunId: run.id, goal: input.goal, campaignId: input.campaignId }, { actor, appId: app.id, idempotencyKey: idempotencyKey(c, `strategy:${run.id}`), credits: { operation: "strategy.run" }, agentRunId: run.id });
  const updated = await ws(c).collection("agentRuns").update(run.id, { jobId: job.id }, { actor });
  return c.json({ run: updated, job }, 202);
});

// ---------------------------------------------------------------------------
// Agent runs (evidence of real model usage: plan, steps, tool calls, citations, cost)
// ---------------------------------------------------------------------------

campaignRoutes.get("/apps/:appId/agent-runs", async (c) => {
  const app = await appOf(c);
  const q = query(c, List);
  const page = await ws(c).collection("agentRuns").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: q.limit, cursor: q.cursor });
  return c.json({ items: page.items, nextCursor: page.nextCursor });
});

/** GET /agent-runs/:runId → { run, steps, usage, tools } */
campaignRoutes.get("/agent-runs/:runId", async (c) => {
  const run = await ws(c).collection("agentRuns").getOrThrow(c.req.param("runId"));
  const [steps, usage, tools] = await Promise.all([
    ws(c).collection("agentSteps").list({ where: [["runId", "==", run.id]], orderBy: { field: "index", dir: "asc" }, limit: 200 }),
    ws(c).collection("modelUsage").list({ where: [["agentRunId", "==", run.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 }),
    ws(c).collection("toolInvocations").list({ where: [["runId", "==", run.id]], orderBy: { field: "createdAt", dir: "asc" }, limit: 200 }),
  ]);
  return c.json({ run, steps: steps.items, usage: usage.items, tools: tools.items });
});

/**
 * Approve / reject a strategy run's spend proposals (approval checkpoint).
 * SECURITY: the run's pending Approval has action "spend", whose approver capability is
 * `billing.manage` (growth APPROVER_CAP). Deciding it here with only `content.write` let an editor
 * authorise agent-proposed credit spend that the generic /approvals/:id/approve route refuses them.
 */
const SPEND_APPROVER_CAP = APPROVER_CAP.spend;

campaignRoutes.post("/agent-runs/:runId/approve", requireCap(SPEND_APPROVER_CAP), async (c) => {
  const input = await optionalBody(c, z.object({ note: z.string().max(1000).optional() }));
  const out = await decideStrategy(c.get("platform"), { workspaceId: c.get("workspaceId"), runId: c.req.param("runId"), actor: actorOf(c), approve: true, note: input.note });
  return c.json(out, 202);
});

campaignRoutes.post("/agent-runs/:runId/reject", requireCap(SPEND_APPROVER_CAP), async (c) => {
  const input = await optionalBody(c, z.object({ note: z.string().max(1000).optional() }));
  const out = await decideStrategy(c.get("platform"), { workspaceId: c.get("workspaceId"), runId: c.req.param("runId"), actor: actorOf(c), approve: false, note: input.note });
  return c.json(out);
});
