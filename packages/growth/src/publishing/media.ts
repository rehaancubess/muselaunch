import { AI_VOICE_CAPTION_LINE, APP_LINK_TOKEN, fillAppLink, withAiVoiceLine, type Channel, type CompositionDoc, type MediaAsset, type ScheduledPost } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError } from "@muselaunch/platform";
import { acceptsShape, mediaShapeOf, type AdapterAccepts, type MediaShape } from "@muselaunch/providers";
import { xWeightedLength } from "./text";

/**
 * What a post carries (one video, one image, a carousel's slides, or nothing for a text post) and
 * the channel rules about it, in plain words. Shared by post creation, preflight, the publish job
 * and the manual checklist.
 */

/** Most media one post holds (ScheduledPost.assetIds). */
export const MAX_POST_MEDIA = 20;

/** Plain channel names for messages. */
export const CHANNEL_NAME: Record<Channel, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  x: "X",
  threads: "Threads",
  reddit: "Reddit",
  producthunt: "Product Hunt",
  hackernews: "Hacker News",
  newsletter: "Your newsletter",
  website: "Your website",
  app_store: "The App Store",
  google_play: "Google Play",
  other: "This channel",
};

/** Channels where a post must have media (a text-only post can't go there, by API or by hand). */
const NEEDS_MEDIA: Partial<Record<Channel, string>> = {
  instagram: "Instagram needs an image, a carousel or a video.",
  tiktok: "TikTok needs a video or photos.",
  youtube: "YouTube needs a video.",
  app_store: "App Store screenshots need images.",
  google_play: "Google Play screenshots need images.",
};

export const needsMedia = (channel: Channel) => channel in NEEDS_MEDIA;
export const needsMediaMessage = (channel: Channel) => NEEDS_MEDIA[channel] ?? `${CHANNEL_NAME[channel]} needs media.`;

/** Longest caption each channel takes (X standard accounts: 280 weighted; YouTube: 5,000 bytes). */
export const CAPTION_LIMIT: Partial<Record<Channel, number>> = { x: 280, threads: 500, linkedin: 3000, instagram: 2200, tiktok: 2200, youtube: 5000, facebook: 5000, reddit: 5000 };
const CAPTION_MAX = 5000;

/** Most images a person can put in one post by hand (only where the platform states a limit). */
export const MANUAL_MAX_IMAGES: Partial<Record<Channel, number>> = { x: 4, instagram: 20, linkedin: 20, threads: 20, app_store: 10, google_play: 8 };

/** The assets in the post's order (a repository's getMany doesn't promise it). */
export function inOrder<T extends { id: string }>(ids: readonly string[], items: readonly T[]): T[] {
  const byId = new Map(items.map((x) => [x.id, x]));
  return ids.map((id) => byId.get(id)).filter((x): x is T => Boolean(x));
}

export function shapeOfAssets(assets: readonly Pick<MediaAsset, "kind">[]): MediaShape {
  return mediaShapeOf(assets.map((a) => ({ kind: a.kind === "video" ? "video" : "image" })));
}

/** Slide number of a still render (`slide:<n>` label; 1 when unlabelled). */
export function slideNumber(a: Pick<MediaAsset, "labels">): number {
  const m = a.labels.map((l) => /^slide:(\d+)$/.exec(l)).find(Boolean);
  return m ? Number(m[1]) : 1;
}

const FORMAT_NAME: Record<string, string> = { "image/jpeg": "JPEG", "image/jpg": "JPEG", "image/png": "PNG", "image/gif": "GIF", "image/webp": "WEBP", "image/bmp": "BMP", "image/tiff": "TIFF" };
export const formatName = (mime: string) => FORMAT_NAME[mime.toLowerCase()] ?? mime.split("/")[1]?.toUpperCase() ?? mime;

function listFormats(mimes: readonly string[]): string {
  const names = [...new Set(mimes.map(formatName))];
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** "Slide 2", "Slides 2 and 5", "Slides 1, 3 and 4". */
export function slidesPhrase(numbers: number[], noun = "Slide"): string {
  if (numbers.length === 1) return `${noun} ${numbers[0]}`;
  return `${noun}s ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

// ---------------------------------------------------------------------------
// Final renders → the post's media
// ---------------------------------------------------------------------------

export interface RenderMedia {
  version: number;
  /** The rendered doc kind: a video, or stills (one image per slide). */
  kind: CompositionDoc["kind"];
  /** The video, or every slide in order. */
  assets: MediaAsset[];
}

const isFinalOf = (a: MediaAsset, appId: string, compositionId: string, version?: number) =>
  a.appId === appId && a.status === "ready" && a.render?.compositionId === compositionId && a.render.quality === "final" && (version === undefined || a.render.version === version);

/**
 * All slides of a still render, in order: slide 1 is `ast_r_<key>`, slide n is `ast_r_<key>_<n>`
 * (render worker `saveStills`). Stops at the first missing slide.
 */
export async function slideSet(ws: WorkspaceDb, first: MediaAsset): Promise<MediaAsset[]> {
  const ids = Array.from({ length: 29 }, (_, i) => `${first.id}_${i + 2}`);
  const found = inOrder(ids, await ws.collection("mediaAssets").getMany(ids));
  const out = [first];
  for (const [i, id] of ids.entries()) {
    const a = found.find((x) => x.id === id);
    if (!a || !a.render || a.render.compositionId !== first.render?.compositionId || a.render.version !== first.render.version || a.render.quality !== first.render.quality) break;
    if (slideNumber(a) !== i + 2) break;
    out.push(a);
  }
  return out;
}

/**
 * The final render of a composition for a post: the newest final render (or the exact version
 * asked for). A video doc gives its video; a still doc (post, carousel, thumbnail, store set) gives
 * every slide in order. `preferJpeg` picks a JPEG slide set when that version has one (Instagram).
 */
export async function renderMediaFor(ws: WorkspaceDb, appId: string, compositionId: string, version?: number, opts: { preferJpeg?: boolean } = {}): Promise<RenderMedia> {
  const comp = await ws.collection("compositions").getOrThrow(compositionId);
  if (comp.appId !== appId) throw new AppError("NOT_FOUND", "Composition not found");
  const finals = (await ws.collection("mediaAssets").list({ where: [["appId", "==", appId], ["role", "==", "render"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((a) => isFinalOf(a, appId, compositionId, version));
  // The composition points at its newest render too (older renders can fall outside the listing).
  if (comp.lastRender?.quality === "final" && comp.lastRender.assetId && !finals.some((a) => a.id === comp.lastRender!.assetId)) {
    const last = await ws.collection("mediaAssets").get(comp.lastRender.assetId);
    if (last && isFinalOf(last, appId, compositionId, version)) finals.push(last);
  }
  const still = comp.kind !== "video";
  if (!finals.length) {
    const what = still ? "slides" : "video";
    throw new AppError("CONFLICT", `No final render${version ? ` of version ${version}` : ""} for this composition`, { userMessage: `Finish the ${what} first (final render), then schedule ${still ? "them" : "it"}.` });
  }
  const v = version ?? Math.max(...finals.map((a) => a.render!.version));
  const ofV = finals.filter((a) => a.render!.version === v).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const ver = await ws.collection("compositionVersions").get(`${compositionId}_v${v}`);
  const kind = ver?.doc.kind ?? comp.kind;

  if (kind === "video") {
    const hit = ofV.find((a) => a.kind === "video") ?? ofV[0]!;
    return { version: v, kind, assets: [hit] };
  }
  // Slide 1 of each still render of this version (from a later slide when slide 1 isn't listed).
  const firsts = new Map<string, MediaAsset>();
  for (const a of ofV.filter((x) => x.kind === "image")) {
    if (slideNumber(a) === 1) firsts.set(a.id, a);
  }
  for (const a of ofV.filter((x) => x.kind === "image" && slideNumber(x) > 1)) {
    const base = a.id.replace(/_\d+$/, "");
    if (firsts.has(base)) continue;
    const b = await ws.collection("mediaAssets").get(base);
    if (b && isFinalOf(b, appId, compositionId, v)) firsts.set(b.id, b);
  }
  const ranked = [...firsts.values()].sort((a, b) => {
    if (opts.preferJpeg) {
      const ja = /jpe?g$/i.test(a.mimeType) ? 0 : 1;
      const jb = /jpe?g$/i.test(b.mimeType) ? 0 : 1;
      if (ja !== jb) return ja - jb;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
  const first = ranked[0];
  if (!first) throw new AppError("CONFLICT", `No final slides of version ${v}`, { userMessage: "Finish the slides first (final render), then schedule them." });
  const assets = await slideSet(ws, first);
  if (assets.length > MAX_POST_MEDIA) throw new AppError("VALIDATION_FAILED", `This render has ${assets.length} slides; a post takes at most ${MAX_POST_MEDIA}`, { userMessage: `A post takes at most ${MAX_POST_MEDIA} slides. Remove some slides, then finish them again.` });
  return { version: v, kind, assets };
}

// ---------------------------------------------------------------------------
// AI voice disclosure
// ---------------------------------------------------------------------------

/**
 * Whether a rendered version speaks with an external TTS voice. The version's own audio decides:
 * a voiceover track labelled `external_tts` (or whose asset is the TTS output). The storyboard's
 * voiceover source "tts" counts only when the version has a voiceover track that isn't the
 * founder's own recording (a storyboard that planned a voice the video doesn't have isn't disclosed).
 */
export async function compositionHasAiVoice(ws: WorkspaceDb, compositionId: string | undefined, version: number | undefined): Promise<boolean> {
  if (!compositionId) return false;
  const comp = await ws.collection("compositions").get(compositionId);
  const v = version ?? comp?.currentVersion;
  if (!comp || !v) return false;
  const ver = await ws.collection("compositionVersions").get(`${compositionId}_v${v}`);
  const voice = (ver?.doc.audio ?? []).filter((t) => t.kind === "voiceover");
  if (!voice.length) return false;
  if (voice.some((t) => t.sourceLabel === "external_tts")) return true;
  const assets = await ws.collection("mediaAssets").getMany(voice.map((t) => t.assetId));
  if (assets.some((a) => a.sourceLabel === "external_tts" || a.role === "tts" || a.labels.includes("ai_voice"))) return true;
  if (!comp.storyboardId) return false;
  const sb = await ws.collection("storyboards").get(comp.storyboardId);
  return sb?.voiceover.source === "tts" && voice.some((t) => t.sourceLabel !== "founder_recording" && t.sourceLabel !== "user_upload");
}

/** Stand-in for a tracked link when measuring X length ([APP_LINK] becomes a URL; X counts any URL as 23). */
const LINK_STANDIN = "https://muselaunch.link/r/xxxxxxxx";

/** How a channel measures caption length. */
export function captionLength(channel: Channel, text: string): number {
  if (channel === "x") return xWeightedLength(fillAppLink(text, LINK_STANDIN));
  if (channel === "youtube") return Buffer.byteLength(text, "utf8");
  return text.length;
}

/**
 * The caption with the AI-voice line added once, within the channel's limit as the channel counts
 * it (X weighted characters, YouTube bytes). The line wins over the caption's tail; a link
 * placeholder cut in half is dropped rather than left broken.
 */
export function withAiVoiceLineFor(channel: Channel, caption: string): string {
  const limit = Math.min(CAPTION_LIMIT[channel] ?? CAPTION_MAX, CAPTION_MAX);
  let max = limit;
  let out = withAiVoiceLine(caption, max);
  for (let i = 0; i < 50 && captionLength(channel, out) > limit && max > AI_VOICE_CAPTION_LINE.length + 3; i++) {
    max -= Math.max(1, captionLength(channel, out) - limit);
    out = withAiVoiceLine(caption, max);
  }
  if (caption.includes(APP_LINK_TOKEN) && !out.includes(APP_LINK_TOKEN)) out = out.replace(/\s*\[[A-Z_]*…/, "…");
  return out;
}

/** Caption for a post, with the AI-voice line when its video has an external TTS voice. */
export async function disclosedCaption(ws: WorkspaceDb, post: Pick<ScheduledPost, "compositionId" | "compositionVersion" | "channel">, caption: string): Promise<{ caption: string; aiVoice: boolean }> {
  const aiVoice = await compositionHasAiVoice(ws, post.compositionId, post.compositionVersion);
  return { caption: aiVoice ? withAiVoiceLineFor(post.channel, caption) : caption, aiVoice };
}

// ---------------------------------------------------------------------------
// API media rules (what the channel's adapter takes)
// ---------------------------------------------------------------------------

/**
 * Why an adapter can't post these media at all (shape or format), or null when it can try. Counts
 * aren't checked here: a carousel that is too long stays an API post with a preflight error that
 * offers "post the first N" or posting by hand.
 */
export function apiRefusal(channel: Channel, accepts: AdapterAccepts, assets: readonly Pick<MediaAsset, "kind" | "mimeType">[]): string | null {
  const shape = shapeOfAssets(assets);
  const name = CHANNEL_NAME[channel];
  if (!acceptsShape(accepts, shape)) return accepts.manualReason?.[shape] ?? `${name} can't post this through its API.`;
  if (shape === "image" || shape === "carousel") {
    const allowed = shape === "carousel" ? (accepts.carousel?.mimeTypes ?? []) : accepts.imageMimeTypes;
    const bad = assets.map((a, i) => ({ n: i + 1, mime: a.mimeType.toLowerCase() })).filter((x) => !allowed.includes(x.mime));
    if (bad.length) {
      const formats = [...new Set(bad.map((b) => formatName(b.mime)))].join(" and ");
      const which = assets.length === 1 ? "This image is" : bad.length === assets.length ? (assets.length === 2 ? "Both slides are" : `All ${assets.length} slides are`) : `${slidesPhrase(bad.map((b) => b.n))} ${bad.length === 1 ? "is" : "are"}`;
      return `${name} takes ${listFormats(allowed)} images only through its API. ${which} ${formats}.`;
    }
  }
  return null;
}

/** Count limits of the adapter for these media (errors in plain words, with what to do). */
export function apiCountErrors(channel: Channel, accepts: AdapterAccepts, count: number, shape: MediaShape): string[] {
  if (shape !== "carousel" || !accepts.carousel) return [];
  const { min, max } = accepts.carousel;
  const name = CHANNEL_NAME[channel];
  if (count > max) return [`${name} takes up to ${max} images. Post the first ${max}, or post the carousel by hand.`];
  if (count < min) return [`${name} needs at least ${min} images in a multi-image post.`];
  return [];
}

/** Slides whose shape differs from the first one (Instagram crops every slide to the first). */
export function offShapeSlides(assets: readonly Pick<MediaAsset, "width" | "height">[]): number[] {
  const ratio = (a: Pick<MediaAsset, "width" | "height">) => (a.width && a.height ? a.width / a.height : undefined);
  const first = assets[0] ? ratio(assets[0]) : undefined;
  if (!first) return [];
  return assets.map((a, i) => ({ n: i + 1, r: ratio(a) })).filter((x) => x.r !== undefined && Math.abs(x.r / first - 1) > 0.01).map((x) => x.n);
}

/** What a channel takes, for the post view (plain words the web can show as is). */
export function channelMediaRules(channel: Channel, accepts: AdapterAccepts | null) {
  const manualMax = MANUAL_MAX_IMAGES[channel] ?? null;
  const api = accepts
    ? {
        video: accepts.video,
        image: accepts.image,
        textOnly: accepts.textOnly,
        carousel: accepts.carousel,
        imageFormats: [...new Set(accepts.imageMimeTypes.map(formatName))],
        thumbnail: accepts.thumbnail,
        manualReason: accepts.manualReason ?? {},
      }
    : null;
  return { channel, needsMedia: needsMedia(channel), captionLimit: CAPTION_LIMIT[channel] ?? null, manualMaxImages: manualMax, api };
}
