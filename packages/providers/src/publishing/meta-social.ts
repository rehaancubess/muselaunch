import { AppError } from "@muselaunch/platform";
import { expiresIn, uncertainOutcome } from "./http";
import type { ProviderAdapter, PublishContext, PublishRequest, PublishResult } from "./types";

// ---------------------------------------------------------------------------
// Instagram API with Instagram Login (professional accounts)
// OAuth: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// Publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing/
// ---------------------------------------------------------------------------

export const IG_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
export const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
export const IG_GRAPH = "https://graph.instagram.com";
const IG_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

async function igPublish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  if (!req.media) throw new AppError("VALIDATION_FAILED", "Instagram posts need an image or video");
  if (req.visibility !== "public") throw new AppError("VALIDATION_FAILED", "Instagram API posts are always public", { userMessage: "Instagram doesn't support private or unlisted posts via the API." });
  if (req.media.kind === "image" && !/jpe?g$/i.test(req.media.mimeType)) throw new AppError("VALIDATION_FAILED", "Instagram API accepts JPEG images only");
  const { http, tokens, settings } = ctx;
  const v = settings.graphApiVersion;
  const igId = ctx.externalAccountId;
  const base = `${IG_GRAPH}/${v}`;
  const maxPolls = ctx.maxPolls ?? 10;
  const interval = ctx.pollIntervalMs ?? 30_000;

  let containerId = typeof ctx.state.igContainerId === "string" ? ctx.state.igContainerId : undefined;
  if (!containerId) {
    if (!req.media.publicUrl) throw new AppError("PROVIDER_NOT_CONFIGURED", "Instagram needs a publicly reachable media URL (deploy with public storage URLs)");
    const url = await req.media.publicUrl();
    const params: Record<string, string> =
      req.media.kind === "video" ? { media_type: "REELS", video_url: url, caption: req.caption, share_to_feed: "true" } : { image_url: url, caption: req.caption };
    const created = await http.request(`${base}/${igId}/media`, { op: "create media container", method: "POST", bearer: tokens.accessToken, form: params, signal: ctx.signal });
    containerId = created.json<{ id?: string }>().id;
    if (!containerId) throw new AppError("PROVIDER_ERROR", "Instagram did not return a container id");
    await ctx.saveState({ igContainerId: containerId });
  }

  // Poll container status (FINISHED | IN_PROGRESS | ERROR | EXPIRED | PUBLISHED).
  let status = "";
  for (let i = 0; i < maxPolls; i++) {
    const s = await http.request(`${base}/${containerId}`, { op: "container status", bearer: tokens.accessToken, query: { fields: "status_code,status" }, signal: ctx.signal });
    const j = s.json<{ status_code?: string; status?: string }>();
    status = j.status_code ?? "";
    if (status === "FINISHED" || status === "PUBLISHED") break;
    if (status === "ERROR" || status === "EXPIRED") {
      await ctx.saveState({ igContainerId: undefined });
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
  const pub = await http.request(`${base}/${igId}/media_publish`, { op: "media_publish", method: "POST", bearer: tokens.accessToken, form: { creation_id: containerId }, signal: ctx.signal });
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
  return { remoteId: mediaId, remoteUrl: permalink, receipt: { mediaId, containerId: ctx.state.igContainerId, permalink, timestamp }, effectiveVisibility: "public" };
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
      "Meta app with the Instagram API (Instagram Login) product. Standard Access works only for professional accounts you own/manage and have added to the app; serving other users needs Advanced Access via App Review for instagram_business_basic + instagram_business_content_publish. Media must be on a publicly reachable URL; 100 API posts per 24h per account.",
    docsUrl: "https://developers.facebook.com/docs/instagram-platform/content-publishing/",
  },
  accepts: { video: true, image: true, textOnly: false },
  oauth: {
    pkce: false,
    scopes: IG_SCOPES,
    authorizeUrl({ clientId, redirectUri, state }) {
      const u = new URL(IG_AUTHORIZE_URL);
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", IG_SCOPES.join(","));
      u.searchParams.set("state", state);
      u.searchParams.set("enable_fb_login", "false");
      return u.toString();
    },
    async exchangeCode({ code, redirectUri, creds }, http) {
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
      const res = await http.request(`${IG_GRAPH}/refresh_access_token`, { op: "token refresh", query: { grant_type: "ig_refresh_token", access_token: tokens.accessToken } });
      const j = res.json<{ access_token: string; expires_in?: number }>();
      return { ...tokens, accessToken: j.access_token, expiresAt: expiresIn(j.expires_in) };
    },
    async identity(tokens, http, settings) {
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
// Facebook Pages — Video API (resumable upload session → /{page-id}/videos)
// https://developers.facebook.com/docs/video-api/guides/publishing
// ---------------------------------------------------------------------------

const FB_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
const graph = (v: string) => `https://graph.facebook.com/${v}`;
const graphVideo = (v: string) => `https://graph-video.facebook.com/${v}`;

async function fbPublish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  if (!req.media || req.media.kind !== "video") throw new AppError("VALIDATION_FAILED", "Facebook Page publishing supports rendered videos");
  if (req.visibility !== "public") throw new AppError("VALIDATION_FAILED", "Facebook Page videos are public");
  const { http, tokens, settings, creds } = ctx;
  const v = settings.graphApiVersion;
  const pageId = ctx.externalAccountId;
  const pageToken = tokens.extra?.pageAccessToken;
  if (!pageToken) throw new AppError("PROVIDER_ERROR", "No Page access token stored; reconnect Facebook", { details: { reconnect: true } });
  if (ctx.state.fbVideoCreateStarted && !ctx.state.fbVideoId) throw uncertainOutcome("Facebook", "create page video");
  if (typeof ctx.state.fbVideoId === "string") return fbResult(pageId, ctx.state.fbVideoId);

  let handle = typeof ctx.state.fbFileHandle === "string" ? ctx.state.fbFileHandle : undefined;
  if (!handle) {
    const session = await http.request(`${graph(v)}/${creds.clientId}/uploads`, {
      op: "start upload session",
      method: "POST",
      bearer: tokens.accessToken,
      query: { file_name: req.media.filename, file_length: req.media.bytes, file_type: req.media.mimeType },
      signal: ctx.signal,
    });
    const sid = session.json<{ id?: string }>().id;
    if (!sid?.startsWith("upload:")) throw new AppError("PROVIDER_ERROR", "Facebook did not return an upload session");
    const bytes = await req.media.read();
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
  capabilities: ["publish_video"],
  env: { clientId: "FACEBOOK_APP_ID", clientSecret: "FACEBOOK_APP_SECRET" },
  review: {
    required: true,
    summary:
      "Meta app with Facebook Login for Business. pages_manage_posts / pages_read_engagement / pages_show_list need Advanced Access (App Review + business verification) for Pages you don't manage in the app; app admins/testers can use them before review.",
    docsUrl: "https://developers.facebook.com/docs/video-api/guides/publishing",
  },
  accepts: { video: true, image: false, textOnly: false },
  oauth: {
    pkce: false,
    scopes: FB_SCOPES,
    authorizeUrl({ clientId, redirectUri, state, settings }) {
      const u = new URL(`https://www.facebook.com/${settings.graphApiVersion}/dialog/oauth`);
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", FB_SCOPES.join(","));
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

