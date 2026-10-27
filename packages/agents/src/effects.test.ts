import type { CompositionDoc } from "@muselaunch/contracts";
import { sceneHash, validateDoc } from "@muselaunch/compositions";
import { createComposition, getVersion } from "@muselaunch/compositions/store";
import { createTestPlatform, type JobContext } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { multiVersionIntent } from "./edit";
import { handlers } from "./index";
import { installFakeMeta, jsonRoute, requestText, schemaName, seedApp, type MetaRequest, type MetaRoute } from "./testing";

/** Sequence of structured responses for one schema name (fixtures built per request). */
function seq(name: string, bodies: ((req: MetaRequest) => unknown)[]): MetaRoute & { calls: number } {
  const r = ((req: MetaRequest) => {
    if (schemaName(req) !== name) return undefined;
    const body = bodies[Math.min(r.calls, bodies.length - 1)]!(req);
    r.calls++;
    return jsonRoute(name, () => body)(req, 0);
  }) as unknown as MetaRoute & { calls: number };
  r.calls = 0;
  return r;
}

const claimsOk = jsonRoute("ClaimValidation", (req) => ({ results: requestText(req).split("\n").filter((l) => l.startsWith('{"id":')).map((l) => ({ id: JSON.parse(l).id, issues: [] })) }));
const briefs = jsonRoute("VariantBriefs", () => ({
  variants: [
    { label: "Problem", brief: "Open on the late-night scroll, then the one-tap focus session." },
    { label: "Curiosity", brief: "What if your phone defended your focus for you?" },
    { label: "Demo-first", brief: "Start inside the app: tap start and watch distractions disappear." },
  ],
}));

async function setup(routes: MetaRoute[]) {
  const variantsJobs: { mode: string; targets: string[] }[] = [];
  const p = createTestPlatform({ META_API_KEY: "test-key" }, {
    ...handlers,
    // Module C's composition.variants: stub records the hand-off.
    "composition.variants": async (ctx: JobContext<"composition.variants">) => {
      variantsJobs.push({ mode: ctx.payload.mode, targets: ctx.payload.targets });
      return { creditsUsed: 0 };
    },
  });
  const wid = "ws_effects";
  await p.credits.ensureAccount(wid, { grant: 500, reason: "test" });
  const seed = await seedApp(p, wid);
  const ws = p.db.ws(wid);
  // A real presenter clip analysed by SAM (person + phone tracks) + Muse Voice transcript (fixtures).
  const clipAsset = await ws.collection("mediaAssets").create({ appId: seed.appId, kind: "video", role: "founder_clip", origin: "upload", storagePath: `workspaces/${wid}/uploads/clip.mp4`, mimeType: "video/mp4", status: "ready", durationSec: 9, title: "Founder demo clip" }, { actor: "u1" });
  const seg = await ws.collection("segmentations").create({ appId: seed.appId, sourceAssetId: clipAsset.id, prompt: "person, phone", status: "succeeded", mediaType: "video", objects: [{ objectId: "1", label: "person" }, { objectId: "2", label: "phone" }] }, { actor: "u1" });
  const transcript = await ws.collection("transcripts").create({ appId: seed.appId, sourceAssetId: clipAsset.id, purpose: "founder_brief", status: "succeeded", text: "This is how I find anything in Tidy Timer: search your sessions in one tap." }, { actor: "u1" });
  const clip = await ws.collection("clipAnalyses").create(
    {
      appId: seed.appId,
      sourceAssetId: clipAsset.id,
      status: "succeeded",
      prompts: ["person", "phone"],
      segmentationIds: { person: seg.id, phone: seg.id },
      transcriptId: transcript.id,
      durationSec: 9,
      objects: [
        { key: "person", label: "person", segmentationId: seg.id, objectId: "1", trackingQuality: 0.93, presence: [{ startSec: 0, endSec: 9 }], meanBbox: { x: 0.2, y: 0.1, w: 0.5, h: 0.85 } },
        { key: "phone", label: "phone", segmentationId: seg.id, objectId: "2", trackingQuality: 0.81, presence: [{ startSec: 1.5, endSec: 8 }], meanBbox: { x: 0.55, y: 0.5, w: 0.18, h: 0.3 } },
      ],
    },
    { actor: "u1" },
  );
  const v = validateDoc({
    schemaVersion: 1,
    title: "Founder demo",
    kind: "video",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#5C46DC" },
    scenes: [
      { id: "sc_hook", name: "Hook", template: "hook-title", purpose: "hook", durationSec: 2, layers: [{ id: "ly_hook_title", type: "text", role: "headline", text: "Find anything fast", box: { x: 0.08, y: 0.38, w: 0.84, h: 0.2 } }] },
      {
        id: "sc_clip",
        name: "Presenter",
        template: "founder-cutout",
        purpose: "founder",
        durationSec: 6,
        layers: [
          { id: "ly_demo_device", type: "device", screenAssetId: seed.screenshotIds[0], box: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, timing: { start: 0 } },
          { id: "ly_clip", type: "video", assetId: clipAsset.id, box: { x: 0, y: 0, w: 1, h: 1, z: 5 } },
        ],
      },
      { id: "sc_cta", name: "CTA", template: "cta-endcard", purpose: "cta", durationSec: 2, layers: [{ id: "ly_cta_text", type: "text", role: "cta", text: "Start your first focus session", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 } }] },
    ],
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  const { composition } = await createComposition(ws, { appId: seed.appId, title: "Founder demo", doc: v.doc }, "u1");
  const meta = installFakeMeta(p, [...routes, claimsOk, briefs]);
  return { p, wid, ws, seed, clip, seg, composition, doc: v.doc as CompositionDoc, meta, variantsJobs };
}

/** Effects director fixture: first proposal targets an object that isn't in the clip; the repair uses the real tracks. */
const effectsRoute = (segId: () => string) =>
  seq("CompositionEdit", [
    () => ({ summary: "Spotlight the phone", targetSceneIds: ["sc_clip"], ops: [{ op: "add_layer", sceneId: "sc_clip", layer: { id: "ly_spot", type: "effect", effect: "spotlight", target: { segmentationId: segId(), objectId: "9" }, box: { x: 0, y: 0, w: 1, h: 1, z: 6 } } }] }),
    () => ({
      summary: "Presenter in front of the demo, phone spotlighted with an anchored search callout",
      targetSceneIds: ["sc_clip"],
      ops: [
        { op: "update_layer", sceneId: "sc_clip", layerId: "ly_clip", set: { mask: { segmentationId: segId(), mode: "cutout", objectIds: ["1"], fallback: "unmasked" } } },
        { op: "add_layer", sceneId: "sc_clip", layer: { id: "ly_spot", type: "effect", effect: "spotlight", target: { segmentationId: segId(), objectId: "2" }, intensity: 0.6, box: { x: 0, y: 0, w: 1, h: 1, z: 6 }, timing: { start: 1.5, end: 6 } } },
        { op: "add_layer", sceneId: "sc_clip", layer: { id: "ly_search_label", type: "text", role: "label", text: "Search every session", box: { x: 0.5, y: 0.4, w: 0.4, h: 0.06, z: 7 }, anchor: { segmentationId: segId(), objectId: "2", point: "top", offset: { x: 0, y: -0.04 }, whenLost: "hide" }, timing: { start: 1.5, end: 6 } } },
      ],
    }),
  ]);

describe("effects direction in composition.edit (clip context)", () => {
  it("gives Spark the clip's tracked objects + transcript + effect vocabulary and applies a valid object-aware patch", async () => {
    let segId = "";
    const route = effectsRoute(() => segId);
    const s = await setup([route]);
    segId = s.seg.id;
    await s.ws.collection("compositionPatches").create({ id: "pch_fx", compositionId: s.composition.id, baseVersion: 1, ops: [], summary: "Generating edit…", source: "ai", instruction: "x", affectedSceneIds: ["sc_clip"], status: "proposed" }, { actor: "u1" });
    const job = await s.p.jobs.create(s.wid, "composition.edit", { appId: s.seed.appId, compositionId: s.composition.id, baseVersion: 1, instruction: "Make this look like a professional Apple product commercial: put the app demonstration behind me and emphasise the search feature.", sceneIds: ["sc_clip"], patchId: "pch_fx", autoApply: true, clipAnalysisIds: [s.clip.id] }, { actor: "u1", credits: { operation: "composition.edit" } });
    await s.p.inline!.drain();
    expect((await s.p.jobs.get(s.wid, job.id))?.status).toBe("succeeded");
    expect(route.calls).toBe(2);
    const req = s.meta.requests.find((r) => schemaName(r) === "CompositionEdit")!;
    const text = requestText(req);
    expect(text).toContain(`"segmentationId":"${s.seg.id}","objectId":"2"`);
    expect(text).toContain("search your sessions in one tap");
    expect(text).toContain("screen-insert");
    const repairText = requestText(s.meta.requests.filter((r) => schemaName(r) === "CompositionEdit")[1]!);
    expect(repairText).toMatch(/not one of the attached clip's objects/);

    const patch = await s.ws.collection("compositionPatches").getOrThrow("pch_fx");
    expect(patch).toMatchObject({ status: "applied", resultVersion: 2, affectedSceneIds: ["sc_clip"] });
    const v2 = await getVersion(s.ws, s.composition.id, 2);
    const scene = v2.doc.scenes.find((x) => x.id === "sc_clip")!;
    const spot = scene.layers.find((l) => l.id === "ly_spot")!;
    expect(spot).toMatchObject({ type: "effect", effect: "spotlight", target: { segmentationId: s.seg.id, objectId: "2" } });
    expect(scene.layers.find((l) => l.id === "ly_search_label")!.anchor).toMatchObject({ objectId: "2", point: "top" });
    expect(scene.layers.find((l) => l.id === "ly_clip")).toMatchObject({ mask: { mode: "cutout", objectIds: ["1"] } });
    for (const id of ["sc_hook", "sc_cta"]) expect(sceneHash(v2.doc.scenes.find((x) => x.id === id)!)).toBe(sceneHash(s.doc.scenes.find((x) => x.id === id)!));
    const run = await s.ws.collection("agentRuns").getOrThrow(patch.agentRunId!);
    expect(run.kind).toBe("effects_direction");
  });

  it("refuses clip analyses from another app and object references without a clip", async () => {
    const s = await setup([]);
    const other = await s.ws.collection("clipAnalyses").create({ appId: "app_other", sourceAssetId: s.clip.sourceAssetId, status: "succeeded", prompts: ["phone"] }, { actor: "u1" });
    const job = await s.p.jobs.create(s.wid, "composition.edit", { appId: s.seed.appId, compositionId: s.composition.id, baseVersion: 1, instruction: "Spotlight the phone", sceneIds: ["sc_clip"], patchId: "pch_x", clipAnalysisIds: [other.id] }, { actor: "u1" });
    await s.p.inline!.drain();
    expect((await s.p.jobs.get(s.wid, job.id))?.error?.code).toBe("BAD_REQUEST");
  });
});

describe("multi-version intent router", () => {
  it("parses hook/audience requests and keeps the remaining edit", () => {
    expect(multiVersionIntent("Create three different hooks")).toEqual({ mode: "hooks", count: 3, remaining: "" });
    expect(multiVersionIntent("make 2 versions for different audiences")).toMatchObject({ mode: "audience", count: 2 });
    const mixed = multiVersionIntent("Put the app demonstration behind me, emphasise the search feature, and create three different hooks.");
    expect(mixed).toMatchObject({ mode: "hooks", count: 3 });
    expect(mixed!.remaining).toContain("Put the app demonstration behind me");
    expect(mixed!.remaining).not.toMatch(/hooks/);
    expect(multiVersionIntent("Make the opening more engaging")).toBeNull();
  });

  it("routes 'create three different hooks' to composition.variants (mode hooks) with Spark-written briefs instead of editing", async () => {
    const s = await setup([]);
    await s.ws.collection("compositionPatches").create({ id: "pch_hooks", compositionId: s.composition.id, baseVersion: 1, ops: [], summary: "Generating edit…", source: "ai", instruction: "Create three different hooks", affectedSceneIds: [], status: "proposed" }, { actor: "u1" });
    const job = await s.p.jobs.create(s.wid, "composition.edit", { appId: s.seed.appId, compositionId: s.composition.id, baseVersion: 1, instruction: "Create three different hooks", sceneIds: [], patchId: "pch_hooks" }, { actor: "u1", credits: { operation: "composition.edit" } });
    await s.p.inline!.drain();
    const done = await s.p.jobs.get(s.wid, job.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.output?.data).toMatchObject({ routedTo: "composition.variants", mode: "hooks" });
    expect(s.variantsJobs).toEqual([{ mode: "hooks", targets: ["Problem: Open on the late-night scroll, then the one-tap focus session.", "Curiosity: What if your phone defended your focus for you?", "Demo-first: Start inside the app: tap start and watch distractions disappear."] }]);
    expect(s.meta.requests.some((r) => schemaName(r) === "CompositionEdit")).toBe(false);
    const patch = await s.ws.collection("compositionPatches").getOrThrow("pch_hooks");
    expect(patch.status).toBe("rejected");
    expect(patch.summary).toMatch(/Routed: creating 3 hook variants/);
    expect((await s.ws.collection("compositions").getOrThrow(s.composition.id)).latestVersion).toBe(1);
  });

  it("mixed request with autoApply: applies the effects edit, then branches three hook variants from the edited version", async () => {
    let segId = "";
    const route = effectsRoute(() => segId);
    const s = await setup([route]);
    segId = s.seg.id;
    const job = await s.p.jobs.create(
      s.wid,
      "composition.edit",
      { appId: s.seed.appId, compositionId: s.composition.id, baseVersion: 1, instruction: "Put the app demonstration behind me, emphasise the search feature, and create three different hooks.", sceneIds: ["sc_clip"], patchId: "pch_mixed", autoApply: true, clipAnalysisIds: [s.clip.id] },
      { actor: "u1" },
    );
    await s.p.inline!.drain();
    const done = await s.p.jobs.get(s.wid, job.id);
    expect(done?.output?.data).toMatchObject({ status: "applied", resultVersion: 2, variantMode: "hooks" });
    expect(s.variantsJobs).toHaveLength(1);
    const req = s.meta.requests.find((r) => schemaName(r) === "CompositionEdit")!;
    expect(requestText(req)).toContain("Instruction from the founder: Put the app demonstration behind me, emphasise the search feature");
    expect(requestText(req)).toContain("produced separately as variants");
  });
});
