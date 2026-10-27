import { CreateUploadRequest, MediaRole, type MediaKind } from "@muselaunch/contracts";
import { AppError, assertKeyInWorkspace, safeFilename, workspaceKey } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, query, requireCap, type AppEnv } from "../context";

/** Upload policy per media kind (content-type allowlist + size caps). */
const UPLOAD_POLICY: { kind: MediaKind; types: RegExp; maxBytes: number }[] = [
  { kind: "image", types: /^image\/(png|jpeg|webp|gif|heic|heif|svg\+xml)$/, maxBytes: 25 * 1024 * 1024 },
  { kind: "video", types: /^video\/(mp4|quicktime|webm|x-m4v)$/, maxBytes: 1024 * 1024 * 1024 },
  { kind: "audio", types: /^audio\/(mpeg|mp4|x-m4a|wav|x-wav|webm|ogg|aac|flac)$/, maxBytes: 200 * 1024 * 1024 },
  { kind: "document", types: /^(application\/pdf|text\/plain|text\/markdown|text\/csv)$/, maxBytes: 20 * 1024 * 1024 },
];

const PRODUCT_TRUTH_ROLES = new Set(["screenshot", "app_recording", "logo", "icon", "product_photo"]);

/** Media assets: signed direct uploads, listing and signed downloads. Module D extends processing. */
export const assetRoutes = new Hono<AppEnv>();

assetRoutes.post("/uploads", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const input = await body(c, CreateUploadRequest);
  const policy = UPLOAD_POLICY.find((u) => u.types.test(input.mimeType));
  if (!policy) throw new AppError("BAD_REQUEST", `Unsupported file type ${input.mimeType}`, { userMessage: "That file type isn't supported." });
  if (input.bytes > policy.maxBytes) throw new AppError("BAD_REQUEST", "File too large", { userMessage: `Files of this type can be up to ${Math.round(policy.maxBytes / 1024 / 1024)} MB.` });
  if ((input.role === "founder_clip" || input.role === "voiceover") && !input.consent) {
    throw new AppError("BAD_REQUEST", "Consent required for recordings of a person", { userMessage: "Confirm you have consent from the person recorded." });
  }
  if (input.appId) await p.db.ws(wid).collection("apps").getOrThrow(input.appId);
  const repo = p.db.ws(wid).collection("mediaAssets");
  const id = repo.newId();
  const key = workspaceKey(wid, "uploads", id, safeFilename(input.filename));
  const actor = actorOf(c);
  const asset = await repo.create(
    {
      id,
      appId: input.appId,
      campaignId: input.campaignId,
      kind: policy.kind,
      role: input.role,
      origin: "upload",
      storagePath: key,
      mimeType: input.mimeType,
      bytes: input.bytes,
      status: "pending_upload",
      originalFilename: input.filename.slice(0, 260),
      isProductTruth: PRODUCT_TRUTH_ROLES.has(input.role),
      license: {
        type: "user_uploaded",
        consent: input.consent ? { by: actor, at: new Date().toISOString(), scope: input.consent.scope } : undefined,
      },
    },
    { actor },
  );
  const upload = await p.storage.signedUploadUrl(key, { contentType: input.mimeType, maxBytes: input.bytes, expiresSec: 1800 });
  return c.json({ asset, upload }, 201);
});

assetRoutes.post("/assets/:assetId/complete", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const repo = p.db.ws(wid).collection("mediaAssets");
  const asset = await repo.getOrThrow(c.req.param("assetId"));
  if (asset.status !== "pending_upload") return c.json({ asset, job: null });
  const stat = await p.storage.stat(asset.storagePath);
  if (!stat) throw new AppError("CONFLICT", "Upload not found in storage", { userMessage: "The upload didn't finish. Please try again." });
  if (stat.bytes > asset.bytes * 1.01 + 1024) throw new AppError("BAD_REQUEST", "Uploaded size does not match");
  const actor = actorOf(c);
  const updated = await repo.update(asset.id, { status: "uploaded", bytes: stat.bytes }, { actor });
  const job = await p.jobs.create(wid, "media.probe", { assetId: asset.id }, { actor, appId: asset.appId, idempotencyKey: `probe:${asset.id}` });
  return c.json({ asset: updated, job });
});

const ListAssets = z.object({
  appId: z.string().optional(),
  campaignId: z.string().optional(),
  role: MediaRole.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  cursor: z.string().optional(),
});

assetRoutes.get("/assets", async (c) => {
  const p = c.get("platform");
  const q = query(c, ListAssets);
  const where: [string, "==", unknown][] = [];
  if (q.appId) where.push(["appId", "==", q.appId]);
  else if (q.campaignId) where.push(["campaignId", "==", q.campaignId]);
  if (q.role && q.appId) where.push(["role", "==", q.role]);
  const page = await p.db
    .ws(c.get("workspaceId"))
    .collection("mediaAssets")
    .list({ where, orderBy: where.length ? { field: "createdAt", dir: "desc" } : undefined, limit: q.limit, cursor: q.cursor });
  return c.json({ items: page.items.filter((a) => a.status !== "deleted"), nextCursor: page.nextCursor });
});

assetRoutes.get("/assets/:assetId", async (c) => {
  const p = c.get("platform");
  const asset = await p.db.ws(c.get("workspaceId")).collection("mediaAssets").getOrThrow(c.req.param("assetId"));
  return c.json({ asset });
});

/** Short-lived signed URL; the key is re-checked against the workspace before signing. */
assetRoutes.get("/assets/:assetId/url", async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(c.req.param("assetId"));
  if (asset.status === "deleted" || asset.status === "pending_upload") throw new AppError("NOT_FOUND", "Asset not available");
  assertKeyInWorkspace(wid, asset.storagePath);
  const download = c.req.query("download") === "1";
  const signed = await p.storage.signedDownloadUrl(asset.storagePath, { expiresSec: 3600, downloadName: download ? (asset.originalFilename ?? `${asset.id}`) : undefined });
  return c.json(signed);
});

assetRoutes.delete("/assets/:assetId", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const wid = c.get("workspaceId");
  const repo = p.db.ws(wid).collection("mediaAssets");
  const asset = await repo.getOrThrow(c.req.param("assetId"));
  assertKeyInWorkspace(wid, asset.storagePath);
  await p.storage.delete(asset.storagePath);
  const updated = await repo.update(asset.id, { status: "deleted" }, { actor: actorOf(c) });
  return c.json({ asset: updated });
});
