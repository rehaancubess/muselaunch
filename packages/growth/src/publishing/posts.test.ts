import { AI_VOICE_CAPTION_LINE, COMPOSITION_SCHEMA_VERSION, type CompositionDoc, type MediaAsset } from "@muselaunch/contracts";
import { createTestPlatform, workspaceKey } from "@muselaunch/platform";
import { FakeFetch, growthFixture } from "@muselaunch/providers";
import { beforeAll, describe, expect, it } from "vitest";
import { postSnapshot, requestApproval } from "../approvals";
import { configureGrowth } from "../deps";
import { usePostCopyPack, usePostRender, createPost, manualPackage, postView, preflight, updatePost } from "./posts";
import { publishPostHandler } from "./publish-job";
import { calendar } from "./schedule";
import { captionLength, withAiVoiceLineFor } from "./media";

/**
 * Posts that carry a carousel's slides, a single still, or no media at all (text posts), and the
 * AI-voice caption line. Provider HTTP is a scripted fetch returning documented shapes from
 * fixtures/growth (labelled fixtures, not live output).
 */

const ig = growthFixture("instagram");
const xf = growthFixture("x");
const IG = "https://graph.instagram.com/v25.0";
const IG_MEDIA = /^https:\/\/graph\.instagram\.com\/v25\.0\/ig-1\/media$/;

const http = new FakeFetch()
  .on("POST", `${IG}/ig-1/media_publish`, { json: ig.carouselPublish })
  .on("POST", IG_MEDIA, ...ig.carouselItems.map((j: unknown) => ({ json: j })), { json: ig.carouselContainer })
  .on("GET", `${IG}/${ig.carouselContainer.id}`, { json: ig.carouselStatusFinished })
  .on("GET", `${IG}/${ig.carouselPublish.id}`, { json: ig.carouselMedia })
  .on("POST", "https://api.x.com/2/tweets", { status: 201, json: xf.tweet });

const p = createTestPlatform({}, { "publish.post": publishPostHandler });
const creds = { clientId: "cid", clientSecret: "csecret" };
configureGrowth(p, { fetch: http.fetch, sleep: async () => {}, claimValidator: null, settings: { creds: { instagram: creds, x: creds, tiktok: creds }, publishMaxPolls: 2, publishPollIntervalMs: 1 } });

const WID = "ws_posts";
const ws = p.db.ws(WID);
const actor = "alice";
let appId = "";
let campaignId = "";

const theme = { mode: "light" as const, background: "#FFFFFF", surface: "#FFFFFF", text: "#111111", textMuted: "#666666", accent: "#0A84FF", headingFont: "Inter", bodyFont: "Inter", radiusPx: 28 };
function doc(kind: CompositionDoc["kind"], scenes: number, audio: CompositionDoc["audio"] = []): CompositionDoc {
  return {
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    title: "Doc",
    kind,
    aspectRatio: kind === "video" ? "9:16" : "4:5",
    width: 1080,
    height: kind === "video" ? 1920 : 1350,
    fps: 30,
    theme,
    safeZone: { top: 0.08, bottom: 0.14, left: 0.05, right: 0.05 },
    scenes: Array.from({ length: scenes }, (_, i) => ({ id: `sc_${i + 1}`, name: `Slide ${i + 1}`, template: "slide-feature", durationSec: 1, background: { kind: "solid", color: "theme.background", angle: 180, dim: 0 }, transitionIn: { kind: "cut", durationSec: 0 }, layers: [] })),
    audio,
    captions: { enabled: false, preset: "boxed", position: "bottom", source: "script", cues: [] },
    meta: {},
  } as CompositionDoc;
}

async function composition(kind: CompositionDoc["kind"], scenes: number, opts: { audio?: CompositionDoc["audio"]; storyboardId?: string } = {}) {
  const comp = await ws.collection("compositions").create({ appId, campaignId, title: `${kind} comp`, kind, aspectRatio: kind === "video" ? "9:16" : "4:5", currentVersion: 1, latestVersion: 1, storyboardId: opts.storyboardId }, { actor });
  await ws.collection("compositionVersions").create({ id: `${comp.id}_v1`, compositionId: comp.id, version: 1, parentVersion: null, doc: doc(kind, scenes, opts.audio), source: "generated", summary: "v1", contentHash: `h-${comp.id}` }, { actor });
  return comp;
}

/** A final render the way the render worker's saveStills writes it: ast_r_<key>, ast_r_<key>_2, … with slide:<n> labels. */
async function stillRender(compositionId: string, version: number, slides: number, opts: { key?: string; mime?: string; sizes?: [number, number][] } = {}) {
  const key = opts.key ?? `k${compositionId.slice(-8)}v${version}`;
  const mime = opts.mime ?? "image/jpeg";
  const out: MediaAsset[] = [];
  // Written last-slide-first, so creation order can't be what puts them in order.
  for (let i = slides; i >= 1; i--) {
    const storagePath = workspaceKey(WID, "renders", compositionId, `v${version}-final-${key}-slide${i}.jpg`);
    await p.storage.put(storagePath, Buffer.from(`slide ${i} of ${key}`), { contentType: mime });
    const [w, h] = opts.sizes?.[i - 1] ?? [1080, 1350];
    out.unshift(
      await ws.collection("mediaAssets").create(
        { id: i === 1 ? `ast_r_${key}` : `ast_r_${key}_${i}`, appId, campaignId, kind: "image", role: "render", origin: "render", storagePath, mimeType: mime, bytes: 20, width: w, height: h, status: "ready", labels: [`slide:${i}`], render: { compositionId, version, quality: "final" } },
        { actor },
      ),
    );
  }
  return out;
}

async function videoRender(compositionId: string, version: number) {
  const storagePath = workspaceKey(WID, "renders", compositionId, `v${version}.mp4`);
  await p.storage.put(storagePath, Buffer.from("0123456789ABCDEF"), { contentType: "video/mp4" });
  return ws.collection("mediaAssets").create({ appId, campaignId, kind: "video", role: "render", origin: "render", storagePath, mimeType: "video/mp4", bytes: 16, status: "ready", render: { compositionId, version, quality: "final" } }, { actor });
}

async function account(provider: "instagram" | "x" | "tiktok", id: string) {
  await p.secrets.put(WID, `tok_${id}`, `oauth_${provider}`, { accessToken: "ACCESS", scope: [], extra: { username: "fixtureapps" } });
  return ws.collection("connectedAccounts").create({ provider, purposes: ["publishing"], externalAccountId: id, displayName: `@${id}`, status: "connected", capabilities: ["publish_image", "publish_video", "publish_text"], secretId: `tok_${id}`, connectedBy: actor }, { actor });
}

async function pack(channel: "x" | "instagram" | "threads" | "linkedin", caption: string) {
  return ws.collection("copyPacks").create({ appId, campaignId, channel, items: [{ id: "it_caption", kind: "caption", text: caption, claimIds: [] }], validation: { ok: true, issues: [], checkedAt: new Date().toISOString() } }, { actor });
}

async function approve(postId: string) {
  const post = await ws.collection("scheduledPosts").getOrThrow(postId);
  const { hash } = await postSnapshot(ws, post);
  const a = await requestApproval(ws, { appId, action: "publish", subject: { entity: "scheduledPosts", id: postId }, hash, summary: "test", actor });
  const ok = await ws.collection("approvals").update(a.id, { status: "approved", decidedBy: actor, decidedAt: new Date().toISOString() }, { actor });
  await ws.collection("scheduledPosts").update(postId, { approvalId: ok.id, status: "scheduled" }, { actor });
  return ok;
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await p.db.top("workspaces").set(WID, { id: WID, workspaceId: WID, name: "Posts", slug: "posts", ownerId: actor, planId: "free", spendCeilingUsd: 25, settings: { defaultTimezone: "UTC", defaultLocale: "en", metaDataMode: "standard" }, createdAt: now, updatedAt: now, createdBy: actor } as never);
  await ws.collection("members").create({ id: actor, userId: actor, email: "alice@example.com", role: "owner", canPublish: true, canManageAccounts: true, status: "active" }, { actor });
  appId = (await ws.collection("apps").create({ name: "Fixture Planner" } as never, { actor })).id;
  campaignId = (await ws.collection("campaigns").create({ appId, name: "Launch", goal: "launch" } as never, { actor })).id;
});

describe("createPost with a still composition: every slide of the final render, in slide order", () => {
  it("a 6-slide carousel gets all six slides (ast_r_<key>, _2 … _6), not just the first", async () => {
    const comp = await composition("carousel", 6);
    const slides = await stillRender(comp.id, 1, 6);
    const { post, preflight: pf } = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "linkedin", caption: "Six ways to plan", visibility: "public" }, actor);
    expect(post.assetIds).toEqual(slides.map((a) => a.id));
    expect(post.assetIds[1]).toBe(`${slides[0]!.id}_2`);
    expect(post).toMatchObject({ compositionVersion: 1, mode: "manual" });
    expect(post.manualInstructions.join(" ")).toMatch(/add the slides in order, 1 to 6/);
    expect(pf.errors).toEqual([]);
    const view = await postView(p, WID, post.id);
    expect(view.media).toMatchObject({ shape: "carousel", count: 6 });
    expect(view.media.items.map((i) => i.slide)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(view.media.items.map((i) => i.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("uses the newest version's slides (or the exact version asked for)", async () => {
    const comp = await composition("carousel", 3);
    await stillRender(comp.id, 1, 3, { key: "oldv1" });
    await ws.collection("compositionVersions").create({ id: `${comp.id}_v2`, compositionId: comp.id, version: 2, parentVersion: 1, doc: doc("carousel", 4), source: "user_edit", summary: "v2", contentHash: "h2" }, { actor });
    const v2 = await stillRender(comp.id, 2, 4, { key: "newv2" });
    const newest = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "linkedin", caption: "x", visibility: "public" }, actor);
    expect(newest.post).toMatchObject({ compositionVersion: 2, assetIds: v2.map((a) => a.id) });
    const v1 = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "linkedin", caption: "x", compositionVersion: 1, visibility: "public" }, actor);
    expect(v1.post.assetIds).toEqual(["ast_r_oldv1", "ast_r_oldv1_2", "ast_r_oldv1_3"]);
  });

  it("a single still (post / thumbnail) is one image; a video composition is its video", async () => {
    const still = await composition("static", 1);
    const [one] = await stillRender(still.id, 1, 1);
    expect((await createPost(p, WID, appId, { campaignId, compositionId: still.id, channel: "linkedin", caption: "One image", visibility: "public" }, actor)).post.assetIds).toEqual([one!.id]);
    const video = await composition("video", 2);
    const mp4 = await videoRender(video.id, 1);
    expect((await createPost(p, WID, appId, { campaignId, compositionId: video.id, channel: "linkedin", caption: "A video", visibility: "public" }, actor)).post.assetIds).toEqual([mp4.id]);
  });

  it("says plainly when the slides aren't finished yet", async () => {
    const comp = await composition("carousel", 3);
    await expect(createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "instagram", caption: "x", visibility: "public" }, actor)).rejects.toMatchObject({ code: "CONFLICT", opts: { userMessage: "Finish the slides first (final render), then schedule them." } });
  });
});

describe("text-only posts (copy pack, no composition)", () => {
  it("X from a copy pack: no media, caption from the pack, manual steps say copy and paste", async () => {
    const pk = await pack("x", "We shipped dark mode. Try it tonight.");
    const { post, preflight: pf } = await createPost(p, WID, appId, { campaignId, copyPackId: pk.id, channel: "x", visibility: "public" }, actor);
    expect(post).toMatchObject({ assetIds: [], caption: "We shipped dark mode. Try it tonight.", copyPackId: pk.id, mode: "manual" });
    expect(post.manualInstructions.join(" ")).toMatch(/Copy the post text/);
    expect(pf.errors).toEqual([]);
    const view = await postView(p, WID, post.id);
    expect(view.media).toMatchObject({ shape: "text", count: 0, items: [], rules: { needsMedia: false, captionLimit: 280 } });
    const cal = await calendar(ws, appId, {}, "UTC");
    expect(cal.unscheduled.find((i) => i.id === post.id)).toMatchObject({ textOnly: true, mediaCount: 0, thumbnailAssetId: undefined });
  });

  it("is refused on channels that need media, and when the copy pack is for another channel", async () => {
    const pk = await pack("x", "Short and sweet");
    await expect(createPost(p, WID, appId, { campaignId, copyPackId: pk.id, channel: "instagram", visibility: "public" }, actor)).rejects.toMatchObject({ code: "BAD_REQUEST", opts: { userMessage: "This text was written for X. Pick the Instagram text, or write a caption." } });
    const igPack = await pack("instagram", "Caption");
    await expect(createPost(p, WID, appId, { campaignId, copyPackId: igPack.id, channel: "instagram", visibility: "public" }, actor)).rejects.toMatchObject({ code: "BAD_REQUEST", opts: { userMessage: expect.stringMatching(/^Instagram needs an image, a carousel or a video\. A text-only post can go to X/) } });
  });

  it("publishes through the X API with only the text (no media requests)", async () => {
    const acc = await account("x", "x-1");
    const pk = await pack("x", "Text only, through the API.");
    const { post } = await createPost(p, WID, appId, { campaignId, copyPackId: pk.id, channel: "x", accountId: acc.id, visibility: "public" }, actor);
    expect(post.mode).toBe("api");
    const approval = await approve(post.id);
    const job = await p.jobs.create(WID, "publish.post", { scheduledPostId: post.id, approvalId: approval.id }, { actor });
    await p.inline!.drain();
    expect((await p.jobs.get(WID, job.id))!.status).toBe("succeeded");
    expect(http.calls("POST", "https://api.x.com/2/media/upload/initialize")).toHaveLength(0);
    expect(http.calls("POST", "https://api.x.com/2/tweets").at(-1)!.json).toEqual({ text: "Text only, through the API." });
    expect((await ws.collection("scheduledPosts").getOrThrow(post.id)).status).toBe("published");
  });
});

describe("preflight: what each channel takes, in plain words", () => {
  it("X takes up to 4 images through the API: says what to do; trimming to 4 clears it", async () => {
    const acc = await account("x", "x-2");
    const comp = await composition("carousel", 6);
    await stillRender(comp.id, 1, 6);
    const { post, preflight: pf } = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "x", accountId: acc.id, caption: "Six slides", visibility: "public" }, actor);
    expect(post.mode).toBe("api");
    expect(pf.errors).toContain("X takes up to 4 images. Post the first 4, or post the carousel by hand.");
    const trimmed = await updatePost(p, WID, post.id, { assetIds: post.assetIds.slice(0, 4) }, actor);
    expect(trimmed.preflight.errors).toEqual([]);
    expect(trimmed.post.mode).toBe("api");
  });

  it("Instagram API: JPEG only, at most 10 slides, mixed shapes warned (cropped to the first)", async () => {
    const acc = await account("instagram", "ig-1");
    const png = await composition("carousel", 3);
    await stillRender(png.id, 1, 3, { mime: "image/png" });
    // Files the API can't take at all: posted by hand, with the reason (approval can go ahead).
    const a = await createPost(p, WID, appId, { campaignId, compositionId: png.id, channel: "instagram", accountId: acc.id, caption: "PNG slides", visibility: "public" }, actor);
    expect(a.post.mode).toBe("manual");
    expect(a.post.manualInstructions[0]).toBe("Why manual: Instagram takes JPEG images only through its API. All 3 slides are PNG.");
    expect(a.preflight.errors).toEqual([]);
    // An API post whose files changed behind it is still caught before publishing.
    const forced = await ws.collection("scheduledPosts").update(a.post.id, { mode: "api" }, { actor });
    expect((await preflight(ws, forced)).errors).toContain("Instagram takes JPEG images only through its API. All 3 slides are PNG. Post it by hand instead.");

    const long = await composition("carousel", 12);
    await stillRender(long.id, 1, 12);
    const b = await createPost(p, WID, appId, { campaignId, compositionId: long.id, channel: "instagram", accountId: acc.id, caption: "Twelve", visibility: "public" }, actor);
    expect(b.preflight.errors).toContain("Instagram takes up to 10 images. Post the first 10, or post the carousel by hand.");

    const mixed = await composition("carousel", 3);
    await stillRender(mixed.id, 1, 3, { sizes: [[1080, 1350], [1080, 1080], [1080, 1350]] });
    const c = await createPost(p, WID, appId, { campaignId, compositionId: mixed.id, channel: "instagram", accountId: acc.id, caption: "Mixed", visibility: "public" }, actor);
    expect(c.preflight.errors).toEqual([]);
    expect(c.preflight.warnings).toContain("Instagram crops every slide to the shape of the first one. Slide 2 has a different shape and will be cropped.");
  });

  it("TikTok carousels go manual with the honest reason (verified URL prefix), and the photo-mode steps", async () => {
    const acc = await account("tiktok", "tt-1");
    const comp = await composition("carousel", 3);
    await stillRender(comp.id, 1, 3);
    const { post, preflight: pf } = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "tiktok", accountId: acc.id, caption: "Photos", visibility: "public" }, actor);
    expect(post.mode).toBe("manual");
    expect(post.manualInstructions[0]).toMatch(/^Why manual: TikTok photo posts through the API need a web address verified with TikTok/);
    expect(post.manualInstructions.join(" ")).toMatch(/Photos \(photo mode\) and select the slides in order/);
    expect(pf.errors).toEqual([]);
  });

  it("YouTube needs a video; a manual X carousel over 4 only warns (the person can split it)", async () => {
    const comp = await composition("carousel", 3);
    const slides = await stillRender(comp.id, 1, 3);
    const yt = await createPost(p, WID, appId, { campaignId, assetIds: slides.map((s) => s.id), channel: "youtube", title: "x", caption: "x", visibility: "public" }, actor);
    expect(yt.preflight.errors[0]).toMatch(/^YouTube needs a video/);
    const six = await composition("carousel", 6);
    await stillRender(six.id, 1, 6);
    const x = await createPost(p, WID, appId, { campaignId, compositionId: six.id, channel: "x", caption: "x", visibility: "public" }, actor);
    expect(x.post.mode).toBe("manual");
    expect(x.preflight.errors).toEqual([]);
    expect(x.preflight.warnings).toContain("X takes up to 4 images in one post. Keep the first 4, or split the slides into two posts.");
    expect(x.post.manualInstructions.join(" ")).toMatch(/attach slides 1 to 4 in order, or split the 6 slides into a thread/);
  });

  it("an emptied post on a media channel is refused; on X it becomes a text post", async () => {
    const comp = await composition("static", 1);
    const [one] = await stillRender(comp.id, 1, 1);
    const ig1 = await createPost(p, WID, appId, { campaignId, assetIds: [one!.id], channel: "instagram", caption: "x", visibility: "public" }, actor);
    await expect(updatePost(p, WID, ig1.post.id, { assetIds: [] }, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const x1 = await createPost(p, WID, appId, { campaignId, assetIds: [one!.id], channel: "x", caption: "Words", visibility: "public" }, actor);
    const emptied = await updatePost(p, WID, x1.post.id, { assetIds: [] }, actor);
    expect(emptied.post.assetIds).toEqual([]);
    expect(emptied.preflight.errors).toEqual([]);
  });
});

describe("publish job: a carousel's slides go to the adapter as ordered items", () => {
  it("Instagram carousel: one item container per slide (signed URLs, in order), then CAROUSEL, then media_publish", async () => {
    const acc = (await ws.collection("connectedAccounts").list({ limit: 50 })).items.find((a) => a.externalAccountId === "ig-1")!;
    const comp = await composition("carousel", 3);
    const slides = await stillRender(comp.id, 1, 3);
    const { post, preflight: pf } = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "instagram", accountId: acc.id, caption: "Three slides", visibility: "public" }, actor);
    expect(pf.errors).toEqual([]);
    const approval = await approve(post.id);
    const before = http.calls("POST", IG_MEDIA).length;
    const job = await p.jobs.create(WID, "publish.post", { scheduledPostId: post.id, approvalId: approval.id }, { actor });
    await p.inline!.drain();
    expect((await p.jobs.get(WID, job.id))!.status).toBe("succeeded");
    const creates = http.calls("POST", IG_MEDIA).slice(before);
    expect(creates).toHaveLength(4);
    // Each item URL is the signed URL of that slide's own file, in slide order.
    // Local signed URLs carry the storage key as base64url JSON ({"k": key, ...}) before the signature.
    const keyOf = (url: string) => JSON.parse(Buffer.from(new URL(url).pathname.split("/").pop()!.split(".")[0]!, "base64url").toString("utf8")).k as string;
    expect(creates.slice(0, 3).map((r) => keyOf(r.form!.image_url!))).toEqual(slides.map((s) => s.storagePath));
    expect(creates.slice(0, 3).every((r) => r.form!.is_carousel_item === "true")).toBe(true);
    expect(creates[3]!.form).toMatchObject({ media_type: "CAROUSEL", caption: "Three slides" });
    const done = await ws.collection("scheduledPosts").getOrThrow(post.id);
    expect(done.status).toBe("published");
    expect(done.publishState).toMatchObject({ igCarouselId: ig.carouselContainer.id, igMediaId: ig.carouselPublish.id });
    const pub = await ws.collection("publications").getOrThrow(done.publicationId!);
    expect(pub).toMatchObject({ mode: "api", remoteId: ig.carouselPublish.id, remoteUrl: ig.carouselMedia.permalink, receipt: expect.objectContaining({ carouselItemIds: ig.carouselItems.map((x: { id: string }) => x.id) }) });
  });

  it("manual package numbers the slide files in posting order", async () => {
    const comp = await composition("carousel", 3);
    await stillRender(comp.id, 1, 3);
    const { post } = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "threads", caption: "x", visibility: "public" }, actor);
    const pkg = await manualPackage(p, WID, post.id);
    expect(pkg.downloads.map((d) => d.filename)).toEqual(["threads-slide-01.jpg", "threads-slide-02.jpg", "threads-slide-03.jpg"]);
    expect(pkg.instructions.join(" ")).toMatch(/attach the slides in order, 1 to 3/);
  });
});

describe("AI-voice disclosure (external TTS voiceover)", () => {
  const tts = (assetId: string): CompositionDoc["audio"] => [{ id: "au_vo", kind: "voiceover", assetId, startSec: 0, trimInSec: 0, volume: 0.9, fadeInSec: 0, fadeOutSec: 0.5, duckUnderVoice: true, sourceLabel: "external_tts" }];

  it("withAiVoiceLineFor: once, at the end, within X's 280 weighted characters ([APP_LINK] counts as a 23-char URL)", () => {
    const short = withAiVoiceLineFor("x", "Plan your week in 15 seconds.");
    expect(short).toBe(`Plan your week in 15 seconds.\n\n${AI_VOICE_CAPTION_LINE}`);
    expect(withAiVoiceLineFor("x", short)).toBe(short);
    const long = `${"Plan every day with less effort and more focus. ".repeat(6)}Get it: [APP_LINK]`;
    const out = withAiVoiceLineFor("x", long);
    expect(out.endsWith(AI_VOICE_CAPTION_LINE)).toBe(true);
    expect(captionLength("x", out)).toBeLessThanOrEqual(280);
    const near = `${"a".repeat(240)} [APP_LINK]`;
    const kept = withAiVoiceLineFor("x", near);
    expect(captionLength("x", kept)).toBeLessThanOrEqual(280);
    expect(kept).not.toMatch(/\[[A-Z_]*…/);
    expect(captionLength("instagram", withAiVoiceLineFor("instagram", "b".repeat(2200)))).toBe(2200);
  });

  it("createPost adds the line once and sets containsSyntheticMedia; a founder recording doesn't", async () => {
    const voice = await ws.collection("mediaAssets").create({ appId, kind: "audio", role: "tts", origin: "generated", storagePath: workspaceKey(WID, "tts", "vo.mp3"), mimeType: "audio/mpeg", bytes: 10, status: "ready", sourceLabel: "external_tts", labels: ["external_tts", "ai_voice"] }, { actor });
    const comp = await composition("video", 2, { audio: tts(voice.id) });
    await videoRender(comp.id, 1);
    const { post } = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "x", caption: "Plan your week in 15 seconds.", visibility: "public" }, actor);
    expect(post.caption).toBe(`Plan your week in 15 seconds.\n\n${AI_VOICE_CAPTION_LINE}`);
    expect(post.containsSyntheticMedia).toBe(true);

    const founder = await composition("video", 2, { audio: [{ ...tts(voice.id)[0]!, sourceLabel: "founder_recording" }] });
    await ws.collection("mediaAssets").update(voice.id, { sourceLabel: undefined, labels: [], role: "voiceover" }, { actor });
    await videoRender(founder.id, 1);
    const own = await createPost(p, WID, appId, { campaignId, compositionId: founder.id, channel: "x", caption: "My own voice.", visibility: "public" }, actor);
    expect(own.post.caption).toBe("My own voice.");
    expect(own.post.containsSyntheticMedia).toBe(false);
  });

  it("a storyboard voiceover source 'tts' counts when the video has a voice track", async () => {
    const sb = await ws.collection("storyboards").create({ appId, campaignId, variantId: "var_1", title: "SB", aspectRatio: "9:16", targetDurationSec: 10, scenes: [{ id: "sbs_1", order: 0, purpose: "hook", durationSec: 3, onScreenText: "Hook", visual: "x", template: "hook-title" }], voiceover: { source: "tts", script: "Hello" } } as never, { actor });
    const voice = await ws.collection("mediaAssets").create({ appId, kind: "audio", role: "voiceover", origin: "generated", storagePath: workspaceKey(WID, "tts", "vo2.mp3"), mimeType: "audio/mpeg", bytes: 10, status: "ready" }, { actor });
    const comp = await composition("video", 2, { storyboardId: sb.id, audio: [{ ...tts(voice.id)[0]!, sourceLabel: "generated" }] });
    await videoRender(comp.id, 1);
    const { post } = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "linkedin", caption: "Watch", visibility: "public" }, actor);
    expect(post.caption.endsWith(AI_VOICE_CAPTION_LINE)).toBe(true);
  });

  it("a rewritten caption (copy pack) keeps the line; a new render with a voice adds it", async () => {
    const voice = await ws.collection("mediaAssets").create({ appId, kind: "audio", role: "tts", origin: "generated", storagePath: workspaceKey(WID, "tts", "vo3.mp3"), mimeType: "audio/mpeg", bytes: 10, status: "ready", sourceLabel: "external_tts" }, { actor });
    const comp = await composition("video", 2, { audio: tts(voice.id) });
    await videoRender(comp.id, 1);
    const { post } = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "x", caption: "First words", visibility: "public" }, actor);
    const rewritten = await pack("x", "Second words, rewritten by Muse.");
    const after = await usePostCopyPack(p, WID, post.id, rewritten.id, actor);
    expect(after.post.caption).toBe(`Second words, rewritten by Muse.\n\n${AI_VOICE_CAPTION_LINE}`);

    // A silent video gets a voice in v2: the post using the new render discloses it.
    const silent = await composition("video", 2);
    await videoRender(silent.id, 1);
    const p2 = await createPost(p, WID, appId, { campaignId, compositionId: silent.id, channel: "x", caption: "No voice yet", visibility: "public" }, actor);
    expect(p2.post.caption).toBe("No voice yet");
    await ws.collection("compositionVersions").create({ id: `${silent.id}_v2`, compositionId: silent.id, version: 2, parentVersion: 1, doc: doc("video", 2, tts(voice.id)), source: "ai_edit", summary: "voice", contentHash: "hv2" }, { actor });
    const v2 = await videoRender(silent.id, 2);
    const used = await usePostRender(p, WID, p2.post.id, { assetId: v2.id, compositionVersion: 2 }, actor);
    expect(used.post).toMatchObject({ assetIds: [v2.id], compositionVersion: 2, caption: `No voice yet\n\n${AI_VOICE_CAPTION_LINE}`, containsSyntheticMedia: true });
  });

  it("usePostRender on a still post brings every slide of the new render", async () => {
    const comp = await composition("carousel", 3);
    await stillRender(comp.id, 1, 3, { key: "rv1" });
    const { post } = await createPost(p, WID, appId, { campaignId, compositionId: comp.id, channel: "linkedin", caption: "x", visibility: "public" }, actor);
    await ws.collection("compositionVersions").create({ id: `${comp.id}_v2`, compositionId: comp.id, version: 2, parentVersion: 1, doc: doc("carousel", 4), source: "ai_edit", summary: "v2", contentHash: "hr2" }, { actor });
    const v2 = await stillRender(comp.id, 2, 4, { key: "rv2" });
    const used = await usePostRender(p, WID, post.id, { assetId: v2[0]!.id, compositionVersion: 2 }, actor);
    expect(used.post.assetIds).toEqual(v2.map((a) => a.id));
    expect((await preflight(ws, used.post)).errors).toEqual([]);
  });
});
