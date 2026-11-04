import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordingSegment, StoryboardScene } from "@muselaunch/contracts";
import { createTestPlatform, type HandlerRegistry, type JobContext } from "@muselaunch/platform";
import { afterAll, describe, expect, it } from "vitest";
import { keyframeTime } from "./focus-track";
import { handlers } from "./index";
import { installFakeMeta, makeTestVideo, promptBoxes, samPromptOf, samTrackOutput, storeUpload } from "./testing";

const dir = mkdtempSync(join(tmpdir(), "media-focus-track-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("keyframeTime", () => {
  it("uses the stored keyframe time, else the keyframe's title (older breakdowns), within the segment", () => {
    expect(keyframeTime({ keyframeAtSec: 3.2, startSec: 3, endSec: 6 })).toBe(3.2);
    expect(keyframeTime({ startSec: 10, endSec: 16 }, { title: "Walkthrough · still at 0:12.5" })).toBe(12.5);
    expect(keyframeTime({ startSec: 60, endSec: 70 }, { title: "Walkthrough · still at 1:04.0" })).toBe(64);
    expect(keyframeTime({ startSec: 0, endSec: 2 }, { title: "Walkthrough · still at 0:12.5" })).toBeUndefined();
    expect(keyframeTime({ startSec: 0, endSec: 2 })).toBeUndefined();
  });
});

describe("storyboard.resolve_media: close-ups that follow the element", () => {
  it("tracks a focus-zoom's box through its walkthrough segment and stores the path on the scene", async () => {
    const wid = "ws_focus";
    const builds: string[] = [];
    const registry: HandlerRegistry = {
      ...handlers,
      "composition.build": async (ctx: JobContext<"composition.build">) => {
        builds.push(ctx.payload.storyboardId);
        return { creditsUsed: 0 };
      },
    };
    const p = createTestPlatform({ META_API_KEY: "test-meta-key" }, registry);
    // The element scrolls left 3 px per frame (the red box of the test clip).
    const { calls } = installFakeMeta(p, { samOutput: (body) => samTrackOutput(samPromptOf(body), 20, (f) => ({ dx: 3 * f, dy: 0 })) });
    await p.credits.ensureAccount(wid, { grant: 50, reason: "test" });
    const ws = p.db.ws(wid);
    const app = await ws.collection("apps").create({ name: "Boxy", status: "draft" }, { actor: "u1" });
    const file = join(dir, "rec.mp4");
    await makeTestVideo(file);
    const up = await storeUpload(p, wid, file, { kind: "video", role: "app_recording", mimeType: "video/mp4", appId: app.id });
    const rec = await ws.collection("mediaAssets").update(up.id, { status: "ready", width: 160, height: 120, durationSec: 2, fps: 10 }, { actor: "u1" });
    const seg = (await ws.collection("recordingSegments").create(
      { appId: app.id, assetId: rec.id, startSec: 0, endSec: 2, label: "Box moves", action: "scroll", featureIds: [], quality: 0.9, privacy: { flagged: false, regions: [] }, keyframeAtSec: 0.5 },
      { actor: "u1" },
    )) as RecordingSegment;
    const sc = (i: number, template: string, over: Partial<StoryboardScene> = {}): StoryboardScene => ({ id: `sbs_${i}`, order: i, purpose: "demo", durationSec: 3, onScreenText: "Watch it move", narration: "", visual: "", template, assets: [{ kind: "app_recording", segmentId: seg.id }], claimIds: [], ...over });
    const sb = await ws.collection("storyboards").create(
      {
        appId: app.id,
        campaignId: "cmp_1",
        variantId: "var_1",
        title: "Boxy",
        aspectRatio: "9:16",
        targetDurationSec: 9,
        scenes: [sc(0, "focus-zoom", { focus: { x: 25 / 160, y: 0.25, w: 0.25, h: 0.5 }, focusQuery: "red box" }), sc(1, "device-demo"), sc(2, "focus-zoom", { assets: [{ kind: "screenshot", assetId: "ast_none" }], focus: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })],
        voiceover: { source: "none" },
        music: {},
      },
      { actor: "u1" },
    );
    const job = await p.jobs.create(wid, "storyboard.resolve_media", { appId: app.id, storyboardId: sb.id, compositionId: `cmp_${sb.id}` }, { actor: "u1", appId: app.id, idempotencyKey: "focus-1" });
    await p.inline!.drain();
    const done = (await p.jobs.get(wid, job.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.output?.data).toMatchObject({ focusTracked: 1 });
    expect(builds).toEqual([sb.id]); // the build still follows
    // One SAM call: the box prompt on the keyframe's frame (0.5 s → frame 5 at 10 fps).
    const sam = calls.filter((c) => c.url.endsWith("/responses"));
    expect(sam).toHaveLength(1);
    expect(promptBoxes(samPromptOf(sam[0]!.json!))[0]).toMatchObject({ id: 1, frame: 5, x1: 25 });
    const after = await ws.collection("storyboards").getOrThrow(sb.id);
    const path = after.scenes[0]!.focusPath!;
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[path.length - 1]!.x).toBeGreaterThan(path[0]!.x + 0.2); // follows the element to the right
    expect(after.scenes[1]!.focusPath).toBeUndefined(); // no focus
    expect(after.scenes[2]!.focusPath).toBeUndefined(); // not a walkthrough segment

    // Idempotent: a scene that already follows is not tracked again.
    const again = await p.jobs.create(wid, "storyboard.resolve_media", { appId: app.id, storyboardId: sb.id, compositionId: `cmp_${sb.id}` }, { actor: "u1", appId: app.id, idempotencyKey: "focus-2" });
    await p.inline!.drain();
    expect((await p.jobs.get(wid, again.id))!.output?.data).toMatchObject({ focusTracked: 0 });
    expect(calls.filter((c) => c.url.endsWith("/responses"))).toHaveLength(1);
  });
});
