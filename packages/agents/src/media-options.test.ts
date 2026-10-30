import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { loadAppContext } from "./context";
import { handlers } from "./index";
import { productMediaOptions } from "./media-options";
import { seedApp } from "./testing";

describe("productMediaOptions", () => {
  it("lists walkthrough segments first, keeps marketing screenshots out of device frames and prefers their SAM cut-outs", async () => {
    const p = createTestPlatform({}, handlers);
    const wid = "ws_media_opts";
    const seed = await seedApp(p, wid);
    const ws = p.db.ws(wid);
    const [shot] = seed.screenshotIds;
    await ws.collection("mediaAssets").update(shot!, { screenshotKind: "marketing" }, { actor: "t" });
    const orig = await ws.collection("mediaAssets").getOrThrow(shot!);
    const crop = await ws.collection("mediaAssets").create(
      { appId: seed.appId, kind: "image", role: "screenshot", origin: "derived", storagePath: `${orig.storagePath}.crop.png`, mimeType: "image/png", status: "ready", title: "timer-screen (app screen, cut out by SAM 3.1)", isProductTruth: true, sourceLabel: "sam_ui_crop", derivedFromAssetId: shot!, screenshotKind: "raw_ui" },
      { actor: "t" },
    );
    const rec = await ws.collection("mediaAssets").create(
      { appId: seed.appId, kind: "video", role: "app_recording", origin: "upload", storagePath: `workspaces/${wid}/apps/${seed.appId}/walkthrough.mp4`, mimeType: "video/mp4", status: "ready", title: "Walkthrough", isProductTruth: true, durationSec: 120 },
      { actor: "t" },
    );
    await ws.collection("recordingSegments").create({ appId: seed.appId, assetId: rec.id, startSec: 42, endSec: 51, label: "Starts a 25-minute focus session", action: "tap", featureIds: ["feat_timer"], quality: 0.9 }, { actor: "t" });
    await ws.collection("recordingSegments").create({ appId: seed.appId, assetId: rec.id, startSec: 3, endSec: 9, label: "Opens weekly report", featureIds: ["feat_reports"], privacy: { flagged: true, regions: [{ x: 0, y: 0, w: 1, h: 0.1 }] } }, { actor: "t" });
    // Left out: too low quality (lock screen), and personal info with nothing to blur.
    await ws.collection("recordingSegments").create({ appId: seed.appId, assetId: rec.id, startSec: 0, endSec: 3, label: "Unlocks the phone", quality: 0.1 }, { actor: "t" });
    await ws.collection("recordingSegments").create({ appId: seed.appId, assetId: rec.id, startSec: 60, endSec: 64, label: "Inbox with real emails", quality: 0.9, privacy: { flagged: true, notes: "Email addresses", regions: [] } }, { actor: "t" });

    const ctx = await loadAppContext(ws, seed.appId);
    const opts = await productMediaOptions(ws, seed.appId, ctx.dna);
    expect(opts.filter((o) => o.kind === "recording_segment").map((o) => [o.kind, o.trim?.inSec])).toEqual([
      ["recording_segment", 3],
      ["recording_segment", 42],
    ]);
    expect(opts.slice(0, 2).every((o) => o.kind === "recording_segment")).toBe(true);
    expect(opts[0]!.title).toContain("personal info");
    const byRef = new Map(opts.map((o) => [o.ref, o]));
    expect(byRef.get(shot!)).toMatchObject({ kind: "marketing_screenshot", deviceFrameOk: false });
    expect(byRef.get(crop.id)).toMatchObject({ kind: "ui_crop", deviceFrameOk: true });
    expect(byRef.get(rec.id)).toMatchObject({ kind: "app_recording", trim: { inSec: 0, outSec: 120 } });
    // Cut-outs inherit the original's App DNA features.
    expect(byRef.get(crop.id)!.featureIds).toEqual(byRef.get(shot!)!.featureIds);
  });
});
