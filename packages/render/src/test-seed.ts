/** Test helper: seed a workspace with the Focusly fixture app, real fixture screenshots and a storyboard. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Platform } from "@muselaunch/platform";
import { workspaceKey } from "@muselaunch/platform";
import { SAMPLE_FIXTURE_FILES, sampleApp, sampleAssets, sampleBrand, sampleStoryboard } from "./sample";

export const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/render/", import.meta.url));

export async function seedSample(p: Platform, wid: string, opts: { scenes?: 3 | 5 } = {}) {
  const ws = p.db.ws(wid);
  const app = sampleApp(wid);
  const { id: _a, workspaceId: _w, createdAt: _c, updatedAt: _u, createdBy: _b, ...appInput } = app;
  await ws.collection("apps").createIfAbsent({ id: app.id, ...appInput, brandProfileId: app.id }, { actor: "fixture" });
  const brand = sampleBrand(wid);
  const { id: _bi, workspaceId: _bw, createdAt: _bc, updatedAt: _bu, createdBy: _bb, ...brandInput } = brand;
  await ws.collection("brandProfiles").createIfAbsent({ id: app.id, ...brandInput }, { actor: "fixture" });
  for (const a of sampleAssets(wid, app.id, (id, file) => workspaceKey(wid, "uploads", id, file))) {
    const f = SAMPLE_FIXTURE_FILES[a.id as keyof typeof SAMPLE_FIXTURE_FILES];
    const put = await p.storage.put(a.storagePath, readFileSync(join(FIXTURES_DIR, f.file)), { contentType: f.mime });
    const { id, workspaceId: _x, createdAt: _y, updatedAt: _z, createdBy: _q, ...rest } = a;
    await ws.collection("mediaAssets").createIfAbsent({ id, ...rest, bytes: put.bytes, sha256: put.sha256 }, { actor: "fixture" });
  }
  await ws.collection("campaigns").createIfAbsent({ id: "cpg_sample", appId: app.id, name: "Mornings launch", goal: "launch", channels: ["instagram", "tiktok"] }, { actor: "fixture" });
  await ws.collection("campaignVariants").createIfAbsent(
    {
      id: "var_sample",
      appId: app.id,
      campaignId: "cpg_sample",
      title: "Mornings",
      angleType: "practical_demo",
      hook: "Your mornings deserve better",
      audience: "Busy indie makers",
      keyMessage: "Plan in focus blocks",
      rationale: "fixture",
      hypothesis: "fixture",
      successMetric: { metric: "installs" },
      status: "selected",
    },
    { actor: "fixture" },
  );
  const sb = sampleStoryboard(wid, { scenes: opts.scenes ?? 3 });
  const { id: sbId, workspaceId: _sw, createdAt: _sc, updatedAt: _su, createdBy: _sbb, ...sbInput } = sb;
  await ws.collection("storyboards").createIfAbsent({ id: sbId, ...sbInput }, { actor: "fixture" });
  return { appId: app.id, storyboardId: sbId, campaignId: "cpg_sample", variantId: "var_sample" };
}
