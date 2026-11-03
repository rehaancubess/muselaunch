/**
 * The Studio for stills (posts, carousels, thumbnails, store screenshot sets: `doc.kind` "static" or
 * "carousel"). One scene of the doc is one slide, so the words change ("Slide 3", "Change slide 3
 * only", "All slides"), the preview parks on a slide instead of playing, and the suggestions are
 * about headlines, screens and backgrounds instead of pacing and music. Plain TS (tested in
 * stills.test.ts).
 */
import type { CompositionDoc, Scene } from "./types";

export const isStillDoc = (doc: Pick<CompositionDoc, "kind">) => doc.kind !== "video";

/** "slide" for stills, "scene" for videos. */
export const unitWord = (doc: Pick<CompositionDoc, "kind">) => (isStillDoc(doc) ? "slide" : "scene");

/** What the whole thing is called in "Whole video" / "All slides" / "Whole image". */
export function wholeLabel(doc: Pick<CompositionDoc, "kind" | "scenes">): string {
  if (!isStillDoc(doc)) return "Whole video";
  return doc.scenes.length > 1 ? "All slides" : "Whole image";
}

/** What the person is editing, in a word ("carousel", "screenshots", "image"). */
export function stillNoun(doc: Pick<CompositionDoc, "kind" | "aspectRatio" | "scenes">): string {
  if (!isStillDoc(doc)) return "video";
  if (doc.aspectRatio === "9:19.5" || (doc.kind === "carousel" && doc.aspectRatio === "9:16")) return "screenshots";
  return doc.scenes.length > 1 ? "carousel" : "image";
}

/**
 * Asset ids of a still render's slides, in order: the render worker saves slide 1 as `ast_r_<key>`
 * and slide n as `ast_r_<key>_<n>` (packages/render saveStills).
 */
export function slideAssetIds(firstAssetId: string, slides: number): string[] {
  return Array.from({ length: Math.max(1, slides) }, (_, i) => (i === 0 ? firstAssetId : `${firstAssetId}_${i + 1}`));
}

/** Credits the final render of stills holds (one per started 4 slides; the render route's formula). */
export const stillRenderCredits = (slides: number) => Math.max(1, Math.ceil(slides / 4));

export interface StillChip {
  key: string;
  label: string;
  /** What Muse is asked (Muse Spark AI edit). */
  instruction: string;
  /** Only these slides change (empty = all). */
  sceneIds: string[];
  hint?: string;
}

const hasDevice = (scene: Scene | undefined) => Boolean(scene?.layers.some((l) => l.type === "device" && !l.hidden));
const headlineOf = (scene: Scene | undefined) => scene?.layers.find((l) => l.type === "text" && !l.hidden && (l.role === "headline" || l.role === undefined)) as { text?: string } | undefined;

/**
 * One-tap suggestions for stills: shorter headlines, another real screen on this slide, a darker
 * background, a slide about one of the app's features (carousels with room for one more).
 * `index`: the selected slide's position (null = all slides); `features`: the app's features (About your app).
 */
export function stillChips(doc: Pick<CompositionDoc, "kind" | "scenes" | "aspectRatio">, sceneId: string | null, features: string[] = [], maxSlides = 10): StillChip[] {
  const i = sceneId ? doc.scenes.findIndex((s) => s.id === sceneId) : -1;
  const scene = i >= 0 ? doc.scenes[i] : undefined;
  const n = i + 1;
  const many = doc.scenes.length > 1;
  const out: StillChip[] = [];
  const head = headlineOf(scene);
  if (scene) out.push({ key: "headline", label: "Make the headline shorter", instruction: `Make the headline on slide ${n} shorter and punchier, keeping what it says true`, sceneIds: [scene.id], hint: head?.text ? `Now: “${head.text.slice(0, 60)}”` : undefined });
  else out.push({ key: "headlines", label: many ? "Make the headlines shorter" : "Make the headline shorter", instruction: many ? "Make every slide's headline shorter and punchier, keeping what each says true" : "Make the headline shorter and punchier, keeping what it says true", sceneIds: [] });
  if (scene && hasDevice(scene)) out.push({ key: "screen", label: "Use a different screen on this slide", instruction: `On slide ${n}, show a different real screenshot of the app in the phone (one not used on the other slides)`, sceneIds: [scene.id] });
  out.push({ key: "darker", label: "Try a darker background", instruction: scene ? `Give slide ${n} a darker background, keeping the text easy to read` : "Use a darker background on every slide, keeping the text easy to read", sceneIds: scene ? [scene.id] : [] });
  const feature = features.find(Boolean);
  if (doc.kind === "carousel" && feature && doc.scenes.length < maxSlides && stillNoun(doc) !== "screenshots")
    out.push({ key: "add", label: `Add a slide about ${feature.length > 28 ? `${feature.slice(0, 27)}…` : feature}`, instruction: `Add one slide about ${feature} before the last slide, in the same style, using a real screenshot of it`, sceneIds: [] });
  if (!scene && many) out.push({ key: "first", label: "Make the first slide stop the scroll", instruction: "Make the first slide stop the scroll: a bolder, shorter headline, keeping what it says true", sceneIds: [doc.scenes[0]!.id] });
  return out.slice(0, 4);
}
