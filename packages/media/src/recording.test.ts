import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaAsset, RecordingSegment } from "@muselaunch/contracts";
import { AppError, createTestPlatform, type Platform } from "@muselaunch/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectShots, keyframeTimes, sampleFrameChanges, type FrameChanges } from "./frames";
import { handlers } from "./index";
import { batchShots, mergeAdjacent, narrationFor, recordingProblem, requestRecordingAnalysis } from "./recording";
import { imageCountOf, installFakeMeta, loadFixture, makeTestWalkthrough, schemaOf, storeUpload, textOf, type RecordedCall } from "./testing";

const dir = mkdtempSync(join(tmpdir(), "media-walkthrough-test-"));
const transcript = loadFixture<{ response: unknown }>("voice-transcribe-documented.json").response;

/** FrameChanges at 10 fps from a list of (seconds, changeShare) runs. */
function changes(runs: [number, number][], fps = 10): FrameChanges {
  const change: number[] = [];
  for (const [sec, c] of runs) for (let i = 0; i < Math.round(sec * fps); i++) change.push(c);
  change[0] = 0;
  return { fps, times: change.map((_, i) => i / fps), change };
}

describe("shot detection", () => {
  it("cuts on short changes, keeps long motion as its own shot, merges micro-shots and splits long shots", () => {
    const d = changes([
      [3, 0], // screen A
      [0.2, 1], // tap → instant cut
      [4, 0], // screen B
      [0.3, 0.5], // push animation (transition, excluded)
      [0.5, 0], // 0.5 s flash (micro-shot → merged into the next)
      [0.1, 1],
      [2.5, 0], // screen C
      [2, 0.3], // 2 s of scrolling (motion shot)
      [19.4, 0.01], // one long calm screen → split into 3
    ]);
    const shots = detectShots(d, 32);
    const ranges = shots.map((s) => [s.startSec, s.endSec]);
    expect(ranges[0]).toEqual([0, 2.9]);
    expect(ranges[1]).toEqual([3.1, 7.1]);
    // the 0.5 s flash (7.4–7.9) is merged into screen C, which runs until the scroll starts
    expect(ranges[2]).toEqual([7.4, 10.5]);
    expect(shots[3]).toMatchObject({ startSec: 10.5, endSec: 12.5, motion: true });
    const tail = shots.slice(4);
    expect(tail.map((s) => [s.startSec, s.endSec])).toEqual([
      [12.5, 19],
      [19, 25.5],
      [25.5, 32],
    ]);
    for (const s of shots) expect(s.endSec - s.startSec).toBeLessThanOrEqual(8);
    for (const s of shots) expect(s.endSec - s.startSec).toBeGreaterThanOrEqual(0.8);
  });

  it("caps the number of shots by merging the shortest", () => {
    const runs: [number, number][] = [];
    for (let i = 0; i < 40; i++) runs.push([1, 0], [0.1, 1]);
    const shots = detectShots(changes(runs), 44, { changeThreshold: 0.04, maxTransitionSec: 1, minShotSec: 0.8, maxShotSec: 8, splitSearchSec: 1.5, maxShots: 10 });
    expect(shots).toHaveLength(10);
    for (let i = 1; i < shots.length; i++) expect(shots[i]!.startSec).toBeGreaterThanOrEqual(shots[i - 1]!.endSec);
  });

  it("samples 1 still for short shots and 2 for longer ones, and batches ≤ 8 images without splitting a shot", () => {
    expect(keyframeTimes({ startSec: 2, endSec: 5 })).toEqual([3.5]);
    expect(keyframeTimes({ startSec: 0, endSec: 6 })).toEqual([2, 4]);
    const shots = [2, 2, 1, 2, 2, 1, 2].map((n, i) => ({ i, frames: Array.from({ length: n }) }));
    expect(batchShots(shots).map((b) => b.map((s) => s.i))).toEqual([[0, 1, 2, 3], [4, 5, 6]]);
  });

  it("merges adjacent shots with the same label or the same screen/action/features, within limits", () => {
    const base = { motion: false, frames: [], labelled: true, action: "tap" as const, privacy: { flagged: false, regions: [] }, keyframe: { atSec: 0, file: "x" } };
    const merged = mergeAdjacent([
      { ...base, index: 0, startSec: 0, endSec: 3, label: "Starts a focus session", featureIds: ["f1"], quality: 0.9 },
      { ...base, index: 1, startSec: 3.1, endSec: 6, label: "starts a focus session.", featureIds: ["f1"], quality: 0.6, privacy: { flagged: true, notes: "Banner", regions: [{ x: 0, y: 0, w: 1, h: 0.1 }] } },
      { ...base, index: 2, startSec: 6, endSec: 9, label: "Timer counts down", screen: "Timer", featureIds: ["f1"], quality: 0.8 },
      { ...base, index: 3, startSec: 9, endSec: 12, label: "Timer running", screen: "timer", featureIds: ["f1"], quality: 0.8 },
      { ...base, index: 4, startSec: 12, endSec: 30, label: "Timer running", screen: "timer", featureIds: ["f1"], quality: 0.8 },
    ]);
    expect(merged.map((s) => [s.startSec, s.endSec])).toEqual([[0, 6], [6, 12], [12, 30]]);
    expect(merged[0]!.quality).toBeCloseTo((0.9 * 3 + 0.6 * 2.9) / 5.9, 2);
    expect(merged[0]!.privacy).toMatchObject({ flagged: true, notes: "Banner", regions: [{ x: 0, y: 0, w: 1, h: 0.1 }] });
  });

  it("attaches the narration overlapping a segment", () => {
    const turns = [
      { startSec: 1, endSec: 4, text: "Here is the timer." },
      { startSec: 5, endSec: 7, text: "Now I start a session." },
    ];
    expect(narrationFor(turns, 0, 2)).toBe("Here is the timer.");
    expect(narrationFor(turns, 3, 6)).toBe("Here is the timer. Now I start a session.");
    expect(narrationFor(turns, 8, 9)).toBeUndefined();
  });
});

describe("media.analyze_recording (walkthrough → labelled clips)", () => {
  let p: Platform;
  let calls: RecordedCall[];
  const wid = "ws_walk";
  let appId = "";
  let asset: MediaAsset;
  const spark: { omit?: number[]; fail?: boolean } = {};

  beforeAll(async () => {
    p = createTestPlatform({ META_API_KEY: "test-meta-key" }, handlers);
    ({ calls } = installFakeMeta(p, {
      transcribe: () => transcript,
      spark: (body) => {
        if (spark.fail) return new Response(JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
        expect(schemaOf(body)).toBe("RecordingShotLabels");
        const shots = [...textOf(body).matchAll(/^Shot (\d+) ·/gm)].map((m) => Number(m[1]));
        const label = (n: number) =>
          n === 0
            ? { shot: n, label: "Opens the timer", screen: "Home", action: "navigate", featureIds: ["feat_timer", "feat_not_in_dna"], quality: 0.9, privacy: { flagged: false, regions: [] } }
            : n === 3
              ? { shot: n, label: "Weekly report with a notification banner", screen: "Report", action: "scroll", featureIds: ["feat_reports"], quality: 0.25, privacy: { flagged: true, notes: "Message banner shows a name", regions: [{ x: 0.02, y: -0.1, w: 1.2, h: 0.15 }] } }
              : { shot: n, label: "Starts a focus session", screen: "Timer", action: "tap", featureIds: ["feat_timer"], quality: 0.8, privacy: { flagged: false, regions: [] } };
        return { shots: shots.filter((n) => !spark.omit?.includes(n)).map(label) };
      },
    }));
    await p.credits.ensureAccount(wid, { grant: 100, reason: "test" });
    const ws = p.db.ws(wid);
    const app = await ws.collection("apps").create({ name: "Tidy Timer", status: "draft", dnaStatus: "needs_review" }, { actor: "tester" });
    appId = app.id;
    await ws.collection("brandProfiles").create(
      {
        id: appId,
        appId,
        version: 1,
        status: "draft",
        oneLiner: "A calm Pomodoro timer.",
        description: "Focus sessions and weekly reports.",
        features: [
          { id: "feat_timer", name: "Pomodoro timer", description: "Custom-length focus sessions.", evidenceIds: [], assetIds: [] },
          { id: "feat_reports", name: "Weekly reports", description: "Weekly focus reports.", evidenceIds: [], assetIds: [] },
        ],
        prohibitedClaims: [],
        competitorIds: [],
        guidelines: "",
        userEditedPaths: ["features"],
      },
      { actor: "tester" },
    );
    const file = join(dir, "walkthrough.mp4");
    await makeTestWalkthrough(file, { audio: true });
    const up = await storeUpload(p, wid, file, { kind: "video", role: "app_recording", mimeType: "video/mp4", appId, consent: true });
    // Upload finished → media.probe → the breakdown is queued automatically.
    await p.jobs.create(wid, "media.probe", { assetId: up.id }, { actor: "tester", appId, idempotencyKey: `probe:${up.id}` });
    await p.inline!.drain();
    asset = await ws.collection("mediaAssets").getOrThrow(up.id);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("finds the shots of the real file", async () => {
    const src = join(dir, "walkthrough.mp4");
    const d = await sampleFrameChanges(src, join(dir, "samples.rgb"));
    const shots = detectShots(d, 16.5);
    expect(shots.map((s) => [s.startSec, s.endSec])).toEqual([
      [0, 2.833],
      [3, 8.333], // the 0.4 s flash leads into the long screen, which is split at a calm point
      [8.333, 13.833],
      [14, 16.5],
    ]);
  });

  it("labels each shot with Muse Spark, merges same-label neighbours, attaches narration and stores segments", async () => {
    const ws = p.db.ws(wid);
    const jobs = (await ws.collection("jobs").list({ where: [["appId", "==", appId]], limit: 20 })).items;
    const job = jobs.find((j) => j.type === "media.analyze_recording")!;
    expect(job).toMatchObject({ status: "succeeded", payload: { assetId: asset.id, transcribe: true }, reservation: { credits: 6 }, creditsCharged: 6 });
    expect(jobs.find((j) => j.type === "media.probe")!.output?.data).toMatchObject({ analyzeRecordingJobId: job.id });

    const sparkCalls = calls.filter((c) => c.url.endsWith("/responses") && c.json && schemaOf(c.json) === "RecordingShotLabels");
    expect(sparkCalls).toHaveLength(1);
    expect(imageCountOf(sparkCalls[0]!.json!)).toBe(6); // 1 + 2 + 2 + 1 stills
    const text = textOf(sparkCalls[0]!.json!);
    expect(text).toContain("feat_timer: Pomodoro timer");
    expect(text).toContain("How is the weather?"); // narration goes to Spark as context
    expect(calls.filter((c) => c.url.includes("/asr/transcribe"))).toHaveLength(1);

    const segs = (await ws.collection("recordingSegments").list({ where: [["assetId", "==", asset.id]], orderBy: { field: "startSec", dir: "asc" }, limit: 50 })).items as RecordingSegment[];
    expect(segs.map((s) => [s.startSec, s.endSec, s.label])).toEqual([
      [0, 2.833, "Opens the timer"],
      [3, 13.833, "Starts a focus session"],
      [14, 16.5, "Weekly report with a notification banner"],
    ]);
    expect(segs[0]).toMatchObject({ appId, featureIds: ["feat_timer"], quality: 0.9, action: "navigate", screen: "Home", narration: "How is the weather?", labelledBy: "muse-spark-1.3" });
    expect(segs[1]!.narration).toBe("How is the weather? It is raining.");
    expect(segs[2]!.privacy).toEqual({ flagged: true, notes: "Message banner shows a name", regions: [{ x: 0.02, y: 0, w: 0.98, h: 0.15 }] });
    for (const s of segs) {
      const kf = await ws.collection("mediaAssets").getOrThrow(s.keyframeAssetId!);
      expect(kf).toMatchObject({ kind: "image", role: "thumbnail", origin: "derived", sourceLabel: "recording_keyframe", derivedFromAssetId: asset.id, isProductTruth: false, width: 180, height: 320 });
      expect((await p.storage.get(kf.storagePath)).subarray(0, 2).toString("hex")).toBe("ffd8");
    }
    // The recording becomes evidence for the features it shows well (added even though the founder edited features).
    const dna = await ws.collection("brandProfiles").getOrThrow(appId);
    expect(dna.features.find((f) => f.id === "feat_timer")!.assetIds).toEqual([asset.id]);
    expect(dna.features.find((f) => f.id === "feat_reports")!.assetIds).toEqual([]); // quality 0.25: not evidence
    const transcriptDoc = (await ws.collection("transcripts").list({ where: [["sourceAssetId", "==", asset.id]], limit: 5 })).items[0]!;
    expect(transcriptDoc).toMatchObject({ purpose: "captions", status: "succeeded" });
  });

  it("re-runs idempotently: replaces the recording's segments and keeps unlabelled shots honest", async () => {
    const ws = p.db.ws(wid);
    const before = (await ws.collection("recordingSegments").list({ where: [["assetId", "==", asset.id]], orderBy: { field: "startSec", dir: "asc" }, limit: 50 })).items;
    spark.omit = [3];
    const { job, estimate } = await requestRecordingAnalysis(p, wid, { asset, appId, actor: "tester", idempotencyKey: "rerun-1" });
    expect(estimate).toEqual({ credits: 6, minutes: 1, perMinute: 6 });
    await p.inline!.drain();
    spark.omit = undefined;
    expect((await p.jobs.get(wid, job.id))!.status).toBe("succeeded");
    const after = (await ws.collection("recordingSegments").list({ where: [["assetId", "==", asset.id]], orderBy: { field: "startSec", dir: "asc" }, limit: 50 })).items;
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2).map((s) => s.id)).toEqual(before.slice(0, 2).map((s) => s.id)); // same shots → same ids
    expect(after[2]).toMatchObject({ label: "Unlabelled shot 0:14.0–0:16.5", quality: 0.2, featureIds: [], privacy: { flagged: false } });
    expect(after[2]!.labelledBy).toBeUndefined();
    // The transcript is reused, not paid for twice.
    expect(calls.filter((c) => c.url.includes("/asr/transcribe"))).toHaveLength(1);
  });

  it("fails visibly when Muse Spark fails: no segments replaced, credits released", async () => {
    const ws = p.db.ws(wid);
    const balance = (await p.credits.balance(wid)).available;
    const before = (await ws.collection("recordingSegments").list({ where: [["assetId", "==", asset.id]], orderBy: { field: "startSec", dir: "asc" }, limit: 50 })).items.map((s) => s.id);
    spark.fail = true;
    const { job } = await requestRecordingAnalysis(p, wid, { asset, appId, actor: "tester", idempotencyKey: "rerun-fail" });
    await p.inline!.drain();
    spark.fail = false;
    const failed = (await p.jobs.get(wid, job.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.creditsCharged ?? 0).toBe(0);
    expect((await p.credits.balance(wid)).available).toBe(balance);
    const after = (await ws.collection("recordingSegments").list({ where: [["assetId", "==", asset.id]], orderBy: { field: "startSec", dir: "asc" }, limit: 50 })).items.map((s) => s.id);
    expect(after).toEqual(before);
  });

  it("skips the narration without consent for the voice, and refuses recordings it can't break down", async () => {
    const ws = p.db.ws(wid);
    const asr = calls.filter((c) => c.url.includes("/asr/transcribe")).length;
    // A second recording without consent (different hash, so the earlier transcript can't be reused).
    const copy = await ws.collection("mediaAssets").create(
      { appId, kind: "video", role: "app_recording", origin: "upload", storagePath: asset.storagePath, mimeType: asset.mimeType, bytes: asset.bytes, sha256: "different-hash", width: asset.width, height: asset.height, durationSec: asset.durationSec, fps: asset.fps, hasAudio: true, status: "ready", title: "Second walkthrough", isProductTruth: true, license: { type: "user_uploaded" } },
      { actor: "tester" },
    );
    const { job } = await requestRecordingAnalysis(p, wid, { asset: copy, appId, actor: "tester", idempotencyKey: "no-consent" });
    await p.inline!.drain();
    const done = (await p.jobs.get(wid, job.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.output?.data).toMatchObject({ narration: "not transcribed: no consent recorded for the voice in this recording" });
    expect(calls.filter((c) => c.url.includes("/asr/transcribe"))).toHaveLength(asr);
    const segs = (await ws.collection("recordingSegments").list({ where: [["assetId", "==", copy.id]], orderBy: { field: "startSec", dir: "asc" }, limit: 50 })).items;
    expect(segs.every((s) => s.narration === undefined)).toBe(true);

    const long = { ...asset, durationSec: 601 };
    expect(recordingProblem(long, appId)?.opts.userMessage).toMatch(/up to 10 minutes/);
    await expect(requestRecordingAnalysis(p, wid, { asset: long, appId, actor: "tester" })).rejects.toBeInstanceOf(AppError);
    expect(recordingProblem({ ...asset, role: "founder_clip" }, appId)?.code).toBe("BAD_REQUEST");
    expect(recordingProblem(asset, "app_other")?.code).toBe("NOT_FOUND");
    expect(recordingProblem({ ...asset, status: "processing" }, appId)?.code).toBe("CONFLICT");
  });
});
