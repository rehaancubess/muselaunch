/**
 * A spoken instruction ("Make the opening shorter") → its words, with Muse Voice Transcribe: the same
 * path as the web's spoken edits (apps/web/src/features/media/lib.ts transcribeVoiceCommand). The clip
 * is uploaded as the person's own `voice_command` (POST /uploads → signed PUT → /complete), then
 * POST /assets/:id/transcribe answers with the text, or the job is followed. Nothing is spent on the
 * edit itself here: the words land in the box and the person taps the button.
 */
import { File } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import { Platform } from "react-native";
import { newKey, type Api } from "../api/client";
import { waitForJob } from "../api/hooks";
import type { Job, Transcript, UploadResponse } from "../api/types";

export type VoiceStage = "uploading" | "transcribing";

const baseMime = (t: string) => t.split(";")[0]!.trim().toLowerCase();

/** The recording's type: m4a (AAC) on phones, WebM in a browser. */
export function recordingMime(uri: string, blobType?: string): { mimeType: string; ext: string } {
  if (blobType) {
    const m = baseMime(blobType);
    if (m.includes("webm")) return { mimeType: "audio/webm", ext: "webm" };
    if (m.includes("ogg")) return { mimeType: "audio/ogg", ext: "ogg" };
    if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return { mimeType: "audio/mp4", ext: "m4a" };
  }
  if (/\.webm($|\?)/i.test(uri)) return { mimeType: "audio/webm", ext: "webm" };
  return { mimeType: "audio/mp4", ext: "m4a" };
}

async function upload(api: Api, target: UploadResponse["upload"], body: Blob | File, mimeType: string): Promise<void> {
  const url = target.url.startsWith("http") ? target.url : `${api.base}${target.url}`;
  const headers: Record<string, string> = { ...target.headers };
  if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = mimeType;
  const send = Platform.OS === "web" ? fetch : (expoFetch as unknown as typeof fetch);
  const res = await send(url, { method: target.method, headers, body: body as unknown as BodyInit });
  if (!res.ok) throw new Error("The recording didn’t upload. Check your connection and try again.");
}

export async function transcribeRecording(api: Api, uri: string, opts: { appId?: string | null; onStage?: (s: VoiceStage) => void } = {}): Promise<string> {
  let body: Blob | File;
  let bytes: number;
  let kind: { mimeType: string; ext: string };
  if (Platform.OS === "web") {
    const blob = await (await fetch(uri)).blob();
    kind = recordingMime(uri, blob.type);
    body = blob;
    bytes = blob.size;
  } else {
    const file = new File(uri);
    kind = recordingMime(uri);
    body = file;
    bytes = file.size;
  }
  if (!bytes) throw new Error("Nothing was recorded. Hold the mic button while you speak.");
  opts.onStage?.("uploading");
  const up = await api.post<UploadResponse>(api.ws("/uploads"), { filename: `spoken-change-${Date.now()}.${kind.ext}`, mimeType: kind.mimeType, bytes, role: "other", ...(opts.appId ? { appId: opts.appId } : {}) });
  await upload(api, up.upload, body, kind.mimeType);
  const getJob = (id: string) => api.get<{ job: Job }>(api.ws(`/jobs/${id}`)).then((r) => r.job);
  const done = await api.post<{ job: Job | null }>(api.ws(`/assets/${up.asset.id}/complete`));
  if (done.job) {
    const probe = await waitForJob(getJob, done.job.id);
    if (probe.status !== "succeeded") throw new Error(probe.error?.userMessage ?? "That recording couldn’t be read. Try again, or type it.");
  }
  opts.onStage?.("transcribing");
  const tr = await api.post<{ job: Job | null; transcript: Transcript }>(api.ws(`/assets/${up.asset.id}/transcribe`), { purpose: "voice_command" }, { idempotencyKey: newKey("voice") });
  if (tr.job && tr.transcript.status !== "succeeded") {
    const j = await waitForJob(getJob, tr.job.id);
    if (j.status !== "succeeded") throw new Error(j.error?.userMessage ?? "Muse couldn’t hear that. Try again, or type it.");
  }
  const view = await api.get<{ transcript: Transcript }>(api.ws(`/transcripts/${tr.transcript.id}`));
  const text = view.transcript.text.trim();
  if (!text) throw new Error("Muse didn’t catch any words. Try again a little closer to the phone.");
  return text;
}
