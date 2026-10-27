import { describe, expect, it } from "vitest";
import { FakeFetch, growthFixture } from "./fake-fetch";
import { buildRawEmail, gmailAdapter, YOUTUBE_UPLOAD_URL, youtubeAdapter } from "./google";
import { HttpClient } from "./http";
import { linkedinAdapter, linkedinCommentary } from "./linkedin";
import { instagramAdapter } from "./meta-social";
import { tiktokAdapter, tiktokChunks } from "./tiktok";
import type { PublishContext, PublishRequest } from "./types";
import { xAdapter } from "./x";

const yt = growthFixture("youtube");
const settings = { graphApiVersion: "v25.0", linkedinApiVersion: "202605", tiktokAudited: false };
const creds = { clientId: "cid", clientSecret: "csecret" };
const VIDEO = Buffer.from("0123456789ABCDEF"); // 16 bytes stands in for an MP4

function ctx(f: FakeFetch, state: Record<string, unknown> = {}, extra: Partial<PublishContext> = {}): PublishContext & { saved: Record<string, unknown>[] } {
  const saved: Record<string, unknown>[] = [];
  return {
    http: new HttpClient(f.fetch, "Test"),
    tokens: { accessToken: "ACCESS", scope: [], extra: {} },
    externalAccountId: "acct-1",
    settings,
    creds,
    state,
    saveState: async (patch) => {
      saved.push(patch);
      Object.assign(state, patch);
    },
    sleep: async () => {},
    maxPolls: 3,
    pollIntervalMs: 1,
    saved,
    ...extra,
  };
}

const req = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  media: { kind: "video", mimeType: "video/mp4", bytes: VIDEO.length, filename: "post.mp4", read: async () => VIDEO, publicUrl: async () => "https://cdn.example.com/signed/post.mp4" },
  title: "Plan your week in 15 seconds",
  caption: "Plan your week <fast> in 15 seconds.\n#productivity",
  tags: ["#productivity", "planner"],
  visibility: "public",
  containsSyntheticMedia: true,
  ...over,
});

describe("YouTube adapter (videos.insert resumable upload)", () => {
  it("starts a resumable session with the documented headers/body, persists the session URI, then uploads the bytes", async () => {
    const f = new FakeFetch()
      .on("POST", YOUTUBE_UPLOAD_URL, { status: 200, text: "", headers: { location: yt.sessionLocation } })
      .on("PUT", yt.sessionLocation, { status: 201, json: yt.video });
    const c = ctx(f);
    const out = await youtubeAdapter.publish!(req(), c);

    const init = f.calls("POST", YOUTUBE_UPLOAD_URL)[0]!;
    const u = new URL(init.url);
    expect(u.searchParams.get("uploadType")).toBe("resumable");
    expect(u.searchParams.get("part")).toBe("snippet,status");
    expect(init.headers.authorization).toBe("Bearer ACCESS");
    expect(init.headers["x-upload-content-length"]).toBe(String(VIDEO.length));
    expect(init.headers["x-upload-content-type"]).toBe("video/mp4");
    expect(init.json).toEqual({
      snippet: { title: "Plan your week in 15 seconds", description: "Plan your week fast in 15 seconds.\n#productivity", tags: ["productivity", "planner"], categoryId: "28" },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
    });
    expect(c.saved[0]).toMatchObject({ youtubeSessionUrl: yt.sessionLocation });
    const put = f.calls("PUT", yt.sessionLocation)[0]!;
    expect(put.bodyBytes).toBe(VIDEO.length);
    expect(put.headers["content-type"]).toBe("video/mp4");
    expect(out).toMatchObject({ remoteId: "FIXTUREvid01", remoteUrl: "https://www.youtube.com/watch?v=FIXTUREvid01", effectiveVisibility: "public" });
    expect(out.receipt).toMatchObject({ videoId: "FIXTUREvid01", channelId: "UCFIXTURE0000000000000001", uploadStatus: "uploaded" });
  });

  it("schedules natively with publishAt (privacy private) for future times", async () => {
    const f = new FakeFetch().on("POST", YOUTUBE_UPLOAD_URL, { status: 200, headers: { location: yt.sessionLocation } }).on("PUT", yt.sessionLocation, { status: 201, json: yt.video });
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await youtubeAdapter.publish!(req({ scheduledAt: at }), ctx(f));
    expect((f.calls("POST", YOUTUBE_UPLOAD_URL)[0]!.json as any).status).toMatchObject({ privacyStatus: "private", publishAt: at });
  });

  it("resumes a stored session: 308 with Range → uploads only the remaining bytes", async () => {
    const f = new FakeFetch().on(
      "PUT",
      yt.sessionLocation,
      { status: 308, headers: { range: "bytes=0-9" } },
      { status: 201, json: yt.video },
    );
    const out = await youtubeAdapter.publish!(req(), ctx(f, { youtubeSessionUrl: yt.sessionLocation }));
    const [probe, rest] = f.calls("PUT", yt.sessionLocation);
    expect(probe!.headers["content-range"]).toBe(`bytes */${VIDEO.length}`);
    expect(rest!.headers["content-range"]).toBe(`bytes 10-15/16`);
    expect(rest!.bodyBytes).toBe(6);
    expect(f.calls("POST", YOUTUBE_UPLOAD_URL)).toHaveLength(0);
    expect(out.remoteId).toBe("FIXTUREvid01");
  });

  it("never re-uploads when a stored session already completed (returns the original video)", async () => {
    const f = new FakeFetch().on("PUT", yt.sessionLocation, { status: 200, json: yt.video });
    const out = await youtubeAdapter.publish!(req(), ctx(f, { youtubeSessionUrl: yt.sessionLocation }));
    expect(f.requests).toHaveLength(1);
    expect(out.remoteId).toBe("FIXTUREvid01");
  });

  it("maps provider errors: 401 → reconnect, 403 quota → not retryable, 503 → retryable", async () => {
    const mk = (status: number) => new FakeFetch().on("POST", YOUTUBE_UPLOAD_URL, { status, json: { error: { code: status, message: "boom", errors: [{ reason: status === 403 ? "quotaExceeded" : "x" }] } } });
    await expect(youtubeAdapter.publish!(req(), ctx(mk(401)))).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: false, opts: { details: { reconnect: true } } });
    await expect(youtubeAdapter.publish!(req(), ctx(mk(403)))).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: false });
    await expect(youtubeAdapter.publish!(req(), ctx(mk(503)))).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("builds the Google authorize URL with offline access and PKCE S256", () => {
    const url = new URL(youtubeAdapter.oauth.authorizeUrl({ clientId: "cid", redirectUri: "https://api.example.com/v1/oauth/youtube/callback", state: "STATE", codeChallenge: "CHAL", settings }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "cid", response_type: "code", access_type: "offline", state: "STATE", code_challenge: "CHAL", code_challenge_method: "S256" });
    expect(url.searchParams.get("scope")).toContain("youtube.upload");
  });
});

describe("TikTok adapter (Direct Post)", () => {
  const tt = growthFixture("tiktok");
  it("unaudited client posts SELF_ONLY with is_aigc, uploads with Content-Range, and reports private visibility", async () => {
    const f = new FakeFetch()
      .on("POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", { json: tt.creatorInfo })
      .on("POST", "https://open.tiktokapis.com/v2/post/publish/video/init/", { json: tt.init })
      .on("PUT", tt.init.data.upload_url, { status: 201, text: "" })
      .on("POST", "https://open.tiktokapis.com/v2/post/publish/status/fetch/", { json: tt.statusProcessing }, { json: tt.statusComplete });
    const out = await tiktokAdapter.publish!(req(), ctx(f));
    const init = f.calls("POST", "https://open.tiktokapis.com/v2/post/publish/video/init/")[0]!.json as any;
    expect(init.post_info).toMatchObject({ privacy_level: "SELF_ONLY", is_aigc: true });
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 16, chunk_size: 16, total_chunk_count: 1 });
    expect(f.calls("PUT", tt.init.data.upload_url)[0]!.headers["content-range"]).toBe("bytes 0-15/16");
    expect(out).toMatchObject({ remoteId: tt.init.data.publish_id, effectiveVisibility: "private" });
    expect(out.notes?.join(" ")).toMatch(/not yet audited/);
  });
  it("chunks large files per the media transfer guide", () => {
    const plan = tiktokChunks(105_000_123);
    expect(plan.count).toBe(10);
    expect(plan.ranges.at(-1)).toEqual([90_000_000, 105_000_122]);
  });
});

describe("Instagram adapter", () => {
  const ig = growthFixture("instagram");
  it("creates a REELS container from a public URL, polls status, publishes and fetches the permalink", async () => {
    const base = "https://graph.instagram.com/v25.0";
    const f = new FakeFetch()
      .on("POST", `${base}/acct-1/media_publish`, { json: ig.publish })
      .on("POST", `${base}/acct-1/media`, { json: ig.container })
      .on("GET", `${base}/${ig.container.id}`, { json: ig.statusInProgress }, { json: ig.statusFinished })
      .on("GET", `${base}/${ig.publish.id}`, { json: ig.media });
    const c = ctx(f);
    const out = await instagramAdapter.publish!(req(), c);
    expect(f.calls("POST", `${base}/acct-1/media`)[0]!.form).toMatchObject({ media_type: "REELS", video_url: "https://cdn.example.com/signed/post.mp4", caption: req().caption });
    expect(f.calls("POST", `${base}/acct-1/media_publish`)[0]!.form).toEqual({ creation_id: ig.container.id });
    expect(c.saved[0]).toEqual({ igContainerId: ig.container.id });
    expect(out).toMatchObject({ remoteId: ig.publish.id, remoteUrl: ig.media.permalink });
  });
  it("refuses to re-publish when a previous attempt's outcome is unknown", async () => {
    const base = "https://graph.instagram.com/v25.0";
    const f = new FakeFetch().on("GET", `${base}/${ig.container.id}`, { json: { status_code: "PUBLISHED" } });
    await expect(instagramAdapter.publish!(req(), ctx(f, { igContainerId: ig.container.id }))).rejects.toMatchObject({ code: "PROVIDER_ERROR", opts: { details: { uncertain: true } } });
    expect(f.calls("POST", `${base}/acct-1/media_publish`)).toHaveLength(0);
  });
});

describe("LinkedIn + X + Gmail adapters", () => {
  it("LinkedIn: initialize → part PUT (ETag) → finalize → poll → create post with escaped commentary", async () => {
    const li = growthFixture("linkedin");
    const f = new FakeFetch()
      .on("POST", "https://api.linkedin.com/rest/videos?action=initializeUpload", { json: li.initialize })
      .on("PUT", li.initialize.value.uploadInstructions[0].uploadUrl, { status: 200, text: "", headers: { etag: li.partEtag } })
      .on("POST", "https://api.linkedin.com/rest/videos?action=finalizeUpload", { status: 200, text: "" })
      .on("GET", "https://api.linkedin.com/rest/videos/", { json: li.videoAvailable })
      .on("POST", "https://api.linkedin.com/rest/posts", { status: 201, text: "", headers: { "x-restli-id": li.postUrn } });
    const out = await linkedinAdapter.publish!(req({ caption: "New (beta) build #indiedev" }), ctx(f));
    const fin = f.calls("POST", "https://api.linkedin.com/rest/videos?action=finalizeUpload")[0]!;
    expect(fin.json).toEqual({ finalizeUploadRequest: { video: li.initialize.value.video, uploadToken: "", uploadedPartIds: [li.partEtag] } });
    const post = f.calls("POST", "https://api.linkedin.com/rest/posts")[0]!;
    expect(post.headers["linkedin-version"]).toBe("202605");
    expect(post.json).toMatchObject({ author: "urn:li:person:acct-1", commentary: "New \\(beta\\) build {hashtag|\\#|indiedev}", content: { media: { id: li.initialize.value.video } }, lifecycleState: "PUBLISHED" });
    expect(out).toMatchObject({ remoteId: li.postUrn, remoteUrl: `https://www.linkedin.com/feed/update/${li.postUrn}/` });
    expect(linkedinCommentary("a_b*c")).toBe("a\\_b\\*c");
  });

  it("X: initialize → append → finalize → status → POST /2/tweets with media_ids", async () => {
    const x = growthFixture("x");
    const f = new FakeFetch()
      .on("POST", "https://api.x.com/2/media/upload/initialize", { json: x.initialize })
      .on("POST", /\/2\/media\/upload\/\d+\/append$/, { status: 204 })
      .on("POST", /\/2\/media\/upload\/\d+\/finalize$/, { json: x.finalize })
      .on("GET", "https://api.x.com/2/media/upload?", { json: x.statusSucceeded })
      .on("POST", "https://api.x.com/2/tweets", { status: 201, json: x.tweet });
    const c = ctx(f);
    c.tokens.extra = { username: "fixtureapps" };
    const out = await xAdapter.publish!(req({ caption: "Plan your week in 15 seconds" }), c);
    expect((f.calls("POST", "https://api.x.com/2/media/upload/initialize")[0]!.json as any)).toEqual({ media_type: "video/mp4", total_bytes: 16, media_category: "tweet_video" });
    expect(f.calls("POST", "https://api.x.com/2/tweets")[0]!.json).toEqual({ text: "Plan your week in 15 seconds", media: { media_ids: [x.initialize.data.id] } });
    expect(out.remoteUrl).toBe(`https://x.com/fixtureapps/status/${x.tweet.data.id}`);
  });

  it("Gmail: base64url RFC 2822 raw message, header injection stripped", async () => {
    const gm = growthFixture("gmail");
    const raw = buildRawEmail({ to: "creator@example.com\r\nBcc: victim@example.com", subject: "Hi\nthere", body: "Hello" });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: creator@example.com Bcc: victim@example.com");
    expect(decoded).not.toMatch(/\r\nBcc:/);
    const f = new FakeFetch().on("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { json: gm.send });
    const c = ctx(f);
    c.tokens.extra = { email: "founder@fixture.example" };
    const out = await gmailAdapter.sendEmail!({ to: "creator@example.com", subject: "Hi", body: "Hello" }, c);
    expect(out.messageId).toBe(gm.send.id);
    const sent = Buffer.from((f.requests[0]!.json as any).raw, "base64url").toString("utf8");
    expect(sent).toContain("From: founder@fixture.example");
  });
});
