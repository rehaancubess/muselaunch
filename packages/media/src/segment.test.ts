import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPlatform, type Platform } from "@muselaunch/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpeg, ffprobeJson } from "./ffmpeg";
import { handlers } from "./index";
import { correctSegmentation, requestSegmentation } from "./service";
import { installFakeMeta, loadFixture, makeTestImage, makeTestVideo, storeUpload, type RecordedCall } from "./testing";
import { trackingQuality } from "./masks";

const dir = mkdtempSync(join(tmpdir(), "media-seg-test-"));
type SamFixture = { rawOutput: string; frames?: number; width: number; height: number };
const videoFixture = loadFixture<SamFixture>("sam-video-moving-box.json");
const boxFixture = loadFixture<SamFixture>("sam-video-box-prompt.json");
const imageFixture = loadFixture<SamFixture>("sam-image-box.json");

/** Decode one RGBA frame of a VP9-alpha WebM with libvpx (the native decoder drops alpha). */
async function rgbaFrame(file: string, frame: number, w: number, h: number): Promise<Buffer> {
  const out = join(dir, `frame-${frame}-${Date.now()}.rgba`);
  await ffmpeg(["-c:v", "libvpx-vp9", "-i", file, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", out]);
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(out);
  expect(buf.length).toBe(w * h * 4);
  return buf;
}
const alphaAt = (buf: Buffer, w: number, x: number, y: number) => buf[(y * w + x) * 4 + 3]!;

describe("media.segment (SAM 3.1 → matte → VP9-alpha cutout)", () => {
  let p: Platform & { runner: unknown };
  let calls: RecordedCall[];
  let samResponses = 0;
  let next: SamFixture = videoFixture;
  const wid = "ws_media_test";
  const other = "ws_other_tenant";

  beforeAll(async () => {
    p = createTestPlatform({ META_API_KEY: "test-meta-key" }, handlers);
    ({ calls } = installFakeMeta(p, {
      samOutput: () => {
        samResponses++;
        return next.rawOutput;
      },
    }));
    await p.credits.ensureAccount(wid, { grant: 500, reason: "test" });
    await p.credits.ensureAccount(other, { grant: 500, reason: "test" });
  });
  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });

  let videoAssetId = "";
  it("probes and normalises an uploaded clip (VP9 WebM → H.264 MP4, poster, sha256)", async () => {
    const file = join(dir, "clip.webm");
    await makeTestVideo(file, { audio: true, codec: "vp9" });
    const asset = await storeUpload(p, wid, file, { kind: "video", role: "app_recording", mimeType: "video/webm" });
    await p.jobs.create(wid, "media.probe", { assetId: asset.id }, { actor: "tester", idempotencyKey: `probe:${asset.id}` });
    await p.inline!.drain();
    const ready = await p.db.ws(wid).collection("mediaAssets").getOrThrow(asset.id);
    expect(ready.status).toBe("ready");
    expect(ready.mimeType).toBe("video/mp4");
    expect(ready.storagePath).toMatch(/normalized\.mp4$/);
    expect([ready.width, ready.height, ready.fps, ready.hasAudio]).toEqual([160, 120, 10, true]);
    expect(ready.durationSec).toBeCloseTo(2, 0);
    expect(ready.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ready.posterAssetId).toBeTruthy();
    const poster = await p.db.ws(wid).collection("mediaAssets").getOrThrow(ready.posterAssetId!);
    expect(poster).toMatchObject({ role: "thumbnail", kind: "image", status: "ready", derivedFromAssetId: asset.id });
    videoAssetId = asset.id;
  });

  it("segments video from fixture masks into a frame-aligned matte and a real VP9-alpha cutout", async () => {
    const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(videoAssetId);
    const before = await p.credits.balance(wid);
    const { segmentation, job } = await requestSegmentation(p, wid, { asset, prompt: "Segment the red box", actor: "tester" });
    expect(segmentation.prompt).toBe("red box");
    expect(job?.reservation?.credits).toBe(12);
    await p.inline!.drain();
    const seg = await p.db.ws(wid).collection("segmentations").getOrThrow(segmentation.id);
    expect(seg.status).toBe("succeeded");
    expect(seg.frameCount).toBe(20);
    expect(seg.objects.map((o) => [o.objectId, o.framesTracked])).toEqual([
      ["0", 20],
      ["1", 5],
    ]);
    expect(seg.objects[0]!.bbox).toEqual({ x: 10 / 160, y: 30 / 120, w: 40 / 160, h: 60 / 120 });
    expect(seg.objects[0]!.score).toBeCloseTo(0.96);
    expect(seg.trackingQuality).toBeGreaterThan(0.7);
    expect(seg.usageEventIds.length).toBeGreaterThanOrEqual(2); // file upload + segmentation

    // Request shape: Files upload, then a streamed Responses call with input_video.file_id.
    const upload = calls.find((c) => c.url.endsWith("/v1/files") && c.method === "POST")!;
    expect(upload.form!.get("purpose")).toBe("user_data");
    expect(upload.form!.get("expires_after[anchor]")).toBe("created_at");
    const sam = calls.find((c) => c.url.endsWith("/v1/responses"))!;
    expect(sam.json).toMatchObject({ model: "sam-3.1", stream: true, metadata: { include_confidence: "true", mask_encoding: "one_bit" } });
    const content = (sam.json!.input as { content: Record<string, unknown>[] }[])[0]!.content;
    expect(content).toEqual([{ type: "input_text", text: "red box" }, { type: "input_video", file_id: "file-1" }]);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v1/files/file-1"))).toBe(true);

    // Usage metered with frames processed.
    const usage = await p.db.ws(wid).collection("modelUsage").getMany(seg.usageEventIds);
    const samUsage = usage.find((u) => u.operation === "segmentation")!;
    expect(samUsage).toMatchObject({ provider: "meta", model: "sam-3.1", frames: 20, status: "ok", jobId: job!.id });
    expect(samUsage.costUsdEstimate).toBeCloseTo(50 * 0.0002); // 50-frame minimum
    expect((await p.credits.balance(wid)).available).toBe(before.available - 12);

    // Matte: grayscale MP4 with exactly the source frame count.
    const assets = p.db.ws(wid).collection("mediaAssets");
    const matte = await assets.getOrThrow(seg.maskAssetId!);
    expect(matte).toMatchObject({ kind: "mask", role: "mask", sourceLabel: "sam_matte", mimeType: "video/mp4", isProductTruth: false });
    const matteFile = join(dir, "matte.mp4");
    await p.storage.downloadToFile(matte.storagePath, matteFile);
    const mp = await ffprobeJson(matteFile, ["-count_frames"]);
    expect(Number((mp.streams![0] as { nb_read_frames?: string }).nb_read_frames)).toBe(20);

    // Cutout: VP9 with alpha, audio kept, alpha 255 inside the tracked box and 0 outside, per frame.
    const cutout = await assets.getOrThrow(seg.cutoutAssetId!);
    expect(cutout).toMatchObject({ kind: "video", mimeType: "video/webm", sourceLabel: "sam_cutout", isProductTruth: true, derivedFromAssetId: videoAssetId, hasAudio: true });
    const cutFile = join(dir, "cutout.webm");
    await p.storage.downloadToFile(cutout.storagePath, cutFile);
    const cp = await ffprobeJson(cutFile);
    const v = cp.streams!.find((s) => s.codec_type === "video")!;
    expect(v.codec_name).toBe("vp9");
    expect(v.tags?.alpha_mode ?? v.tags?.ALPHA_MODE).toBe("1");
    expect(cp.streams!.some((s) => s.codec_type === "audio" && s.codec_name === "opus")).toBe(true);
    const f0 = await rgbaFrame(cutFile, 0, 160, 120);
    expect(alphaAt(f0, 160, 30, 60)).toBeGreaterThan(240); // inside box at frame 0 (x 10..49)
    expect(alphaAt(f0, 160, 120, 100)).toBeLessThan(15); // background
    expect(alphaAt(f0, 160, 137, 15)).toBeGreaterThan(240); // object 1 (frames 0-4)
    const f15 = await rgbaFrame(cutFile, 15, 160, 120);
    expect(alphaAt(f15, 160, 30, 60)).toBeLessThan(15); // box moved on (x 55..94)
    expect(alphaAt(f15, 160, 75, 60)).toBeGreaterThan(240);
    expect(alphaAt(f15, 160, 137, 15)).toBeLessThan(15); // object 1 gone
    const preview = await assets.getOrThrow(seg.previewAssetId!);
    expect(preview).toMatchObject({ role: "preview", sourceLabel: "sam_preview", mimeType: "video/mp4" });
  });

  it("reuses a succeeded segmentation for the same content hash + prompt without a new call or charge", async () => {
    const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(videoAssetId);
    const usageBefore = (await p.db.ws(wid).collection("modelUsage").list({ limit: 200 })).items.length;
    const balance = (await p.credits.balance(wid)).available;
    const samBefore = samResponses;

    const again = await requestSegmentation(p, wid, { asset, prompt: "red box", actor: "tester" });
    expect(again.job).toBeNull();
    expect(again.reused).toBe(true);

    // A second upload of identical bytes reuses the masks too (copy linked to the original).
    const file = join(dir, "clip.webm");
    const dup = await storeUpload(p, wid, file, { kind: "video", role: "app_recording", mimeType: "video/webm" });
    await p.jobs.create(wid, "media.probe", { assetId: dup.id }, { actor: "tester", idempotencyKey: `probe:${dup.id}` });
    await p.inline!.drain();
    const dupReady = await p.db.ws(wid).collection("mediaAssets").getOrThrow(dup.id);
    expect(dupReady.sha256).toBe(asset.sha256);
    const copy = await requestSegmentation(p, wid, { asset: dupReady, prompt: "red box", actor: "tester" });
    expect(copy.job).toBeNull();
    expect(copy.segmentation).toMatchObject({ status: "succeeded", reusedFromSegmentationId: again.segmentation.id, cutoutAssetId: again.segmentation.cutoutAssetId, usageEventIds: [] });

    expect(samResponses).toBe(samBefore);
    expect((await p.db.ws(wid).collection("modelUsage").list({ limit: 200 })).items.length).toBe(usageBefore);
    expect((await p.credits.balance(wid)).available).toBe(balance);

    // Never across tenants: the other workspace has no access to this cache.
    const otherAsset = await storeUpload(p, other, file, { kind: "video", role: "app_recording", mimeType: "video/webm" });
    await p.jobs.create(other, "media.probe", { assetId: otherAsset.id }, { actor: "tester", idempotencyKey: `probe:${otherAsset.id}` });
    await p.inline!.drain();
    const fresh = await requestSegmentation(p, other, { asset: await p.db.ws(other).collection("mediaAssets").getOrThrow(otherAsset.id), prompt: "red box", actor: "tester" });
    expect(fresh.reused).toBe(false);
    expect(fresh.job).not.toBeNull();
    await p.inline!.drain();
    expect(samResponses).toBe(samBefore + 1);
    expect(await p.db.ws(other).collection("segmentations").get(again.segmentation.id)).toBeNull();
  });

  it("re-selects objects from stored SAM output without calling SAM or charging credits", async () => {
    const seg0 = (await p.db.ws(wid).collection("segmentations").list({ where: [["sourceAssetId", "==", videoAssetId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 5 })).items[0]!;
    const samBefore = samResponses;
    const balance = (await p.credits.balance(wid)).available;
    const { job } = await correctSegmentation(p, wid, seg0, { kind: "objects", objectIds: ["0"] }, "tester");
    expect(job.reservation).toBeUndefined();
    await p.inline!.drain();
    const seg = await p.db.ws(wid).collection("segmentations").getOrThrow(seg0.id);
    expect(seg.status).toBe("succeeded");
    expect(seg.selectedObjectIds).toEqual(["0"]);
    expect(seg.cutoutAssetId).not.toBe(seg0.cutoutAssetId);
    expect(samResponses).toBe(samBefore);
    expect((await p.credits.balance(wid)).available).toBe(balance);
    const old = await p.db.ws(wid).collection("mediaAssets").getOrThrow(seg0.cutoutAssetId!);
    expect(old.status).toBe("deleted");
    const cutFile = join(dir, "cutout-sel.webm");
    await p.storage.downloadToFile((await p.db.ws(wid).collection("mediaAssets").getOrThrow(seg.cutoutAssetId!)).storagePath, cutFile);
    const f0 = await rgbaFrame(cutFile, 0, 160, 120);
    expect(alphaAt(f0, 160, 137, 15)).toBeLessThan(15); // object 1 excluded now
    expect(alphaAt(f0, 160, 30, 60)).toBeGreaterThan(240);
  });

  it("refines with a box prompt (new SAM call using buildObjectPrompt syntax)", async () => {
    const seg0 = (await p.db.ws(wid).collection("segmentations").list({ where: [["sourceAssetId", "==", videoAssetId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 5 })).items[0]!;
    next = boxFixture;
    const { job } = await correctSegmentation(p, wid, seg0, { kind: "box", frame: 0, box: { x: 10 / 160, y: 30 / 120, w: 40 / 160, h: 60 / 120 } }, "tester");
    expect(job.reservation?.credits).toBe(12);
    await p.inline!.drain();
    const seg = await p.db.ws(wid).collection("segmentations").getOrThrow(seg0.id);
    expect(seg.status).toBe("succeeded");
    expect(seg.corrections.at(-1)).toMatchObject({ kind: "box" });
    expect(seg.objects.map((o) => o.objectId)).toEqual(["1"]);
    const last = calls.filter((c) => c.url.endsWith("/v1/responses")).at(-1)!;
    const text = ((last.json!.input as { content: { text?: string }[] }[])[0]!.content[0]!.text)!;
    expect(text).toBe("<0f>1<|box;x1=10;y1=30;x2=49;y2=89;w=160;h=120|>");
    expect(last.json!.metadata).toMatchObject({ propagation_direction: "both" });
    next = videoFixture;
  });

  it("segments a still image into a PNG matte and RGBA cutout", async () => {
    const file = join(dir, "still.png");
    await makeTestImage(file);
    next = imageFixture;
    const asset = await storeUpload(p, wid, file, { kind: "image", role: "screenshot", mimeType: "image/png" });
    await p.jobs.create(wid, "media.probe", { assetId: asset.id }, { actor: "tester", idempotencyKey: `probe:${asset.id}` });
    await p.inline!.drain();
    const ready = await p.db.ws(wid).collection("mediaAssets").getOrThrow(asset.id);
    expect([ready.width, ready.height]).toEqual([96, 64]);
    const { job, segmentation } = await requestSegmentation(p, wid, { asset: ready, prompt: "red box", actor: "tester" });
    expect(job?.reservation?.credits).toBe(3);
    await p.inline!.drain();
    const seg = await p.db.ws(wid).collection("segmentations").getOrThrow(segmentation.id);
    expect(seg).toMatchObject({ status: "succeeded", mediaType: "image", trackingQuality: 0.92 });
    const sam = calls.filter((c) => c.url.endsWith("/v1/responses")).at(-1)!;
    const part = (sam.json!.input as { content: { type: string; image_url?: string }[] }[])[0]!.content[1]!;
    expect(part.type).toBe("input_image");
    expect(part.image_url).toMatch(/^data:image\/png;base64,/);
    const cutout = await p.db.ws(wid).collection("mediaAssets").getOrThrow(seg.cutoutAssetId!);
    expect(cutout.mimeType).toBe("image/png");
    const png = join(dir, "cut.png");
    await p.storage.downloadToFile(cutout.storagePath, png);
    const raw = join(dir, "cut.rgba");
    await ffmpeg(["-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", raw]);
    const buf = await (await import("node:fs/promises")).readFile(raw);
    expect(alphaAt(buf, 96, 40, 30)).toBe(255);
    expect(alphaAt(buf, 96, 5, 5)).toBe(0);
    const usage = await p.db.ws(wid).collection("modelUsage").getMany(seg.usageEventIds);
    const samUsage = usage.find((u) => u.operation === "segmentation")!;
    expect(samUsage.images).toBe(1);
    expect(samUsage.frames).toBeUndefined();
    next = videoFixture;
  });

  it("requires consent before segmenting a person and records it on the asset", async () => {
    const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(videoAssetId);
    await expect(requestSegmentation(p, wid, { asset, prompt: "person", actor: "tester" })).rejects.toMatchObject({ code: "BAD_REQUEST", opts: { details: { consentRequired: true } } });
    const { segmentation } = await requestSegmentation(p, wid, { asset, prompt: "person", consent: { scope: "Founder appears in own demo video" }, actor: "tester" });
    expect(segmentation.status).toBe("queued");
    await p.inline!.drain();
    const updated = await p.db.ws(wid).collection("mediaAssets").getOrThrow(videoAssetId);
    expect(updated.license?.consent).toMatchObject({ by: "tester", scope: "Founder appears in own demo video" });
  });

  it("fails visibly (no fabricated mask) when SAM is not configured", async () => {
    const q = createTestPlatform({}, handlers);
    await q.credits.ensureAccount(wid, { grant: 100, reason: "test" });
    const file = join(dir, "still.png");
    const asset = await storeUpload(q, wid, file, { kind: "image", role: "screenshot", mimeType: "image/png" });
    await q.jobs.create(wid, "media.probe", { assetId: asset.id }, { actor: "tester", idempotencyKey: `probe:${asset.id}` });
    await q.inline!.drain();
    const { segmentation, job } = await requestSegmentation(q, wid, { asset: await q.db.ws(wid).collection("mediaAssets").getOrThrow(asset.id), prompt: "red box", actor: "tester" });
    await q.inline!.drain();
    const seg = await q.db.ws(wid).collection("segmentations").getOrThrow(segmentation.id);
    expect(seg.status).toBe("failed");
    expect(seg.cutoutAssetId).toBeUndefined();
    const j = await q.jobs.get(wid, job!.id);
    expect(j).toMatchObject({ status: "failed", error: { code: "PROVIDER_NOT_CONFIGURED" } });
    expect((await q.credits.balance(wid)).available).toBe(100); // reservation released
  });
});

describe("trackingQuality heuristic", () => {
  it("rewards continuous, stable coverage and penalises gaps and jitter", () => {
    expect(trackingQuality(Array(30).fill(0.2))).toBe(1);
    expect(trackingQuality([])).toBe(0);
    expect(trackingQuality(Array(30).fill(0))).toBe(0);
    const gappy = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 0 : 0.2));
    expect(trackingQuality(gappy)).toBeLessThan(0.5);
    const jitter = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.05 : 0.3));
    expect(trackingQuality(jitter)).toBeLessThan(0.7);
  });
});
