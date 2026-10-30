import type { MediaAsset, ProductMediaOption, RecordingSegment } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { productAssets, type AppContextData } from "./context";

/**
 * Everything a storyboard may show of the real product, as one list:
 * - walkthrough segments (best: real motion), labelled by feature;
 * - raw screenshots and SAM screen cut-outs (`sourceLabel: "sam_ui_crop"`), which may go in a device frame;
 * - designed marketing screenshots, only ever shown full screen (never inside another device frame);
 * - founder clips, logo, icon.
 * When a marketing screenshot has a SAM cut-out, the cut-out is the device-frame option and the
 * original stays available as a full-screen option.
 */
export async function productMediaOptions(ws: WorkspaceDb, appId: string, dna?: AppContextData["dna"]): Promise<ProductMediaOption[]> {
  const assets = await productAssets(ws, appId);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const featuresByAsset = new Map<string, string[]>();
  for (const f of dna?.features ?? []) for (const id of f.assetIds) featuresByAsset.set(id, [...(featuresByAsset.get(id) ?? []), f.id]);
  const out: ProductMediaOption[] = [];

  const segments = (await ws.collection("recordingSegments").list({ where: [["appId", "==", appId]], orderBy: { field: "startSec", dir: "asc" }, limit: 300 })).items as RecordingSegment[];
  for (const s of segments) {
    const rec = byId.get(s.assetId);
    if (!rec) continue;
    out.push({
      ref: s.id,
      kind: "recording_segment",
      assetId: s.assetId,
      title: `${s.label}${s.privacy.flagged ? " (personal info: blurred)" : ""}`,
      featureIds: s.featureIds,
      trim: { inSec: s.startSec, outSec: s.endSec },
      deviceFrameOk: true,
      quality: s.quality,
    });
  }

  for (const a of assets) {
    const features = featuresByAsset.get(a.id) ?? featuresByAsset.get(a.derivedFromAssetId ?? "") ?? [];
    const kind = optionKind(a);
    if (!kind) continue;
    out.push({
      ref: a.id,
      kind,
      assetId: a.id,
      title: a.title ?? a.originalFilename ?? a.role,
      featureIds: features,
      deviceFrameOk: kind !== "marketing_screenshot",
      ...(a.durationSec && kind === "app_recording" ? { trim: { inSec: 0, outSec: a.durationSec } } : {}),
    });
  }
  return out;
}

function optionKind(a: MediaAsset): ProductMediaOption["kind"] | null {
  if (a.role === "screenshot" && a.isProductTruth) {
    if (a.sourceLabel === "sam_ui_crop") return "ui_crop";
    return a.screenshotKind === "marketing" ? "marketing_screenshot" : "raw_screenshot";
  }
  if (a.role === "app_recording" && a.isProductTruth) return "app_recording";
  if (a.role === "founder_clip") return "founder_clip";
  if (a.role === "logo") return "logo";
  if (a.role === "icon") return "icon";
  return null;
}
