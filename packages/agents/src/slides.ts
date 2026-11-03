import {
  clampSlides,
  FORMAT_LABEL,
  ScenePurpose,
  slideLimits,
  slideNoun,
  stillAspect,
  type AspectRatio,
  type CreativeDirection,
  type MediaAsset,
  type OutputFormat,
  type ProductMediaOption,
  type RecordingSegment,
  type Storyboard,
  type StoreTarget,
  type StoryboardScene,
  type TemplateId,
} from "@muselaunch/contracts";
import { TEMPLATE_CATALOG } from "@muselaunch/compositions";
import { AppError, toAppError, type JobContext, type JobResult } from "@muselaunch/platform";
import { untrusted, type InputPart } from "@muselaunch/providers";
import { z } from "zod";
import { unsupportedFigures, validateClaims } from "./claims";
import { dnaSummary, loadAppContext, productAssets, requireDna } from "./context";
import { directorLabel } from "./direction";
import { productMediaOptions } from "./media-options";
import { retrieveMemory } from "./memory";
import { engineName, fallbackTo, plannedEngine, sparkJson } from "./models";
import { RunRecorder } from "./runs";
import { imageInput } from "./images";
import { clip, hashId, jaccard, normalizeText } from "./util";

/**
 * Muse Spark plans STILLS (stills.ts formats: a post, a carousel, a YouTube thumbnail, an App Store /
 * Google Play screenshot set) from the same inputs as a video storyboard: ONE scene per slide, in
 * order, written like a senior social designer / ASO specialist. Real app screens only (raw
 * screenshots, SAM screen cut-outs, walkthrough segments), proof only with verified claims. The plan
 * goes through deterministic checks, one repair round, deterministic polish and the claim validator,
 * then is saved as a Storyboard with `format` (durations are only a render slot; no narration, no
 * voice, no music) and handed to the same chain as a video (b-roll step → composition.build).
 *
 * `planSlides` is not called directly: `storyboard.generate` dispatches here when its payload has a
 * still `format` (storyboard.ts).
 */

/** The six slide templates (the generic "carousel-slide" stays for older docs; plans never use it). */
export const SLIDE_TEMPLATES = ["slide-cover", "slide-feature", "slide-proof", "slide-cta", "thumbnail-bold", "store-screenshot"] as const satisfies readonly TemplateId[];
export type SlideTemplate = (typeof SLIDE_TEMPLATES)[number];

const Box01 = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) });

/** Muse Spark's slide plan (schema name "SlidePlan"). */
export const SlidePlanOutput = z.object({
  title: z.string().min(1).max(200),
  slides: z
    .array(
      z.object({
        template: z.enum(SLIDE_TEMPLATES),
        purpose: ScenePurpose,
        headline: z.string().max(200).describe("The words on the slide, big"),
        body: z.string().max(300).default("").describe("One supporting line under the headline (may be empty)"),
        visual: z.string().min(1).max(600).describe("What the slide shows: the real screen, the layout, the mood"),
        assets: z
          .array(
            z.object({
              kind: z.enum(["screenshot", "app_recording", "founder_clip", "logo"]),
              assetId: z.string().max(128).optional().describe("A ref from the media list (screenshots, cut-outs, recordings, founder clips, logo)"),
              segmentId: z.string().max(128).optional().describe("A walkthrough segment ref (rsg_…) from the media list, with kind app_recording"),
              featureId: z.string().max(128).optional(),
            }),
          )
          .max(3)
          .default([]),
        claimIds: z.array(z.string()).max(3).default([]),
        focus: Box01.optional().describe("Optional: the part of the attached image of this slide's screen to feature, as fractions (0-1)"),
      }),
    )
    .min(1)
    .max(10),
});
export type SlidePlanOutput = z.infer<typeof SlidePlanOutput>;
export type PlanSlide = SlidePlanOutput["slides"][number];
type Hint = PlanSlide["assets"][number];

/** Words per slide, by format and role (a social designer's / ASO specialist's limits). */
export function wordLimits(format: OutputFormat): { headline: number; body: number } {
  switch (format) {
    case "thumbnail":
      return { headline: 5, body: 0 };
    case "store_screenshots":
      return { headline: 6, body: 10 };
    default:
      return { headline: 8, body: 18 };
  }
}

/** Templates a slide may use in each format (carousel: cover first, CTA last, features/proof between). */
export function templatesFor(format: OutputFormat): readonly SlideTemplate[] {
  switch (format) {
    case "post":
      return ["slide-cover", "slide-feature"];
    case "thumbnail":
      return ["thumbnail-bold"];
    case "store_screenshots":
      return ["store-screenshot"];
    default:
      return ["slide-cover", "slide-feature", "slide-proof", "slide-cta"];
  }
}

/** Slides that must show a real app screen (the plan can't be made without one). */
const SCREEN_TEMPLATES = new Set<SlideTemplate>(["slide-feature", "store-screenshot"]);
/** Slides that show a real screen: always the feature and store slides; covers and thumbnails unless they show the founder's cut-out. */
const SHOWS_MEDIA = new Set<SlideTemplate>(["slide-cover", "slide-feature", "store-screenshot", "thumbnail-bold"]);
const wantsScreen = (s: Pick<PlanSlide, "template" | "assets">) => SCREEN_TEMPLATES.has(s.template) || (SHOWS_MEDIA.has(s.template) && !s.assets.some((h) => h.kind === "founder_clip"));
const PRICE = /(?:[$€£¥₹]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:usd|eur|gbp|dollars?|euros?)\b|\/\s?(?:mo|month|yr|year)\b)/i;

export const countWords = (t: string) => t.split(/\s+/).filter(Boolean).length;

export interface SlideCheckContext {
  format: OutputFormat;
  store?: StoreTarget;
  /** The slide count to plan (clamped). */
  slides: number;
  assets: Map<string, MediaAsset>;
  verifiedClaimIds: Set<string>;
  /** Verified claim texts (what a price or a "#1" in a store headline may rest on). */
  verifiedClaimText?: string;
  featureAssets: Map<string, string[]>;
  segments?: Map<string, RecordingSegment>;
}

interface Screen {
  key: string;
  hint: Hint;
  features: string[];
}

const isMarketing = (a: MediaAsset | undefined) => !!a && a.screenshotKind === "marketing" && a.sourceLabel !== "sam_ui_crop";
const isTruth = (a: MediaAsset | undefined): a is MediaAsset => !!a && (a.role === "screenshot" || a.role === "app_recording") && a.isProductTruth;
const keyOf = (h: Hint) => (h.segmentId ? `seg:${h.segmentId}` : (h.assetId ?? ""));
const screenOf = (s: Pick<PlanSlide, "assets">) => s.assets.find((h) => (h.kind === "screenshot" || h.kind === "app_recording") && (h.assetId || h.segmentId));

/**
 * The real screens a slide can show, best first: raw screenshots and SAM screen cut-outs (stills show
 * stills best), then walkthrough segments by quality, then recordings without segments. Designed
 * marketing screenshots never go in a slide's device frame (their cut-out does).
 */
export function realScreens(c: Pick<SlideCheckContext, "assets" | "featureAssets" | "segments">): Screen[] {
  const segments = c.segments ?? new Map<string, RecordingSegment>();
  const truth = [...c.assets.values()].filter(isTruth);
  const segmented = new Set([...segments.values()].map((s) => s.assetId));
  const featuresOf = (a: MediaAsset) => [...c.featureAssets.entries()].filter(([, ids]) => ids.includes(a.id) || (!!a.derivedFromAssetId && ids.includes(a.derivedFromAssetId))).map(([f]) => f);
  return [
    ...truth.filter((a) => a.kind === "image" && !isMarketing(a)).map((a) => ({ key: a.id, hint: { kind: "screenshot" as const, assetId: a.id }, features: featuresOf(a) })),
    ...[...segments.values()]
      .filter((s) => c.assets.has(s.assetId))
      .sort((a, b) => b.quality - a.quality)
      .map((s) => ({ key: `seg:${s.id}`, hint: { kind: "app_recording" as const, assetId: s.assetId, segmentId: s.id, featureId: s.featureIds[0] }, features: s.featureIds })),
    ...truth.filter((a) => a.kind === "video" && !segmented.has(a.id)).map((a) => ({ key: a.id, hint: { kind: "app_recording" as const, assetId: a.id }, features: [] as string[] })),
  ];
}

/** How many slides to plan: the count asked for, clamped; a store set has no more screenshots than the app has real screens (never below the minimum). */
export function slideCount(format: OutputFormat, asked: number | null | undefined, store: StoreTarget | undefined, screens: number): number {
  const n = clampSlides(format, asked, store);
  if (format !== "store_screenshots") return n;
  const l = slideLimits(format, store);
  return Math.max(l.min, Math.min(n, screens));
}

/**
 * Structural checks + deterministic fixes for a slide plan. `problems` must be repaired by the model
 * (the job fails if they survive the repair); `soft` ones go into the same repair round and are
 * otherwise fixed by `polishSlides`; `fixes` were made here already.
 */
export function checkSlides(plan: SlidePlanOutput, c: SlideCheckContext): { slides: PlanSlide[]; problems: string[]; soft: string[]; fixes: string[] } {
  const problems: string[] = [];
  const soft: string[] = [];
  const fixes: string[] = [];
  const screens = realScreens(c);
  const segments = c.segments ?? new Map<string, RecordingSegment>();
  const cropOf = new Map<string, string>();
  for (const a of c.assets.values()) if (a.sourceLabel === "sam_ui_crop" && a.derivedFromAssetId && a.isProductTruth) cropOf.set(a.derivedFromAssetId, a.id);
  const segmentByKeyframe = new Map([...segments.values()].filter((s) => s.keyframeAssetId).map((s) => [s.keyframeAssetId!, s.id]));
  const allowed = templatesFor(c.format);
  const limits = wordLimits(c.format);
  const noun = slideNoun(c.format);
  const label = (i: number) => (c.slides === 1 && plan.slides.length === 1 ? `The ${noun}` : `Slide ${i + 1}`);

  if (plan.slides.length !== c.slides) soft.push(`${plan.slides.length} slides planned; this ${FORMAT_LABEL[c.format].toLowerCase()} needs exactly ${c.slides}.`);
  const slides = plan.slides.map((s, i): PlanSlide => {
    const n = label(i);
    // Real media only: known ids of this app, in the right role; segments by id, by recording or by keyframe.
    let assets = s.assets.flatMap((h): Hint[] => {
      const segId = h.segmentId ?? (h.assetId && segments.has(h.assetId) ? h.assetId : h.assetId ? segmentByKeyframe.get(h.assetId) : undefined);
      if (segId) {
        const seg = segments.get(segId);
        if (!seg || !c.assets.has(seg.assetId)) {
          fixes.push(`${n}: dropped unknown walkthrough segment ${segId}`);
          return [];
        }
        return [{ kind: "app_recording", assetId: seg.assetId, segmentId: seg.id, featureId: h.featureId ?? seg.featureIds[0] }];
      }
      const a = h.assetId ? c.assets.get(h.assetId) : undefined;
      const ok = a && (h.kind === "logo" ? a.role === "logo" || a.role === "icon" : h.kind === "founder_clip" ? a.role === "founder_clip" : isTruth(a) && a.role === h.kind);
      if (!ok) {
        fixes.push(`${n}: dropped ${h.kind} hint with unknown or mismatched asset ${h.assetId ?? "(none)"}`);
        return [];
      }
      if (h.kind === "screenshot" && isMarketing(a)) {
        const crop = cropOf.get(a!.id);
        if (crop) {
          fixes.push(`${n}: shows the app-screen cut-out ${crop} instead of the designed store image ${a!.id}`);
          return [{ kind: "screenshot", assetId: crop, featureId: h.featureId }];
        }
        fixes.push(`${n}: dropped the designed store image ${a!.id} (it has its own frame and headline)`);
        return [];
      }
      return [{ kind: h.kind, assetId: a!.id, featureId: h.featureId }];
    });
    // The founder's cut-out only on covers and thumbnails.
    if (s.template !== "slide-cover" && s.template !== "thumbnail-bold" && assets.some((h) => h.kind === "founder_clip")) {
      assets = assets.filter((h) => h.kind !== "founder_clip");
      fixes.push(`${n}: the founder's cut-out only goes on a cover or a thumbnail`);
    }
    if (!allowed.includes(s.template)) soft.push(`${n} uses ${s.template}; a ${FORMAT_LABEL[c.format].toLowerCase()} uses ${allowed.join(" / ")}.`);
    const claimIds = s.claimIds.filter((id) => c.verifiedClaimIds.has(id));
    if (claimIds.length !== s.claimIds.length) fixes.push(`${n}: removed unverified claim ids`);
    if (s.template === "slide-proof" && !claimIds.length) soft.push(`${n} is a proof slide without a verified claim id; proof slides only show a verified claim (or make it a feature slide).`);
    if (wantsScreen({ template: s.template, assets }) && !assets.some((h) => h.kind === "screenshot" || h.kind === "app_recording")) {
      const featureId = s.assets.find((h) => h.featureId)?.featureId;
      const pick = (featureId ? screens.find((m) => m.features.includes(featureId)) : undefined) ?? screens[0];
      if (pick) {
        assets.unshift({ ...pick.hint, featureId: featureId ?? pick.hint.featureId });
        fixes.push(`${n}: attached the real ${pick.hint.segmentId ? `walkthrough segment ${pick.hint.segmentId}` : `${pick.hint.kind} ${pick.hint.assetId}`}`);
      } else if (SCREEN_TEMPLATES.has(s.template)) {
        problems.push(`${n} (${s.template}) must show a real screen of the app, but no screenshot or recording is available; plan slides that need no screen.`);
      }
    }
    const hw = countWords(s.headline);
    if (!s.headline.trim() && s.template !== "slide-cta") soft.push(`${n} has no headline.`);
    if (hw > limits.headline) soft.push(`${n} headline has ${hw} words ("${clip(s.headline, 60)}"); at most ${limits.headline}.`);
    const bw = countWords(s.body);
    if (bw > limits.body) soft.push(limits.body ? `${n} body has ${bw} words; at most ${limits.body}.` : `${n}: a ${noun} has a headline only (no body text).`);
    if (c.format === "store_screenshots") {
      const text = `${s.headline} ${s.body}`;
      const price = PRICE.exec(text)?.[0];
      if (price && !normalizeText(c.verifiedClaimText ?? "").includes(normalizeText(price))) soft.push(`${n} mentions a price ("${price}"); store screenshots don't show prices unless a verified claim states them.`);
      for (const f of unsupportedFigures(text, c.verifiedClaimText ?? "")) soft.push(`${n}: ${f.issue} (store screenshots don't rank or count without a verified claim).`);
    }
    let focus = s.focus;
    if (focus) {
      const x = Math.min(0.98, focus.x);
      const y = Math.min(0.98, focus.y);
      const fixed = { x, y, w: Math.min(focus.w, 1 - x), h: Math.min(focus.h, 1 - y) };
      if (fixed.w < 0.02 || fixed.h < 0.01) {
        fixes.push(`${n}: ignored an empty focus box`);
        focus = undefined;
      } else focus = fixed;
    }
    return { ...s, headline: s.headline.trim(), body: s.body.trim(), assets, claimIds, focus };
  });
  // Carousels read as a sequence: a cover, one idea per slide, the call to action last.
  if (c.format === "carousel" && slides.length) {
    if (slides[0]!.template !== "slide-cover") soft.push(`Slide 1 must be the cover (slide-cover) with a scroll-stopping hook.`);
    if (slides.length > 1 && slides[slides.length - 1]!.template !== "slide-cta") soft.push(`The last slide must be the call to action (slide-cta).`);
    slides.forEach((s, i) => {
      if (i > 0 && s.template === "slide-cover") soft.push(`Slide ${i + 1} is a second cover; only slide 1 is the cover.`);
      if (i < slides.length - 1 && s.template === "slide-cta") soft.push(`Slide ${i + 1} is a call to action before the end; only the last slide is.`);
    });
  }
  // Every slide says something new.
  slides.forEach((s, i) => {
    if (!s.headline) return;
    const j = slides.findIndex((o, k) => k < i && o.headline && (normalizeText(o.headline) === normalizeText(s.headline) || jaccard(o.headline, s.headline) >= 0.7));
    if (j >= 0) soft.push(`Slide ${i + 1} repeats slide ${j + 1}'s headline ("${clip(s.headline, 50)}"); each slide tells the next part of the story.`);
  });
  if (slides.some((s) => SCREEN_TEMPLATES.has(s.template)) && !screens.length) problems.push("This plan needs real screens of the app, but none are uploaded yet.");
  soft.push(...duplicateScreens(slides, screens));
  return { slides, problems, soft, fixes };
}

/** Feature and store slides that show a screen another slide already shows, while unused real screens remain. */
function duplicateScreens(slides: PlanSlide[], screens: Screen[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  const used = new Set(slides.map((s) => screenOf(s)).filter(Boolean).map((h) => keyOf(h!)));
  const unused = screens.filter((m) => !used.has(m.key)).length;
  slides.forEach((s, i) => {
    const h = screenOf(s);
    if (!h || !SCREEN_TEMPLATES.has(s.template)) return;
    const k = keyOf(h);
    if (seen.has(k) && unused > 0) out.push(`Slide ${i + 1} shows the same screen as slide ${seen.get(k)! + 1}; each feature slide shows a different real screen (${unused} unused).`);
    else if (!seen.has(k)) seen.set(k, i);
  });
  return out;
}

/** A headline cut to `max` words: its first clause when that fits, else its first words. */
export function cutHeadline(text: string, max: number): string {
  if (countWords(text) <= max) return text;
  const clause = text.split(/(?<=[.!?:;—])\s+/)[0]!.trim();
  if (countWords(clause) <= max) return clause.replace(/[,;:—-]+$/, "");
  return text.split(/\s+/).slice(0, max).join(" ").replace(/[,;:—-]+$/, "");
}

/** A body cut to `max` words: whole sentences while they fit, else the first words with an ellipsis. */
export function cutBody(text: string, max: number): string {
  if (max <= 0) return "";
  if (countWords(text) <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((x) => x.trim()) ?? [text];
  let out = "";
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (countWords(next) > max) break;
    out = next;
  }
  return out || `${text.split(/\s+/).slice(0, max).join(" ").replace(/[,;:—.-]+$/, "")}…`;
}

const PURPOSE_OF: Record<SlideTemplate, PlanSlide["purpose"]> = {
  "slide-cover": "hook",
  "slide-feature": "feature",
  "slide-proof": "proof",
  "slide-cta": "cta",
  "thumbnail-bold": "hook",
  "store-screenshot": "feature",
};

/**
 * Deterministic polish of what the repair round left: the format's templates (a carousel opens on its
 * cover and ends on its call to action), proof only with a verified claim, the slide count, word
 * limits, a different real screen on each feature slide while unused ones remain, and the call to
 * action's words. Never invents slides' content: extra slides are dropped, missing ones are not made up.
 */
export function polishSlides(input: PlanSlide[], c: SlideCheckContext, cta: string): { slides: PlanSlide[]; fixes: string[] } {
  let slides = input.map((s) => ({ ...s, assets: [...s.assets] }));
  const fixes: string[] = [];
  const limits = wordLimits(c.format);
  const screens = realScreens(c);
  const set = (s: PlanSlide, i: number, t: SlideTemplate, why: string) => {
    if (s.template === t) return;
    fixes.push(`Slide ${i + 1}: ${s.template} → ${t} (${why})`);
    s.template = t;
  };
  // Proof needs a verified claim: an unbacked proof slide is dropped (while the count allows) or becomes a feature slide.
  const min = slideLimits(c.format, c.store).min;
  for (let i = slides.length - 1; i >= 0; i--) {
    const s = slides[i]!;
    if (s.template !== "slide-proof" || s.claimIds.length) continue;
    if (slides.length > Math.max(min, c.slides)) {
      fixes.push(`Slide ${i + 1}: dropped a proof slide without a verified claim`);
      slides.splice(i, 1);
    } else set(s, i, screens.length ? "slide-feature" : "slide-cover", "proof slides only show a verified claim");
  }
  // The slide count: extra slides go (the cover and the call to action stay).
  if (slides.length > c.slides) {
    const keepLast = c.format === "carousel" && c.slides > 1 && slides[slides.length - 1]!.template === "slide-cta";
    const dropped = slides.length - c.slides;
    slides = keepLast ? [...slides.slice(0, c.slides - 1), slides[slides.length - 1]!] : slides.slice(0, c.slides);
    fixes.push(`Kept ${c.slides} slide${c.slides === 1 ? "" : "s"} (dropped ${dropped})`);
  } else if (slides.length < c.slides) {
    fixes.push(`Muse Spark planned ${slides.length} of the ${c.slides} slides asked for; nothing was made up to fill the rest`);
  }
  // The format's templates.
  slides.forEach((s, i) => {
    if (c.format === "thumbnail") set(s, i, "thumbnail-bold", "a thumbnail");
    else if (c.format === "store_screenshots") set(s, i, "store-screenshot", "a store screenshot");
    else if (c.format === "post") {
      if (s.template !== "slide-cover" && s.template !== "slide-feature") set(s, i, "slide-cover", "a single post");
    } else {
      const last = i === slides.length - 1 && slides.length > 1;
      if (i === 0) set(s, i, "slide-cover", "the cover opens a carousel");
      else if (last) set(s, i, "slide-cta", "the call to action ends a carousel");
      else if (s.template === "slide-cover" || s.template === "slide-cta" || s.template === "thumbnail-bold" || s.template === "store-screenshot") set(s, i, "slide-feature", "one idea per slide between the cover and the call to action");
    }
    if (!TEMPLATE_CATALOG[s.template].purposes.includes(s.purpose)) s.purpose = PURPOSE_OF[s.template];
    if (s.template !== "slide-cover" && s.template !== "thumbnail-bold") s.assets = s.assets.filter((h) => h.kind !== "founder_clip");
  });
  // Words.
  slides.forEach((s, i) => {
    if (s.template === "slide-cta" && !s.headline) {
      s.headline = cutHeadline(clip(cta, 120), limits.headline);
      fixes.push(`Slide ${i + 1}: the call to action reads "${s.headline}"`);
    }
    const head = cutHeadline(s.headline, limits.headline);
    if (head !== s.headline) {
      if (!s.body && limits.body) s.body = cutBody(s.headline, limits.body);
      fixes.push(`Slide ${i + 1}: headline shortened to ≤ ${limits.headline} words: "${head}"`);
      s.headline = head;
    }
    const body = cutBody(s.body, limits.body);
    if (body !== s.body) {
      fixes.push(limits.body ? `Slide ${i + 1}: body shortened to ≤ ${limits.body} words` : `Slide ${i + 1}: a ${slideNoun(c.format)} has a headline only`);
      s.body = body;
    }
  });
  // Real screens: every screen slide has one; feature slides first get distinct ones, then the cover.
  const used = new Set<string>();
  const order = [...slides.keys()].sort((a, b) => Number(!SCREEN_TEMPLATES.has(slides[a]!.template)) - Number(!SCREEN_TEMPLATES.has(slides[b]!.template)) || a - b);
  for (const i of order) {
    const s = slides[i]!;
    if (!wantsScreen(s)) continue;
    const h = screenOf(s);
    if (!h) {
      const pick = screens.find((m) => !used.has(m.key)) ?? screens[0];
      if (!pick) continue;
      s.assets.unshift({ ...pick.hint });
      used.add(pick.key);
      fixes.push(`Slide ${i + 1}: shows the real ${pick.hint.segmentId ? `walkthrough segment ${pick.hint.segmentId}` : `${pick.hint.kind} ${pick.hint.assetId}`}`);
      continue;
    }
    const k = keyOf(h);
    if (!used.has(k)) {
      used.add(k);
      continue;
    }
    const free = screens.filter((m) => !used.has(m.key));
    const pick = (h.featureId ? free.find((m) => m.features.includes(h.featureId!)) : undefined) ?? free[0];
    if (!pick) {
      if (SCREEN_TEMPLATES.has(s.template)) fixes.push(`Slide ${i + 1} shows a screen another slide shows too (the app has ${screens.length} real screen${screens.length === 1 ? "" : "s"})`);
      continue;
    }
    s.assets[s.assets.indexOf(h)] = { ...pick.hint, featureId: h.featureId ?? pick.hint.featureId };
    s.focus = undefined; // the box pointed into the other image
    used.add(pick.key);
    fixes.push(`Slide ${i + 1}: ${k.replace(/^seg:/, "segment ")} was already shown; using ${pick.key.replace(/^seg:/, "segment ")} instead`);
  }
  return { slides, fixes };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const BASE = `You are Muse Spark acting as MuseLaunch's senior social designer and App Store optimisation (ASO) specialist. Turn one campaign concept into a plan of STILL slides for an indie app: one entry per slide, in order. Every slide is a designed image built from editable layers, and every product screen on it is the REAL app (screenshots, SAM screen cut-outs or walkthrough segments from the media list).

Rules for every format:
- Product screens come only from the media list (by its ref). Never ask for generated or stock images of the app; never invent asset ids.
- Proof only with a verified claim id (slide-proof). Never invent reviews, ratings, numbers, rankings, awards, user counts or prices.
- Product claims in headlines and bodies must come from the verified claims (list their ids in claimIds) or the App DNA's features.
- Write like a person, in the brand voice: concrete benefits, plain words, no hashtags or emoji on the slides.
- headline is the big text; body is one supporting line (or empty). visual says what the slide shows.
- Respect the team memory and the brand voice.`;

const FORMAT_RULES: Record<Exclude<OutputFormat, "video">, string> = {
  carousel: `Format: an Instagram-style carousel (people swipe through it).
- Slide 1 is slide-cover: a scroll-stopping hook, at most 8 words (a tension, a sharp question or a bold outcome), with the best real screen or the founder's cut-out.
- The middle slides tell ONE idea each and read as a sequence (a story, or a numbered list like "1. … 2. …"), never the same tagline again: slide-feature with a short headline, one supporting line and a DIFFERENT real screen each; slide-proof only for a verified claim (with its id).
- The last slide is slide-cta: the call to action (the brief's CTA), the app's name and icon.
- Headline ≤ 8 words, body ≤ 18 words.`,
  post: `Format: ONE single-image feed post.
- Exactly one slide: slide-cover (the hook with the best real screen) or slide-feature (one feature on its real screen).
- Headline ≤ 8 words that stop the scroll; body ≤ 18 words (or empty).`,
  thumbnail: `Format: ONE YouTube thumbnail (16:9).
- Exactly one slide: thumbnail-bold. At most 5 huge words that make people curious, with a real screen or the founder's cut-out.
- No body text. No clickbait: nothing the video doesn't deliver, no invented numbers, no "#1" or "best".`,
  store_screenshots: `Format: an App Store / Google Play screenshot set (ASO).
- Every slide is store-screenshot: a benefit-first headline (≤ 6 words, what the person gets, not the feature's name) on top and a DIFFERENT real screen large below it.
- The first 2–3 slides carry the main value (most people only see those in search results); later slides cover the remaining features.
- Body is optional, ≤ 10 words. No prices, no "#1", "best" or rankings unless a verified claim states them.`,
};

function stillDirectionLines(d: CreativeDirection): string {
  return [
    `Creative direction from ${directorLabel(d)} (the campaign's creative director). Work to it where it fits a still; the rules above still win:`,
    `- Hook approach: ${d.hookApproach}`,
    `- Visual idea through every slide: ${d.visualMotif}`,
    d.avoid ? `- Avoid: ${d.avoid}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function templateGuide(format: OutputFormat): string {
  return templatesFor(format)
    .map((id) => `- ${id}: ${TEMPLATE_CATALOG[id].description}`)
    .join("\n");
}

/** Images Spark can look at (raw screenshots and cut-outs first). 8 = Muse Spark Open's cap, so the route can still fall back. */
const MAX_SLIDE_IMAGES = 8;

function optionLine(o: ProductMediaOption, imageNo: number | undefined): string {
  const what = o.kind === "ui_crop" ? "app-screen cut-out of a store image" : o.kind === "recording_segment" ? `walkthrough segment of ${o.assetId}` : o.kind.replace("_", " ");
  const where = o.kind === "founder_clip" ? "cover / thumbnail only (the founder's SAM cut-out)" : o.kind === "logo" || o.kind === "icon" ? "call-to-action slide" : "real screen for any slide";
  return `- ${o.ref} | ${what} | ${clip(o.title, 140)} | features: ${o.featureIds.join(", ") || "—"} | ${where}${imageNo ? ` | image ${imageNo}` : ""}`;
}

// ---------------------------------------------------------------------------
// The job (storyboard.generate with a still format)
// ---------------------------------------------------------------------------

export async function slidesHandler(ctx: JobContext<"storyboard.generate">): Promise<JobResult> {
  const p = ctx.platform;
  const { appId, campaignId, variantId } = ctx.payload;
  const format = ctx.payload.format as Exclude<OutputFormat, "video">;
  const store: StoreTarget | undefined = format === "store_screenshots" ? (ctx.payload.store ?? "ios") : undefined;
  const aspectRatio: AspectRatio = stillAspect(format, ctx.payload.aspectRatio, store);
  const ws = ctx.ws;
  const [campaign, variant] = await Promise.all([ws.collection("campaigns").getOrThrow(campaignId), ws.collection("campaignVariants").getOrThrow(variantId)]);
  if (campaign.appId !== appId || variant.campaignId !== campaignId) throw new AppError("BAD_REQUEST", "Variant does not belong to this campaign/app");
  const storyboardId = hashId("sbd", ctx.job.id);
  const compositionId = hashId("cmp", storyboardId);
  const already = await ws.collection("storyboards").get(storyboardId);
  if (already) {
    const job = await ctx.enqueue("storyboard.resolve_media", { appId, storyboardId, compositionId }, { idempotencyKey: `storyboard.resolve_media:${storyboardId}` });
    return { refs: [{ entity: "storyboards", id: storyboardId }], data: { compositionId, mediaJobId: job.id, alreadyGenerated: true } };
  }

  const app = await loadAppContext(ws, appId);
  const dna = requireDna(app);
  const brief = campaign.briefId ? await ws.collection("campaignBriefs").get(campaign.briefId) : null;
  const engine = plannedEngine(p, "storyboard.generate");
  const label = FORMAT_LABEL[format];
  const rec = await RunRecorder.start(ctx, { id: hashId("run", ctx.job.id), kind: "storyboard", model: engine.model, goal: `${label} plan for "${variant.title}" (${aspectRatio}${format === "carousel" || format === "store_screenshots" ? `, ${ctx.payload.slides ?? "default"} slides` : ""})`, appId });
  try {
    await ctx.progress(10, "collecting real product screens");
    const assets = await productAssets(ws, appId);
    const usable = assets.filter((a) => (a.isProductTruth && (a.role === "screenshot" || a.role === "app_recording")) || a.role === "founder_clip" || a.role === "logo" || a.role === "icon");
    const assetMap = new Map(usable.map((a) => [a.id, a]));
    const options = (await productMediaOptions(ws, appId, dna)).filter((o) => o.kind !== "marketing_screenshot" && o.kind !== "app_recording");
    const segmentIds = options.filter((o) => o.kind === "recording_segment").map((o) => o.ref);
    const segments = new Map(((await ws.collection("recordingSegments").getMany(segmentIds)) as RecordingSegment[]).filter((s) => s.appId === appId && assetMap.has(s.assetId)).map((s) => [s.id, s]));
    const keyframes = new Map(((await ws.collection("mediaAssets").getMany([...segments.values()].map((s) => s.keyframeAssetId).filter((x): x is string => !!x))) as MediaAsset[]).filter((a) => a.kind === "image" && a.appId === appId).map((a) => [a.id, a]));
    const featureAssets = new Map(dna.features.map((f) => [f.id, f.assetIds.filter((x) => assetMap.has(x))]));
    const checkBase = { format, store, assets: assetMap, verifiedClaimIds: new Set(app.verifiedClaims.map((c) => c.id)), verifiedClaimText: app.verifiedClaims.map((c) => c.text).join("\n"), featureAssets, segments };
    const screens = realScreens(checkBase);
    if (format === "store_screenshots" && !screens.length) {
      throw new AppError("VALIDATION_FAILED", "No real screens of the app to make store screenshots from", { retryable: false, userMessage: "Store screenshots show your real app. Add screenshots or a screen recording first, then try again." });
    }
    const slides = slideCount(format, ctx.payload.slides, store, screens.length);
    const checkCtx: SlideCheckContext = { ...checkBase, slides };
    if (format === "store_screenshots" && slides < clampSlides(format, ctx.payload.slides, store)) {
      await rec.step({ kind: "decision", title: `Planning ${slides} screenshots: the app has ${screens.length} real screen${screens.length === 1 ? "" : "s"}`, output: { asked: clampSlides(format, ctx.payload.slides, store), screens: screens.length } });
    }
    const memory = await retrieveMemory(p, { workspaceId: ctx.workspaceId, appId, task: "storyboard", query: `${variant.title} ${variant.hook} ${label}`, jobId: ctx.job.id, agentRunId: rec.id });
    const variantClaims = app.verifiedClaims.filter((c) => variant.claimIds.includes(c.id) || brief?.approvedClaimIds.includes(c.id));

    // Stills Spark looks at: screenshots and cut-outs first, then walkthrough keyframes.
    const rank = (o: ProductMediaOption) => (o.kind === "recording_segment" ? 1 : 0) - (o.quality ?? 0.5) * 0.5;
    const visuals: { ref: string; image: MediaAsset }[] = [];
    for (const o of options.filter((x) => x.kind === "recording_segment" || x.kind === "ui_crop" || x.kind === "raw_screenshot").sort((a, b) => rank(a) - rank(b))) {
      if (visuals.length >= MAX_SLIDE_IMAGES) break;
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
    const direction = variant.creativeDirection;
    if (direction) await rec.step({ kind: "decision", title: `Working to ${directorLabel(direction)}'s creative direction`, model: direction.model, output: stillDirectionLines(direction) });
    const cta = brief?.cta || dna.preferredCtas[0] || `Get ${app.app.name}`;
    const limits = wordLimits(format);
    const frame = format === "store_screenshots" ? (store === "android" ? "Google Play phone screenshot, 1080×1920" : "App Store 6.9-inch iPhone screenshot, 1290×2796") : aspectRatio;
    const input = [
      `Concept: ${variant.title} (${variant.angleType})`,
      `Hook: ${variant.hook}`,
      `Audience: ${variant.audience}`,
      `Key message: ${variant.keyMessage}`,
      variant.scriptOutline.length ? `Story beats:\n${variant.scriptOutline.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "",
      brief ? `Brief: CTA "${brief.cta}" · USP: ${brief.usp}${brief.visualDirection ? ` · Visual direction: ${brief.visualDirection}` : ""}` : `Call to action: "${cta}"`,
      direction ? stillDirectionLines(direction) : "",
      FORMAT_RULES[format],
      `Plan exactly ${slides} slide${slides === 1 ? "" : "s"} (format ${format}, frame ${frame}). Headline ≤ ${limits.headline} words${limits.body ? `, body ≤ ${limits.body} words` : ", no body"}.`,
      screens.length ? `${screens.length} real screen(s) are available: use each at most once while unused ones remain.` : "No real screens are uploaded yet: plan slides that need no screen (no slide-feature).",
      variantClaims.length ? `Claims chosen for this concept: ${variantClaims.map((c) => `${c.id}: ${c.text}`).join(" | ")}` : "",
      memory.items.length ? `Team memory:\n${memory.summary}` : "",
      "",
      "Slide templates for this format:",
      templateGuide(format),
      "",
      "Real product media (ref | what it is | what it shows | features | where it may appear | attached image):",
      options.length ? options.map((o) => optionLine(o, imageNo.get(o.ref))).join("\n") : "- (no product media uploaded)",
      parts.length ? "\nImages attached, in order:" : "",
      ...visuals.filter((v) => imageNo.has(v.ref)).map((v) => `Image ${imageNo.get(v.ref)}: asset ${v.image.id}${v.image.id !== v.ref ? ` (keyframe of ${v.ref})` : ""}`),
      "",
      untrusted("app_dna", dnaSummary(app), 12_000),
    ]
      .filter((x) => x !== "")
      .join("\n");
    const instructions = `${BASE}\n\n${FORMAT_RULES[format]}`;
    const callInput = (text: string) => (parts.length ? ([{ type: "input_text", text }, ...parts] as InputPart[]) : text);
    const summary = (o: SlidePlanOutput) => o.slides.map((s, i) => `${i + 1}. ${s.template}: ${s.headline}${s.body ? ` — ${s.body}` : ""}`).join("\n");
    const claimTexts = (xs: PlanSlide[]) => xs.map((s, i) => ({ id: `slide_${i + 1}`, text: [s.headline, s.body].filter(Boolean).join(" — ") }));
    const maxOutputTokens = 2000 + slides * 500;

    await ctx.progress(30, `${engine.name} is planning the ${slideNoun(format) === "slide" ? "slides" : slideNoun(format)}`);
    let out = await sparkJson(p, rec, "storyboard.generate", { ctx: rec.callCtx("storyboard.slides"), instructions, input: callInput(input), schema: SlidePlanOutput, schemaName: "SlidePlan", maxOutputTokens, reasoningEffort: "medium", cacheKey: "agents.slides" });
    await rec.modelStep(`Plan ${label.toLowerCase()} (${engineName(out.model)})`, out, { format, slides, media: options.length, images: parts.length }, summary(out.data));
    let check = checkSlides(out.data, checkCtx);
    let polished = polishSlides(check.slides, checkCtx, cta);
    let claimCheck = await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: claimTexts(polished.slides), onFallback: fallbackTo(rec) });
    if (check.problems.length || check.soft.length || !claimCheck.ok) {
      ctx.throwIfCancelled();
      const issues = [...check.problems, ...check.soft, ...claimCheck.issues.map((x) => `${x.id.replace("_", " ")}: ${x.issue}`)];
      await rec.step({ kind: "decision", title: `Slide plan needs repair (${issues.length} issues)`, output: issues });
      const repair = `${input}\n\nYour previous slide plan had these problems:\n${issues.map((x) => `- ${x}`).join("\n")}\n\nPrevious slide plan:\n${JSON.stringify(out.data).slice(0, 12_000)}\n\nReturn a corrected slide plan JSON.`;
      out = await sparkJson(p, rec, "storyboard.generate", { ctx: rec.callCtx("storyboard.slides.repair"), instructions, input: callInput(repair), schema: SlidePlanOutput, schemaName: "SlidePlan", maxOutputTokens, reasoningEffort: "medium", cacheKey: "agents.slides" });
      await rec.modelStep(`Repair ${label.toLowerCase()} plan (${engineName(out.model)})`, out, issues, summary(out.data));
      check = checkSlides(out.data, checkCtx);
      if (check.problems.length) throw new AppError("PROVIDER_ERROR", `Slide plan still invalid after repair: ${check.problems.join(" ")}`, { retryable: true, userMessage: `The ${label.toLowerCase()} couldn't be planned from your real app screens. Add screenshots or try again.` });
      polished = polishSlides(check.slides, checkCtx, cta);
      claimCheck = await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: claimTexts(polished.slides), onFallback: fallbackTo(rec) });
    }
    if (!polished.slides.length) throw new AppError("PROVIDER_ERROR", "The slide plan had no slides", { retryable: true });
    const fixes = [...check.fixes, ...polished.fixes];
    if (fixes.length) await rec.step({ kind: "decision", title: "Deterministic slide fixes", output: fixes });
    await rec.step({ kind: "decision", title: claimCheck.ok ? "Claim check passed" : `Claim check: ${claimCheck.issues.length} issue(s) for review`, status: claimCheck.ok ? "succeeded" : "failed", output: claimCheck.issues });

    const scenes: StoryboardScene[] = polished.slides.map((s, i) => ({
      id: hashId("sbs", storyboardId, i).slice(0, 40),
      order: i,
      purpose: s.purpose,
      // A render slot only: a still has no timing.
      durationSec: 1,
      onScreenText: s.headline,
      ...(s.body ? { body: s.body } : {}),
      narration: "",
      visual: s.visual,
      template: s.template,
      assets: s.assets.map((h) => ({ kind: h.kind, ...(h.assetId ? { assetId: h.assetId } : {}), ...(h.segmentId ? { segmentId: h.segmentId } : {}), ...(h.featureId ? { featureId: h.featureId } : {}) })),
      claimIds: s.claimIds,
      ...(s.focus ? { focus: s.focus } : {}),
    }));
    const storyboard = (
      await ws.collection("storyboards").createIfAbsent(
        {
          id: storyboardId,
          appId,
          campaignId,
          variantId,
          title: out.data.title,
          aspectRatio,
          targetDurationSec: scenes.length,
          format,
          ...(store ? { store } : {}),
          scenes,
          voiceover: { source: "none" } satisfies Storyboard["voiceover"],
          music: {},
          generatedByRunId: rec.id,
        },
        { actor: ctx.actor },
      )
    ).entity;
    await ws.collection("campaignVariants").update(variantId, { storyboardId, status: variant.status === "proposed" ? "selected" : variant.status, compositionIds: [...new Set([...variant.compositionIds, compositionId])] }, { actor: ctx.actor });
    if (campaign.status === "planning" || campaign.status === "concepts_ready" || campaign.status === "review") await ws.collection("campaigns").update(campaignId, { status: "producing" }, { actor: ctx.actor });
    await ctx.progress(90, `queueing the ${label.toLowerCase()} build`);
    const media = await ctx.enqueue("storyboard.resolve_media", { appId, storyboardId, compositionId }, { idempotencyKey: `storyboard.resolve_media:${storyboardId}` });
    await rec.finish("succeeded", { outputRefs: [{ entity: "storyboards", id: storyboard.id }], memoryRefs: memory.items.map((m) => m.id) });
    const creditsUsed = p.credits.estimate("storyboard.generate", { format, slides: scenes.length, store }).credits;
    return {
      refs: [{ entity: "storyboards", id: storyboard.id }, { entity: "agentRuns", id: rec.id }],
      data: { compositionId, mediaJobId: media.id, claimIssues: claimCheck.issues, fixes, format, slides: scenes.length },
      creditsUsed: ctx.job.reservation ? Math.min(creditsUsed, ctx.job.reservation.credits) : creditsUsed,
    };
  } catch (raw) {
    const err = toAppError(raw);
    await rec.finish(err.code === "CANCELLED" ? "cancelled" : "failed", { error: err.toInfo() }).catch(() => {});
    throw err;
  }
}
