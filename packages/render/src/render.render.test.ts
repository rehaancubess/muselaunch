import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "@muselaunch/compositions";
import { commitVersion, getVersion } from "@muselaunch/compositions/store";
import { createTestPlatform } from "@muselaunch/platform";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { handlers } from "./handlers";
import { extractFrame, probe } from "./media";
import { FIXTURES_DIR, seedSample } from "./test-seed";

/**
 * Real HyperFrames renders (headless Chrome + FFmpeg). Slow: run with
 *   RUN_RENDER_TESTS=1 RENDER_CHROME_PATH=/path/to/chrome-headless-shell npx vitest run packages/render/src/render.render.test.ts
 */
describe.runIf(process.env.RUN_RENDER_TESTS === "1")("real render pipeline", { timeout: 20 * 60_000 }, () => {
  const p = createTestPlatform({}, handlers);
  const wid = "ws_render";
  const tmp = mkdtempSync(join(tmpdir(), "ml-render-test-"));
  let previewAssetId = "";
  let finalAssetId = "";

  it("composition.build → render.preview produces a real low-res MP4", async () => {
    const seed = await seedSample(p, wid);
    await p.jobs.create(wid, "composition.build", { appId: seed.appId, storyboardId: seed.storyboardId, compositionId: "cmp_r" }, { actor: "u1", idempotencyKey: "b1" });
    await p.inline!.drain();
    const comp = await p.db.ws(wid).collection("compositions").getOrThrow("cmp_r");
    expect(comp.lastRender?.quality).toBe("preview");
    expect(comp.status).toBe("rendered");
    const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(comp.lastRender!.assetId!);
    previewAssetId = asset.id;
    expect(asset).toMatchObject({ kind: "video", role: "preview", origin: "render", mimeType: "video/mp4", status: "ready", render: { compositionId: "cmp_r", version: 1, quality: "preview" } });
    const file = join(tmp, "preview.mp4");
    await p.storage.downloadToFile(asset.storagePath, file);
    const info = await probe(file);
    expect(info.width).toBe(540);
    expect(info.height).toBe(960);
    expect(info.durationSec).toBeGreaterThan(8.8);
    expect(info.durationSec).toBeLessThan(9.2);
    expect(asset.posterAssetId).toBeTruthy();
  });

  it("render.final produces a 1080x1920 MP4 of the expected length, charges credits and caches", async () => {
    const before = await p.credits.balance(wid);
    const job = await p.jobs.create(wid, "render.final", { appId: "app_focusly", compositionId: "cmp_r", version: 1 }, { actor: "u1", idempotencyKey: "f1", credits: { operation: "render.final", params: { durationSec: 9 } } });
    expect(job.reservation?.credits).toBe(8);
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.creditsCharged).toBe(8);
    expect((await p.credits.balance(wid)).available).toBe(before.available - 8);
    finalAssetId = done!.output!.data!.assetId as string;
    const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(finalAssetId);
    expect(asset).toMatchObject({ role: "render", width: 1080, height: 1920, render: { compositionId: "cmp_r", version: 1, quality: "final" } });
    expect(asset.storagePath).toBe(`workspaces/${wid}/renders/cmp_r/${asset.storagePath.split("/").pop()}`);
    const file = join(tmp, "final.mp4");
    await p.storage.downloadToFile(asset.storagePath, file);
    const info = await probe(file);
    expect([info.width, info.height]).toEqual([1080, 1920]);
    expect(Math.abs(info.durationSec! - 9)).toBeLessThan(0.15);
    // Save a frame from the device-demo scene for visual review.
    await extractFrame(file, 4.6, join(FIXTURES_DIR, "samples", "integration-final-frame.png"));
    const comp = await p.db.ws(wid).collection("compositions").getOrThrow("cmp_r");
    expect(comp.lastRender).toMatchObject({ quality: "final", version: 1, assetId: finalAssetId });

    // Same doc + quality again → cached asset, no credits.
    const again = await p.jobs.create(wid, "render.final", { appId: "app_focusly", compositionId: "cmp_r", version: 1 }, { actor: "u1", idempotencyKey: "f2", credits: { operation: "render.final", params: { durationSec: 9 } } });
    await p.inline!.drain();
    const cached = await p.jobs.get(wid, again.id);
    expect(cached?.output?.data).toMatchObject({ cached: true, assetId: finalAssetId });
    expect(cached?.creditsCharged).toBe(0);
    expect(previewAssetId).not.toBe(finalAssetId);
  });

  it("cancels a running render and releases the credit hold", async () => {
    const ws = p.db.ws(wid);
    const cur = await getVersion(ws, "cmp_r");
    const next = applyPatch(cur.doc, [{ op: "update_layer", sceneId: "sc_s2", layerId: "sc_s2_headline", set: { text: "Plan your day. Then do it." } }]);
    await commitVersion(ws, "cmp_r", { baseVersion: 1, doc: next.doc, source: "user_edit", summary: "edit" }, "u1");
    const before = await p.credits.balance(wid);
    const job = await p.jobs.create(wid, "render.final", { appId: "app_focusly", compositionId: "cmp_r", version: 2 }, { actor: "u1", idempotencyKey: "c1", credits: { operation: "render.final", params: { durationSec: 9 } } });
    for (let i = 0; i < 100; i++) {
      const j = await p.jobs.get(wid, job.id);
      if (j?.status === "running" && j.progress.pct >= 12) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    await p.jobs.requestCancel(wid, job.id, "u1");
    await p.inline!.drain();
    expect((await p.jobs.get(wid, job.id))?.status).toBe("cancelled");
    expect((await p.credits.balance(wid)).available).toBe(before.available);
    expect((await ws.collection("compositions").getOrThrow("cmp_r")).status).not.toBe("rendering");
  });

  it("package.export zips the final video, poster, instructions and attributions", async () => {
    const ws = p.db.ws(wid);
    await ws.collection("compositions").update("cmp_r", { approvedVersion: 1 }, { actor: "u1" });
    await ws.collection("copyPacks").create({ appId: "app_focusly", campaignId: "cpg_sample", channel: "instagram", items: [{ id: "c1", kind: "caption", text: "Mornings, sorted.", claimIds: [] }] }, { actor: "u1" });
    const job = await p.jobs.create(wid, "package.export", { appId: "app_focusly", campaignId: "cpg_sample", compositionIds: [], includeCopy: true }, { actor: "u1" });
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job.id);
    expect(done?.status).toBe("succeeded");
    const asset = await ws.collection("mediaAssets").getOrThrow(done!.output!.data!.assetId as string);
    expect(asset).toMatchObject({ role: "package", kind: "archive", mimeType: "application/zip" });
    const zip = unzipSync(new Uint8Array(await p.storage.get(asset.storagePath)));
    const names = Object.keys(zip).sort();
    expect(names).toEqual(expect.arrayContaining(["README.md", "ATTRIBUTION.txt", "manifest.json", "copy/instagram.txt", "videos/focusly-mornings-9x16.mp4", "thumbnails/focusly-mornings-9x16.jpg"]));
    expect(zip["videos/focusly-mornings-9x16.mp4"]!.length).toBe((await p.storage.stat((await ws.collection("mediaAssets").getOrThrow(finalAssetId)).storagePath))!.bytes);
    const readme = new TextDecoder().decode(zip["README.md"]);
    expect(readme).toMatch(/Nothing in this package has been posted/);
    writeFileSync(join(tmp, "pkg.zip"), Buffer.from(await p.storage.get(asset.storagePath)));
    expect(execFileSync("unzip", ["-l", join(tmp, "pkg.zip")]).toString()).toContain("videos/focusly-mornings-9x16.mp4");
  });
});
