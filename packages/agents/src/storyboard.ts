import { ScenePurpose, TEMPLATE_IDS, type MediaAsset, type Storyboard, type StoryboardScene, type TemplateId } from "@muselaunch/contracts";
import { TEMPLATE_CATALOG } from "@muselaunch/compositions";
import { AppError, toAppError, type JobContext, type JobResult } from "@muselaunch/platform";
import { generateJson, untrusted } from "@muselaunch/providers";
import { z } from "zod";
import { validateClaims } from "./claims";
import { dnaSummary, loadAppContext, productAssets, requireDna } from "./context";
import { retrieveMemory } from "./memory";
import { RunRecorder } from "./runs";
import { clip, hashId } from "./util";

const HintKind = z.enum(["screenshot", "app_recording", "founder_clip", "generated_image", "stock_video", "stock_image", "logo", "none"]);

export const StoryboardOutput = z.object({
  title: z.string().min(1).max(200),
  scenes: z
    .array(
      z.object({
        purpose: ScenePurpose,
        durationSec: z.number().min(0.5).max(30),
        onScreenText: z.string().max(300).default(""),
        narration: z.string().max(800).default(""),
        visual: z.string().min(1).max(1000).describe("What the viewer sees and how it moves"),
        template: z.enum(TEMPLATE_IDS),
        assets: z
          .array(
            z.object({
              kind: HintKind,
              assetId: z.string().max(128).optional().describe("Required for screenshot/app_recording/founder_clip/logo: an id from the asset list"),
              query: z.string().max(500).optional().describe("Required for generated_image/stock_*: a prompt/search that does NOT depict the app UI"),
              featureId: z.string().max(128).optional(),
            }),
          )
          .max(4)
          .default([]),
        claimIds: z.array(z.string()).max(5).default([]),
      }),
    )
    .min(2)
    .max(12),
  voiceover: z.object({ source: z.enum(["none", "founder_recording", "tts"]), script: z.string().max(4000).optional() }),
  music: z.object({ mood: z.string().max(120).optional() }).default({}),
});
type StoryboardOutput = z.infer<typeof StoryboardOutput>;
type Hint = StoryboardOutput["scenes"][number]["assets"][number];

const PRODUCT_KINDS = new Set(["screenshot", "app_recording"]);
const DEMO_TEMPLATES = new Set<TemplateId>(["device-demo", "feature-callout", "before-after"]);
const PROOF_TEMPLATES = new Set<TemplateId>(["quote-proof", "stat-card"]);
/** Object-aware templates need real presenter footage (SAM tracks it); never generated media. */
const OBJECT_TEMPLATES = new Set<TemplateId>(["presenter-depth", "object-spotlight", "product-in-hand"]);
const UI_WORDS = /\b(screenshot|app (?:ui|interface|screen)|user interface|\bui\b|dashboard of the app|the app's screen|phone screen showing)\b/i;

export interface StoryboardCheckContext {
  assets: Map<string, MediaAsset>;
  verifiedClaimIds: Set<string>;
  featureAssets: Map<string, string[]>;
}

/**
 * Structural validation + deterministic fixes. Real product media only for demo scenes; generated
 * or stock media only for supporting visuals (and never of the app UI); proof templates only with
 * verified claims. Returns the fixed storyboard scenes, problems needing a model repair, and notes.
 */
export function checkStoryboard(sb: StoryboardOutput, c: StoryboardCheckContext): { scenes: StoryboardOutput["scenes"]; problems: string[]; fixes: string[] } {
  const problems: string[] = [];
  const fixes: string[] = [];
  const productIds = [...c.assets.values()].filter((a) => PRODUCT_KINDS.has(a.role) && a.isProductTruth).map((a) => a.id);
  let rr = 0;
  const scenes = sb.scenes.map((s, i) => {
    const n = i + 1;
    const assets = s.assets.flatMap((h): Hint[] => {
      if (h.kind === "none") return [];
      if (h.kind === "generated_image" || h.kind === "stock_video" || h.kind === "stock_image") {
        if (!h.query?.trim()) {
          problems.push(`Scene ${n}: ${h.kind} needs a query.`);
          return [];
        }
        if (UI_WORDS.test(h.query)) {
          problems.push(`Scene ${n}: generated/stock media must not depict the app UI ("${clip(h.query, 80)}"); use a real screenshot instead.`);
          return [];
        }
        return [{ kind: h.kind, query: h.query, featureId: h.featureId }];
      }
      const a = h.assetId ? c.assets.get(h.assetId) : undefined;
      const roleOk = a && (h.kind === "logo" ? a.role === "logo" || a.role === "icon" : h.kind === "founder_clip" ? a.role === "founder_clip" : a.role === h.kind && a.isProductTruth);
      if (!roleOk) {
        fixes.push(`Scene ${n}: dropped ${h.kind} hint with unknown/mismatched asset ${h.assetId ?? "(none)"}`);
        return [];
      }
      return [{ kind: h.kind, assetId: a.id, featureId: h.featureId }];
    });
    const needsProduct = s.purpose === "demo" || s.purpose === "feature" || DEMO_TEMPLATES.has(s.template);
    if (needsProduct && !assets.some((h) => PRODUCT_KINDS.has(h.kind))) {
      const featureId = s.assets.find((h) => h.featureId)?.featureId;
      const candidate = (featureId && c.featureAssets.get(featureId)?.[0]) || productIds[rr++ % Math.max(1, productIds.length)];
      if (candidate && c.assets.get(candidate)) {
        const role = c.assets.get(candidate)!.role as "screenshot" | "app_recording";
        assets.unshift({ kind: role, assetId: candidate, featureId });
        fixes.push(`Scene ${n}: attached real ${role} ${candidate}`);
      } else {
        problems.push(`Scene ${n} (${s.template}) must show the real app, but no screenshot or recording is available; use a template that needs no product media.`);
      }
    }
    if ((s.template === "founder-cutout" || OBJECT_TEMPLATES.has(s.template)) && !assets.some((h) => h.kind === "founder_clip")) {
      problems.push(`Scene ${n}: ${s.template} needs a real founder_clip asset from the list (none chosen/available); use another template.`);
    }
    const claimIds = s.claimIds.filter((id) => c.verifiedClaimIds.has(id));
    if (claimIds.length !== s.claimIds.length) fixes.push(`Scene ${n}: removed unverified claim ids`);
    if (PROOF_TEMPLATES.has(s.template) && !claimIds.length) {
      problems.push(`Scene ${n}: ${s.template} may only show REAL proof backed by a verified claim id; none given.`);
    }
    return { ...s, assets, claimIds };
  });
  if (!scenes.some((s) => s.assets.some((h) => PRODUCT_KINDS.has(h.kind))) && productIds.length) {
    problems.push("At least one scene must show the real app (device-demo or feature-callout with a screenshot/recording).");
  }
  return { scenes, problems, fixes };
}

/** Scale durations to the target length (≥1 s per scene, 0.1 s precision). */
export function fitDurations(durations: number[], target: number): number[] {
  const sum = durations.reduce((a, b) => a + b, 0) || 1;
  const scaled = durations.map((d) => Math.max(1, Math.round(((d * target) / sum) * 10) / 10));
  const diff = Math.round((target - scaled.reduce((a, b) => a + b, 0)) * 10) / 10;
  const iMax = scaled.indexOf(Math.max(...scaled));
  scaled[iMax] = Math.max(1, Math.round((scaled[iMax]! + diff) * 10) / 10);
  return scaled;
}

function templateGuide(): string {
  return TEMPLATE_IDS.map((id) => {
    const t = TEMPLATE_CATALOG[id];
    return `- ${id}: ${t.description} Purposes: ${t.purposes.join(", ")}. Needs: ${t.needs.join(" / ")}.`;
  }).join("\n");
}

const INSTRUCTIONS = `You are Muse Spark acting as MuseLaunch's production director. Turn one campaign concept into a timed storyboard for a short marketing video built from editable scenes.

Rules:
- template must be one of the allowlisted template ids (described below). Pick the template that fits each scene's purpose.
- Demo/feature scenes must show the REAL app: use screenshot/app_recording hints with asset ids from the asset list (prefer the screenshot linked to the feature shown). Never ask for generated or stock images of the app UI.
- generated_image / stock_* hints are only for supporting visuals (moods, people, settings) and need a query.
- founder-cutout only if a founder_clip asset exists in the list.
- quote-proof / stat-card only with a verified claim id; never invent reviews, numbers, quotes or awards.
- onScreenText ≤ 8 words per scene where possible, legible on a phone; narration optional and natural.
- Product claims in onScreenText/narration must come from the verified claims (list their ids in claimIds).
- Respect the brand voice and team memory. Open with a strong hook in the first 2 seconds; end with a cta-endcard.`;

export async function storyboardHandler(ctx: JobContext<"storyboard.generate">): Promise<JobResult> {
  const p = ctx.platform;
  const { appId, campaignId, variantId, aspectRatio, targetDurationSec } = ctx.payload;
  const ws = ctx.ws;
  const [campaign, variant] = await Promise.all([ws.collection("campaigns").getOrThrow(campaignId), ws.collection("campaignVariants").getOrThrow(variantId)]);
  if (campaign.appId !== appId || variant.campaignId !== campaignId) throw new AppError("BAD_REQUEST", "Variant does not belong to this campaign/app");
  const storyboardId = hashId("sbd", ctx.job.id);
  const compositionId = hashId("cmp", storyboardId);
  const already = await ws.collection("storyboards").get(storyboardId);
  if (already) {
    const job = await ctx.enqueue("composition.build", { appId, storyboardId, compositionId }, { idempotencyKey: `composition.build:${storyboardId}`, credits: { operation: "composition.build" } });
    return { refs: [{ entity: "storyboards", id: storyboardId }], data: { compositionId, buildJobId: job.id, alreadyGenerated: true } };
  }

  const app = await loadAppContext(ws, appId);
  const dna = requireDna(app);
  const brief = campaign.briefId ? await ws.collection("campaignBriefs").get(campaign.briefId) : null;
  const rec = await RunRecorder.start(ctx, { id: hashId("run", ctx.job.id), kind: "storyboard", model: p.cfg.META_MODEL_SPARK, goal: `Storyboard for "${variant.title}" (${aspectRatio}, ${targetDurationSec}s)`, appId });
  try {
    await ctx.progress(10, "collecting real product media");
    const assets = await productAssets(ws, appId);
    const usable = assets.filter((a) => (PRODUCT_KINDS.has(a.role) && a.isProductTruth) || a.role === "founder_clip" || a.role === "logo" || a.role === "icon");
    const assetMap = new Map(usable.map((a) => [a.id, a]));
    const featureAssets = new Map(dna.features.map((f) => [f.id, f.assetIds.filter((x) => assetMap.has(x))]));
    const featureByAsset = new Map<string, string[]>();
    for (const f of dna.features) for (const a of f.assetIds) featureByAsset.set(a, [...(featureByAsset.get(a) ?? []), f.name]);
    const memory = await retrieveMemory(p, { workspaceId: ctx.workspaceId, appId, task: "storyboard", query: `${variant.title} ${variant.hook}`, jobId: ctx.job.id, agentRunId: rec.id });
    const variantClaims = app.verifiedClaims.filter((c) => variant.claimIds.includes(c.id) || brief?.approvedClaimIds.includes(c.id));

    const input = [
      `Concept: ${variant.title} (${variant.angleType})`,
      `Hook: ${variant.hook}`,
      `Audience: ${variant.audience}`,
      `Key message: ${variant.keyMessage}`,
      `Script outline:\n${variant.scriptOutline.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      brief ? `Brief: CTA "${brief.cta}" · USP: ${brief.usp}${brief.visualDirection ? ` · Visual direction: ${brief.visualDirection}` : ""}` : "",
      `Format: ${aspectRatio}, target ${targetDurationSec} seconds total, 3-7 scenes.`,
      variantClaims.length ? `Claims chosen for this concept: ${variantClaims.map((c) => `${c.id}: ${c.text}`).join(" | ")}` : "",
      memory.items.length ? `Team memory:\n${memory.summary}` : "",
      "",
      "Allowlisted templates:",
      templateGuide(),
      "",
      "Asset list (real media — id | role | title | features shown):",
      usable.length ? usable.map((a) => `- ${a.id} | ${a.role} | ${a.title ?? a.originalFilename ?? ""} | ${(featureByAsset.get(a.id) ?? []).join(", ")}`).join("\n") : "- (no product media uploaded; avoid device-demo/feature-callout/before-after)",
      "",
      untrusted("app_dna", dnaSummary(app), 12_000),
    ]
      .filter(Boolean)
      .join("\n");
    const checkCtx: StoryboardCheckContext = { assets: assetMap, verifiedClaimIds: new Set(app.verifiedClaims.map((c) => c.id)), featureAssets };

    await ctx.progress(30, "Muse Spark is writing the storyboard");
    let out = await generateJson(p, { ctx: rec.callCtx("storyboard.generate"), model: "spark", instructions: INSTRUCTIONS, input, schema: StoryboardOutput, schemaName: "Storyboard", maxOutputTokens: 8000, reasoningEffort: "medium", cacheKey: "agents.storyboard" });
    await rec.modelStep("Write storyboard (Muse Spark)", out, { assets: usable.length, target: targetDurationSec }, out.data.scenes.map((s) => `${s.template} ${s.durationSec}s: ${s.onScreenText}`).join("\n"));
    let check = checkStoryboard(out.data, checkCtx);
    let claimCheck = await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: check.scenes.map((s, i) => ({ id: `scene_${i + 1}`, text: [s.onScreenText, s.narration].filter(Boolean).join(" — ") })) });
    if (check.problems.length || !claimCheck.ok) {
      ctx.throwIfCancelled();
      const issues = [...check.problems, ...claimCheck.issues.map((x) => `${x.id.replace("_", " ")}: ${x.issue}`)];
      await rec.step({ kind: "decision", title: `Storyboard needs repair (${issues.length} issues)`, output: issues });
      const repair = `${input}\n\nYour previous storyboard had these problems:\n${issues.map((x) => `- ${x}`).join("\n")}\n\nPrevious storyboard:\n${JSON.stringify(out.data).slice(0, 12_000)}\n\nReturn a corrected storyboard JSON.`;
      out = await generateJson(p, { ctx: rec.callCtx("storyboard.repair"), model: "spark", instructions: INSTRUCTIONS, input: repair, schema: StoryboardOutput, schemaName: "Storyboard", maxOutputTokens: 8000, reasoningEffort: "medium", cacheKey: "agents.storyboard" });
      await rec.modelStep("Repair storyboard (Muse Spark)", out, issues, out.data.scenes.map((s) => `${s.template} ${s.durationSec}s: ${s.onScreenText}`).join("\n"));
      check = checkStoryboard(out.data, checkCtx);
      if (check.problems.length) throw new AppError("PROVIDER_ERROR", `Storyboard still invalid after repair: ${check.problems.join(" ")}`, { retryable: true, userMessage: "The storyboard couldn't be built from your real app media. Add screenshots or retry." });
      claimCheck = await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: check.scenes.map((s, i) => ({ id: `scene_${i + 1}`, text: [s.onScreenText, s.narration].filter(Boolean).join(" — ") })) });
    }
    if (check.fixes.length) await rec.step({ kind: "decision", title: "Deterministic storyboard fixes", output: check.fixes });
    await rec.step({ kind: "decision", title: claimCheck.ok ? "Claim check passed" : `Claim check: ${claimCheck.issues.length} issue(s) for review`, status: claimCheck.ok ? "succeeded" : "failed", output: claimCheck.issues });

    const durations = fitDurations(check.scenes.map((s) => s.durationSec), targetDurationSec);
    const scenes: StoryboardScene[] = check.scenes.map((s, i) => ({
      id: hashId("sbs", storyboardId, i).slice(0, 40),
      order: i,
      purpose: s.purpose,
      durationSec: durations[i]!,
      onScreenText: s.onScreenText,
      narration: s.narration,
      visual: s.visual,
      template: s.template,
      assets: s.assets,
      claimIds: s.claimIds,
    }));
    const founderClip = usable.find((a) => a.role === "founder_clip");
    const voiceover: Storyboard["voiceover"] =
      out.data.voiceover.source === "founder_recording" && founderClip
        ? { source: "founder_recording", assetId: founderClip.id, script: out.data.voiceover.script }
        : out.data.voiceover.source === "tts"
          ? { source: "tts", script: out.data.voiceover.script ?? scenes.map((s) => s.narration).filter(Boolean).join(" ") }
          : { source: "none" };
    const storyboard = (
      await ws.collection("storyboards").createIfAbsent(
        { id: storyboardId, appId, campaignId, variantId, title: out.data.title, aspectRatio, targetDurationSec, scenes, voiceover, music: out.data.music, generatedByRunId: rec.id },
        { actor: ctx.actor },
      )
    ).entity;
    await ws.collection("campaignVariants").update(variantId, { storyboardId, status: variant.status === "proposed" ? "selected" : variant.status, compositionIds: [...new Set([...variant.compositionIds, compositionId])] }, { actor: ctx.actor });
    // Producing (again): the campaign returns to `review` when every production chain has finished (campaign-status.ts).
    if (campaign.status === "planning" || campaign.status === "concepts_ready" || campaign.status === "review") await ws.collection("campaigns").update(campaignId, { status: "producing" }, { actor: ctx.actor });
    await ctx.progress(90, "queueing composition build");
    const build = await ctx.enqueue("composition.build", { appId, storyboardId, compositionId }, { idempotencyKey: `composition.build:${storyboardId}`, credits: { operation: "composition.build" } });
    await rec.finish("succeeded", { outputRefs: [{ entity: "storyboards", id: storyboard.id }], memoryRefs: memory.items.map((m) => m.id) });
    return {
      refs: [{ entity: "storyboards", id: storyboard.id }, { entity: "agentRuns", id: rec.id }],
      data: { compositionId, buildJobId: build.id, claimIssues: claimCheck.issues, fixes: check.fixes },
    };
  } catch (raw) {
    const err = toAppError(raw);
    await rec.finish(err.code === "CANCELLED" ? "cancelled" : "failed", { error: err.toInfo() }).catch(() => {});
    throw err;
  }
}
