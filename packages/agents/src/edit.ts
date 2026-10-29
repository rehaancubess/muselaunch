import type { ClipAnalysis, CompositionDoc, CompositionPatch, Layer, MediaAsset, PatchOp } from "@muselaunch/contracts";
import { applyPatch, describeForLLM, PatchError, sceneHash, TEMPLATE_CATALOG } from "@muselaunch/compositions";
import type { WorkspaceDb } from "@muselaunch/db";
import { commitVersion, getVersion } from "@muselaunch/compositions/store";
import { AppError, toAppError, type JobContext, type JobResult } from "@muselaunch/platform";
import { untrusted, type TextRoute } from "@muselaunch/providers";
import { z } from "zod";
import { validateClaims } from "./claims";
import { dnaSummary, loadAppContext, productAssets } from "./context";
import { retrieveMemory } from "./memory";
import { engineName, fallbackTo, plannedEngine, sparkJson } from "./models";
import { RunRecorder } from "./runs";
import { clip, hashId } from "./util";

const OP_NAMES = ["update_scene", "add_scene", "remove_scene", "move_scene", "add_layer", "update_layer", "remove_layer", "reorder_layer", "update_theme", "upsert_audio", "remove_audio", "set_captions"] as const;
const SCENE_OPS = new Set(["update_scene", "add_layer", "update_layer", "remove_layer", "reorder_layer"]);

/** Wire format from Spark; each op is then validated with the real PatchOp schema by applyPatch. */
export const EditOutput = z.object({
  summary: z.string().min(1).max(1000).describe("One sentence describing the change for the version history"),
  targetSceneIds: z.array(z.string().max(128)).max(30).default([]).describe("Scenes you changed"),
  ops: z.array(z.object({ op: z.enum(OP_NAMES) }).catchall(z.unknown())).min(1).max(40),
});
type EditOutput = z.infer<typeof EditOutput>;

const OP_REFERENCE = `PatchOp reference (return JSON objects exactly in these shapes; reuse existing ids; new ids must be unique, e.g. "ly_<scene>_<word>"):
- {"op":"update_scene","sceneId":ID,"set":{"name"?,"template"?,"purpose"?,"durationSec"?(0.5-60),"background"?:{"kind":"solid"|"gradient"|"image"|"video"|"blur","color"?,"colors"?:[2-4 colors],"angle"?,"assetId"?,"dim"?},"transitionIn"?:{"kind":"cut"|"fade"|"slide-left"|"slide-up"|"zoom"|"blur"|"flash"|"wipe","durationSec"?},"notes"?}}
- {"op":"add_layer","sceneId":ID,"layer":LAYER,"index"?:n}
- {"op":"update_layer","sceneId":ID,"layerId":ID,"set":{partial layer fields; nested box/style/animation/timing merge one level deep; null removes an optional field; never change id/type}}
- {"op":"remove_layer","sceneId":ID,"layerId":ID} · {"op":"reorder_layer","sceneId":ID,"layerId":ID,"toIndex":n}
- {"op":"add_scene","scene":SCENE,"afterSceneId":ID|null} · {"op":"remove_scene","sceneId":ID} · {"op":"move_scene","sceneId":ID,"afterSceneId":ID|null}
- {"op":"update_theme","set":{"background"?,"surface"?,"text"?,"textMuted"?,"accent"?,"accent2"?,"headingFont"?,"bodyFont"?,"radiusPx"?,"mode"?}}
- {"op":"set_captions","captions":{"enabled":bool,"preset":"bold-center"|"minimal-bottom"|"boxed"|"word-pop","position":"top"|"center"|"bottom","source":"script"|"manual","cues":[{"id","startSec","endSec","text"}]}}
LAYER fields: "id","type","name"?,"box":{"x","y","w","h" (fractions of the frame),"rotation"?,"opacity"?,"z"?},"timing"?:{"start","end"?} (seconds from scene start),"animation"?:{"enter"?:{"preset":"none"|"fade"|"slide-up"|"slide-down"|"slide-left"|"slide-right"|"scale-in"|"pop"|"blur-in"|"typewriter"|"mask-reveal","durationSec"?,"delaySec"?,"easing"?:"smooth"|"snappy"|"spring"|"linear"},"exit"?:{"preset":"none"|"fade"|"slide-up"|"slide-down"|"slide-left"|"slide-right"|"scale-out"|"blur-out","durationSec"?},"loop"?:"none"|"float"|"pulse"|"ken-burns"|"slow-zoom"|"tilt"}
- text: "type":"text","role"?:"headline"|"subhead"|"body"|"label"|"cta"|"caption","text","style"?:{"font"?:"heading"|"body"|"mono","sizePx"?,"weight"?,"color"?,"align"?:"left"|"center"|"right","uppercase"?,"background"?:{"color","paddingPx"?,"radiusPx"?},"shadow"?,"highlight"?:{"words":[...],"color"}},"claimIds"?
- device: "type":"device","device"?:"iphone"|"android"|"ipad"|"browser"|"macbook","screenAssetId": a REAL screenshot/recording id,"screenKind"?:"image"|"video","frameColor"?:"black"|"silver"|"natural"|"white","shadow"?
- image: "type":"image","assetId","fit"?:"cover"|"contain","radiusPx"?,"shadow"? · shape: "type":"shape","shape":"rect"|"circle"|"pill"|"blob"|"line","fill"?,"gradientTo"?,"radiusPx"?,"blurPx"?
- video: "type":"video","assetId","trimInSec"?,"trimOutSec"?,"muted"?,"mask"?:{"segmentationId","mode"?:"cutout"|"inverse","fallback"?:"unmasked"|"hide"}
Colours: "#RRGGBB" or "theme.background"|"theme.surface"|"theme.text"|"theme.textMuted"|"theme.accent"|"theme.accent2".`;

/** Object-aware vocabulary (phase 2): only offered when real clip analyses are attached. */
const EFFECTS_REFERENCE = `Object-aware editing (SAM 3.1 tracks of the attached clip; use ONLY the segmentation/object ids listed in the clip context):
- effect layer: {"type":"effect","id","box","timing"?,"effect":"spotlight"|"outline-glow"|"focus-blur"|"highlight-ring"|"follow-arrow"|"screen-insert","target":{"segmentationId","objectId"},"color"?,"intensity"?:0-1,"assetId"? (screen-insert only: a REAL app recording/screenshot id),"inset"?:{"top","right","bottom","left"} (screen-insert only, fractions 0-0.5)}
  spotlight dims everything but the object · outline-glow traces its edge · focus-blur blurs the rest · highlight-ring follows its bbox · follow-arrow points at it · screen-insert puts the real app onto the tracked phone screen.
- "anchor" on ANY layer (labels, callouts, arrows) makes it follow a tracked object: {"segmentationId","objectId","point":"center"|"top"|"bottom"|"left"|"right"|"top-left"|"top-right"|"bottom-left"|"bottom-right","offset"?:{"x","y"},"scaleWithObject"?,"smoothFrames"?,"whenLost":"hold"|"hide"}; "box" stays the fallback position.
- Presenter cutout (depth sandwich): a video layer of the clip with "mask":{"segmentationId","mode":"cutout","objectIds":["<person objectId>"],"fallback":"unmasked"} at a HIGHER z than the app demo/motion-graphics layers behind it.
- Object-aware templates (for new scenes): ${["presenter-depth", "object-spotlight", "product-in-hand"].map((t) => `${t}: ${TEMPLATE_CATALOG[t as keyof typeof TEMPLATE_CATALOG].description}`).join(" | ")}
Effects must support the message (e.g. emphasise the feature being demonstrated); time them to when the object is visible (presence ranges are clip seconds; layer timing is seconds from scene start, so subtract the video layer's trimIn and the scene's position in the clip).`;

const INSTRUCTIONS = `You are Muse Spark acting as MuseLaunch's video editor. You edit an existing, editable composition by returning a minimal list of PatchOps — never a new video.

Rules:
- Change only what the instruction asks. When target scenes are given, every op must stay inside those scenes (no scene add/remove/move, theme, audio or caption changes) so other scenes stay byte-identical.
- Keep existing layer ids; prefer update_layer over remove+add. Do not modify LOCKED layers.
- Device screens and demo media must be REAL product media: use only asset ids from the asset list (role screenshot/app_recording). Never invent asset ids.
- Product claims in text must come from the verified claims list; never invent numbers, reviews or awards.
- Keep text legible inside the frame and the safe zone; durations 0.5-60 s.
${OP_REFERENCE}`;


// ---------------------------------------------------------------------------
// Clip context (effects direction) and multi-version intent routing
// ---------------------------------------------------------------------------

export interface ClipContext {
  analyses: ClipAnalysis[];
  /** "segmentationId/objectId" (and "segmentationId/*") the edit may target. */
  targets: Set<string>;
  text: string;
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** Load analysed clips (SAM tracks + transcript) for this app; refuse other apps' or unfinished analyses. */
export async function loadClipContext(ws: WorkspaceDb, appId: string, ids: string[]): Promise<ClipContext | null> {
  if (!ids.length) return null;
  const analyses = await ws.collection("clipAnalyses").getMany(ids);
  if (analyses.length !== new Set(ids).size || analyses.some((a) => a.appId !== appId)) throw new AppError("BAD_REQUEST", "Unknown clip analysis for this app");
  const unusable = analyses.filter((a) => a.status !== "succeeded" && a.status !== "partial");
  if (unusable.length) throw new AppError("CONFLICT", `Clip analysis ${unusable[0]!.id} is ${unusable[0]!.status}`, { userMessage: "The clip is still being analysed. Try again when it's ready." });
  const targets = new Set<string>();
  const lines: string[] = [];
  for (const a of analyses) {
    const source = await ws.collection("mediaAssets").get(a.sourceAssetId);
    const transcript = a.transcriptId ? await ws.collection("transcripts").get(a.transcriptId) : null;
    lines.push(`- Clip ${a.id}: source video asset ${a.sourceAssetId}${source?.durationSec ? ` (${fmt(source.durationSec)} s)` : ""}${a.durationSec ? `, analysed ${fmt(a.durationSec)} s` : ""}. Objects:`);
    for (const o of a.objects) {
      targets.add(`${o.segmentationId}/${o.objectId}`);
      targets.add(`${o.segmentationId}/*`);
      const presence = o.presence.slice(0, 6).map((r) => `${fmt(r.startSec)}–${fmt(r.endSec)}s`).join(", ");
      const where = o.meanBbox ? ` mostly at x=${fmt(o.meanBbox.x)},y=${fmt(o.meanBbox.y)},w=${fmt(o.meanBbox.w)},h=${fmt(o.meanBbox.h)}` : "";
      lines.push(`  * ${o.label} (key ${o.key}) → target {"segmentationId":"${o.segmentationId}","objectId":"${o.objectId}"}${o.trackingQuality !== undefined ? ` tracking ${fmt(o.trackingQuality)}` : ""}; visible ${presence || "unknown"}${where}`);
    }
    if (transcript?.text) lines.push(`  Transcript (Muse Voice Transcribe): ${clip(transcript.text, 1500)}`);
  }
  return { analyses, targets, text: lines.join("\n") };
}

const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, "2": 2, "3": 3, "4": 4, "5": 5 };
const MULTI_RE = /\b(two|three|four|five|[2-5]|multiple|several)\s+(?:[\w-]+\s+){0,3}?(hooks?|openings?|intros?|versions?|variants?|variations?)\b/i;

/**
 * Intent router: "create three different hooks" / "make 3 versions for different audiences" are
 * requests for variants, not an in-place edit. Returns the variant mode, count and the remaining
 * edit instruction (if the request also asks for an edit).
 */
export function multiVersionIntent(instruction: string): { mode: "hooks" | "audience"; count: number; remaining: string } | null {
  const m = instruction.match(MULTI_RE);
  if (!m) return null;
  const count = NUMBER_WORDS[m[1]!.toLowerCase()] ?? 3;
  const clauses = instruction.split(/(?<=[.;!?])\s+|,\s*(?:and\s+)?|\s+and\s+(?=(?:create|make|give|generate|produce|add|write)\b)/i);
  const multi = clauses.filter((c) => MULTI_RE.test(c));
  const mode = multi.some((c) => /audienc|segment|persona/i.test(c)) ? "audience" : "hooks";
  const remaining = clauses.filter((c) => !MULTI_RE.test(c)).join(", ").replace(/\s+/g, " ").trim();
  return { mode, count, remaining: remaining.replace(/[^A-Za-z]/g, "").length >= 12 ? remaining : "" };
}

const VariantBriefs = z.object({
  variants: z
    .array(z.object({ label: z.string().min(1).max(60), brief: z.string().min(1).max(200).describe("What changes in this version (hook line / opening beat, or the audience it targets)") }))
    .min(2)
    .max(5),
});

export interface EditCheck {
  problems: string[];
  doc?: CompositionDoc;
  ops: PatchOp[];
  affectedSceneIds: string[];
  changedTexts: { id: string; text: string }[];
}

function layerAssetIds(l: Layer): string[] {
  if (l.type === "image" || l.type === "video") return [l.assetId];
  if (l.type === "device") return [l.screenAssetId];
  // Phase-2 screen-insert effects place media onto a tracked phone: same "real product media" rule.
  if (l.type === "effect" && l.assetId) return [l.assetId];
  return [];
}

/** "segmentationId/objectId" pairs a layer depends on (effects, anchors, cutout masks). */
function objectTargets(l: Layer): string[] {
  const out: string[] = [];
  if (l.anchor) out.push(`${l.anchor.segmentationId}/${l.anchor.objectId}`);
  if (l.type === "effect") out.push(`${l.target.segmentationId}/${l.target.objectId}`);
  if (l.type === "video" && l.mask) for (const o of l.mask.objectIds.length ? l.mask.objectIds : ["*"]) out.push(`${l.mask.segmentationId}/${o}`);
  return out;
}

/** Layers whose media must be the app's REAL screenshots/recordings (never generated or stock). */
const needsProductTruth = (l: Layer) => l.type === "device" || l.type === "effect";

/** Validate a proposed edit: real PatchOps, scene scope, untouched scenes byte-identical, real assets, locked layers. */
export function checkEdit(base: CompositionDoc, out: EditOutput, opts: { sceneIds: string[]; assets: Map<string, MediaAsset>; clipTargets?: Set<string> }): EditCheck {
  const problems: string[] = [];
  const ops = out.ops as unknown as PatchOp[];
  const scoped = opts.sceneIds.length > 0;
  const sceneById = new Map(base.scenes.map((s) => [s.id, s]));
  ops.forEach((op, i) => {
    const o = op as { op: string; sceneId?: string; layerId?: string };
    if (scoped && !SCENE_OPS.has(o.op)) problems.push(`ops.${i}: "${o.op}" is not allowed when editing only scenes ${opts.sceneIds.join(", ")}`);
    if (scoped && o.sceneId && !opts.sceneIds.includes(o.sceneId)) problems.push(`ops.${i}: scene ${o.sceneId} is outside the requested scenes (${opts.sceneIds.join(", ")})`);
    if ((o.op === "update_layer" || o.op === "remove_layer" || o.op === "reorder_layer") && o.sceneId && o.layerId) {
      const layer = sceneById.get(o.sceneId)?.layers.find((l) => l.id === o.layerId);
      if (layer?.locked) problems.push(`ops.${i}: layer ${o.layerId} is locked`);
    }
  });
  if (problems.length) return { problems, ops, affectedSceneIds: [], changedTexts: [] };
  let result: ReturnType<typeof applyPatch>;
  try {
    result = applyPatch(base, ops);
  } catch (err) {
    if (err instanceof PatchError) return { problems: err.errors.slice(0, 20), ops, affectedSceneIds: [], changedTexts: [] };
    throw err;
  }
  const allowed = new Set(scoped ? opts.sceneIds : [...out.targetSceneIds, ...result.affectedSceneIds]);
  for (const id of result.affectedSceneIds) if (scoped && !allowed.has(id)) problems.push(`The patch changed scene ${id}, which was not requested.`);
  // Untouched scenes must be byte-identical (scene hashes).
  const after = new Map(result.doc.scenes.map((s) => [s.id, s]));
  for (const s of base.scenes) {
    if (result.affectedSceneIds.includes(s.id)) continue;
    const a = after.get(s.id);
    if (!a || sceneHash(a) !== sceneHash(s)) problems.push(`Scene ${s.id} changed although it is not part of the edit.`);
  }
  const baseAssets = new Set(base.scenes.flatMap((s) => s.layers.flatMap(layerAssetIds)));
  const baseTargets = new Set(base.scenes.flatMap((s) => s.layers.flatMap(objectTargets)));
  const baseTexts = new Map(base.scenes.flatMap((s) => s.layers.filter((l): l is Extract<Layer, { type: "text" }> => l.type === "text").map((l) => [l.id, l.text] as const)));
  const changedTexts: { id: string; text: string }[] = [];
  for (const s of result.doc.scenes) {
    if (!result.affectedSceneIds.includes(s.id)) continue;
    for (const l of s.layers) {
      for (const assetId of layerAssetIds(l)) {
        if (baseAssets.has(assetId)) continue;
        const a = opts.assets.get(assetId);
        if (!a) problems.push(`Layer ${l.id} references unknown asset ${assetId}; use an id from the asset list.`);
        else if (needsProductTruth(l) && !(a.isProductTruth && (a.role === "screenshot" || a.role === "app_recording"))) problems.push(`${l.type === "device" ? "Device" : "Screen-insert"} layer ${l.id} must show a real screenshot or recording, not ${a.role}.`);
      }
      for (const t of objectTargets(l)) {
        if (baseTargets.has(t) || opts.clipTargets?.has(t)) continue;
        problems.push(
          opts.clipTargets?.size
            ? `Layer ${l.id} references tracked object ${t}, which is not one of the attached clip's objects (${[...opts.clipTargets].join(", ")}).`
            : `Layer ${l.id} references tracked object ${t}, but no analysed clip is attached to this edit.`,
        );
      }
      if (l.type === "text" && baseTexts.get(l.id) !== l.text) changedTexts.push({ id: l.id, text: l.text });
    }
  }
  return { problems, doc: problems.length ? undefined : result.doc, ops, affectedSceneIds: result.affectedSceneIds, changedTexts };
}

export async function compositionEditHandler(ctx: JobContext<"composition.edit">): Promise<JobResult> {
  const p = ctx.platform;
  const { appId, compositionId, baseVersion, instruction, sceneIds, patchId, autoApply } = ctx.payload;
  const ws = ctx.ws;
  const patches = ws.collection("compositionPatches");
  const comp = await ws.collection("compositions").getOrThrow(compositionId);
  if (comp.appId !== appId) throw new AppError("BAD_REQUEST", "Composition does not belong to this app");
  const existingPatch = await patches.get(patchId);
  if (existingPatch && existingPatch.compositionId !== compositionId) throw new AppError("BAD_REQUEST", "Patch does not belong to this composition");
  const runId = hashId("run", ctx.job.id);
  if (existingPatch && (existingPatch.status === "applied" || existingPatch.status === "rejected" || existingPatch.agentRunId === runId)) {
    return { refs: [{ entity: "compositionPatches", id: patchId }], data: { alreadyProcessed: true, status: existingPatch.status } };
  }
  const base = await getVersion(ws, compositionId, baseVersion);
  const unknownScenes = sceneIds.filter((id) => !base.doc.scenes.some((s) => s.id === id));
  if (unknownScenes.length) throw new AppError("BAD_REQUEST", `Unknown scene ids: ${unknownScenes.join(", ")}`);

  const app = await loadAppContext(ws, appId);
  const clipCtx = await loadClipContext(ws, appId, ctx.payload.clipAnalysisIds);
  const intent = multiVersionIntent(instruction);
  const effects = Boolean(clipCtx);
  // Explicit routes (providers/router.ts): scene-scoped edits can run on Muse Spark Open when listed in
  // SPARK_OPEN_TASKS; the repair after a failed validation has its own route (Muse Spark by default).
  const route: TextRoute = intent && !intent.remaining ? "composition.variant_briefs" : sceneIds.length ? "composition.edit.scoped" : "composition.edit";
  const planned = plannedEngine(p, route);
  const rec = await RunRecorder.start(ctx, {
    id: runId,
    kind: effects ? "effects_direction" : "scene_edit",
    model: planned.model,
    goal: clip(`${effects ? "Direct object-aware effects" : "Edit"} "${comp.title}" v${baseVersion}: ${instruction}`, 4000),
    appId,
  });
  try {
    const assets = new Map((await productAssets(ws, appId)).map((a) => [a.id, a]));
    const memory = await retrieveMemory(p, { workspaceId: ctx.workspaceId, appId, task: "scene_edit", query: instruction, jobId: ctx.job.id, agentRunId: rec.id });
    const memoryRefs0 = memory.items.map((m) => m.id);
    if (clipCtx) await rec.step({ kind: "message", title: `Clip context: ${clipCtx.analyses.length} analysed clip(s), ${[...clipCtx.targets].filter((t) => !t.endsWith("/*")).length} tracked object(s)`, output: clipCtx.text });

    // Intent router: "three different hooks" → composition.variants, not an in-place edit.
    if (intent && !intent.remaining) {
      const routed = await routeToVariants({ ctx, rec, base: base.doc, appDna: dnaSummary(app), verified: app.verifiedClaims.map((c) => c.text), intent, instruction, clipText: clipCtx?.text });
      const patch = existingPatch
        ? await patches.update(patchId, { status: "rejected", summary: clip(`Routed: creating ${intent.count} ${intent.mode === "hooks" ? "hook" : "audience"} variants instead of editing this version (job ${routed.job.id}).`, 1000), agentRunId: rec.id, memoryRefs: memoryRefs0 }, { actor: ctx.actor })
        : null;
      await rec.finish("succeeded", { outputRefs: [{ entity: "jobs", id: routed.job.id }, ...(patch ? [{ entity: "compositionPatches", id: patchId }] : [])], memoryRefs: memoryRefs0 });
      return {
        refs: [...(patch ? [{ entity: "compositionPatches", id: patchId }] : []), { entity: "agentRuns", id: rec.id }],
        data: { routedTo: "composition.variants", mode: intent.mode, variantsJobId: routed.job.id, targets: routed.targets, claimIssues: routed.claimIssues },
      };
    }
    const editInstruction = intent ? intent.remaining : instruction;
    const input = [
      `Instruction from the founder: ${editInstruction}`,
      intent ? `(The founder also asked for ${intent.count} ${intent.mode === "hooks" ? "different hooks" : "audience versions"}; those are produced separately as variants of the edited video — do not create them here.)` : "",
      sceneIds.length ? `Edit ONLY these scenes: ${sceneIds.join(", ")}` : "No scenes were selected: change the smallest set of scenes that satisfies the instruction and list them in targetSceneIds.",
      memory.items.length ? `Team preferences (apply when relevant):\n${memory.summary}` : "",
      `Verified claims (id: text): ${app.verifiedClaims.map((c) => `${c.id}: ${c.text}`).join(" | ") || "(none)"}`,
      `Asset list (id | role | title): ${[...assets.values()].filter((a) => a.isProductTruth || a.role === "founder_clip" || a.origin === "generated" || a.origin === "stock").map((a) => `${a.id} | ${a.role} | ${a.title ?? a.originalFilename ?? ""}`).join(" ; ") || "(none)"}`,
      clipCtx ? `\nClip context (real footage analysed by SAM 3.1 + Muse Voice Transcribe):\n${untrusted("clip_analysis", clipCtx.text, 8000)}\n\n${EFFECTS_REFERENCE}` : "",
      "",
      "Current composition:",
      untrusted("composition", describeForLLM(base.doc), 40_000),
    ]
      .filter(Boolean)
      .join("\n");
    await ctx.progress(20, `${planned.name} is planning the edit`);
    let out = await sparkJson(p, rec, route, { ctx: rec.callCtx("composition.edit"), instructions: INSTRUCTIONS, input, schema: EditOutput, schemaName: "CompositionEdit", maxOutputTokens: 6000, reasoningEffort: "medium", cacheKey: "agents.edit" });
    let modelNote = out.fallback?.title;
    await rec.modelStep(`Propose scene-scoped patch (${engineName(out.model)})`, out, { instruction, sceneIds }, { summary: out.data.summary, ops: out.data.ops.map((o) => o.op) });
    const clipTargets = clipCtx?.targets;
    let check = checkEdit(base.doc, out.data, { sceneIds, assets, clipTargets });
    let claims = check.problems.length || !check.changedTexts.length ? { ok: true, issues: [] as { id: string; issue: string }[] } : await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: check.changedTexts, onFallback: fallbackTo(rec) });
    if (check.problems.length || !claims.ok) {
      ctx.throwIfCancelled();
      const issues = [...check.problems, ...claims.issues.map((x) => `Text layer ${x.id}: ${x.issue}`)];
      await rec.step({ kind: "decision", title: `Patch rejected by validation (${issues.length}); one repair attempt`, status: "failed", output: issues });
      const repair = `${input}\n\nYour previous patch was invalid:\n${issues.map((x) => `- ${x}`).join("\n")}\n\nPrevious patch:\n${JSON.stringify(out.data).slice(0, 12_000)}\n\nReturn a corrected patch.`;
      out = await sparkJson(p, rec, "composition.edit.repair", { ctx: rec.callCtx("composition.edit.repair"), instructions: INSTRUCTIONS, input: repair, schema: EditOutput, schemaName: "CompositionEdit", maxOutputTokens: 6000, reasoningEffort: "medium", cacheKey: "agents.edit" });
      modelNote = out.fallback?.title;
      await rec.modelStep(`Repair patch (${engineName(out.model)})`, out, issues, { summary: out.data.summary, ops: out.data.ops.map((o) => o.op) });
      check = checkEdit(base.doc, out.data, { sceneIds, assets, clipTargets });
      claims = check.problems.length || !check.changedTexts.length ? { ok: true, issues: [] } : await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: check.changedTexts, onFallback: fallbackTo(rec) });
    }

    const memoryRefs = memory.items.map((m) => m.id);
    if (check.problems.length || !check.doc) {
      if (existingPatch) await patches.update(patchId, { status: "invalid", validationErrors: check.problems.slice(0, 20).map((x) => clip(x, 500)), agentRunId: rec.id, memoryRefs, model: out.model, modelNote }, { actor: ctx.actor });
      await rec.finish("failed", { error: { code: "VALIDATION_FAILED", message: clip(check.problems.join("; "), 4000), retryable: false } });
      throw new AppError("PROVIDER_ERROR", `AI edit could not produce a valid patch: ${check.problems.slice(0, 3).join("; ")}`, { retryable: false, userMessage: `${engineName(out.model)} couldn't make that change safely. Try rephrasing or selecting the scene to edit.`, details: { problems: check.problems.slice(0, 20) } });
    }

    const fields: Partial<CompositionPatch> = {
      ops: check.ops,
      summary: clip(out.data.summary, 1000),
      affectedSceneIds: check.affectedSceneIds,
      status: "proposed",
      validationErrors: claims.issues.map((x) => clip(`Claim check (${x.id}): ${x.issue}`, 500)),
      agentRunId: rec.id,
      memoryRefs,
      instruction,
      // The model that wrote these ops (shown in the Studio), and why when it was a fallback.
      model: out.model,
      modelNote,
    };
    let patch = existingPatch
      ? await patches.update(patchId, fields, { actor: ctx.actor })
      : (await patches.createIfAbsent({ id: patchId, compositionId, baseVersion, source: "ai", ...fields, ops: check.ops, summary: fields.summary!, status: "proposed" }, { actor: ctx.actor })).entity;

    let resultVersion: number | undefined;
    if (autoApply && claims.ok) {
      try {
        const committed = await commitVersion(ws, compositionId, { baseVersion, doc: check.doc, source: "ai_edit", summary: patch.summary, patchId }, ctx.actor);
        resultVersion = committed.version.version;
        patch = await patches.update(patchId, { status: "applied", resultVersion }, { actor: ctx.actor });
      } catch (raw) {
        const err = toAppError(raw);
        if (err.code !== "CONFLICT") throw err;
        patch = await patches.update(patchId, { validationErrors: [...patch.validationErrors, "The composition changed since this edit was requested; review and apply it manually."] }, { actor: ctx.actor });
      }
    }
    await ctx.enqueue("memory.ingest", { appId, ref: { entity: "compositionPatches", id: patchId } }, { idempotencyKey: `memory.ingest:patch:${patchId}:${patch.status}` });
    // Mixed request ("…put the demo behind me, and create three hooks"): variants branch from the
    // edited version, so they start once the edit is applied.
    let variants: Awaited<ReturnType<typeof routeToVariants>> | undefined;
    if (intent && resultVersion) {
      variants = await routeToVariants({ ctx, rec, base: check.doc, appDna: dnaSummary(app), verified: app.verifiedClaims.map((c) => c.text), intent, instruction, clipText: clipCtx?.text });
    } else if (intent) {
      patch = await patches.update(patchId, { summary: clip(`${patch.summary} · Apply this edit, then ask again for the ${intent.count} ${intent.mode === "hooks" ? "hooks" : "audience versions"} so they branch from the edited video.`, 1000) }, { actor: ctx.actor });
    }
    await rec.finish("succeeded", { outputRefs: [{ entity: "compositionPatches", id: patchId }, ...(variants ? [{ entity: "jobs", id: variants.job.id }] : [])], memoryRefs });
    await ctx.progress(100, resultVersion ? `applied as version ${resultVersion}` : "patch ready for review");
    return {
      refs: [{ entity: "compositionPatches", id: patchId }, { entity: "agentRuns", id: rec.id }],
      data: { status: patch.status, resultVersion, affectedSceneIds: check.affectedSceneIds, claimIssues: claims.issues, usedGlimmer: memory.usedGlimmer, effectsDirection: effects, ...(variants ? { variantsJobId: variants.job.id, variantMode: intent!.mode, targets: variants.targets } : {}) },
    };
  } catch (raw) {
    const err = toAppError(raw);
    if (rec.run.status === "running") await rec.finish(err.code === "CANCELLED" ? "cancelled" : "failed", { error: err.toInfo() }).catch(() => {});
    throw err;
  }
}

/** Spark writes N distinct variant briefs (claim-checked) and delegates them to composition.variants. */
async function routeToVariants(input: {
  ctx: JobContext<"composition.edit">;
  rec: RunRecorder;
  base: CompositionDoc;
  appDna: string;
  verified: string[];
  intent: { mode: "hooks" | "audience"; count: number };
  instruction: string;
  clipText?: string;
}): Promise<{ job: Awaited<ReturnType<JobContext["enqueue"]>>; targets: string[]; claimIssues: { id: string; issue: string }[] }> {
  const { ctx, rec, intent } = input;
  const p = ctx.platform;
  const first = input.base.scenes[0];
  const out = await sparkJson(p, rec, "composition.variant_briefs", {
    ctx: rec.callCtx("composition.variant_briefs"),
    cacheKey: "agents.variant_briefs",
    reasoningEffort: "low",
    maxOutputTokens: 2000,
    instructions:
      intent.mode === "hooks"
        ? `Write exactly ${intent.count} strategically different HOOKS (opening line + first-beat idea) for this video. Each brief ≤ 200 characters, distinct angle (e.g. problem, curiosity, demo-first, founder voice). Product claims only from the verified claims. Never invent numbers or reviews.`
        : `Write exactly ${intent.count} versions of this video for DIFFERENT AUDIENCES. Each brief ≤ 200 characters names the audience and what changes for them. Product claims only from the verified claims.`,
    input: [
      `Founder's request: ${input.instruction}`,
      `Current opening scene: ${first ? first.layers.filter((l) => l.type === "text").map((l) => (l as Extract<Layer, { type: "text" }>).text).join(" / ") : ""}`,
      `Verified claims: ${input.verified.join(" | ") || "(none)"}`,
      input.clipText ? untrusted("clip_analysis", input.clipText, 3000) : "",
      untrusted("app_dna", input.appDna, 6000),
    ]
      .filter(Boolean)
      .join("\n\n"),
    schema: VariantBriefs,
    schemaName: "VariantBriefs",
  });
  await rec.modelStep(`Write ${intent.count} ${intent.mode} briefs (${engineName(out.model)})`, out, input.instruction, out.data.variants.map((v) => `${v.label}: ${v.brief}`).join("\n"));
  const variants = out.data.variants.slice(0, intent.count);
  if (variants.length < 2) throw new AppError("PROVIDER_ERROR", `${engineName(out.model)} returned too few variant briefs`, { retryable: true });
  const check = await validateClaims(p, { workspaceId: ctx.workspaceId, appId: ctx.payload.appId, jobId: ctx.job.id, agentRunId: rec.id, texts: variants.map((v, i) => ({ id: `variant_${i + 1}`, text: v.brief })), onFallback: fallbackTo(rec) });
  await rec.step({ kind: "decision", title: check.ok ? "Variant briefs passed the claim check" : `Variant briefs: ${check.issues.length} claim issue(s) for review`, status: check.ok ? "succeeded" : "failed", output: check.issues });
  const targets = variants.map((v) => clip(`${v.label}: ${v.brief}`, 200));
  const job = await ctx.enqueue("composition.variants", { appId: ctx.payload.appId, compositionId: ctx.payload.compositionId, mode: intent.mode, targets }, { idempotencyKey: `composition.variants:${intent.mode}:${ctx.payload.patchId}`, credits: { operation: "composition.variants" } });
  await rec.step({ kind: "subtask", title: `Delegated ${targets.length} ${intent.mode} variants to the video engine`, output: { jobId: job.id, targets } });
  return { job, targets, claimIssues: check.issues };
}
