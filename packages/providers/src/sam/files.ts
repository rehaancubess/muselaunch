import { openAsBlob } from "node:fs";
import { metaClient, type CallContext } from "../meta/client";

/** Meta Files API object (https://dev.meta.ai/docs/file-handling). */
export interface MetaFile {
  id: string;
  object?: string;
  bytes?: number;
  created_at?: number;
  expires_at?: number;
  filename?: string;
  purpose?: string;
  status?: string;
}

/**
 * Upload a local file to `POST /v1/files` (`purpose=user_data`, synchronous: 200 = ready) so SAM can
 * reference it as `input_video.file_id`. Streams from disk (no full read into memory) and sets an
 * expiry so customer media does not linger in the Meta team storage. Metered (no cost) for audit.
 */
export async function uploadMetaFile(
  p: Parameters<typeof metaClient>[0],
  ctx: CallContext,
  input: { localPath: string; filename: string; mimeType: string; expiresAfterSec?: number },
): Promise<MetaFile> {
  const client = metaClient(p);
  client.requireMeta("SAM 3.1 video uploads");
  const seconds = Math.min(2_592_000, Math.max(3600, Math.round(input.expiresAfterSec ?? 6 * 3600)));
  return client.metered(ctx, { model: "files", operation: "file_upload", estimatedUsd: 0 }, async () => {
    const blob = await openAsBlob(input.localPath, { type: input.mimeType });
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("expires_after[anchor]", "created_at");
    form.append("expires_after[seconds]", String(seconds));
    // The file part goes last (documented: lower upload latency).
    form.append("file", blob, input.filename);
    const { data } = await client.fetchForm<MetaFile>("/files", form, { signal: ctx.signal });
    if (!data?.id) throw new Error("Meta Files API returned no file id");
    return {
      value: data,
      usage: { provider: "meta", model: "files", operation: "file_upload", costUsdEstimate: 0, dataMode: "standard" },
      trace: { request: { filename: input.filename, mimeType: input.mimeType, bytes: blob.size, expiresAfterSec: seconds }, response: data },
    };
  });
}

/** Best-effort delete of an uploaded file once it is no longer needed (privacy: don't keep customer media). */
export async function deleteMetaFile(p: Parameters<typeof metaClient>[0], fileId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await metaClient(p).fetchJson(`/files/${encodeURIComponent(fileId)}`, { method: "DELETE", signal });
    return true;
  } catch {
    return false;
  }
}
