import { join } from "node:path";
import type { MediaAsset, RecordingSegment, Storyboard } from "@muselaunch/contracts";
import { toAppError, type JobContext } from "@muselaunch/platform";
import { metaClient } from "@muselaunch/providers";
import { probeMedia } from "./ffmpeg";
import { trackRegions } from "./region-track";
import { EXT_BY_MIME, withWorkdir } from "./util";

/**
 * Close-ups that follow the element (storyboard.resolve_media). Muse Spark (or SAM on a still) points
 * a focus-zoom / tap-demo at a UI element on a walkthrough segment's keyframe; on footage the element
 * moves (a list scrolls, a sheet slides up). SAM 3.1 tracks that box through the segment and the
 * storyboard scene keeps the path (`focusPath`), so the zoom and highlight ring follow the element.
 * Optional: any failure leaves the static close-up and is reported as a warning.
 */

/** Templates whose push-in follows a tracked element on video screens. */
export const FOLLOW_TEMPLATES = new Set(["focus-zoom", "tap-demo"]);
/** SAM tracking calls per storyboard. */
export const MAX_FOCUS_TRACKS = 4;

/** Keyframe time of a segment: the stored value, else the "still at m:ss.s" of its keyframe's title (older breakdowns). */
export function keyframeTime(seg: Pick<RecordingSegment, "keyframeAtSec" | "startSec" | "endSec">, keyframe?: Pick<MediaAsset, "title">): number | undefined {
  if (seg.keyframeAtSec !== undefined) return seg.keyframeAtSec;
  const m = /still at (\d+):(\d+(?:\.\d+)?)\s*$/.exec(keyframe?.title ?? "");
  if (!m) return undefined;
  const t = Number(m[1]) * 60 + Number(m[2]);
  return t >= seg.startSec - 0.2 && t <= seg.endSec + 0.2 ? t : undefined;
}

export async function trackStoryboardFocus(ctx: JobContext, sb: Storyboard): Promise<{ tracked: number; warnings: string[] }> {
  const warnings: string[] = [];
  const wanted = [...sb.scenes]
    .sort((a, b) => a.order - b.order)
    .filter((s) => FOLLOW_TEMPLATES.has(s.template) && s.focus && !s.focusPath && s.assets.some((h) => h.segmentId))
    .slice(0, MAX_FOCUS_TRACKS);
  if (!wanted.length || !metaClient(ctx.platform).configured) return { tracked: 0, warnings };
  const segIds = wanted.map((s) => s.assets.find((h) => h.segmentId)!.segmentId!);
  const segs = new Map(((await ctx.ws.collection("recordingSegments").getMany(segIds)) as RecordingSegment[]).filter((s) => s.appId === sb.appId).map((s) => [s.id, s]));
  const recIds = [...new Set([...segs.values()].map((s) => s.assetId))];
  const recs = new Map(((await ctx.ws.collection("mediaAssets").getMany(recIds)) as MediaAsset[]).filter((a) => a.kind === "video" && a.status === "ready" && a.appId === sb.appId).map((a) => [a.id, a]));
  const kfIds = [...segs.values()].map((s) => s.keyframeAssetId).filter((x): x is string => !!x);
  const keyframes = new Map(((await ctx.ws.collection("mediaAssets").getMany(kfIds)) as MediaAsset[]).map((a) => [a.id, a]));
  const paths = new Map<string, NonNullable<Storyboard["scenes"][number]["focusPath"]>>();
  await withWorkdir(async (dir) => {
    const local = new Map<string, { file: string; size: { width: number; height: number } }>();
    for (const scene of wanted) {
      ctx.throwIfCancelled();
      const seg = segs.get(scene.assets.find((h) => h.segmentId)!.segmentId!);
      const rec = seg ? recs.get(seg.assetId) : undefined;
      const anchorSec = seg ? keyframeTime(seg, seg.keyframeAssetId ? keyframes.get(seg.keyframeAssetId) : undefined) : undefined;
      if (!seg || !rec || anchorSec === undefined) continue;
      try {
        let src = local.get(rec.id);
        if (!src) {
          const file = join(dir, `${rec.id}.${EXT_BY_MIME[rec.mimeType] ?? "mp4"}`);
          await ctx.platform.storage.downloadToFile(rec.storagePath, file);
          const info = await probeMedia(file, { signal: ctx.signal });
          src = { file, size: { width: info.displayWidth ?? rec.width ?? 0, height: info.displayHeight ?? rec.height ?? 0 } };
          local.set(rec.id, src);
        }
        if (!src.size.width || !src.size.height) continue;
        const r = await trackRegions(ctx, { src: src.file, dir, size: src.size, startSec: seg.startSec, endSec: seg.endSec, regions: [{ ...scene.focus!, anchorSec }], task: "storyboard.focus_track" });
        if (r.paths[0]) {
          paths.set(scene.id, r.paths[0]);
          await ctx.log_event(`Scene ${scene.order + 1}: SAM 3.1 follows the ${scene.focusQuery ? `“${scene.focusQuery.slice(0, 40)}”` : "focused element"} as it moves`);
        } else warnings.push(`Scene ${scene.order + 1}: the close-up stays fixed (${r.reasons[0] ?? "not tracked"})`);
      } catch (raw) {
        const err = toAppError(raw);
        if (err.code === "CANCELLED" || ctx.signal.aborted) throw err;
        warnings.push(`Scene ${scene.order + 1}: the close-up stays fixed (tracking unavailable: ${(err.opts.userMessage ?? err.message).slice(0, 120)})`);
      }
    }
  });
  if (paths.size) {
    // Re-read so a concurrent write (b-roll) is not lost; only focusPath is added.
    const fresh = await ctx.ws.collection("storyboards").getOrThrow(sb.id);
    await ctx.ws.collection("storyboards").update(sb.id, { scenes: fresh.scenes.map((s) => (paths.has(s.id) && !s.focusPath ? { ...s, focusPath: paths.get(s.id)! } : s)) }, { actor: ctx.actor });
  }
  return { tracked: paths.size, warnings };
}
