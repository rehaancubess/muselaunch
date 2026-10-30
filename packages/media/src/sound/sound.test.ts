import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompositionDoc, Job, Storyboard } from "@muselaunch/contracts";
import { compileToHtml, validateDoc } from "@muselaunch/compositions";
import { ensureNodeCompileRuntime } from "@muselaunch/compositions/node";
import { createComposition, getVersion } from "@muselaunch/compositions/store";
import { createTestPlatform, type JobContext, type Platform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { ffmpeg } from "../ffmpeg";
import { handlers } from "../index";
import { installFakeMeta } from "../testing";
import { installMediaDeps } from "../util";
import { narrationScript, prepareSoundtrack, soundSettings } from "./index";
import { normalizeWords, scriptTurns, wordErrorRate } from "./voiceover";

const dir = mkdtempSync(join(tmpdir(), "sound-test-"));
const SCRIPT = "Meet Focusly. Plan your whole day in 3 taps, and get 20% more done.";

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
      { id: "sc_hook", name: "Hook", template: "hook-title", purpose: "hook", durationSec: 3, layers: [{ id: "ly_h", type: "text", text: "Stop losing mornings", box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 } }] },
      { id: "sc_demo", name: "Demo", template: "device-demo", purpose: "demo", durationSec: 4, transitionIn: { kind: "slide-up", durationSec: 0.5 }, layers: [{ id: "ly_d", type: "text", text: "One tap", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 } }] },
      { id: "sc_cta", name: "CTA", template: "cta-endcard", purpose: "cta", durationSec: 3, transitionIn: { kind: "fade", durationSec: 0.4 }, layers: [{ id: "ly_c", type: "text", role: "cta", text: "Download", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 } }] },
    ],
  });
  if (!v.ok) throw new Error(v.errors.join("; "));
  return v.doc;
}

const storyboard = (voice: "tts" | "none", mood = "upbeat, playful") =>
  ({ id: "sbd_1", voiceover: { source: voice, script: voice === "tts" ? SCRIPT : undefined }, music: { mood }, scenes: [{ order: 0, narration: "Meet Focusly." }] }) as unknown as Storyboard;

/** A JobContext for calling the build-pipeline sound pass directly (as composition.build does). */
function ctxFor(p: Platform, wid: string, jobId: string): JobContext {
  return { job: { id: jobId } as Job, type: "composition.build", payload: {}, workspaceId: wid, appId: "app_1", platform: p, db: p.db, ws: p.db.ws(wid), log: p.log, signal: new AbortController().signal, actor: `job:${jobId}`, requestedBy: "u1", progress: async () => {}, log_event: async () => {}, throwIfCancelled: () => {}, enqueue: async () => ({}) as Job } as unknown as JobContext;
}


/** A workspace document (top-level), as onboarding creates it. */
async function makeWorkspace(p: Platform, wid: string, sound?: Record<string, unknown>) {
  const now = new Date().toISOString();
  await p.db.top("workspaces").set(wid, {
    id: wid,
    workspaceId: wid,
    name: "Sound test",
    slug: `sound-${wid}`,
    ownerId: "u1",
    planId: "free",
    spendCeilingUsd: 25,
    settings: { defaultTimezone: "UTC", defaultLocale: "en", metaDataMode: "standard", autopilot: { enabled: true, autoApproveRenders: true }, ...(sound ? { sound } : {}) },
    createdAt: now,
    updatedAt: now,
    createdBy: "u1",
  } as never);
}

let mp3: Buffer | null = null;
async function ttsMp3(): Promise<Buffer> {
  if (!mp3) {
    const f = join(dir, "tts.mp3");
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=210:duration=4.2", "-af", "volume=0.3", "-c:a", "libmp3lame", f]);
    mp3 = readFileSync(f);
  }
  return mp3;
}

/** Fake OpenAI TTS (documented request shape) + fake Muse Voice Transcribe (documented response shape). */
async function wire(p: Platform, heard: string[]) {
  const audio = await ttsMp3();
  const tts: Record<string, unknown>[] = [];
  installMediaDeps(p, {
    fetch: (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/audio/speech");
      tts.push(JSON.parse(String(init.body)));
      return new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch,
  });
  let n = 0;
  const meta = installFakeMeta(p, {
    transcribe: () => {
      const text = heard[Math.min(n++, heard.length - 1)]!;
      const [a, b] = text.split(/(?<=\.)\s+/);
      return {
        sessionId: `s${n}`,
        transcript: text,
        audioDurationMs: 4200,
        turns: [
          { turnId: 1, startMs: 120, endMs: 1500, transcript: a, speaker: "A" },
          ...(b ? [{ turnId: 2, startMs: 1700, endMs: 4000, transcript: b, speaker: "A" }] : []),
          { turnId: 3, startMs: 4100, endMs: 4100, transcript: "Yeah.", speaker: "A" }, // zero-length: dropped
        ],
      };
    },
  });
  return { tts, meta };
}

describe("word error rate (script check)", () => {
  it("normalises numbers, symbols and punctuation before comparing", () => {
    expect(normalizeWords("Plan your day in 3 taps & get 20% more done!")).toEqual(["plan", "your", "day", "in", "three", "taps", "and", "get", "twenty", "percent", "more", "done"]);
    expect(wordErrorRate(SCRIPT, "Meet Focusly. Plan your whole day in three taps and get twenty percent more done")).toBe(0);
    expect(wordErrorRate(SCRIPT, "Meet focus Lee. Plan your whole day in three taps and get twenty percent more done")).toBeCloseTo(2 / 15, 5);
    expect(wordErrorRate("", "")).toBe(0);
  });

  it("puts the script's own words on the transcript's turn timing", () => {
    const turns = scriptTurns(SCRIPT, [
      { startSec: 0.1, endSec: 1.5, text: "meet focus lee" },
      { startSec: 1.7, endSec: 4, text: "plan your whole day in three taps and get twenty percent more done" },
    ]);
    expect(turns.map((t) => t.text)).toEqual(["Meet Focusly. Plan", "your whole day in 3 taps, and get 20% more done."]);
    expect(turns[1]).toMatchObject({ startSec: 1.7, endSec: 4 });
  });
});

describe("media.voiceover (OpenAI TTS → Muse Voice Transcribe check)", () => {
  it("generates a labelled AI voice, verifies it, aligns captions + ducking, and charges only what ran", async () => {
    const p = createTestPlatform({ OPENAI_API_KEY: "sk-test", META_API_KEY: "test-meta-key" }, handlers);
    const wid = "ws_vo";
    const { tts, meta } = await wire(p, ["Meet Focusly. Plan your whole day in three taps, and get twenty percent more done."]);
    await p.credits.ensureAccount(wid, { grant: 50, reason: "test" });
    await p.db.ws(wid).collection("apps").create({ id: "app_1", name: "Focusly" } as never, { actor: "u1" });
    const { composition } = await createComposition(p.db.ws(wid), { id: "cmp_1", appId: "app_1", title: "Focusly", doc: videoDoc() }, "u1");
    const job = await p.jobs.create(wid, "media.voiceover", { appId: "app_1", compositionId: "cmp_1", baseVersion: 1, source: "tts", text: SCRIPT, voice: "marin" }, { actor: "u1", credits: { operation: "media.voiceover", params: { text: SCRIPT, source: "tts" } } });
    expect(job.reservation?.credits).toBe(4); // (1 TTS + 1 check) held twice for one possible regeneration
    await p.inline!.drain();
    const done = (await p.jobs.get(wid, job.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.creditsCharged).toBe(2);
    expect((await p.credits.balance(wid)).available).toBe(48);
    expect(tts).toHaveLength(1);
    expect(tts[0]).toMatchObject({ model: "gpt-4o-mini-tts", voice: "marin", input: SCRIPT, response_format: "mp3" });
    expect(meta.calls.filter((c) => c.url.includes("/asr/transcribe"))).toHaveLength(1);

    const comp = await p.db.ws(wid).collection("compositions").getOrThrow(composition.id);
    expect(comp.currentVersion).toBe(2);
    const v2 = await getVersion(p.db.ws(wid), "cmp_1", 2);
    const vo = v2.doc.audio.find((a) => a.kind === "voiceover")!;
    expect(vo).toMatchObject({ sourceLabel: "external_tts", startSec: 0.25, check: { passed: true, wer: 0, attempts: 1 } });
    expect(vo.speech).toEqual([
      { startSec: 0.12, endSec: 1.5 },
      { startSec: 1.7, endSec: 4 },
    ]);
    // captions show the script's words (correct brand spelling) at the transcript's turn timing
    expect(v2.doc.captions).toMatchObject({ enabled: true, source: "transcript" });
    expect(v2.doc.captions.cues.map((c) => c.text).join(" ")).toBe(SCRIPT);
    expect(v2.doc.captions.cues[0]!.startSec).toBeCloseTo(0.37, 3);

    const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(vo.assetId);
    expect(asset).toMatchObject({ role: "tts", origin: "generated", sourceLabel: "external_tts", mimeType: "audio/mp4", isProductTruth: false, license: { type: "generated_terms", provider: "OpenAI TTS" } });
    expect(asset.labels).toEqual(expect.arrayContaining(["external_tts", "ai_voice", "voice:marin"]));
    const usage = (await p.db.ws(wid).collection("modelUsage").list({ where: [["jobId", "==", job.id]], limit: 20 })).items;
    expect(usage.map((u) => `${u.provider}:${u.operation}`).sort()).toEqual(["meta:asr", "openai:tts"]);

    // A second identical request reuses the stored take and its check: no new provider calls.
    const again = await p.jobs.create(wid, "media.voiceover", { appId: "app_1", compositionId: "cmp_1", baseVersion: 2, source: "tts", text: SCRIPT, voice: "marin" }, { actor: "u1", credits: { operation: "media.voiceover", params: { text: SCRIPT, source: "tts" } } });
    await p.inline!.drain();
    expect((await p.jobs.get(wid, again.id))!).toMatchObject({ status: "succeeded", creditsCharged: 0 });
    expect(tts).toHaveLength(1);
  });

  it("regenerates once when the voice doesn't match the script, then keeps the better take with a warning", async () => {
    const p = createTestPlatform({ OPENAI_API_KEY: "sk-test", META_API_KEY: "test-meta-key" }, handlers);
    const wid = "ws_vo2";
    const { tts } = await wire(p, ["Meet Focus. Plan your old day.", "Meet Focusly. Plan your hole day in tree taps."]);
    await p.credits.ensureAccount(wid, { grant: 50, reason: "test" });
    await p.db.ws(wid).collection("apps").create({ id: "app_1", name: "Focusly" } as never, { actor: "u1" });
    await createComposition(p.db.ws(wid), { id: "cmp_1", appId: "app_1", title: "Focusly", doc: videoDoc() }, "u1");
    const job = await p.jobs.create(wid, "media.voiceover", { appId: "app_1", compositionId: "cmp_1", baseVersion: 1, source: "tts", text: SCRIPT }, { actor: "u1", credits: { operation: "media.voiceover", params: { text: SCRIPT, source: "tts" } } });
    await p.inline!.drain();
    const done = (await p.jobs.get(wid, job.id))!;
    expect(done.status).toBe("succeeded");
    expect(tts).toHaveLength(2);
    expect(String(tts[1]!.instructions)).toMatch(/slower/);
    expect(done.creditsCharged).toBe(4);
    const data = done.output!.data as { check: { passed: boolean; attempts: number; wer: number }; warnings: string[] };
    expect(data.check).toMatchObject({ passed: false, attempts: 2 });
    expect(data.warnings[0]).toMatch(/didn't match the script/);
    const v2 = await getVersion(p.db.ws(wid), "cmp_1", 2);
    // failed check → captions show what is actually heard
    expect(v2.doc.captions.cues.map((c) => c.text).join(" ")).toBe("Meet Focusly. Plan your hole day in tree taps.");
  });

  it("fails visibly without a TTS key and returns the held credits; never crosses workspaces", async () => {
    const p = createTestPlatform({ META_API_KEY: "test-meta-key" }, handlers);
    await p.credits.ensureAccount("ws_a", { grant: 20, reason: "test" });
    await p.credits.ensureAccount("ws_b", { grant: 20, reason: "test" });
    await p.db.ws("ws_a").collection("apps").create({ id: "app_1", name: "Focusly" } as never, { actor: "u1" });
    await createComposition(p.db.ws("ws_a"), { id: "cmp_1", appId: "app_1", title: "Focusly", doc: videoDoc() }, "u1");
    const job = await p.jobs.create("ws_a", "media.voiceover", { appId: "app_1", compositionId: "cmp_1", baseVersion: 1, source: "tts", text: SCRIPT }, { actor: "u1", credits: { operation: "media.voiceover", params: { text: SCRIPT, source: "tts" } } });
    await p.inline!.drain();
    expect(await p.jobs.get("ws_a", job.id)).toMatchObject({ status: "failed", error: { code: "PROVIDER_NOT_CONFIGURED" } });
    expect((await p.credits.balance("ws_a")).available).toBe(20);
    const other = await p.jobs.create("ws_b", "media.voiceover", { appId: "app_1", compositionId: "cmp_1", baseVersion: 1, source: "tts", text: SCRIPT }, { actor: "u2" });
    await p.inline!.drain();
    expect(await p.jobs.get("ws_b", other.id)).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
  });
});

describe("build-pipeline sound pass (prepareSoundtrack)", () => {
  it("gives every new video original music + effects by default; narration waits for the workspace's AI-voice switch", async () => {
    const p = createTestPlatform({ OPENAI_API_KEY: "sk-test", META_API_KEY: "test-meta-key" }, handlers);
    const wid = "ws_build";
    await makeWorkspace(p, wid);
    const { tts } = await wire(p, ["Meet Focusly. Plan your whole day in three taps, and get twenty percent more done."]);
    const r = await prepareSoundtrack(ctxFor(p, wid, "job_b1"), { doc: videoDoc(), compositionId: "cmp_b", appId: "app_1", storyboard: storyboard("tts"), app: { name: "Focusly" } });
    expect(tts).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/AI voice is off/);
    expect(r.music).toMatchObject({ mood: "bright-pluck", reused: false });
    expect(r.doc.audio.find((a) => a.kind === "music")).toMatchObject({ sourceLabel: "original_music", auto: true, mood: "bright-pluck" });
    expect(r.doc.audio.filter((a) => a.kind === "sfx").map((a) => a.sfx)).toEqual(["whoosh", "shimmer"]);
    expect(validateDoc(r.doc).ok).toBe(true);

    // compile + the HyperFrames audio clips reference the stored assets
    ensureNodeCompileRuntime();
    const html = compileToHtml(r.doc, { assetUrl: (id) => `assets/${id}.m4a`, mode: "render", gsapSource: "inline" }).html;
    expect(html.match(/<audio /g)).toHaveLength(3);

    // AI voice on (workspace setting) → the storyboard's narration is spoken, credits held + settled
    await makeWorkspace(p, wid, { music: true, sfx: true, aiVoiceover: true });
    expect(soundSettings(await p.db.top("workspaces").get(wid))).toMatchObject({ aiVoiceover: true });
    await p.credits.ensureAccount(wid, { grant: 10, reason: "test" });
    const v = await prepareSoundtrack(ctxFor(p, wid, "job_b2"), { doc: videoDoc(), compositionId: "cmp_v", appId: "app_1", storyboard: storyboard("tts", "calm ambient"), app: { name: "Focusly" } });
    expect(tts).toHaveLength(1);
    expect(v.voiceover).toMatchObject({ credits: 2, check: { passed: true } });
    expect((await p.credits.balance(wid)).available).toBe(8);
    expect(v.music?.mood).toBe("calm-pad");
    expect(v.doc.audio.find((a) => a.kind === "voiceover")).toMatchObject({ sourceLabel: "external_tts" });
    const html2 = compileToHtml(v.doc, { assetUrl: (id) => id, mode: "render", gsapSource: "inline" }).html;
    expect(/<audio id="a-aud_music"[^>]*data-automation=/.test(html2)).toBe(true);
  });

  it("reports (does not hide) a voice it couldn't make, and still delivers music", async () => {
    const p = createTestPlatform({ OPENAI_API_KEY: "sk-test", META_API_KEY: "test-meta-key" }, handlers);
    const wid = "ws_broke";
    await makeWorkspace(p, wid, { music: true, sfx: false, aiVoiceover: true });
    await p.credits.ensureAccount(wid, { grant: 1, reason: "test" }); // not enough for the voice
    const r = await prepareSoundtrack(ctxFor(p, wid, "job_c"), { doc: videoDoc(), compositionId: "cmp_c", appId: "app_1", storyboard: storyboard("tts"), app: null });
    expect(r.warnings.join(" ")).toMatch(/AI voiceover skipped/);
    expect(r.doc.audio.map((a) => a.kind)).toEqual(["music"]);
    expect((await p.credits.balance(wid)).available).toBe(1);
  });

  it("reads the narration script from the storyboard", () => {
    expect(narrationScript(storyboard("tts"))).toBe(SCRIPT);
    expect(narrationScript({ voiceover: { source: "tts" }, scenes: [{ order: 1, narration: "Two." }, { order: 0, narration: " One. " }] } as unknown as Storyboard)).toBe("One. Two.");
  });
});
