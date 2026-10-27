import { AppError } from "@muselaunch/platform";
import { expiresIn, uncertainOutcome } from "./http";
import type { ClientCredentials, OAuthTokens, ProviderAdapter, PublishContext, PublishRequest, PublishResult } from "./types";

/**
 * X API v2: OAuth 2.0 Authorization Code with PKCE, chunked media upload, POST /2/tweets.
 * OAuth: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
 * Media: https://docs.x.com/x-api/media/quickstart/media-upload-chunked
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

async function xPublish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  if (req.visibility !== "public") throw new AppError("VALIDATION_FAILED", "Posts on X are public", { userMessage: "X doesn't support private or unlisted posts." });
  const { http, tokens } = ctx;
  if (ctx.state.xTweetCreateStarted && !ctx.state.xTweetId) throw uncertainOutcome("X", "create post");
  const username = tokens.extra?.username;
  if (typeof ctx.state.xTweetId === "string") return xResult(ctx.state.xTweetId, username);

  let mediaId = typeof ctx.state.xMediaId === "string" ? ctx.state.xMediaId : undefined;
  if (req.media && !ctx.state.xMediaReady) {
    if (!mediaId || !ctx.state.xFinalized) {
      const init = await http.request(`${X_API}/media/upload/initialize`, {
        op: "media initialize",
        method: "POST",
        bearer: tokens.accessToken,
        json: { media_type: req.media.mimeType, total_bytes: req.media.bytes, media_category: req.media.kind === "video" ? "tweet_video" : "tweet_image" },
        signal: ctx.signal,
      });
      mediaId = init.json<{ data?: { id?: string } }>().data?.id;
      if (!mediaId) throw new AppError("PROVIDER_ERROR", "X media initialize returned no id");
      await ctx.saveState({ xMediaId: mediaId });
      const bytes = await req.media.read();
      for (let i = 0, off = 0; off < bytes.length; i++, off += SEGMENT) {
        const fd = new FormData();
        fd.set("segment_index", String(i));
        fd.set("media", new Blob([bytes.subarray(off, off + SEGMENT)], { type: "application/octet-stream" }), "chunk");
        await http.request(`${X_API}/media/upload/${mediaId}/append`, { op: "media append", method: "POST", bearer: tokens.accessToken, body: fd, signal: ctx.signal });
      }
      await http.request(`${X_API}/media/upload/${mediaId}/finalize`, { op: "media finalize", method: "POST", bearer: tokens.accessToken, signal: ctx.signal });
      await ctx.saveState({ xFinalized: true });
    }
    let state = "succeeded";
    for (let i = 0; i < (ctx.maxPolls ?? 20); i++) {
      const st = await http.request(`${X_API}/media/upload`, { op: "media status", bearer: tokens.accessToken, query: { command: "STATUS", media_id: mediaId }, signal: ctx.signal });
      const info = st.json<{ data?: { processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } } } }>().data?.processing_info;
      state = info?.state ?? "succeeded";
      if (state === "succeeded") break;
      if (state === "failed") {
        await ctx.saveState({ xMediaId: undefined, xFinalized: undefined });
        throw new AppError("PROVIDER_ERROR", `X could not process the media: ${info?.error?.message ?? "unknown"}`);
      }
      await ctx.sleep(Math.max(1, info?.check_after_secs ?? 5) * 1000);
    }
    if (state !== "succeeded") throw new AppError("PROVIDER_UNAVAILABLE", "X is still processing the media; will check again", { retryable: true });
    await ctx.saveState({ xMediaReady: true });
  }

  await ctx.saveState({ xTweetCreateStarted: true });
  const tw = await http.request(`${X_API}/tweets`, {
    op: "create post",
    method: "POST",
    bearer: tokens.accessToken,
    json: { text: req.caption, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) },
    expect: [200, 201],
    signal: ctx.signal,
  });
  const id = tw.json<{ data?: { id?: string } }>().data?.id;
  if (!id) throw uncertainOutcome("X", "create post");
  await ctx.saveState({ xTweetId: id });
  return xResult(id, username, mediaId);
}

const xResult = (id: string, username?: string, mediaId?: string): PublishResult => ({
  remoteId: id,
  remoteUrl: username ? `https://x.com/${encodeURIComponent(username)}/status/${id}` : `https://x.com/i/web/status/${id}`,
  receipt: { tweetId: id, mediaId },
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
  accepts: { video: true, image: true, textOnly: true },
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
