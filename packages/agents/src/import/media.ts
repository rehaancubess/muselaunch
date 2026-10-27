import type { MediaAsset } from "@muselaunch/contracts";
import { AppError, workspaceKey, type JobContext } from "@muselaunch/platform";
import sharp from "sharp";
import { fetcherFor } from "../fetcher";
import { clip, hashId } from "../util";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };
const FORMAT_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/**
 * Download a public listing image (icon/screenshot) into workspace storage as a product-truth
 * MediaAsset with its source URL and `public_listing` licence. Idempotent: the asset id is derived
 * from (app, source URL), so retries and re-imports reuse the same asset.
 */
export async function importListingImage(
  ctx: JobContext,
  input: { appId: string; url: string; role: "icon" | "screenshot"; origin: "store_import" | "website_import"; provider: string; attribution?: string; title: string; label: string },
): Promise<MediaAsset> {
  const repo = ctx.ws.collection("mediaAssets");
  const id = hashId("ast", input.appId, input.url);
  const existing = await repo.get(id);
  if (existing && existing.status === "ready") return existing;
  const res = await fetcherFor(ctx.platform)(input.url, { accept: ["image/"], maxBytes: 15 * 1024 * 1024, timeoutMs: 20_000, signal: ctx.signal });
  if (res.status !== 200) throw new AppError("PROVIDER_UNAVAILABLE", `Image ${input.url} returned ${res.status}`);
  let width: number | undefined;
  let height: number | undefined;
  let mime = res.contentType.split(";")[0]!.trim().toLowerCase();
  try {
    const m = await sharp(res.body).metadata();
    width = m.width;
    height = m.height;
    if (m.format && FORMAT_MIME[m.format]) mime = FORMAT_MIME[m.format]!;
  } catch {
    if (!mime.startsWith("image/x-icon")) throw new AppError("BAD_REQUEST", `Not a readable image: ${input.url}`);
  }
  const ext = EXT[mime] ?? "img";
  const key = workspaceKey(ctx.workspaceId, "apps", input.appId, "import", `${id}.${ext}`);
  const put = await ctx.platform.storage.put(key, res.body, { contentType: mime });
  const doc = {
    id,
    appId: input.appId,
    kind: "image" as const,
    role: input.role,
    origin: input.origin,
    storagePath: key,
    mimeType: mime,
    bytes: put.bytes,
    sha256: put.sha256,
    width,
    height,
    status: "ready" as const,
    title: clip(input.title, 200),
    labels: [input.label],
    isProductTruth: true,
    license: { type: "public_listing" as const, provider: input.provider, attribution: input.attribution ? clip(input.attribution, 500) : undefined, sourceUrl: input.url },
  };
  if (existing) return repo.update(id, doc, { actor: ctx.actor });
  return (await repo.createIfAbsent(doc, { actor: ctx.actor })).entity;
}
