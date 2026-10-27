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
