import { copyFileSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaAsset } from "@muselaunch/contracts";
import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { handlers } from "./handlers";
import { sampleStillStoryboard } from "./sample";
import { hasAlpha, imageInfo } from "./stills";
import { seedSample } from "./test-seed";

/**
 * Real still renders (headless Chrome + FFmpeg) of the three still sets, from storyboard to files:
 *   RUN_RENDER_TESTS=1 RENDER_CHROME_PATH=/path/to/chrome npx vitest run packages/render/src/stills.render.test.ts
 * Set STILLS_OUT_DIR to keep the rendered slides for a visual check.
 */
describe.runIf(process.env.RUN_RENDER_TESTS === "1")("real still renders", { timeout: 20 * 60_000 }, () => {
  const p = createTestPlatform({}, handlers);
  const wid = "ws_stills";
  const tmp = mkdtempSync(join(tmpdir(), "ml-stills-render-"));
  const keep = process.env.STILLS_OUT_DIR;
  if (keep) mkdirSync(keep, { recursive: true });

  async function buildAndRender(format: "carousel" | "thumbnail" | "store_screenshots", opts: { store?: "ios" | "android"; claimId?: string } = {}) {
    const ws = p.db.ws(wid);
    const seed = await seedSample(p, wid);
    await p.credits.grant(wid, 50, { reason: "test credits", idempotencyKey: `grant:${format}:${opts.store ?? ""}`, actor: "system" });
    const sb = sampleStillStoryboard(wid, format, { ...opts, id: `sbd_${format}_${opts.store ?? "x"}` });
    const { id: sbId, workspaceId: _w, createdAt: _c, updatedAt: _u, createdBy: _b, ...rest } = sb;
    await ws.collection("storyboards").createIfAbsent({ id: sbId, ...rest }, { actor: "fixture" });
    const compositionId = `cmp_${format}_${opts.store ?? "x"}`;
    await p.jobs.create(wid, "composition.build", { appId: seed.appId, storyboardId: sbId, compositionId }, { actor: "u1", idempotencyKey: `b:${compositionId}` });
    await p.inline!.drain();
    const comp = await ws.collection("compositions").getOrThrow(compositionId);
    // The build queued a cheap preview: small JPEG slides.
    expect(comp.lastRender?.quality).toBe("preview");
    const preview = await ws.collection("mediaAssets").getOrThrow(comp.lastRender!.assetId!);
    expect(preview).toMatchObject({ kind: "image", role: "preview", mimeType: "image/jpeg" });
    // Final, as the Create runner asks for any still ("png"): the handler picks the right encoding.
    const job = await p.jobs.create(wid, "render.final", { appId: seed.appId, compositionId, version: 1, format: "png" }, { actor: "u1", idempotencyKey: `f:${compositionId}`, credits: { operation: "render.final", amount: 1 } });
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job.id);
    expect(done?.status, JSON.stringify(done?.error)).toBe("succeeded");
    const ids = done!.output!.data!.assetIds as string[];
    expect(done!.output!.refs.map((r) => r.id)).toEqual(ids);
    // Same shape as a video render: slide 1 is the asset and the poster.
    expect(done!.output!.data).toMatchObject({ assetId: ids[0], posterAssetId: ids[0], slides: ids.length, format: format === "store_screenshots" ? "png" : "jpeg" });
    // A second final of the same doc is the cached render, with the same data.
    const again = await p.jobs.create(wid, "render.final", { appId: seed.appId, compositionId, version: 1, format: "png" }, { actor: "u1", idempotencyKey: `f2:${compositionId}`, credits: { operation: "render.final", amount: 1 } });
    await p.inline!.drain();
    expect((await p.jobs.get(wid, again.id))?.output?.data).toMatchObject({ cached: true, assetId: ids[0], posterAssetId: ids[0], assetIds: ids, slides: ids.length });
    const slides = (await ws.collection("mediaAssets").getMany(ids)) as MediaAsset[];
    const ordered = ids.map((id) => slides.find((a) => a.id === id)!);
    const after = await ws.collection("compositions").getOrThrow(compositionId);
    expect(after.lastRender).toMatchObject({ quality: "final", version: 1, assetId: ids[0] });
    expect(after.thumbnailAssetId).toBe(ids[0]);
    const files: { asset: MediaAsset; file: string }[] = [];
    for (const [i, a] of ordered.entries()) {
      const ext = a.mimeType === "image/png" ? "png" : "jpg";
      const file = join(tmp, `${compositionId}-slide-${String(i + 1).padStart(2, "0")}.${ext}`);
      await p.storage.downloadToFile(a.storagePath, file);
      if (keep) copyFileSync(file, join(keep, `${format}${opts.store ? `-${opts.store}` : ""}-slide-${String(i + 1).padStart(2, "0")}.${ext}`));
      files.push({ asset: a, file });
    }
    return { comp: after, files };
  }

  it("renders a 4-slide carousel (4:5) to 1080×1350 JPEGs, in order", async () => {
    const { files } = await buildAndRender("carousel");
    expect(files).toHaveLength(4);
    for (const [i, { asset, file }] of files.entries()) {
      expect(asset).toMatchObject({ kind: "image", role: "render", mimeType: "image/jpeg", width: 1080, height: 1350 });
      expect(asset.labels).toEqual(expect.arrayContaining([`slide:${i + 1}`, "still:carousel"]));
      const info = await imageInfo(file);
      expect(info).toMatchObject({ codec: "mjpeg", width: 1080, height: 1350 });
      expect(statSync(file).size).toBeLessThan(8 * 1024 * 1024);
      expect(statSync(file).size).toBeGreaterThan(30_000);
    }
  });

  it("renders a YouTube thumbnail (16:9) to a 1920×1080 JPEG of at most 2 MB", async () => {
    const { files } = await buildAndRender("thumbnail");
    expect(files).toHaveLength(1);
    const [{ asset, file }] = files as [{ asset: MediaAsset; file: string }];
    expect(asset).toMatchObject({ mimeType: "image/jpeg", width: 1920, height: 1080 });
    expect(await imageInfo(file)).toMatchObject({ codec: "mjpeg", width: 1920, height: 1080 });
    expect(statSync(file).size).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("renders a 3-slide App Store set (9:19.5) to 1290×2796 24-bit PNGs without alpha", async () => {
    const { files } = await buildAndRender("store_screenshots", { store: "ios" });
    expect(files).toHaveLength(3);
    for (const { asset, file } of files) {
      expect(asset).toMatchObject({ mimeType: "image/png", width: 1290, height: 2796 });
      const info = await imageInfo(file);
      expect(info).toMatchObject({ codec: "png", pixFmt: "rgb24", width: 1290, height: 2796 });
      expect(hasAlpha(info.pixFmt)).toBe(false);
    }
  });

  it("renders a Google Play set (9:16) to 1080×1920 PNGs without alpha", async () => {
    const { files } = await buildAndRender("store_screenshots", { store: "android" });
    expect(files).toHaveLength(3);
    for (const { file } of files) expect(await imageInfo(file)).toMatchObject({ codec: "png", pixFmt: "rgb24", width: 1080, height: 1920 });
  });

  it("renders a founder cut-out cover, a verified-claim proof slide and a 1:1 post", async () => {
    const { seedPresenter } = await import("./test-seed");
    const { buildFromStoryboard } = await import("@muselaunch/compositions");
    const { createComposition } = await import("@muselaunch/compositions/store");
    const ws = p.db.ws(wid);
    const seed = await seedPresenter(p, wid);
    await p.credits.grant(wid, 20, { reason: "test credits", idempotencyKey: "grant:gallery", actor: "system" });
    // A claim the founder confirmed (fixture): the proof slide may only show verified claims.
    await ws.collection("claims").createIfAbsent({ id: "clm_fixture_rating", appId: seed.appId, text: "Rated 4.8 on the App Store", evidenceIds: [], confidence: 1, state: "verified", permittedContexts: ["all"], origin: "user" }, { actor: "fixture" });
    const sb = sampleStillStoryboard(wid, "carousel", { id: "sbd_gallery", claimId: "clm_fixture_rating" });
    sb.scenes[0]!.assets = [{ kind: "founder_clip", assetId: "ast_presenter" }];
    const app = await ws.collection("apps").getOrThrow(seed.appId);
    const brand = await ws.collection("brandProfiles").get(seed.appId);
    const assets = (await ws.collection("mediaAssets").list({ where: [["appId", "==", seed.appId]], limit: 100 })).items;
    const segmentations = (await ws.collection("segmentations").list({ where: [["appId", "==", seed.appId]], limit: 50 })).items;
    const clipAnalyses = (await ws.collection("clipAnalyses").list({ where: [["appId", "==", seed.appId]], limit: 50 })).items;
    const outputs: string[] = [];
    for (const [id, ar, kind] of [
      ["cmp_gallery_4x5", "4:5", "carousel"],
      ["cmp_gallery_1x1", "1:1", "carousel"],
    ] as const) {
      const doc = buildFromStoryboard({ storyboard: sb, app, brand, assets, segmentations, clipAnalyses, aspectRatio: ar, kind });
      expect(doc.scenes[0]!.layers.some((l) => l.type === "video" && l.mask?.segmentationId === "seg_person")).toBe(true);
      expect(doc.scenes.map((s) => s.template)).toContain("slide-proof");
      await createComposition(ws, { id, appId: seed.appId, campaignId: "cpg_sample", title: `Gallery ${ar}`, doc }, "u1");
      const job = await p.jobs.create(wid, "render.final", { appId: seed.appId, compositionId: id, version: 1, format: "png" }, { actor: "u1", idempotencyKey: `g:${id}`, credits: { operation: "render.final", amount: 2 } });
      await p.inline!.drain();
      const done = await p.jobs.get(wid, job.id);
      expect(done?.status, JSON.stringify(done?.error)).toBe("succeeded");
      for (const [i, aid] of (done!.output!.data!.assetIds as string[]).entries()) {
        const a = await ws.collection("mediaAssets").getOrThrow(aid);
        const file = join(tmp, `${id}-${i + 1}.jpg`);
        await p.storage.downloadToFile(a.storagePath, file);
        expect(await imageInfo(file)).toMatchObject({ codec: "mjpeg", width: 1080, height: ar === "1:1" ? 1080 : 1350 });
        if (keep) copyFileSync(file, join(keep, `gallery-${ar.replace(":", "x")}-slide-${String(i + 1).padStart(2, "0")}.jpg`));
        outputs.push(file);
      }
    }
    expect(outputs).toHaveLength(10);
  });

  it("exports every slide in order, store sets in a store folder with upload notes", async () => {
    const ws = p.db.ws(wid);
    const job = await p.jobs.create(wid, "package.export", { appId: "app_focusly", campaignId: "cpg_sample", compositionIds: ["cmp_carousel_x", "cmp_thumbnail_x", "cmp_store_screenshots_ios"], includeCopy: true }, { actor: "u1" });
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job.id);
    expect(done?.status, JSON.stringify(done?.error)).toBe("succeeded");
    const { unzipSync } = await import("fflate");
    const asset = await ws.collection("mediaAssets").getOrThrow(done!.output!.data!.assetId as string);
    const zip = unzipSync(new Uint8Array(await p.storage.get(asset.storagePath)));
    const names = Object.keys(zip).sort();
    expect(names).toEqual(expect.arrayContaining(["app-store/README.txt", "app-store/focusly-app-store-screenshots/slide-01.png", "app-store/focusly-app-store-screenshots/slide-03.png"]));
    expect(names.filter((n) => /^carousels\/focusly-mornings-carousel-4x5\/slide-0\d\.jpg$/.test(n))).toHaveLength(4);
    expect(names).toContain("thumbnails/focusly-thumbnail-16x9.jpg");
    if (keep) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(keep, "export.zip"), Buffer.from(await p.storage.get(asset.storagePath)));
    }
  });
});
