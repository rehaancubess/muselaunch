/**
 * LAYOUT FIXTURE (not product output): renders the render module's sample storyboard as real still
 * slides (HyperFrames → PNG), to review the web's still views. Writes PNGs + the doc + preview HTML.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFromStoryboard, compileToHtml, collectAssetRefs } from "@muselaunch/compositions";
import { ensureNodeCompileRuntime } from "@muselaunch/compositions/node";
import { createComposition } from "@muselaunch/compositions/store";
import { createTestPlatform } from "@muselaunch/platform";
import { handlers } from "@muselaunch/render";
import { seedSample } from "../packages/render/src/test-seed";

const OUT = process.argv[2]!;
mkdirSync(OUT, { recursive: true });
const p = createTestPlatform({}, handlers);
const wid = "ws_harness";
const seed = await seedSample(p, wid, { scenes: 5 });
await p.credits.grant(wid, 100, { reason: "harness", idempotencyKey: "grant:h", actor: "system" });
const ws = p.db.ws(wid);
const sb = await ws.collection("storyboards").getOrThrow(seed.storyboardId);
const app = await ws.collection("apps").getOrThrow(seed.appId);
const brand = await ws.collection("brandProfiles").get(seed.appId);
const assets = (await ws.collection("mediaAssets").list({ where: [["appId", "==", seed.appId]], limit: 50 })).items;
for (const [name, ar] of [["carousel", "4:5"], ["store", "9:19.5"]] as const) {
  const doc = buildFromStoryboard({ storyboard: sb, app, brand, assets, aspectRatio: ar, kind: "carousel" });
  await createComposition(ws, { id: `cmp_${name}`, appId: seed.appId, campaignId: seed.campaignId, title: name, doc }, "u1");
  const job = await p.jobs.create(wid, "render.final", { appId: seed.appId, compositionId: `cmp_${name}`, version: 1, format: "png" }, { actor: "u1", idempotencyKey: `r-${name}`, credits: { operation: "render.final", amount: 2 } });
  await p.inline!.drain();
  const done = await p.jobs.get(wid, job.id);
  if (done?.status !== "succeeded") throw new Error(JSON.stringify(done?.error));
  for (const [i, ref] of done.output!.refs.entries()) {
    const a = await ws.collection("mediaAssets").getOrThrow(ref.id);
    await p.storage.downloadToFile(a.storagePath, join(OUT, `${name}-${i + 1}.png`));
  }
  writeFileSync(join(OUT, `${name}-doc.json`), JSON.stringify(doc));
  ensureNodeCompileRuntime();
  const refs = collectAssetRefs(doc);
  const urls: Record<string, string> = {};
  for (const id of refs.assetIds) {
    const a = assets.find((x) => x.id === id);
    if (a) urls[id] = `data:${a.mimeType};base64,${Buffer.from(await p.storage.get(a.storagePath)).toString("base64")}`;
  }
  const { html, durationSec, scenes } = compileToHtml(doc, { assetUrl: (id) => urls[id] ?? "data:,", mode: "preview", gsapSource: "inline", assetKinds: Object.fromEntries(assets.map((a) => [a.id, a.kind])) });
  writeFileSync(join(OUT, `${name}-preview.json`), JSON.stringify({ html, durationSec, scenes, width: doc.width, height: doc.height }));
  console.log(name, done.output!.refs.length, "slides", doc.width, doc.height);
}
process.exit(0);
