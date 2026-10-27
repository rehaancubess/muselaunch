import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { MediaAsset } from "@muselaunch/contracts";
import { AppError, workspaceKey, type JobContext } from "@muselaunch/platform";
import { guardImagePrompt, resolveImageProvider, type ImageResult } from "@muselaunch/providers";
import { probeMedia } from "./ffmpeg";
import { callCtx, derivedId, EXT_BY_MIME, mediaDeps, sha256, withWorkdir } from "./util";

/**
 * `media.image_generate`: campaign imagery (backgrounds, scenes, illustrations, thumbnails).
 * Provider: Muse Image only if the geo gate passes, otherwise the licensed alternative (OpenAI).
 * Every asset records provider/model/prompt/revision and is never product truth; prompts asking
 * for the app's UI are refused (real screenshots in device frames are used for that).
 */
export async function imageGenerateHandler(ctx: JobContext<"media.image_generate">) {
  const { prompt, count, size, parentAssetId, appId, campaignId, endUserCountry } = ctx.payload;
  const repo = ctx.ws.collection("mediaAssets");
  const ids = Array.from({ length: count }, (_, i) => derivedId("ast", ctx.job.id, "img", String(i)));

  // Idempotency: a redelivered job returns what it already produced instead of paying again.
  const existing = (await repo.getMany(ids)).filter((a) => a.status === "ready");
  if (existing.length) {
    return { refs: existing.map((a) => ({ entity: "mediaAssets", id: a.id })), data: { assetIds: existing.map((a) => a.id), provider: existing[0]!.generation?.provider, model: existing[0]!.generation?.model, reused: true } };
  }

  const guard = guardImagePrompt(prompt);
  if (!guard.ok) throw new AppError("BAD_REQUEST", `Image prompt refused: ${guard.reason}`, { retryable: false, userMessage: guard.userMessage });
  const { provider, choice } = resolveImageProvider(ctx.platform, endUserCountry, { fetch: mediaDeps(ctx.platform).fetch });

  let parent: MediaAsset | undefined;
  if (parentAssetId) {
    parent = await repo.getOrThrow(parentAssetId);
    if (parent.kind !== "image" || parent.status !== "ready") throw new AppError("BAD_REQUEST", "Revisions need a ready image", { retryable: false });
    if (parent.isProductTruth) {
      throw new AppError("BAD_REQUEST", "Refusing to AI-edit a real product screenshot", {
        retryable: false,
        userMessage: "Real screenshots can't be AI-edited (that would misrepresent your app). Revise a generated image instead.",
      });
    }
  }

  await ctx.progress(10, "generating", `${choice.label} · ${choice.model}`);
  const cc = callCtx(ctx, parent ? "image.revise" : "image.generate");
  let result: ImageResult;
  if (parent) {
    const data = await ctx.platform.storage.get(parent.storagePath);
    result = await provider.edit(cc, { prompt: guard.prompt, n: count, size, images: [{ data, mimeType: parent.mimeType, filename: `source.${EXT_BY_MIME[parent.mimeType] ?? "png"}` }] });
  } else {
    result = await provider.generate(cc, { prompt: guard.prompt, n: count, size });
  }
  ctx.throwIfCancelled();
  await ctx.progress(80, "saving");

  const revision = parent ? (parent.generation?.revision ?? 0) + 1 : 1;
  const usageEvent = result.usageEventId ?? (await latestUsageEventId(ctx));
  const created: MediaAsset[] = await withWorkdir(async (dir) => {
    const out: MediaAsset[] = [];
    for (const [i, img] of result.images.slice(0, count).entries()) {
      const id = ids[i]!;
      const ext = EXT_BY_MIME[img.mimeType] ?? "png";
      const key = workspaceKey(ctx.workspaceId, "generated", id, `image.${ext}`);
      const { bytes } = await ctx.platform.storage.put(key, img.data, { contentType: img.mimeType });
      const local = join(dir, `${i}.${ext}`);
      await writeFile(local, img.data);
      const info = await probeMedia(local);
      const [w, h] = size.split("x").map(Number);
      const { entity } = await repo.createIfAbsent(
        {
          id,
          appId: appId ?? parent?.appId,
          campaignId: campaignId ?? parent?.campaignId,
          kind: "image",
          role: "generated_image",
          origin: "generated",
          storagePath: key,
          mimeType: img.mimeType,
          bytes,
          sha256: sha256(img.data),
          width: info.width ?? w,
          height: info.height ?? h,
          status: "ready",
          isProductTruth: false,
          sourceLabel: "ai_generated_image",
          labels: ["ai_generated", `provider:${result.provider}`],
          title: `AI image · ${choice.label}${revision > 1 ? ` · rev ${revision}` : ""}`.slice(0, 200),
          license: { type: "generated_terms", provider: choice.label, termsUrl: provider.termsUrl, restrictions: "AI-generated. Must not be presented as a real product screenshot." },
          generation: { provider: result.provider, model: result.model, prompt: prompt.slice(0, 4000), revision, parentAssetId: parent?.id, usageEventId: usageEvent },
          derivedFromAssetId: parent?.id,
        },
        { actor: ctx.actor },
      );
      out.push(entity);
    }
    return out;
  });
  const reserved = ctx.job.reservation?.credits;
  return {
    refs: created.map((a) => ({ entity: "mediaAssets", id: a.id })),
    data: { assetIds: created.map((a) => a.id), provider: choice, revision, costUsd: result.costUsd },
    // Charge only for images actually returned.
    creditsUsed: reserved !== undefined ? Math.ceil((reserved * created.length) / count) : undefined,
  };
}

async function latestUsageEventId(ctx: JobContext): Promise<string | undefined> {
  const page = await ctx.ws.collection("modelUsage").list({ where: [["jobId", "==", ctx.job.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 1 });
  return page.items[0]?.id;
}
