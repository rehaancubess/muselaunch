/**
 * Test helpers for Spark's video review: a real (tiny) MP4 made with FFmpeg's built-in test sources,
 * stored as the final render of a seeded composition. FIXTURES ONLY — never used by product code.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompositionDoc } from "@muselaunch/contracts";
import { docHash, themeFromBrand, validateDoc } from "@muselaunch/compositions";
import { createComposition } from "@muselaunch/compositions/store";
import { workspaceKey, type Platform } from "@muselaunch/platform";
import { renderAssetId, resolveFfmpegBinaries } from "@muselaunch/render";

export interface TestSegment {
  /** pattern = FFmpeg testsrc (busy image), pattern2 = testsrc2, black/flat = one colour. */
  kind: "pattern" | "pattern2" | "black" | "flat";
  durationSec: number;
}

/** Encode segments back to back into an MP4 (MPEG-4 Part 2: available in every FFmpeg build). */
export async function makeTestVideo(out: string, segments: TestSegment[], size: { width: number; height: number } = { width: 270, height: 480 }): Promise<void> {
  const ffmpeg = resolveFfmpegBinaries().ffmpeg ?? "ffmpeg";
  const s = `${size.width}x${size.height}`;
  const inputs = segments.flatMap((g) => {
    const src = g.kind === "pattern" ? `testsrc=s=${s}:r=30:d=${g.durationSec}` : g.kind === "pattern2" ? `testsrc2=s=${s}:r=30:d=${g.durationSec}` : `color=c=${g.kind === "black" ? "black" : "0x5C46DC"}:s=${s}:r=30:d=${g.durationSec}`;
    return ["-f", "lavfi", "-i", src];
  });
  const concat = `${segments.map((_, i) => `[${i}:v]`).join("")}concat=n=${segments.length}:v=1[v]`;
  await new Promise<void>((resolve, reject) =>
    execFile(ffmpeg, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", concat, "-map", "[v]", "-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p", out], { timeout: 60_000 }, (err, _o, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve())),
  );
}

/** Hook (16 words in 2 s), Demo (device with a real screenshot, 3 s), CTA (2 s). */
export function reviewTestDoc(theme: CompositionDoc["theme"], shotId: string, opts: { hook?: string } = {}): CompositionDoc {
  const v = validateDoc({
    schemaVersion: 1,
    title: "Focus launch",
    kind: "video",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    theme,
    scenes: [
      { id: "sc_hook", name: "Hook", template: "hook-title", purpose: "hook", durationSec: 2, layers: [{ id: "ly_hook", type: "text", role: "headline", text: opts.hook ?? "Stop losing whole evenings to your phone and finally finish the revision you planned for today", box: { x: 0.08, y: 0.38, w: 0.84, h: 0.2 } }] },
      {
        id: "sc_demo",
        name: "Demo",
        template: "device-demo",
        purpose: "demo",
        durationSec: 3,
        layers: [
          { id: "ly_demo_head", type: "text", role: "headline", text: "Block distracting apps", box: { x: 0.08, y: 0.1, w: 0.84, h: 0.14 } },
          { id: "ly_demo_device", type: "device", screenAssetId: shotId, box: { x: 0.22, y: 0.28, w: 0.56, h: 0.56 } },
        ],
      },
      { id: "sc_cta", name: "CTA", template: "cta-endcard", purpose: "cta", durationSec: 2, layers: [{ id: "ly_cta", type: "text", role: "cta", text: "Start your first focus session", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 } }] },
    ],
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.doc;
}

/**
 * A composition (v1) whose final render is a real MP4: hook = test pattern, demo = BLACK (a broken
 * scene for the measurements to catch), CTA = second test pattern. Stored like render.final stores it.
 */
export async function seedRenderedVideo(
  p: Platform,
  workspaceId: string,
  input: { appId: string; screenshotId: string; segments?: TestSegment[]; quality?: "final" | "preview"; hook?: string },
): Promise<{ compositionId: string; doc: CompositionDoc; renderAssetId: string }> {
  const ws = p.db.ws(workspaceId);
  const brand = await ws.collection("brandProfiles").get(input.appId);
  const doc = reviewTestDoc(themeFromBrand(brand), input.screenshotId, { hook: input.hook });
  const { composition } = await createComposition(ws, { appId: input.appId, title: "Focus launch", doc }, "seed");
  const quality = input.quality ?? "final";
  const id = renderAssetId(docHash(doc), quality, "mp4");
  const dir = await mkdtemp(join(tmpdir(), "ml-vreview-test-"));
  try {
    const file = join(dir, "render.mp4");
    await makeTestVideo(file, input.segments ?? [{ kind: "pattern", durationSec: 2 }, { kind: "black", durationSec: 3 }, { kind: "pattern2", durationSec: 2 }]);
    const key = workspaceKey(workspaceId, "renders", composition.id, `v1-${quality}.mp4`);
    const { bytes } = await p.storage.uploadFile(file, key, { contentType: "video/mp4" });
    await ws.collection("mediaAssets").create(
      { id, appId: input.appId, kind: "video", role: quality === "final" ? "render" : "preview", origin: "render", storagePath: key, mimeType: "video/mp4", bytes, width: 270, height: 480, durationSec: 7, status: "ready", title: "Focus launch (test render)", labels: [`doc:${docHash(doc).slice(0, 40)}`, "9:16"], isProductTruth: false, license: { type: "owned" }, render: { compositionId: composition.id, version: 1, quality } },
      { actor: "seed" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { compositionId: composition.id, doc, renderAssetId: id };
}
