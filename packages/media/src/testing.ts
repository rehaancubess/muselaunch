import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaAsset, MediaRole } from "@muselaunch/contracts";
import { workspaceKey, type Platform } from "@muselaunch/platform";
import { installMetaClient, MetaClient } from "@muselaunch/providers";
import { ffmpeg } from "./ffmpeg";

/**
 * Test helpers for module D (and modules that consume media in their tests). Provider traffic is
 * served from LABELLED fixtures under fixtures/media (documented shapes or synthetic data in the
 * documented wire format) — never presented as live output.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/media");

export function loadFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

/** Responses API SSE stream (one `output_text.delta` per line), as the OpenAI SDK consumes it. */
export function samSse(rawOutput: string): string {
  const lane = { item_id: "msg_fixture", output_index: 0, content_index: 0 };
  const events: Record<string, unknown>[] = [{ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } }];
  for (const line of rawOutput.split(/(?<=\n)/)) if (line) events.push({ type: "response.output_text.delta", ...lane, delta: line });
  events.push({ type: "response.output_text.done", ...lane, text: rawOutput });
  events.push({ type: "response.completed", response: { id: "resp_fixture", status: "completed" } });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

export interface RecordedCall {
  method: string;
  url: string;
  json?: Record<string, unknown>;
  form?: FormData;
}

export interface FakeMetaOptions {
  /** SAM special-token output for each /responses call, or an HTTP error to return instead. */
  samOutput?: (body: Record<string, unknown>) => string | { status: number; error: { message: string; type?: string; code?: string } };
  /**
   * Muse Spark structured-output calls (non-SAM /responses): return the JSON answer (wrapped in a
   * documented Responses body) or a `Response` to simulate an HTTP error.
   */
  spark?: (body: Record<string, unknown>) => unknown;
  transcribe?: (form: FormData) => unknown | Promise<unknown>;
  images?: (path: string, body: Record<string, unknown>) => unknown;
}

/** Fake fetch for https://api.meta.ai/v1 serving documented/synthetic fixtures; records every call. */
export function fakeMetaFetch(opts: FakeMetaOptions) {
  const calls: RecordedCall[] = [];
  let fileSeq = 0;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const call: RecordedCall = { method, url };
    if (typeof init.body === "string") call.json = JSON.parse(init.body);
    else if (init.body instanceof FormData) call.form = init.body;
    calls.push(call);
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (path === "/files" && method === "POST") return json({ id: `file-${++fileSeq}`, object: "file", bytes: 1, created_at: 1792000000, filename: "source.mp4", purpose: "user_data", status: "uploaded" });
    if (path.startsWith("/files/") && method === "DELETE") return json({ id: path.split("/").pop(), object: "file", deleted: true });
    if (path === "/responses" && opts.spark && !String(call.json?.model ?? "").startsWith("sam")) {
      const out = await opts.spark(call.json ?? {});
      if (out instanceof Response) return out;
      return json(sparkResponseBody(JSON.stringify(out), String(call.json?.model ?? "muse-spark-1.3")));
    }
    if (path === "/responses" && opts.samOutput) {
      const out = opts.samOutput(call.json ?? {});
      if (typeof out !== "string") return json({ error: out.error }, out.status);
      return new Response(samSse(out), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/asr/transcribe" && opts.transcribe) return json(await opts.transcribe(call.form!));
    if (path.startsWith("/images/") && opts.images) return json(opts.images(path, call.json ?? {}));
    return json({ error: { message: `fixture server: no route for ${method} ${path}`, type: "invalid_request_error", code: "not_found" } }, 404);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** Documented Responses API body carrying `text` as the assistant's answer. */
export function sparkResponseBody(text: string, model = "muse-spark-1.3"): Record<string, unknown> {
  return {
    id: `resp_fixture_${Math.random().toString(36).slice(2, 10)}`,
    object: "response",
    created_at: 1792000000,
    status: "completed",
    model,
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 9000, output_tokens: 600, total_tokens: 9600, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 200 } },
  };
}

/** Name of the structured-output schema of a recorded Responses request (e.g. "RecordingShotLabels"). */
export const schemaOf = (body: Record<string, unknown>): string | undefined => (body.text as { format?: { name?: string } } | undefined)?.format?.name;

/** All input_text of a recorded Responses request. */
export function textOf(body: Record<string, unknown>): string {
  const input = (body.input ?? []) as { content?: { type: string; text?: string }[] }[];
  return input.flatMap((m) => m.content ?? []).filter((c) => c.type === "input_text").map((c) => c.text ?? "").join("\n");
}

/** Number of input_image parts of a recorded Responses request. */
export function imageCountOf(body: Record<string, unknown>): number {
  const input = (body.input ?? []) as { content?: { type: string }[] }[];
  return input.flatMap((m) => m.content ?? []).filter((c) => c.type === "input_image").length;
}

export function installFakeMeta(p: Platform, opts: FakeMetaOptions) {
  const fake = fakeMetaFetch(opts);
  installMetaClient(p, new MetaClient(p, { fetch: fake.fetch, apiKey: "test-meta-key" }));
  return fake;
}

/** 160x120 @10fps, 2 s: blue background with a red 40x60 box moving right 3 px/frame (matches the SAM fixtures). */
export async function makeTestVideo(out: string, opts: { audio?: boolean; codec?: "h264" | "vp9"; seconds?: number } = {}) {
  const d = opts.seconds ?? 2;
  const vcodec = opts.codec === "vp9" ? ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8"] : ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  await ffmpeg([
    "-f", "lavfi", "-i", `color=c=blue:s=160x120:r=10:d=${d}`,
    "-f", "lavfi", "-i", `color=c=red:s=40x60:r=10:d=${d}`,
    ...(opts.audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${d}`] : []),
    "-filter_complex", "[0:v][1:v]overlay=x='10+n*3':y=30:shortest=1[v]",
    "-map", "[v]", ...(opts.audio ? ["-map", "2:a", "-c:a", opts.codec === "vp9" ? "libopus" : "aac"] : []),
    ...vcodec, "-r", "10",
    out,
  ]);
}

/** The concept prompt text of a recorded SAM request. */
export function samPromptOf(body: Record<string, unknown>): string {
  const input = body.input as { content?: { type: string; text?: string }[] }[] | undefined;
  return input?.[0]?.content?.find((c) => c.type === "input_text")?.text ?? "";
}

/**
 * 320x240 @10fps, 3 s clip for clip analysis (matches sam-clip-*.json): grey background, a blue
 * 80x140 "person" moving right 4 px/frame, and a red 24x40 "phone" moving diagonally (+5,+3 px/frame)
 * visible in frames 5–24, with a tone on the audio track.
 */
export async function makeTestClip(out: string) {
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x808080:s=320x240:r=10:d=3",
    "-f", "lavfi", "-i", "color=c=0x2050E0:s=80x140:r=10:d=3",
    "-f", "lavfi", "-i", "color=c=0xE03020:s=24x40:r=10:d=3",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=3",
    "-filter_complex", "[0:v][1:v]overlay=x='20+4*n':y=60:shortest=1[a];[a][2:v]overlay=x='40+5*n':y='30+3*n':enable='between(n,5,24)':shortest=1[v]",
    "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-r", "10",
    out,
  ]);
}

/** 96x64 PNG: blue with a red 40x30 box at (20,16) (matches sam-image-box.json). */
export async function makeTestImage(out: string) {
  await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=96x64", "-f", "lavfi", "-i", "color=c=red:s=40x30", "-filter_complex", "[0:v][1:v]overlay=x=20:y=16,format=rgb24[v]", "-map", "[v]", "-frames:v", "1", out]);
}

/**
 * Synthetic app walkthrough, 180x320 @10fps (optionally with a tone on the audio track): solid "screens"
 * whose brightness differs, so every change is a clear cut: 0–3 s, a 0.4 s flash (micro-shot, merged
 * into the next shot), 3.4–14 s (long: split), 14–16.5 s.
 */
export const WALKTHROUGH_SCREENS: { color: string; sec: number }[] = [
  { color: "0x2040A0", sec: 3 },
  { color: "0xF0F0F0", sec: 0.4 },
  { color: "0x103010", sec: 10.6 },
  { color: "0xD0C060", sec: 2.5 },
];
export async function makeTestWalkthrough(out: string, opts: { audio?: boolean } = {}) {
  const total = WALKTHROUGH_SCREENS.reduce((a, b) => a + b.sec, 0);
  const inputs = WALKTHROUGH_SCREENS.flatMap((x) => ["-f", "lavfi", "-i", `color=c=${x.color}:s=180x320:r=10:d=${x.sec}`]);
  const n = WALKTHROUGH_SCREENS.length;
  await ffmpeg([
    ...inputs,
    ...(opts.audio ? ["-f", "lavfi", "-i", `sine=frequency=300:duration=${total}`] : []),
    "-filter_complex", `${WALKTHROUGH_SCREENS.map((_, i) => `[${i}:v]`).join("")}concat=n=${n}:v=1:a=0[v]`,
    "-map", "[v]", ...(opts.audio ? ["-map", `${n}:a`, "-c:a", "aac"] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", "10",
    out,
  ]);
}

/**
 * Designed store screenshot, 393x852 (matches sam-image-phone-screen.json): purple background, two
 * headline bars, a black phone bezel and a light "app screen" 243x552 at (75,259) with two cards.
 */
export async function makeMarketingScreenshot(out: string) {
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x5E5CE6:s=393x852",
    "-f", "lavfi", "-i", "color=c=white:s=300x34",
    "-f", "lavfi", "-i", "color=c=white:s=220x26",
    "-f", "lavfi", "-i", "color=c=black:s=261x570",
    "-f", "lavfi", "-i", "color=c=0xF2F2F7:s=243x552",
    "-f", "lavfi", "-i", "color=c=white:s=211x120",
    "-filter_complex",
    "[0:v][1:v]overlay=46:84[a];[a][2:v]overlay=86:132[b];[b][3:v]overlay=66:250[c];[c][4:v]overlay=75:259[d];[d][5:v]overlay=91:330[e];[e][5:v]overlay=91:470,format=rgb24[v]",
    "-map", "[v]", "-frames:v", "1", out,
  ]);
}

/** Raw app screen capture, 393x852: light background, cards close to the side edges, full-width tab bar. */
export async function makeRawScreenshot(out: string) {
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=0xF2F2F7:s=393x852",
    "-f", "lavfi", "-i", "color=c=white:s=377x150",
    "-f", "lavfi", "-i", "color=c=0x5E5CE6:s=393x80",
    "-filter_complex", "[0:v][1:v]overlay=8:200[a];[a][1:v]overlay=8:380[b];[b][1:v]overlay=8:560[c];[c][2:v]overlay=0:772,format=rgb24[v]",
    "-map", "[v]", "-frames:v", "1", out,
  ]);
}

/** Short speech-like WAV/MP3 (tone + silence) for transcription/TTS plumbing tests. */
export async function makeTestAudio(out: string, seconds = 3) {
  await ffmpeg(["-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-ac", "1", "-ar", "24000", out]);
}

/** Store a local file as an uploaded MediaAsset (status `uploaded`), as the upload routes would. */
export async function storeUpload(
  p: Platform,
  wid: string,
  file: string,
  init: { kind: MediaAsset["kind"]; role: MediaRole; mimeType: string; appId?: string; consent?: boolean; actor?: string },
): Promise<MediaAsset> {
  const repo = p.db.ws(wid).collection("mediaAssets");
  const id = repo.newId();
  const key = workspaceKey(wid, "uploads", id, file.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._-]/g, "-"));
  const { bytes } = await p.storage.put(key, await readFile(file), { contentType: init.mimeType });
  const actor = init.actor ?? "tester";
  return repo.create(
    {
      id,
      appId: init.appId,
      kind: init.kind,
      role: init.role,
      origin: "upload",
      storagePath: key,
      mimeType: init.mimeType,
      bytes,
      status: "uploaded",
      labels: [],
      isProductTruth: ["screenshot", "app_recording"].includes(init.role),
      license: { type: "user_uploaded", consent: init.consent ? { by: actor, at: new Date().toISOString(), scope: "test consent" } : undefined },
    },
    { actor },
  );
}
