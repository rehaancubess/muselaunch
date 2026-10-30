import { ClaimContext, Monetization, type AppEvidence, type BrandProfile, type MediaAsset } from "@muselaunch/contracts";
import { AppError, assertKeyInWorkspace, toAppError, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { generateJson, imagePart, roleNames, untrusted, type InputPart } from "@muselaunch/providers";
import sharp from "sharp";
import { z } from "zod";
import { initialClaimState } from "../claims";
import { RunRecorder } from "../runs";
import { clip, hashId, normalizeText, nowIso, uniq } from "../util";
import { paletteFromImages } from "./palette";
import { queueScreenCutouts } from "./screens";

const Ids = z.array(z.string().max(128)).max(20).default([]);

/** What Spark returns. Ids are validated against real evidence/assets afterwards. */
export const DnaDraft = z.object({
  oneLiner: z.string().min(1).max(240),
  description: z.string().min(1).max(4000),
  category: z.string().max(120).optional(),
  screenshotObservations: z
    .array(
      z.object({
        key: z.string().max(24).describe("Your short reference, e.g. obs1; may be used in evidenceIds below"),
        assetId: z.string().max(128).describe("The asset id of the image you observed"),
        kind: z.enum(["feature", "visual", "audience", "problem", "positioning", "other"]),
        fact: z.string().min(1).max(600).describe("What is literally visible on this screenshot"),
      }),
    )
    .max(24)
    .default([]),
  features: z
    .array(z.object({ name: z.string().min(1).max(120), description: z.string().max(1000), evidenceIds: Ids, assetIds: Ids }))
    .max(12)
    .default([]),
  audiences: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(1000),
        painPoints: z.array(z.string().max(300)).max(8).default([]),
        motivations: z.array(z.string().max(300)).max(8).default([]),
        evidenceIds: Ids,
      }),
    )
    .max(5)
    .default([]),
  problems: z.array(z.object({ text: z.string().min(1).max(600), evidenceIds: Ids })).max(8).default([]),
  differentiators: z.array(z.object({ text: z.string().min(1).max(600), evidenceIds: Ids })).max(8).default([]),
  monetization: z.object({ model: Monetization.shape.model, notes: z.string().max(500).optional(), evidenceIds: Ids }),
  tone: z.object({
    voice: z.array(z.string().max(60)).max(12).default([]),
    vocabularyUse: z.array(z.string().max(80)).max(30).default([]),
    vocabularyAvoid: z.array(z.string().max(80)).max(30).default([]),
  }),
  styleKeywords: z.array(z.string().max(60)).max(20).default([]),
  preferredCtas: z.array(z.string().max(120)).max(10).default([]),
  claims: z
    .array(
      z.object({
        text: z.string().min(1).max(500),
        evidenceIds: Ids,
        support: z.enum(["direct", "inferred"]).describe("direct = the listing/user text literally states it; inferred = your interpretation"),
        confidence: z.number().min(0).max(1),
        contexts: z.array(ClaimContext).max(6).default(["all"]),
      }),
    )
    .max(15)
    .default([]),
});
export type DnaDraft = z.infer<typeof DnaDraft>;

const INSTRUCTIONS = `You are Muse Spark acting as MuseLaunch's product analyst. Build the "App DNA" of an app from its real public listing text, the founder's own description and real screenshots.

Rules (non-negotiable):
- Use only what the evidence and screenshots show. Never invent features, numbers, awards, user counts, reviews or testimonials.
- Every feature must cite evidence ids (from the evidence list, or keys of your screenshotObservations) and/or the asset ids of screenshots that show it. Omit features you cannot ground.
- screenshotObservations describe what is literally visible on a screenshot (UI elements, screens, text shown); use the exact asset id given for that image.
- Audiences, problems and differentiators are positioning hypotheses; cite evidence where possible.
- Claims are short marketing statements. support="direct" only when the listing or founder text literally states it; otherwise "inferred". Confidence reflects how well the evidence supports the claim.
- Monetization: use only pricing evidence (price, in-app purchases, subscription wording). Use "unknown" if there is none.
- Tone: describe the voice the listing already uses; styleKeywords describe the visual style of the screenshots and icon.
- Write in English, concise and specific to this app.`;

function storageKind(p: Platform) {
  return p.storage.driver;
}

/** Real product images for multimodal input: GCS signed URLs, or resized data URLs for local storage. */
async function imageInputs(p: Platform, workspaceId: string, assets: MediaAsset[]): Promise<{ parts: InputPart[]; buffers: Map<string, Buffer> }> {
  const parts: InputPart[] = [];
  const buffers = new Map<string, Buffer>();
  for (const a of assets) {
    assertKeyInWorkspace(workspaceId, a.storagePath);
    let buf: Buffer;
    try {
      buf = await p.storage.get(a.storagePath);
    } catch {
      continue;
    }
    buffers.set(a.id, buf);
    if (storageKind(p) === "gcs") {
      const { url } = await p.storage.signedDownloadUrl(a.storagePath, { expiresSec: 900 });
      parts.push(imagePart({ url }));
    } else {
      const small = await sharp(buf).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer().catch(() => null);
      if (!small) continue;
      parts.push(imagePart({ bytes: small, mimeType: "image/jpeg" }));
    }
  }
  return { parts, buffers };
}

/** Keep user-edited fields (`userEditedPaths`, top-level or one level deep) from the existing profile. */
export function mergeRespectingEdits(existing: BrandProfile | null, generated: Partial<BrandProfile>): Partial<BrandProfile> {
  if (!existing) return generated;
  const edited = new Set(existing.userEditedPaths);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(generated)) {
    if (edited.has(key)) {
      out[key] = (existing as Record<string, unknown>)[key];
      continue;
    }
    const prev = (existing as Record<string, unknown>)[key];
    if (value && typeof value === "object" && !Array.isArray(value) && prev && typeof prev === "object" && !Array.isArray(prev)) {
      const merged: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const sub of Object.keys({ ...(prev as object), ...(value as object) })) {
        if (edited.has(`${key}.${sub}`)) merged[sub] = (prev as Record<string, unknown>)[sub];
      }
      out[key] = merged;
    } else out[key] = value;
  }
  return out as Partial<BrandProfile>;
}

export async function appAnalyzeHandler(ctx: JobContext<"app.analyze">): Promise<JobResult> {
  const p = ctx.platform;
  const { appId, importId } = ctx.payload;
  const ws = ctx.ws;
  const app = await ws.collection("apps").getOrThrow(appId);
  const imp = importId ? await ws.collection("appImports").get(importId) : null;
  const run = await RunRecorder.start(ctx, { id: hashId("run", ctx.job.id), kind: "app_analysis", model: p.cfg.META_MODEL_SPARK, goal: `Build App DNA for ${app.name}`, appId });
  await ws.collection("apps").update(appId, { dnaStatus: "drafting" }, { actor: ctx.actor });
  try {
    await ctx.progress(10, "gathering evidence");
    const evidence = (await ws.collection("appEvidence").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 150 })).items;
    const assetPage = (await ws.collection("mediaAssets").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items;
    const truth = assetPage.filter((a) => a.isProductTruth && a.kind === "image" && (a.status === "ready" || a.status === "uploaded") && !a.generation);
    // Order: explicitly requested assets, then the import's listing order, then newest uploads.
    const requested = new Set(ctx.payload.assetIds);
    const orderImp = imp ?? (app.lastImportId ? await ws.collection("appImports").get(app.lastImportId) : null);
    const importOrder = new Map((orderImp?.importedAssetIds ?? []).map((id, i) => [id, i]));
    const ordered = [...truth].sort((a, b) => (importOrder.get(a.id) ?? 1e6) - (importOrder.get(b.id) ?? 1e6));
    const shots = [...ordered.filter((a) => requested.has(a.id)), ...ordered.filter((a) => !requested.has(a.id) && a.role === "screenshot")].filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i).slice(0, 8);
    const icon = truth.find((a) => a.id === app.iconAssetId) ?? truth.find((a) => a.role === "icon" || a.role === "logo");
    if (!evidence.length && !shots.length) {
      throw new AppError("BAD_REQUEST", "No evidence to analyze", { userMessage: "Add a store link, a description or screenshots so we can build your App DNA." });
    }
    const { parts: imageParts, buffers } = await imageInputs(p, ctx.workspaceId, [...shots, ...(icon ? [icon] : [])]);
    const imaged = [...shots, ...(icon ? [icon] : [])].filter((a) => buffers.has(a.id));
    ctx.throwIfCancelled();

    const listings = orderImp?.listings ?? [];
    const existing = await ws.collection("brandProfiles").get(appId);
    const text = [
      `App: ${app.name}${app.platforms.length ? ` (${app.platforms.join(", ")})` : ""}${app.category ? `, category ${app.category}` : ""}`,
      existing?.userEditedPaths.length ? `The founder has edited these fields; still return your best version, they will be kept: ${existing.userEditedPaths.join(", ")}` : "",
      "",
      ...listings.map((l) => untrusted(`${l.source} listing ${l.url}`, `Name: ${l.name ?? ""}\nDeveloper: ${l.developer ?? ""}\nCategory: ${l.category ?? ""}\nPrice: ${l.price ?? ""}\n\n${l.description ?? ""}`, 8000)),
      "",
      "Evidence (id | kind | source | fact):",
      untrusted("app_evidence", evidence.map((e) => `${e.id} | ${e.kind} | ${e.source.kind} | ${clip(e.fact, 400)}`).join("\n") || "(none)", 30_000),
      "",
      "Images attached, in order:",
      ...imaged.map((a, i) => `Image ${i + 1}: asset ${a.id} — ${a.role}${a.title ? ` (${a.title})` : ""}`),
    ]
      .filter((x) => x !== undefined)
      .join("\n");

    await ctx.progress(30, `${roleNames(p).spark} is reading your listing and screenshots`);
    const out = await generateJson(p, {
      ctx: run.callCtx("app_dna.extract"),
      model: "spark",
      instructions: INSTRUCTIONS,
      input: [{ type: "input_text", text }, ...imageParts],
      schema: DnaDraft,
      schemaName: "AppDna",
      maxOutputTokens: 12_000,
      reasoningEffort: "medium",
      cacheKey: "agents.app_dna",
    });
    await run.modelStep("Extract App DNA (Muse Spark, multimodal)", out, { evidence: evidence.length, images: imaged.length }, { features: out.data.features.length, claims: out.data.claims.length });
    ctx.throwIfCancelled();
    await ctx.progress(65, "linking evidence");

    const draft = out.data;
    const known = new Map<string, AppEvidence>(evidence.map((e) => [e.id, e]));
    const imagedIds = new Set(imaged.map((a) => a.id));
    const truthIds = new Set(truth.map((a) => a.id));
    const keyMap = new Map<string, string>();
    const dropped: string[] = [];

    // Screenshot observations → evidence (model observation of a real screenshot: needs review).
    for (const o of draft.screenshotObservations) {
      if (!imagedIds.has(o.assetId)) {
        dropped.push(`observation on unknown image ${o.assetId}`);
        continue;
      }
      const asset = imaged.find((a) => a.id === o.assetId)!;
      const id = hashId("evd", appId, "obs", o.assetId, normalizeText(o.fact));
      const { entity } = await ws.collection("appEvidence").createIfAbsent(
        {
          id,
          appId,
          kind: o.kind,
          fact: clip(o.fact, 1000),
          source: { kind: "screenshot", assetId: o.assetId, title: asset.title, url: asset.license?.sourceUrl, retrievedAt: nowIso() },
          assetId: o.assetId,
          observedAt: nowIso(),
          reviewState: "needs_review",
          extractedByRunId: run.id,
        },
        { actor: ctx.actor },
      );
      known.set(id, entity);
      keyMap.set(o.key, id);
    }
    const resolve = (ids: string[]) => uniq(ids.map((i) => keyMap.get(i) ?? i).filter((i) => known.has(i)));

    const features = draft.features
      .map((f) => {
        const evidenceIds = resolve(f.evidenceIds);
        const assetIds = uniq([...f.assetIds.filter((a) => truthIds.has(a)), ...evidenceIds.map((e) => known.get(e)?.assetId).filter((a): a is string => Boolean(a && truthIds.has(a)))]);
        return { id: hashId("feat", appId, normalizeText(f.name)), name: f.name, description: f.description, evidenceIds, assetIds };
      })
      .filter((f) => {
        if (f.evidenceIds.length || f.assetIds.length) return true;
        dropped.push(`feature "${f.name}" (no evidence)`);
        return false;
      });
    const evidenced = (xs: { text: string; evidenceIds: string[] }[], prefix: string) => xs.map((x) => ({ id: hashId(prefix, appId, normalizeText(x.text)), text: x.text, evidenceIds: resolve(x.evidenceIds) }));
    const audiences = draft.audiences.map((a) => ({ id: hashId("aud", appId, normalizeText(a.name)), name: a.name, description: a.description, painPoints: a.painPoints, motivations: a.motivations, evidenceIds: resolve(a.evidenceIds) }));

    // Palette from the real icon + screenshots (deterministic image statistics).
    const palette = await paletteFromImages(icon ? buffers.get(icon.id) : undefined, shots.map((s) => buffers.get(s.id)).filter((b): b is Buffer => Boolean(b)));

    const generated: Partial<BrandProfile> = {
      oneLiner: clip(draft.oneLiner, 240),
      description: clip(draft.description, 4000),
      category: draft.category ?? app.category,
      platforms: app.platforms,
      audiences,
      problems: evidenced(draft.problems, "prob"),
      features,
      differentiators: evidenced(draft.differentiators, "diff"),
      monetization: { model: draft.monetization.model, notes: draft.monetization.notes, evidenceIds: resolve(draft.monetization.evidenceIds) },
      tone: draft.tone,
      visual: {
        palette,
        styleKeywords: draft.styleKeywords,
        logoAssetIds: icon ? [icon.id] : [],
        sampleAssetIds: shots.map((s) => s.id),
        headingFont: existing?.visual.headingFont,
        bodyFont: existing?.visual.bodyFont,
      },
      preferredCtas: draft.preferredCtas,
    };
    const merged = mergeRespectingEdits(existing, generated);
    const profiles = ws.collection("brandProfiles");
    const profile = existing
      ? await profiles.update(appId, { ...merged, version: existing.version + 1, status: "draft", generatedByRunId: run.id }, { actor: ctx.actor })
      : await profiles.create(
          { id: appId, appId, version: 1, status: "draft", oneLiner: generated.oneLiner!, description: generated.description!, ...merged, prohibitedClaims: [], competitorIds: [], guidelines: "", userEditedPaths: [], generatedByRunId: run.id },
          { actor: ctx.actor },
        );

    // Claims: new ones only (never overwrite a claim a human reviewed).
    let created = 0;
    for (const c of draft.claims) {
      const evidenceIds = resolve(c.evidenceIds);
      const { state, speculative } = initialClaimState(c.text, c.support, evidenceIds.map((e) => known.get(e)!));
      const r = await ws.collection("claims").createIfAbsent(
        {
          id: hashId("clm", appId, normalizeText(c.text)),
          appId,
          text: clip(c.text, 500),
          evidenceIds,
          confidence: c.confidence,
          state,
          permittedContexts: c.contexts.length ? c.contexts : ["all"],
          origin: "extracted",
          speculative,
          history: [{ at: nowIso(), by: `agent:${run.id}`, to: state, note: state === "verified" ? "Directly stated in the public listing or founder text" : speculative ? "Speculative: goes beyond the evidence" : "Needs review" }],
        },
        { actor: ctx.actor },
      );
      if (r.created) created++;
    }

    // DNA audiences are also exposed as segments (origin "dna") for briefs and Discover.
    for (const a of audiences) {
      await ws.collection("audienceSegments").createIfAbsent(
        {
          id: hashId("asg", appId, "dna", normalizeText(a.name)),
          appId,
          name: a.name,
          description: a.description,
          painPoints: a.painPoints,
          motivations: a.motivations,
          evidence: a.evidenceIds.slice(0, 10).map((id) => {
            const e = known.get(id)!;
            return { ...e.source, evidenceId: id };
          }),
          origin: "dna",
        },
        { actor: ctx.actor },
      );
    }

    await run.step({ kind: "decision", title: "Grounded App DNA against evidence", output: { features: features.length, claimsCreated: created, dropped, palette: palette.length } });
    await ws.collection("apps").update(appId, { dnaStatus: "needs_review", brandProfileId: appId, tagline: app.tagline ?? clip(draft.oneLiner, 240), category: app.category ?? draft.category }, { actor: ctx.actor });
    if (imp) await ws.collection("appImports").update(imp.id, { status: imp.warnings.length ? "partial" : "succeeded" }, { actor: ctx.actor });
    await run.finish("succeeded", { outputRefs: [{ entity: "brandProfiles", id: profile.id }] });
    // Designed store screenshots → Muse Spark check + SAM 3.1 screen cut-outs, in the background.
    const screenCutoutJobId = await queueScreenCutouts(ctx, appId);
    await ctx.progress(100, "App DNA ready for review");
    return { refs: [{ entity: "brandProfiles", id: profile.id }, { entity: "agentRuns", id: run.id }], data: { version: profile.version, features: features.length, claimsCreated: created, dropped, screenCutoutJobId } };
  } catch (raw) {
    const err = toAppError(raw);
    const final = err.code === "CANCELLED" || !err.retryable || ctx.job.attempts >= ctx.job.maxAttempts;
    if (final) {
      await ws.collection("apps").update(appId, { dnaStatus: err.code === "CANCELLED" ? "none" : "failed" }, { actor: ctx.actor }).catch(() => {});
      if (imp) await ws.collection("appImports").update(imp.id, { status: "partial", warnings: [...imp.warnings, clip(`App DNA analysis failed: ${err.opts.userMessage ?? err.message}`, 500)].slice(0, 50) }, { actor: ctx.actor }).catch(() => {});
    }
    await run.finish(err.code === "CANCELLED" ? "cancelled" : "failed", { error: err.toInfo() }).catch(() => {});
    throw err;
  }
}
