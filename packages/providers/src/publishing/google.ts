import { AppError } from "@muselaunch/platform";
import { expiresIn, httpError } from "./http";
import type { OAuthSpec, OAuthTokens, ProviderAdapter, PublishContext, PublishRequest, PublishResult, SendEmailRequest } from "./types";

/**
 * Google OAuth 2.0 for web server apps (PKCE S256 supported), shared by YouTube and Gmail.
 * Docs: https://developers.google.com/identity/protocols/oauth2/web-server
 */
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

function googleTokens(j: Record<string, any>, prev?: OAuthTokens): OAuthTokens {
  if (!j.access_token) throw new AppError("PROVIDER_ERROR", "Google token response had no access_token");
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? prev?.refreshToken,
    expiresAt: expiresIn(j.expires_in),
    scope: typeof j.scope === "string" ? j.scope.split(" ").filter(Boolean) : (prev?.scope ?? []),
    extra: prev?.extra,
  };
}

function googleOAuth(scopes: string[], identity: OAuthSpec["identity"]): OAuthSpec {
  return {
    pkce: true,
    scopes,
    authorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
      const u = new URL(GOOGLE_AUTHORIZE_URL);
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", scopes.join(" "));
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("include_granted_scopes", "true");
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("state", state);
      if (codeChallenge) {
        u.searchParams.set("code_challenge", codeChallenge);
        u.searchParams.set("code_challenge_method", "S256");
      }
      return u.toString();
    },
    async exchangeCode({ code, redirectUri, codeVerifier, creds }, http) {
      const res = await http.request(GOOGLE_TOKEN_URL, {
        op: "token exchange",
        method: "POST",
        form: { code, client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: codeVerifier },
      });
      return googleTokens(res.json());
    },
    async refresh(tokens, creds, http) {
      if (!tokens.refreshToken) throw new AppError("PROVIDER_ERROR", "Google connection has no refresh token", { details: { reconnect: true }, userMessage: "Please reconnect your Google account." });
      const res = await http.request(GOOGLE_TOKEN_URL, {
        op: "token refresh",
        method: "POST",
        form: { client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: tokens.refreshToken, grant_type: "refresh_token" },
      });
      return googleTokens(res.json(), tokens);
    },
    async revoke(tokens, _creds, http) {
      await http.request(GOOGLE_REVOKE_URL, { op: "revoke", method: "POST", form: { token: tokens.refreshToken ?? tokens.accessToken } });
    },
    identity,
  };
}

// ---------------------------------------------------------------------------
// YouTube Data API v3 — videos.insert via the resumable upload protocol
// https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
// ---------------------------------------------------------------------------

export const YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
export const YOUTUBE_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
/** youtube.readonly also lets Insights read the stats of the channel's videos; yt-analytics.readonly adds watch time, shares and subscribers (YouTube Analytics API). */
const YT_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];

/** YouTube rejects "<" and ">" in titles/descriptions; titles ≤100 chars, descriptions ≤5000 bytes, tags ≤500 chars total. */
export function youtubeMetadata(req: PublishRequest) {
  const clean = (s: string) => s.replace(/[<>]/g, "");
  const title = clean(req.title ?? req.caption.split("\n")[0] ?? "").trim().slice(0, 100);
  if (!title) throw new AppError("VALIDATION_FAILED", "YouTube videos need a title", { userMessage: "Add a title for YouTube." });
  let description = clean(req.caption);
  while (Buffer.byteLength(description, "utf8") > 5000) description = description.slice(0, -1);
  const tags: string[] = [];
  let used = 0;
  for (const t of req.tags.map((x) => clean(x.replace(/^#/, "")).trim()).filter(Boolean)) {
    const cost = t.length + (t.includes(" ") ? 2 : 0) + (tags.length ? 1 : 0);
    if (used + cost > 500) break;
    tags.push(t);
    used += cost;
  }
  const future = req.scheduledAt && Date.parse(req.scheduledAt) > Date.now() + 60_000;
  const status: Record<string, unknown> = {
    // publishAt requires privacyStatus=private; YouTube flips it to public at that time.
    privacyStatus: future ? "private" : req.visibility,
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: req.containsSyntheticMedia,
    ...(future ? { publishAt: new Date(req.scheduledAt!).toISOString() } : {}),
  };
  return { snippet: { title, description, tags, categoryId: "28" }, status };
}

function youtubeResult(video: Record<string, any>, req: PublishRequest): PublishResult {
  if (!video?.id) throw new AppError("PROVIDER_ERROR", "YouTube upload completed without a video id");
  const notes: string[] = [];
  if (video.status?.publishAt) notes.push(`Scheduled on YouTube for ${video.status.publishAt}`);
  return {
    remoteId: String(video.id),
    remoteUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
    receipt: {
      videoId: video.id,
      channelId: video.snippet?.channelId,
      publishedAt: video.snippet?.publishedAt,
      uploadStatus: video.status?.uploadStatus,
      privacyStatus: video.status?.privacyStatus,
      publishAt: video.status?.publishAt,
    },
    effectiveVisibility: video.status?.privacyStatus ?? req.visibility,
    notes,
  };
}

async function youtubePublish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  if (!req.media || req.media.kind !== "video") throw new AppError("VALIDATION_FAILED", "YouTube publishing needs a rendered video");
  const media = req.media;
  const { http, tokens } = ctx;
  const total = media.bytes;

  // Resume: a stored session either completed (201/200 with the video), is incomplete (308), or expired (404).
  let sessionUrl = typeof ctx.state.youtubeSessionUrl === "string" ? ctx.state.youtubeSessionUrl : undefined;
  let start = 0;
  if (sessionUrl) {
    const probe = await http.request(sessionUrl, { op: "upload status", method: "PUT", bearer: tokens.accessToken, headers: { "content-range": `bytes */${total}` }, body: "", expect: [200, 201, 308, 404], signal: ctx.signal });
    if (probe.status === 200 || probe.status === 201) return youtubeResult(probe.json(), req);
    if (probe.status === 404) sessionUrl = undefined;
    else {
      const range = probe.headers.get("range");
      const m = range?.match(/bytes=0-(\d+)/);
      start = m ? Number(m[1]) + 1 : 0;
    }
  }
  if (!sessionUrl) {
    const init = await http.request(YOUTUBE_UPLOAD_URL, {
      op: "videos.insert (start session)",
      method: "POST",
      query: { uploadType: "resumable", part: "snippet,status" },
      bearer: tokens.accessToken,
      headers: { "x-upload-content-length": String(total), "x-upload-content-type": media.mimeType },
      json: youtubeMetadata(req),
      expect: [200],
      signal: ctx.signal,
    });
    sessionUrl = init.headers.get("location") ?? undefined;
    if (!sessionUrl) throw new AppError("PROVIDER_ERROR", "YouTube did not return an upload session URI");
    await ctx.saveState({ youtubeSessionUrl: sessionUrl, youtubeSessionStartedAt: new Date().toISOString() });
    start = 0;
  }
  const bytes = await media.read();
  if (bytes.length !== total) throw new AppError("INTERNAL", `Asset size mismatch (${bytes.length} != ${total})`);
  const chunk = start > 0 ? bytes.subarray(start) : bytes;
  const put = await http.request(sessionUrl, {
    op: "videos.insert (upload)",
    method: "PUT",
    bearer: tokens.accessToken,
    headers: { "content-type": media.mimeType, ...(start > 0 ? { "content-range": `bytes ${start}-${total - 1}/${total}` } : {}) },
    body: chunk,
    expect: [200, 201, 308],
    signal: ctx.signal,
  });
  if (put.status === 308) throw new AppError("PROVIDER_UNAVAILABLE", "YouTube upload incomplete; will resume", { retryable: true });
  return youtubeResult(put.json(), req);
}

export const youtubeAdapter: ProviderAdapter = {
  provider: "youtube",
  label: "YouTube",
  channels: ["youtube"],
  purposes: ["publishing", "analytics"],
  capabilities: ["publish_video", "read_insights"],
  env: { clientId: "YOUTUBE_CLIENT_ID", clientSecret: "YOUTUBE_CLIENT_SECRET" },
  review: {
    required: true,
    summary:
      "Google OAuth client with YouTube Data API v3 and YouTube Analytics API enabled. While the consent screen is in Testing, only listed test users (max 100) can connect and refresh tokens expire after 7 days; the YouTube scopes (upload, readonly, yt-analytics.readonly) need Google OAuth verification for public use. videos.insert has a default limit of 100 calls/day per project.",
    docsUrl: "https://developers.google.com/youtube/v3/docs/videos/insert",
  },
  accepts: { video: true, image: false, textOnly: false },
  oauth: googleOAuth(YT_SCOPES, async (tokens, http) => {
    const res = await http.request(YOUTUBE_CHANNELS_URL, { op: "channels.list", bearer: tokens.accessToken, query: { part: "snippet", mine: "true" } });
    const ch = res.json<{ items?: { id: string; snippet?: { title?: string; customUrl?: string } }[] }>().items?.[0];
    if (!ch) throw new AppError("PROVIDER_ERROR", "This Google account has no YouTube channel", { userMessage: "This Google account doesn't have a YouTube channel yet. Create one on YouTube, then connect again." });
    return { externalAccountId: ch.id, displayName: ch.snippet?.title ?? ch.snippet?.customUrl ?? ch.id, extra: { channelTitle: ch.snippet?.title ?? "" } };
  }),
  publish: youtubePublish,
};

// ---------------------------------------------------------------------------
// Gmail API — users.messages.send (outreach email from the user's own mailbox)
// https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send
// ---------------------------------------------------------------------------

export const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/** RFC 2822 message, base64url-encoded as Gmail's `raw`. Header values are stripped of CR/LF (header injection). */
export function buildRawEmail(m: SendEmailRequest): string {
  const h = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  const encSubject = /^[\x20-\x7e]*$/.test(m.subject) ? h(m.subject) : `=?UTF-8?B?${Buffer.from(h(m.subject), "utf8").toString("base64")}?=`;
  const lines = [
    ...(m.from ? [`From: ${h(m.from)}`] : []),
    `To: ${h(m.to)}`,
    `Subject: ${encSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export const gmailAdapter: ProviderAdapter = {
  provider: "gmail",
  label: "Gmail",
  channels: [],
  purposes: ["outreach"],
  capabilities: ["send_message"],
  env: { clientId: "YOUTUBE_CLIENT_ID", clientSecret: "YOUTUBE_CLIENT_SECRET" },
  review: {
    required: true,
    summary:
      "Uses the same Google OAuth client as YouTube with the Gmail API enabled. gmail.send is a restricted scope: Testing mode works for listed test users; public use needs Google verification (and may need a security assessment).",
    docsUrl: "https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send",
  },
  accepts: { video: false, image: false, textOnly: true },
  oauth: googleOAuth(["openid", "email", "https://www.googleapis.com/auth/gmail.send"], async (tokens, http) => {
    const res = await http.request(GOOGLE_USERINFO_URL, { op: "userinfo", bearer: tokens.accessToken });
    const u = res.json<{ sub: string; email?: string; email_verified?: boolean }>();
    if (!u.email) throw new AppError("PROVIDER_ERROR", "Google did not return the account email");
    return { externalAccountId: u.sub, displayName: u.email, extra: { email: u.email } };
  }),
  async sendEmail(req, ctx) {
    const res = await ctx.http.request(GMAIL_SEND_URL, { op: "messages.send", method: "POST", bearer: ctx.tokens.accessToken, json: { raw: buildRawEmail({ ...req, from: req.from ?? ctx.tokens.extra?.email }) }, signal: ctx.signal });
    const j = res.json<{ id?: string; threadId?: string; labelIds?: string[] }>();
    if (!j.id) throw httpError("Gmail", "messages.send", res.status, res.text);
    return { messageId: j.id, receipt: { provider: "gmail", messageId: j.id, threadId: j.threadId, labelIds: j.labelIds } };
  },
};
