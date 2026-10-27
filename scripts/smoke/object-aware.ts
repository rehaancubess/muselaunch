/**
 * Object-aware render smoke: presenter fixture (SAM-style tracks + cutouts) → presenter-depth,
 * product-in-hand and object-spotlight scenes → HyperFrames MP4 → frames for review.
 *
 *   RENDER_CHROME_PATH=... npx tsx scripts/smoke/object-aware.ts [--scale 0.5] [--times 1.5,4.5,7.5]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFromStoryboard, compileToHtml, describeForLLM, lintDoc } from "../../packages/compositions/src/index";
import { ensureNodeCompileRuntime } from "../../packages/compositions/src/node";
import { presenterAnalysis, presenterAssets, presenterSegmentations, presenterStoryboard, presenterTracks, PRESENTER_FILES } from "../../packages/render/src/presenter-sample";
import { ffmpegBin, renderProject } from "../../packages/render/src/producer";
import { SAMPLE_FIXTURE_FILES, sampleApp, sampleAssets, sampleBrand } from "../../packages/render/src/sample";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : d;
};

async function main() {
  ensureNodeCompileRuntime();
  const wid = "ws_smoke";
  const pdir = join(root, "fixtures/render/presenter");
  const tracks = presenterTracks(pdir);
  const assets = [...sampleAssets(wid, undefined, (id, f) => `workspaces/${wid}/f/${f}`), ...presenterAssets(wid, "app_focusly", (id, f) => `workspaces/${wid}/f/${f}`)];
  const segs = presenterSegmentations(wid, "app_focusly");
  const analysis = presenterAnalysis(wid, "app_focusly", tracks);
  const doc = buildFromStoryboard({ storyboard: presenterStoryboard(wid), app: sampleApp(wid), brand: sampleBrand(wid), assets, segmentations: segs, clipAnalyses: [analysis] });
  const tracksBySeg = { seg_person: tracks.person, seg_phone: tracks.phone };
  for (const i of lintDoc(doc, { assets: Object.fromEntries(assets.map((a) => [a.id, a])), segmentations: Object.fromEntries(segs.map((s) => [s.id, s])), tracks: tracksBySeg })) console.log(`lint ${i.level}: ${i.layerId ?? i.sceneId ?? ""} ${i.message}`);
  const out = join(root, "fixtures/render/out/object-aware");
  mkdirSync(join(out, "assets"), { recursive: true });
  const ext: Record<string, string> = {};
  for (const [id, f] of Object.entries(PRESENTER_FILES)) {
    if (f.kind === "json") continue;
    ext[id] = `assets/${f.file}`;
    copyFileSync(join(pdir, f.file), join(out, ext[id]!));
  }
  for (const [id, f] of Object.entries(SAMPLE_FIXTURE_FILES)) {
    ext[id] = `assets/${f.file}`;
    copyFileSync(join(root, "fixtures/render", f.file), join(out, ext[id]!));
  }
  const scale = Number(arg("scale", "0.5"));
  const compiled = compileToHtml(doc, {
    assetUrl: (id) => ext[id] ?? `assets/${id}`,
    mode: "render",
    gsapSource: "inline",
    scale,
    segmentations: Object.fromEntries(segs.map((s) => [s.id, s])),
    tracks: tracksBySeg,
    assetKinds: Object.fromEntries(assets.map((a) => [a.id, a.kind])),
    assetHasAudio: Object.fromEntries(assets.filter((a) => a.hasAudio !== undefined).map((a) => [a.id, a.hasAudio!])),
  });
  writeFileSync(join(out, "index.html"), compiled.html);
  writeFileSync(join(out, "doc.json"), JSON.stringify(doc, null, 2));
  writeFileSync(join(out, "describe.txt"), describeForLLM(doc, { clipAnalyses: [analysis] }));
  console.log("scenes", compiled.scenes, "assets", compiled.assetIds);
  const t0 = Date.now();
  await renderProject({ projectDir: out, outputPath: join(out, "video.mp4"), fps: 30, quality: scale < 1 ? "draft" : "high", onProgress: (p) => void process.stdout.write(`\r${p}%   `) });
  console.log(`\nrendered in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const times = arg("times", compiled.scenes.map((s) => (s.start + (s.end - s.start) * 0.7).toFixed(2)).join(","));
  const frames: string[] = [];
  for (const t of times.split(",")) {
    const f = join(out, `frame-${t}.png`);
    execFileSync(ffmpegBin(), ["-y", "-loglevel", "error", "-ss", t, "-i", join(out, "video.mp4"), "-frames:v", "1", "-update", "1", f]);
    frames.push(f);
  }
  const inputs = frames.flatMap((f) => ["-i", f]);
  const filt = frames.map((_, i) => `[${i}]scale=360:-1[f${i}]`).join(";") + ";" + frames.map((_, i) => `[f${i}]`).join("") + `hstack=${frames.length}`;
  execFileSync(ffmpegBin(), ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filt, "-frames:v", "1", "-update", "1", join(out, "sheet.png")]);
  console.log("sheet:", join(out, "sheet.png"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
