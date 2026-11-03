import { AppError } from "@muselaunch/platform";
import { definitelyRefused, expiresIn, uncertainOutcome } from "./http";
import { requestMedia, type ClientCredentials, type OAuthTokens, type ProviderAdapter, type PublishContext, type PublishMedia, type PublishRequest, type PublishResult } from "./types";

/**
 * X API v2: OAuth 2.0 Authorization Code with PKCE, chunked media upload, POST /2/tweets.
 * OAuth: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
 * Media: https://docs.x.com/x-api/media/quickstart/media-upload-chunked
 * Posts: https://docs.x.com/x-api/posts/create-post ("up to 4 photos, 1 animated GIF, or 1 video")
 */
export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_API = "https://api.x.com/2";
const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];
const SEGMENT = 4 * 1024 * 1024;

const basic = (c: ClientCredentials) => `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString("base64")}`;

function xTokens(j: Record<string, any>, prev?: OAuthTokens): OAuthTokens {
  if (!j.access_token) throw new AppError("PROVIDER_ERROR", "X token response had no access_token");
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? prev?.refreshToken, expiresAt: expiresIn(j.expires_in), scope: String(j.scope ?? "").split(" ").filter(Boolean), extra: prev?.extra };
}

/** "A Post may include up to 4 photos, 1 animated GIF, or 1 video" (POST /2/tweets). */
export const X_MAX_IMAGES = 4;
/** Still image formats X takes for photos (an animated GIF is its own single-media post). */
const X_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Resume-state keys for media number `i` (the first keeps the original single-media keys). */
const keysFor = (i: number) => (i === 0 ? { id: "xMediaId", finalized: "xFinalized", ready: "xMediaReady" } : { id: `xMediaId_${i + 1}`, finalized: `xFinalized_${i + 1}`, ready: `xMediaReady_${i + 1}` });

/** Chunked upload of one media (initialize → append → finalize → status), resumable per media. */
async function xUpload(media: PublishMedia, i: number, total: number, ctx: PublishContext): Promise<string> {
  const { http, tokens } = ctx;
  const k = keysFor(i);
  const label = total > 1 ? ` ${i + 1}` : "";
  let mediaId = typeof ctx.state[k.id] === "string" ? (ctx.state[k.id] as string) : undefined;
  if (mediaId && ctx.state[k.ready]) return mediaId;
  if (!mediaId || !ctx.state[k.finalized]) {
    const init = await http.request(`${X_API}/media/upload/initialize`, {
      op: `media initialize${label}`,
      method: "POST",
      bearer: tokens.accessToken,
      json: { media_type: media.mimeType, total_bytes: media.bytes, media_category: media.kind === "video" ? "tweet_video" : "tweet_image" },
      signal: ctx.signal,
    });
    mediaId = init.json<{ data?: { id?: string } }>().data?.id;
    if (!mediaId) throw new AppError("PROVIDER_ERROR", "X media initialize returned no id");
    await ctx.saveState({ [k.id]: mediaId });
    const bytes = await media.read();
    for (let n = 0, off = 0; off < bytes.length; n++, off += SEGMENT) {
      const fd = new FormData();
      fd.set("segment_index", String(n));
      fd.set("media", new Blob([bytes.subarray(off, off + SEGMENT)], { type: "application/octet-stream" }), "chunk");
      await http.request(`${X_API}/media/upload/${mediaId}/append`, { op: `media append${label}`, method: "POST", bearer: tokens.accessToken, body: fd, signal: ctx.signal });
    }
    const fin = await http.request(`${X_API}/media/upload/${mediaId}/finalize`, { op: `media finalize${label}`, method: "POST", bearer: tokens.accessToken, signal: ctx.signal });
    await ctx.saveState({ [k.finalized]: true });
    // No processing_info in FINALIZE: the media is ready (photos usually); STATUS is only for async processing.
    const processing = (fin.text ? fin.json<{ data?: { processing_info?: unknown } }>() : {}).data?.processing_info;
    if (!processing) {
      await ctx.saveState({ [k.ready]: true });
      return mediaId;
    }
  }
  let state = "succeeded";
  for (let n = 0; n < (ctx.maxPolls ?? 20); n++) {
    const st = await http.request(`${X_API}/media/upload`, { op: `media status${label}`, bearer: tokens.accessToken, query: { command: "STATUS", media_id: mediaId }, signal: ctx.signal });
    const info = st.json<{ data?: { processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } } } }>().data?.processing_info;
    state = info?.state ?? "succeeded";
    if (state === "succeeded") break;
    if (state === "failed") {
      await ctx.saveState({ [k.id]: undefined, [k.finalized]: undefined });
      throw new AppError("PROVIDER_ERROR", `X could not process the media${label}: ${info?.error?.message ?? "unknown"}`);
    }
    await ctx.sleep(Math.max(1, info?.check_after_secs ?? 5) * 1000);
  }
  if (state !== "succeeded") throw new AppError("PROVIDER_UNAVAILABLE", "X is still processing the media; will check again", { retryable: true });
  await ctx.saveState({ [k.ready]: true });
  return mediaId;
}

async function xPublish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  if (req.visibility !== "public") throw new AppError("VALIDATION_FAILED", "Posts on X are public", { userMessage: "X doesn't support private or unlisted posts." });
  const media = requestMedia(req);
  if (media.length > 1) {
    if (media.some((m) => m.kind !== "image")) throw new AppError("VALIDATION_FAILED", "An X post has up to 4 photos or 1 video, not both", { userMessage: "X takes up to 4 photos or 1 video in a post, not both." });
    if (media.length > X_MAX_IMAGES) throw new AppError("VALIDATION_FAILED", `X takes up to ${X_MAX_IMAGES} images per post (got ${media.length})`, { userMessage: `X takes up to ${X_MAX_IMAGES} images. Post the first ${X_MAX_IMAGES}, or post the carousel by hand.` });
    const bad = media.findIndex((m) => !X_IMAGE_TYPES.includes(m.mimeType.toLowerCase()));
    if (bad >= 0) throw new AppError("VALIDATION_FAILED", `X photos in a multi-image post must be JPEG, PNG or WEBP (image ${bad + 1} is ${media[bad]!.mimeType})`);
  }
  const { http, tokens } = ctx;
  if (ctx.state.xTweetCreateStarted && !ctx.state.xTweetId) throw uncertainOutcome("X", "create post");
  const username = tokens.extra?.username;
  if (typeof ctx.state.xTweetId === "string") return xResult(ctx.state.xTweetId, username, mediaIdsOf(ctx.state, media.length));

  // Uploads aren't posts: each finished media id is kept, so a retry only uploads what's missing.
  const mediaIds: string[] = [];
  for (const [i, m] of media.entries()) mediaIds.push(await xUpload(m, i, media.length, ctx));

  await ctx.saveState({ xTweetCreateStarted: true });
  let tw;
  try {
    tw = await http.request(`${X_API}/tweets`, {
      op: "create post",
      method: "POST",
      bearer: tokens.accessToken,
      json: { text: req.caption, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) },
      expect: [200, 201],
      signal: ctx.signal,
    });
  } catch (err) {
    // X answered with a definite refusal (e.g. 403 duplicate content, 400): nothing was posted.
    if (definitelyRefused(err)) await ctx.saveState({ xTweetCreateStarted: undefined });
    throw err;
  }
  const id = tw.json<{ data?: { id?: string } }>().data?.id;
  if (!id) throw uncertainOutcome("X", "create post");
  await ctx.saveState({ xTweetId: id });
  return xResult(id, username, mediaIds);
}

const mediaIdsOf = (state: Record<string, unknown>, n: number) =>
  Array.from({ length: n }, (_, i) => state[keysFor(i).id]).filter((x): x is string => typeof x === "string");

const xResult = (id: string, username?: string, mediaIds: string[] = []): PublishResult => ({
  remoteId: id,
  remoteUrl: username ? `https://x.com/${encodeURIComponent(username)}/status/${id}` : `https://x.com/i/web/status/${id}`,
  receipt: { tweetId: id, mediaId: mediaIds[0], ...(mediaIds.length > 1 ? { mediaIds } : {}) },
  effectiveVisibility: "public",
});

export const xAdapter: ProviderAdapter = {
  provider: "x",
  label: "X",
  channels: ["x"],
  purposes: ["publishing"],
  capabilities: ["publish_video", "publish_image", "publish_text"],
  env: { clientId: "X_CLIENT_ID", clientSecret: "X_CLIENT_SECRET" },
  review: {
    required: false,
    summary:
      "X developer app with OAuth 2.0 enabled (confidential client, Read and write) and this callback URL registered. Posting/media upload consume X API usage under the developer account's current paid access/pricing; no separate app review, but write access must be enabled.",
    docsUrl: "https://docs.x.com/x-api/media/quickstart/media-upload-chunked",
  },
  accepts: {
    video: true,
    image: true,
    textOnly: true,
    carousel: { min: 2, max: X_MAX_IMAGES, mimeTypes: X_IMAGE_TYPES },
    imageMimeTypes: [...X_IMAGE_TYPES, "image/gif"],
    thumbnail: false,
    manualReason: { mixed: "X takes up to 4 photos or 1 video in a post, not both." },
  },
  oauth: {
    pkce: true,
    scopes: X_SCOPES,
    authorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
      const u = new URL(X_AUTHORIZE_URL);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("scope", X_SCOPES.join(" "));
      u.searchParams.set("state", state);
      if (codeChallenge) {
        u.searchParams.set("code_challenge", codeChallenge);
        u.searchParams.set("code_challenge_method", "S256");
      }
      return u.toString();
    },
    async exchangeCode({ code, redirectUri, codeVerifier, creds }, http) {
      const res = await http.request(`${X_API}/oauth2/token`, {
        op: "token exchange",
        method: "POST",
        headers: { authorization: basic(creds) },
        form: { code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: creds.clientId },
      });
      return xTokens(res.json());
    },
    async refresh(tokens, creds, http) {
      if (!tokens.refreshToken) throw new AppError("PROVIDER_ERROR", "X connection has no refresh token", { details: { reconnect: true } });
      const res = await http.request(`${X_API}/oauth2/token`, { op: "token refresh", method: "POST", headers: { authorization: basic(creds) }, form: { refresh_token: tokens.refreshToken, grant_type: "refresh_token", client_id: creds.clientId } });
      return xTokens(res.json(), tokens);
    },
    async revoke(tokens, creds, http) {
      await http.request(`${X_API}/oauth2/revoke`, { op: "revoke", method: "POST", headers: { authorization: basic(creds) }, form: { token: tokens.refreshToken ?? tokens.accessToken, token_type_hint: tokens.refreshToken ? "refresh_token" : "access_token" } });
    },
    async identity(tokens, http) {
      const res = await http.request(`${X_API}/users/me`, { op: "users/me", bearer: tokens.accessToken });
      const u = res.json<{ data?: { id?: string; username?: string; name?: string } }>().data;
      if (!u?.id) throw new AppError("PROVIDER_ERROR", "X did not return the account id");
      return { externalAccountId: u.id, displayName: u.username ? `@${u.username}` : (u.name ?? u.id), extra: { username: u.username ?? "" } };
    },
  },
  publish: xPublish,
};
