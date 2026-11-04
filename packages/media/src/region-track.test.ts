import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPlatform, type JobContext, type Platform } from "@muselaunch/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handlers } from "./index";
import { cleanPrivacy, regionsInCrop } from "./privacy";
import { clipSize, pathFromBoxes, trackRegions } from "./region-track";
import { installFakeMeta, makeTestVideo, promptBoxes, samPromptOf, samTrackOutput, type RecordedCall } from "./testing";

const dir = mkdtempSync(join(tmpdir(), "media-region-track-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("pathFromBoxes (SAM motion → a region path)", () => {
  const region = { x: 0.1, y: 0.5, w: 0.4, h: 0.1 };
  it("moves Spark's box with the tracked object, keeps its size, and holds lost frames", () => {
    // SAM sees a slightly smaller box (the text inside) that scrolls up 0.02 per frame; frame 3 lost.
    const boxes = Array.from({ length: 8 }, (_, f) => (f === 3 ? undefined : { x: 0.12, y: 0.52 - 0.02 * f, w: 0.36, h: 0.06 }));
    const { path, reason } = pathFromBoxes(region, 0, boxes, 20);
    expect(reason).toBeNull();
    expect(path![0]).toMatchObject({ t: 20, x: 0.1, w: 0.4, h: 0.1 });
    expect(path![0]!.y).toBeCloseTo(0.5, 3); // the ends stay as measured
    const last = path![path!.length - 1]!;
    expect(last.t).toBeCloseTo(20.7, 3);
    expect(last.y).toBeLessThan(0.4);
    expect(last.w).toBeCloseTo(0.4, 3);
    for (const p of path!) expect(p.y + p.h).toBeLessThanOrEqual(1);
  });

  it("refuses tracks that followed something else, were lost most of the time, or missed the prompt frame", () => {
    const elsewhere = Array.from({ length: 6 }, () => ({ x: 0.7, y: 0.1, w: 0.1, h: 0.05 }));
    expect(pathFromBoxes(region, 0, elsewhere, 0).path).toBeNull();
    const sparse = Array.from({ length: 10 }, (_, f) => (f < 3 ? { ...region } : undefined));
    expect(pathFromBoxes(region, 0, sparse, 0).reason).toMatch(/30%/);
    const late = Array.from({ length: 10 }, (_, f) => (f > 5 ? { ...region } : undefined));
    expect(pathFromBoxes(region, 0, late, 0).reason).toMatch(/tracked on|prompted frame/);
  });

  it("never upscales the clip it sends to SAM", () => {
    expect(clipSize({ width: 160, height: 120 })).toEqual({ width: 160, height: 120 });
    expect(clipSize({ width: 1179, height: 2556 })).toEqual({ width: 540, height: 1170 });
  });
});

describe("privacy helpers", () => {
  it("clamps Spark's boxes and re-expresses them inside a screen cut-out", () => {
    expect(cleanPrivacy({ flagged: false, regions: [{ x: -0.1, y: 0.2, w: 0.5, h: 0.1 }, { x: 0.5, y: 0.5, w: 0.001, h: 0.2 }] })).toEqual({ flagged: true, regions: [{ x: 0, y: 0.2, w: 0.5, h: 0.1 }] });
    // 400×800 image, crop 200×400 at (100, 200): a region at (150..250, 300..340) px.
    expect(regionsInCrop([{ x: 0.375, y: 0.375, w: 0.25, h: 0.05 }], { width: 400, height: 800 }, { x: 100, y: 200, w: 200, h: 400 })).toEqual([{ x: 0.25, y: 0.25, w: 0.5, h: 0.1 }]);
    expect(regionsInCrop([{ x: 0, y: 0, w: 0.1, h: 0.1 }], { width: 400, height: 800 }, { x: 100, y: 200, w: 200, h: 400 })).toEqual([]);
  });
});

describe("trackRegions (SAM 3.1 box prompts on a real clip)", () => {
  let p: Platform;
  let calls: RecordedCall[];
  const wid = "ws_track";
  beforeAll(async () => {
    p = createTestPlatform({ META_API_KEY: "test-meta-key" }, handlers);
    // The red box of makeTestVideo moves right 3 px per frame.
    ({ calls } = installFakeMeta(p, { samOutput: (body) => samTrackOutput(samPromptOf(body), 20, (f) => ({ dx: 3 * f, dy: 0 })) }));
  });

  const ctxFor = (): JobContext =>
    ({ platform: p, workspaceId: wid, appId: "app_t", actor: "tester", job: { id: "job_track" }, signal: new AbortController().signal, throwIfCancelled: () => {}, ws: p.db.ws(wid), log: { warn: () => {} }, log_event: async () => {} }) as unknown as JobContext;

  it("cuts the stretch, prompts one box per region on its frame and returns paths in source seconds", async () => {
    const src = join(dir, "box.mp4");
    await makeTestVideo(src);
    // The box (10,30) 40×60 of 160×120, measured at 0.5 s (frame 5 → x = 25 px).
    const r = await trackRegions(ctxFor(), { src, dir, size: { width: 160, height: 120 }, startSec: 0, endSec: 2, regions: [{ x: 25 / 160, y: 30 / 120, w: 40 / 160, h: 60 / 120, anchorSec: 0.5 }], task: "test.track" });
    expect(r.frames).toBe(20);
    const sam = calls.filter((c) => c.url.endsWith("/responses"));
    expect(sam).toHaveLength(1);
    expect(promptBoxes(samPromptOf(sam[0]!.json!))).toEqual([{ id: 1, frame: 5, x1: 25, y1: 30, x2: 64, y2: 89, w: 160, h: 120 }]);
    expect((sam[0]!.json!.metadata as Record<string, string>).propagation_direction).toBe("both");
    // The uploaded file is deleted afterwards.
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/files/"))).toBe(true);
    const path = r.paths[0]!;
    expect(path[0]!.t).toBe(0);
    expect(path[0]!.x).toBeCloseTo(10 / 160, 2);
    expect(path[path.length - 1]!.t).toBeCloseTo(1.9, 3);
    expect(path[path.length - 1]!.x).toBeCloseTo((10 + 57) / 160, 2);
    expect(path.every((pt) => Math.abs(pt.w - 40 / 160) < 1e-3)).toBe(true);
  });
});
