import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaAsset } from "@muselaunch/contracts";
import type { JobContext, Platform } from "@muselaunch/platform";
import { safeFetch, type SafeFetchResult } from "@muselaunch/platform";
import type { CallContext } from "@muselaunch/providers";

/** Per-platform test/injection hooks (like `installMetaClient`). Production uses the defaults. */
export interface MediaDeps {
  /** Provider HTTP (OpenAI images/TTS, stock APIs). */
  fetch?: typeof fetch;
  /** Download of third-party media URLs (stock files). Defaults to SSRF-safe `safeFetch`. */
  download?: (url: string, opts: { maxBytes: number; timeoutMs: number; accept: string[] }) => Promise<Pick<SafeFetchResult, "body" | "contentType" | "url">>;
}
const depsByPlatform = new WeakMap<Platform, MediaDeps>();
export function installMediaDeps(p: Platform, deps: MediaDeps): void {
  depsByPlatform.set(p, deps);
}
export function mediaDeps(p: Platform): Required<MediaDeps> {
  const d = depsByPlatform.get(p) ?? {};
  return {
    fetch: d.fetch ?? fetch,
    download: d.download ?? ((url, opts) => safeFetch(url, { maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs, accept: opts.accept })),
  };
}

/** Temp working directory, always removed (even on failure/cancel). */
export async function withWorkdir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "muselaunch-media-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Deterministic, Firestore-safe derived id (idempotent job outputs). */
export const derivedId = (prefix: string, ...parts: string[]) => `${prefix}_${sha256(parts.join("|")).slice(0, 24)}`;

export function callCtx(ctx: JobContext, task: string): CallContext {
  return { workspaceId: ctx.workspaceId, task, appId: ctx.appId, jobId: ctx.job.id, actor: ctx.actor, signal: ctx.signal };
}

/** All usage events recorded for a job (provider calls are metered with the job id). */
export async function usageEventIdsForJob(ctx: JobContext): Promise<string[]> {
  const page = await ctx.ws.collection("modelUsage").list({ where: [["jobId", "==", ctx.job.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 });
  return page.items.map((u) => u.id);
}

export const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "application/json": "json",
};

/** Fields every asset derived from a source carries over (tenancy scope + licence/consent). */
export function inheritFrom(src: MediaAsset): Pick<MediaAsset, "appId" | "campaignId" | "license" | "derivedFromAssetId"> {
  return { appId: src.appId, campaignId: src.campaignId, license: src.license, derivedFromAssetId: src.id };
}
