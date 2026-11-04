import { AppError } from "@muselaunch/platform";
import { definitelyRefused, expiresIn, uncertainOutcome } from "./http";
import { mediaShapeOf, requestMedia, type AccountIdentity, type OAuthTokens, type ProviderAdapter, type PublishContext, type PublishMedia, type PublishRequest, type PublishResult } from "./types";

// ---------------------------------------------------------------------------
// Instagram professional accounts, two sign-in setups:
// - Unified login (every Meta app created since 2026; used when INSTAGRAM_LOGIN_CONFIG_ID is set):
//   Facebook Login for Business with a config_id → Business Integration System User token,
//   accounts from /me/assigned_instagram_accounts, everything on graph.facebook.com.
//   https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started
// - Instagram Login (older apps): instagram.com/oauth/authorize → graph.instagram.com.
//   https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// Publishing (same container → media_publish flow on either host):
//   https://developers.facebook.com/docs/instagram-platform/content-publishing/
// ---------------------------------------------------------------------------

export const IG_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
export const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
export const IG_GRAPH = "https://graph.instagram.com";
export const FB_DIALOG_URL = "https://www.facebook.com/dialog/oauth";
const IG_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];
/** What the Unified login configuration grants (the configuration, not the URL, decides). */
const IG_UNIFIED_SCOPES = ["instagram_basic", "instagram_content_publish"];
const isUnified = (tokens: { extra?: Record<string, string> }) => tokens.extra?.login === "unified";
/** Graph base for an Instagram connection: Unified login tokens only work on graph.facebook.com. */
const igBase = (tokens: { extra?: Record<string, string> }, v: string) => (isUnified(tokens) ? `https://graph.facebook.com/${v}` : `${IG_GRAPH}/${v}`);

/** Instagram API image formats (JPEG only; MPO and JPS are not supported). */
const IG_IMAGE_TYPES = ["image/jpeg"];
const isJpeg = (m: PublishMedia) => /^image\/jpe?g$/i.test(m.mimeType);
/** Instagram API carousels: 2 to 10 items (content-publishing guide). */
export const IG_CAROUSEL = { min: 2, max: 10 } as const;

async function igPublish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  const media = requestMedia(req);
  if (!media.length) throw new AppError("VALIDATION_FAILED", "Instagram posts need an image or video", { userMessage: "Instagram needs an image, a carousel or a video." });
  if (req.visibility !== "public") throw new AppError("VALIDATION_FAILED", "Instagram API posts are always public", { userMessage: "Instagram doesn't support private or unlisted posts via the API." });
  const base = igBase(ctx.tokens, ctx.settings.graphApiVersion);
  if (media.length > 1) return igCarousel(req, ctx, media, base);
  const one = media[0]!;
  if (one.kind === "image" && !isJpeg(one)) throw new AppError("VALIDATION_FAILED", "Instagram API accepts JPEG images only", { userMessage: "Instagram takes JPEG images only through its API." });
  const { http, tokens } = ctx;
  const igId = ctx.externalAccountId;

  let containerId = typeof ctx.state.igContainerId === "string" ? ctx.state.igContainerId : undefined;
  if (!containerId) {
    if (!one.publicUrl) throw new AppError("PROVIDER_NOT_CONFIGURED", "Instagram needs a publicly reachable media URL (deploy with public storage URLs)");
    const url = await one.publicUrl();
    const params: Record<string, string> = one.kind === "video" ? { media_type: "REELS", video_url: url, caption: req.caption, share_to_feed: "true" } : { image_url: url, caption: req.caption };
    const created = await http.request(`${base}/${igId}/media`, { op: "create media container", method: "POST", bearer: tokens.accessToken, form: params, signal: ctx.signal });
    containerId = created.json<{ id?: string }>().id;
    if (!containerId) throw new AppError("PROVIDER_ERROR", "Instagram did not return a container id");
    await ctx.saveState({ igContainerId: containerId });
  }
  return igFinish(ctx, base, containerId, { igContainerId: undefined });
}

/**
 * Carousel (content-publishing guide): one item container per slide (`is_carousel_item=true`), then a
 * CAROUSEL container with the children in order and the caption, then media_publish. Item and
 * carousel container ids are saved as soon as Instagram returns them, so a retry reuses them; the
 * carousel container's status (PUBLISHED) guards media_publish against posting twice.
 */
async function igCarousel(req: PublishRequest, ctx: PublishContext, items: PublishMedia[], base: string): Promise<PublishResult> {
  if (items.length > IG_CAROUSEL.max) throw new AppError("VALIDATION_FAILED", `Instagram carousels take at most ${IG_CAROUSEL.max} items through the API (got ${items.length})`, { userMessage: `Instagram takes up to ${IG_CAROUSEL.max} slides through its API.` });
  if (items.some((m) => m.kind !== "image")) throw new AppError("VALIDATION_FAILED", "Instagram carousels from MuseLaunch are images only", { userMessage: "MuseLaunch posts Instagram carousels of images only. Post a mix of video and images by hand." });
  const notJpeg = items.findIndex((m) => !isJpeg(m));
  if (notJpeg >= 0) throw new AppError("VALIDATION_FAILED", `Instagram API accepts JPEG images only (slide ${notJpeg + 1} is ${items[notJpeg]!.mimeType})`, { userMessage: "Instagram takes JPEG images only through its API." });
  const { http, tokens } = ctx;
  const igId = ctx.externalAccountId;

  let carouselId = typeof ctx.state.igCarouselId === "string" ? ctx.state.igCarouselId : undefined;
  if (!carouselId) {
    const stored = Array.isArray(ctx.state.igCarouselItemIds) ? (ctx.state.igCarouselItemIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const children = stored.length <= items.length ? stored : [];
    for (let i = children.length; i < items.length; i++) {
      const item = items[i]!;
      if (!item.publicUrl) throw new AppError("PROVIDER_NOT_CONFIGURED", "Instagram needs a publicly reachable media URL (deploy with public storage URLs)");
      const res = await http.request(`${base}/${igId}/media`, { op: `create carousel item ${i + 1}`, method: "POST", bearer: tokens.accessToken, form: { image_url: await item.publicUrl(), is_carousel_item: "true" }, signal: ctx.signal });
      const id = res.json<{ id?: string }>().id;
      if (!id) throw new AppError("PROVIDER_ERROR", `Instagram did not return a container id for slide ${i + 1}`);
      children.push(id);
      await ctx.saveState({ igCarouselItemIds: [...children] });
    }
    let created;
    try {
      created = await http.request(`${base}/${igId}/media`, { op: "create carousel container", method: "POST", bearer: tokens.accessToken, form: { media_type: "CAROUSEL", children: children.join(","), caption: req.caption }, signal: ctx.signal });
    } catch (err) {
      // Item containers expire after 24 h; a refused carousel gets fresh ones next time (they aren't posts).
      if (definitelyRefused(err)) await ctx.saveState({ igCarouselItemIds: undefined });
      throw err;
    }
    carouselId = created.json<{ id?: string }>().id;
    if (!carouselId) throw new AppError("PROVIDER_ERROR", "Instagram did not return a carousel container id");
    await ctx.saveState({ igCarouselId: carouselId });
  }
  // An expired or failed carousel container is made again from new item containers (they expire too).
  return igFinish(ctx, base, carouselId, { igCarouselId: undefined, igCarouselItemIds: undefined });
}

/** Poll a container until FINISHED, then media_publish it once (status PUBLISHED = an earlier attempt did). */
async function igFinish(ctx: PublishContext, base: string, containerId: string, resetOnFailure: Record<string, undefined>): Promise<PublishResult> {
  const { http, tokens } = ctx;
  const maxPolls = ctx.maxPolls ?? 10;
  const interval = ctx.pollIntervalMs ?? 30_000;
  // Poll container status (FINISHED | IN_PROGRESS | ERROR | EXPIRED | PUBLISHED).
  let status = "";
  for (let i = 0; i < maxPolls; i++) {
    const s = await http.request(`${base}/${containerId}`, { op: "container status", bearer: tokens.accessToken, query: { fields: "status_code,status" }, signal: ctx.signal });
    const j = s.json<{ status_code?: string; status?: string }>();
    status = j.status_code ?? "";
    if (status === "FINISHED" || status === "PUBLISHED") break;
    if (status === "ERROR" || status === "EXPIRED") {
      await ctx.saveState(resetOnFailure);
      throw new AppError("PROVIDER_ERROR", `Instagram could not process the media (${status}${j.status ? `: ${j.status}` : ""})`, { retryable: false });
    }
    await ctx.sleep(interval);
  }
  if (status === "PUBLISHED") {
    if (typeof ctx.state.igMediaId === "string") return igResult(ctx, String(ctx.state.igMediaId), base);
    throw uncertainOutcome("Instagram", "media_publish");
  }
  if (status !== "FINISHED") throw new AppError("PROVIDER_UNAVAILABLE", "Instagram is still processing the media; will check again", { retryable: true });

  await ctx.saveState({ igPublishRequestedAt: new Date().toISOString() });
  const pub = await http.request(`${base}/${ctx.externalAccountId}/media_publish`, { op: "media_publish", method: "POST", bearer: tokens.accessToken, form: { creation_id: containerId }, signal: ctx.signal });
  const mediaId = pub.json<{ id?: string }>().id;
  if (!mediaId) throw uncertainOutcome("Instagram", "media_publish");
  await ctx.saveState({ igMediaId: mediaId });
  return igResult(ctx, mediaId, base);
}

async function igResult(ctx: PublishContext, mediaId: string, base: string): Promise<PublishResult> {
  let permalink: string | undefined;
  let timestamp: string | undefined;
  try {
    const m = await ctx.http.request(`${base}/${mediaId}`, { op: "media permalink", bearer: ctx.tokens.accessToken, query: { fields: "permalink,timestamp,media_product_type" }, signal: ctx.signal });
    const j = m.json<{ permalink?: string; timestamp?: string }>();
    permalink = j.permalink;
    timestamp = j.timestamp;
  } catch {
    /* permalink is optional; the media id is the receipt */
  }
  const children = Array.isArray(ctx.state.igCarouselItemIds) ? ctx.state.igCarouselItemIds : undefined;
  return {
    remoteId: mediaId,
    remoteUrl: permalink,
    receipt: { mediaId, containerId: ctx.state.igCarouselId ?? ctx.state.igContainerId, ...(children ? { carouselItemIds: children } : {}), permalink, timestamp },
    effectiveVisibility: "public",
  };
}

export const instagramAdapter: ProviderAdapter = {
  provider: "instagram",
  label: "Instagram (professional account)",
  channels: ["instagram"],
  purposes: ["publishing"],
  capabilities: ["publish_video", "publish_image"],
  env: { clientId: "INSTAGRAM_APP_ID", clientSecret: "INSTAGRAM_APP_SECRET" },
  review: {
    required: true,
    summary:
      "Meta app with the Instagram API use case. New apps use Unified login: set FACEBOOK_APP_ID / FACEBOOK_APP_SECRET and INSTAGRAM_LOGIN_CONFIG_ID (older apps with Instagram Login use INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET). Until App Review grants Advanced Access, only professional accounts added to the app as Instagram Testers can connect. Media must be on a publicly reachable URL; 100 API posts per 24h per account.",
    docsUrl: "https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started",
  },
  accepts: {
    video: true,
    image: true,
    textOnly: false,
    carousel: { ...IG_CAROUSEL, mimeTypes: IG_IMAGE_TYPES },
    imageMimeTypes: IG_IMAGE_TYPES,
    thumbnail: false,
    manualReason: {
      text: "Instagram posts need an image or a video.",
      mixed: "MuseLaunch posts Instagram carousels of images only. Post a mix of video and images by hand.",
    },
  },
  oauth: {
    pkce: false,
    scopes: IG_SCOPES,
    authorizeUrl({ clientId, redirectUri, state, settings }) {
      if (settings.instagramLoginConfigId) {
        const u = new URL(FB_DIALOG_URL);
        u.searchParams.set("client_id", clientId);
        u.searchParams.set("config_id", settings.instagramLoginConfigId);
        u.searchParams.set("redirect_uri", redirectUri);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("override_default_response_type", "true");
        u.searchParams.set("state", state);
        return u.toString();
      }
      const u = new URL(IG_AUTHORIZE_URL);
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", IG_SCOPES.join(","));
      u.searchParams.set("state", state);
      u.searchParams.set("enable_fb_login", "false");
      return u.toString();
    },
    async exchangeCode({ code, redirectUri, creds, settings }, http) {
      if (settings.instagramLoginConfigId) {
        // Unified login: the code is redeemed with the Meta app; the result is a system-user token
        // owned by the client's business portfolio (expiry set by the configuration; ours never expires).
        const res = await http.request(`https://graph.facebook.com/${settings.graphApiVersion}/oauth/access_token`, {
          op: "token exchange",
          query: { client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, code },
        });
        const j = res.json<{ access_token?: string; expires_in?: number }>();
        if (!j.access_token) throw new AppError("PROVIDER_ERROR", "Instagram token response had no access_token");
        const unified: OAuthTokens = { accessToken: j.access_token, expiresAt: expiresIn(j.expires_in), scope: IG_UNIFIED_SCOPES, extra: { login: "unified" } };
        return unified;
      }
      const short = await http.request(IG_TOKEN_URL, {
        op: "token exchange",
        method: "POST",
        form: { client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code: code.replace(/#_$/, "") },
      });
      const sj = short.json<{ data?: { access_token: string; user_id: string | number; permissions?: string }[]; access_token?: string; user_id?: string | number; permissions?: string | string[] }>();
      const row = sj.data?.[0] ?? sj;
      if (!row.access_token) throw new AppError("PROVIDER_ERROR", "Instagram token response had no access_token");
      // Server-side exchange for a long-lived (≈60 day) token.
      const long = await http.request(`${IG_GRAPH}/access_token`, { op: "long-lived token", query: { grant_type: "ig_exchange_token", client_secret: creds.clientSecret, access_token: row.access_token } });
      const lj = long.json<{ access_token: string; expires_in?: number }>();
      const perms = Array.isArray(row.permissions) ? row.permissions : String(row.permissions ?? "").split(",").filter(Boolean);
      return { accessToken: lj.access_token, expiresAt: expiresIn(lj.expires_in), scope: perms, extra: { igUserId: String(row.user_id ?? "") } };
    },
    async refresh(tokens, _creds, http) {
      // System-user tokens aren't refreshed this way; when one stops working the account reconnects.
      if (isUnified(tokens)) return tokens;
      const res = await http.request(`${IG_GRAPH}/refresh_access_token`, { op: "token refresh", query: { grant_type: "ig_refresh_token", access_token: tokens.accessToken } });
      const j = res.json<{ access_token: string; expires_in?: number }>();
      return { ...tokens, accessToken: j.access_token, expiresAt: expiresIn(j.expires_in) };
    },
    async identity(tokens, http, settings) {
      if (isUnified(tokens)) {
        // With a system-user token /me is the business integration user, not the Instagram account.
        const base = igBase(tokens, settings.graphApiVersion);
        const res = await http.request(`${base}/me/assigned_instagram_accounts`, { op: "list Instagram accounts", bearer: tokens.accessToken, query: { fields: "id,username" } });
        const accounts = res.json<{ data?: { id: string; username?: string }[] }>().data ?? [];
        const acct = accounts[0];
        if (!acct?.id) throw new AppError("PROVIDER_ERROR", "No Instagram account was shared", { userMessage: "Pick your Instagram professional account when connecting. Until the app passes Meta's review, only accounts added as Instagram testers can connect." });
        let business = "";
        try {
          const me = await http.request(`${base}/me`, { op: "client business", bearer: tokens.accessToken, query: { fields: "client_business_id" } });
          business = me.json<{ client_business_id?: string }>().client_business_id ?? "";
        } catch {
          /* optional: only needed to manage the token later */
        }
        const limitations = accounts.length > 1 ? [`Connected @${acct.username ?? acct.id}. ${accounts.length - 1} other account(s) were shared; reconnect to choose another.`] : [];
        const found: AccountIdentity = { externalAccountId: acct.id, displayName: acct.username ? `@${acct.username}` : acct.id, extra: { username: acct.username ?? "", clientBusinessId: business }, limitations };
        return found;
      }
      const res = await http.request(`${IG_GRAPH}/${settings.graphApiVersion}/me`, { op: "me", bearer: tokens.accessToken, query: { fields: "user_id,username,account_type" } });
      const j = res.json<{ user_id?: string; id?: string; username?: string; account_type?: string }>();
      const id = String(j.user_id ?? j.id ?? tokens.extra?.igUserId ?? "");
      if (!id) throw new AppError("PROVIDER_ERROR", "Instagram did not return the account id");
      const limitations: string[] = [];
      if (!tokens.scope.includes("instagram_business_content_publish")) limitations.push("Publishing permission was not granted; posts will use the manual flow.");
      return { externalAccountId: id, displayName: j.username ? `@${j.username}` : id, extra: { username: j.username ?? "" }, limitations };
    },
  },
  publish: igPublish,
};

// ---------------------------------------------------------------------------
// Facebook Pages
// - Video API (resumable upload session → /{page-id}/videos)
//   https://developers.facebook.com/docs/video-api/guides/publishing
// - Text post: POST /{page-id}/feed {message}; one photo: POST /{page-id}/photos {url, caption}
//   https://developers.facebook.com/docs/pages-api/posts
// - Several photos: each POST /{page-id}/photos {url, published=false} (unpublished, kept ~24 h),
//   then POST /{page-id}/feed {message, attached_media[i]={"media_fbid":…}} in order
//   https://developers.facebook.com/docs/graph-api/reference/page/photos
// ---------------------------------------------------------------------------

const FB_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
const graph = (v: string) => `https://graph.facebook.com/${v}`;
const graphVideo = (v: string) => `https://graph-video.facebook.com/${v}`;
/** Page photo formats (JPEG, BMP, PNG, GIF, TIFF; ≤ 10 MB each). */
const FB_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/bmp", "image/tiff"];
/**
 * Photos in one Page post. Facebook's docs don't state a maximum for `attached_media`; 10 is
 * MuseLaunch's own limit (the longest carousel or store set it makes).
 */
export const FB_MULTI_PHOTO = { min: 2, max: 10 } as const;
const FB_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

const pageTokenOf = (ctx: PublishContext) => {
  const t = ctx.tokens.extra?.pageAccessToken;
  if (!t) throw new AppError("PROVIDER_ERROR", "No Page access token stored; reconnect Facebook", { details: { reconnect: true } });
  return t;
};

async function fbPublish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  if (req.visibility !== "public") throw new AppError("VALIDATION_FAILED", "Facebook Page posts are public", { userMessage: "Posts on a Facebook Page are public." });
  const media = requestMedia(req);
  const shape = mediaShapeOf(media);
  if (shape === "mixed") throw new AppError("VALIDATION_FAILED", "Facebook Page posts from MuseLaunch are a video, photos or text", { userMessage: "MuseLaunch posts a video, photos or text to a Page. Post a mix of video and photos by hand." });
  if (shape === "video") return fbVideo(req, ctx, media[0]!);
  if (shape === "text") return fbText(req, ctx);
  for (const [i, m] of media.entries()) {
    if (!FB_IMAGE_TYPES.includes(m.mimeType.toLowerCase())) throw new AppError("VALIDATION_FAILED", `Facebook Page photos must be JPEG, PNG, GIF, BMP or TIFF (image ${i + 1} is ${m.mimeType})`);
    if (m.bytes > FB_PHOTO_MAX_BYTES) throw new AppError("VALIDATION_FAILED", `Facebook Page photos are limited to 10 MB (image ${i + 1} is ${Math.ceil(m.bytes / 1048576)} MB)`, { userMessage: "Facebook takes photos up to 10 MB each." });
  }
  if (media.length > FB_MULTI_PHOTO.max) throw new AppError("VALIDATION_FAILED", `MuseLaunch posts at most ${FB_MULTI_PHOTO.max} photos to a Page (got ${media.length})`, { userMessage: `MuseLaunch posts up to ${FB_MULTI_PHOTO.max} photos to a Facebook Page.` });

  const { http, settings } = ctx;
  const v = settings.graphApiVersion;
  const pageId = ctx.externalAccountId;
  const pageToken = pageTokenOf(ctx);
  if (typeof ctx.state.fbPostId === "string") return fbPostResult(ctx, pageId, ctx.state.fbPostId, ctx.state.fbPhotoIds);
  if (ctx.state.fbPostCreateStarted) throw uncertainOutcome("Facebook", "create page post");

  // One photo: a published photo is the post (its response carries the post id).
  if (shape === "image") {
    const one = media[0]!;
    const url = one.publicUrl ? await one.publicUrl() : undefined;
    if (!url) throw new AppError("PROVIDER_NOT_CONFIGURED", "Facebook needs a publicly reachable photo URL (deploy with public storage URLs)");
    await ctx.saveState({ fbPostCreateStarted: true });
    const res = await guarded(ctx, "fbPostCreateStarted", () => http.request(`${graph(v)}/${pageId}/photos`, { op: "publish page photo", method: "POST", form: { access_token: pageToken, url, caption: req.caption, published: "true" }, signal: ctx.signal }));
    const j = res.json<{ id?: string; post_id?: string }>();
    if (!j.post_id && !j.id) throw uncertainOutcome("Facebook", "create page post");
    const postId = j.post_id ?? `${pageId}_${j.id}`;
    await ctx.saveState({ fbPostId: postId, fbPhotoIds: j.id ? [j.id] : undefined });
    return fbPostResult(ctx, pageId, postId, j.id ? [j.id] : undefined);
  }

  // Several photos: upload each unpublished (saved one by one), then one feed post with all of them, in order.
  const photoIds = Array.isArray(ctx.state.fbPhotoIds) ? (ctx.state.fbPhotoIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (photoIds.length > media.length) photoIds.length = 0;
  for (let i = photoIds.length; i < media.length; i++) {
    const m = media[i]!;
    const url = m.publicUrl ? await m.publicUrl() : undefined;
    if (!url) throw new AppError("PROVIDER_NOT_CONFIGURED", "Facebook needs a publicly reachable photo URL (deploy with public storage URLs)");
    const res = await http.request(`${graph(v)}/${pageId}/photos`, { op: `upload photo ${i + 1}`, method: "POST", form: { access_token: pageToken, url, published: "false" }, signal: ctx.signal });
    const id = res.json<{ id?: string }>().id;
    if (!id) throw new AppError("PROVIDER_ERROR", `Facebook returned no photo id for image ${i + 1}`);
    photoIds.push(id);
    await ctx.saveState({ fbPhotoIds: [...photoIds] });
  }
  const form: Record<string, string> = { access_token: pageToken, message: req.caption };
  photoIds.forEach((id, i) => (form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
  await ctx.saveState({ fbPostCreateStarted: true });
  // Unpublished photos are kept about 24 h: a refused post uploads them again next time (they aren't posts).
  const res = await guarded(ctx, ["fbPostCreateStarted", "fbPhotoIds"], () => http.request(`${graph(v)}/${pageId}/feed`, { op: "create page post", method: "POST", form, signal: ctx.signal }));
  const postId = res.json<{ id?: string }>().id;
  if (!postId) throw uncertainOutcome("Facebook", "create page post");
  await ctx.saveState({ fbPostId: postId });
  return fbPostResult(ctx, pageId, postId, photoIds);
}

/** Text-only Page post: POST /{page-id}/feed {message}. */
async function fbText(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  const v = ctx.settings.graphApiVersion;
  const pageId = ctx.externalAccountId;
  const pageToken = pageTokenOf(ctx);
  if (typeof ctx.state.fbPostId === "string") return fbPostResult(ctx, pageId, ctx.state.fbPostId);
  if (ctx.state.fbPostCreateStarted) throw uncertainOutcome("Facebook", "create page post");
  if (!req.caption.trim()) throw new AppError("VALIDATION_FAILED", "A text post needs text", { userMessage: "Write the post's text first." });
  await ctx.saveState({ fbPostCreateStarted: true });
  const res = await guarded(ctx, "fbPostCreateStarted", () => ctx.http.request(`${graph(v)}/${pageId}/feed`, { op: "create page post", method: "POST", form: { access_token: pageToken, message: req.caption }, signal: ctx.signal }));
  const postId = res.json<{ id?: string }>().id;
  if (!postId) throw uncertainOutcome("Facebook", "create page post");
  await ctx.saveState({ fbPostId: postId });
  return fbPostResult(ctx, pageId, postId);
}

/** Run a non-idempotent step whose "started" marker is already saved; a definite refusal clears it (nothing was posted). */
async function guarded<T>(ctx: PublishContext, keys: string | string[], step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (definitelyRefused(err)) await ctx.saveState(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, undefined])));
    throw err;
  }
}

async function fbPostResult(ctx: PublishContext, pageId: string, postId: string, photoIds?: unknown): Promise<PublishResult> {
  let permalink: string | undefined;
  try {
    const r = await ctx.http.request(`${graph(ctx.settings.graphApiVersion)}/${postId}`, { op: "post permalink", bearer: pageTokenOf(ctx), query: { fields: "permalink_url" }, signal: ctx.signal });
    permalink = r.json<{ permalink_url?: string }>().permalink_url;
  } catch {
    /* the post id is the receipt; the link is a convenience */
  }
  const [, suffix] = postId.split("_");
  const remoteUrl = permalink?.startsWith("https://") ? permalink : `https://www.facebook.com/${encodeURIComponent(pageId)}/posts/${encodeURIComponent(suffix ?? postId)}`;
  return { remoteId: postId, remoteUrl, receipt: { postId, pageId, ...(Array.isArray(photoIds) ? { photoIds } : {}), permalink }, effectiveVisibility: "public" };
}

async function fbVideo(req: PublishRequest, ctx: PublishContext, video: PublishMedia): Promise<PublishResult> {
  const { http, tokens, settings, creds } = ctx;
  const v = settings.graphApiVersion;
  const pageId = ctx.externalAccountId;
  const pageToken = pageTokenOf(ctx);
  if (ctx.state.fbVideoCreateStarted && !ctx.state.fbVideoId) throw uncertainOutcome("Facebook", "create page video");
  if (typeof ctx.state.fbVideoId === "string") return fbResult(pageId, ctx.state.fbVideoId);

  let handle = typeof ctx.state.fbFileHandle === "string" ? ctx.state.fbFileHandle : undefined;
  if (!handle) {
    const session = await http.request(`${graph(v)}/${creds.clientId}/uploads`, {
      op: "start upload session",
      method: "POST",
      bearer: tokens.accessToken,
      query: { file_name: video.filename, file_length: video.bytes, file_type: video.mimeType },
      signal: ctx.signal,
    });
    const sid = session.json<{ id?: string }>().id;
    if (!sid?.startsWith("upload:")) throw new AppError("PROVIDER_ERROR", "Facebook did not return an upload session");
    const bytes = await video.read();
    const up = await http.request(`${graph(v)}/${sid}`, { op: "upload file", method: "POST", headers: { authorization: `OAuth ${tokens.accessToken}`, file_offset: "0" }, body: bytes, signal: ctx.signal });
    handle = up.json<{ h?: string }>().h;
    if (!handle) throw new AppError("PROVIDER_ERROR", "Facebook upload returned no file handle");
    await ctx.saveState({ fbFileHandle: handle });
  }
  await ctx.saveState({ fbVideoCreateStarted: true });
  const created = await http.request(`${graphVideo(v)}/${pageId}/videos`, {
    op: "create page video",
    method: "POST",
    form: { access_token: pageToken, title: req.title?.slice(0, 255), description: req.caption, fbuploader_video_file_chunk: handle },
    signal: ctx.signal,
  });
  const id = created.json<{ id?: string }>().id;
  if (!id) throw uncertainOutcome("Facebook", "create page video");
  await ctx.saveState({ fbVideoId: id });
  return fbResult(pageId, id);
}

const fbResult = (pageId: string, id: string): PublishResult => ({
  remoteId: id,
  remoteUrl: `https://www.facebook.com/${encodeURIComponent(pageId)}/videos/${encodeURIComponent(id)}`,
  receipt: { videoId: id, pageId },
  effectiveVisibility: "public",
});

export const facebookAdapter: ProviderAdapter = {
  provider: "facebook",
  label: "Facebook Page",
  channels: ["facebook"],
  purposes: ["publishing"],
  capabilities: ["publish_video", "publish_image", "publish_text"],
  env: { clientId: "FACEBOOK_APP_ID", clientSecret: "FACEBOOK_APP_SECRET" },
  review: {
    required: true,
    summary:
      "Meta app with Facebook Login for Business. pages_manage_posts / pages_read_engagement / pages_show_list need Advanced Access (App Review + business verification) for Pages you don't manage in the app; app admins/testers can use them before review. Videos, photos (one or several) and text posts; photos must be on a publicly reachable URL.",
    docsUrl: "https://developers.facebook.com/docs/pages-api/posts",
  },
  accepts: {
    video: true,
    image: true,
    textOnly: true,
    carousel: { ...FB_MULTI_PHOTO, mimeTypes: FB_IMAGE_TYPES },
    imageMimeTypes: FB_IMAGE_TYPES,
    thumbnail: false,
    manualReason: { mixed: "MuseLaunch posts a video, photos or text to a Page. Post a mix of video and photos by hand." },
  },
  oauth: {
    pkce: false,
    scopes: FB_SCOPES,
    authorizeUrl({ clientId, redirectUri, state, settings }) {
      const u = new URL(`https://www.facebook.com/${settings.graphApiVersion}/dialog/oauth`);
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      u.searchParams.set("response_type", "code");
      // New Meta apps reject `scope` ("Invalid Scopes"); their Facebook Login for Business
      // configuration lists the permissions instead.
      if (settings.facebookLoginConfigId) u.searchParams.set("config_id", settings.facebookLoginConfigId);
      else u.searchParams.set("scope", FB_SCOPES.join(","));
      return u.toString();
    },
    async exchangeCode({ code, redirectUri, creds, settings }, http) {
      const v = settings.graphApiVersion;
      const short = await http.request(`${graph(v)}/oauth/access_token`, { op: "token exchange", query: { client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, code } });
      const sj = short.json<{ access_token: string }>();
      const long = await http.request(`${graph(v)}/oauth/access_token`, {
        op: "long-lived token",
        query: { grant_type: "fb_exchange_token", client_id: creds.clientId, client_secret: creds.clientSecret, fb_exchange_token: sj.access_token },
      });
      const lj = long.json<{ access_token: string; expires_in?: number }>();
      return { accessToken: lj.access_token, expiresAt: expiresIn(lj.expires_in), scope: FB_SCOPES };
    },
    async revoke(tokens, _creds, http, settings) {
      await http.request(`${graph(settings.graphApiVersion)}/me/permissions`, { op: "revoke", method: "DELETE", bearer: tokens.accessToken });
    },
    async identity(tokens, http, settings) {
      const res = await http.request(`${graph(settings.graphApiVersion)}/me/accounts`, { op: "list pages", bearer: tokens.accessToken, query: { fields: "id,name,access_token,tasks" } });
      const pages = res.json<{ data?: { id: string; name: string; access_token?: string; tasks?: string[] }[] }>().data ?? [];
      const page = pages.find((p) => p.access_token && (!p.tasks || p.tasks.includes("CREATE_CONTENT")));
      if (!page) throw new AppError("PROVIDER_ERROR", "No Facebook Page with content permissions was shared", { userMessage: "Select a Facebook Page you can post to when connecting." });
      const limitations = pages.length > 1 ? [`Connected Page "${page.name}". ${pages.length - 1} other Page(s) were shared; reconnect to choose another.`] : [];
      return { externalAccountId: page.id, displayName: page.name, extra: { pageAccessToken: page.access_token! }, limitations };
    },
  },
  publish: fbPublish,
};

