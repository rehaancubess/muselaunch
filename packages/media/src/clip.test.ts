import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaAsset } from "@muselaunch/contracts";
import { createTestPlatform, type Platform } from "@muselaunch/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestClipAnalysis } from "./clip";
import { ffmpeg, ffprobeJson } from "./ffmpeg";
import { handlers } from "./index";
import { installFakeMeta, loadFixture, makeTestClip, samPromptOf, storeUpload, type RecordedCall } from "./testing";
import { loadTracks } from "./tracks";

const dir = mkdtempSync(join(tmpdir(), "media-clip-test-"));
const person = loadFixture<{ rawOutput: string }>("sam-clip-person.json").rawOutput;
const phone = loadFixture<{ rawOutput: string }>("sam-clip-phone.json").rawOutput;
const transcript = loadFixture<{ response: unknown }>("voice-transcribe-documented.json").response;
const W = 320;
const H = 240;

async function alphaAt(file: string, frame: number, points: [number, number][]): Promise<number[]> {
  const out = join(dir, `f-${frame}-${Math.random().toString(36).slice(2)}.rgba`);
  await ffmpeg(["-c:v", "libvpx-vp9", "-i", file, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", out]);
  const buf = await readFile(out);
  expect(buf.length).toBe(W * H * 4);
  return points.map(([x, y]) => buf[(y * W + x) * 4 + 3]!);
}

describe("media.analyze_clip (SAM tracks + per-object outputs + transcript)", () => {
  let p: Platform;
  let calls: RecordedCall[];
  const wid = "ws_clip";
  let asset: MediaAsset;
  const samPrompts: string[] = [];

  beforeAll(async () => {
    p = createTestPlatform({ META_API_KEY: "test-meta-key" }, handlers);
    ({ calls } = installFakeMeta(p, {
      samOutput: (body) => {
        const prompt = samPromptOf(body);
        samPrompts.push(prompt);
        if (prompt === "person") return person;
        if (prompt === "phone") return phone;
        return { status: 400, error: { message: "invalid prompt", type: "invalid_request_error", code: "invalid_prompt" } };
      },
      transcribe: () => transcript,
    }));
    await p.credits.ensureAccount(wid, { grant: 500, reason: "test" });
    const file = join(dir, "clip.mp4");
    await makeTestClip(file);
    const a = await storeUpload(p, wid, file, { kind: "video", role: "founder_clip", mimeType: "video/mp4", consent: true });
    await p.jobs.create(wid, "media.probe", { assetId: a.id }, { actor: "tester", idempotencyKey: `probe:${a.id}` });
    await p.inline!.drain();
    asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(a.id);
    expect([asset.width, asset.height, asset.fps]).toEqual([W, H, 10]);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  let analysisId = "";
  it("tracks person + phone, builds per-object cutouts, and attaches the transcript", async () => {
    const before = (await p.credits.balance(wid)).available;
    const { analysis, job } = await requestClipAnalysis(p, wid, { asset, actor: "tester" });
    expect(analysis.prompts).toEqual(["person", "phone"]);
    expect(job!.reservation!.credits).toBe(12 + 12 + 1);
    await p.inline!.drain();
    const done = await p.db.ws(wid).collection("clipAnalyses").getOrThrow(analysis.id);
    analysisId = done.id;
    expect(done.status).toBe("succeeded");
    expect(done.transcriptId).toBeTruthy();
    expect(Object.keys(done.segmentationIds)).toEqual(["person", "phone"]);
    expect(done.objects.map((o) => o.key)).toEqual(["person:0", "phone:0", "phone:1"]);
    const byKey = Object.fromEntries(done.objects.map((o) => [o.key, o]));
    expect(byKey["person:0"]!.presence).toEqual([{ startSec: 0, endSec: 3 }]);
    expect(byKey["phone:0"]!.presence).toEqual([{ startSec: 0.5, endSec: 2.5 }]);
    expect(byKey["phone:1"]!.presence).toEqual([{ startSec: 0, endSec: 3 }]);
    expect(byKey["person:0"]!.trackingQuality).toBeGreaterThan(0.9);
    expect(byKey["phone:0"]!.trackingQuality).toBeLessThan(byKey["person:0"]!.trackingQuality!); // absent for a third of the clip
    const mb = byKey["phone:1"]!.meanBbox!;
    expect([mb.x, mb.y, mb.w, mb.h].map((v) => Math.round(v * 1000))).toEqual([270 / W, 10 / H, 20 / W, 30 / H].map((v) => Math.round(v * 1000)));
    expect((await p.jobs.get(wid, job!.id))!.creditsCharged).toBe(25);
    expect((await p.credits.balance(wid)).available).toBe(before - 25);
    expect(samPrompts).toEqual(["person", "phone"]);
    expect(calls.filter((c) => c.url.includes("/asr/transcribe"))).toHaveLength(1);

    // Tracks follow the motion (within 1 px) and are invisible where SAM saw nothing.
    const personTracks = (await loadTracks(p, p.db.ws(wid), done.segmentationIds.person!))!;
    expect(personTracks).toMatchObject({ fps: 10, frameCount: 30, width: W, height: H });
    for (const i of [0, 10, 29]) {
      const f = personTracks.tracks[0]!.frames[i]!;
      expect(f.visible).toBe(true);
      expect(f.t).toBeCloseTo(i / 10);
      expect(f.centroid!.x * W).toBeCloseTo(20 + 4 * i + 40, 0);
      expect(f.centroid!.y * H).toBeCloseTo(60 + 70, 0);
      expect(f.bbox!.x * W).toBeCloseTo(20 + 4 * i, 3);
      expect(f.area).toBeCloseTo((80 * 140 - 16) / (W * H), 3);
      expect(f.score).toBe(0.97);
    }
    const phoneTracks = (await loadTracks(p, p.db.ws(wid), done.segmentationIds.phone!))!;
    const moving = phoneTracks.tracks.find((t) => t.objectId === "0")!;
    expect(moving.frames[2]!.visible).toBe(false);
    expect(moving.frames[2]!.centroid).toBeUndefined();
    for (const i of [5, 12, 24]) {
      const f = moving.frames[i]!;
      expect(f.visible).toBe(true);
      expect(f.centroid!.x * W).toBeCloseTo(40 + 5 * i + 12, 0);
      expect(f.centroid!.y * H).toBeCloseTo(30 + 3 * i + 20, 0);
    }
    expect(moving.frames[25]!.visible).toBe(false);

    // Per-object outputs: the phone cutout contains only that phone; the person cutout only the person.
    const segs = p.db.ws(wid).collection("segmentations");
    const assets = p.db.ws(wid).collection("mediaAssets");
    const phoneSeg = await segs.getOrThrow(done.segmentationIds.phone!);
    const personSeg = await segs.getOrThrow(done.segmentationIds.person!);
    expect(Object.keys(phoneSeg.objectOutputs).sort()).toEqual(["0", "1"]);
    expect(phoneSeg.objectOutputs["0"]!.cutoutAssetId).not.toBe(phoneSeg.cutoutAssetId);
    expect(personSeg.objectOutputs["0"]).toEqual({ cutoutAssetId: personSeg.cutoutAssetId, matteAssetId: personSeg.maskAssetId });
    const phone0 = join(dir, "phone0.webm");
    await p.storage.downloadToFile((await assets.getOrThrow(phoneSeg.objectOutputs["0"]!.cutoutAssetId!)).storagePath, phone0);
    const meta = await ffprobeJson(phone0);
    expect(meta.streams!.find((s) => s.codec_type === "video")!.tags?.alpha_mode ?? meta.streams!.find((s) => s.codec_type === "video")!.tags?.ALPHA_MODE).toBe("1");
    // frame 10: phone 0 at (90..113, 60..99); person at (60..139, 60..199); phone 1 at (270..289, 10..39)
    const [onPhone, onPerson, onPhone1] = await alphaAt(phone0, 10, [[102, 80], [130, 180], [280, 25]]);
    expect(onPhone).toBeGreaterThan(240);
    expect(onPerson).toBeLessThan(15);
    expect(onPhone1).toBeLessThan(15);
    const phone1 = join(dir, "phone1.webm");
    await p.storage.downloadToFile((await assets.getOrThrow(phoneSeg.objectOutputs["1"]!.cutoutAssetId!)).storagePath, phone1);
    const [p1a, p1b] = await alphaAt(phone1, 10, [[280, 25], [102, 80]]);
    expect(p1a).toBeGreaterThan(240);
    expect(p1b).toBeLessThan(15);
    const personCut = join(dir, "person.webm");
    await p.storage.downloadToFile((await assets.getOrThrow(personSeg.objectOutputs["0"]!.cutoutAssetId!)).storagePath, personCut);
    const [pa, pb] = await alphaAt(personCut, 10, [[130, 180], [250, 20]]);
    expect(pa).toBeGreaterThan(240);
    expect(pb).toBeLessThan(15);
    const matte = await assets.getOrThrow(phoneSeg.objectOutputs["1"]!.matteAssetId!);
    expect(matte).toMatchObject({ kind: "mask", sourceLabel: "sam_matte", mimeType: "video/mp4" });
  });

  it("reuses everything for a repeat analysis: no SAM/voice calls, no usage events, no credits", async () => {
    const usageBefore = (await p.db.ws(wid).collection("modelUsage").list({ limit: 200 })).items.length;
    const callsBefore = calls.length;
    const balance = (await p.credits.balance(wid)).available;

    const same = await requestClipAnalysis(p, wid, { asset, prompts: ["phone", "person"], actor: "tester" });
    expect(same).toMatchObject({ job: null, reused: true, analysis: { id: analysisId } });

    const subset = await requestClipAnalysis(p, wid, { asset, prompts: ["phone"], actor: "tester" });
    expect(subset.job!.reservation).toBeUndefined(); // estimate is 0: cached segmentation + transcript
    await p.inline!.drain();
    const a = await p.db.ws(wid).collection("clipAnalyses").getOrThrow(subset.analysis.id);
    expect(a.status).toBe("succeeded");
    expect(a.objects.map((o) => o.key)).toEqual(["phone:0", "phone:1"]);
    expect(calls.length).toBe(callsBefore);
    expect((await p.db.ws(wid).collection("modelUsage").list({ limit: 200 })).items.length).toBe(usageBefore);
    expect((await p.credits.balance(wid)).available).toBe(balance);
  });

  it("reports a failing prompt as partial without inventing tracks", async () => {
    const { analysis } = await requestClipAnalysis(p, wid, { asset, prompts: ["person", "mug"], transcribe: false, actor: "tester" });
    await p.inline!.drain();
    const a = await p.db.ws(wid).collection("clipAnalyses").getOrThrow(analysis.id);
    expect(a.status).toBe("partial");
    expect(a.error).toContain("“mug”");
    expect(a.objects.map((o) => o.key)).toEqual(["person:0"]);
    expect(a.transcriptId).toBeUndefined();
    const mugSeg = await p.db.ws(wid).collection("segmentations").getOrThrow(a.segmentationIds.mug!);
    expect(mugSeg.status).toBe("failed");
    expect(mugSeg.tracksAssetId).toBeUndefined();
    expect(mugSeg.error).toBeTruthy();
  });

  it("fails visibly (and releases credits) when SAM is not configured", async () => {
    const q = createTestPlatform({}, handlers);
    await q.credits.ensureAccount(wid, { grant: 100, reason: "test" });
    const a = await storeUpload(q, wid, join(dir, "clip.mp4"), { kind: "video", role: "app_recording", mimeType: "video/mp4" });
    await q.jobs.create(wid, "media.probe", { assetId: a.id }, { actor: "tester", idempotencyKey: `probe:${a.id}` });
    await q.inline!.drain();
    const ready = await q.db.ws(wid).collection("mediaAssets").getOrThrow(a.id);
    const { analysis, job } = await requestClipAnalysis(q, wid, { asset: ready, prompts: ["phone"], transcribe: false, actor: "tester" });
    await q.inline!.drain();
    expect(await q.db.ws(wid).collection("clipAnalyses").getOrThrow(analysis.id)).toMatchObject({ status: "failed" });
    expect(await q.jobs.get(wid, job!.id)).toMatchObject({ status: "failed", error: { code: "PROVIDER_NOT_CONFIGURED" } });
    expect((await q.credits.balance(wid)).available).toBe(100);
  });
});
