import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, createTestPlatform, type Platform } from "@muselaunch/platform";
import { chooseImageProvider, guardImagePrompt, MuseImageProvider, NO_UI_SUFFIX, parseSamOutput } from "@muselaunch/providers";
import { describe, expect, it } from "vitest";
import { cuesToSrt, transcriptToCaptionCues } from "./captions";
import { ffmpeg } from "./ffmpeg";
import { handlers } from "./index";
import { importStock, requestTranscript, waitForTranscript } from "./service";
import { installFakeMeta, loadFixture, makeTestAudio, makeTestImage, storeUpload, type RecordedCall } from "./testing";
import { installMediaDeps } from "./util";

const dir = mkdtempSync(join(tmpdir(), "media-test-"));
const wid = "ws_media_b";

async function readyAsset(p: Platform, file: string, init: Parameters<typeof storeUpload>[3], ws = wid) {
  const a = await storeUpload(p, ws, file, init);
  await p.jobs.create(ws, "media.probe", { assetId: a.id }, { actor: "tester", idempotencyKey: `probe:${a.id}` });
  await p.inline!.drain();
  return p.db.ws(ws).collection("mediaAssets").getOrThrow(a.id);
}

describe("SAM output parsing (@meta-sam/parser)", () => {
  it("parses the documented README example (lossless masks, two objects)", () => {
    const fx = loadFixture<{ rawOutput: string }>("sam-readme-documented.json");
    const r = parseSamOutput(fx.rawOutput, "video");
    expect(r.objectIds).toEqual(["0", "1"]);
    expect(r.detections[0]!.bounds).toEqual({ left: 211, top: 228, right: 271, bottom: 255 });
    expect(r.detections[0]!.mask).toMatchObject({ encoding: "lossless", width: 60, height: 27 });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
  it("treats zero matches as a valid empty result", () => {
    expect(parseSamOutput("", "image").detections).toEqual([]);
  });
});

describe("media.transcribe (Muse Voice Transcribe)", () => {
  const documented = loadFixture<{ response: unknown }>("voice-transcribe-documented.json").response;

  it("transcribes with diarization, stores turn-level timing, meters audio seconds, and builds caption cues", async () => {
    const p = createTestPlatform({ META_API_KEY: "test-meta-key" }, handlers);
    let wavHead = Buffer.alloc(0);
    const { calls } = installFakeMeta(p, {
      transcribe: async (form) => {
        wavHead = Buffer.from(await (form.get("audio") as Blob).slice(0, 64).arrayBuffer());
        return documented;
      },
    });
    await p.credits.ensureAccount(wid, { grant: 100, reason: "test" });
    const app = await p.db.ws(wid).collection("apps").create({ name: "Focus" } as never, { actor: "tester" });
    const wav = join(dir, "brief.m4a");
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=300:duration=9", "-c:a", "aac", wav]);
    const asset = await readyAsset(p, wav, { kind: "audio", role: "founder_clip", mimeType: "audio/mp4", consent: true, appId: app?.id });
    expect(asset.durationSec).toBeCloseTo(9, 0);

    const { transcript, job } = await requestTranscript(p, wid, { asset, purpose: "founder_brief", keywords: ["Focus"], actor: "tester" });
    expect(job!.reservation!.credits).toBe(1);
    await p.inline!.drain();
    const t = await p.db.ws(wid).collection("transcripts").getOrThrow(transcript.id);
    expect(t).toMatchObject({ status: "succeeded", mode: "DIARIZATION", text: "How is the weather? It is raining.", durationSec: 8.24 });
    expect(t.turns).toEqual([
      { startSec: 1.52, endSec: 4.64, speaker: "A", text: "How is the weather?" },
      { startSec: 5.9, endSec: 8.24, speaker: "B", text: "It is raining." },
    ]);
    expect(t.language).toBeUndefined(); // the API does not report a language; we never guess one

    const call = calls.find((c) => c.url.includes("/v1/asr/transcribe"))!;
    expect(call.url).toContain(`sessionId=${t.id}-0`);
    const req = JSON.parse(await (call.form!.get("request") as Blob).text());
    expect(req).toEqual({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "DIARIZATION", keywords: ["Focus"] });
    const head = wavHead;
    expect(head.subarray(0, 4).toString()).toBe("RIFF");
    expect(head.readUInt16LE(22)).toBe(1); // mono
    expect(head.readUInt32LE(24)).toBe(24000);
    expect(head.readUInt16LE(34)).toBe(16);

    const usage = await p.db.ws(wid).collection("modelUsage").getMany(t.usageEventIds);
    expect(usage[0]).toMatchObject({ provider: "meta", operation: "asr", audioSeconds: 8, status: "ok" });

    const cues = transcriptToCaptionCues(t);
    expect(cues).toEqual([
      { id: `${t.id}-c0-0`, startSec: 1.52, endSec: 4.64, text: "A: How is the weather?", speaker: "A" },
      { id: `${t.id}-c1-0`, startSec: 5.9, endSec: 8.24, text: "B: It is raining.", speaker: "B" },
    ]);
    expect(cuesToSrt(cues)).toContain("00:00:01,520 --> 00:00:04,640");

    if (app) {
      const ev = await p.db.ws(wid).collection("appEvidence").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" } });
      expect(ev.items[0]).toMatchObject({ kind: "other", reviewState: "needs_review", source: { kind: "recording", assetId: asset.id } });
      expect(ev.items[0]!.fact).toContain("How is the weather?");
    }

    // Same audio again (any asset in this workspace): copied, no second provider call.
    const before = calls.length;
    const again = await requestTranscript(p, wid, { asset, purpose: "captions", actor: "tester" });
    expect(again).toMatchObject({ job: null, reused: true, transcript: { reusedFromTranscriptId: t.id, text: t.text } });
    expect(calls.length).toBe(before);
  });

  it("voice_command uses PUSH_TO_TALK, needs no consent, and resolves quickly", async () => {
    const p = createTestPlatform({ META_API_KEY: "test-meta-key" }, handlers);
    const { calls } = installFakeMeta(p, { transcribe: () => ({ sessionId: "s", transcript: "Make the opening more engaging.", audioDurationMs: 2100, turns: [] }) });
    await p.credits.ensureAccount(wid, { grant: 100, reason: "test" });
    const wav = join(dir, "cmd.wav");
    await makeTestAudio(wav, 2);
    const asset = await readyAsset(p, wav, { kind: "audio", role: "other", mimeType: "audio/wav" });
    const { transcript } = await requestTranscript(p, wid, { asset, purpose: "voice_command", actor: "tester" });
    const done = await waitForTranscript(p, wid, transcript.id, 10_000);
    expect(done).toMatchObject({ status: "succeeded", mode: "PUSH_TO_TALK", text: "Make the opening more engaging.", turns: [] });
    const req = JSON.parse(await (calls.find((c) => c.url.includes("/asr/transcribe"))!.form!.get("request") as Blob).text());
    expect(req.mode).toBe("PUSH_TO_TALK");
    // A caption request of a non-command recording needs consent.
    await expect(requestTranscript(p, wid, { asset, purpose: "captions", actor: "tester" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("splits long turns into cues that never leave the turn's real boundaries", () => {
    const long = "This is a long founder turn. It keeps going with several sentences, each one adding detail about the product. Finally it ends here.";
    const cues = transcriptToCaptionCues({ id: "trn_x", text: long, durationSec: 20, turns: [{ startSec: 2, endSec: 12, text: long }] }, { maxChars: 50 });
    expect(cues.length).toBeGreaterThan(2);
    expect(cues[0]!.startSec).toBe(2);
    expect(cues.at(-1)!.endSec).toBe(12);
    for (const c of cues) expect(c.text.length).toBeLessThanOrEqual(50);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.startSec).toBeGreaterThanOrEqual(cues[i - 1]!.endSec - 1e-9);
  });
});

describe("Muse Image eligibility gate + OpenAI images", () => {
  it("never selects Muse Image for India or an unknown country (default deployment)", () => {
    const p = createTestPlatform({ META_API_KEY: "k", OPENAI_API_KEY: "sk-test" });
    expect(chooseImageProvider(p, "IN")).toMatchObject({ id: "openai", museImage: { eligible: false } });
    expect(chooseImageProvider(p, undefined)).toMatchObject({ id: "openai", museImage: { eligible: false } });
    expect(chooseImageProvider(p, "US")).toMatchObject({ id: "openai", museImage: { eligible: false, reason: "Muse Image is disabled for this deployment" } });
    expect(() => MuseImageProvider.create(p, "US")).toThrow(AppError);
  });

  it("even when enabled from an eligible operator, refuses IN and unknown end users", () => {
    const p = createTestPlatform({ META_API_KEY: "k", OPENAI_API_KEY: "sk-test", MUSE_IMAGE_ENABLED: "1", IMAGE_PROVIDER: "muse", OPERATOR_COUNTRY: "US" });
    expect(chooseImageProvider(p, "IN")).toMatchObject({ id: "openai", museImage: { eligible: false, reason: "Muse Image is not available to users in IN" } });
    expect(chooseImageProvider(p, undefined)).toMatchObject({ id: "openai", museImage: { eligible: false, reason: "End-user country unknown" } });
    expect(chooseImageProvider(p, "US")).toMatchObject({ id: "muse", model: "muse-image-1.0" });
    for (const c of ["IN", undefined]) {
      try {
        MuseImageProvider.create(p, c);
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as AppError).code).toBe("PROVIDER_RESTRICTED");
      }
    }
  });

  it("refuses prompts asking for the app's UI and adds the no-UI constraint otherwise", () => {
    expect(guardImagePrompt("A screenshot of my app's dashboard on an iPhone").ok).toBe(false);
    expect(guardImagePrompt("show our app UI on a phone").ok).toBe(false);
    const ok = guardImagePrompt("Soft morning light on a minimalist desk with a plant");
    expect(ok.ok && ok.prompt.endsWith(NO_UI_SUFFIX)).toBe(true);
  });

  it("generates with OpenAI (exact request shape), labels the asset, and never calls Meta for an IN user", async () => {
    const p = createTestPlatform({ META_API_KEY: "k", OPENAI_API_KEY: "sk-test", OPENAI_IMAGE_MODEL: "gpt-image-2.5-flare", MUSE_IMAGE_ENABLED: "1", IMAGE_PROVIDER: "muse", OPERATOR_COUNTRY: "US" }, handlers);
    const meta = installFakeMeta(p, { images: () => ({ data: [] }) });
    const fx = loadFixture<{ response: { data: { b64_json: string }[] } }>("openai-images-generate.json").response;
    const calls: RecordedCall[] = [];
    installMediaDeps(p, {
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ method: init.method ?? "GET", url, json: typeof init.body === "string" ? JSON.parse(init.body) : undefined, form: init.body instanceof FormData ? init.body : undefined });
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
        return new Response(JSON.stringify(fx), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await p.credits.ensureAccount(wid, { grant: 100, reason: "test" });
    const job = await p.jobs.create(wid, "media.image_generate", { prompt: "Calm gradient background for a productivity reel", count: 1, size: "1024x1536", endUserCountry: "IN" }, { actor: "tester", credits: { operation: "media.image_generate", params: { count: 1 } } });
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job.id);
    expect(done!.status).toBe("succeeded");
    expect(meta.calls.filter((c) => c.url.includes("/images/"))).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(calls[0]!.json).toMatchObject({ model: "gpt-image-2.5-flare", n: 1, size: "1024x1536", quality: "medium", output_format: "png" });
    expect(String(calls[0]!.json!.prompt)).toContain(NO_UI_SUFFIX);
    expect(calls[0]!.json!.safety_identifier).toMatch(/^[0-9a-f]{32}$/);

    const assetId = (done!.output!.data as { assetIds: string[] }).assetIds[0]!;
    const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(assetId);
    expect(asset).toMatchObject({
      role: "generated_image",
      origin: "generated",
      isProductTruth: false,
      sourceLabel: "ai_generated_image",
      width: 64,
      height: 96,
      license: { type: "generated_terms", provider: "OpenAI Images" },
      generation: { provider: "openai", model: "gpt-image-2.5-flare", prompt: "Calm gradient background for a productivity reel", revision: 1 },
    });
    const usage = await p.db.ws(wid).collection("modelUsage").getOrThrow(asset.generation!.usageEventId!);
    expect(usage).toMatchObject({ provider: "openai", operation: "image_generate", images: 1, dataMode: "third_party", outputTokens: 1056 });
    expect(usage.costUsdEstimate).toBeCloseTo((120 * 5 + 1056 * 30) / 1e6);

    // Revision: multipart edit with the parent image; revision history kept.
    const rev = await p.jobs.create(wid, "media.image_generate", { prompt: "Same, warmer tones", count: 1, size: "1024x1536", parentAssetId: asset.id, endUserCountry: "IN" }, { actor: "tester" });
    await p.inline!.drain();
    const revAsset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(((await p.jobs.get(wid, rev.id))!.output!.data as { assetIds: string[] }).assetIds[0]!);
    expect(revAsset.generation).toMatchObject({ revision: 2, parentAssetId: asset.id });
    expect(calls[1]!.url).toBe("https://api.openai.com/v1/images/edits");
    expect(calls[1]!.form!.get("model")).toBe("gpt-image-2.5-flare");
    expect(calls[1]!.form!.getAll("image[]")).toHaveLength(1);
  });

  it("refuses to AI-edit a real screenshot", async () => {
    const p = createTestPlatform({ OPENAI_API_KEY: "sk-test" }, handlers);
    installMediaDeps(p, { fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
    const img = join(dir, "shot.png");
    await makeTestImage(img);
    const shot = await readyAsset(p, img, { kind: "image", role: "screenshot", mimeType: "image/png" });
    const job = await p.jobs.create(wid, "media.image_generate", { prompt: "make it pop", count: 1, size: "1024x1024", parentAssetId: shot.id }, { actor: "tester" });
    await p.inline!.drain();
    expect(await p.jobs.get(wid, job.id)).toMatchObject({ status: "failed", error: { code: "BAD_REQUEST" } });
  });
});

describe("TTS (optional, external, labelled)", () => {
  it("creates an external_tts asset with a built-in voice and refuses custom voices", async () => {
    const p = createTestPlatform({ OPENAI_API_KEY: "sk-test" }, handlers);
    const mp3 = join(dir, "tts.mp3");
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=200:duration=1.5", "-c:a", "libmp3lame", mp3]);
    let body: Record<string, unknown> = {};
    installMediaDeps(p, {
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.openai.com/v1/audio/speech");
        body = JSON.parse(String(init.body));
        return new Response(readFileSync(mp3), { status: 200, headers: { "content-type": "audio/mpeg" } });
      }) as typeof fetch,
    });
    await p.credits.ensureAccount(wid, { grant: 100, reason: "test" });
    const job = await p.jobs.create(wid, "media.tts", { text: "Meet Focus. Plan your day in seconds.", voice: "marin" }, { actor: "tester" });
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job.id);
    expect(done!.status).toBe("succeeded");
    expect(body).toEqual({ model: "gpt-4o-mini-tts", voice: "marin", input: "Meet Focus. Plan your day in seconds.", response_format: "mp3" });
    const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow((done!.output!.data as { assetId: string }).assetId);
    expect(asset).toMatchObject({ kind: "audio", role: "tts", origin: "generated", sourceLabel: "external_tts", isProductTruth: false, generation: { provider: "openai", model: "gpt-4o-mini-tts" } });
    expect(asset.labels).toEqual(expect.arrayContaining(["external_tts", "ai_voice", "voice:marin"]));
    expect(asset.durationSec).toBeGreaterThan(1);

    const bad = await p.jobs.create(wid, "media.tts", { text: "hi", voice: "voice_cloned_123" }, { actor: "tester" });
    await p.inline!.drain();
    expect(await p.jobs.get(wid, bad.id)).toMatchObject({ status: "failed", error: { code: "BAD_REQUEST" } });
  });
});

describe("stock import", () => {
  it("re-fetches licence server-side, downloads via the injected safe downloader, and stores attribution", async () => {
    const p = createTestPlatform({}, handlers);
    const fx = loadFixture<{ response: { results: unknown[] } }>("openverse-search.json").response;
    const jpg = join(dir, "stock.jpg");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=64x48", "-frames:v", "1", jpg]);
    const fetched: string[] = [];
    const downloaded: string[] = [];
    installMediaDeps(p, {
      fetch: (async (url: string) => {
        fetched.push(url);
        const item = fx.results[0] as { id: string };
        return new Response(JSON.stringify(url.includes(`/images/${item.id}/`) ? item : fx), { status: 200 });
      }) as typeof fetch,
      download: async (url) => {
        downloaded.push(url);
        return { body: readFileSync(jpg), contentType: "image/jpeg", url };
      },
    });
    const { asset, job, created } = await importStock(p, wid, { provider: "openverse", id: "4bc43a04-ef46-4544-a0c1-63c63f56e276", kind: "image" }, "tester");
    expect(created).toBe(true);
    expect(fetched).toEqual(["https://api.openverse.org/v1/images/4bc43a04-ef46-4544-a0c1-63c63f56e276/"]);
    expect(downloaded).toEqual(["https://live.staticflickr.com/65535/123_abc_b.jpg"]);
    expect(asset).toMatchObject({
      role: "stock_image",
      origin: "stock",
      sourceLabel: "stock",
      license: { type: "creative_commons", provider: "Openverse (Creative Commons)", sourceUrl: "https://www.flickr.com/photos/example/123", termsUrl: "https://creativecommons.org/licenses/by/2.0/" },
    });
    expect(asset.license!.attribution).toContain("Example Creator");
    expect(asset.license!.restrictions).toContain("attribution required");
    await p.inline!.drain();
    expect((await p.jobs.get(wid, job!.id))!.status).toBe("succeeded");
    expect((await p.db.ws(wid).collection("mediaAssets").getOrThrow(asset.id)).status).toBe("ready");
    // Same item again → same asset, no second download.
    const again = await importStock(p, wid, { provider: "openverse", id: "4bc43a04-ef46-4544-a0c1-63c63f56e276", kind: "image" }, "tester");
    expect(again).toMatchObject({ created: false, asset: { id: asset.id } });
    expect(downloaded).toHaveLength(1);
  });
});
