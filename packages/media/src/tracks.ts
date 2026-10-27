import { TracksFile, type ObjectTrack } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { assertKeyInWorkspace, type Platform } from "@muselaunch/platform";
import { decodeMaskToRaster, type SamResult } from "@muselaunch/providers";
import { trackingQuality, type FrameSize } from "./masks";

/**
 * Per-object tracks from SAM output (every value comes from the decoded masks; frames without a
 * detection are `visible: false`, never interpolated). Coordinates are normalised 0..1 of the frame.
 */

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Contract `ObjectKey` charset (compositions interpolate object ids; SAM ids are decimal, but never trust input). */
export const SAFE_OBJECT_ID = /^[A-Za-z0-9_.:-]{1,40}$/;

export function buildTracks(result: SamResult, meta: { width: number; height: number; fps?: number; frameCount: number }, labels: Record<string, string>, sam?: FrameSize): TracksFile {
  const W = meta.width;
  const H = meta.height;
  const fps = meta.fps && meta.fps > 0 ? meta.fps : 1;
  const sx = sam && sam.width !== W ? W / sam.width : 1;
  const sy = sam && sam.height !== H ? H / sam.height : 1;
  const tracks: ObjectTrack[] = result.objectIds.filter((id) => SAFE_OBJECT_ID.test(id)).map((objectId) => ({
    objectId,
    label: (labels[objectId] ?? objectId).slice(0, 80),
    frames: Array.from({ length: meta.frameCount }, (_, i) => ({ t: r4(i / fps), visible: false })),
  }));
  const byId = new Map(tracks.map((t) => [t.objectId, t]));
  for (const d of result.detections) {
    const track = byId.get(d.objectId);
    if (!track || d.frame < 0 || d.frame >= meta.frameCount) continue;
    const raster = decodeMaskToRaster(d.mask);
    const mw = d.mask.width;
    const mh = d.mask.height;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 0; y < mh; y++) {
      const row = y * mw;
      for (let x = 0; x < mw; x++) {
        if (raster[row + x]) {
          count++;
          sumX += x;
          sumY += y;
        }
      }
    }
    if (!count) continue;
    const left = d.bounds.left * sx;
    const top = d.bounds.top * sy;
    const bw = (d.bounds.right - d.bounds.left) * sx;
    const bh = (d.bounds.bottom - d.bounds.top) * sy;
    const cx = left + ((sumX / count + 0.5) * bw) / mw;
    const cy = top + ((sumY / count + 0.5) * bh) / mh;
    const area = (count * (bw * bh)) / (mw * mh) / (W * H);
    track.frames[d.frame] = {
      t: r4(d.frame / fps),
      visible: true,
      bbox: { x: r4(left / W), y: r4(top / H), w: r4(bw / W), h: r4(bh / H) },
      centroid: { x: r4(cx / W), y: r4(cy / H) },
      area: r4(Math.min(1, area)),
      ...(d.confidence !== undefined ? { score: d.confidence } : {}),
    };
  }
  return { fps, frameCount: meta.frameCount, width: W, height: H, tracks };
}

/** Visible time ranges; gaps of ≤ `bridgeFrames` (tracking blips) are bridged. */
export function presenceRanges(track: ObjectTrack, fps: number, bridgeFrames = 2): { startSec: number; endSec: number }[] {
  const out: { start: number; end: number }[] = [];
  track.frames.forEach((f, i) => {
    if (!f.visible) return;
    const last = out[out.length - 1];
    if (last && i - last.end - 1 <= bridgeFrames) last.end = i;
    else out.push({ start: i, end: i });
  });
  return out.slice(0, 100).map((r) => ({ startSec: r4(r.start / fps), endSec: r4((r.end + 1) / fps) }));
}

export function meanBbox(track: ObjectTrack): { x: number; y: number; w: number; h: number } | undefined {
  const boxes = track.frames.filter((f) => f.visible && f.bbox).map((f) => f.bbox!);
  if (!boxes.length) return undefined;
  const avg = (k: "x" | "y" | "w" | "h") => r4(boxes.reduce((a, b) => a + b[k], 0) / boxes.length);
  return { x: avg("x"), y: avg("y"), w: avg("w"), h: avg("h") };
}

/** Per-object tracking quality from the object's own per-frame mask area (same heuristic as the combined matte). */
export function trackQuality(track: ObjectTrack): number {
  return trackingQuality(track.frames.map((f) => (f.visible ? (f.area ?? 0) : 0)));
}

/**
 * Load a segmentation's tracks (module C compiler/render handlers). Returns null when the
 * segmentation has no tracks yet (not succeeded, or produced before tracks existed).
 */
export async function loadTracks(p: Platform, ws: WorkspaceDb, segmentationId: string): Promise<TracksFile | null> {
  const seg = await ws.collection("segmentations").get(segmentationId);
  if (!seg?.tracksAssetId) return null;
  const asset = await ws.collection("mediaAssets").get(seg.tracksAssetId);
  if (!asset || asset.status !== "ready") return null;
  assertKeyInWorkspace(ws.workspaceId, asset.storagePath);
  const parsed = TracksFile.safeParse(JSON.parse((await p.storage.get(asset.storagePath)).toString("utf8")));
  return parsed.success ? parsed.data : null;
}
