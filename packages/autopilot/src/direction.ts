import { DirectionPacing, modelDisplayName, MUSIC_MOOD_INFO, MUSIC_MOODS, TEMPLATE_IDS, type CreativeDirection, type MediaAsset, type TemplateId } from "@muselaunch/contracts";
import { z } from "zod";

/**
 * Muse Wonder as creative director (Growth Autopilot, `pick_variants`): with each concept it picks,
 * Wonder sets the hook approach, pacing, visual motif, signature shots and music mood. The storyboard
 * writer works to it (agents/direction.ts) and the music mood is applied as chosen.
 */

/** Templates that need real presenter footage (SAM tracks it). */
export const OBJECT_AWARE_SHOTS: readonly TemplateId[] = ["founder-cutout", "presenter-depth", "object-spotlight", "product-in-hand"];

/** Never a "signature" shot: end cards, static slides, and proof cards that need verified evidence. */
const NOT_SIGNATURE = new Set<TemplateId>(["carousel-slide", "quote-proof", "stat-card", "cta-endcard", "store-cta"]);

const SHOT_NOTES: Partial<Record<TemplateId, string>> = {
  "hook-title": "big kinetic headline",
  "device-demo": "real app inside an animated phone",
  "feature-callout": "phone with animated callout labels",
  "before-after": "wipe between two real workflow states",
  "text-over-media": "full-bleed supporting footage with a headline",
  "split-screen": "two panes side by side",
  "focus-zoom": "push-in on one element of the real screen",
  "tap-demo": "finger tap with ripple on the real screen",
  "phone-tilt": "3D phone turn over a parallax background",
  "kinetic-type": "word-by-word typography",
  "icon-reveal": "app icon scale-in with glow",
  "fullscreen-showcase": "designed store screenshot, full-bleed slow push",
  "founder-cutout": "founder cut out by SAM, in front of the app",
  "presenter-depth": "app demo BEHIND the presenter (SAM depth sandwich)",
  "object-spotlight": "the phone in hand tracked and highlighted (SAM)",
  "product-in-hand": "real app recording placed onto the phone in hand (SAM)",
};

const PACING_NOTES: Record<DirectionPacing, string> = {
  punchy: "quick cuts, scenes mostly 2–3 s",
  steady: "even rhythm, scenes mostly 3–4 s",
  "slow-burn": "fewer, longer shots of 4–5 s that build",
};

/** Presenter footage the storyboard can use (a founder clip on this app). */
export function hasPresenterFootage(assets: MediaAsset[]): boolean {
  return assets.some((a) => a.role === "founder_clip");
}

export function signatureShotOptions(hasPresenter: boolean): TemplateId[] {
  return TEMPLATE_IDS.filter((t) => !NOT_SIGNATURE.has(t) && (hasPresenter || !OBJECT_AWARE_SHOTS.includes(t)));
}

/** What Wonder fills in per pick (the stored CreativeDirection adds model, run and time). */
export function directionSchema(shots: TemplateId[]) {
  return z.object({
    hookApproach: z.string().trim().min(1).max(600).describe("How the first 2 seconds stop the scroll for this audience (the tension, question or reveal), in one or two sentences"),
    pacing: DirectionPacing.describe(Object.entries(PACING_NOTES).map(([k, v]) => `${k}: ${v}`).join("; ")),
    visualMotif: z.string().trim().min(1).max(600).describe("The one visual idea that runs through the whole video (e.g. 'every scene pushes closer to the search bar', 'cold blue chaos resolving to calm white')"),
    signatureShots: z
      .array(z.enum(shots as [TemplateId, ...TemplateId[]]))
      .min(1)
      .max(3)
      .describe("1-3 shot templates this video should be remembered for"),
    musicMood: z.enum(MUSIC_MOODS).describe("Original score mood"),
    avoid: z.string().trim().max(400).optional().describe("Anything this video should stay away from"),
    why: z.string().trim().min(1).max(800).describe("Why this direction serves the concept and makes the variant a clean test of the hypothesis"),
  });
}
export type WonderDirection = z.infer<ReturnType<typeof directionSchema>>;

/** The menu Wonder directs from (appended to the pick_variants input). */
export function directionMenu(shots: TemplateId[], hasPresenter: boolean): string {
  return [
    "Direct each picked video (you are the creative director; Muse Spark storyboards to your direction and HyperFrames renders it from the app's REAL screens):",
    `Pacing: ${Object.entries(PACING_NOTES).map(([k, v]) => `${k} (${v})`).join("; ")}.`,
    `Music moods (original score): ${MUSIC_MOODS.map((m) => `${m} (${MUSIC_MOOD_INFO[m].description})`).join("; ")}.`,
    `Signature shots available: ${shots.map((t) => `${t} (${SHOT_NOTES[t] ?? t})`).join("; ")}.`,
    hasPresenter ? "Presenter footage exists, so the SAM object-aware shots are available." : "No presenter footage: SAM presenter shots are not available.",
    "Make the variants look and feel different from each other, so the experiment tests the angle, not one house style. Never direct invented UI, numbers, reviews or features.",
  ].join("\n");
}

/** Error for Wonder when several picks share one look and sound (it retries), else null. */
export function directionProblem(directions: WonderDirection[]): string | null {
  if (directions.length < 2) return null;
  const looks = new Set(directions.map((d) => `${d.pacing}|${d.musicMood}`));
  if (looks.size === 1) return "Give the picked videos different directions: vary the pacing or the music mood between them.";
  return null;
}

export function toCreativeDirection(d: WonderDirection, model: string, runId: string, at: string): CreativeDirection {
  return { ...d, model, runId, directedAt: at };
}

/** One line for the Autopilot log. */
export function directionSummary(d: Pick<CreativeDirection, "pacing" | "musicMood" | "signatureShots" | "visualMotif">): string {
  return `${d.pacing}, ${MUSIC_MOOD_INFO[d.musicMood].label.toLowerCase()} score, ${d.signatureShots.join(" + ")}; motif: ${d.visualMotif}`;
}

export function directorName(model: string): string {
  return modelDisplayName(model, { short: true }) || model;
}
