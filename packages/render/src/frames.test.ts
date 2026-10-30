import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractReviewFrames, planReviewFrames, REVIEW_FRAME_LIMIT, scaledSize, sceneAtTime } from "./frames";
import { probe } from "./media";
import { ffmpegBin } from "./producer";

const scenes = (durations: number[]) => {
  let t = 0;
  return durations.map((d, i) => {
    const s = { id: `sc_${i + 1}`, startSec: t, durationSec: d };
    t += d;
    return s;
  });
};

describe("review frame plan", () => {
  it("takes the first frame, every scene's mid-point and an early + late frame of long scenes, in time order", () => {
    const plan = planReviewFrames(scenes([2.5, 4.5, 3, 5]));
    expect(plan.map((f) => [f.ref, f.atSec, f.sceneId, f.kind])).toEqual([
      ["f1", 0, "sc_1", "first"],
      ["f2", 1.25, "sc_1", "mid"],
      ["f3", 3.4, "sc_2", "early"],
      ["f4", 4.75, "sc_2", "mid"],
      ["f5", 6.1, "sc_2", "late"],
      ["f6", 8.5, "sc_3", "mid"],
      ["f7", 11, "sc_4", "early"],
      ["f8", 12.5, "sc_4", "mid"],
      ["f9", 14, "sc_4", "late"],
    ]);
  });

  it("never exceeds 16 frames: many scenes are sampled evenly (first and last kept), long-scene extras only while room remains", () => {
    const many = planReviewFrames(scenes(Array.from({ length: 24 }, () => 2.5)));
    expect(many).toHaveLength(REVIEW_FRAME_LIMIT);
    expect(many[0]).toMatchObject({ kind: "first", atSec: 0 });
    expect(many[1]!.sceneId).toBe("sc_1");
    expect(many.at(-1)!.sceneId).toBe("sc_24");
    const long = planReviewFrames(scenes([6, 6, 6, 6, 6, 6, 6, 6, 6, 6]));
    expect(long).toHaveLength(15); // 1 first + 10 mids + 2 pairs; a single slot left can't hold a pair
    expect(long.filter((f) => f.kind === "mid")).toHaveLength(10);
    expect(long.filter((f) => f.kind === "early" || f.kind === "late")).toHaveLength(4);
    // The last frame is never past the end of the video.
    const end = planReviewFrames(scenes([0.5]), { fps: 30 });
    expect(end.every((f) => f.atSec < 0.5)).toBe(true);
    expect(sceneAtTime(scenes([2, 3]), 2.5)?.id).toBe("sc_2");
  });

  it("scales the shorter side to ~540 px without upscaling", () => {
    expect(scaledSize(1080, 1920)).toEqual({ width: 540, height: 960, vf: "scale=540:-2" });
    expect(scaledSize(1920, 1080)).toEqual({ width: 960, height: 540, vf: "scale=-2:540" });
    expect(scaledSize(270, 480)).toMatchObject({ width: 270, height: 480 });
  });
});

describe("extractReviewFrames (FFmpeg)", () => {
  let dir = "";
  let video = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-frames-test-"));
    video = join(dir, "in.mp4");
    await new Promise<void>((resolve, reject) =>
      execFile(ffmpegBin(), ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=1080x1920:r=30:d=3", "-c:v", "mpeg4", "-q:v", "6", "-pix_fmt", "yuv420p", video], { timeout: 60_000 }, (err, _o, e) => (err ? reject(new Error(`${err.message}\n${e}`)) : resolve())),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one ~540 px JPEG per planned frame, clamping times to the real duration", async () => {
    const plan = planReviewFrames(scenes([1, 2]), { totalSec: 3 });
    const late = [...plan, { ref: "f9", atSec: 9, kind: "mid" as const, sceneId: "sc_2" }];
    const out = await extractReviewFrames(video, late, join(dir, "frames"));
    expect(out.frames.map((f) => f.ref)).toEqual([...plan.map((f) => f.ref), "f9"]);
    for (const f of out.frames) {
      expect((await stat(f.path)).size).toBeGreaterThan(500);
      expect(f).toMatchObject({ width: 540, height: 960 });
      const info = await probe(f.path);
      expect([info.width, info.height]).toEqual([540, 960]);
    }
    expect(out.frames.at(-1)!.atSec).toBeLessThan(3);
  });

  it("fails honestly on a file that isn't a video", async () => {
    const bad = join(dir, "bad.mp4");
    await import("node:fs/promises").then((fs) => fs.writeFile(bad, "FIXTURE: not a video"));
    await expect(extractReviewFrames(bad, planReviewFrames(scenes([1])), join(dir, "bad"))).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
