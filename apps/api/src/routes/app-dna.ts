import { ClaimContext, HttpUrl, Id, PreferenceKind, ReviewState, SocialHandle, type BrandProfile } from "@muselaunch/contracts";
import { DnaAudience, DnaFeature, HexColor, Monetization } from "@muselaunch/contracts";
import { rememberPreference, retrieveMemory } from "@muselaunch/agents";
import { can } from "@muselaunch/contracts";
import { AppError, assertSafeUrl } from "@muselaunch/platform";
import { glimmerClient } from "@muselaunch/providers";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, idempotencyKey, query, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * Owner: module B (Intelligence): App DNA, evidence, claims, brand kit, competitors, memory/preferences.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 */
export const appDnaRoutes = new Hono<AppEnv>();

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

const Evidenced = z.object({ id: Id, text: z.string().min(1).max(600), evidenceIds: z.array(Id).default([]) });
// Nested patches are explicit (no schema defaults), so sending one field never resets its siblings.
const MonetizationPatch = z.object({ model: Monetization.shape.model, notes: z.string().max(500), evidenceIds: z.array(Id) }).partial().strict();
const TonePatch = z.object({ voice: z.array(z.string().max(60)).max(12), vocabularyUse: z.array(z.string().max(80)).max(50), vocabularyAvoid: z.array(z.string().max(80)).max(50) }).partial().strict();
const VisualPatch = z
  .object({
    palette: z.array(z.object({ hex: HexColor, role: z.enum(["primary", "secondary", "accent", "background", "text", "other"]) })).max(12),
    headingFont: z.string().max(80),
    bodyFont: z.string().max(80),
    styleKeywords: z.array(z.string().max(60)).max(20),
    logoAssetIds: z.array(Id).max(10),
    sampleAssetIds: z.array(Id).max(30),
  })
  .partial()
  .strict();
const UpdateDna = z
  .object({
    oneLiner: z.string().min(1).max(240),
    description: z.string().min(1).max(4000),
    category: z.string().max(120),
    audiences: z.array(DnaAudience).max(10),
    problems: z.array(Evidenced).max(20),
    features: z.array(DnaFeature).max(30),
    differentiators: z.array(Evidenced).max(20),
    monetization: MonetizationPatch,
    tone: TonePatch,
    visual: VisualPatch,
    preferredCtas: z.array(z.string().max(120)).max(20),
    prohibitedClaims: z.array(z.string().max(300)).max(50),
    guidelines: z.string().max(4000),
  })
  .partial()
  .strict();

const NESTED = new Set(["monetization", "tone", "visual"]);

/** GET /apps/:appId/dna → { profile, evidence, claims, import } */
appDnaRoutes.get("/apps/:appId/dna", async (c) => {
  const app = await appOf(c);
  const [profile, evidence, claims, imp] = await Promise.all([
    ws(c).collection("brandProfiles").get(app.id),
    ws(c).collection("appEvidence").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 }),
    ws(c).collection("claims").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 }),
    app.lastImportId ? ws(c).collection("appImports").get(app.lastImportId) : Promise.resolve(null),
  ]);
  return c.json({ profile, evidence: evidence.items, claims: claims.items, import: imp });
});

/** POST /apps/:appId/dna/analyze (202): re-run Muse Spark App DNA (user edits are preserved). */
appDnaRoutes.post("/apps/:appId/dna/analyze", requireCap("apps.write"), async (c) => {
  const p = c.get("platform");
  const app = await appOf(c);
  const input = await optionalBody(c, z.object({ assetIds: z.array(Id).max(12).default([]) }));
  if (input.assetIds.length) {
    const assets = await ws(c).collection("mediaAssets").getMany(input.assetIds);
    if (assets.length !== input.assetIds.length || assets.some((a) => a.appId !== app.id || !a.isProductTruth)) throw new AppError("BAD_REQUEST", "assetIds must be this app's real screenshots/recordings");
  }
  const job = await p.jobs.create(c.get("workspaceId"), "app.analyze", { appId: app.id, assetIds: input.assetIds, refresh: true }, { actor: actorOf(c), appId: app.id, idempotencyKey: idempotencyKey(c), credits: { operation: "app.analyze" } });
  await ws(c).collection("apps").update(app.id, { dnaStatus: "drafting" }, { actor: actorOf(c) });
  return c.json({ job }, 202);
});

/** PATCH /apps/:appId/dna: founder edits; edited paths are recorded so refreshes never overwrite them. */
appDnaRoutes.patch("/apps/:appId/dna", requireCap("apps.write"), async (c) => {
  const p = c.get("platform");
  const app = await appOf(c);
  const input = await body(c, UpdateDna);
  const repo = ws(c).collection("brandProfiles");
  const existing = await repo.get(app.id);
  const actor = actorOf(c);
  const paths = new Set(existing?.userEditedPaths ?? []);
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (NESTED.has(k)) for (const sub of Object.keys(v as object)) paths.add(`${k}.${sub}`);
    else paths.add(k);
  }
  // Feature screenshots must be this app's real media.
  if (input.features) {
    const ids = [...new Set(input.features.flatMap((f) => f.assetIds))];
    const ok = new Set((await ws(c).collection("mediaAssets").getMany(ids)).filter((a) => a.appId === app.id && a.isProductTruth).map((a) => a.id));
    input.features = input.features.map((f) => ({ ...f, assetIds: f.assetIds.filter((a) => ok.has(a)) }));
  }
  let profile: BrandProfile;
  if (existing) {
    const patch: Record<string, unknown> = { ...input };
    for (const k of NESTED) if (input[k as keyof typeof input]) patch[k] = { ...(existing as unknown as Record<string, object>)[k], ...(input[k as keyof typeof input] as object) };
    profile = await repo.update(app.id, { ...(patch as Partial<BrandProfile>), userEditedPaths: [...paths].slice(0, 200), version: existing.version + 1 }, { actor });
  } else {
    if (!input.oneLiner || !input.description) throw new AppError("BAD_REQUEST", "oneLiner and description are required to create App DNA manually");
    profile = await repo.create(
      {
        id: app.id,
        appId: app.id,
        version: 1,
        status: "draft",
        ...(input as Partial<BrandProfile>),
        oneLiner: input.oneLiner,
        description: input.description,
        monetization: { model: "unknown", evidenceIds: [], ...input.monetization },
        tone: { voice: [], vocabularyUse: [], vocabularyAvoid: [], ...input.tone },
        visual: { palette: [], styleKeywords: [], logoAssetIds: [], sampleAssetIds: [], ...input.visual },
        userEditedPaths: [...paths],
      },
      { actor },
    );
    await ws(c).collection("apps").update(app.id, { brandProfileId: app.id, dnaStatus: "needs_review" }, { actor });
  }
  // Founder-stated constraints and voice become memory (Glimmer retrieves them later).
  for (const pc of (input.prohibitedClaims ?? []).filter((x) => !existing?.prohibitedClaims.includes(x))) {
    await rememberPreference(p, { workspaceId: c.get("workspaceId"), appId: app.id, kind: "constraint", text: `Do not claim: "${pc}"`, source: { type: "user_edit", ref: { entity: "brandProfiles", id: app.id } }, actor, weight: 0.8 });
  }
  if (input.tone?.voice?.length) await rememberPreference(p, { workspaceId: c.get("workspaceId"), appId: app.id, kind: "tone", text: `Brand voice: ${input.tone.voice.join(", ")}`, source: { type: "user_edit", ref: { entity: "brandProfiles", id: app.id } }, actor });
  return c.json({ profile });
});

/** POST /apps/:appId/dna/confirm: founder confirms the DNA (app becomes ready). */
appDnaRoutes.post("/apps/:appId/dna/confirm", requireCap("apps.write"), async (c) => {
  const p = c.get("platform");
  const app = await appOf(c);
  const actor = actorOf(c);
  const existing = await ws(c).collection("brandProfiles").get(app.id);
  if (!existing) throw new AppError("CONFLICT", "There is no App DNA to confirm yet");
  const profile = await ws(c).collection("brandProfiles").update(app.id, { status: "confirmed", confirmedBy: actor, confirmedAt: new Date().toISOString() }, { actor });
  const updatedApp = await ws(c).collection("apps").update(app.id, { dnaStatus: "confirmed", status: "ready" }, { actor });
  await p.jobs.create(c.get("workspaceId"), "memory.ingest", { appId: app.id, ref: { entity: "brandProfiles", id: app.id } }, { actor, appId: app.id, idempotencyKey: `memory.ingest:dna:${app.id}:v${profile.version}` });
  return c.json({ profile, app: updatedApp });
});

// ---------------------------------------------------------------------------
// Claims (verified claim library)
// ---------------------------------------------------------------------------

const CreateClaim = z.object({ text: z.string().min(1).max(500), evidenceIds: z.array(Id).max(20).default([]), permittedContexts: z.array(ClaimContext).max(6).default(["all"]) });
const UpdateClaim = z.object({ text: z.string().min(1).max(500).optional(), state: ReviewState.optional(), permittedContexts: z.array(ClaimContext).max(6).optional(), note: z.string().max(500).optional() });

appDnaRoutes.get("/apps/:appId/claims", async (c) => {
  const app = await appOf(c);
  const page = await ws(c).collection("claims").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  return c.json({ items: page.items, nextCursor: page.nextCursor });
});

/** Founder-added claim: verified when the author may approve content, otherwise queued for review. */
appDnaRoutes.post("/apps/:appId/claims", requireCap("apps.write"), async (c) => {
  const app = await appOf(c);
  const input = await body(c, CreateClaim);
  const evidence = await ws(c).collection("appEvidence").getMany(input.evidenceIds);
  if (evidence.some((e) => e.appId !== app.id) || evidence.length !== input.evidenceIds.length) throw new AppError("BAD_REQUEST", "evidenceIds must belong to this app");
  const actor = actorOf(c);
  const approver = can(c.get("member"), "content.approve");
  const state = approver ? "verified" : "needs_review";
  const claim = await ws(c).collection("claims").create(
    {
      appId: app.id,
      text: input.text,
      evidenceIds: input.evidenceIds,
      confidence: 1,
      state,
      permittedContexts: input.permittedContexts,
      origin: "user",
      speculative: false,
      reviewedBy: approver ? actor : undefined,
      reviewedAt: approver ? new Date().toISOString() : undefined,
      history: [{ at: new Date().toISOString(), by: actor, to: state, note: "Added by the team" }],
    },
    { actor },
  );
  return c.json({ claim }, 201);
});

appDnaRoutes.patch("/apps/:appId/claims/:claimId", requireCap("apps.write"), async (c) => {
  const p = c.get("platform");
  const app = await appOf(c);
  const input = await body(c, UpdateClaim);
  const repo = ws(c).collection("claims");
  const claim = await repo.getOrThrow(c.req.param("claimId"));
  if (claim.appId !== app.id) throw new AppError("NOT_FOUND", "Claim not found");
  if (input.state && input.state !== claim.state && !can(c.get("member"), "content.approve")) throw new AppError("FORBIDDEN", "Only members who can approve content can verify or reject claims");
  const actor = actorOf(c);
  const now = new Date().toISOString();
  // Editing the wording invalidates a previous verification unless re-verified in the same request.
  const nextState = input.state ?? (input.text && input.text !== claim.text ? "needs_review" : claim.state);
  const updated = await repo.update(
    claim.id,
    {
      text: input.text ?? claim.text,
      permittedContexts: input.permittedContexts ?? claim.permittedContexts,
      state: nextState,
      speculative: nextState === "verified" ? false : claim.speculative,
      reviewedBy: nextState !== claim.state ? actor : claim.reviewedBy,
      reviewedAt: nextState !== claim.state ? now : claim.reviewedAt,
      history: nextState !== claim.state || input.text ? [...claim.history, { at: now, by: actor, from: claim.state, to: nextState, note: input.note ?? (input.text ? "Wording edited" : undefined) }].slice(-50) : claim.history,
    },
    { actor },
  );
  if (nextState === "rejected" && claim.state !== "rejected") {
    await p.jobs.create(c.get("workspaceId"), "memory.ingest", { appId: app.id, ref: { entity: "claims", id: claim.id } }, { actor, appId: app.id, idempotencyKey: `memory.ingest:claim:${claim.id}:rejected` });
  }
  return c.json({ claim: updated });
});

// ---------------------------------------------------------------------------
// Competitors
// ---------------------------------------------------------------------------

const CreateCompetitor = z.object({
  name: z.string().min(1).max(120),
  websiteUrl: HttpUrl.optional(),
  storeUrls: z.object({ ios: HttpUrl.optional(), android: HttpUrl.optional() }).default({}),
  handles: z.array(SocialHandle).max(10).default([]),
  positioning: z.string().max(1000).optional(),
});

appDnaRoutes.get("/apps/:appId/competitors", async (c) => {
  const app = await appOf(c);
  const page = await ws(c).collection("competitors").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 });
  return c.json({ items: page.items, nextCursor: page.nextCursor });
});

appDnaRoutes.post("/apps/:appId/competitors", requireCap("apps.write"), async (c) => {
  const app = await appOf(c);
  const input = await body(c, CreateCompetitor);
  for (const u of [input.websiteUrl, input.storeUrls.ios, input.storeUrls.android, ...input.handles.map((h) => h.url)]) if (u) assertSafeUrl(u);
  const actor = actorOf(c);
  const competitor = await ws(c).collection("competitors").create({ appId: app.id, ...input, origin: "user", observedHooks: [], observedFormats: [], comparison: [], sources: [] }, { actor });
  const profile = await ws(c).collection("brandProfiles").get(app.id);
  if (profile && !profile.competitorIds.includes(competitor.id)) await ws(c).collection("brandProfiles").update(app.id, { competitorIds: [...profile.competitorIds, competitor.id] }, { actor });
  return c.json({ competitor }, 201);
});

appDnaRoutes.get("/apps/:appId/competitors/:id", async (c) => {
  const app = await appOf(c);
  const competitor = await ws(c).collection("competitors").getOrThrow(c.req.param("id"));
  if (competitor.appId !== app.id) throw new AppError("NOT_FOUND", "Competitor not found");
  return c.json({ competitor });
});

appDnaRoutes.delete("/apps/:appId/competitors/:id", requireCap("apps.write"), async (c) => {
  const app = await appOf(c);
  const repo = ws(c).collection("competitors");
  const competitor = await repo.getOrThrow(c.req.param("id"));
  if (competitor.appId !== app.id) throw new AppError("NOT_FOUND", "Competitor not found");
  await repo.delete(competitor.id);
  const profile = await ws(c).collection("brandProfiles").get(app.id);
  if (profile?.competitorIds.includes(competitor.id)) await ws(c).collection("brandProfiles").update(app.id, { competitorIds: profile.competitorIds.filter((x) => x !== competitor.id) }, { actor: actorOf(c) });
  return c.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Memory (brand preferences; Muse Glimmer retrieves over them)
// ---------------------------------------------------------------------------

const CreatePref = z.object({ kind: PreferenceKind, text: z.string().min(1).max(1000), scope: z.enum(["app", "workspace"]).default("app") });
const UpdatePref = z.object({ kind: PreferenceKind.optional(), text: z.string().min(1).max(1000).optional(), weight: z.number().min(0).max(1).optional(), active: z.boolean().optional() }).strict();

function glimmerStatus(c: Ctx) {
  const g = glimmerClient(c.get("platform"));
  return { connected: g.configured, model: g.model, label: g.label };
}

async function prefOf(c: Ctx, appId: string) {
  const pref = await ws(c).collection("brandPreferences").getOrThrow(c.req.param("id")!);
  if (pref.appId && pref.appId !== appId) throw new AppError("NOT_FOUND", "Preference not found");
  return pref;
}

appDnaRoutes.get("/apps/:appId/memory", async (c) => {
  const app = await appOf(c);
  const [active, scoped] = await Promise.all([
    ws(c).collection("brandPreferences").list({ where: [["active", "==", true]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 }),
    ws(c).collection("brandPreferences").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 }),
  ]);
  const byId = new Map([...active.items.filter((x) => !x.appId || x.appId === app.id), ...scoped.items].map((x) => [x.id, x]));
  const items = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return c.json({ items, nextCursor: null, glimmer: glimmerStatus(c) });
});

/** Preview what memory a task would use (Glimmer when connected, honest fallback otherwise). */
appDnaRoutes.get("/apps/:appId/memory/retrieve", async (c) => {
  const app = await appOf(c);
  const q = query(c, z.object({ task: z.string().min(1).max(60).default("campaign_concepts"), query: z.string().max(1000).default(""), limit: z.coerce.number().int().min(1).max(20).default(8) }));
  const res = await retrieveMemory(c.get("platform"), { workspaceId: c.get("workspaceId"), appId: app.id, task: q.task, query: q.query, limit: q.limit });
  return c.json({ ...res, glimmer: glimmerStatus(c) });
});

appDnaRoutes.post("/apps/:appId/memory", requireCap("content.write"), async (c) => {
  const app = await appOf(c);
  const input = await body(c, CreatePref);
  const preference = await rememberPreference(c.get("platform"), { workspaceId: c.get("workspaceId"), appId: input.scope === "app" ? app.id : undefined, kind: input.kind, text: input.text, source: { type: "explicit" }, actor: actorOf(c) });
  return c.json({ preference }, 201);
});

appDnaRoutes.get("/apps/:appId/memory/:id", async (c) => {
  const app = await appOf(c);
  return c.json({ preference: await prefOf(c, app.id) });
});

appDnaRoutes.patch("/apps/:appId/memory/:id", requireCap("content.write"), async (c) => {
  const app = await appOf(c);
  const pref = await prefOf(c, app.id);
  const input = await body(c, UpdatePref);
  const preference = await ws(c).collection("brandPreferences").update(pref.id, input, { actor: actorOf(c) });
  return c.json({ preference });
});

appDnaRoutes.delete("/apps/:appId/memory/:id", requireCap("content.write"), async (c) => {
  const app = await appOf(c);
  const pref = await prefOf(c, app.id);
  await ws(c).collection("brandPreferences").delete(pref.id);
  return c.json({ deleted: true });
});
