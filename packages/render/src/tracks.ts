/**
 * Load SAM object tracks (TracksFile JSON assets referenced by `Segmentation.tracksAssetId`).
 * Mirrors module D's `loadTracks`; kept local so the render worker has no dependency on the
 * media pipeline. Always workspace-scoped; unreadable/invalid files are skipped (effects fall back).
 */
import { TracksFile, type Segmentation } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { assertKeyInWorkspace, type ObjectStorage } from "@muselaunch/platform";

export async function loadTracksFor(storage: ObjectStorage, ws: WorkspaceDb, segs: Segmentation[]): Promise<Record<string, TracksFile>> {
  const out: Record<string, TracksFile> = {};
  for (const s of segs) {
    if (!s.tracksAssetId) continue;
    const a = await ws.collection("mediaAssets").get(s.tracksAssetId);
    if (!a || a.status !== "ready") continue;
    assertKeyInWorkspace(ws.workspaceId, a.storagePath);
    try {
      const parsed = TracksFile.safeParse(JSON.parse((await storage.get(a.storagePath)).toString("utf8")));
      if (parsed.success) out[s.id] = parsed.data;
    } catch {
      /* missing or malformed: effects/anchors fall back */
    }
  }
  return out;
}

/** Per-object cutouts/mattes plus the combined cutout, for downloading alongside a render. */
export function segmentationAssetIds(segs: Segmentation[]): string[] {
  const ids = new Set<string>();
  for (const s of segs) {
    if (s.cutoutAssetId) ids.add(s.cutoutAssetId);
    for (const o of Object.values(s.objectOutputs ?? {})) if (o.cutoutAssetId) ids.add(o.cutoutAssetId);
  }
  return [...ids];
}
