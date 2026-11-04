import { describe, expect, it } from "vitest";
import { FakeFetch, growthFixture } from "./fake-fetch";
import { YOUTUBE_THUMBNAIL_URL, YOUTUBE_UPLOAD_URL, youtubeAdapter } from "./google";
import { HttpClient } from "./http";
import { linkedinAdapter } from "./linkedin";
import { facebookAdapter, instagramAdapter } from "./meta-social";
import { tiktokAdapter } from "./tiktok";
import { acceptsShape, mediaShapeOf, requestMedia, type PublishContext, type PublishMedia, type PublishRequest } from "./types";
import { xAdapter } from "./x";

/**
 * Carousels (several images in order), single images and text-only posts through each adapter's
 * documented API. Provider responses are documented shapes from fixtures/growth (labelled fixtures,
 * not live output): no live account was used.
 */

const settings = { graphApiVersion: "v25.0", linkedinApiVersion: "202605", tiktokAudited: false };
const creds = { clientId: "cid", clientSecret: "csecret" };
const ig = growthFixture("instagram");
const fbx = growthFixture("facebook");
const li = growthFixture("linkedin");
const xf = growthFixture("x");
const yt = growthFixture("youtube");
const IG = "https://graph.instagram.com/v25.0";
/** The container endpoint exactly (FakeFetch string routes match by prefix, which would include media_publish). */
const IG_MEDIA = /^https:\/\/graph\.instagram\.com\/v25\.0\/acct-1\/media$/;
const FB = "https://graph.facebook.com/v25.0";

function ctx(f: FakeFetch, state: Record<string, unknown> = {}, extra: Partial<PublishContext> = {}): PublishContext & { saved: Record<string, unknown>[] } {
  const saved: Record<string, unknown>[] = [];
  return {
    http: new HttpClient(f.fetch, "Test"),
    tokens: { accessToken: "ACCESS", scope: [], extra: { pageAccessToken: "PAGE_TOKEN", username: "fixtureapps" } },
    externalAccountId: "acct-1",
    settings,
    creds,
    state,
    saveState: async (patch) => {
      saved.push(structuredClone(patch));
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete state[k];
        else state[k] = v;
      }
    },
    sleep: async () => {},
    maxPolls: 3,
    pollIntervalMs: 1,
    saved,
    ...extra,
  };
}

const slide = (n: number, mimeType = "image/jpeg", over: Partial<PublishMedia> = {}): PublishMedia => {
  const bytes = Buffer.from(`slide-${n}-bytes`);
  return { kind: "image", mimeType, bytes: bytes.length, filename: `slide${n}.jpg`, read: async () => bytes, publicUrl: async () => `https://cdn.example.com/signed/slide${n}.jpg`, ...over };
};
const slides = (n: number, mime?: string) => Array.from({ length: n }, (_, i) => slide(i + 1, mime));
const req = (over: Partial<PublishRequest> = {}): PublishRequest => ({ caption: "Three ways to plan your week #productivity", tags: [], visibility: "public", containsSyntheticMedia: false, ...over });

describe("media shape helpers", () => {
  it("items win over media; shapes are text / video / image / carousel / mixed", () => {
    expect(requestMedia({})).toEqual([]);
    expect(mediaShapeOf([])).toBe("text");
    expect(mediaShapeOf([{ kind: "image" }])).toBe("image");
    expect(mediaShapeOf([{ kind: "image" }, { kind: "image" }])).toBe("carousel");
    expect(mediaShapeOf([{ kind: "video" }, { kind: "image" }])).toBe("mixed");
    expect(requestMedia({ items: slides(2) })).toHaveLength(2);
  });
  it("each adapter says what it takes (the web explains these)", () => {
    expect(instagramAdapter.accepts).toMatchObject({ textOnly: false, carousel: { min: 2, max: 10, mimeTypes: ["image/jpeg"] }, imageMimeTypes: ["image/jpeg"] });
    expect(facebookAdapter.accepts).toMatchObject({ textOnly: true, image: true, carousel: { min: 2, max: 10 } });
    expect(xAdapter.accepts).toMatchObject({ textOnly: true, carousel: { min: 2, max: 4 } });
    expect(linkedinAdapter.accepts).toMatchObject({ textOnly: true, image: true, carousel: { min: 2, max: 20, mimeTypes: ["image/jpeg", "image/png", "image/gif"] } });
    expect(tiktokAdapter.accepts.carousel).toBeNull();
    expect(tiktokAdapter.accepts.manualReason?.carousel).toMatch(/verified with TikTok/);
    expect(youtubeAdapter.accepts).toMatchObject({ carousel: null, image: false, thumbnail: true });
    expect(acceptsShape(youtubeAdapter.accepts, "carousel")).toBe(false);
    expect(acceptsShape(xAdapter.accepts, "text")).toBe(true);
  });
});

describe("Instagram carousel (item containers → CAROUSEL container → media_publish)", () => {
  const route = () =>
    new FakeFetch()
      .on("POST", `${IG}/acct-1/media_publish`, { json: ig.carouselPublish })
      .on("POST", `${IG}/acct-1/media`, ...ig.carouselItems.map((j: unknown) => ({ json: j })), { json: ig.carouselContainer })
      .on("GET", `${IG}/${ig.carouselContainer.id}`, { json: { status_code: "IN_PROGRESS" } }, { json: ig.carouselStatusFinished })
      .on("GET", `${IG}/${ig.carouselPublish.id}`, { json: ig.carouselMedia });

  it("creates one item per slide in order, then the carousel with children + caption, polls, publishes once", async () => {
    const f = route();
    const c = ctx(f);
    const out = await instagramAdapter.publish!(req({ items: slides(3) }), c);
    const creates = f.calls("POST", IG_MEDIA);
    expect(creates).toHaveLength(4);
    expect(creates.slice(0, 3).map((r) => r.form)).toEqual([1, 2, 3].map((n) => ({ image_url: `https://cdn.example.com/signed/slide${n}.jpg`, is_carousel_item: "true" })));
    expect(creates[3]!.form).toEqual({ media_type: "CAROUSEL", children: ig.carouselItems.map((x: { id: string }) => x.id).join(","), caption: req().caption });
    expect(f.calls("POST", `${IG}/acct-1/media_publish`).map((r) => r.form)).toEqual([{ creation_id: ig.carouselContainer.id }]);
    // Resume state is saved after each container, before the next non-idempotent step.
    expect(c.saved.slice(0, 4)).toEqual([
      { igCarouselItemIds: ["17900000000000101"] },
      { igCarouselItemIds: ["17900000000000101", "17900000000000102"] },
      { igCarouselItemIds: ["17900000000000101", "17900000000000102", "17900000000000103"] },
      { igCarouselId: ig.carouselContainer.id },
    ]);
    expect(out).toMatchObject({ remoteId: ig.carouselPublish.id, remoteUrl: ig.carouselMedia.permalink, receipt: { containerId: ig.carouselContainer.id, carouselItemIds: ig.carouselItems.map((x: { id: string }) => x.id) } });
  });

  it("a retry after a failure part-way reuses the item containers it already made", async () => {
    const f = new FakeFetch()
      .on("POST", `${IG}/acct-1/media_publish`, { json: ig.carouselPublish })
      .on("POST", `${IG}/acct-1/media`, { json: ig.carouselItems[2] }, { json: ig.carouselContainer })
      .on("GET", `${IG}/${ig.carouselContainer.id}`, { json: ig.carouselStatusFinished })
      .on("GET", `${IG}/${ig.carouselPublish.id}`, { json: ig.carouselMedia });
    await instagramAdapter.publish!(req({ items: slides(3) }), ctx(f, { igCarouselItemIds: ["17900000000000101", "17900000000000102"] }));
    const creates = f.calls("POST", IG_MEDIA);
    expect(creates.map((r) => r.form?.image_url ?? r.form?.media_type)).toEqual(["https://cdn.example.com/signed/slide3.jpg", "CAROUSEL"]);
    expect(creates[1]!.form!.children).toBe("17900000000000101,17900000000000102,17900000000000103");
  });

  it("never publishes twice: a carousel container already PUBLISHED without a recorded media id is an uncertain outcome", async () => {
    const f = new FakeFetch().on("GET", `${IG}/${ig.carouselContainer.id}`, { json: { status_code: "PUBLISHED" } });
    await expect(instagramAdapter.publish!(req({ items: slides(3) }), ctx(f, { igCarouselId: ig.carouselContainer.id }))).rejects.toMatchObject({ code: "PROVIDER_ERROR", opts: { details: { uncertain: true } } });
    expect(f.calls("POST", `${IG}/acct-1/media_publish`)).toHaveLength(0);
    expect(f.calls("POST", IG_MEDIA)).toHaveLength(0);
  });

  it("an EXPIRED carousel container is dropped so the next attempt makes fresh containers", async () => {
    const f = new FakeFetch().on("GET", `${IG}/${ig.carouselContainer.id}`, { json: { status_code: "EXPIRED" } });
    const state: Record<string, unknown> = { igCarouselId: ig.carouselContainer.id, igCarouselItemIds: ["a", "b"] };
    await expect(instagramAdapter.publish!(req({ items: slides(2) }), ctx(f, state))).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: false });
    expect(state).toEqual({});
  });

  it("refuses more than 10 slides, PNG slides and video+image mixes before any request", async () => {
    const f = new FakeFetch();
    await expect(instagramAdapter.publish!(req({ items: slides(11) }), ctx(f))).rejects.toMatchObject({ code: "VALIDATION_FAILED", opts: { userMessage: "Instagram takes up to 10 slides through its API." } });
    await expect(instagramAdapter.publish!(req({ items: [slide(1), slide(2, "image/png")] }), ctx(f))).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("slide 2 is image/png") });
    await expect(instagramAdapter.publish!(req({ items: [slide(1), { ...slide(2), kind: "video", mimeType: "video/mp4" }] }), ctx(f))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(instagramAdapter.publish!(req(), ctx(f))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(f.requests).toHaveLength(0);
  });

  it("a single JPEG stays a single image container with the caption", async () => {
    const f = new FakeFetch()
      .on("POST", `${IG}/acct-1/media_publish`, { json: ig.publish })
      .on("POST", `${IG}/acct-1/media`, { json: ig.container })
      .on("GET", `${IG}/${ig.container.id}`, { json: ig.statusFinished })
      .on("GET", `${IG}/${ig.publish.id}`, { json: ig.media });
    await instagramAdapter.publish!(req({ media: slide(1) }), ctx(f));
    expect(f.calls("POST", IG_MEDIA)[0]!.form).toEqual({ image_url: "https://cdn.example.com/signed/slide1.jpg", caption: req().caption });
  });
});

describe("Facebook Page: text, one photo, several photos (unpublished photos → /feed attached_media)", () => {
  it("text-only posts to /feed with the message and the Page token", async () => {
    const f = new FakeFetch().on("POST", `${FB}/acct-1/feed`, { json: fbx.feedPost }).on("GET", `${FB}/${fbx.feedPost.id}`, { json: fbx.permalink });
    const c = ctx(f);
    const out = await facebookAdapter.publish!(req({ caption: "We shipped dark mode." }), c);
    expect(f.calls("POST", `${FB}/acct-1/feed`)[0]!.form).toEqual({ access_token: "PAGE_TOKEN", message: "We shipped dark mode." });
    expect(c.saved[0]).toEqual({ fbPostCreateStarted: true });
    expect(out).toMatchObject({ remoteId: fbx.feedPost.id, remoteUrl: fbx.permalink.permalink_url, effectiveVisibility: "public" });
  });

  it("several photos: each uploaded unpublished in order (ids saved one by one), then one feed post with attached_media", async () => {
    const f = new FakeFetch()
      .on("POST", `${FB}/acct-1/photos`, ...fbx.unpublishedPhotos.map((j: unknown) => ({ json: j })))
      .on("POST", `${FB}/acct-1/feed`, { json: fbx.feedPost })
      .on("GET", `${FB}/${fbx.feedPost.id}`, { json: fbx.permalink });
    const c = ctx(f);
    const out = await facebookAdapter.publish!(req({ items: slides(3, "image/png") }), c);
    const photos = f.calls("POST", `${FB}/acct-1/photos`);
    expect(photos.map((r) => r.form)).toEqual([1, 2, 3].map((n) => ({ access_token: "PAGE_TOKEN", url: `https://cdn.example.com/signed/slide${n}.jpg`, published: "false" })));
    const feed = f.calls("POST", `${FB}/acct-1/feed`)[0]!.form!;
    expect(feed).toEqual({
      access_token: "PAGE_TOKEN",
      message: req().caption,
      "attached_media[0]": JSON.stringify({ media_fbid: "1002088839996" }),
      "attached_media[1]": JSON.stringify({ media_fbid: "1002088840149" }),
      "attached_media[2]": JSON.stringify({ media_fbid: "1002088840150" }),
    });
    expect(c.saved.map((s) => Object.keys(s)[0])).toEqual(["fbPhotoIds", "fbPhotoIds", "fbPhotoIds", "fbPostCreateStarted", "fbPostId"]);
    expect(out.receipt).toMatchObject({ postId: fbx.feedPost.id, photoIds: fbx.unpublishedPhotos.map((x: { id: string }) => x.id) });
  });

  it("one photo is a published photo post (post_id from /photos)", async () => {
    const f = new FakeFetch().on("POST", `${FB}/acct-1/photos`, { json: fbx.photoPost }).on("GET", `${FB}/${fbx.photoPost.post_id}`, { status: 500, json: { error: { message: "x" } } });
    const out = await facebookAdapter.publish!(req({ media: slide(1) }), ctx(f));
    expect(f.calls("POST", `${FB}/acct-1/photos`)[0]!.form).toMatchObject({ url: "https://cdn.example.com/signed/slide1.jpg", caption: req().caption, published: "true" });
    expect(out).toMatchObject({ remoteId: fbx.photoPost.post_id, remoteUrl: "https://www.facebook.com/acct-1/posts/200000000000002" });
  });

  it("a started feed post without a recorded id is never sent again; a definite refusal (4xx) clears the marker", async () => {
    const f = new FakeFetch();
    await expect(facebookAdapter.publish!(req(), ctx(f, { fbPostCreateStarted: true }))).rejects.toMatchObject({ opts: { details: { uncertain: true } } });
    expect(f.requests).toHaveLength(0);
    const refused = new FakeFetch().on("POST", `${FB}/acct-1/feed`, { status: 400, json: fbx.duplicateError });
    const state: Record<string, unknown> = {};
    await expect(facebookAdapter.publish!(req(), ctx(refused, state))).rejects.toMatchObject({ code: "PROVIDER_ERROR", message: expect.stringContaining("Duplicate status message") });
    expect(state.fbPostCreateStarted).toBeUndefined();
  });
});

describe("X: up to 4 images (one upload each, media_ids in order) and text-only", () => {
  const route = () =>
    new FakeFetch()
      .on("POST", "https://api.x.com/2/media/upload/initialize", ...xf.imageInitialize.map((j: unknown) => ({ json: j })))
      .on("POST", /\/2\/media\/upload\/\d+\/append$/, { status: 204 })
      .on("POST", /\/2\/media\/upload\/\d+\/finalize$/, { json: xf.imageFinalize })
      .on("POST", "https://api.x.com/2/tweets", { status: 201, json: xf.tweetCarousel });

  it("uploads each image as tweet_image and posts media_ids in slide order (no STATUS poll when FINALIZE has no processing_info)", async () => {
    const f = route();
    const c = ctx(f);
    const out = await xAdapter.publish!(req({ caption: "Three slides", items: slides(3, "image/png") }), c);
    expect(f.calls("POST", "https://api.x.com/2/media/upload/initialize").map((r) => (r.json as { media_category: string }).media_category)).toEqual(["tweet_image", "tweet_image", "tweet_image"]);
    expect(f.calls("GET", "https://api.x.com/2/media/upload?")).toHaveLength(0);
    expect(f.calls("POST", "https://api.x.com/2/tweets")[0]!.json).toEqual({ text: "Three slides", media: { media_ids: xf.imageInitialize.map((x: { data: { id: string } }) => x.data.id) } });
    expect(c.state).toMatchObject({ xMediaId: "1880000000000000011", xMediaId_2: "1880000000000000012", xMediaId_3: "1880000000000000013", xMediaReady_3: true, xTweetId: xf.tweetCarousel.data.id });
    expect(out.receipt).toMatchObject({ tweetId: xf.tweetCarousel.data.id, mediaIds: ["1880000000000000011", "1880000000000000012", "1880000000000000013"] });
  });

  it("a retry only uploads the images not yet uploaded", async () => {
    const f = new FakeFetch()
      .on("POST", "https://api.x.com/2/media/upload/initialize", { json: xf.imageInitialize[2] })
      .on("POST", /\/append$/, { status: 204 })
      .on("POST", /\/finalize$/, { json: xf.imageFinalize })
      .on("POST", "https://api.x.com/2/tweets", { status: 201, json: xf.tweetCarousel });
    await xAdapter.publish!(req({ items: slides(3) }), ctx(f, { xMediaId: "1880000000000000011", xMediaReady: true, xMediaId_2: "1880000000000000012", xMediaReady_2: true }));
    expect(f.calls("POST", "https://api.x.com/2/media/upload/initialize")).toHaveLength(1);
    expect((f.calls("POST", "https://api.x.com/2/tweets")[0]!.json as { media: { media_ids: string[] } }).media.media_ids).toEqual(["1880000000000000011", "1880000000000000012", "1880000000000000013"]);
  });

  it("refuses a 5th image with what to do, and video+image mixes, before any request", async () => {
    const f = new FakeFetch();
    await expect(xAdapter.publish!(req({ items: slides(5) }), ctx(f))).rejects.toMatchObject({ code: "VALIDATION_FAILED", opts: { userMessage: "X takes up to 4 images. Post the first 4, or post the carousel by hand." } });
    await expect(xAdapter.publish!(req({ items: [slide(1), { ...slide(2), kind: "video", mimeType: "video/mp4" }] }), ctx(f))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(f.requests).toHaveLength(0);
  });

  it("text-only posts just the text; a definite refusal clears the started marker", async () => {
    const f = new FakeFetch().on("POST", "https://api.x.com/2/tweets", { status: 201, json: xf.tweet });
    await xAdapter.publish!(req({ caption: "Just words" }), ctx(f));
    expect(f.calls("POST", "https://api.x.com/2/tweets")[0]!.json).toEqual({ text: "Just words" });
    const dup = new FakeFetch().on("POST", "https://api.x.com/2/tweets", { status: 403, json: { detail: "You are not allowed to create a Tweet with duplicate content.", status: 403 } });
    const state: Record<string, unknown> = {};
    await expect(xAdapter.publish!(req({ caption: "Just words" }), ctx(dup, state))).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(state.xTweetCreateStarted).toBeUndefined();
  });
});

describe("LinkedIn: one image or 2–20 images (Images API → Posts API content.multiImage)", () => {
  const route = (n: number) => {
    const f = new FakeFetch().on("POST", "https://api.linkedin.com/rest/images?action=initializeUpload", ...li.imageInitialize.slice(0, n).map((j: unknown) => ({ json: j })));
    for (const i of li.imageInitialize) f.on("PUT", i.value.uploadUrl, { status: 201, text: "" });
    return f.on("POST", "https://api.linkedin.com/rest/posts", { status: 201, text: "", headers: { "x-restli-id": li.multiImagePostUrn } });
  };

  it("initializes + uploads each image (bearer token, saved per image) and posts multiImage.images in order", async () => {
    const f = route(3);
    const c = ctx(f);
    const out = await linkedinAdapter.publish!(req({ items: slides(3, "image/png") }), c);
    const inits = f.calls("POST", "https://api.linkedin.com/rest/images?action=initializeUpload");
    expect(inits.map((r) => r.json)).toEqual([1, 2, 3].map(() => ({ initializeUploadRequest: { owner: "urn:li:person:acct-1" } })));
    expect(inits[0]!.headers).toMatchObject({ "linkedin-version": "202605", "x-restli-protocol-version": "2.0.0" });
    const put = f.calls("PUT", li.imageInitialize[0].value.uploadUrl)[0]!;
    expect(put.headers).toMatchObject({ authorization: "Bearer ACCESS", "content-type": "image/png" });
    expect(put.bodyBytes).toBe(Buffer.from("slide-1-bytes").length);
    const post = f.calls("POST", "https://api.linkedin.com/rest/posts")[0]!.json as Record<string, any>;
    expect(post.content).toEqual({ multiImage: { images: li.imageInitialize.map((x: { value: { image: string } }) => ({ id: x.value.image })) } });
    expect(post).toMatchObject({ author: "urn:li:person:acct-1", lifecycleState: "PUBLISHED", visibility: "PUBLIC" });
    expect(c.saved.slice(0, 3)).toEqual([{ liImageUrn_1: "urn:li:image:C4E10FIXTURE1" }, { liImageUrn_2: "urn:li:image:C4E10FIXTURE2" }, { liImageUrn_3: "urn:li:image:C4E10FIXTURE3" }]);
    expect(out).toMatchObject({ remoteId: li.multiImagePostUrn, receipt: { imageUrns: ["urn:li:image:C4E10FIXTURE1", "urn:li:image:C4E10FIXTURE2", "urn:li:image:C4E10FIXTURE3"] } });
  });

  it("one image is content.media with the image URN", async () => {
    const f = route(1);
    await linkedinAdapter.publish!(req({ media: slide(1) }), ctx(f));
    expect((f.calls("POST", "https://api.linkedin.com/rest/posts")[0]!.json as Record<string, any>).content).toEqual({ media: { id: "urn:li:image:C4E10FIXTURE1" } });
  });

  it("a retry skips images already uploaded; a 422 from the Posts API clears the started marker", async () => {
    const f = new FakeFetch()
      .on("POST", "https://api.linkedin.com/rest/images?action=initializeUpload", { json: li.imageInitialize[1] })
      .on("PUT", li.imageInitialize[1].value.uploadUrl, { status: 201, text: "" })
      .on("POST", "https://api.linkedin.com/rest/posts", { status: 422, json: li.invalidContent });
    const state: Record<string, unknown> = { liImageUrn_1: "urn:li:image:C4E10FIXTURE1" };
    await expect(linkedinAdapter.publish!(req({ items: slides(2) }), ctx(f, state))).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: false });
    expect(f.calls("POST", "https://api.linkedin.com/rest/images?action=initializeUpload")).toHaveLength(1);
    expect(state).toMatchObject({ liImageUrn_1: "urn:li:image:C4E10FIXTURE1", liImageUrn_2: "urn:li:image:C4E10FIXTURE2" });
    expect(state.liPostCreateStarted).toBeUndefined();
  });

  it("refuses more than 20 images, other formats and huge images before any request", async () => {
    const f = new FakeFetch();
    await expect(linkedinAdapter.publish!(req({ items: slides(21) }), ctx(f))).rejects.toMatchObject({ code: "VALIDATION_FAILED", opts: { userMessage: "LinkedIn takes up to 20 images in a post." } });
    await expect(linkedinAdapter.publish!(req({ items: [slide(1), slide(2, "image/webp")] }), ctx(f))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(linkedinAdapter.publish!(req({ items: [slide(1), slide(2, "image/png", { width: 8000, height: 6000 })] }), ctx(f))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(f.requests).toHaveLength(0);
  });
});

describe("TikTok and YouTube keep image posts manual; YouTube sets a custom thumbnail", () => {
  it("TikTok refuses photos and carousels with the honest reason", async () => {
    await expect(tiktokAdapter.publish!(req({ items: slides(3) }), ctx(new FakeFetch()))).rejects.toMatchObject({ code: "VALIDATION_FAILED", opts: { userMessage: expect.stringMatching(/verified with TikTok/) } });
    await expect(tiktokAdapter.publish!(req({ media: slide(1) }), ctx(new FakeFetch()))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  const VIDEO = Buffer.from("0123456789ABCDEF");
  const video: PublishMedia = { kind: "video", mimeType: "video/mp4", bytes: VIDEO.length, filename: "v.mp4", read: async () => VIDEO };
  const ytRoutes = () => new FakeFetch().on("POST", YOUTUBE_UPLOAD_URL, { status: 200, headers: { location: yt.sessionLocation } }).on("PUT", yt.sessionLocation, { status: 201, json: yt.video });

  it("YouTube refuses images", async () => {
    await expect(youtubeAdapter.publish!(req({ title: "x", items: slides(2) }), ctx(new FakeFetch()))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("thumbnails.set uploads the cover after the video (media upload, videoId) and records it", async () => {
    const f = ytRoutes().on("POST", YOUTUBE_THUMBNAIL_URL, { json: yt.thumbnailSet });
    const c = ctx(f);
    const out = await youtubeAdapter.publish!(req({ title: "Plan your week", media: video, thumbnail: slide(1) }), c);
    const t = f.calls("POST", YOUTUBE_THUMBNAIL_URL)[0]!;
    expect(Object.fromEntries(new URL(t.url).searchParams)).toEqual({ videoId: "FIXTUREvid01", uploadType: "media" });
    expect(t.headers).toMatchObject({ authorization: "Bearer ACCESS", "content-type": "image/jpeg" });
    expect(t.bodyBytes).toBe(Buffer.from("slide-1-bytes").length);
    expect(out).toMatchObject({ remoteId: "FIXTUREvid01", receipt: { thumbnail: "set", thumbnailUrl: yt.thumbnailSet.items[0].maxres.url } });
    expect(c.state.youtubeThumbnailSet).toBe(true);
  });

  it("a refused thumbnail (unverified channel) never fails the published video; it says what to do", async () => {
    const f = ytRoutes().on("POST", YOUTUBE_THUMBNAIL_URL, { status: 403, json: yt.thumbnailForbidden });
    const out = await youtubeAdapter.publish!(req({ title: "Plan your week", media: video, thumbnail: slide(1) }), ctx(f));
    expect(out).toMatchObject({ remoteId: "FIXTUREvid01", receipt: { thumbnail: "failed" } });
    expect(out.notes?.join(" ")).toMatch(/verified channel/);
  });
});
