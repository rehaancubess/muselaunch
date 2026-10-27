import { AppError } from "@muselaunch/platform";
import { expiresIn } from "./http";
import type { OAuthTokens, ProviderAdapter, PublishContext, PublishRequest, PublishResult } from "./types";

/**
 * TikTok Content Posting API — Direct Post (FILE_UPLOAD).
 * Init:   https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 * Upload: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 * Status: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 * OAuth:  https://developers.tiktok.com/doc/oauth-user-access-token-management
 *
 * Unaudited clients may only post privately (SELF_ONLY); we never claim a public post in that case.
 */
export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_API = "https://open.tiktokapis.com/v2";
const TT_SCOPES = ["user.info.basic", "video.publish"];

type TtEnvelope<T> = { data?: T; error?: { code?: string; message?: string; log_id?: string } };

function ttCheck<T>(j: TtEnvelope<T>, op: string): T {
  if (j.error && j.error.code && j.error.code !== "ok") {
    const retryable = j.error.code === "rate_limit_exceeded" || j.error.code === "internal_error";
    throw new AppError(retryable ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR", `TikTok ${op}: ${j.error.code} ${j.error.message ?? ""}`.trim(), { retryable, details: { provider: "tiktok", code: j.error.code, logId: j.error.log_id } });
  }
  if (!j.data) throw new AppError("PROVIDER_ERROR", `TikTok ${op}: empty response`);
  return j.data;
}

/** Chunk plan per the media transfer guide: ≤64 MB single chunk; otherwise 10 MB chunks with the remainder merged into the last. */
export function tiktokChunks(size: number): { chunkSize: number; count: number; ranges: [number, number][] } {
  if (size <= 64 * 1024 * 1024) return { chunkSize: size, count: 1, ranges: [[0, size - 1]] };
  const chunkSize = 10_000_000;
  const count = Math.floor(size / chunkSize);
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) ranges.push([i * chunkSize, i === count - 1 ? size - 1 : (i + 1) * chunkSize - 1]);
  return { chunkSize, count, ranges };
}

function ttTokens(j: Record<string, any>): OAuthTokens {
  if (!j.access_token) throw new AppError("PROVIDER_ERROR", `TikTok token response: ${j.error ?? "no access_token"} ${j.error_description ?? ""}`.trim());
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: expiresIn(j.expires_in),
    refreshExpiresAt: expiresIn(j.refresh_expires_in),
    scope: String(j.scope ?? "").split(",").filter(Boolean),
    extra: { openId: String(j.open_id ?? "") },
  };
}

async function ttPublish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  if (!req.media || req.media.kind !== "video") throw new AppError("VALIDATION_FAILED", "TikTok publishing needs a rendered video");
  const { http, tokens, settings } = ctx;
  const headers = { "content-type": "application/json; charset=UTF-8" };
  const notes: string[] = [];
  let publishId = typeof ctx.state.tiktokPublishId === "string" ? ctx.state.tiktokPublishId : undefined;
  let privacy = typeof ctx.state.tiktokPrivacy === "string" ? ctx.state.tiktokPrivacy : undefined;
  let username = typeof ctx.state.tiktokUsername === "string" ? ctx.state.tiktokUsername : undefined;

  if (!publishId) {
    const ci = ttCheck(
      (await http.request(`${TIKTOK_API}/post/publish/creator_info/query/`, { op: "creator_info", method: "POST", bearer: tokens.accessToken, headers, json: {}, signal: ctx.signal })).json<
        TtEnvelope<{ creator_username?: string; privacy_level_options?: string[]; max_video_post_duration_sec?: number }>
      >(),
      "creator_info",
    );
    username = ci.creator_username;
    const options = ci.privacy_level_options ?? [];
    if (req.visibility === "unlisted") throw new AppError("VALIDATION_FAILED", "TikTok has no unlisted visibility", { userMessage: "Choose public or private for TikTok." });
    if (!settings.tiktokAudited || req.visibility === "private") {
      privacy = "SELF_ONLY";
      if (!settings.tiktokAudited && req.visibility === "public") notes.push("TikTok app not yet audited: TikTok only allows private (Only me) posts. Change visibility in the TikTok app after it's posted.");
    } else privacy = "PUBLIC_TO_EVERYONE";
    if (options.length && !options.includes(privacy)) throw new AppError("PROVIDER_ERROR", `TikTok account does not allow privacy level ${privacy} (allowed: ${options.join(", ")})`);

    const plan = tiktokChunks(req.media.bytes);
    const init = ttCheck(
      (
        await http.request(`${TIKTOK_API}/post/publish/video/init/`, {
          op: "video init",
          method: "POST",
          bearer: tokens.accessToken,
          headers,
          json: {
            post_info: { title: req.caption.slice(0, 2200), privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false, is_aigc: req.containsSyntheticMedia },
            source_info: { source: "FILE_UPLOAD", video_size: req.media.bytes, chunk_size: plan.chunkSize, total_chunk_count: plan.count },
          },
          signal: ctx.signal,
        })
      ).json<TtEnvelope<{ publish_id?: string; upload_url?: string }>>(),
      "video init",
    );
    if (!init.publish_id || !init.upload_url) throw new AppError("PROVIDER_ERROR", "TikTok init returned no publish_id/upload_url");
    publishId = init.publish_id;
    await ctx.saveState({ tiktokPublishId: publishId, tiktokUploadUrl: init.upload_url, tiktokPrivacy: privacy, tiktokUsername: username, tiktokUploaded: false });
    ctx.state.tiktokUploadUrl = init.upload_url;
  }

  if (!ctx.state.tiktokUploaded) {
    const uploadUrl = String(ctx.state.tiktokUploadUrl ?? "");
    if (!uploadUrl) throw new AppError("PROVIDER_ERROR", "TikTok upload URL missing from resume state");
    const bytes = await req.media.read();
    const plan = tiktokChunks(bytes.length);
    for (const [first, last] of plan.ranges) {
      await http.request(uploadUrl, {
        op: "upload chunk",
        method: "PUT",
        headers: { "content-type": req.media.mimeType, "content-range": `bytes ${first}-${last}/${bytes.length}` },
        body: bytes.subarray(first, last + 1),
        expect: [200, 201, 206],
        signal: ctx.signal,
      });
    }
    await ctx.saveState({ tiktokUploaded: true });
  }

  const maxPolls = ctx.maxPolls ?? 20;
  for (let i = 0; i < maxPolls; i++) {
    const st = ttCheck(
      (await http.request(`${TIKTOK_API}/post/publish/status/fetch/`, { op: "status fetch", method: "POST", bearer: tokens.accessToken, headers, json: { publish_id: publishId }, signal: ctx.signal })).json<
        TtEnvelope<{ status?: string; fail_reason?: string; publicaly_available_post_id?: (number | string)[] }>
      >(),
      "status fetch",
    );
    if (st.status === "PUBLISH_COMPLETE") {
      const postId = st.publicaly_available_post_id?.[0] !== undefined ? String(st.publicaly_available_post_id[0]) : undefined;
      return {
        remoteId: postId ?? publishId!,
        remoteUrl: postId && username ? `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${postId}` : undefined,
        receipt: { publishId, status: st.status, postId, privacyLevel: privacy },
        effectiveVisibility: privacy === "SELF_ONLY" ? "private" : "public",
        notes: [...notes, ...(postId ? [] : ["TikTok reports the post as complete; a public link appears once it's public and has passed moderation."])],
      };
    }
    if (st.status === "FAILED") {
      await ctx.saveState({ tiktokPublishId: undefined, tiktokUploadUrl: undefined, tiktokUploaded: undefined });
      throw new AppError("PROVIDER_ERROR", `TikTok rejected the video: ${st.fail_reason ?? "unknown reason"}`, { retryable: false, details: { failReason: st.fail_reason } });
    }
    await ctx.sleep(ctx.pollIntervalMs ?? 10_000);
  }
  throw new AppError("PROVIDER_UNAVAILABLE", "TikTok is still processing the upload; will check again", { retryable: true });
}

export const tiktokAdapter: ProviderAdapter = {
  provider: "tiktok",
  label: "TikTok",
  channels: ["tiktok"],
  purposes: ["publishing"],
  capabilities: ["publish_video"],
  env: { clientId: "TIKTOK_CLIENT_KEY", clientSecret: "TIKTOK_CLIENT_SECRET" },
  review: {
    required: true,
    summary:
      "TikTok developer app with Login Kit + Content Posting API (Direct Post) and the video.publish scope approved. Until the client passes TikTok's audit, posts are restricted to private (SELF_ONLY) and only to private accounts; set TIKTOK_AUDITED=true after the audit. TikTok's UX guidelines require showing the creator's nickname, privacy choice and consent before posting.",
    docsUrl: "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
  },
  accepts: { video: true, image: false, textOnly: false },
  oauth: {
    pkce: false,
    scopes: TT_SCOPES,
    authorizeUrl({ clientId, redirectUri, state }) {
      const u = new URL(TIKTOK_AUTHORIZE_URL);
      u.searchParams.set("client_key", clientId);
      u.searchParams.set("scope", TT_SCOPES.join(","));
      u.searchParams.set("response_type", "code");
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      return u.toString();
    },
    async exchangeCode({ code, redirectUri, creds }, http) {
      const res = await http.request(`${TIKTOK_API}/oauth/token/`, {
        op: "token exchange",
        method: "POST",
        form: { client_key: creds.clientId, client_secret: creds.clientSecret, code: decodeURIComponent(code), grant_type: "authorization_code", redirect_uri: redirectUri },
      });
      return ttTokens(res.json());
    },
    async refresh(tokens, creds, http) {
      if (!tokens.refreshToken) throw new AppError("PROVIDER_ERROR", "TikTok connection has no refresh token", { details: { reconnect: true } });
      const res = await http.request(`${TIKTOK_API}/oauth/token/`, { op: "token refresh", method: "POST", form: { client_key: creds.clientId, client_secret: creds.clientSecret, grant_type: "refresh_token", refresh_token: tokens.refreshToken } });
      return ttTokens(res.json());
    },
    async revoke(tokens, creds, http) {
      await http.request(`${TIKTOK_API}/oauth/revoke/`, { op: "revoke", method: "POST", form: { client_key: creds.clientId, client_secret: creds.clientSecret, token: tokens.accessToken } });
    },
    async identity(tokens, http) {
      const res = await http.request(`${TIKTOK_API}/user/info/`, { op: "user info", bearer: tokens.accessToken, query: { fields: "open_id,display_name,avatar_url" } });
      const u = ttCheck(res.json<TtEnvelope<{ user?: { open_id?: string; display_name?: string } }>>(), "user info").user;
      const id = u?.open_id ?? tokens.extra?.openId;
      if (!id) throw new AppError("PROVIDER_ERROR", "TikTok did not return the account id");
      const limitations = tokens.scope.includes("video.publish") ? [] : ["video.publish was not granted; posts will use the manual flow."];
      return { externalAccountId: id, displayName: u?.display_name ?? id, limitations };
    },
  },
  publish: ttPublish,
};
