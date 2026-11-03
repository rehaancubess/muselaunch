import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompositionDoc } from "@muselaunch/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slideFrameIndex } from "./handlers";
import { ffmpegBin } from "./producer";
import { encodeStill, finalStillEncoding, hasAlpha, imageInfo, STILL_MAX_BYTES, stillEncoding, stillKindOf } from "./stills";

const doc = (kind: CompositionDoc["kind"], aspectRatio: CompositionDoc["aspectRatio"], templates: string[] = ["slide-feature"]) =>
  ({ kind, aspectRatio, scenes: templates.map((template, i) => ({ id: `sc_${i}`, template })) }) as unknown as CompositionDoc;

describe("still kinds and encodings", () => {
  it("knows the kind from the storyboard, else from the doc", () => {
    expect(stillKindOf(doc("carousel", "4:5"), { format: "carousel" })).toBe("carousel");
    expect(stillKindOf(doc("static", "1:1"), { format: "post" })).toBe("post");
    expect(stillKindOf(doc("static", "16:9"), { format: "thumbnail" })).toBe("thumbnail");
    expect(stillKindOf(doc("carousel", "9:19.5"), { format: "store_screenshots", store: "ios" })).toBe("store_ios");
    expect(stillKindOf(doc("carousel", "9:16"), { format: "store_screenshots", store: "android" })).toBe("store_android");
    // Without a storyboard: the App Store frame, a store-screenshot slide or a 16:9 single still.
    expect(stillKindOf(doc("carousel", "9:19.5"))).toBe("store_ios");
    expect(stillKindOf(doc("carousel", "9:16", ["store-screenshot", "slide-cta"]))).toBe("store_android");
    expect(stillKindOf(doc("static", "16:9"))).toBe("thumbnail");
    expect(stillKindOf(doc("static", "4:5"))).toBe("post");
    expect(stillKindOf(doc("carousel", "4:5"))).toBe("carousel");
  });

  it("JPEG for posts, carousels and thumbnails; flattened PNG for store sets; an explicit jpeg is kept", () => {
    for (const k of ["post", "carousel", "thumbnail"] as const) {
      expect(stillEncoding(k, "png")).toBe("jpeg");
      expect(stillEncoding(k)).toBe("jpeg");
    }
    for (const k of ["store_ios", "store_android"] as const) {
      expect(stillEncoding(k, "png")).toBe("png");
      expect(stillEncoding(k, "jpeg")).toBe("jpeg");
    }
    // The Create runner and the API route send "png" for any still.
    expect(finalStillEncoding(doc("carousel", "4:5"), "png", { format: "carousel" })).toBe("jpeg");
    expect(finalStillEncoding(doc("carousel", "9:19.5"), "png", { format: "store_screenshots", store: "ios" })).toBe("png");
    // A video captured as stills keeps what was asked.
    expect(finalStillEncoding(doc("video", "9:16"), "png")).toBe("png");
    expect(finalStillEncoding(doc("video", "9:16"), "jpeg")).toBe("jpeg");
    expect(STILL_MAX_BYTES.thumbnail).toBe(2 * 1024 * 1024);
  });

  it("takes each slide from the middle of its slot", () => {
    // 0.2 s slots at 30 fps: 6 frames each.
    expect([0, 1, 2].map((i) => slideFrameIndex({ start: i * 0.2, end: (i + 1) * 0.2 }, 30, 18))).toEqual([3, 9, 15]);
    expect(slideFrameIndex({ start: 0.4, end: 0.6 }, 30, 10)).toBe(9);
  });
});

describe("encodeStill (FFmpeg)", () => {
  let dir = "";
  let src = "";
  let noisy = "";
  const ff = (args: string[]) =>
    new Promise<void>((resolve, reject) => execFile(ffmpegBin(), ["-y", "-loglevel", "error", ...args], { timeout: 60_000 }, (err, _o, e) => (err ? reject(new Error(`${err.message}\n${e}`)) : resolve())));
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-stills-test-"));
    src = join(dir, "alpha.png");
    // A frame WITH alpha (half-transparent brand colour) to prove the flattening.
    await ff(["-f", "lavfi", "-i", "color=c=0x5E5CE6@0.5:s=640x360,format=rgba", "-frames:v", "1", "-update", "1", src]);
    noisy = join(dir, "noisy.png");
    // Random noise: incompressible, so a high-quality JPEG of it is large.
    await ff(["-f", "lavfi", "-i", "nullsrc=s=640x360,geq=random(1)*255:128:128", "-frames:v", "1", "-update", "1", noisy]);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a 24-bit PNG without alpha for store sets, flattened on the background", async () => {
    expect(hasAlpha((await imageInfo(src)).pixFmt)).toBe(true);
    const out = await encodeStill(src, join(dir, "store.png"), { encoding: "png", maxBytes: STILL_MAX_BYTES.store_ios, background: "#F5F5F7" });
    expect(out).toMatchObject({ mimeType: "image/png", width: 640, height: 360 });
    const info = await imageInfo(out.path);
    expect(info).toMatchObject({ codec: "png", pixFmt: "rgb24", width: 640, height: 360 });
    expect(hasAlpha(info.pixFmt)).toBe(false);
  });

  it("writes a full-quality sRGB JPEG, and re-encodes lower until it fits the size limit", async () => {
    const best = await encodeStill(noisy, join(dir, "thumb.jpg"), { encoding: "jpeg", maxBytes: 50 * 1024 * 1024 });
    expect(best).toMatchObject({ mimeType: "image/jpeg", width: 640, height: 360, qscale: 3 });
    expect((await imageInfo(best.path)).codec).toBe("mjpeg");
    const capped = await encodeStill(noisy, join(dir, "thumb-small.jpg"), { encoding: "jpeg", maxBytes: Math.floor(best.bytes * 0.6) });
    expect(capped.qscale).toBeGreaterThan(3);
    expect((await stat(capped.path)).size).toBeLessThanOrEqual(Math.floor(best.bytes * 0.6));
    await expect(encodeStill(noisy, join(dir, "x.jpg"), { encoding: "jpeg", maxBytes: 1000 })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
