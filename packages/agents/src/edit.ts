import type { CompositionDoc, CompositionPatch, Layer, MediaAsset, PatchOp } from "@muselaunch/contracts";
import { applyPatch, describeForLLM, PatchError, sceneHash } from "@muselaunch/compositions";
import { commitVersion, getVersion } from "@muselaunch/compositions/store";
import { AppError, toAppError, type JobContext, type JobResult } from "@muselaunch/platform";
import { generateJson, untrusted } from "@muselaunch/providers";
import { z } from "zod";
import { validateClaims } from "./claims";
import { loadAppContext, productAssets } from "./context";
import { retrieveMemory } from "./memory";
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

const INSTRUCTIONS = `You are Muse Spark acting as MuseLaunch's video editor. You edit an existing, editable composition by returning a minimal list of PatchOps — never a new video.

Rules:
- Change only what the instruction asks. When target scenes are given, every op must stay inside those scenes (no scene add/remove/move, theme, audio or caption changes) so other scenes stay byte-identical.
- Keep existing layer ids; prefer update_layer over remove+add. Do not modify LOCKED layers.
- Device screens and demo media must be REAL product media: use only asset ids from the asset list (role screenshot/app_recording). Never invent asset ids.
- Product claims in text must come from the verified claims list; never invent numbers, reviews or awards.
- Keep text legible inside the frame and the safe zone; durations 0.5-60 s.
${OP_REFERENCE}`;

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

/** Layers whose media must be the app's REAL screenshots/recordings (never generated or stock). */
const needsProductTruth = (l: Layer) => l.type === "device" || l.type === "effect";

/** Validate a proposed edit: real PatchOps, scene scope, untouched scenes byte-identical, real assets, locked layers. */
export function checkEdit(base: CompositionDoc, out: EditOutput, opts: { sceneIds: string[]; assets: Map<string, MediaAsset> }): EditCheck {
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
  const rec = await RunRecorder.start(ctx, { id: runId, kind: "scene_edit", model: p.cfg.META_MODEL_SPARK, goal: clip(`Edit "${comp.title}" v${baseVersion}: ${instruction}`, 4000), appId });
  try {
    const assets = new Map((await productAssets(ws, appId)).map((a) => [a.id, a]));
    const memory = await retrieveMemory(p, { workspaceId: ctx.workspaceId, appId, task: "scene_edit", query: instruction, jobId: ctx.job.id, agentRunId: rec.id });
    const input = [
      `Instruction from the founder: ${instruction}`,
      sceneIds.length ? `Edit ONLY these scenes: ${sceneIds.join(", ")}` : "No scenes were selected: change the smallest set of scenes that satisfies the instruction and list them in targetSceneIds.",
      memory.items.length ? `Team preferences (apply when relevant):\n${memory.summary}` : "",
      `Verified claims (id: text): ${app.verifiedClaims.map((c) => `${c.id}: ${c.text}`).join(" | ") || "(none)"}`,
      `Asset list (id | role | title): ${[...assets.values()].filter((a) => a.isProductTruth || a.role === "founder_clip" || a.origin === "generated" || a.origin === "stock").map((a) => `${a.id} | ${a.role} | ${a.title ?? a.originalFilename ?? ""}`).join(" ; ") || "(none)"}`,
      "",
      "Current composition:",
      untrusted("composition", describeForLLM(base.doc), 40_000),
    ]
      .filter(Boolean)
      .join("\n");
    await ctx.progress(20, "Muse Spark is planning the edit");
    let out = await generateJson(p, { ctx: rec.callCtx("composition.edit"), model: "spark", instructions: INSTRUCTIONS, input, schema: EditOutput, schemaName: "CompositionEdit", maxOutputTokens: 6000, reasoningEffort: "medium", cacheKey: "agents.edit" });
    await rec.modelStep("Propose scene-scoped patch (Muse Spark)", out, { instruction, sceneIds }, { summary: out.data.summary, ops: out.data.ops.map((o) => o.op) });
    let check = checkEdit(base.doc, out.data, { sceneIds, assets });
    let claims = check.problems.length || !check.changedTexts.length ? { ok: true, issues: [] as { id: string; issue: string }[] } : await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: check.changedTexts });
    if (check.problems.length || !claims.ok) {
      ctx.throwIfCancelled();
      const issues = [...check.problems, ...claims.issues.map((x) => `Text layer ${x.id}: ${x.issue}`)];
      await rec.step({ kind: "decision", title: `Patch rejected by validation (${issues.length}); one repair attempt`, status: "failed", output: issues });
      const repair = `${input}\n\nYour previous patch was invalid:\n${issues.map((x) => `- ${x}`).join("\n")}\n\nPrevious patch:\n${JSON.stringify(out.data).slice(0, 12_000)}\n\nReturn a corrected patch.`;
      out = await generateJson(p, { ctx: rec.callCtx("composition.edit.repair"), model: "spark", instructions: INSTRUCTIONS, input: repair, schema: EditOutput, schemaName: "CompositionEdit", maxOutputTokens: 6000, reasoningEffort: "medium", cacheKey: "agents.edit" });
      await rec.modelStep("Repair patch (Muse Spark)", out, issues, { summary: out.data.summary, ops: out.data.ops.map((o) => o.op) });
      check = checkEdit(base.doc, out.data, { sceneIds, assets });
      claims = check.problems.length || !check.changedTexts.length ? { ok: true, issues: [] } : await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: check.changedTexts });
    }

    const memoryRefs = memory.items.map((m) => m.id);
    if (check.problems.length || !check.doc) {
      if (existingPatch) await patches.update(patchId, { status: "invalid", validationErrors: check.problems.slice(0, 20).map((x) => clip(x, 500)), agentRunId: rec.id, memoryRefs }, { actor: ctx.actor });
      await rec.finish("failed", { error: { code: "VALIDATION_FAILED", message: clip(check.problems.join("; "), 4000), retryable: false } });
      throw new AppError("PROVIDER_ERROR", `AI edit could not produce a valid patch: ${check.problems.slice(0, 3).join("; ")}`, { retryable: false, userMessage: "Muse Spark couldn't make that change safely. Try rephrasing or selecting the scene to edit.", details: { problems: check.problems.slice(0, 20) } });
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
    await rec.finish("succeeded", { outputRefs: [{ entity: "compositionPatches", id: patchId }], memoryRefs });
    await ctx.progress(100, resultVersion ? `applied as version ${resultVersion}` : "patch ready for review");
    return { refs: [{ entity: "compositionPatches", id: patchId }, { entity: "agentRuns", id: rec.id }], data: { status: patch.status, resultVersion, affectedSceneIds: check.affectedSceneIds, claimIssues: claims.issues, usedGlimmer: memory.usedGlimmer } };
  } catch (raw) {
    const err = toAppError(raw);
    if (rec.run.status === "running") await rec.finish(err.code === "CANCELLED" ? "cancelled" : "failed", { error: err.toInfo() }).catch(() => {});
    throw err;
  }
}
