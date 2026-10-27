import { CreateAppRequest, HttpUrl } from "@muselaunch/contracts";
import { AppError, assertSafeUrl } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, idempotencyKey, requireCap, type AppEnv } from "../context";
import { audit } from "../services/workspaces";

/** Base app CRUD + import trigger. App DNA/evidence/claims/brand routes live in app-dna.ts (module B). */
export const appRoutes = new Hono<AppEnv>();

appRoutes.get("/", async (c) => {
  const p = c.get("platform");
  const page = await p.db.ws(c.get("workspaceId")).collection("apps").list({ limit: 100 });
  return c.json({ items: page.items.filter((a) => a.status !== "archived") });
});

appRoutes.post("/", requireCap("apps.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const input = await body(c, CreateAppRequest);
  for (const u of [input.appStoreUrl, input.playStoreUrl, input.websiteUrl]) if (u) assertSafeUrl(u);
  if (!input.name && !input.appStoreUrl && !input.playStoreUrl && !input.websiteUrl) {
    throw new AppError("BAD_REQUEST", "Provide a store URL, a website, or a name", { userMessage: "Add an App Store / Google Play link, a website, or at least a name." });
  }
  const plan = p.credits.plans[c.get("workspace").planId as keyof typeof p.credits.plans] ?? p.credits.plans.free;
  const existing = (await p.db.ws(wid).collection("apps").list({ limit: 200 })).items.filter((a) => a.status !== "archived");
  if (existing.length >= plan.limits.apps) throw new AppError("QUOTA_EXCEEDED", `Your plan allows ${plan.limits.apps} apps`);

  const hasSources = Boolean(input.appStoreUrl || input.playStoreUrl || input.websiteUrl);
  const actor = actorOf(c);
  const app = await p.db.ws(wid).collection("apps").create(
    {
      name: input.name ?? "New app",
      status: hasSources ? "importing" : "draft",
      dnaStatus: "none",
      storeUrls: { ios: input.appStoreUrl, android: input.playStoreUrl },
      websiteUrl: input.websiteUrl,
      targetCountries: input.targetCountries ?? [],
    },
    { actor },
  );
  const sources = [
    ...(input.appStoreUrl ? [{ kind: "app_store" as const, url: input.appStoreUrl }] : []),
    ...(input.playStoreUrl ? [{ kind: "google_play" as const, url: input.playStoreUrl }] : []),
    ...(input.websiteUrl ? [{ kind: "website" as const, url: input.websiteUrl }] : []),
    ...(input.description ? [{ kind: "manual" as const }] : []),
  ];
  let job = null;
  if (sources.length) {
    const imp = await p.db.ws(wid).collection("appImports").create({ appId: app.id, sources, status: "queued" }, { actor });
    if (input.description) {
      await p.db.ws(wid).collection("appEvidence").create(
        { appId: app.id, kind: "positioning", fact: input.description.slice(0, 1000), source: { kind: "user_input", retrievedAt: new Date().toISOString() }, observedAt: new Date().toISOString(), reviewState: "verified" },
        { actor },
      );
    }
    job = await p.jobs.create(wid, "app.import", { appId: app.id, importId: imp.id }, { actor, appId: app.id, idempotencyKey: idempotencyKey(c, `app.import:${imp.id}`), credits: { operation: "app.import" } });
    await p.db.ws(wid).collection("appImports").update(imp.id, { jobId: job.id }, { actor });
    await p.db.ws(wid).collection("apps").update(app.id, { lastImportId: imp.id }, { actor });
  }
  await audit(p, wid, actor, "app.created", { appId: app.id });
  return c.json({ app, job }, hasSources ? 202 : 201);
});

appRoutes.get("/:appId", async (c) => {
  const p = c.get("platform");
  const app = await p.db.ws(c.get("workspaceId")).collection("apps").getOrThrow(c.req.param("appId"));
  return c.json({ app });
});

const UpdateApp = z.object({
  name: z.string().min(1).max(120).optional(),
  tagline: z.string().max(240).optional(),
  category: z.string().max(120).optional(),
  websiteUrl: HttpUrl.optional(),
  storeUrls: z.object({ ios: HttpUrl.optional(), android: HttpUrl.optional() }).optional(),
  targetCountries: z.array(z.string().length(2)).max(20).optional(),
  targetLanguages: z.array(z.string().min(2).max(16)).max(10).optional(),
  stage: z.enum(["pre_launch", "launched", "growing", "mature"]).optional(),
  iconAssetId: z.string().optional(),
});

appRoutes.patch("/:appId", requireCap("apps.write"), async (c) => {
  const p = c.get("platform");
  const input = await body(c, UpdateApp);
  // Same URL policy as POST /apps: store URLs are fetched by re-imports and used as tracked-link destinations.
  for (const u of [input.websiteUrl, input.storeUrls?.ios, input.storeUrls?.android]) if (u) assertSafeUrl(u);
  const app = await p.db.ws(c.get("workspaceId")).collection("apps").update(c.req.param("appId"), input, { actor: actorOf(c) });
  return c.json({ app });
});

/** Re-import public listing data (does not overwrite user-edited App DNA fields). */
appRoutes.post("/:appId/import", requireCap("apps.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const app = await p.db.ws(wid).collection("apps").getOrThrow(c.req.param("appId"));
  const sources = [
    ...(app.storeUrls.ios ? [{ kind: "app_store" as const, url: app.storeUrls.ios }] : []),
    ...(app.storeUrls.android ? [{ kind: "google_play" as const, url: app.storeUrls.android }] : []),
    ...(app.websiteUrl ? [{ kind: "website" as const, url: app.websiteUrl }] : []),
  ];
  if (!sources.length) throw new AppError("BAD_REQUEST", "This app has no store or website URL to import from");
  const actor = actorOf(c);
  const imp = await p.db.ws(wid).collection("appImports").create({ appId: app.id, sources, status: "queued" }, { actor });
  const job = await p.jobs.create(wid, "app.import", { appId: app.id, importId: imp.id }, { actor, appId: app.id, idempotencyKey: idempotencyKey(c, `app.import:${imp.id}`), credits: { operation: "app.import" } });
  await p.db.ws(wid).collection("appImports").update(imp.id, { jobId: job.id }, { actor });
  return c.json({ job, import: imp }, 202);
});

appRoutes.delete("/:appId", requireCap("apps.write"), async (c) => {
  const p = c.get("platform");
  const app = await p.db.ws(c.get("workspaceId")).collection("apps").update(c.req.param("appId"), { status: "archived" }, { actor: actorOf(c) });
  await audit(p, c.get("workspaceId"), actorOf(c), "app.archived", { appId: app.id });
  return c.json({ app });
});
