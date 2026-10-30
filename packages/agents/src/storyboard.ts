import { ScenePurpose, TEMPLATE_IDS, type MediaAsset, type ProductMediaOption, type RecordingSegment, type Storyboard, type StoryboardScene, type TemplateId } from "@muselaunch/contracts";
import { CTA_TEMPLATES, DEVICE_TEMPLATES, PRODUCT_SCENE_TEMPLATES, TEMPLATE_CATALOG, TEMPLATE_SHOT } from "@muselaunch/compositions";
import { AppError, assertKeyInWorkspace, STORYBOARD_MAX_FOCUS_LOOKUPS, toAppError, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { imagePart, runSam, untrusted, type InputPart } from "@muselaunch/providers";
import sharp from "sharp";
import { z } from "zod";
import { validateClaims } from "./claims";
import { planMaxVideoSec, seededDuration } from "./concepts";
import { dnaSummary, loadAppContext, productAssets, requireDna } from "./context";
import { productMediaOptions } from "./media-options";
import { retrieveMemory } from "./memory";
import { engineName, fallbackTo, plannedEngine, sparkJson } from "./models";
import { RunRecorder } from "./runs";
import { clip, hashId } from "./util";

const HintKind = z.enum(["screenshot", "app_recording", "founder_clip", "generated_image", "stock_video", "stock_image", "logo", "none"]);
const Box01 = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) });

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
              assetId: z.string().max(128).optional().describe("Required for screenshot/app_recording/founder_clip/logo: an id from the media list"),
              segmentId: z.string().max(128).optional().describe("A walkthrough segment ref (rsg_…) from the media list, with kind app_recording"),
              query: z.string().max(500).optional().describe("Required for generated_image/stock_*: a prompt/search that does NOT depict the app UI"),
              featureId: z.string().max(128).optional(),
            }),
          )
          .max(4)
          .default([]),
        claimIds: z.array(z.string()).max(5).default([]),
        focus: Box01.optional().describe("focus-zoom / tap-demo: the UI element to push in on, as fractions (0-1) of the attached image of this scene's media"),
        focusQuery: z.string().max(120).optional().describe("focus-zoom / tap-demo when you cannot point precisely: a short noun phrase naming the element, e.g. 'save button'"),
      }),
    )
    .min(2)
    .max(18),
  voiceover: z.object({ source: z.enum(["none", "founder_recording", "tts"]), script: z.string().max(4000).optional() }),
  music: z.object({ mood: z.string().max(120).optional() }).default({}),
});
type StoryboardOutput = z.infer<typeof StoryboardOutput>;
type OutScene = StoryboardOutput["scenes"][number];
type Hint = OutScene["assets"][number];

const PRODUCT_KINDS = new Set(["screenshot", "app_recording"]);
const SUPPORT_KINDS = new Set(["generated_image", "stock_video", "stock_image"]);
const PROOF_TEMPLATES = new Set<TemplateId>(["quote-proof", "stat-card"]);
/** Object-aware templates need real presenter footage (SAM tracks it); never generated media. */
const OBJECT_TEMPLATES = new Set<TemplateId>(["presenter-depth", "object-spotlight", "product-in-hand"]);
const FOCUS_TEMPLATES = new Set<TemplateId>(["focus-zoom", "tap-demo"]);
const TEXT_TEMPLATES = new Set<TemplateId>(["hook-title", "kinetic-type"]);
const UI_WORDS = /\b(screenshot|app (?:ui|interface|screen)|user interface|\bui\b|dashboard of the app|the app's screen|phone screen showing)\b/i;

/** Readable on-screen text: about 3 words per second (plus the entrance before the first word lands). */
export const READING_WORDS_PER_SEC = 3;
export const HOOK_MAX_WORDS = 5;
export const HOOK_MIN_SEC = 1.5;
const MIN_TEMPLATES_LONG = 5;

export const countWords = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** Scene count for a target length: about one scene per 3.5 s (8–16 scenes for 30 s and longer). */
export function sceneRange(targetSec: number): { min: number; max: number } {
  if (targetSec < 30) return { min: 3, max: Math.max(4, Math.min(8, Math.round(targetSec / 2.5))) };
  const n = Math.round(targetSec / 3.5);
  return { min: Math.max(8, Math.min(14, n - 2)), max: Math.min(16, Math.max(10, n + 2)) };
}

/** Shortest a scene can be and still be read: ~3 words/s after the entrance; hook ≥ 1.5 s, end card ≥ 2.5 s. */
export function minSceneSec(s: Pick<OutScene, "onScreenText" | "template">, index: number): number {
  const words = countWords(s.onScreenText);
  let m = Math.max(1.2, words / READING_WORDS_PER_SEC + 0.6);
  if (s.template === "kinetic-type") m = Math.max(m, words / READING_WORDS_PER_SEC + 1);
  if (index === 0) m = Math.max(m, HOOK_MIN_SEC);
  if (CTA_TEMPLATES.has(s.template)) m = Math.max(m, 2.5);
  return Math.round(m * 10) / 10;
}

export interface StoryboardCheckContext {
  assets: Map<string, MediaAsset>;
  verifiedClaimIds: Set<string>;
  featureAssets: Map<string, string[]>;
  /** Walkthrough segments (rsg_…) of the app's recordings. */
  segments?: Map<string, RecordingSegment>;
  /** The video length; rules for 30 s+ videos (variety, close-ups) apply from 30 s. */
  targetDurationSec?: number;
}

const isMarketing = (a: MediaAsset | undefined) => !!a && a.screenshotKind === "marketing" && a.sourceLabel !== "sam_ui_crop";
const isTruth = (a: MediaAsset | undefined): a is MediaAsset => !!a && PRODUCT_KINDS.has(a.role) && a.isProductTruth;
const keyOf = (h: Hint) => (h.segmentId ? `seg:${h.segmentId}` : (h.assetId ?? ""));
const firstProduct = (s: Pick<OutScene, "assets">) => s.assets.find((h) => PRODUCT_KINDS.has(h.kind) && (h.assetId || h.segmentId));

/** Media a storyboard can place: framable items (device templates) and full-screen-only items. */
function mediaCatalog(c: StoryboardCheckContext) {
  const segments = c.segments ?? new Map<string, RecordingSegment>();
  const cropOf = new Map<string, string>();
  for (const a of c.assets.values()) if (a.sourceLabel === "sam_ui_crop" && a.derivedFromAssetId && a.isProductTruth) cropOf.set(a.derivedFromAssetId, a.id);
  const truth = [...c.assets.values()].filter(isTruth);
  const segmented = new Set([...segments.values()].map((s) => s.assetId));
  // Framable items (one key each): walkthrough segments, raw screenshots and SAM cut-outs, recordings without segments.
  const framable: { key: string; hint: Hint; features: string[] }[] = [
    ...[...segments.values()]
      .filter((s) => c.assets.has(s.assetId))
      .sort((a, b) => b.quality - a.quality)
      .map((s) => ({ key: `seg:${s.id}`, hint: { kind: "app_recording" as const, assetId: s.assetId, segmentId: s.id, featureId: s.featureIds[0] }, features: s.featureIds })),
    ...truth
      .filter((a) => a.kind === "image" && !isMarketing(a))
      .map((a) => ({ key: a.id, hint: { kind: "screenshot" as const, assetId: a.id }, features: [...c.featureAssets.entries()].filter(([, ids]) => ids.includes(a.id) || (a.derivedFromAssetId && ids.includes(a.derivedFromAssetId))).map(([f]) => f) })),
    ...truth.filter((a) => a.kind === "video" && !segmented.has(a.id)).map((a) => ({ key: a.id, hint: { kind: "app_recording" as const, assetId: a.id }, features: [] as string[] })),
  ];
  const marketing = truth.filter((a) => isMarketing(a)).map((a) => a.id);
  const segmentByKeyframe = new Map([...segments.values()].filter((s) => s.keyframeAssetId).map((s) => [s.keyframeAssetId!, s.id]));
  return { segments, segmentByKeyframe, cropOf, framable, marketing, productIds: truth.map((a) => a.id) };
}

/**
 * Structural validation + deterministic fixes. Real product media only for demo scenes (walkthrough
 * segments, raw screenshots, SAM cut-outs; designed marketing screenshots only full screen); generated
 * or stock media only for supporting visuals (never of the app UI); proof templates only with verified
 * claims; each media item once per video while unused items remain.
 *
 * `problems` must be repaired by the model (the job fails if they survive the repair); `soft` problems
 * (pace, variety, arc) go into the same repair round and are otherwise fixed by `polishStoryboard`.
 */
export function checkStoryboard(sb: StoryboardOutput, c: StoryboardCheckContext): { scenes: StoryboardOutput["scenes"]; problems: string[]; soft: string[]; fixes: string[] } {
  const problems: string[] = [];
  const soft: string[] = [];
  const fixes: string[] = [];
  const cat = mediaCatalog(c);
  const target = c.targetDurationSec ?? sb.scenes.reduce((n, s) => n + s.durationSec, 0);
  const long = target >= 30;
  let rr = 0;
  const scenes = sb.scenes.map((s, i): OutScene => {
    const n = i + 1;
    let template = s.template;
    let focus = s.focus;
    let assets = s.assets.flatMap((h): Hint[] => {
      if (h.kind === "none") return [];
      if (SUPPORT_KINDS.has(h.kind)) {
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
      // A walkthrough segment, by segmentId, given as the asset id, or by the keyframe image Spark was shown.
      const segId = h.segmentId ?? (h.assetId && cat.segments.has(h.assetId) ? h.assetId : h.assetId ? cat.segmentByKeyframe.get(h.assetId) : undefined);
      if (segId) {
        const seg = cat.segments.get(segId);
        if (!seg || !c.assets.has(seg.assetId)) {
          fixes.push(`Scene ${n}: dropped unknown walkthrough segment ${segId}`);
          return [];
        }
        return [{ kind: "app_recording", assetId: seg.assetId, segmentId: seg.id, featureId: h.featureId ?? seg.featureIds[0] }];
      }
      const a = h.assetId ? c.assets.get(h.assetId) : undefined;
      const roleOk = a && (h.kind === "logo" ? a.role === "logo" || a.role === "icon" : h.kind === "founder_clip" ? a.role === "founder_clip" : a.role === h.kind && a.isProductTruth);
      if (!roleOk) {
        fixes.push(`Scene ${n}: dropped ${h.kind} hint with unknown/mismatched asset ${h.assetId ?? "(none)"}`);
        return [];
      }
      return [{ kind: h.kind, assetId: a.id, featureId: h.featureId }];
    });
    // Designed marketing screenshots never go inside a device frame: their SAM cut-out does, else they go full screen.
    if (DEVICE_TEMPLATES.has(template)) {
      assets = assets.flatMap((h, k): Hint[] => {
        const a = h.assetId ? c.assets.get(h.assetId) : undefined;
        if (h.kind !== "screenshot" || !isMarketing(a)) return [h];
        const crop = cat.cropOf.get(a!.id);
        if (crop) {
          fixes.push(`Scene ${n}: device shows the app-screen cut-out ${crop} instead of the marketing screenshot ${a!.id}`);
          focus = undefined;
          return [{ ...h, assetId: crop }];
        }
        if (k === 0 && template !== "founder-cutout" && template !== "presenter-depth") {
          fixes.push(`Scene ${n}: marketing screenshot ${a!.id} shown full screen (fullscreen-showcase) instead of inside a ${template} device`);
          template = "fullscreen-showcase";
          return [h];
        }
        fixes.push(`Scene ${n}: dropped marketing screenshot ${a!.id} from a device frame`);
        return [];
      });
    }
    const needsProduct = s.purpose === "demo" || s.purpose === "feature" || PRODUCT_SCENE_TEMPLATES.has(template);
    if (needsProduct && !assets.some((h) => PRODUCT_KINDS.has(h.kind))) {
      const featureId = s.assets.find((h) => h.featureId)?.featureId;
      const byFeature = featureId ? cat.framable.find((m) => m.features.includes(featureId)) : undefined;
      const marketing: { hint: Hint }[] = cat.marketing.map((id) => ({ hint: { kind: "screenshot", assetId: id } }));
      const pool = template === "fullscreen-showcase" && marketing.length ? marketing : cat.framable;
      let pick = byFeature ?? pool[rr++ % Math.max(1, pool.length)];
      if (!pick && marketing.length && !OBJECT_TEMPLATES.has(template) && template !== "founder-cutout") {
        // Only designed store screenshots (no cut-outs yet): show one full screen.
        pick = marketing[rr++ % marketing.length];
        fixes.push(`Scene ${n}: ${template} → fullscreen-showcase (only marketing screenshots are available)`);
        template = "fullscreen-showcase";
      }
      if (pick) {
        assets.unshift({ ...pick.hint, featureId: featureId ?? pick.hint.featureId });
        fixes.push(`Scene ${n}: attached real ${pick.hint.segmentId ? `walkthrough segment ${pick.hint.segmentId}` : `${pick.hint.kind} ${pick.hint.assetId}`}`);
      } else {
        problems.push(`Scene ${n} (${template}) must show the real app, but no screenshot or recording is available; use a template that needs no product media.`);
      }
    }
    if ((template === "founder-cutout" || OBJECT_TEMPLATES.has(template)) && !assets.some((h) => h.kind === "founder_clip")) {
      problems.push(`Scene ${n}: ${template} needs a real founder_clip asset from the list (none chosen/available); use another template.`);
    }
    const claimIds = s.claimIds.filter((id) => c.verifiedClaimIds.has(id));
    if (claimIds.length !== s.claimIds.length) fixes.push(`Scene ${n}: removed unverified claim ids`);
    if (PROOF_TEMPLATES.has(template) && !claimIds.length) {
      problems.push(`Scene ${n}: ${template} may only show REAL proof backed by a verified claim id; none given.`);
    }
    if (focus) {
      const x = Math.min(0.98, focus.x);
      const y = Math.min(0.98, focus.y);
      const fixed = { x, y, w: Math.min(focus.w, 1 - x), h: Math.min(focus.h, 1 - y) };
      if (fixed.w < 0.02 || fixed.h < 0.01) {
        fixes.push(`Scene ${n}: ignored an empty focus box`);
        focus = undefined;
      } else focus = fixed;
    }
    return { ...s, template, assets, claimIds, focus, focusQuery: s.focusQuery?.trim() || undefined };
  });
  if (!scenes.some((s) => s.assets.some((h) => PRODUCT_KINDS.has(h.kind))) && cat.productIds.length) {
    problems.push("At least one scene must show the real app (device-demo, focus-zoom or feature-callout with a screenshot, cut-out or walkthrough segment).");
  }
  dedupeMedia(scenes, cat, fixes);
  // Enforced deterministically by fitDurations' minimums: no repair call needed.
  if (scenes[0] && scenes[0].durationSec < HOOK_MIN_SEC) fixes.push(`Scene 1 (hook) held for at least ${HOOK_MIN_SEC}s (was ${scenes[0].durationSec}s)`);
  soft.push(...pacingProblems(scenes, target, long, cat.framable.length > 0));
  return { scenes, problems, soft, fixes };
}

/** Each media item at most once per video while unused items remain (otherwise the builder crops it differently). */
function dedupeMedia(scenes: OutScene[], cat: ReturnType<typeof mediaCatalog>, fixes: string[]) {
  const used = new Set<string>();
  scenes.forEach((s, i) => {
    const h = firstProduct(s);
    if (!h) return;
    const key = keyOf(h);
    if (!used.has(key)) {
      used.add(key);
      return;
    }
    const fullScreen = s.template === "fullscreen-showcase";
    const pool: { key: string; hint: Hint; features: string[] }[] = fullScreen ? cat.marketing.map((id) => ({ key: id, hint: { kind: "screenshot", assetId: id }, features: [] })) : cat.framable;
    const free = pool.filter((m) => !used.has(m.key));
    const pick = (h.featureId ? free.find((m) => m.features.includes(h.featureId!)) : undefined) ?? free.find((m) => (m.hint.kind === "app_recording") === (h.kind === "app_recording")) ?? free[0];
    if (!pick) return; // fewer items than scenes: the builder shows another crop/zoom of it
    s.assets[s.assets.indexOf(h)] = { ...pick.hint, featureId: h.featureId ?? pick.hint.featureId };
    s.focus = undefined; // the box pointed into the other image
    used.add(pick.key);
    fixes.push(`Scene ${i + 1}: ${key.replace(/^seg:/, "segment ")} was already shown; using ${pick.key.replace(/^seg:/, "segment ")} instead`);
  });
}

/** Pace, variety and arc rules (an editor's checklist). */
function pacingProblems(scenes: OutScene[], target: number, long: boolean, hasProductMedia: boolean): string[] {
  const out: string[] = [];
  const range = sceneRange(target);
  if (scenes.length < range.min || scenes.length > range.max) out.push(`${scenes.length} scenes for a ${Math.round(target)} s video; use ${range.min}–${range.max} scenes (about 3.5 s each).`);
  const hook = scenes[0];
  if (hook && countWords(hook.onScreenText) > HOOK_MAX_WORDS) out.push(`Scene 1 (hook) has ${countWords(hook.onScreenText)} words on screen; the hook must be ≤ ${HOOK_MAX_WORDS} words ("${clip(hook.onScreenText, 60)}").`);
  const minTotal = scenes.reduce((n, s, i) => n + minSceneSec(s, i), 0);
  if (minTotal > target + 0.05) out.push(`Too much on-screen text: at about ${READING_WORDS_PER_SEC} words per second it needs ${minTotal.toFixed(1)} s, but the video is ${target} s. Cut words (move detail to narration).`);
  scenes.forEach((s, i) => {
    const w = countWords(s.onScreenText);
    if (w > 12) out.push(`Scene ${i + 1} has ${w} words on screen; keep each scene to ≤ 8 words.`);
  });
  for (let i = 2; i < scenes.length; i++) {
    if (scenes[i]!.template === scenes[i - 1]!.template && scenes[i]!.template === scenes[i - 2]!.template) out.push(`Scenes ${i - 1}–${i + 1} all use ${scenes[i]!.template}; never use the same template more than twice in a row.`);
  }
  const last = scenes[scenes.length - 1];
  if (last && !CTA_TEMPLATES.has(last.template)) out.push("The last scene must be the call to action (store-cta or cta-endcard).");
  if (!scenes.some((s) => s.purpose === "demo" || s.purpose === "feature")) out.push("Show the app solving the problem: add demo/feature scenes (problem → demo → features → proof → CTA).");
  const firstDemo = scenes.findIndex((s) => s.purpose === "demo" || s.purpose === "feature");
  const lateProblem = scenes.findIndex((s, i) => s.purpose === "problem" && firstDemo >= 0 && i > firstDemo);
  if (lateProblem >= 0) out.push(`Scene ${lateProblem + 1} states the problem after the demo has started; keep the arc problem → demo → features → proof → CTA.`);
  const earlyProof = scenes.findIndex((s, i) => s.purpose === "proof" && (firstDemo < 0 || i < firstDemo));
  if (earlyProof >= 0 && earlyProof > 0) out.push(`Scene ${earlyProof + 1} shows proof before the demo; proof comes after the features.`);
  if (long) {
    const distinct = new Set(scenes.map((s) => s.template)).size;
    if (distinct < MIN_TEMPLATES_LONG) out.push(`Only ${distinct} different templates; a ${Math.round(target)} s video needs at least ${MIN_TEMPLATES_LONG} (mix device-demo, focus-zoom, tap-demo, phone-tilt, kinetic-type, fullscreen-showcase, icon-reveal, store-cta…).`);
    if (hasProductMedia && !scenes.some((s) => TEMPLATE_SHOT[s.template] === "close")) out.push("Add at least one close-up (focus-zoom or tap-demo) on the exact UI element that proves a point.");
    for (let i = 3; i < scenes.length; i++) {
      const shot = (k: number) => TEMPLATE_SHOT[scenes[k]!.template];
      if (shot(i) === shot(i - 1) && shot(i) === shot(i - 2) && shot(i) === shot(i - 3)) {
        out.push(`Scenes ${i - 2}–${i + 1} are all ${shot(i)} shots; vary shot sizes (wide device / close-up / type / full screen).`);
        break;
      }
    }
  }
  return out;
}

/** Same-shot alternatives an editor would cut to, for scenes that show the product (in preference order). */
const DEVICE_ALTERNATIVES: TemplateId[] = ["focus-zoom", "phone-tilt", "device-demo", "tap-demo"];

/**
 * Deterministic polish for what the repair round left: a ≤ 5-word hook, an end card, no template more
 * than twice in a row, enough different templates and a close-up in 30 s+ videos.
 */
export function polishStoryboard(input: StoryboardOutput["scenes"], c: Pick<StoryboardCheckContext, "targetDurationSec">, cta: string): { scenes: StoryboardOutput["scenes"]; fixes: string[] } {
  const scenes = input.map((s) => ({ ...s, assets: [...s.assets] }));
  const fixes: string[] = [];
  const target = c.targetDurationSec ?? scenes.reduce((n, s) => n + s.durationSec, 0);
  const long = target >= 30;
  const hook = scenes[0];
  if (hook && countWords(hook.onScreenText) > HOOK_MAX_WORDS) {
    const clause = hook.onScreenText.split(/(?<=[.!?:;—])\s+/)[0]!.trim();
    const short = countWords(clause) <= HOOK_MAX_WORDS ? clause : hook.onScreenText.split(/\s+/).slice(0, HOOK_MAX_WORDS).join(" ").replace(/[,;:—-]+$/, "");
    if (!hook.narration) hook.narration = hook.onScreenText;
    fixes.push(`Hook shortened to ≤ ${HOOK_MAX_WORDS} words: "${short}"`);
    hook.onScreenText = short;
  }
  const last = scenes[scenes.length - 1];
  if (last && !CTA_TEMPLATES.has(last.template)) {
    if (last.purpose === "cta") {
      last.template = "store-cta";
      fixes.push("Last scene uses the store-cta end card");
    } else {
      scenes.push({ purpose: "cta", durationSec: 3, onScreenText: clip(cta, 60), narration: "", visual: "App icon, name and store pills", template: "store-cta", assets: [], claimIds: [] });
      fixes.push("Added a store-cta end card");
    }
  }
  const hasProduct = (s: OutScene) => s.assets.some((h) => PRODUCT_KINDS.has(h.kind));
  const swappable = (s: OutScene) => DEVICE_TEMPLATES.has(s.template) && !OBJECT_TEMPLATES.has(s.template) && s.template !== "founder-cutout" && hasProduct(s);
  const swap = (i: number, avoid: Set<TemplateId>, why: string) => {
    const s = scenes[i]!;
    let next: TemplateId | undefined;
    if (swappable(s)) next = DEVICE_ALTERNATIVES.find((t) => t !== s.template && !avoid.has(t));
    else if (TEXT_TEMPLATES.has(s.template) && i > 0) next = s.template === "kinetic-type" ? "hook-title" : "kinetic-type";
    else if (s.template === "cta-endcard") next = "store-cta";
    if (!next || avoid.has(next)) return false;
    fixes.push(`Scene ${i + 1}: ${s.template} → ${next} (${why})`);
    s.template = next;
    return true;
  };
  for (let i = 2; i < scenes.length; i++) {
    if (scenes[i]!.template === scenes[i - 1]!.template && scenes[i]!.template === scenes[i - 2]!.template) {
      swap(i - 1, new Set([scenes[i]!.template, scenes[i - 2]!.template]), "no template more than twice in a row");
    }
  }
  if (long) {
    const productMedia = scenes.some(hasProduct);
    if (productMedia && !scenes.some((s) => TEMPLATE_SHOT[s.template] === "close")) {
      const demos = scenes.map((s, i) => [s, i] as const).filter(([s]) => swappable(s));
      const pick = demos[1] ?? demos[0];
      if (pick) {
        fixes.push(`Scene ${pick[1] + 1}: ${pick[0].template} → focus-zoom (a close-up on the UI element)`);
        pick[0].template = "focus-zoom";
      }
    }
    // Enough different templates: convert, never invent scenes.
    for (let guard = 0; guard < scenes.length && new Set(scenes.map((s) => s.template)).size < MIN_TEMPLATES_LONG; guard++) {
      const have = new Set(scenes.map((s) => s.template));
      const counts = new Map<TemplateId, number>();
      for (const s of scenes) counts.set(s.template, (counts.get(s.template) ?? 0) + 1);
      // Change a scene whose template is used most, to one not used yet.
      const order = scenes.map((s, i) => [s, i] as const).filter(([s, i]) => (counts.get(s.template) ?? 0) > 1 && i > 0 && i < scenes.length - 1);
      order.sort((a, b) => (counts.get(b[0].template) ?? 0) - (counts.get(a[0].template) ?? 0));
      let changed = false;
      for (const [s, i] of order) {
        const neighbours = new Set([scenes[i - 1]?.template, scenes[i + 1]?.template].filter(Boolean) as TemplateId[]);
        const candidates: TemplateId[] = swappable(s) ? DEVICE_ALTERNATIVES : TEXT_TEMPLATES.has(s.template) ? ["kinetic-type", "hook-title"] : [];
        const next = candidates.find((t) => !have.has(t) && !neighbours.has(t));
        if (next) {
          fixes.push(`Scene ${i + 1}: ${s.template} → ${next} (more shot variety)`);
          s.template = next;
          changed = true;
          break;
        }
      }
      if (!changed) {
        const end = scenes[scenes.length - 1]!;
        if (end.template === "cta-endcard" && !have.has("store-cta")) {
          end.template = "store-cta";
          fixes.push(`Scene ${scenes.length}: cta-endcard → store-cta (more shot variety)`);
        } else break;
      }
    }
  }
  return { scenes, fixes };
}

/**
 * Scale durations to the target length, keeping every scene at or above its minimum (reading time,
 * hook ≥ 1.5 s, end card ≥ 2.5 s). Model durations are the weights. 0.1 s precision; the rounding
 * remainder goes to the longest scene. When the minimums alone exceed the target, they are scaled down.
 */
export function fitDurations(durations: number[], target: number, mins: number[] = []): number[] {
  const n = durations.length;
  if (!n) return [];
  const minOf = (i: number) => Math.max(1, mins[i] ?? 1);
  const sumMin = durations.reduce((a, _, i) => a + minOf(i), 0);
  let values: number[];
  if (sumMin >= target) {
    values = durations.map((_, i) => Math.max(0.5, (minOf(i) * target) / sumMin));
  } else {
    const fixed = new Set<number>();
    let free: number[] = [];
    let scale = 1;
    for (let iter = 0; iter <= n; iter++) {
      free = durations.map((_, i) => i).filter((i) => !fixed.has(i));
      const room = target - [...fixed].reduce((a, i) => a + minOf(i), 0);
      const weight = free.reduce((a, i) => a + Math.max(0.1, durations[i]!), 0) || 1;
      scale = room / weight;
      const under = free.filter((i) => Math.max(0.1, durations[i]!) * scale < minOf(i));
      if (!under.length) break;
      for (const i of under) fixed.add(i);
    }
    values = durations.map((d, i) => (fixed.has(i) ? minOf(i) : Math.max(0.1, d) * scale));
  }
  const rounded = values.map((v) => Math.max(0.5, Math.round(v * 10) / 10));
  const diff = Math.round((target - rounded.reduce((a, b) => a + b, 0)) * 10) / 10;
  const iMax = rounded.indexOf(Math.max(...rounded));
  rounded[iMax] = Math.max(0.5, Math.round((rounded[iMax]! + diff) * 10) / 10);
  return rounded;
}

function templateGuide(): string {
  return TEMPLATE_IDS.map((id) => {
    const t = TEMPLATE_CATALOG[id];
    return `- ${id} [${TEMPLATE_SHOT[id]} shot]: ${t.description} Purposes: ${t.purposes.join(", ")}. Needs: ${t.needs.join(" / ")}.`;
  }).join("\n");
}

const INSTRUCTIONS = `You are Muse Spark acting as MuseLaunch's senior short-form video editor. Turn one campaign concept into a timed storyboard for a marketing video built from editable scenes, cut the way a great editor cuts a product video: tight, varied, readable, and always showing the REAL app.

Story arc, in this order: hook → problem → demo (the app solving it) → features → proof (only real, verified) → CTA.
- Scene 1 is the hook: at most 5 words on screen, on screen for at least 1.5 s. It must stop the scroll (a tension, a sharp question, a bold outcome).
- Then name the problem in the audience's own words (kinetic-type, hook-title or text-over-media).
- Demo and feature scenes show the REAL app: walkthrough segments (real motion, best), screenshots or SAM screen cut-outs from the media list. Never ask for generated or stock images of the app UI.
- Proof only with a verified claim id (quote-proof / stat-card). If there is no real proof, skip it; never invent reviews, numbers, quotes, awards or user counts.
- End with the call to action (store-cta or cta-endcard); an icon-reveal right before it works well.

Editing rules:
- Vary shot sizes like an editor: wide device shots (device-demo, phone-tilt, feature-callout), close-ups (focus-zoom, tap-demo), type (kinetic-type, hook-title) and full-bleed (fullscreen-showcase, text-over-media). Never use the same template more than twice in a row; a video of 30 s or more uses at least 5 different templates and at least one close-up.
- Reading pace: about 3 words per second of on-screen text, after a ~0.6 s entrance (a 6-word line needs at least 2.6 s). onScreenText ≤ 8 words per scene (hook ≤ 5); put anything longer in the narration.
- Scene lengths 2–5 s (hook 1.5–2.5 s, CTA 2.5–4 s); durations should add up to the target.
- Use each real media item at most once per video. Only when there are fewer items than demo scenes, reuse one with a different focus region (focus-zoom on another part of the screen).
- focus-zoom / tap-demo: look at the attached image of the media item and give focus {x,y,w,h} as fractions (0–1) of that image, tight around the UI element that proves the point (a button, a list row, a result). If you cannot point precisely, give focusQuery (a short noun phrase such as "save button") instead.
- Walkthrough segments: hint {kind:"app_recording", segmentId:"<ref>"}. Screenshots and cut-outs: {kind:"screenshot", assetId:"<ref>"}.
- Marketing screenshots (FULL SCREEN ONLY) already have their own phone frame and headline: only in fullscreen-showcase, never inside a device template. Their app-screen cut-outs go in device templates.
- generated_image / stock_* hints are only for supporting visuals (moods, people, settings) and need a query; they never depict the app UI.
- founder-cutout and presenter templates only if a founder_clip exists in the list.
- Product claims in onScreenText/narration must come from the verified claims (list their ids in claimIds).
- Respect the brand voice and team memory.`;

/** Images Spark can look at to point at UI (raw screenshots, cut-outs, walkthrough keyframes). 8 = Muse Spark Open's cap, so the route can still fall back. */
const MAX_STORYBOARD_IMAGES = 8;

interface Visual {
  ref: string;
  /** The still shown to Spark (and SAM): the screenshot / cut-out itself, or a segment's keyframe. */
  image: MediaAsset;
}

async function imageInput(p: Platform, workspaceId: string, a: MediaAsset): Promise<{ part: InputPart; bytes: Buffer; width: number; height: number } | null> {
  assertKeyInWorkspace(workspaceId, a.storagePath);
  let buf: Buffer;
  try {
    buf = await p.storage.get(a.storagePath);
  } catch {
    return null;
  }
  const small = await sharp(buf).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true }).catch(() => null);
  if (!small) return null;
  if (p.storage.driver === "gcs") {
    const { url } = await p.storage.signedDownloadUrl(a.storagePath, { expiresSec: 900 });
    return { part: imagePart({ url }), bytes: small.data, width: small.info.width, height: small.info.height };
  }
  return { part: imagePart({ bytes: small.data, mimeType: "image/jpeg" }), bytes: small.data, width: small.info.width, height: small.info.height };
}

function optionLine(o: ProductMediaOption, imageNo: number | undefined, crops: Map<string, string>): string {
  const where = o.deviceFrameOk ? "device frame OK" : `FULL SCREEN ONLY (fullscreen-showcase)${crops.get(o.ref) ? `; its app-screen cut-out ${crops.get(o.ref)} is the device version` : ""}`;
  const trim = o.trim && o.kind === "recording_segment" ? ` of ${o.assetId}, ${o.trim.inSec.toFixed(1)}–${o.trim.outSec.toFixed(1)} s (${(o.trim.outSec - o.trim.inSec).toFixed(1)} s)` : "";
  return `- ${o.ref} | ${o.kind}${trim} | ${clip(o.title, 140)} | features: ${o.featureIds.join(", ") || "—"} | ${where}${imageNo ? ` | image ${imageNo}` : ""}`;
}

/** SAM 3.1 finds `focusQuery` on the scene's real still when Spark gave no box (at most STORYBOARD_MAX_FOCUS_LOOKUPS). */
async function resolveFocusQueries(ctx: JobContext, rec: RunRecorder, scenes: StoryboardOutput["scenes"], stillFor: (s: OutScene) => MediaAsset | undefined): Promise<number> {
  let lookups = 0;
  for (const [i, s] of scenes.entries()) {
    if (!FOCUS_TEMPLATES.has(s.template) || s.focus || !s.focusQuery) continue;
    const still = stillFor(s);
    if (!still) continue;
    if (lookups >= STORYBOARD_MAX_FOCUS_LOOKUPS) break;
    ctx.throwIfCancelled();
    lookups++;
    try {
      const img = await imageInput(ctx.platform, ctx.workspaceId, still);
      if (!img) continue;
      const r = await runSam(ctx.platform, rec.callCtx("storyboard.focus"), { media: { kind: "image", imageUrl: `data:image/jpeg;base64,${img.bytes.toString("base64")}` }, prompt: { kind: "text", text: s.focusQuery }, timeoutMs: 120_000 });
      const best = [...r.detections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
      if (!best) {
        await rec.step({ kind: "tool_call", title: `SAM 3.1 found no "${clip(s.focusQuery, 60)}" on ${still.id}`, model: r.model, input: { scene: i + 1, query: s.focusQuery }, status: "succeeded" });
        continue;
      }
      const b = best.bounds;
      const focus = { x: b.left / img.width, y: b.top / img.height, w: (b.right - b.left) / img.width, h: (b.bottom - b.top) / img.height };
      const r3 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
      s.focus = { x: r3(focus.x), y: r3(focus.y), w: r3(focus.w), h: r3(focus.h) };
      await rec.step({ kind: "tool_call", title: `SAM 3.1 located "${clip(s.focusQuery, 60)}" for scene ${i + 1}`, model: r.model, input: { scene: i + 1, query: s.focusQuery, image: still.id }, output: s.focus });
    } catch (raw) {
      const err = toAppError(raw);
      if (err.code === "CANCELLED") throw err;
      await rec.step({ kind: "tool_call", title: `SAM 3.1 focus lookup failed for scene ${i + 1}: ${clip(err.message, 160)}`, status: "failed", input: { query: s.focusQuery } });
    }
  }
  return lookups;
}

export async function storyboardHandler(ctx: JobContext<"storyboard.generate">): Promise<JobResult> {
  const p = ctx.platform;
  const { appId, campaignId, variantId, aspectRatio } = ctx.payload;
  const ws = ctx.ws;
  const [campaign, variant] = await Promise.all([ws.collection("campaigns").getOrThrow(campaignId), ws.collection("campaignVariants").getOrThrow(variantId)]);
  if (campaign.appId !== appId || variant.campaignId !== campaignId) throw new AppError("BAD_REQUEST", "Variant does not belong to this campaign/app");
  // The founder's choice, else the concept's own length (30–60 s), within the plan's longest video.
  const planMax = await planMaxVideoSec(p, ctx.workspaceId);
  const targetDurationSec = Math.min(planMax, ctx.payload.targetDurationSec ?? variant.targetDurationSec ?? seededDuration(variant.id, Math.min(30, planMax), Math.min(60, planMax)));
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
  const rec = await RunRecorder.start(ctx, { id: hashId("run", ctx.job.id), kind: "storyboard", model: plannedEngine(p, "storyboard.generate").model, goal: `Storyboard for "${variant.title}" (${aspectRatio}, ${targetDurationSec}s)`, appId });
  try {
    await ctx.progress(10, "collecting real product media");
    const assets = await productAssets(ws, appId);
    const usable = assets.filter((a) => (PRODUCT_KINDS.has(a.role) && a.isProductTruth) || a.role === "founder_clip" || a.role === "logo" || a.role === "icon");
    const assetMap = new Map(usable.map((a) => [a.id, a]));
    const options = await productMediaOptions(ws, appId, dna);
    const segmentIds = options.filter((o) => o.kind === "recording_segment").map((o) => o.ref);
    const segments = new Map(((await ws.collection("recordingSegments").getMany(segmentIds)) as RecordingSegment[]).filter((s) => s.appId === appId && assetMap.has(s.assetId)).map((s) => [s.id, s]));
    const keyframes = new Map(((await ws.collection("mediaAssets").getMany([...segments.values()].map((s) => s.keyframeAssetId).filter((x): x is string => !!x))) as MediaAsset[]).filter((a) => a.kind === "image" && a.appId === appId).map((a) => [a.id, a]));
    const featureAssets = new Map(dna.features.map((f) => [f.id, f.assetIds.filter((x) => assetMap.has(x))]));
    const crops = new Map<string, string>();
    for (const a of usable) if (a.sourceLabel === "sam_ui_crop" && a.derivedFromAssetId) crops.set(a.derivedFromAssetId, a.id);
    const memory = await retrieveMemory(p, { workspaceId: ctx.workspaceId, appId, task: "storyboard", query: `${variant.title} ${variant.hook}`, jobId: ctx.job.id, agentRunId: rec.id });
    const variantClaims = app.verifiedClaims.filter((c) => variant.claimIds.includes(c.id) || brief?.approvedClaimIds.includes(c.id));

    // Stills Spark can point at (focus boxes): best walkthrough segments, cut-outs, raw screenshots.
    const visuals: Visual[] = [];
    const rank = (o: ProductMediaOption) => (o.kind === "recording_segment" ? 0 : o.kind === "ui_crop" ? 1 : 2) - (o.quality ?? 0.5) * 0.5;
    for (const o of [...options].filter((o) => o.kind === "recording_segment" || o.kind === "ui_crop" || o.kind === "raw_screenshot").sort((a, b) => rank(a) - rank(b))) {
      if (visuals.length >= MAX_STORYBOARD_IMAGES) break;
      const image = o.kind === "recording_segment" ? keyframes.get(segments.get(o.ref)?.keyframeAssetId ?? "") : assetMap.get(o.ref);
      if (image) visuals.push({ ref: o.ref, image });
    }
    const parts: InputPart[] = [];
    const imageNo = new Map<string, number>();
    for (const v of visuals) {
      const img = await imageInput(p, ctx.workspaceId, v.image);
      if (!img) continue;
      parts.push(img.part);
      imageNo.set(v.ref, parts.length);
    }
    const range = sceneRange(targetDurationSec);
    const demoMedia = options.filter((o) => o.deviceFrameOk && !["founder_clip", "logo", "icon"].includes(o.kind)).length;

    const input = [
      `Concept: ${variant.title} (${variant.angleType})`,
      `Hook: ${variant.hook}`,
      `Audience: ${variant.audience}`,
      `Key message: ${variant.keyMessage}`,
      `Script outline:\n${variant.scriptOutline.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      brief ? `Brief: CTA "${brief.cta}" · USP: ${brief.usp}${brief.visualDirection ? ` · Visual direction: ${brief.visualDirection}` : ""}` : "",
      `Format: ${aspectRatio}, target ${targetDurationSec} seconds total, ${range.min}-${range.max} scenes (about 3.5 s each; hook 1.5–2.5 s with ≤ ${HOOK_MAX_WORDS} words; CTA 2.5–4 s).`,
      targetDurationSec >= 30 ? `This is a ${targetDurationSec} s video: at least ${MIN_TEMPLATES_LONG} different templates, at least one close-up (focus-zoom or tap-demo), no template more than twice in a row.` : "",
      variantClaims.length ? `Claims chosen for this concept: ${variantClaims.map((c) => `${c.id}: ${c.text}`).join(" | ")}` : "",
      memory.items.length ? `Team memory:\n${memory.summary}` : "",
      "",
      "Allowlisted templates:",
      templateGuide(),
      "",
      `Real product media (ref | kind | what it shows | features | where it may appear | attached image). ${demoMedia} item(s) can go in a device frame: use each at most once.`,
      options.length ? options.map((o) => optionLine(o, imageNo.get(o.ref), crops)).join("\n") : "- (no product media uploaded; avoid device and close-up templates)",
      parts.length ? "\nImages attached, in order (point focus boxes into these):" : "",
      ...visuals.filter((v) => imageNo.has(v.ref)).map((v) => `Image ${imageNo.get(v.ref)}: asset ${v.image.id}${v.image.id !== v.ref ? ` (keyframe of ${v.ref})` : ""}`),
      "",
      untrusted("app_dna", dnaSummary(app), 12_000),
    ]
      .filter((x) => x !== "")
      .join("\n");
    const callInput = parts.length ? ([{ type: "input_text", text: input }, ...parts] as InputPart[]) : input;
    const checkCtx: StoryboardCheckContext = { assets: assetMap, verifiedClaimIds: new Set(app.verifiedClaims.map((c) => c.id)), featureAssets, segments, targetDurationSec };
    const sceneSummary = (o: StoryboardOutput) => o.scenes.map((s) => `${s.template} ${s.durationSec}s: ${s.onScreenText}${s.focus ? " [focus]" : s.focusQuery ? ` [focus: ${s.focusQuery}]` : ""}`).join("\n");

    await ctx.progress(30, `${plannedEngine(p, "storyboard.generate").name} is writing the storyboard`);
    const maxOutputTokens = targetDurationSec >= 30 ? 14_000 : 8000;
    let out = await sparkJson(p, rec, "storyboard.generate", { ctx: rec.callCtx("storyboard.generate"), instructions: INSTRUCTIONS, input: callInput, schema: StoryboardOutput, schemaName: "Storyboard", maxOutputTokens, reasoningEffort: "medium", cacheKey: "agents.storyboard" });
    await rec.modelStep(`Write storyboard (${engineName(out.model)})`, out, { media: options.length, images: parts.length, target: targetDurationSec }, sceneSummary(out.data));
    let check = checkStoryboard(out.data, checkCtx);
    const claimTexts = (scenes: StoryboardOutput["scenes"]) => scenes.map((s, i) => ({ id: `scene_${i + 1}`, text: [s.onScreenText, s.narration].filter(Boolean).join(" — ") }));
    let claimCheck = await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: claimTexts(check.scenes), onFallback: fallbackTo(rec) });
    if (check.problems.length || check.soft.length || !claimCheck.ok) {
      ctx.throwIfCancelled();
      const issues = [...check.problems, ...check.soft, ...claimCheck.issues.map((x) => `${x.id.replace("_", " ")}: ${x.issue}`)];
      await rec.step({ kind: "decision", title: `Storyboard needs repair (${issues.length} issues)`, output: issues });
      const repair = `${input}\n\nYour previous storyboard had these problems:\n${issues.map((x) => `- ${x}`).join("\n")}\n\nPrevious storyboard:\n${JSON.stringify(out.data).slice(0, 16_000)}\n\nReturn a corrected storyboard JSON.`;
      out = await sparkJson(p, rec, "storyboard.generate", { ctx: rec.callCtx("storyboard.repair"), instructions: INSTRUCTIONS, input: parts.length ? ([{ type: "input_text", text: repair }, ...parts] as InputPart[]) : repair, schema: StoryboardOutput, schemaName: "Storyboard", maxOutputTokens, reasoningEffort: "medium", cacheKey: "agents.storyboard" });
      await rec.modelStep(`Repair storyboard (${engineName(out.model)})`, out, issues, sceneSummary(out.data));
      check = checkStoryboard(out.data, checkCtx);
      if (check.problems.length) throw new AppError("PROVIDER_ERROR", `Storyboard still invalid after repair: ${check.problems.join(" ")}`, { retryable: true, userMessage: "The storyboard couldn't be built from your real app media. Add screenshots or retry." });
      claimCheck = await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: claimTexts(check.scenes), onFallback: fallbackTo(rec) });
    }
    const polished = polishStoryboard(check.scenes, checkCtx, brief?.cta || dna.preferredCtas[0] || `Get ${app.app.name}`);
    const fixes = [...check.fixes, ...polished.fixes];
    if (fixes.length) await rec.step({ kind: "decision", title: "Deterministic storyboard fixes", output: fixes });
    await rec.step({ kind: "decision", title: claimCheck.ok ? "Claim check passed" : `Claim check: ${claimCheck.issues.length} issue(s) for review`, status: claimCheck.ok ? "succeeded" : "failed", output: claimCheck.issues });

    // Focus boxes named in words: SAM 3.1 points at them on the real still.
    const stillFor = (s: OutScene): MediaAsset | undefined => {
      const h = firstProduct(s);
      if (!h) return undefined;
      if (h.segmentId) return keyframes.get(segments.get(h.segmentId)?.keyframeAssetId ?? "");
      const a = h.assetId ? assetMap.get(h.assetId) : undefined;
      return a?.kind === "image" ? a : undefined;
    };
    const lookups = await resolveFocusQueries(ctx, rec, polished.scenes, stillFor);

    const durations = fitDurations(
      polished.scenes.map((s) => s.durationSec),
      targetDurationSec,
      polished.scenes.map((s, i) => minSceneSec(s, i)),
    );
    const scenes: StoryboardScene[] = polished.scenes.map((s, i) => ({
      id: hashId("sbs", storyboardId, i).slice(0, 40),
      order: i,
      purpose: s.purpose,
      durationSec: durations[i]!,
      onScreenText: s.onScreenText,
      narration: s.narration,
      visual: s.visual,
      template: s.template,
      assets: s.assets.map((h) => ({ kind: h.kind, ...(h.assetId ? { assetId: h.assetId } : {}), ...(h.segmentId ? { segmentId: h.segmentId } : {}), ...(h.query ? { query: h.query } : {}), ...(h.featureId ? { featureId: h.featureId } : {}) })),
      claimIds: s.claimIds,
      ...(s.focus ? { focus: s.focus } : {}),
      ...(s.focusQuery ? { focusQuery: s.focusQuery } : {}),
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
    // Charged: the storyboard at this length, plus the SAM focus lookups actually made.
    const est = p.credits.estimate("storyboard.generate", { targetDurationSec });
    const lookupPrice = p.credits.prices["storyboard.focus_lookup"] ?? 1;
    const creditsUsed = est.credits - (STORYBOARD_MAX_FOCUS_LOOKUPS - lookups) * lookupPrice;
    return {
      refs: [{ entity: "storyboards", id: storyboard.id }, { entity: "agentRuns", id: rec.id }],
      data: { compositionId, buildJobId: build.id, claimIssues: claimCheck.issues, fixes, targetDurationSec, focusLookups: lookups },
      creditsUsed: ctx.job.reservation ? Math.min(creditsUsed, ctx.job.reservation.credits) : creditsUsed,
    };
  } catch (raw) {
    const err = toAppError(raw);
    await rec.finish(err.code === "CANCELLED" ? "cancelled" : "failed", { error: err.toInfo() }).catch(() => {});
    throw err;
  }
}
