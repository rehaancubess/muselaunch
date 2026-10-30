import type { MediaAsset } from "@muselaunch/contracts";
import { toAppError, type JobContext } from "@muselaunch/platform";
import { metaClient } from "@muselaunch/providers";

/**
 * Screenshots that still need the raw-UI vs store-image check (Muse Spark) or, for store images, a
 * SAM 3.1 screen cut-out. Mirrors `pendingScreens` in @muselaunch/media (which does the work).
 */
export function screensNeedingCheck(assets: MediaAsset[]): MediaAsset[] {
  const cut = new Set(assets.filter((a) => a.sourceLabel === "sam_ui_crop" && a.status === "ready" && a.derivedFromAssetId).map((a) => a.derivedFromAssetId));
  return assets.filter(
    (a) =>
      a.role === "screenshot" &&
      a.kind === "image" &&
      a.isProductTruth &&
      !a.generation &&
      a.sourceLabel !== "sam_ui_crop" &&
      a.status === "ready" &&
      a.mimeType !== "image/svg+xml" &&
      (!a.screenshotKind || (a.screenshotKind === "marketing" && !cut.has(a.id))),
  );
}

/**
 * After App DNA: queue `media.extract_ui` for the app's screenshots so designed store images get their
 * real app screen cut out before storyboards pick media. Never blocks or fails the DNA job: missing
 * credits, quota or keys are logged on it instead.
 */
export async function queueScreenCutouts(ctx: JobContext, appId: string): Promise<string | undefined> {
  try {
    if (!metaClient(ctx.platform).configured) return undefined;
    const assets = (await ctx.ws.collection("mediaAssets").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items;
    const pending = screensNeedingCheck(assets);
    if (!pending.length) return undefined;
    const job = await ctx.enqueue("media.extract_ui", { appId }, {
      appId,
      idempotencyKey: `media.extract_ui:${ctx.job.id}`,
      credits: { operation: "media.extract_ui", amount: pending.length * (ctx.platform.credits.prices["media.extract_ui_per_image"] ?? 2) },
    });
    return job.id;
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code !== "INSUFFICIENT_CREDITS" && err.code !== "QUOTA_EXCEEDED") ctx.log.warn({ err, appId }, "could not queue screen cut-outs");
    await ctx.log_event(`Screen cut-outs not started: ${err.opts.userMessage ?? err.message}`).catch(() => {});
    return undefined;
  }
}
