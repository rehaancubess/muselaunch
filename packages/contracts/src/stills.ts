import { z } from "zod";
import type { AspectRatio, Channel } from "./common";

/**
 * What one plan makes. A video, or stills built from the same editable scenes (one scene = one
 * slide): a single post, a carousel, a thumbnail, or a store screenshot set. Text posts have no
 * scenes at all (they are a copy pack: see `isTextDeliverable`).
 *
 *   format             doc kind   slides           frame
 *   video              video      —                the deliverable's aspect ratio
 *   post               static     1                4:5 (Instagram / Facebook feed) or 1:1
 *   carousel           carousel   3–10 (default 6)  4:5 or 1:1 (Instagram crops every slide to the first one)
 *   thumbnail          static     1                16:9 (YouTube)
 *   store_screenshots  carousel   3–10 / 3–8       9:19.5 (App Store, 1290×2796) or 9:16 (Google Play, 1080×1920)
 *
 * Limits come from the platforms: Instagram API carousels take at most 10 items (JPEG only); App
 * Store Connect takes at most 10 screenshots per localization; Google Play takes 2–8 phone
 * screenshots (4+ at 1080 px or more to be eligible for featuring).
 */
export const OutputFormat = z.enum(["video", "post", "carousel", "thumbnail", "store_screenshots"]);
export type OutputFormat = z.infer<typeof OutputFormat>;

/** Which store a screenshot set is for (decides the frame and the slide limit). */
export const StoreTarget = z.enum(["ios", "android"]);
export type StoreTarget = z.infer<typeof StoreTarget>;

/** Composition kind for a format (`CompositionDoc.kind`). */
export function docKindOf(format: OutputFormat): "video" | "static" | "carousel" {
  if (format === "video") return "video";
  return format === "post" || format === "thumbnail" ? "static" : "carousel";
}

export const isStillFormat = (format: OutputFormat | null | undefined): boolean => !!format && format !== "video";

/** Slides a format can have, and what Muse plans when nothing was asked for. */
export function slideLimits(format: OutputFormat, store?: StoreTarget | null): { min: number; max: number; default: number } {
  switch (format) {
    case "video":
      return { min: 0, max: 0, default: 0 };
    case "post":
    case "thumbnail":
      return { min: 1, max: 1, default: 1 };
    case "carousel":
      return { min: 3, max: 10, default: 6 };
    case "store_screenshots":
      return store === "android" ? { min: 3, max: 8, default: 6 } : { min: 3, max: 10, default: 6 };
  }
}

/** A slide count the format allows (the one asked for, clamped; else the default). */
export function clampSlides(format: OutputFormat, slides: number | null | undefined, store?: StoreTarget | null): number {
  const l = slideLimits(format, store);
  if (typeof slides !== "number" || !Number.isFinite(slides)) return l.default;
  return Math.max(l.min, Math.min(l.max, Math.round(slides)));
}

/** The frame a still format is made in (store sets have a fixed frame; others keep what was asked when it fits). */
export function stillAspect(format: OutputFormat, asked: AspectRatio | null | undefined, store?: StoreTarget | null): AspectRatio {
  switch (format) {
    case "video":
      return asked && asked !== "9:19.5" ? asked : "9:16";
    case "thumbnail":
      return "16:9";
    case "store_screenshots":
      return store === "android" ? "9:16" : "9:19.5";
    case "post":
    case "carousel":
      return asked === "1:1" || asked === "4:5" ? asked : "4:5";
  }
}

/**
 * Deliverable kinds → format. Video kinds (short_video, app_demo, feature_promo, launch_announcement,
 * app_trailer) → video; screenshot_graphic / static_ad → post; carousel → carousel; thumbnail →
 * thumbnail; store_screenshots → store_screenshots. Text and pack kinds (text_post, caption_pack,
 * outreach_pack, product_hunt_assets) have no scenes: `null`.
 */
export function formatOfDeliverable(kind: string | null | undefined): OutputFormat | null {
  switch (kind) {
    case "short_video":
    case "app_demo":
    case "feature_promo":
    case "launch_announcement":
    case "app_trailer":
      return "video";
    case "screenshot_graphic":
    case "static_ad":
      return "post";
    case "carousel":
      return "carousel";
    case "thumbnail":
      return "thumbnail";
    case "store_screenshots":
      return "store_screenshots";
    default:
      return null;
  }
}

/** A text-only post: Muse writes the post (a copy pack); nothing is rendered. */
export const isTextDeliverable = (kind: string | null | undefined) => kind === "text_post";

/** Channels a text-only post can go to (their APIs or a manual paste take text without media). */
export const TEXT_POST_CHANNELS = ["x", "threads", "linkedin", "reddit", "facebook"] as const satisfies readonly Channel[];

/** Longest text each of those channels takes in one post (X standard accounts: 280). */
export const TEXT_POST_LIMITS: Record<(typeof TEXT_POST_CHANNELS)[number], number> = { x: 280, threads: 500, linkedin: 3000, reddit: 5000, facebook: 5000 };

/**
 * X weighted length (twitter-text v3: most Latin = 1, CJK/emoji = 2, URLs = 23): how X counts a post
 * against its 280. Copy generation and the publishing preflight both measure with this.
 */
export function xWeightedLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, () => {
    n += 23;
    return "";
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0)!;
    n += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
  }
  return n;
}

/** Plain words for a format ("carousel" → "Carousel"). */
export const FORMAT_LABEL: Record<OutputFormat, string> = {
  video: "Video",
  post: "Post",
  carousel: "Carousel",
  thumbnail: "Thumbnail",
  store_screenshots: "Store screenshots",
};

/** "slide" for carousels and store sets, "image" for single stills (in plain words: "Slide 3", "the image"). */
export const slideNoun = (format: OutputFormat) => (format === "carousel" || format === "store_screenshots" ? "slide" : "image");
