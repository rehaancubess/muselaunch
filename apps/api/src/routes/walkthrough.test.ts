import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handlers } from "@muselaunch/media";
import { installFakeMeta, loadFixture, makeTestWalkthrough, samPromptOf, schemaOf, textOf } from "@muselaunch/media/testing";
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

const MARKETING_PNG = fileURLToPath(new URL("../../../../fixtures/render/screenshot-marketing.png", import.meta.url));

describe("walkthrough + screen cut-out API", () => {
  const dir = mkdtempSync(join(tmpdir(), "walkthrough-api-"));
  const p = createTestPlatform({ META_API_KEY: "test-meta-key" }, handlers);
  const screenFx = loadFixture<{ rawOutput: string }>("sam-image-phone-screen.json").rawOutput;
  installFakeMeta(p, {
    transcribe: () => loadFixture<{ response: unknown }>("voice-transcribe-documented.json").response,
    samOutput: (body) => (/screen|display/.test(samPromptOf(body)) ? screenFx : ""),
    spark: (body) => {
      const text = textOf(body);
      if (schemaOf(body) === "ScreenshotKinds") return { images: [...text.matchAll(/^Image \d+: asset (\S+) .* Heuristic: (.*)$/gm)].map((m) => ({ assetId: m[1], kind: /device frame/.test(m[2]!) ? "marketing" : "raw_ui" })) };
      const shots = [...text.matchAll(/^Shot (\d+) ·/gm)].map((m) => Number(m[1]));
      return { shots: shots.map((n) => ({ shot: n, label: `Screen ${n + 1}`, action: "tap", featureIds: [], quality: 0.8, privacy: { flagged: false, regions: [] } })) };
    },
  });
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  let wsA = "";
  let wsB = "";
  let appId = "";
  let recordingId = "";

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
    appId = (await alice.post(`/v1/workspaces/${wsA}/apps`, { name: "Tidy Timer", autopilot: false })).json.app.id;
    const file = join(dir, "walkthrough.mp4");
    await makeTestWalkthrough(file, { audio: true });
    recordingId = await upload(wsA, file, "video/mp4", "app_recording", { appId, consent: { scope: "It's my voice" } });
  });

  it("cuts an uploaded app recording into clips automatically and lists them with the job and estimate", async () => {
    const res = await alice.get(`/v1/workspaces/${wsA}/apps/${appId}/recording-segments?assetId=${recordingId}`);
    expect(res.status).toBe(200);
    expect(res.json.job).toMatchObject({ type: "media.analyze_recording", status: "succeeded" });
    expect(res.json.estimate).toEqual({ credits: 6, minutes: 1, perMinute: 6 });
    expect(res.json.canAnalyze).toBe(true);
    expect(res.json.items.map((s: Json) => [s.startSec, s.endSec, s.label])).toEqual([
      [0, 2.833, "Screen 1"],
      [3, 8.333, "Screen 2"],
      [8.333, 13.833, "Screen 3"],
      [14, 16.5, "Screen 4"],
    ]);
    expect(res.json.items[0].narration).toBe("How is the weather?");
    const all = await alice.get(`/v1/workspaces/${wsA}/apps/${appId}/recording-segments`);
    expect(all.json.items).toHaveLength(4);
  });

  it("re-runs on request (202) and refuses what it can't break down", async () => {
    const res = await alice.post(`/v1/workspaces/${wsA}/apps/${appId}/media/${recordingId}/analyze-recording`, { transcribe: false });
    expect(res.status).toBe(202);
    expect(res.json.job).toMatchObject({ type: "media.analyze_recording", payload: { appId, assetId: recordingId, transcribe: false }, reservation: { credits: 6 } });
    await p.inline!.drain();
    expect((await alice.get(`/v1/workspaces/${wsA}/jobs/${res.json.job.id}`)).json.job.status).toBe("succeeded");

    const shot = await upload(wsA, MARKETING_PNG, "image/png", "screenshot", { appId });
    const notVideo = await alice.post(`/v1/workspaces/${wsA}/apps/${appId}/media/${shot}/analyze-recording`, {});
    expect(notVideo.status).toBe(400);
    const otherApp = (await alice.post(`/v1/workspaces/${wsA}/apps`, { name: "Other", autopilot: false })).json.app.id;
    expect((await alice.post(`/v1/workspaces/${wsA}/apps/${otherApp}/media/${recordingId}/analyze-recording`, {})).status).toBe(404);
    expect((await alice.get(`/v1/workspaces/${wsA}/apps/${otherApp}/recording-segments?assetId=${recordingId}`)).status).toBe(404);
  });

  it("isolates tenants", async () => {
    expect((await bob.get(`/v1/workspaces/${wsA}/apps/${appId}/recording-segments`)).status).toBe(404); // not a member: the workspace is not revealed
    expect((await bob.get(`/v1/workspaces/${wsB}/apps/${appId}/recording-segments?assetId=${recordingId}`)).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsB}/apps/${appId}/media/${recordingId}/analyze-recording`, {})).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsB}/apps/${appId}/media/extract-ui`, {})).status).toBe(404);
  });

  it("cuts the app screen out of a designed store screenshot (SAM 3.1) and is a no-op the second time", async () => {
    const res = await alice.post(`/v1/workspaces/${wsA}/apps/${appId}/media/extract-ui`, {});
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ pending: 1, credits: 2, job: { type: "media.extract_ui" } });
    await p.inline!.drain();
    const assets = (await alice.get(`/v1/workspaces/${wsA}/assets?appId=${appId}&limit=100`)).json.items as Json[];
    const original = assets.find((a) => a.role === "screenshot" && a.origin === "upload")!;
    expect(original.screenshotKind).toBe("marketing");
    const crop = assets.find((a) => a.sourceLabel === "sam_ui_crop")!;
    // The fixture's screen is 729×1656 px at (225,777); a 4 px inset keeps the bezel out.
    expect(crop).toMatchObject({ role: "screenshot", isProductTruth: true, derivedFromAssetId: original.id, screenshotKind: "raw_ui", width: 721, height: 1648 });
    const again = await alice.post(`/v1/workspaces/${wsA}/apps/${appId}/media/extract-ui`, {});
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ job: null, pending: 0, credits: 0 });
  });
});
