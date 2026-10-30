/**
 * Render smoke test: storyboard (fixture app "Focusly") → CompositionDoc → HyperFrames HTML →
 * real MP4 via @hyperframes/producer, then extract frames for visual review.
 *
 *   RENDER_CHROME_PATH=/path/to/chrome-headless-shell npx tsx scripts/smoke/render.ts [--aspect 9:16] [--scenes 5] [--times 1,4,8]
 *   … --long   ~40 s editor-style cut (kinetic type, icon reveal, phone tilt, focus zoom, tap, store CTA)
 *
 * Output: fixtures/render/out/<aspect>/{index.html,video.mp4,frame-<t>.png}
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AspectRatio } from "@muselaunch/contracts";
import { buildFromStoryboard, compileToHtml, lintDoc } from "../../packages/compositions/src/index";
import { ensureNodeCompileRuntime } from "../../packages/compositions/src/node";
import { ffmpegBin, renderProject } from "../../packages/render/src/producer";
import { SAMPLE_FIXTURE_FILES, sampleApp, sampleAssets, sampleBrand, sampleLongStoryboard, sampleStoryboard } from "../../packages/render/src/sample";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const aspect = arg("aspect", "9:16") as AspectRatio;
const scenes = Number(arg("scenes", "3")) as 3 | 5;
const quality = arg("quality", "draft") as "draft" | "standard" | "high";
const scale = Number(arg("scale", "1"));

async function main() {
  ensureNodeCompileRuntime();
  const wid = "ws_smoke";
  const assets = sampleAssets(wid, undefined, (id, file) => `workspaces/${wid}/fixtures/${file}`);
  const long = process.argv.includes("--long");
  const storyboard = long ? sampleLongStoryboard(wid) : sampleStoryboard(wid, { scenes });
  const doc = buildFromStoryboard({ storyboard, app: sampleApp(wid), brand: sampleBrand(wid), assets, aspectRatio: aspect });
  const issues = lintDoc(doc, { assets: Object.fromEntries(assets.map((a) => [a.id, a])) });
  for (const i of issues) console.log(`lint ${i.level}: ${i.sceneId ?? ""} ${i.layerId ?? ""} ${i.message}`);
  const out = join(root, "fixtures/render/out", `${aspect.replace(":", "x")}${long ? "-long" : ""}`);
  mkdirSync(join(out, "assets"), { recursive: true });
  for (const [id, f] of Object.entries(SAMPLE_FIXTURE_FILES)) copyFileSync(join(root, "fixtures/render", f.file), join(out, "assets", `${id}.png`));
  const { html, durationSec, scenes: times } = compileToHtml(doc, { assetUrl: (id) => `assets/${id}.png`, mode: "render", gsapSource: "inline", scale });
  writeFileSync(join(out, "index.html"), html);
  writeFileSync(join(out, "doc.json"), JSON.stringify(doc, null, 2));
  console.log(`compiled ${durationSec}s, scenes:`, times);
  const t0 = Date.now();
  await renderProject({ projectDir: out, outputPath: join(out, "video.mp4"), fps: 30, quality, onProgress: (p, m) => void process.stdout.write(`\r${p}% ${m.slice(0, 60)}`.padEnd(80)) });
  console.log(`\nrendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height,codec_name", "-of", "json", join(out, "video.mp4")]).toString();
  console.log(probe);
  const ts = arg("times", times.map((s) => (s.start + Math.min(2.2, (s.end - s.start) * 0.75)).toFixed(2)).join(","));
  for (const t of ts.split(",")) {
    execFileSync(ffmpegBin(), ["-y", "-loglevel", "error", "-ss", t, "-i", join(out, "video.mp4"), "-frames:v", "1", join(out, `frame-${t}.png`)]);
  }
  console.log("frames:", ts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
