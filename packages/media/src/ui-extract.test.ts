import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaAsset } from "@muselaunch/contracts";
import { createTestPlatform, type Platform } from "@muselaunch/platform";
import { parseSamOutput } from "@muselaunch/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpeg } from "./ffmpeg";
import { grayThumbnail } from "./frames";
import { handlers } from "./index";
import { samFrameSize } from "./masks";
import { imageCountOf, installFakeMeta, loadFixture, makeMarketingScreenshot, makeRawScreenshot, samPromptOf, schemaOf, storeUpload, textOf, type RecordedCall } from "./testing";
import { pickPhoneScreen, plainSideMargin, requestUiExtraction, roundedAlpha } from "./ui-extract";

const dir = mkdtempSync(join(tmpdir(), "media-ui-extract-test-"));
const screenFx = loadFixture<{ rawOutput: string }>("sam-image-phone-screen.json").rawOutput;
const headlineFx = loadFixture<{ rawOutput: string }>("sam-image-headline-only.json").rawOutput;

async function rgbaAt(file: string, w: number, points: [number, number][]): Promise<number[][]> {
  const raw = join(dir, `${Math.random().toString(36).slice(2)}.rgba`);
  await ffmpeg(["-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", raw]);
  const buf = await readFile(raw);
  return points.map(([x, y]) => [...buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]);
}

describe("screen cut-out helpers", () => {
  it("measures plain side margins: wide on a designed store image, narrow on a raw capture", async () => {
    await makeMarketingScreenshot(join(dir, "m.png"));
    await makeRawScreenshot(join(dir, "r.png"));
    const m = plainSideMargin(await grayThumbnail(join(dir, "m.png"), join(dir, "m.gray"), 48, 96));
    const r = plainSideMargin(await grayThumbnail(join(dir, "r.png"), join(dir, "r.gray"), 48, 96));
    expect(m).toBeGreaterThanOrEqual(0.08);
    expect(r).toBeLessThan(0.08);
  });

  it("picks the plausible phone screen, not the more confident landscape headline", () => {
    const res = parseSamOutput(screenFx, "image");
    expect(res.detections).toHaveLength(2);
    const sam = samFrameSize(screenFx)!;
    expect(sam).toEqual({ width: 393, height: 852 });
    const pick = pickPhoneScreen(res.detections, { width: 1179, height: 2556 }, sam)!;
    expect(pick.det.objectId).toBe("1");
    expect(pick.box).toEqual({ left: 225, top: 777, right: 954, bottom: 2433 });
    expect(pick.aspect).toBeGreaterThan(0.42);
    expect(pick.area).toBeGreaterThan(0.15);
    expect(pickPhoneScreen(parseSamOutput(headlineFx, "image").detections, { width: 393, height: 852 }, sam)).toBeNull();
  });

  it("makes anti-aliased rounded corners", () => {
    const a = roundedAlpha(40, 80, 10);
    expect(a[0]).toBe(0);
    expect(a[20 * 40 + 20]).toBe(255);
    expect(a[10]).toBe(255); // top edge past the corner
    expect(roundedAlpha(4, 4, 0).every((v) => v === 255)).toBe(true);
  });
});

describe("media.extract_ui (Muse Spark sorts screenshots, SAM 3.1 cuts out the app screen)", () => {
  let p: Platform;
  let calls: RecordedCall[];
  const wid = "ws_ui";
  let appId = "";
  let raw: MediaAsset;
  let marketing: MediaAsset;
  const samPrompts: string[] = [];
  let samFails = false;

  beforeAll(async () => {
    p = createTestPlatform({ META_API_KEY: "test-meta-key" }, handlers);
    ({ calls } = installFakeMeta(p, {
      // Spark sees each image with its pixel hint; this fake follows the hint (the real model decides from the image).
      spark: (body) => {
        expect(schemaOf(body)).toBe("ScreenshotKinds");
        const images = [...textOf(body).matchAll(/^Image \d+: asset (\S+) .* Heuristic: (.*)$/gm)].map((m) => ({ assetId: m[1]!, kind: /device frame/.test(m[2]!) ? "marketing" : "raw_ui", reason: "Fixture" }));
        return { images };
      },
      samOutput: (body) => {
        const prompt = samPromptOf(body);
        samPrompts.push(prompt);
        if (samFails) return { status: 400, error: { message: "invalid image", type: "invalid_request_error" } };
        return prompt === "phone screen" ? headlineFx : screenFx;
      },
    }));
    await p.credits.ensureAccount(wid, { grant: 50, reason: "test" });
    appId = (await p.db.ws(wid).collection("apps").create({ name: "Tidy Timer", status: "draft" }, { actor: "tester" })).id;
    await makeMarketingScreenshot(join(dir, "store-2.png"));
    await makeRawScreenshot(join(dir, "store-1.png"));
    const up = async (name: string) => {
      const a = await storeUpload(p, wid, join(dir, name), { kind: "image", role: "screenshot", mimeType: "image/png", appId });
      await p.jobs.create(wid, "media.probe", { assetId: a.id }, { actor: "tester", appId, idempotencyKey: `probe:${a.id}` });
      return a.id;
    };
    const rawId = await up("store-1.png");
    const mId = await up("store-2.png");
    await p.inline!.drain();
    raw = await p.db.ws(wid).collection("mediaAssets").getOrThrow(rawId);
    marketing = await p.db.ws(wid).collection("mediaAssets").update(mId, { title: "Tidy Timer screenshot 2 (App Store)" }, { actor: "tester" });
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("classifies both, cuts the screen out of the store image (falling back to the next prompt) and charges per screenshot", async () => {
    const before = (await p.credits.balance(wid)).available;
    const { job, pending, credits } = await requestUiExtraction(p, wid, { appId, actor: "tester" });
    expect([pending, credits]).toEqual([2, 4]);
    expect(job!.reservation!.credits).toBe(4);
    await p.inline!.drain();
    const done = (await p.jobs.get(wid, job!.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.creditsCharged).toBe(4);
    expect((await p.credits.balance(wid)).available).toBe(before - 4);
    expect(done.output?.data).toMatchObject({ classified: 2, marketing: 1, cutOut: 1 });

    const sparkCalls = calls.filter((c) => c.json && schemaOf(c.json) === "ScreenshotKinds");
    expect(sparkCalls).toHaveLength(1);
    expect(imageCountOf(sparkCalls[0]!.json!)).toBe(2);
    expect(samPrompts).toEqual(["phone screen", "smartphone display"]);

    const ws = p.db.ws(wid).collection("mediaAssets");
    expect((await ws.getOrThrow(raw.id)).screenshotKind).toBe("raw_ui");
    expect((await ws.getOrThrow(marketing.id)).screenshotKind).toBe("marketing");
    const crops = (await ws.list({ where: [["appId", "==", appId]], limit: 50 })).items.filter((a) => a.sourceLabel === "sam_ui_crop");
    expect(crops).toHaveLength(1);
    const crop = crops[0]!;
    expect(crop).toMatchObject({
      kind: "image",
      role: "screenshot",
      origin: "derived",
      isProductTruth: true,
      derivedFromAssetId: marketing.id,
      screenshotKind: "raw_ui",
      mimeType: "image/png",
      status: "ready",
      title: "Tidy Timer screenshot 2 (App Store) — app screen (cut out by SAM 3.1)",
      width: 238, // the lavfi test image is 392 px wide (yuv420p rounding); SAM boxes are scaled from its 393 px frame
      height: 548,
    });
    // The cut-out holds the app screen (light UI), with transparent rounded corners and no bezel or background.
    const file = join(dir, "crop.png");
    await p.storage.downloadToFile(crop.storagePath, file);
    const [corner, centre, edge, card] = await rgbaAt(file, 238, [[0, 0], [119, 30], [1, 274], [119, 120]]);
    expect(corner![3]).toBe(0);
    // (lavfi colours go through yuv420p: allow a few levels of rounding)
    [0xf2, 0xf2, 0xf7].forEach((v, i) => expect(Math.abs(centre![i]! - v)).toBeLessThanOrEqual(3));
    expect(centre![3]).toBe(255);
    expect(edge![3]).toBe(255);
    expect(edge![0]).toBeGreaterThan(200); // not the black bezel
    expect(card!.slice(0, 3)).toEqual([255, 255, 255]);
  });

  it("is idempotent: nothing left to do, so no job and no charge", async () => {
    const again = await requestUiExtraction(p, wid, { appId, actor: "tester" });
    expect(again).toEqual({ job: null, pending: 0, credits: 0 });
    await expect(requestUiExtraction(p, wid, { appId, assetIds: ["ast_not_mine"], actor: "tester" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requestUiExtraction(p, "ws_other", { appId, actor: "tester" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails visibly when SAM fails for every store image (credits released)", async () => {
    const ws = p.db.ws(wid).collection("mediaAssets");
    const crop = (await ws.list({ where: [["appId", "==", appId]], limit: 50 })).items.find((a) => a.sourceLabel === "sam_ui_crop")!;
    await ws.update(crop.id, { status: "deleted" }, { actor: "tester" });
    samFails = true;
    const before = (await p.credits.balance(wid)).available;
    const { job } = await requestUiExtraction(p, wid, { appId, assetIds: [marketing.id], actor: "tester" });
    await p.inline!.drain();
    samFails = false;
    const failed = (await p.jobs.get(wid, job!.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("PROVIDER_ERROR");
    expect((await p.credits.balance(wid)).available).toBe(before);
  });
});
