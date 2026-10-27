import { AiEditRequest, ApplyPatchRequest, AspectRatio, RenderRequest, type Composition, type CompositionPatch, type MediaAsset, type Segmentation } from "@muselaunch/contracts";
import { applyPatch, collectAssetRefs, compileToHtml, docHash, lintDoc, PatchError, totalDuration } from "@muselaunch/compositions";
import { ensureNodeCompileRuntime } from "@muselaunch/compositions/node";
import { commitVersion, getVersion, redo, undo } from "@muselaunch/compositions/store";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, assertKeyInWorkspace, type Platform } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, idempotencyKey, query, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * Owner: module C (Video Studio): compositions, versions, patches, undo/redo, preview/render, exports.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 */
export const compositionRoutes = new Hono<AppEnv>();

const ws = (c: Ctx): WorkspaceDb => c.get("platform").db.ws(c.get("workspaceId"));
const SIGNED_URL_TTL = 30 * 60;

async function loadComposition(c: Ctx): Promise<Composition> {
  return ws(c).collection("compositions").getOrThrow(c.req.param("id")!);
}

/** Map PatchError to a 422 the editor can show line by line. */
function patchFailure(err: unknown): never {
  if (err instanceof PatchError) throw new AppError("VALIDATION_FAILED", err.message, { userMessage: "That edit isn't valid for this composition.", details: { errors: err.errors } });
  throw err;
}

async function docMedia(db: WorkspaceDb, doc: Parameters<typeof collectAssetRefs>[0]) {
  const refs = collectAssetRefs(doc);
  const segs = (await db.collection("segmentations").getMany(refs.segmentationIds)) as Segmentation[];
  const cutouts = segs.map((s) => s.cutoutAssetId).filter((x): x is string => !!x);
  const assets = (await db.collection("mediaAssets").getMany([...new Set([...refs.assetIds, ...cutouts])])) as MediaAsset[];
  return { refs, segs, assets };
}

async function lintFor(db: WorkspaceDb, doc: Parameters<typeof collectAssetRefs>[0]) {
  const { assets, segs } = await docMedia(db, doc);
  const claimIds = [...new Set(doc.scenes.flatMap((s) => s.layers.flatMap((l) => (l.type === "text" ? l.claimIds : []))))];
  const claims = claimIds.length ? await db.collection("claims").getMany(claimIds) : [];
  return lintDoc(doc, {
    assets: Object.fromEntries(assets.map((a) => [a.id, a])),
    claims: Object.fromEntries(claims.map((x) => [x.id, x])),
    segmentations: Object.fromEntries(segs.map((s) => [s.id, s])),
  });
}

async function signed(p: Platform, wid: string, asset: MediaAsset | null | undefined) {
  if (!asset || asset.status !== "ready") return null;
  assertKeyInWorkspace(wid, asset.storagePath);
  const { url, expiresAt } = await p.storage.signedDownloadUrl(asset.storagePath, { expiresSec: SIGNED_URL_TTL });
  return { asset, url, expiresAt };
}

async function lastRenderInfo(c: Ctx, comp: Composition) {
  if (!comp.lastRender?.assetId) return null;
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const asset = await ws(c).collection("mediaAssets").get(comp.lastRender.assetId);
  const main = await signed(p, wid, asset);
  if (!main) return null;
  const poster = asset?.posterAssetId ? await signed(p, wid, await ws(c).collection("mediaAssets").get(asset.posterAssetId)) : null;
  return { ...comp.lastRender, asset: main.asset, url: main.url, posterUrl: poster?.url ?? null, expiresAt: main.expiresAt };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const ListCompositions = z.object({ appId: z.string().optional(), campaignId: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() });

compositionRoutes.get("/compositions", async (c) => {
  const q = query(c, ListCompositions);
  if (!q.appId && !q.campaignId) throw new AppError("BAD_REQUEST", "appId or campaignId is required");
  const where = q.campaignId ? ([["campaignId", "==", q.campaignId]] as const) : ([["appId", "==", q.appId!]] as const);
  const page = await ws(c).collection("compositions").list({ where, orderBy: { field: "createdAt", dir: "desc" }, limit: q.limit, cursor: q.cursor });
  return c.json(page);
});

compositionRoutes.get("/compositions/:id", async (c) => {
  const comp = await loadComposition(c);
  const version = await getVersion(ws(c), comp.id, comp.currentVersion);
  const lint = await lintFor(ws(c), version.doc);
  return c.json({ composition: comp, version, lint, lastRender: await lastRenderInfo(c, comp), durationSec: totalDuration(version.doc) });
});

const ListVersions = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() });

compositionRoutes.get("/compositions/:id/versions", async (c) => {
  const comp = await loadComposition(c);
  const q = query(c, ListVersions);
  const page = await ws(c)
    .collection("compositionVersions")
    .list({ where: [["compositionId", "==", comp.id]], orderBy: { field: "version", dir: "desc" }, limit: q.limit, cursor: q.cursor });
  // Summaries only; fetch one version for its doc.
  const items = page.items.map(({ doc: _doc, ...rest }) => ({ ...rest, current: rest.version === comp.currentVersion }));
  return c.json({ items, nextCursor: page.nextCursor, currentVersion: comp.currentVersion, redoStack: comp.redoStack });
});

compositionRoutes.get("/compositions/:id/versions/:v", async (c) => {
  const comp = await loadComposition(c);
  const v = z.coerce.number().int().min(1).parse(c.req.param("v"));
  return c.json({ version: await getVersion(ws(c), comp.id, v) });
});

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

compositionRoutes.post("/compositions/:id/patch", requireCap("content.write"), async (c) => {
  const db = ws(c);
  const actor = actorOf(c);
  const comp = await loadComposition(c);
  const input = await body(c, ApplyPatchRequest);
  if (input.baseVersion !== comp.currentVersion) throw new AppError("CONFLICT", `Composition is at version ${comp.currentVersion}`, { details: { currentVersion: comp.currentVersion } });
  const base = await getVersion(db, comp.id, comp.currentVersion);
  let result: ReturnType<typeof applyPatch>;
  try {
    result = applyPatch(base.doc, input.ops);
  } catch (err) {
    patchFailure(err);
  }
  const patches = db.collection("compositionPatches");
  const patchId = patches.newId();
  const committed = await commitVersion(db, comp.id, { baseVersion: input.baseVersion, doc: result.doc, source: "user_edit", summary: input.summary, patchId }, actor);
  const patch = await patches.create(
    { id: patchId, compositionId: comp.id, baseVersion: input.baseVersion, resultVersion: committed.version.version, ops: input.ops, summary: input.summary, source: "user", affectedSceneIds: result.affectedSceneIds, status: "applied", validationErrors: [], memoryRefs: [] },
    { actor },
  );
  return c.json({ composition: committed.composition, version: committed.version, patch, affectedSceneIds: result.affectedSceneIds, inverse: result.inverse });
});

compositionRoutes.post("/compositions/:id/ai-edit", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const db = ws(c);
  const actor = actorOf(c);
  const comp = await loadComposition(c);
  const input = await body(c, AiEditRequest);
  if (input.baseVersion !== comp.currentVersion) throw new AppError("CONFLICT", `Composition is at version ${comp.currentVersion}`, { details: { currentVersion: comp.currentVersion } });
  const base = await getVersion(db, comp.id, comp.currentVersion);
  const known = new Set(base.doc.scenes.map((s) => s.id));
  const unknown = input.sceneIds.filter((id) => !known.has(id));
  if (unknown.length) throw new AppError("BAD_REQUEST", `Unknown scene(s): ${unknown.join(", ")}`);
  const patch = await db.collection("compositionPatches").create(
    {
      compositionId: comp.id,
      baseVersion: input.baseVersion,
      ops: [],
      summary: "Generating edit…",
      source: "ai",
      instruction: input.instruction,
      affectedSceneIds: input.sceneIds,
      status: "proposed",
      validationErrors: [],
      memoryRefs: [],
    },
    { actor },
  );
  const job = await p.jobs.create(
    wid,
    "composition.edit",
    { appId: comp.appId, compositionId: comp.id, baseVersion: input.baseVersion, instruction: input.instruction, sceneIds: input.sceneIds, patchId: patch.id, autoApply: input.autoApply },
    { actor, appId: comp.appId, idempotencyKey: idempotencyKey(c, `ai-edit:${patch.id}`), credits: { operation: "composition.edit" } },
  );
  return c.json({ job, patch }, 202);
});

const ListPatches = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().optional() });

compositionRoutes.get("/compositions/:id/patches", async (c) => {
  const comp = await loadComposition(c);
  const q = query(c, ListPatches);
  const page = await ws(c).collection("compositionPatches").list({ where: [["compositionId", "==", comp.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: q.limit, cursor: q.cursor });
  return c.json(page);
});

async function loadPatch(c: Ctx, comp: Composition): Promise<CompositionPatch> {
  const patch = await ws(c).collection("compositionPatches").getOrThrow(c.req.param("patchId")!);
  if (patch.compositionId !== comp.id) throw new AppError("NOT_FOUND", "Patch not found");
  return patch;
}

compositionRoutes.get("/compositions/:id/patches/:patchId", async (c) => {
  const comp = await loadComposition(c);
  const patch = await loadPatch(c, comp);
  // Preview what applying would touch, against the current version.
  let preview: { applicable: boolean; affectedSceneIds: string[]; errors: string[] } | null = null;
  if (patch.status === "proposed" && patch.ops.length) {
    const cur = await getVersion(ws(c), comp.id, comp.currentVersion);
    try {
      const r = applyPatch(cur.doc, patch.ops);
      preview = { applicable: true, affectedSceneIds: r.affectedSceneIds, errors: [] };
    } catch (err) {
      preview = { applicable: false, affectedSceneIds: [], errors: err instanceof PatchError ? err.errors : [String(err)] };
    }
  }
  return c.json({ patch, preview, currentVersion: comp.currentVersion });
});

compositionRoutes.post("/compositions/:id/patches/:patchId/apply", requireCap("content.write"), async (c) => {
  const db = ws(c);
  const actor = actorOf(c);
  const comp = await loadComposition(c);
  const patch = await loadPatch(c, comp);
  if (patch.status === "applied") {
    const version = await getVersion(db, comp.id, patch.resultVersion ?? comp.currentVersion);
    return c.json({ composition: comp, version, patch });
  }
  if (patch.status !== "proposed") throw new AppError("CONFLICT", `Patch is ${patch.status}`);
  if (!patch.ops.length) throw new AppError("CONFLICT", "This edit is still being generated", { userMessage: "The AI is still working on this edit." });
  // Ops address stable ids, so a patch proposed on an older version may still apply cleanly.
  const cur = await getVersion(db, comp.id, comp.currentVersion);
  let result: ReturnType<typeof applyPatch>;
  try {
    result = applyPatch(cur.doc, patch.ops);
  } catch (err) {
    if (err instanceof PatchError) await db.collection("compositionPatches").update(patch.id, { status: "invalid", validationErrors: err.errors.slice(0, 20).map((e) => e.slice(0, 500)) }, { actor });
    patchFailure(err);
  }
  const committed = await commitVersion(db, comp.id, { baseVersion: cur.version, doc: result.doc, source: patch.source === "ai" ? "ai_edit" : "user_edit", summary: patch.summary.slice(0, 500), patchId: patch.id }, actor);
  const updated = await db.collection("compositionPatches").update(patch.id, { status: "applied", resultVersion: committed.version.version, affectedSceneIds: result.affectedSceneIds }, { actor });
  return c.json({ composition: committed.composition, version: committed.version, patch: updated, affectedSceneIds: result.affectedSceneIds });
});

compositionRoutes.post("/compositions/:id/patches/:patchId/reject", requireCap("content.write"), async (c) => {
  const comp = await loadComposition(c);
  const patch = await loadPatch(c, comp);
  if (patch.status === "applied") throw new AppError("CONFLICT", "Patch was already applied; use undo instead");
  const updated = patch.status === "rejected" ? patch : await ws(c).collection("compositionPatches").update(patch.id, { status: "rejected" }, { actor: actorOf(c) });
  return c.json({ patch: updated });
});

compositionRoutes.post("/compositions/:id/undo", requireCap("content.write"), async (c) => {
  const comp = await undo(ws(c), c.req.param("id"), actorOf(c));
  return c.json({ composition: comp, version: await getVersion(ws(c), comp.id, comp.currentVersion) });
});

compositionRoutes.post("/compositions/:id/redo", requireCap("content.write"), async (c) => {
  const comp = await redo(ws(c), c.req.param("id"), actorOf(c));
  return c.json({ composition: comp, version: await getVersion(ws(c), comp.id, comp.currentVersion) });
});

compositionRoutes.post("/compositions/:id/approve", requireCap("content.approve"), async (c) => {
  const comp = await loadComposition(c);
  const { version } = await body(c, z.object({ version: z.number().int().min(1).optional() }));
  const v = version ?? comp.currentVersion;
  const ver = await getVersion(ws(c), comp.id, v);
  const errors = (await lintFor(ws(c), ver.doc)).filter((i) => i.level === "error");
  if (errors.length) throw new AppError("VALIDATION_FAILED", "Fix blocking issues before approving", { details: { issues: errors } });
  const updated = await ws(c).collection("compositions").update(comp.id, { approvedVersion: v, status: comp.currentVersion === v ? "approved" : comp.status }, { actor: actorOf(c) });
  return c.json({ composition: updated });
});

// ---------------------------------------------------------------------------
// Preview / render
// ---------------------------------------------------------------------------

compositionRoutes.post("/compositions/:id/render", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const actor = actorOf(c);
  const comp = await loadComposition(c);
  const input = await body(c, RenderRequest);
  const version = input.version ?? comp.currentVersion;
  const ver = await getVersion(ws(c), comp.id, version);
  const durationSec = totalDuration(ver.doc);
  const issues = await lintFor(ws(c), ver.doc);
  const missing = issues.filter((i) => i.level === "error" && /missing asset/.test(i.message));
  if (missing.length) throw new AppError("VALIDATION_FAILED", "Some media is missing", { details: { issues: missing } });
  const key = docHash(ver.doc).slice(0, 16);
  if (input.quality === "final") {
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length) throw new AppError("VALIDATION_FAILED", `${errors.length} blocking issue(s) must be fixed before the final render`, { userMessage: "Fix the flagged issues before the final render.", details: { issues: errors } });
    const format = ver.doc.kind === "video" ? "mp4" : "png";
    const job = await p.jobs.create(
      wid,
      "render.final",
      { appId: comp.appId, compositionId: comp.id, version, format },
      {
        actor,
        appId: comp.appId,
        idempotencyKey: idempotencyKey(c, `render.final:${comp.id}:v${version}:${key}`),
        credits: ver.doc.kind === "video" ? { operation: "render.final", params: { durationSec } } : { operation: "render.final", amount: Math.max(1, Math.ceil(ver.doc.scenes.length / 4)) },
      },
    );
    return c.json({ job, estimate: p.credits.estimate("render.final", { durationSec }) }, 202);
  }
  const job = await p.jobs.create(wid, "render.preview", { appId: comp.appId, compositionId: comp.id, version }, { actor, appId: comp.appId, idempotencyKey: idempotencyKey(c, `render.preview:${comp.id}:v${version}`) });
  return c.json({ job }, 202);
});

const PreviewQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

compositionRoutes.get("/compositions/:id/preview", async (c) => {
  ensureNodeCompileRuntime();
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const comp = await loadComposition(c);
  const q = query(c, PreviewQuery);
  const ver = await getVersion(ws(c), comp.id, q.version ?? comp.currentVersion);
  const { assets, segs } = await docMedia(ws(c), ver.doc);
  const urls: Record<string, string> = {};
  for (const a of assets) {
    if (a.status !== "ready" && a.status !== "uploaded") continue;
    assertKeyInWorkspace(wid, a.storagePath);
    urls[a.id] = (await p.storage.signedDownloadUrl(a.storagePath, { expiresSec: SIGNED_URL_TTL })).url;
  }
  const missing = collectAssetRefs(ver.doc).assetIds.filter((id) => !urls[id]);
  const { html, durationSec, scenes } = compileToHtml(ver.doc, {
    // Unknown/missing assets resolve to an empty data URL rather than a guessable path.
    assetUrl: (id) => urls[id] ?? "data:,",
    mode: "preview",
    gsapSource: "inline",
    segmentations: Object.fromEntries(segs.map((s) => [s.id, s])),
    assetKinds: Object.fromEntries(assets.map((a) => [a.id, a.kind])),
  });
  return c.json({ html, durationSec, version: ver.version, scenes, missingAssetIds: missing, width: ver.doc.width, height: ver.doc.height, expiresInSec: SIGNED_URL_TTL });
});

// ---------------------------------------------------------------------------
// Variants & export
// ---------------------------------------------------------------------------

const VariantsRequest = z.object({
  mode: z.enum(["aspect", "audience"]),
  targets: z.array(z.string().min(1).max(200)).min(1).max(5),
});

compositionRoutes.post("/compositions/:id/variants", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const comp = await loadComposition(c);
  const input = await body(c, VariantsRequest);
  if (input.mode === "aspect") for (const t of input.targets) AspectRatio.parse(t);
  const targets = [...new Set(input.targets.map((t) => t.trim()))];
  const job = await p.jobs.create(
    c.get("workspaceId"),
    "composition.variants",
    { appId: comp.appId, compositionId: comp.id, mode: input.mode, targets },
    {
      actor: actorOf(c),
      appId: comp.appId,
      idempotencyKey: idempotencyKey(c, `variants:${comp.id}:v${comp.currentVersion}:${input.mode}:${targets.join("|")}`),
      // Audience variants each run a Spark edit; aspect re-layouts are local.
      credits: input.mode === "audience" ? { operation: "composition.edit", amount: p.credits.estimate("composition.edit").credits * targets.length } : undefined,
    },
  );
  return c.json({ job }, 202);
});

const ExportRequest = z.object({ compositionIds: z.array(z.string().min(1).max(128)).max(30).default([]), includeCopy: z.boolean().default(true) });

compositionRoutes.post("/campaigns/:campaignId/export", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const campaign = await ws(c).collection("campaigns").getOrThrow(c.req.param("campaignId"));
  const input = await body(c, ExportRequest);
  if (input.compositionIds.length) {
    const found = await ws(c).collection("compositions").getMany(input.compositionIds);
    if (found.length !== input.compositionIds.length) throw new AppError("NOT_FOUND", "Composition not found");
  }
  const job = await p.jobs.create(
    c.get("workspaceId"),
    "package.export",
    { appId: campaign.appId, campaignId: campaign.id, compositionIds: input.compositionIds, includeCopy: input.includeCopy },
    { actor: actorOf(c), appId: campaign.appId, idempotencyKey: idempotencyKey(c, `export:${campaign.id}:${input.compositionIds.join(",")}:${input.includeCopy}:${Date.now() - (Date.now() % 60_000)}`) },
  );
  return c.json({ job }, 202);
});
