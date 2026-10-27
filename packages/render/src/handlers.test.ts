import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { handlers } from "./handlers";
import { seedSample } from "./test-seed";

/**
 * Fast handler tests (no Chrome): build, idempotency, variants, export guard, tenancy.
 * `render.preview` is deliberately not registered here, so chained preview jobs fail fast;
 * the real render path is covered by render.render.test.ts.
 */
describe("render module handlers (no rendering)", () => {
  const { "render.preview": _skip, "render.final": _skip2, ...noRender } = handlers;
  const p = createTestPlatform({}, noRender);
  const wid = "ws_handlers";

  it("composition.build creates an editable composition from the storyboard, links the variant and queues a preview", async () => {
    const seed = await seedSample(p, wid, { scenes: 5 });
    const job = await p.jobs.create(wid, "composition.build", { appId: seed.appId, storyboardId: seed.storyboardId, compositionId: "cmp_sbd_sample" }, { actor: "u1", idempotencyKey: "build:1" });
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job.id);
    expect(done?.status).toBe("succeeded");
    const comp = await p.db.ws(wid).collection("compositions").getOrThrow("cmp_sbd_sample");
    expect(comp).toMatchObject({ appId: seed.appId, storyboardId: seed.storyboardId, campaignId: seed.campaignId, variantId: seed.variantId, currentVersion: 1, kind: "video", aspectRatio: "9:16" });
    const v1 = await p.db.ws(wid).collection("compositionVersions").getOrThrow("cmp_sbd_sample_v1");
    expect(v1.doc.scenes.map((s) => s.template)).toEqual(["hook-title", "device-demo", "feature-callout", "cta-endcard"]);
    expect(Object.keys(v1.sceneHashes)).toHaveLength(4);
    const variant = await p.db.ws(wid).collection("campaignVariants").getOrThrow(seed.variantId);
    expect(variant.compositionIds).toEqual(["cmp_sbd_sample"]);
    expect(variant.status).toBe("produced");
    expect(done?.output?.data?.previewJobId).toBeTruthy();
    const preview = await p.jobs.get(wid, done!.output!.data!.previewJobId as string);
    expect(preview?.type).toBe("render.preview");
    expect(preview?.payload).toMatchObject({ compositionId: "cmp_sbd_sample", version: 1 });

    // Rerun (e.g. redelivery) is idempotent: same composition, no second version, variant not duplicated.
    const again = await p.jobs.create(wid, "composition.build", { appId: seed.appId, storyboardId: seed.storyboardId, compositionId: "cmp_sbd_sample" }, { actor: "u1", idempotencyKey: "build:2" });
    await p.inline!.drain();
    expect((await p.jobs.get(wid, again.id))?.status).toBe("succeeded");
    expect((await p.db.ws(wid).collection("compositions").getOrThrow("cmp_sbd_sample")).latestVersion).toBe(1);
    expect((await p.db.ws(wid).collection("campaignVariants").getOrThrow(seed.variantId)).compositionIds).toEqual(["cmp_sbd_sample"]);
  });

  it("composition.variants re-lays out to other aspect ratios, carrying edits by id", async () => {
    const { applyPatch } = await import("@muselaunch/compositions");
    const { commitVersion, getVersion } = await import("@muselaunch/compositions/store");
    const ws = p.db.ws(wid);
    const cur = await getVersion(ws, "cmp_sbd_sample");
    const edited = applyPatch(cur.doc, [{ op: "update_layer", sceneId: "sc_s2", layerId: "sc_s2_headline", set: { text: "Edited headline survives" } }]);
    await commitVersion(ws, "cmp_sbd_sample", { baseVersion: 1, doc: edited.doc, source: "user_edit", summary: "edit" }, "u1");
    const job = await p.jobs.create(wid, "composition.variants", { appId: "app_focusly", compositionId: "cmp_sbd_sample", mode: "aspect", targets: ["16:9", "1:1"] }, { actor: "u1" });
    await p.inline!.drain();
    expect((await p.jobs.get(wid, job.id))?.status).toBe("succeeded");
    for (const [id, ar, w, h] of [
      ["cmp_sbd_sample_16x9", "16:9", 1920, 1080],
      ["cmp_sbd_sample_1x1", "1:1", 1080, 1080],
    ] as const) {
      const c = await ws.collection("compositions").getOrThrow(id);
      expect(c.derivedFromCompositionId).toBe("cmp_sbd_sample");
      const v = await getVersion(ws, id);
      expect(v.doc).toMatchObject({ aspectRatio: ar, width: w, height: h });
      const head = v.doc.scenes[1]!.layers.find((l) => l.id === "sc_s2_headline");
      expect(head?.type === "text" && head.text).toBe("Edited headline survives");
    }
  });

  it("package.export refuses to export without final renders (no fake files)", async () => {
    const job = await p.jobs.create(wid, "package.export", { appId: "app_focusly", campaignId: "cpg_sample", compositionIds: [], includeCopy: true }, { actor: "u1" });
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job.id);
    expect(done?.status).toBe("failed");
    expect(done?.error?.code).toBe("VALIDATION_FAILED");
    expect(done?.error?.message).toMatch(/No final renders/);
  });

  it("is tenant-scoped: another workspace cannot build from this storyboard", async () => {
    const job = await p.jobs.create("ws_other", "composition.build", { appId: "app_focusly", storyboardId: "sbd_sample", compositionId: "cmp_x" }, { actor: "u2" });
    await p.inline!.drain();
    const done = await p.jobs.get("ws_other", job.id);
    expect(done?.status).toBe("failed");
    expect(done?.error?.code).toBe("NOT_FOUND");
    expect(await p.db.ws("ws_other").collection("compositions").get("cmp_x")).toBeNull();
  });

  it("composition.variants hooks: N copies, each with an auto-applied composition.edit scoped to the opening scene + clip context", async () => {
    const { seedPresenter } = await import("./test-seed");
    const seed = await seedPresenter(p, wid);
    await p.jobs.create(wid, "composition.build", { appId: seed.appId, storyboardId: seed.presenterStoryboardId, compositionId: "cmp_founder" }, { actor: "u1", idempotencyKey: "bf" });
    await p.inline!.drain();
    const job = await p.jobs.create(wid, "composition.variants", { appId: seed.appId, compositionId: "cmp_founder", mode: "hooks", targets: ["3"] }, { actor: "u1", idempotencyKey: "hooks" });
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job.id);
    expect(done?.status).toBe("succeeded");
    const hooks = done!.output!.data!.hooks as { compositionId: string; brief: string; patchId: string; jobId: string }[];
    expect(hooks).toHaveLength(3);
    expect(new Set(hooks.map((h) => h.brief)).size).toBe(3);
    for (const h of hooks) {
      const c = await p.db.ws(wid).collection("compositions").getOrThrow(h.compositionId);
      expect(c.derivedFromCompositionId).toBe("cmp_founder");
      expect(h.compositionId).toMatch(/^cmp_founder_hook_/);
      const edit = await p.jobs.get(wid, h.jobId);
      expect(edit?.type).toBe("composition.edit");
      expect(edit?.payload).toMatchObject({ compositionId: h.compositionId, baseVersion: 1, sceneIds: ["sc_p1"], patchId: h.patchId, autoApply: true, clipAnalysisIds: [seed.clipAnalysisId] });
      expect(String(edit?.payload.instruction)).toContain(h.brief);
      const patch = await p.db.ws(wid).collection("compositionPatches").getOrThrow(h.patchId);
      expect(patch).toMatchObject({ status: "proposed", source: "ai", affectedSceneIds: ["sc_p1"] });
    }
    // idempotent: same request → same compositions
    const again = await p.jobs.create(wid, "composition.variants", { appId: seed.appId, compositionId: "cmp_founder", mode: "hooks", targets: ["3"] }, { actor: "u1", idempotencyKey: "hooks2" });
    await p.inline!.drain();
    expect(((await p.jobs.get(wid, again.id))!.output!.data!.hooks as { compositionId: string }[]).map((h) => h.compositionId)).toEqual(hooks.map((h) => h.compositionId));
  });
});
