import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Storyboard, StoryboardScene } from "@muselaunch/contracts";
import { createTestPlatform, type HandlerRegistry, type JobContext, type Platform } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { brollTargets, imageSizeFor } from "./broll";
import { ffmpeg, probeMedia } from "./ffmpeg";
import { handlers } from "./index";
import { loadFixture } from "./testing";
import { installMediaDeps } from "./util";

// biome-ignore lint: loose fixture JSON
type Json = any;

/**
 * storyboard.resolve_media against LABELLED fixtures in the documented Pexels / Openverse / OpenAI
 * Images response shapes (fixtures/media/*.json); downloads are local synthetic files. No network.
 */

const dir = mkdtempSync(join(tmpdir(), "broll-test-"));
const VIDEO = join(dir, "portrait.mp4");
const JPG = join(dir, "photo.jpg");

const pexelsVideos = loadFixture<{ response: Json }>("pexels-videos-search.json").response;
const pexelsPhotos = loadFixture<{ response: Json }>("pexels-photos-search.json").response;
const openverse = loadFixture<{ response: Json }>("openverse-search.json").response;
const imagesFx = loadFixture<{ response: Json }>("openai-images-generate.json").response;

beforeAll(async () => {
  // 1216x2160 portrait (above 1080p), 6 s, 10 fps, with an audio track that must be dropped.
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1216x2160:r=10:d=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", VIDEO]);
  await ffmpeg(["-f", "lavfi", "-i", "color=c=orange:s=400x600", "-frames:v", "1", JPG]);
}, 60_000);

/** Fake provider HTTP: Pexels (videos + photos), Openverse, OpenAI Images. `empty` queries return no results. */
function fakeProviders(opts: { empty?: RegExp } = {}) {
  const calls: string[] = [];
  const downloads: string[] = [];
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const u = new URL(url);
    const q = u.searchParams.get("q") ?? u.searchParams.get("query") ?? "";
    if (u.hostname === "api.pexels.com") {
      if (u.pathname === "/videos/search") return json(opts.empty?.test(q) ? { ...pexelsVideos, videos: [] } : pexelsVideos);
      const v = u.pathname.match(/^\/videos\/videos\/(\d+)$/);
      if (v) return json(pexelsVideos.videos.find((x: Json) => String(x.id) === v[1]));
      if (u.pathname === "/v1/search") return json(opts.empty?.test(q) ? { ...pexelsPhotos, photos: [] } : pexelsPhotos);
      const ph = u.pathname.match(/^\/v1\/photos\/(\d+)$/);
      if (ph) return json(pexelsPhotos.photos.find((x: Json) => String(x.id) === ph[1]));
    }
    if (u.hostname === "api.openverse.org") {
      const m = u.pathname.match(/^\/v1\/images\/([^/]+)\/$/);
      if (m) return json(openverse.results.find((r: Json) => r.id === m[1]));
      return json(opts.empty?.test(q) ? { ...openverse, results: [], page_count: 0 } : openverse);
    }
    if (url.startsWith("https://api.openai.com/v1/images/generations")) return json(imagesFx);
    return json({ error: { message: `fixture server: no route for ${url}` } }, 404);
  }) as typeof fetch;
  return {
    calls,
    downloads,
    deps: {
      fetch: fetchImpl,
      download: async (url: string) => {
        downloads.push(url);
        return url.includes("videos.pexels.com") ? { body: readFileSync(VIDEO), contentType: "video/mp4", url } : { body: readFileSync(JPG), contentType: "application/octet-stream", url };
      },
    },
  };
}

function setup(cfg: Record<string, string>, wid: string) {
  const builds: { storyboardId: string; compositionId: string }[] = [];
  const registry: HandlerRegistry = {
    ...handlers,
    // Module C's builder is not under test: record the hand-off.
    "composition.build": async (ctx: JobContext<"composition.build">) => {
      builds.push({ storyboardId: ctx.payload.storyboardId, compositionId: ctx.payload.compositionId });
      return { creditsUsed: 2 };
    },
  };
  const p = createTestPlatform(cfg, registry);
  return { p, builds, ws: p.db.ws(wid) };
}

const scene = (i: number, durationSec: number, assets: StoryboardScene["assets"], template = "text-over-media"): StoryboardScene => ({
  id: `sbs_${i}`,
  order: i,
  purpose: i === 0 ? "hook" : "other",
  durationSec,
  onScreenText: `Scene ${i + 1}`,
  narration: "",
  visual: "lifestyle",
  template,
  assets,
  claimIds: [],
});

async function storyboard(p: Platform, wid: string, scenes: StoryboardScene[], extra: Partial<Storyboard> = {}): Promise<Storyboard> {
  return p.db.ws(wid).collection("storyboards").create(
    { appId: "app_focus", campaignId: "cmp_exam", variantId: "var_1", title: "Calm focus", aspectRatio: "9:16", targetDurationSec: 15, scenes, voiceover: { source: "none" }, music: {}, ...extra },
    { actor: "u1" },
  );
}

async function run(p: Platform, wid: string, sb: Storyboard, key: string) {
  const job = await p.jobs.create(wid, "storyboard.resolve_media", { appId: sb.appId, storyboardId: sb.id, compositionId: `cmp_${sb.id}` }, { actor: "u1", appId: sb.appId, idempotencyKey: key });
  await p.inline!.drain();
  return (await p.jobs.get(wid, job.id))!;
}

describe("storyboard.resolve_media (lifestyle b-roll)", () => {
  it("attaches ranked, deduped, licensed stock + a labelled AI still, trims video to the scene, charges per item, then builds", async () => {
    const wid = "ws_broll";
    const { p, builds, ws } = setup({ PEXELS_API_KEY: "pexels-test-key", OPENAI_API_KEY: "sk-test" }, wid);
    await p.credits.ensureAccount(wid, { grant: 100, reason: "test" });
    const fake = fakeProviders();
    installMediaDeps(p, fake.deps);
    const sb = await storyboard(p, wid, [
      scene(0, 3, [{ kind: "stock_video", query: "student studying at a desk with headphones" }], "hook-title"),
      scene(1, 4, [{ kind: "screenshot", assetId: "ast_real_shot" }], "device-demo"),
      scene(2, 4, [{ kind: "stock_video", query: "student studying at a desk with headphones" }]),
      scene(3, 2, [{ kind: "stock_image", query: "warm desk lamp on a wooden desk in the evening" }]),
      scene(4, 2, [{ kind: "generated_image", query: "abstract soft gradient of a calm evening sky" }]),
      scene(5, 2, [{ kind: "generated_image", query: "A screenshot of my app's home screen" }]),
    ]);
    const before = (await p.credits.balance(wid)).available;
    const job = await run(p, wid, sb, "r1");
    expect(job.status).toBe("succeeded");

    const after = await ws.collection("storyboards").getOrThrow(sb.id);
    const hint = (i: number) => after.scenes[i]!.assets[0]!;
    // Real product hints are untouched.
    expect(hint(1)).toEqual({ kind: "screenshot", assetId: "ast_real_shot" });

    // Scene 1: the portrait Pexels clip ≥ scene length ranks first (landscape and short ones lose).
    const clipA = await ws.collection("mediaAssets").getOrThrow(hint(0).assetId!);
    expect(clipA).toMatchObject({
      kind: "video",
      role: "stock_video",
      origin: "stock",
      sourceLabel: "stock",
      isProductTruth: false,
      hasAudio: false,
      status: "ready",
      license: { type: "stock_license", provider: "Pexels", attribution: "Video by Example Creator on Pexels", sourceUrl: "https://www.pexels.com/video/student-studying-at-a-desk-with-headphones-6394054/", termsUrl: "https://www.pexels.com/license/" },
    });
    expect(clipA.labels).toContain("broll");
    // ≤1080p (the 1216x2160 source is scaled down), no audio, trimmed to scene + 1 s.
    const local = join(dir, "check.mp4");
    await p.storage.downloadToFile(clipA.storagePath, local);
    const info = await probeMedia(local);
    expect(info.hasAudio).toBe(false);
    expect(info.videoCodec).toBe("h264");
    expect(Math.max(info.width!, info.height!)).toBeLessThanOrEqual(1920);
    expect(Math.min(info.width!, info.height!)).toBeLessThanOrEqual(1080);
    expect(info.height! > info.width!).toBe(true);
    expect(info.durationSec!).toBeLessThanOrEqual(4.05);
    expect(clipA.posterAssetId).toBeTruthy();
    expect(await ws.collection("mediaAssets").getOrThrow(clipA.posterAssetId!)).toMatchObject({ role: "thumbnail", license: { provider: "Pexels" } });
    // Downloaded the ≤1920 rendition, never the 4K one.
    expect(fake.downloads).toContain("https://videos.pexels.com/video-files/6394054/6394054-hd_1080_1920_25fps.mp4");
    expect(fake.downloads.some((u) => u.includes("uhd_2160"))).toBe(false);

    // Scene 3: same query → a DIFFERENT clip (dedupe within the storyboard).
    const clipB = await ws.collection("mediaAssets").getOrThrow(hint(2).assetId!);
    expect(clipB.id).not.toBe(clipA.id);
    expect(clipB.role).toBe("stock_video");

    // Scene 4: stock photo with licence + attribution.
    const photo = await ws.collection("mediaAssets").getOrThrow(hint(3).assetId!);
    expect(photo).toMatchObject({ kind: "image", role: "stock_image", origin: "stock", isProductTruth: false, mimeType: "image/jpeg" });
    expect(photo.license?.attribution).toBeTruthy();
    expect(photo.license?.sourceUrl).toMatch(/^https:\/\//);

    // Scene 5: AI still via the chosen provider (OpenAI), labelled, with the no-UI guard applied.
    const gen = await ws.collection("mediaAssets").getOrThrow(hint(4).assetId!);
    expect(gen).toMatchObject({ role: "generated_image", origin: "generated", sourceLabel: "ai_generated_image", isProductTruth: false, license: { type: "generated_terms", provider: "OpenAI Images" } });
    expect(gen.generation?.prompt).toBe("abstract soft gradient of a calm evening sky");

    // Scene 6: a prompt for the app's UI is refused and left empty, with the reason for the Studio.
    expect(hint(5).assetId).toBeUndefined();
    expect(hint(5).unresolved).toMatch(/interface/);

    // Credits: 3 stock downloads × 1 + 1 image × 6, charged per item.
    const data = job.output!.data as Json;
    expect(data.creditsCharged).toBe(9);
    expect(before - (await p.credits.balance(wid)).available).toBe(9 + 2); // + the composition build
    expect(data.unresolved).toHaveLength(1);
    expect(data.warnings.join(" ")).toMatch(/Scene 6/);
    // The build follows, with the same composition id.
    expect(builds).toEqual([{ storyboardId: sb.id, compositionId: `cmp_${sb.id}` }]);
    expect(data.buildJobId).toBeTruthy();
    // Every provider call is a metered usage event.
    const usage = (await ws.collection("modelUsage").list({ where: [["jobId", "==", job.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 })).items;
    expect(usage.some((u) => u.provider === "stock")).toBe(true);
    expect(usage.some((u) => u.provider === "openai")).toBe(true);

    // Idempotent: running again attaches nothing new, downloads nothing, charges nothing.
    const downloads = fake.downloads.length;
    const balance = (await p.credits.balance(wid)).available;
    const again = await run(p, wid, sb, "r2");
    expect(again.status).toBe("succeeded");
    expect(fake.downloads).toHaveLength(downloads);
    expect((await p.credits.balance(wid)).available).toBe(balance);
    expect((await ws.collection("storyboards").getOrThrow(sb.id)).scenes.map((s) => s.assets[0]?.assetId)).toEqual(after.scenes.map((s) => s.assets[0]?.assetId));
  }, 120_000);

  it("is honest without providers or results: photo instead of video (noted), empty hints with reasons, still builds", async () => {
    const wid = "ws_broll_bare";
    // No Pexels/Pixabay key (Openverse only), no image provider.
    const { p, builds, ws } = setup({}, wid);
    await p.credits.ensureAccount(wid, { grant: 50, reason: "test" });
    const fake = fakeProviders({ empty: /underwater/ });
    installMediaDeps(p, fake.deps);
    const sb = await storyboard(p, wid, [
      scene(0, 3, [{ kind: "stock_video", query: "phone on a desk" }]),
      scene(1, 3, [{ kind: "stock_image", query: "underwater coral reef" }]),
      scene(2, 3, [{ kind: "generated_image", query: "soft gradient backdrop" }]),
    ]);
    const job = await run(p, wid, sb, "bare");
    expect(job.status).toBe("succeeded");
    const after = await ws.collection("storyboards").getOrThrow(sb.id);
    // Stock video needs a key: an Openverse CC photo is used instead, and the hint says so by kind.
    const a0 = after.scenes[0]!.assets[0]!;
    expect(a0.kind).toBe("stock_image");
    expect(await ws.collection("mediaAssets").getOrThrow(a0.assetId!)).toMatchObject({ role: "stock_image", license: { type: "creative_commons", provider: "Openverse (Creative Commons)" } });
    expect(fake.calls.some((u) => u.includes("pexels") || u.includes("pixabay"))).toBe(false);
    // No result → empty hint with the reason.
    expect(after.scenes[1]!.assets[0]).toMatchObject({ kind: "stock_image" });
    expect(after.scenes[1]!.assets[0]!.assetId).toBeUndefined();
    expect(after.scenes[1]!.assets[0]!.unresolved).toMatch(/No stock photo matched/);
    // No image provider → empty hint, nothing generated or faked.
    expect(after.scenes[2]!.assets[0]!.assetId).toBeUndefined();
    expect(after.scenes[2]!.assets[0]!.unresolved).toMatch(/isn't connected/);
    expect(fake.calls.some((u) => u.includes("openai"))).toBe(false);
    const data = job.output!.data as Json;
    expect(data.warnings.join(" ")).toMatch(/Pexels or Pixabay API key/);
    expect(builds).toHaveLength(1);
  }, 60_000);

  it("never spends the build's credits on b-roll, and refuses another app's or workspace's storyboard", async () => {
    const wid = "ws_broll_poor";
    const { p, builds, ws } = setup({}, wid);
    await p.credits.ensureAccount(wid, { grant: 2, reason: "test" }); // exactly the build
    const fake = fakeProviders();
    installMediaDeps(p, fake.deps);
    const sb = await storyboard(p, wid, [scene(0, 3, [{ kind: "stock_image", query: "phone on a desk" }])]);
    const job = await run(p, wid, sb, "poor");
    expect(job.status).toBe("succeeded");
    const h = (await ws.collection("storyboards").getOrThrow(sb.id)).scenes[0]!.assets[0]!;
    expect(h.assetId).toBeUndefined();
    expect(h.unresolved).toMatch(/Not enough credits/);
    expect(fake.downloads).toHaveLength(0);
    expect(builds).toHaveLength(1);
    expect((await p.credits.balance(wid)).available).toBe(0);

    // Wrong app → refused; another workspace can't see the storyboard at all.
    const wrongApp = await p.jobs.create(wid, "storyboard.resolve_media", { appId: "app_other", storyboardId: sb.id, compositionId: "cmp_x" }, { actor: "u1", idempotencyKey: "wrong-app" });
    const otherWs = await p.jobs.create("ws_intruder", "storyboard.resolve_media", { appId: sb.appId, storyboardId: sb.id, compositionId: "cmp_x" }, { actor: "u2", idempotencyKey: "intruder" });
    await p.inline!.drain();
    expect(await p.jobs.get(wid, wrongApp.id)).toMatchObject({ status: "failed", error: { code: "BAD_REQUEST" } });
    expect(await p.jobs.get("ws_intruder", otherWs.id)).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
    expect(builds).toHaveLength(1);
  }, 60_000);

  it("targets only stock/generated hints without assets, and picks image sizes from the aspect ratio", () => {
    const targets = brollTargets({
      scenes: [
        scene(1, 2, [{ kind: "stock_video", query: "b" }, { kind: "stock_image", query: "  " }]),
        scene(0, 2, [{ kind: "generated_image", query: "a" }, { kind: "stock_image", query: "done", assetId: "ast_1" }, { kind: "screenshot", assetId: "ast_2" }]),
      ],
    });
    expect(targets.map((t) => [t.scene.order, t.hint.kind, t.hintIndex])).toEqual([
      [0, "generated_image", 0],
      [1, "stock_video", 0],
    ]);
    expect([imageSizeFor("9:16"), imageSizeFor("4:5"), imageSizeFor("16:9"), imageSizeFor("1:1")]).toEqual(["1024x1536", "1024x1536", "1536x1024", "1024x1024"]);
  });
});
