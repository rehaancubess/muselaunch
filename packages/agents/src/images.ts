import type { MediaAsset } from "@muselaunch/contracts";
import { assertKeyInWorkspace, type Platform } from "@muselaunch/platform";
import { imagePart, type InputPart } from "@muselaunch/providers";
import sharp from "sharp";

/** A real still for Muse Spark to look at (≤ 1024 px JPEG; a signed URL on GCS). Also used by the slide planner. */
export async function imageInput(p: Platform, workspaceId: string, a: MediaAsset): Promise<{ part: InputPart; bytes: Buffer; width: number; height: number } | null> {
  assertKeyInWorkspace(workspaceId, a.storagePath);
  let buf: Buffer;
  try {
    buf = await p.storage.get(a.storagePath);
  } catch {
    return null;
  }
  const small = await sharp(buf).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true }).catch(() => null);
  if (!small) return null;
  if (p.storage.driver === "gcs") {
    const { url } = await p.storage.signedDownloadUrl(a.storagePath, { expiresSec: 900 });
    return { part: imagePart({ url }), bytes: small.data, width: small.info.width, height: small.info.height };
  }
  return { part: imagePart({ bytes: small.data, mimeType: "image/jpeg" }), bytes: small.data, width: small.info.width, height: small.info.height };
}
