import type { CompositionDoc, MediaAsset } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";

/**
 * Model-chosen media ids are untrusted (security guarantee 7): any asset a suggested fix introduces
 * into a composition must be one of THIS app's real product-truth screenshots/recordings. Ids from
 * other apps/workspaces are simply unknown here.
 */

function refsOf(doc: CompositionDoc): Set<string> {
  const ids = new Set<string>();
  for (const s of doc.scenes) {
    if (s.background.assetId) ids.add(s.background.assetId);
    for (const l of s.layers) {
      if (l.type === "image" || l.type === "video") ids.add(l.assetId);
      else if (l.type === "device") ids.add(l.screenAssetId);
      else if (l.type === "effect" && l.assetId) ids.add(l.assetId);
    }
  }
  for (const a of doc.audio) ids.add(a.assetId);
  return ids;
}

export const isRealProductMedia = (a: MediaAsset) => a.isProductTruth && !a.generation && a.origin !== "generated" && (a.role === "screenshot" || a.role === "app_recording") && a.status !== "deleted" && a.status !== "failed";

/** Problems with media ids that `next` references but `base` did not. Empty when the fix is safe. */
export function newAssetProblems(base: CompositionDoc, next: CompositionDoc, appAssets: Map<string, MediaAsset>): string[] {
  const before = refsOf(base);
  const problems: string[] = [];
  for (const id of refsOf(next)) {
    if (before.has(id)) continue;
    const a = appAssets.get(id);
    if (!a) problems.push(`references unknown asset ${id}`);
    else if (!isRealProductMedia(a)) problems.push(`asset ${id} is not a real screenshot or recording of this app`);
  }
  return problems;
}

/** Collect every `*assetId` string inside untrusted model output (to preload exactly those assets). */
export function assetIdsIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) assetIdsIn(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/assetid$/i.test(k) && typeof v === "string" && v.length <= 128) out.add(v);
      else assetIdsIn(v, out);
    }
  }
  return out;
}

/** This app's media among `ids` (workspace-scoped lookup; other apps' assets are dropped). */
export async function appAssetsById(ws: WorkspaceDb, appId: string, ids: Iterable<string>): Promise<Map<string, MediaAsset>> {
  const list = [...new Set(ids)].slice(0, 100);
  if (!list.length) return new Map();
  const found = (await ws.collection("mediaAssets").getMany(list)) as MediaAsset[];
  return new Map(found.filter((a) => a.appId === appId).map((a) => [a.id, a]));
}
