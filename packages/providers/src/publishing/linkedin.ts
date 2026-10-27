import { AppError } from "@muselaunch/platform";
import { expiresIn, uncertainOutcome } from "./http";
import type { ProviderAdapter, PublishContext, PublishRequest, PublishResult } from "./types";

/**
 * LinkedIn (member posts with w_member_social).
 * Videos API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
 * Posts API:  https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * OAuth:      https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 */
export const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_REVOKE_URL = "https://www.linkedin.com/oauth/v2/revoke";
export const LINKEDIN_REST = "https://api.linkedin.com/rest";
const LI_SCOPES = ["openid", "profile", "w_member_social"];

/**
 * Posts API commentary uses "little text": reserved characters must be backslash-escaped.
 * Hashtags become `{hashtag|\#|tag}` templates so they stay clickable.
 */
export function linkedinCommentary(text: string): string {
  const escape = (s: string) => s.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
  const out: string[] = [];
  const re = /#([\p{L}\p{N}_]+)/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(escape(text.slice(last, m.index)));
    out.push(`{hashtag|\\#|${escape(m[1]!)}}`);
    last = m.index! + m[0].length;
  }
  out.push(escape(text.slice(last)));
  return out.join("");
}

async function liPublish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  const { http, tokens, settings } = ctx;
  const author = `urn:li:person:${ctx.externalAccountId}`;
  const h = { "linkedin-version": settings.linkedinApiVersion, "x-restli-protocol-version": "2.0.0" };
  if (req.media && req.media.kind !== "video") throw new AppError("VALIDATION_FAILED", "LinkedIn publishing supports video or text posts");
  if (ctx.state.liPostCreateStarted && !ctx.state.liPostUrn) throw uncertainOutcome("LinkedIn", "create post");
  if (typeof ctx.state.liPostUrn === "string") return liResult(ctx.state.liPostUrn, ctx.state.liVideoUrn);

  let videoUrn = typeof ctx.state.liVideoUrn === "string" ? ctx.state.liVideoUrn : undefined;
  if (req.media && !ctx.state.liVideoReady) {
    if (!videoUrn || !ctx.state.liFinalized) {
      const init = await http.request(`${LINKEDIN_REST}/videos`, {
        op: "videos initializeUpload",
        method: "POST",
        query: { action: "initializeUpload" },
        bearer: tokens.accessToken,
        headers: h,
        json: { initializeUploadRequest: { owner: author, fileSizeBytes: req.media.bytes, uploadCaptions: false, uploadThumbnail: false } },
        signal: ctx.signal,
      });
      const v = init.json<{ value?: { video?: string; uploadToken?: string; uploadInstructions?: { uploadUrl: string; firstByte: number; lastByte: number }[] } }>().value;
      if (!v?.video || !v.uploadInstructions?.length) throw new AppError("PROVIDER_ERROR", "LinkedIn initializeUpload returned no upload instructions");
      videoUrn = v.video;
      await ctx.saveState({ liVideoUrn: videoUrn });
      const bytes = await req.media.read();
      const etags: string[] = [];
      for (const ins of v.uploadInstructions) {
        const part = await http.request(ins.uploadUrl, { op: "upload part", method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes.subarray(ins.firstByte, ins.lastByte + 1), signal: ctx.signal });
        const etag = part.headers.get("etag");
        if (!etag) throw new AppError("PROVIDER_ERROR", "LinkedIn part upload returned no ETag");
        etags.push(etag);
      }
      await http.request(`${LINKEDIN_REST}/videos`, {
        op: "videos finalizeUpload",
        method: "POST",
        query: { action: "finalizeUpload" },
        bearer: tokens.accessToken,
        headers: h,
        json: { finalizeUploadRequest: { video: videoUrn, uploadToken: v.uploadToken ?? "", uploadedPartIds: etags } },
        signal: ctx.signal,
      });
      await ctx.saveState({ liFinalized: true });
    }
    let status = "";
    for (let i = 0; i < (ctx.maxPolls ?? 20); i++) {
      const st = await http.request(`${LINKEDIN_REST}/videos/${encodeURIComponent(videoUrn!)}`, { op: "video status", bearer: tokens.accessToken, headers: h, signal: ctx.signal });
      const j = st.json<{ status?: string; processingFailureReason?: string }>();
      status = j.status ?? "";
      if (status === "AVAILABLE") break;
      if (status === "PROCESSING_FAILED") {
        await ctx.saveState({ liVideoUrn: undefined, liFinalized: undefined });
        throw new AppError("PROVIDER_ERROR", `LinkedIn could not process the video: ${j.processingFailureReason ?? "unknown"}`);
      }
      await ctx.sleep(ctx.pollIntervalMs ?? 10_000);
    }
    if (status !== "AVAILABLE") throw new AppError("PROVIDER_UNAVAILABLE", "LinkedIn is still processing the video; will check again", { retryable: true });
    await ctx.saveState({ liVideoReady: true });
  }

  await ctx.saveState({ liPostCreateStarted: true });
  const post = await http.request(`${LINKEDIN_REST}/posts`, {
    op: "create post",
    method: "POST",
    bearer: tokens.accessToken,
    headers: h,
    json: {
      author,
      commentary: linkedinCommentary(req.caption),
      visibility: req.visibility === "public" ? "PUBLIC" : "CONNECTIONS",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(videoUrn ? { content: { media: { title: (req.title ?? "").slice(0, 200), id: videoUrn } } } : {}),
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    },
    expect: [201],
    signal: ctx.signal,
  });
  const urn = post.headers.get("x-restli-id");
  if (!urn) throw uncertainOutcome("LinkedIn", "create post");
  await ctx.saveState({ liPostUrn: urn });
  return liResult(urn, videoUrn, req.visibility === "public" ? "public" : "private");
}

const liResult = (urn: string, videoUrn: unknown, vis: "public" | "private" = "public"): PublishResult => ({
  remoteId: urn,
  remoteUrl: `https://www.linkedin.com/feed/update/${urn}/`,
  receipt: { postUrn: urn, videoUrn: typeof videoUrn === "string" ? videoUrn : undefined },
  effectiveVisibility: vis,
});

export const linkedinAdapter: ProviderAdapter = {
  provider: "linkedin",
  label: "LinkedIn (member profile)",
  channels: ["linkedin"],
  purposes: ["publishing"],
  capabilities: ["publish_video", "publish_text"],
  env: { clientId: "LINKEDIN_CLIENT_ID", clientSecret: "LINKEDIN_CLIENT_SECRET" },
  review: {
    required: false,
    summary:
      "LinkedIn developer app (linked to a Company Page) with the self-serve products 'Sign In with LinkedIn using OpenID Connect' and 'Share on LinkedIn' (w_member_social). Posting as a Company Page needs Community Management API approval (not implemented). Access tokens last ~60 days; refresh tokens only for approved partners, so users reconnect.",
    docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
  },
  accepts: { video: true, image: false, textOnly: true },
  oauth: {
    pkce: false,
    scopes: LI_SCOPES,
    authorizeUrl({ clientId, redirectUri, state }) {
      const u = new URL(LINKEDIN_AUTHORIZE_URL);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      u.searchParams.set("scope", LI_SCOPES.join(" "));
      return u.toString();
    },
    async exchangeCode({ code, redirectUri, creds }, http) {
      const res = await http.request(LINKEDIN_TOKEN_URL, { op: "token exchange", method: "POST", form: { grant_type: "authorization_code", code, client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri } });
      const j = res.json<{ access_token: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string }>();
      if (!j.access_token) throw new AppError("PROVIDER_ERROR", "LinkedIn token response had no access_token");
      return { accessToken: j.access_token, expiresAt: expiresIn(j.expires_in), refreshToken: j.refresh_token, refreshExpiresAt: expiresIn(j.refresh_token_expires_in), scope: String(j.scope ?? LI_SCOPES.join(",")).split(/[ ,]/).filter(Boolean) };
    },
    async revoke(tokens, creds, http) {
      await http.request(LINKEDIN_REVOKE_URL, { op: "revoke", method: "POST", form: { client_id: creds.clientId, client_secret: creds.clientSecret, token: tokens.accessToken } });
    },
    async identity(tokens, http) {
      const res = await http.request("https://api.linkedin.com/v2/userinfo", { op: "userinfo", bearer: tokens.accessToken });
      const u = res.json<{ sub?: string; name?: string }>();
      if (!u.sub) throw new AppError("PROVIDER_ERROR", "LinkedIn did not return the member id");
      const limitations = tokens.scope.includes("w_member_social") ? [] : ["w_member_social was not granted; posts will use the manual flow."];
      return { externalAccountId: u.sub, displayName: u.name ?? u.sub, limitations };
    },
  },
  publish: liPublish,
};
