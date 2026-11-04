"use client";
import type { CaptionCue, ClipAnalysis, Job, MediaAsset, Segmentation, TracksFile, Transcript } from "@muselaunch/contracts";
import { TERMINAL_JOB_STATUSES } from "@muselaunch/contracts";
import { api, uploadToSignedUrl, wsPath } from "@/lib/api";
import type { CompleteUploadResponse, EstimateResponse, JobResponse, SignedUrl, UploadResponse } from "@/lib/api-types";
import { useApiQuery } from "@/lib/query";

/** Response shapes of module D routes (apps/api/src/routes/media.ts). */
export type SegmentResponse = { job: Job | null; segmentation: Segmentation; reused: boolean };
export type SegmentationView = { segmentation: Segmentation; assets: { mask: MediaAsset | null; cutout: MediaAsset | null; preview: MediaAsset | null }; lowQuality: boolean };
export type CorrectResponse = { job: Job; segmentation: Segmentation };
export type TranscribeResponse = { job: Job | null; transcript: Transcript; reused?: boolean };
export type TranscriptView = { transcript: Transcript; cues: CaptionCue[]; timing: "turn" };

/** Mirrors the API's consent rule for person prompts (the server enforces it; this only shows the checkbox early). */
export const PERSON_PROMPT = /\b(person|people|man|men|woman|women|boy|girl|kid|child|human|face|head|founder|speaker|presenter|me|myself|someone|guy|lady|body|hair|hand|hands)\b/i;

export const fetchEstimate = (workspaceId: string) => (req: { operation: string; params: Record<string, unknown> }) => api.post<EstimateResponse>(wsPath(workspaceId, "/estimate"), req);

/** Short-lived signed URL for an asset (refreshed well before the 1 h expiry). */
export function useSignedUrl(workspaceId: string, assetId: string | null | undefined) {
  return useApiQuery<SignedUrl>(assetId ? wsPath(workspaceId, `/assets/${assetId}/url`) : null, { staleTime: 45 * 60_000, refetchInterval: 50 * 60_000 });
}

/** Poll a job until it is terminal (used inside imperative upload flows). */
export async function waitForJob(workspaceId: string, jobId: string, opts: { signal?: AbortSignal; onUpdate?: (job: Job) => void; timeoutMs?: number } = {}): Promise<Job> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let delay = 600;
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const { job } = await api.get<JobResponse>(wsPath(workspaceId, `/jobs/${jobId}`), { signal: opts.signal });
    opts.onUpdate?.(job);
    if ((TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error("This is taking longer than expected. It will keep running in the background.");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(2500, Math.round(delay * 1.4));
  }
}

export function qualityOf(q: number | undefined): { tone: "success" | "warning" | "danger" | "neutral"; label: string } {
  if (q === undefined) return { tone: "neutral", label: "Quality unknown" };
  if (q >= 0.8) return { tone: "success", label: `Tracking good · ${Math.round(q * 100)}%` };
  if (q >= 0.5) return { tone: "warning", label: `Tracking fair · ${Math.round(q * 100)}%` };
  return { tone: "danger", label: `Tracking low · ${Math.round(q * 100)}%` };
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Strip codec parameters so the declared upload type matches the API allowlist (e.g. `audio/webm`). */
export const baseMime = (t: string) => t.split(";")[0]!.trim().toLowerCase();

/**
 * A spoken instruction ("Make the opening shorter") → its text, with Muse Voice Transcribe: the same
 * path as the Studio's "Speak an edit" (upload as the person's own `voice_command`, no consent step,
 * POST /assets/:id/transcribe answers with the text when it's quick, else the job is followed).
 */
export async function transcribeVoiceCommand(workspaceId: string, blob: Blob, opts: { appId?: string; signal?: AbortSignal; onStage?: (stage: "uploading" | "transcribing") => void } = {}): Promise<{ text: string; transcriptId: string }> {
  const mimeType = baseMime(blob.type || "audio/webm");
  const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
  opts.onStage?.("uploading");
  const up = await api.post<UploadResponse>(wsPath(workspaceId, "/uploads"), { filename: `spoken-change-${Date.now()}.${ext}`, mimeType, bytes: blob.size, role: "other", appId: opts.appId });
  await uploadToSignedUrl(up.upload, new Blob([blob], { type: mimeType }), undefined, opts.signal);
  const done = await api.post<CompleteUploadResponse>(wsPath(workspaceId, `/assets/${up.asset.id}/complete`));
  if (done.job) {
    const probe = await waitForJob(workspaceId, done.job.id, { signal: opts.signal });
    if (probe.status !== "succeeded") throw new Error(probe.error?.userMessage ?? "That recording couldn’t be read. Try again, or type it.");
  }
  opts.onStage?.("transcribing");
  const tr = await api.post<TranscribeResponse>(wsPath(workspaceId, `/assets/${up.asset.id}/transcribe`), { purpose: "voice_command" }, { idempotent: true });
  if (tr.job && tr.transcript.status !== "succeeded") {
    const j = await waitForJob(workspaceId, tr.job.id, { signal: opts.signal });
    if (j.status !== "succeeded") throw new Error(j.error?.userMessage ?? "Muse couldn’t hear that. Try again, or type it.");
  }
  const view = await api.get<TranscriptView>(wsPath(workspaceId, `/transcripts/${tr.transcript.id}`));
  return { text: view.transcript.text.trim(), transcriptId: view.transcript.id };
}

/** Clip analysis routes (object-aware editing). */
export type AnalyzeClipResponse = { job: Job | null; analysis: ClipAnalysis };
export type ClipAnalysisView = {
  analysis: ClipAnalysis;
  segmentations: Segmentation[];
  /** Signed URLs (1 h) for the source clip and every cutout/matte/preview/tracks asset. */
  assets: Record<string, { url: string; kind: MediaAsset["kind"]; role: MediaAsset["role"]; mimeType?: string }>;
  tracksUrls: Record<string, string>;
  transcript?: Transcript | null;
};
export type ClipEstimate = { credits: number; breakdown: { label: string; credits: number }[]; available: number };

/** Fetch a tracks JSON via its signed URL (no auth header: the URL itself is the short-lived grant). */
export async function fetchTracks(url: string, signal?: AbortSignal): Promise<TracksFile> {
  const res = await fetch(url, { signal, credentials: "omit" });
  if (!res.ok) throw new Error(`Tracks unavailable (${res.status})`);
  return (await res.json()) as TracksFile;
}

/** Distinct, accessible object colours (overlay boxes + chips). */
export const OBJECT_COLORS = ["#3355ff", "#e5484d", "#12a594", "#f5a524", "#8e4ec6", "#0090ff", "#d6409f", "#46a758"] as const;
