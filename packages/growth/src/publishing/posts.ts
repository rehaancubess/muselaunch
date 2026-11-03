import { AI_VOICE_CAPTION_LINE, Channel, HttpUrl, Id, IsoDateTime, APP_LINK_TOKEN, fillAppLink, type Approval, type ConnectedAccount, type CopyPack, type MediaAsset, type PostFactCheck, type Publication, type ScheduledPost } from "@muselaunch/contracts";
import { nowIso, type WorkspaceDb } from "@muselaunch/db";
import { AppError, assertKeyInWorkspace, notifyPostsReady, trackedLinkUrl, type Platform } from "@muselaunch/platform";
import { MANUAL_ONLY_CHANNELS, providerAdapter, publishingAdapterForChannel } from "@muselaunch/providers";
import { z } from "zod";
import { assertApproved, consumeApproval, expireApprovals, postSnapshot, requestApproval } from "../approvals";
import { growthDeps } from "../deps";
import { factPreflightErrors, postFactCheck } from "./facts";
import { manualInstructions, POST_URL_HOSTS, type ManualMedia } from "./manual";
import {
  apiCountErrors,
  apiRefusal,
  compositionHasAiVoice,
  captionLength,
  CHANNEL_NAME,
  channelMediaRules,
  disclosedCaption,
  inOrder,
  MANUAL_MAX_IMAGES,
  MAX_POST_MEDIA,
  needsMedia,
  needsMediaMessage,
  offShapeSlides,
  renderMediaFor,
  shapeOfAssets,
  slideNumber,
  slideSet,
  withAiVoiceLineFor,
} from "./media";
import { xWeightedLength } from "./text";

export { xWeightedLength } from "./text";

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * POST /apps/:appId/posts. The media come from one of:
 * - `compositionId` (+ optional `compositionVersion`): its final render — the video, or every slide
 *   of a still (post, carousel, thumbnail, store set) in slide order;
 * - `assetIds`: media in posting order (up to 20);
 * - neither, with `copyPackId`: a text-only post (X, Threads, LinkedIn, Reddit, Facebook); the
 *   copy pack's channel must be the post's channel.
 * A caption (or a copy pack to take it from) is always needed.
 */
export const CreatePostRequest = z
  .object({
    campaignId: Id,
    variantId: Id.optional(),
    compositionId: Id.optional(),
    compositionVersion: z.number().int().min(1).optional(),
    assetIds: z.array(Id).max(MAX_POST_MEDIA).optional(),
    copyPackId: Id.optional(),
    channel: Channel,
    accountId: Id.optional(),
    title: z.string().max(300).optional(),
    caption: z.string().max(5000).optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    visibility: z.enum(["public", "unlisted", "private"]).default("public"),
    containsSyntheticMedia: z.boolean().optional(),
    thumbnailAssetId: Id.optional(),
    trackingLinkId: Id.optional(),
    scheduledAt: IsoDateTime.optional(),
    timezone: z.string().max(64).optional(),
    suggestedTimeReason: z.string().max(500).optional(),
  })
  .refine((v) => v.compositionId || v.assetIds?.length || v.copyPackId, { message: "Provide compositionId (rendered), assetIds, or copyPackId for a text post" });
export type CreatePostRequest = z.infer<typeof CreatePostRequest>;

export const UpdatePostRequest = z.object({
  title: z.string().max(300).nullable().optional(),
  caption: z.string().max(5000).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  containsSyntheticMedia: z.boolean().optional(),
  accountId: Id.nullable().optional(),
  /** The media in posting order (e.g. "post the first 4" of a carousel); empty makes a text post where the channel takes one. */
  assetIds: z.array(Id).max(MAX_POST_MEDIA).optional(),
  thumbnailAssetId: Id.nullable().optional(),
  trackingLinkId: Id.nullable().optional(),
  scheduledAt: IsoDateTime.nullable().optional(),
  timezone: z.string().max(64).optional(),
});

export const MarkPostedRequest = z.object({ url: HttpUrl, postedAt: IsoDateTime.optional(), note: z.string().max(500).optional() });
export const ReminderRequest = z.object({ at: IsoDateTime.nullable() });

const TERMINAL: ScheduledPost["status"][] = ["published", "manually_posted", "cancelled"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadPost(ws: WorkspaceDb, id: string, appId?: string): Promise<ScheduledPost> {
  const post = await ws.collection("scheduledPosts").getOrThrow(id);
  if (appId && post.appId !== appId) throw new AppError("NOT_FOUND", "Post not found");
  return post;
}

export function captionFromCopyPack(pack: CopyPack, channel: Channel): { title?: string; caption?: string; tags: string[] } {
  const first = (k: string) => pack.items.find((i) => i.kind === k)?.text;
  const hashtagsText = first("hashtags") ?? "";
  const tags = [...hashtagsText.matchAll(/#?([\p{L}\p{N}_]{2,})/gu)].map((m) => m[1]!).slice(0, 30);
  let caption = first("caption") ?? first("description");
  if (caption && hashtagsText && !/#\w/.test(caption) && channel !== "youtube") caption = `${caption}\n\n${hashtagsText.trim()}`;
  return { title: first("title"), caption, tags };
}

/**
 * The post's copy from a (rewritten) copy pack: caption, title, tags, with the AI-voice line added
 * again when the post's video has an external TTS voice (a rewrite would otherwise drop it).
 */
export async function captionForPack(ws: WorkspaceDb, post: ScheduledPost, pack: CopyPack): Promise<Pick<ScheduledPost, "caption" | "title" | "tags"> & { containsSyntheticMedia?: true }> {
  const derived = captionFromCopyPack(pack, post.channel);
  const { caption, aiVoice } = await disclosedCaption(ws, post, derived.caption ?? post.caption);
  return { caption, title: derived.title ?? post.title, tags: derived.tags.length ? derived.tags : post.tags, ...(aiVoice ? { containsSyntheticMedia: true as const } : {}) };
}

export interface Preflight {
  errors: string[];
  warnings: string[];
}

/** Channel rules checked before approval is requested and again before publishing. */
export async function preflight(ws: WorkspaceDb, post: ScheduledPost): Promise<Preflight> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const assets = inOrder(post.assetIds, await ws.collection("mediaAssets").getMany(post.assetIds));
  if (assets.length !== post.assetIds.length) errors.push("One or more media files are missing.");
  for (const a of assets) if (!["ready", "uploaded"].includes(a.status)) errors.push(`${a.title ?? a.originalFilename ?? a.id} is ${a.status}.`);
  const shape = shapeOfAssets(assets);
  const primary = assets[0];
  const isVideo = shape === "video";
  const images = assets.filter((a) => a.kind !== "video").length;
  const cap = post.caption;
  const api = post.mode === "api";
  const name = CHANNEL_NAME[post.channel];
  // Generated copy uses [APP_LINK] where a link belongs; it's filled from the post's tracked link.
  if ((cap.includes(APP_LINK_TOKEN) || post.title?.includes(APP_LINK_TOKEN)) && !post.trackingLinkId) {
    (api ? errors : warnings).push(`The copy still has the ${APP_LINK_TOKEN} placeholder. Add a tracked link to this post, or replace the placeholder with your link.`);
  }
  // Media: a text post only where the channel takes one; what the API can't post goes manual.
  if (!post.assetIds.length) {
    if (needsMedia(post.channel)) errors.push(`${needsMediaMessage(post.channel)} Add one, or post this text on X, Threads, LinkedIn, Reddit or Facebook.`);
    if (!cap.trim()) errors.push("A text post needs text. Write the post first.");
  }
  if (api && assets.length === post.assetIds.length) {
    const adapter = publishingAdapterForChannel(post.channel);
    if (adapter) {
      const refusal = apiRefusal(post.channel, adapter.accepts, assets);
      if (refusal) errors.push(`${refusal} Post it by hand instead.`);
      else errors.push(...apiCountErrors(post.channel, adapter.accepts, assets.length, shape));
    }
  }
  const manualMax = MANUAL_MAX_IMAGES[post.channel];
  // By hand the person can still split the slides (a thread, two posts), so this only warns.
  if (!api && shape === "carousel" && manualMax && images > manualMax) warnings.push(`${name} takes up to ${manualMax} images in one post. Keep the first ${manualMax}, or split the slides into two posts.`);
  if (shape === "carousel" && ["instagram", "threads"].includes(post.channel)) {
    const off = offShapeSlides(assets);
    if (off.length) warnings.push(`${name} crops every slide to the shape of the first one. ${off.length === 1 ? `Slide ${off[0]} has` : `Slides ${off.join(", ")} have`} a different shape and will be cropped.`);
  }
  switch (post.channel) {
    case "youtube":
      if (assets.length && !isVideo) errors.push("YouTube needs a video. YouTube's API only uploads videos; post images on YouTube by hand.");
      if (!post.title?.trim()) errors.push("YouTube needs a title.");
      if ((post.title ?? "").length > 100) errors.push("YouTube titles are limited to 100 characters.");
      if (Buffer.byteLength(cap, "utf8") > 5000) errors.push("YouTube descriptions are limited to 5,000 bytes.");
      break;
    case "instagram":
      if (cap.length > 2200) errors.push("Instagram captions are limited to 2,200 characters.");
      if ((cap.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) errors.push("Instagram allows at most 30 hashtags.");
      if (api && post.visibility !== "public") errors.push("Instagram API posts are always public.");
      break;
    case "tiktok":
      if (assets.length && shape !== "video" && shape !== "image" && shape !== "carousel") errors.push("TikTok posts are a video or photos, not both.");
      if (cap.length > 2200) errors.push("TikTok captions are limited to 2,200 characters.");
      if (post.visibility === "unlisted") errors.push("TikTok has no unlisted visibility.");
      break;
    case "x": {
      const len = xWeightedLength(cap);
      if (len > 280) (api ? errors : warnings).push(`Post is ${len}/280 characters (longer posts need X Premium).`);
      if (post.visibility !== "public") errors.push("Posts on X are public.");
      break;
    }
    case "threads":
      if (captionLength("threads", cap) > 500) errors.push("Threads posts are limited to 500 characters.");
      break;
    case "linkedin":
      if (cap.length > 3000) errors.push("LinkedIn posts are limited to 3,000 characters.");
      break;
    case "facebook":
      if (api && post.visibility !== "public") errors.push("Posts on a Facebook Page are public.");
      break;
    default:
      break;
  }
  if (assets.some((a) => a.origin === "generated") && !post.containsSyntheticMedia) warnings.push("This post includes AI-generated media; we recommend enabling the synthetic-media disclosure.");
  if (post.compositionId && !cap.toLowerCase().includes(AI_VOICE_CAPTION_LINE.toLowerCase()) && (await compositionHasAiVoice(ws, post.compositionId, post.compositionVersion)))
    warnings.push(`The voice in this video is AI-generated. Keep the line “${AI_VOICE_CAPTION_LINE}” in the caption so viewers know.`);
  if (post.thumbnailAssetId && post.channel === "youtube" && api) warnings.push("YouTube only lets verified channels set a custom thumbnail. If yours isn't verified, the video still goes up and you can add the cover in YouTube Studio.");
  if (api) {
    const acc = post.accountId ? await ws.collection("connectedAccounts").get(post.accountId) : null;
    if (!acc || acc.status !== "connected") errors.push("The selected account isn't connected. Reconnect it or switch to manual posting.");
    for (const l of acc?.limitations ?? []) warnings.push(l);
  }
  if (post.copyPackId) {
    // Generated copy may only say what the app's confirmed facts or its own listing back (plain words;
    // the post view offers the one-tap fixes: remove the words, or confirm them as a fact).
    const pack = await ws.collection("copyPacks").get(post.copyPackId);
    if (pack) errors.push(...factPreflightErrors(pack));
  }
  if (post.scheduledAt && Date.parse(post.scheduledAt) < Date.now() - 5 * 60_000 && post.status !== "published") warnings.push("The scheduled time is in the past; it will publish as soon as it's approved and started.");
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/**
 * Decide api vs manual for a channel/account, with the reason when manual. Media the channel's API
 * can't post at all (TikTok photos, YouTube images, a text post on Instagram, a video+image mix) are
 * posted by hand, with the adapter's own reason.
 */
async function resolveMode(p: Platform, ws: WorkspaceDb, channel: Channel, accountId: string | undefined, media: readonly Pick<MediaAsset, "kind" | "mimeType">[] = []): Promise<{ mode: "api" | "manual"; account?: ConnectedAccount; reason?: string }> {
  if (MANUAL_ONLY_CHANNELS.includes(channel))
    return { mode: "manual", reason: channel === "reddit" ? "Community posts are never automated." : channel === "threads" ? "MuseLaunch doesn't post to Threads through its API yet." : `${CHANNEL_NAME[channel]} has no supported posting API.` };
  const adapter = publishingAdapterForChannel(channel);
  if (!adapter) return { mode: "manual", reason: `${channel} publishing isn't supported via API.` };
  // Media this API can't take at all (shape or file format) are posted by hand; too many slides stay
  // an API post whose preflight offers "post the first N".
  const shapeReason = apiRefusal(channel, adapter.accepts, media) ?? undefined;
  if (!growthDeps(p).settings.creds[adapter.provider]) return { mode: "manual", reason: `${adapter.label} API isn't configured on this deployment (needs ${adapter.env.clientId}).` };
  if (!accountId) return { mode: "manual", reason: shapeReason ?? `No ${adapter.label} account selected.` };
  const acc = await ws.collection("connectedAccounts").get(accountId);
  if (!acc || acc.provider !== adapter.provider) throw new AppError("BAD_REQUEST", `Account ${accountId} is not a ${adapter.label} connection`);
  if (shapeReason) return { mode: "manual", account: acc, reason: shapeReason };
  if (acc.status !== "connected") return { mode: "manual", account: acc, reason: `${adapter.label} connection is ${acc.status}.` };
  if (!acc.capabilities.some((c) => c.startsWith("publish_"))) return { mode: "manual", account: acc, reason: `${adapter.label} connection can't publish.` };
  return { mode: "api", account: acc };
}

/** What the manual checklist says about the media (order of slides, text only). */
function manualMediaOf(assets: readonly Pick<MediaAsset, "kind" | "labels">[]): ManualMedia {
  const shape = shapeOfAssets(assets);
  return { shape, count: assets.length, slideNumbers: shape === "carousel" ? assets.map(slideNumber) : undefined };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createPost(p: Platform, wid: string, appId: string, input: CreatePostRequest, actor: string): Promise<{ post: ScheduledPost; preflight: Preflight }> {
  const ws = p.db.ws(wid);
  const campaign = await ws.collection("campaigns").getOrThrow(input.campaignId);
  if (campaign.appId !== appId) throw new AppError("NOT_FOUND", "Campaign not found");
  let assetIds = input.assetIds ?? [];
  let compositionVersion = input.compositionVersion;
  if (input.compositionId) {
    // The video, or every slide of a still in slide order (Instagram prefers a JPEG slide set).
    const render = await renderMediaFor(ws, appId, input.compositionId, input.compositionVersion, { preferJpeg: input.channel === "instagram" });
    compositionVersion = render.version;
    const ids = render.assets.map((a) => a.id);
    assetIds = [...ids, ...assetIds.filter((x) => !ids.includes(x))];
    if (assetIds.length > MAX_POST_MEDIA) throw new AppError("VALIDATION_FAILED", `A post takes at most ${MAX_POST_MEDIA} media`, { userMessage: `A post takes at most ${MAX_POST_MEDIA} images or videos.` });
  }
  const assets = inOrder(assetIds, await ws.collection("mediaAssets").getMany(assetIds));
  if (assets.length !== assetIds.length || assets.some((a) => a.appId && a.appId !== appId)) throw new AppError("NOT_FOUND", "Asset not found");
  if (input.thumbnailAssetId) {
    const thumb = await ws.collection("mediaAssets").getOrThrow(input.thumbnailAssetId);
    if (thumb.appId && thumb.appId !== appId) throw new AppError("NOT_FOUND", "Asset not found");
  }
  if (input.trackingLinkId) {
    const link = await ws.collection("attributionLinks").getOrThrow(input.trackingLinkId);
    if (link.appId !== appId) throw new AppError("NOT_FOUND", "Tracking link not found");
  }
  let fromPack: ReturnType<typeof captionFromCopyPack> = { tags: [] };
  if (input.copyPackId) {
    const pack = await ws.collection("copyPacks").getOrThrow(input.copyPackId);
    if (pack.appId !== appId) throw new AppError("NOT_FOUND", "Copy pack not found");
    // A text post IS its copy pack: it must be written for this channel (limits, tone).
    if (!assetIds.length && pack.channel !== input.channel) throw new AppError("BAD_REQUEST", `Copy pack is for ${pack.channel}, not ${input.channel}`, { userMessage: `This text was written for ${CHANNEL_NAME[pack.channel]}. Pick the ${CHANNEL_NAME[input.channel]} text, or write a caption.` });
    fromPack = captionFromCopyPack(pack, input.channel);
  }
  const raw = input.caption ?? fromPack.caption;
  if (raw === undefined) throw new AppError("BAD_REQUEST", "Provide a caption or a copy pack", { userMessage: "Add a caption (or pick a copy pack) for this post." });
  if (!assetIds.length && !raw.trim()) throw new AppError("BAD_REQUEST", "A text post needs text", { userMessage: "Write the post's text first." });
  if (!assetIds.length && needsMedia(input.channel)) throw new AppError("BAD_REQUEST", `${input.channel} posts need media`, { userMessage: `${needsMediaMessage(input.channel)} A text-only post can go to X, Threads, LinkedIn, Reddit or Facebook.` });
  // Viewers of a posted video never see the Studio: an external TTS voice is said in the caption, once.
  const { caption, aiVoice } = await disclosedCaption(ws, { compositionId: input.compositionId, compositionVersion, channel: input.channel }, raw);
  const mode = await resolveMode(p, ws, input.channel, input.accountId, assets);
  const post = await ws.collection("scheduledPosts").create(
    {
      appId,
      campaignId: input.campaignId,
      variantId: input.variantId,
      compositionId: input.compositionId,
      compositionVersion,
      assetIds,
      channel: input.channel,
      accountId: mode.account?.id ?? input.accountId,
      mode: mode.mode,
      title: input.title ?? fromPack.title,
      caption,
      tags: input.tags ?? fromPack.tags,
      copyPackId: input.copyPackId,
      visibility: input.visibility,
      containsSyntheticMedia: aiVoice || (input.containsSyntheticMedia ?? assets.some((a) => a.origin === "generated")),
      thumbnailAssetId: input.thumbnailAssetId,
      trackingLinkId: input.trackingLinkId,
      scheduledAt: input.scheduledAt,
      timezone: input.timezone ?? (await p.db.top("workspaces").get(wid))?.settings.defaultTimezone ?? "UTC",
      suggestedTimeReason: input.suggestedTimeReason,
      status: "draft",
      manualInstructions: mode.mode === "manual" ? manualInstructions(input.channel, mode.reason, manualMediaOf(assets)) : [],
      attempts: 0,
    },
    { actor },
  );
  return { post, preflight: await preflight(ws, post) };
}

/** Edit a post. Content changes invalidate any pending/granted approval (back to draft). */
export async function updatePost(p: Platform, wid: string, id: string, input: z.infer<typeof UpdatePostRequest>, actor: string): Promise<{ post: ScheduledPost; approvalReset: boolean; preflight: Preflight }> {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  if (TERMINAL.includes(post.status) || post.status === "publishing") throw new AppError("CONFLICT", `Post is ${post.status}`);
  const patch: Partial<ScheduledPost> = {};
  for (const [k, v] of Object.entries(input)) (patch as Record<string, unknown>)[k] = v === null ? undefined : v;
  let media = inOrder(post.assetIds, await ws.collection("mediaAssets").getMany(post.assetIds));
  if (input.assetIds) {
    const assets = inOrder(input.assetIds, await ws.collection("mediaAssets").getMany(input.assetIds));
    if (assets.length !== input.assetIds.length || assets.some((a) => a.appId && a.appId !== post.appId)) throw new AppError("NOT_FOUND", "Asset not found");
    if (!assets.length && needsMedia(post.channel)) throw new AppError("BAD_REQUEST", `${post.channel} posts need media`, { userMessage: needsMediaMessage(post.channel) });
    if (!assets.length && !(input.caption ?? post.caption).trim()) throw new AppError("BAD_REQUEST", "A text post needs text", { userMessage: "Write the post's text first." });
    media = assets;
  }
  if (input.thumbnailAssetId) {
    const thumb = await ws.collection("mediaAssets").getOrThrow(input.thumbnailAssetId);
    if (thumb.appId && thumb.appId !== post.appId) throw new AppError("NOT_FOUND", "Asset not found");
  }
  if (input.trackingLinkId) {
    const link = await ws.collection("attributionLinks").getOrThrow(input.trackingLinkId);
    if (link.appId !== post.appId) throw new AppError("NOT_FOUND", "Tracking link not found");
  }
  // A new account or new media can change what the channel's API takes (e.g. a carousel on TikTok).
  if (input.accountId !== undefined || input.assetIds) {
    const accountId = input.accountId !== undefined ? (input.accountId ?? undefined) : post.accountId;
    const mode = await resolveMode(p, ws, post.channel, accountId, media);
    patch.mode = mode.mode;
    patch.accountId = mode.account?.id ?? accountId;
    patch.manualInstructions = mode.mode === "manual" ? manualInstructions(post.channel, mode.reason, manualMediaOf(media)) : [];
  }
  const before = (await postSnapshot(ws, post)).hash;
  let next = await ws.collection("scheduledPosts").update(id, patch, { actor });
  const after = (await postSnapshot(ws, next)).hash;
  const contentChanged = before !== after;
  let approvalReset = false;
  if (contentChanged && post.approvalId) {
    approvalReset = (await expireApprovals(ws, { entity: "scheduledPosts", id }, post.appId, actor, "Post content changed")) > 0;
    next = await ws.collection("scheduledPosts").update(id, { status: "draft", approvalId: undefined, publishState: undefined, lastError: undefined }, { actor });
  }
  return { post: next, approvalReset, preflight: await preflight(ws, next) };
}

/**
 * The post now uses another final render of its own video or slides (e.g. after "Tell Muse what to
 * change" edited them). Same rule as any content change: an approval pending or granted for the old
 * render expires and the post goes back to draft, so the new version needs its own approval. A
 * still render brings all its slides, in order. The AI-voice line follows the new render's voice.
 */
export async function usePostRender(p: Platform, wid: string, id: string, input: { assetId: string; compositionVersion: number }, actor: string): Promise<{ post: ScheduledPost; approvalReset: boolean }> {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  if (TERMINAL.includes(post.status) || post.status === "publishing") throw new AppError("CONFLICT", `Post is ${post.status}`, { userMessage: "This post is already out, so its video can’t change." });
  const asset = await ws.collection("mediaAssets").getOrThrow(input.assetId);
  const ok = asset.appId === post.appId && asset.status === "ready" && asset.render?.quality === "final" && asset.render.compositionId === post.compositionId && asset.render.version === input.compositionVersion;
  if (!post.compositionId || !ok) throw new AppError("BAD_REQUEST", "Not a final render of this post's video", { userMessage: "That isn’t a finished version of this post’s video." });
  // Any slide of a still render stands for the whole set (slide 1 is `ast_r_<key>`).
  const first = asset.kind === "image" && slideNumber(asset) > 1 ? ((await ws.collection("mediaAssets").get(asset.id.replace(/_\d+$/, ""))) ?? asset) : asset;
  const rendered = asset.kind === "video" ? [asset] : await slideSet(ws, first);
  const ids = rendered.map((a) => a.id);
  // Drop the earlier render(s) of the same composition; keep anything else attached (e.g. extra images).
  const current = await ws.collection("mediaAssets").getMany(post.assetIds);
  const oldRenders = new Set(current.filter((a) => a.render?.compositionId === post.compositionId).map((a) => a.id));
  const assetIds = [...ids, ...post.assetIds.filter((x) => !ids.includes(x) && !oldRenders.has(x))].slice(0, MAX_POST_MEDIA);
  const aiVoice = await compositionHasAiVoice(ws, post.compositionId, input.compositionVersion);
  const patch: Partial<ScheduledPost> = { assetIds, compositionVersion: input.compositionVersion };
  if (aiVoice) Object.assign(patch, { caption: withAiVoiceLineFor(post.channel, post.caption), containsSyntheticMedia: true });
  const before = (await postSnapshot(ws, post)).hash;
  let next = await ws.collection("scheduledPosts").update(id, patch, { actor });
  const changed = before !== (await postSnapshot(ws, next)).hash;
  let approvalReset = false;
  if (changed && post.approvalId) {
    approvalReset = (await expireApprovals(ws, { entity: "scheduledPosts", id }, post.appId, actor, "The post's video changed")) > 0;
    next = await ws.collection("scheduledPosts").update(id, { status: "draft", approvalId: undefined, publishState: undefined, lastError: undefined }, { actor });
  }
  return { post: next, approvalReset };
}

/**
 * The post now shows a rewritten copy pack (e.g. "Tell Muse what to change" on its caption). Like
 * any content change, an approval pending or granted for the old words expires (back to draft).
 */
export async function usePostCopyPack(p: Platform, wid: string, id: string, packId: string, actor: string): Promise<{ post: ScheduledPost; approvalReset: boolean }> {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  if (TERMINAL.includes(post.status) || post.status === "publishing") throw new AppError("CONFLICT", `Post is ${post.status}`, { userMessage: "This post is already out, so its caption can’t change." });
  const pack = await ws.collection("copyPacks").getOrThrow(packId);
  if (pack.appId !== post.appId || pack.channel !== post.channel) throw new AppError("BAD_REQUEST", "Copy pack doesn't belong to this post");
  const derived = await captionForPack(ws, post, pack);
  const before = (await postSnapshot(ws, post)).hash;
  let next = await ws.collection("scheduledPosts").update(id, { copyPackId: pack.id, ...derived }, { actor });
  const changed = before !== (await postSnapshot(ws, next)).hash;
  let approvalReset = false;
  if (changed && post.approvalId) {
    approvalReset = (await expireApprovals(ws, { entity: "scheduledPosts", id }, post.appId, actor, "The post's caption changed")) > 0;
    next = await ws.collection("scheduledPosts").update(id, { status: "draft", approvalId: undefined, publishState: undefined, lastError: undefined }, { actor });
  }
  return { post: next, approvalReset };
}

/**
 * Ask for a post's publish approval. A new request also tells the people who can schedule it on
 * their linked phones ("2 posts are ready to review", at most once per app per hour); callers that
 * draft several posts in a row pass `notify: false` and call notifyPostsReady once at the end.
 */
export async function requestPostApproval(p: Platform, wid: string, id: string, actor: string, opts: { notify?: boolean } = {}): Promise<{ post: ScheduledPost; approval: Approval; preflight: Preflight }> {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  if (!["draft", "awaiting_approval", "failed", "manual_post_needed", "scheduled"].includes(post.status)) throw new AppError("CONFLICT", `Post is ${post.status}`);
  const pf = await preflight(ws, post);
  if (pf.errors.length) throw new AppError("VALIDATION_FAILED", "Post can't be approved yet", { details: { errors: pf.errors }, userMessage: pf.errors[0] });
  const { hash } = await postSnapshot(ws, post);
  const acc = post.accountId ? await ws.collection("connectedAccounts").get(post.accountId) : null;
  const where = post.mode === "api" ? `${providerAdapter(acc?.provider ?? "youtube")?.label ?? post.channel} (${acc?.displayName ?? "account"}) via API` : `${post.channel} (you post it manually)`;
  const approval = await requestApproval(ws, {
    appId: post.appId,
    action: "publish",
    subject: { entity: "scheduledPosts", id: post.id },
    hash,
    summary: `Publish to ${where}: ${(post.title ?? post.caption).slice(0, 140)}${post.scheduledAt ? ` · scheduled ${post.scheduledAt}` : ""}`,
    actor,
  });
  const updated = await ws.collection("scheduledPosts").update(post.id, { status: approval.status === "approved" ? post.status : "awaiting_approval", approvalId: approval.id }, { actor });
  if (opts.notify !== false && approval.status === "pending" && post.approvalId !== approval.id) await notifyPostsReady(p, wid, post.appId);
  return { post: updated, approval, preflight: pf };
}

/** Called after an approval decision on a post. */
export async function onPostApprovalDecided(ws: WorkspaceDb, approval: Approval, actor: string): Promise<ScheduledPost | null> {
  if (approval.subject.entity !== "scheduledPosts") return null;
  const post = await ws.collection("scheduledPosts").get(approval.subject.id);
  if (!post || post.approvalId !== approval.id || TERMINAL.includes(post.status)) return post;
  if (approval.status === "approved") return ws.collection("scheduledPosts").update(post.id, { status: post.mode === "api" ? "scheduled" : "manual_post_needed" }, { actor });
  if (approval.status === "rejected") return ws.collection("scheduledPosts").update(post.id, { status: "draft", lastError: approval.note ? `Rejected: ${approval.note}` : "Approval rejected" }, { actor });
  return post;
}

/** Explicit "publish now" (or start a scheduled one early). Requires approval + `publish` capability (checked by the route). */
export async function enqueuePublish(p: Platform, wid: string, id: string, actor: string, opts: { system?: boolean } = {}) {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  if (post.status === "published" || post.status === "manually_posted") throw new AppError("CONFLICT", "Post is already published");
  if (post.status === "publishing") throw new AppError("CONFLICT", "Post is already being published");
  if (post.mode !== "api") throw new AppError("CONFLICT", "This post is set to manual posting", { userMessage: "This channel is posted manually: download the package and use “Mark as posted”." });
  const { hash } = await postSnapshot(ws, post);
  const approval = await assertApproved(ws, { approvalId: post.approvalId, action: "publish", subject: { entity: "scheduledPosts", id: post.id }, hash });
  const attempt = post.attempts + 1;
  const job = await p.jobs.create(wid, "publish.post", { scheduledPostId: post.id, approvalId: approval.id }, { actor: opts.system ? approval.decidedBy ?? actor : actor, appId: post.appId, idempotencyKey: `publish:${post.id}:${approval.id}:a${attempt}`, maxAttempts: 4 });
  const updated = await ws.collection("scheduledPosts").update(post.id, { status: "publishing", attempts: attempt, lastError: undefined }, { actor });
  return { post: updated, job };
}

export async function switchToManual(ws: WorkspaceDb, id: string, actor: string, reason = "Switched to manual posting"): Promise<ScheduledPost> {
  const post = await loadPost(ws, id);
  if (TERMINAL.includes(post.status) || post.status === "publishing") throw new AppError("CONFLICT", `Post is ${post.status}`);
  if (post.publishState && Object.keys(post.publishState).length && post.status === "failed") {
    // A failed API attempt may have partially reached the provider; keep the state for audit but make the user check.
    reason = `${reason}. A previous API attempt didn't complete: check the channel before posting again to avoid a duplicate.`;
  }
  const approved = post.approvalId ? await ws.collection("approvals").get(post.approvalId) : null;
  // Mode is part of the approved snapshot: switching invalidates the approval.
  await expireApprovals(ws, { entity: "scheduledPosts", id }, post.appId, actor, "Switched to manual posting");
  const media = inOrder(post.assetIds, await ws.collection("mediaAssets").getMany(post.assetIds));
  return ws.collection("scheduledPosts").update(id, { mode: "manual", status: "draft", approvalId: undefined, manualInstructions: manualInstructions(post.channel, reason, manualMediaOf(media)), lastError: approved ? "Approval reset: request approval for manual posting" : undefined }, { actor });
}

export async function cancelPost(ws: WorkspaceDb, id: string, actor: string): Promise<ScheduledPost> {
  const post = await loadPost(ws, id);
  if (TERMINAL.includes(post.status)) throw new AppError("CONFLICT", `Post is ${post.status}`);
  if (post.status === "publishing") throw new AppError("CONFLICT", "Post is being published; wait for the result");
  await expireApprovals(ws, { entity: "scheduledPosts", id }, post.appId, actor, "Post cancelled");
  return ws.collection("scheduledPosts").update(id, { status: "cancelled", approvalId: undefined }, { actor });
}

/** Manual flow confirmation: the user posted it themselves and gives the live URL. Never yields `published`. */
export async function markPosted(p: Platform, wid: string, id: string, input: z.infer<typeof MarkPostedRequest>, actor: string): Promise<{ post: ScheduledPost; publication: Publication }> {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  if (post.status === "manually_posted" && post.publicationId) return { post, publication: await ws.collection("publications").getOrThrow(post.publicationId) };
  if (post.status === "published") throw new AppError("CONFLICT", "Post was already published via API");
  if (!["manual_post_needed", "failed"].includes(post.status)) throw new AppError("CONFLICT", `Post is ${post.status}; approve it for manual posting first`);
  const { hash } = await postSnapshot(ws, post);
  const approval = await assertApproved(ws, { approvalId: post.approvalId, action: "publish", subject: { entity: "scheduledPosts", id: post.id }, hash });
  const host = new URL(input.url).hostname.toLowerCase();
  const hosts = POST_URL_HOSTS[post.channel];
  if (hosts && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) throw new AppError("BAD_REQUEST", `That link isn't a ${post.channel} URL`, { userMessage: `Paste the link of the ${post.channel} post.` });
  const publishedAt = input.postedAt ?? nowIso();
  const { entity: publication } = await ws.collection("publications").createIfAbsent(
    {
      id: publicationIdFor(post.id),
      appId: post.appId,
      campaignId: post.campaignId,
      scheduledPostId: post.id,
      channel: post.channel,
      mode: "manual_confirmed",
      remoteUrl: input.url,
      publishedAt,
      confirmedBy: actor,
      receipt: { confirmation: "user", note: input.note, approvalId: approval.id },
    },
    { actor },
  );
  const updated = await ws.collection("scheduledPosts").update(post.id, { status: "manually_posted", publicationId: publication.id, lastError: undefined }, { actor });
  await consumeApproval(ws, approval.id, actor, "Manually posted");
  return { post: updated, publication };
}

export const publicationIdFor = (postId: string) => `pub_${postId.replace(/^pst_/, "")}`;

export async function setReminder(ws: WorkspaceDb, id: string, at: string | null, actor: string) {
  const post = await loadPost(ws, id);
  if (TERMINAL.includes(post.status)) throw new AppError("CONFLICT", `Post is ${post.status}`);
  return ws.collection("scheduledPosts").update(id, { reminderAt: at ?? undefined }, { actor });
}

/** Signed download links for the post media (manual flow). */
export async function manualPackage(p: Platform, wid: string, id: string) {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  const ids = [...post.assetIds, ...(post.thumbnailAssetId && !post.assetIds.includes(post.thumbnailAssetId) ? [post.thumbnailAssetId] : [])];
  const assets = inOrder(ids, await ws.collection("mediaAssets").getMany(ids));
  const media = assets.filter((a) => post.assetIds.includes(a.id));
  const carousel = shapeOfAssets(media) === "carousel";
  const downloads = [];
  for (const a of assets) {
    assertKeyInWorkspace(wid, a.storagePath);
    const ext = a.mimeType.split("/")[1]?.replace("quicktime", "mov").replace("jpeg", "jpg") ?? "bin";
    const order = post.assetIds.indexOf(a.id);
    const isThumb = order < 0;
    // Slides are numbered in posting order so the files sort the way they're uploaded.
    const filename = carousel && !isThumb ? `${post.channel}-slide-${String(order + 1).padStart(2, "0")}.${ext}` : `${post.channel}-${isThumb ? "thumbnail" : a.role}-${a.id.slice(-6)}.${ext}`;
    const signed = await p.storage.signedDownloadUrl(a.storagePath, { expiresSec: 3600, downloadName: filename });
    downloads.push({ assetId: a.id, role: a.role, kind: a.kind, mimeType: a.mimeType, bytes: a.bytes, filename, ...(isThumb ? { thumbnail: true } : { order: order + 1 }), ...signed });
  }
  let pkg: { jobId: string; status: string; assetId?: string; url?: string; expiresAt?: string; error?: string } | undefined;
  if (post.exportJobId) {
    const job = await p.jobs.get(wid, post.exportJobId);
    let assetId = post.packageAssetId;
    if (job?.status === "succeeded" && !assetId) {
      const ref = job.output?.refs.find((r) => r.entity === "mediaAssets");
      if (ref) {
        assetId = ref.id;
        await ws.collection("scheduledPosts").update(post.id, { packageAssetId: ref.id }, { actor: "system" });
      }
    }
    pkg = { jobId: post.exportJobId, status: job?.status ?? "unknown", assetId, error: job?.error?.userMessage ?? job?.error?.message };
    if (assetId) {
      const asset = await ws.collection("mediaAssets").get(assetId);
      if (asset) {
        assertKeyInWorkspace(wid, asset.storagePath);
        Object.assign(pkg, await p.storage.signedDownloadUrl(asset.storagePath, { expiresSec: 3600, downloadName: `${post.channel}-package.zip` }));
      }
    }
  }
  let trackingUrl: string | undefined;
  if (post.trackingLinkId) {
    const link = await ws.collection("attributionLinks").get(post.trackingLinkId);
    if (link) trackingUrl = trackedLinkUrl(p.cfg, link.slug);
  }
  return {
    post,
    instructions: post.manualInstructions.length ? post.manualInstructions : manualInstructions(post.channel, undefined, manualMediaOf(media)),
    copy: { title: post.title && fillAppLink(post.title, trackingUrl), caption: post.caption && fillAppLink(post.caption, trackingUrl), tags: post.tags, trackingUrl },
    downloads,
    package: pkg,
  };
}

/** Export package via module C's `package.export` job (ZIP with media + copy). */
export async function requestPackage(p: Platform, wid: string, id: string, actor: string) {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  // Without a composition the export would package the whole campaign; a text post has no files at all.
  if (!post.compositionId && !post.assetIds.length) throw new AppError("BAD_REQUEST", "A text post has no files to package", { userMessage: "This is a text post, so there are no files to download. Copy the text instead." });
  const job = await p.jobs.create(wid, "package.export", { appId: post.appId, campaignId: post.campaignId, compositionIds: post.compositionId ? [post.compositionId] : [], includeCopy: true }, { actor, appId: post.appId, idempotencyKey: `package:${post.id}:${post.compositionVersion ?? 0}:${Date.now()}` });
  const updated = await ws.collection("scheduledPosts").update(post.id, { exportJobId: job.id, packageAssetId: undefined }, { actor });
  return { post: updated, job };
}

export async function postView(p: Platform, wid: string, id: string) {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  const [approval, publication, account, pf, snap, facts] = await Promise.all([
    post.approvalId ? ws.collection("approvals").get(post.approvalId) : null,
    post.publicationId ? ws.collection("publications").get(post.publicationId) : null,
    post.accountId ? ws.collection("connectedAccounts").get(post.accountId) : null,
    preflight(ws, post),
    postSnapshot(ws, post),
    postFactCheck(ws, post),
  ]);
  const factCheck: PostFactCheck | null = facts ? { ...facts, preflightError: pf.errors.find((e) => e.startsWith(facts.message)) } : null;
  return {
    post,
    approval,
    publication,
    account: account ? { id: account.id, provider: account.provider, displayName: account.displayName, status: account.status, limitations: account.limitations } : null,
    preflight: pf,
    snapshotHash: snap.hash,
    statusLabel: statusLabel(post),
    factCheck,
    media: await postMedia(ws, post),
  };
}

/** One media of a post for previews (fetch the image/video with GET /assets/:id/url). */
export interface PostMediaItem {
  assetId: string;
  /** 1-based posting order. */
  order: number;
  kind: MediaAsset["kind"];
  mimeType: string;
  width?: number;
  height?: number;
  bytes: number;
  /** Slide number of a still render (`slide:<n>`). */
  slide?: number;
  /** Poster image of a video. */
  posterAssetId?: string;
  status: MediaAsset["status"];
}

/**
 * GET /posts/:id `media`: what the post carries, in posting order, and what its channel takes.
 * `shape` is "text" (no media), "video", "image", "carousel" or "mixed".
 */
export async function postMedia(ws: WorkspaceDb, post: ScheduledPost) {
  const assets = inOrder(post.assetIds, await ws.collection("mediaAssets").getMany(post.assetIds));
  const shape = shapeOfAssets(assets);
  const items: PostMediaItem[] = assets.map((a, i) => ({
    assetId: a.id,
    order: i + 1,
    kind: a.kind,
    mimeType: a.mimeType,
    width: a.width,
    height: a.height,
    bytes: a.bytes,
    ...(a.render && a.kind === "image" ? { slide: slideNumber(a) } : {}),
    ...(a.posterAssetId ? { posterAssetId: a.posterAssetId } : {}),
    status: a.status,
  }));
  const adapter = MANUAL_ONLY_CHANNELS.includes(post.channel) ? undefined : publishingAdapterForChannel(post.channel);
  return { shape, count: items.length, items, thumbnailAssetId: post.thumbnailAssetId, rules: channelMediaRules(post.channel, adapter?.accepts ?? null) };
}

/** Plain-language status (UI must never show "published" unless a real receipt exists). */
export function statusLabel(post: ScheduledPost): string {
  switch (post.status) {
    case "published":
      return "Published via API (receipt on file)";
    case "manually_posted":
      return "Posted manually (confirmed by you)";
    case "manual_post_needed":
      return "Ready for you to post manually";
    case "awaiting_approval":
      return "Waiting for approval";
    case "scheduled":
      return post.scheduledAt ? `Approved · publishes ${post.scheduledAt}` : "Approved · ready to publish";
    case "publishing":
      return "Publishing…";
    case "failed":
      return `Failed: ${post.lastError ?? "unknown error"}`;
    default:
      return post.status.replace(/_/g, " ");
  }
}
