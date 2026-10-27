import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlers, installMediaDeps } from "@muselaunch/media";
import { installFakeMeta, loadFixture, makeTestAudio, makeTestVideo } from "@muselaunch/media/testing";
import { createTestPlatform } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function client(app: ReturnType<typeof buildApp>, uid: string) {
  const auth = { authorization: `Bearer dev:${uid}:${uid}@example.com` };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Json };
  };
  return { get: (p: string) => call("GET", p), post: (p: string, b?: unknown) => call("POST", p, b) };
}

describe("media API", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-api-"));
  const p = createTestPlatform({ META_API_KEY: "test-meta-key", OPENAI_API_KEY: "sk-test" }, handlers);
  const sam = loadFixture<{ rawOutput: string }>("sam-video-moving-box.json");
  const meta = installFakeMeta(p, {
    samOutput: () => sam.rawOutput,
    transcribe: () => ({ sessionId: "s1", transcript: "Make the opening more engaging.", audioDurationMs: 2000, turns: [] }),
  });
  const openverse = loadFixture<{ response: Json }>("openverse-search.json").response;
  const imagesFx = loadFixture<{ response: Json }>("openai-images-generate.json").response;
  installMediaDeps(p, {
    fetch: (async (url: string) => {
      if (url.startsWith("https://api.openverse.org/")) return new Response(JSON.stringify(openverse), { status: 200 });
      if (url.startsWith("https://api.openai.com/v1/images/")) return new Response(JSON.stringify(imagesFx), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
  });
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  let wsA = "";
  let wsB = "";
  let videoId = "";

  async function upload(ws: string, file: string, mimeType: string, role: string, extra: Json = {}) {
    const bytes = readFileSync(file);
    const res = await alice.post(`/v1/workspaces/${ws}/uploads`, { filename: file.split("/").pop(), mimeType, bytes: bytes.length, role, ...extra });
    expect(res.status).toBe(201);
    const put = await app.request(new URL(res.json.upload.url).pathname, { method: "PUT", headers: { "content-type": mimeType }, body: bytes });
    expect(put.status).toBe(200);
    const done = await alice.post(`/v1/workspaces/${ws}/assets/${res.json.asset.id}/complete`);
    expect(done.json.job.type).toBe("media.probe");
    await p.inline!.drain();
    return res.json.asset.id as string;
  }

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).json.workspace.id;
    wsB = (await bob.post("/v1/workspaces", { name: "Bob Studio" })).json.workspace.id;
    const file = join(dir, "clip.mp4");
    await makeTestVideo(file, { audio: true });
    videoId = await upload(wsA, file, "video/mp4", "app_recording");
  });

  it("segments via the API, returns assets, and reuses the result for the same prompt", async () => {
    const res = await alice.post(`/v1/workspaces/${wsA}/assets/${videoId}/segment`, { prompt: "red box" });
    expect(res.status).toBe(202);
    expect(res.json.job).toMatchObject({ type: "media.segment", reservation: { credits: 12 } });
    await p.inline!.drain();
    const got = await alice.get(`/v1/workspaces/${wsA}/segmentations/${res.json.segmentation.id}`);
    expect(got.status).toBe(200);
    expect(got.json.segmentation.status).toBe("succeeded");
    expect(got.json.assets.cutout).toMatchObject({ mimeType: "video/webm", sourceLabel: "sam_cutout" });
    expect(got.json.assets.preview).toMatchObject({ role: "preview" });
    expect(got.json.lowQuality).toBe(false);

    const again = await alice.post(`/v1/workspaces/${wsA}/assets/${videoId}/segment`, { prompt: "red box" });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ job: null, reused: true, segmentation: { id: res.json.segmentation.id } });
    expect(meta.calls.filter((c) => c.url.endsWith("/v1/responses"))).toHaveLength(1);

    const list = await alice.get(`/v1/workspaces/${wsA}/assets/${videoId}/segmentations`);
    expect(list.json.items.map((s: Json) => s.id)).toContain(res.json.segmentation.id);

    const corr = await alice.post(`/v1/workspaces/${wsA}/segmentations/${res.json.segmentation.id}/correct`, { kind: "objects", objectIds: ["0"] });
    expect(corr.status).toBe(202);
    expect(corr.json.job.reservation).toBeUndefined();
    await p.inline!.drain();
    const bad = await alice.post(`/v1/workspaces/${wsA}/segmentations/${res.json.segmentation.id}/correct`, { kind: "objects", objectIds: ["99"] });
    expect(bad.status).toBe(400);
  });

  it("isolates tenants", async () => {
    const seg = (await alice.get(`/v1/workspaces/${wsA}/assets/${videoId}/segmentations`)).json.items[0];
    expect((await bob.get(`/v1/workspaces/${wsA}/segmentations/${seg.id}`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/segmentations/${seg.id}`)).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsB}/assets/${videoId}/segment`, { prompt: "red box" })).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsB}/assets/${videoId}/transcribe`, { purpose: "voice_command" })).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/assets/${seg.cutoutAssetId}/url`)).status).toBe(404);
  });

  it("requires consent for person prompts and records it", async () => {
    const res = await alice.post(`/v1/workspaces/${wsA}/assets/${videoId}/segment`, { prompt: "person" });
    expect(res.status).toBe(400);
    expect(res.json.error.details).toEqual({ consentRequired: true });
    const ok = await alice.post(`/v1/workspaces/${wsA}/assets/${videoId}/segment`, { prompt: "person", consent: { scope: "I am the person in this clip" } });
    expect(ok.status).toBe(202);
    await p.inline!.drain();
  });

  it("analyses a clip: 202 {job, analysis}, detail with signed URLs + tracks, identical repeat → 200 reuse, tenancy", async () => {
    // A second upload of the same clip (no consent recorded yet): SAM results are reused by content hash.
    const videoId = await upload(wsA, join(dir, "clip.mp4"), "video/mp4", "app_recording");
    const needConsent = await alice.post(`/v1/workspaces/${wsA}/assets/${videoId}/analyze-clip`, { prompts: ["red box"] });
    expect(needConsent.status).toBe(400);
    expect(needConsent.json.error.details).toEqual({ consentRequired: true });
    const est = await alice.post(`/v1/workspaces/${wsA}/assets/${videoId}/analyze-clip/estimate`, { prompts: ["red box"] });
    expect(est.json).toMatchObject({ credits: 1, breakdown: [{ label: "Track “red box” (reused)", credits: 0 }, { label: "Transcript", credits: 1 }] });

    const res = await alice.post(`/v1/workspaces/${wsA}/assets/${videoId}/analyze-clip`, { prompts: ["red box"], consent: { scope: "My own demo clip" } });
    expect(res.status).toBe(202);
    expect(res.json.job).toMatchObject({ type: "media.analyze_clip" });
    expect(res.json.analysis).toMatchObject({ status: "queued", prompts: ["red box"], transcribe: true });
    await p.inline!.drain();

    const got = await alice.get(`/v1/workspaces/${wsA}/clip-analyses/${res.json.analysis.id}`);
    expect(got.status).toBe(200);
    const { analysis, segmentations, assets, tracksUrls } = got.json;
    expect(analysis.status).toBe("succeeded");
    expect(analysis.objects.map((o: Json) => o.key)).toEqual(["red box:0", "red box:1"]);
    expect(segmentations).toHaveLength(1);
    const seg = segmentations[0];
    expect(Object.keys(seg.objectOutputs).sort()).toEqual(["0", "1"]);
    expect(assets[videoId]).toMatchObject({ kind: "video", role: "app_recording" });
    expect(assets[seg.objectOutputs["0"].cutoutAssetId]).toMatchObject({ kind: "video", role: "other", mimeType: "video/webm" });
    expect(assets[seg.objectOutputs["1"].matteAssetId]).toMatchObject({ kind: "mask" });
    expect(tracksUrls[seg.id]).toMatch(/\/v1\/storage\/local\//);
    const tracks = await (await app.request(new URL(tracksUrls[seg.id]).pathname)).json();
    expect(tracks).toMatchObject({ fps: 10, frameCount: 20, width: 160, height: 120 });
    expect(tracks.tracks[0].frames[3].centroid.x).toBeCloseTo((10 + 9 + 20) / 160, 2);
    expect(got.json.transcript).toMatchObject({ status: "succeeded", purpose: "captions" });

    const again = await alice.post(`/v1/workspaces/${wsA}/assets/${videoId}/analyze-clip`, { prompts: ["red box"] });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ job: null, analysis: { id: analysis.id } });
    const list = await alice.get(`/v1/workspaces/${wsA}/assets/${videoId}/clip-analyses`);
    expect(list.json.items.map((a: Json) => a.id)).toContain(analysis.id);

    expect((await bob.get(`/v1/workspaces/${wsB}/clip-analyses/${analysis.id}`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsA}/clip-analyses/${analysis.id}`)).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsB}/assets/${videoId}/analyze-clip`, {})).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/assets/${videoId}/clip-analyses`)).status).toBe(404);
  });

  it("returns a voice command's text in the same request", async () => {
    const wav = join(dir, "cmd.wav");
    await makeTestAudio(wav, 2);
    const id = await upload(wsA, wav, "audio/wav", "other");
    const res = await alice.post(`/v1/workspaces/${wsA}/assets/${id}/transcribe`, { purpose: "voice_command" });
    expect(res.status).toBe(200);
    expect(res.json.transcript).toMatchObject({ status: "succeeded", text: "Make the opening more engaging.", mode: "PUSH_TO_TALK" });
    const t = await alice.get(`/v1/workspaces/${wsA}/transcripts/${res.json.transcript.id}`);
    expect(t.json).toMatchObject({ timing: "turn", cues: [{ startSec: 0, endSec: 2, text: "Make the opening more engaging." }] });
  });

  it("names the image provider (OpenAI for IN/unknown users) and refuses UI prompts", async () => {
    const res = await alice.post(`/v1/workspaces/${wsA}/images/generate`, { prompt: "Soft gradient background with floating shapes", count: 2 });
    expect(res.status).toBe(202);
    expect(res.json.provider).toMatchObject({ id: "openai", label: "OpenAI Images", model: "gpt-image-2.5-flare", museImage: { eligible: false } });
    expect(res.json.job.reservation.credits).toBe(12);
    await p.inline!.drain();
    const refused = await alice.post(`/v1/workspaces/${wsA}/images/generate`, { prompt: "A screenshot of my app's home screen" });
    expect(refused.status).toBe(400);
    expect(refused.json.error.userMessage).toMatch(/real screenshot/);
    expect(meta.calls.some((c) => c.url.includes("/images/"))).toBe(false);
  });

  it("searches stock with licence + attribution and runs TTS with disclosure", async () => {
    const s = await alice.get(`/v1/workspaces/${wsA}/stock/search?q=phone`);
    expect(s.status).toBe(200);
    expect(s.json.provider).toBe("openverse");
    // by-sa is excluded (share-alike obligations); CC BY carries attribution.
    expect(s.json.items).toHaveLength(1);
    expect(s.json.items[0].license).toMatchObject({ type: "creative_commons", name: "CC BY 2.0", attributionRequired: true });
    expect(s.json.providers.find((x: Json) => x.id === "pexels").state).toBe("not_configured");
    const video = await alice.get(`/v1/workspaces/${wsA}/stock/search?q=phone&kind=video`);
    expect(video.status).toBe(503);

    const tts = await alice.post(`/v1/workspaces/${wsA}/tts`, { text: "Meet Focus.", voice: "marin" });
    expect(tts.status).toBe(202);
    expect(tts.json).toMatchObject({ sourceLabel: "external_tts", provider: { id: "openai", voice: "marin" } });
    expect(tts.json.disclosure).toMatch(/AI-generated voice/);
    expect((await alice.post(`/v1/workspaces/${wsA}/tts`, { text: "hi", voice: "my-cloned-voice" })).status).toBe(400);
  });
});
