import type { App, CompositionDoc } from "@muselaunch/contracts";
import { validateDoc } from "@muselaunch/compositions";
import { createComposition, getVersion } from "@muselaunch/compositions/store";
import { handlers } from "@muselaunch/media";
import { createTestPlatform } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

function client(app: ReturnType<typeof buildApp>, uid: string) {
  const auth = { authorization: `Bearer dev:${uid}:${uid}@example.com` };
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as J });
  const send = (method: string) => (path: string, body?: unknown) =>
    Promise.resolve(app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? "{}" : JSON.stringify(body) })).then(json);
  return {
    get: (path: string) => Promise.resolve(app.request(path, { headers: auth })).then(json),
    post: send("POST"),
    patch: send("PATCH"),
    del: (path: string) => Promise.resolve(app.request(path, { method: "DELETE", headers: auth })).then(json),
  };
}

function videoDoc(): CompositionDoc {
  const v = validateDoc({
    schemaVersion: 1,
    title: "Focusly",
    kind: "video",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#0A84FF" },
    scenes: [
      { id: "sc_hook", name: "Hook", template: "hook-title", durationSec: 3, layers: [{ id: "ly_h", type: "text", text: "Stop losing mornings", box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 } }] },
      { id: "sc_demo", name: "Demo", template: "device-demo", durationSec: 3, transitionIn: { kind: "wipe", durationSec: 0.4 }, layers: [{ id: "ly_d", type: "text", text: "One tap", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 } }] },
      { id: "sc_cta", name: "CTA", template: "cta-endcard", purpose: "cta", durationSec: 2, layers: [{ id: "ly_c", type: "text", role: "cta", text: "Download", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 } }] },
    ],
  });
  if (!v.ok) throw new Error(v.errors.join("; "));
  return v.doc;
}

describe("sound routes (Studio sound panel + workspace defaults)", () => {
  // No provider keys: music and effects are our own synthesis and still work; AI voice reports why it can't.
  const p = createTestPlatform({}, handlers);
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  const eddie = client(app, "eddie");
  let wid = "";
  let widBob = "";
  const S = (path = "") => `/v1/workspaces/${wid}/compositions/cmp_snd/sound${path}`;

  beforeAll(async () => {
    wid = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    widBob = (await bob.post("/v1/workspaces", { name: "Bob" })).body.workspace.id;
    const inv = await alice.post(`/v1/workspaces/${wid}/invites`, { email: "eddie@example.com", role: "editor" });
    expect((await eddie.post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(200);
    const appDoc = (await p.db.ws(wid).collection("apps").create({ name: "Focusly", platforms: ["ios"], storeUrls: {}, status: "ready", dnaStatus: "confirmed", targetCountries: [], targetLanguages: ["en"] }, { actor: "alice" })) as App;
    await createComposition(p.db.ws(wid), { id: "cmp_snd", appId: appDoc.id, title: "Focusly", doc: videoDoc() }, "alice");
  });

  it("shows the sound state with honest provider status", async () => {
    const r = await alice.get(S());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 1, tracks: [], settings: { music: true, sfx: true, aiVoiceover: false }, tts: { configured: false, ttsConfigured: false, transcribeConfigured: false, provider: "OpenAI TTS (external)" } });
    expect(r.body.moods.map((m: J) => m.id)).toEqual(["bright-pluck", "calm-pad", "tech-pulse", "warm-keys", "cinematic-build", "lofi-chill"]);
  });

  it("turns effects on (placed for the current scenes) and composes music as a job; volume is instant", async () => {
    const fx = await eddie.post(S("/sfx"), { baseVersion: 1, enabled: true });
    expect(fx.status).toBe(200);
    expect(fx.body.version.version).toBe(2);
    expect(fx.body.version.doc.audio.map((a: J) => a.sfx)).toEqual(["whoosh", "shimmer"]);

    const m = await eddie.post(S("/music"), { baseVersion: 2, mood: "calm-pad" });
    expect(m.status).toBe(202);
    expect(m.body).toMatchObject({ mood: "calm-pad", sourceLabel: "original_music", job: { type: "media.music", status: "queued" } });
    await p.inline!.drain();
    const job = await p.jobs.get(wid, m.body.job.id);
    expect(job).toMatchObject({ status: "succeeded", creditsCharged: 0 });
    const v3 = await getVersion(p.db.ws(wid), "cmp_snd", 3);
    const music = v3.doc.audio.find((a) => a.kind === "music")!;
    expect(music).toMatchObject({ mood: "calm-pad", sourceLabel: "original_music", startSec: 0, endSec: 8 });
    const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(music.assetId);
    expect(asset).toMatchObject({ role: "music", sourceLabel: "original_music", license: { type: "owned", provider: "MuseLaunch" }, durationSec: 8 });

    const vol = await eddie.post(S("/music"), { baseVersion: 3, volume: 0.5 });
    expect(vol.status).toBe(200);
    expect(vol.body.version.doc.audio.find((a: J) => a.kind === "music").volume).toBe(0.5);

    const state = await alice.get(S());
    expect(state.body.assets[music.assetId]).toMatchObject({ sourceLabel: "original_music", license: { attribution: "Original music generated by MuseLaunch" } });
  });

  it("refuses stale versions, an unconfigured AI voice, and other workspaces", async () => {
    expect((await alice.post(S("/sfx"), { baseVersion: 1, enabled: false })).status).toBe(409);
    const tts = await alice.post(S("/voiceover"), { source: "tts", baseVersion: 4, script: "Meet Focusly." });
    expect(tts.status).toBe(503);
    expect(tts.body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect((await alice.post(S("/voiceover"), { source: "tts", baseVersion: 4, voice: "voice_clone_1" })).status).toBe(503);
    expect((await bob.get(S())).status).toBe(404); // not a member: the workspace is invisible
    expect((await bob.get(`/v1/workspaces/${widBob}/compositions/cmp_snd/sound`)).status).toBe(404);
  });

  it("removes music and voice cleanly", async () => {
    const r = await alice.post(S("/music"), { baseVersion: 4, enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.version.doc.audio.some((a: J) => a.kind === "music")).toBe(false);
    const d = await alice.del(`${S("/voiceover")}?baseVersion=5`);
    expect(d.status).toBe(200);
    expect(d.body.version.version).toBe(6);
  });

  it("workspace sound defaults: managers only; built-in voices only", async () => {
    expect((await eddie.patch(`/v1/workspaces/${wid}/sound/settings`, { sfx: false })).status).toBe(403);
    expect((await alice.patch(`/v1/workspaces/${wid}/sound/settings`, { voice: "my_clone" })).status).toBe(400);
    const ok = await alice.patch(`/v1/workspaces/${wid}/sound/settings`, { aiVoiceover: true, voice: "nova" });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toEqual({ music: true, sfx: true, aiVoiceover: true, voice: "nova" });
    const ws = await alice.get(`/v1/workspaces/${wid}`);
    expect(ws.body.workspace.settings.sound).toEqual({ music: true, sfx: true, aiVoiceover: true, voice: "nova" });
    expect(ws.body.workspace.settings.autopilot).toMatchObject({ enabled: true });
  });
});
