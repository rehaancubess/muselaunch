import type { CompositionDoc, MediaAsset } from "@muselaunch/contracts";
import { sceneHash, validateDoc } from "@muselaunch/compositions";
import { createComposition, getVersion } from "@muselaunch/compositions/store";
import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { checkEdit, slideRefs } from "./edit";
import { handlers } from "./index";
import { installFakeMeta, jsonRoute, requestText, schemaName, seedApp, type MetaRequest } from "./testing";

/**
 * Ask Muse on stills (composition.edit for doc.kind static / carousel): "slide 3" is scene 3, other
 * slides stay byte-identical, and nothing a still can't have (sound, captions, transitions, video
 * layers, made-up screens) gets in. Fake Spark answers are FIXTURES, not live output.
 */

/** A 4-slide carousel fixture: cover, two feature slides on real screens, the call to action. */
function carouselDoc(shotA: string, shotB: string, kind: CompositionDoc["kind"] = "carousel"): CompositionDoc {
  const slide = (id: string, template: string, purpose: string, head: string, extra: unknown[] = []) => ({
    id,
    name: `${id} ${purpose}`,
    template,
    purpose,
    durationSec: 1,
    layers: [{ id: `ly_${id}_head`, type: "text", role: "headline", text: head, box: { x: 0.08, y: 0.08, w: 0.84, h: 0.14 }, style: { sizePx: 72 } }, ...extra],
  });
  const device = (id: string, asset: string) => ({ id: `ly_${id}_device`, type: "device", screenAssetId: asset, box: { x: 0.22, y: 0.3, w: 0.56, h: 0.6 } });
  const scenes = [
    slide("sc_s1", "slide-cover", "hook", "Your phone wins. Again?", [device("sc_s1", shotA)]),
    slide("sc_s2", "slide-feature", "feature", "1. Start one calm session", [device("sc_s2", shotA)]),
    slide("sc_s3", "slide-feature", "feature", "2. Let the noise wait", [device("sc_s3", shotB)]),
    slide("sc_s4", "slide-cta", "cta", "Start your first focus session"),
  ];
  const v = validateDoc({
    schemaVersion: 1,
    title: "Three small changes",
    kind,
    aspectRatio: "4:5",
    width: 1080,
    height: 1350,
    fps: 30,
    theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#5C46DC" },
    scenes: kind === "static" ? scenes.slice(0, 1) : scenes,
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.doc;
}

const asset = (id: string, over: Partial<MediaAsset> = {}): MediaAsset => ({ id, kind: "image", role: "screenshot", isProductTruth: true, status: "ready", origin: "upload", ...over }) as MediaAsset;
const assets = new Map<string, MediaAsset>([
  ["ast_a", asset("ast_a")],
  ["ast_b", asset("ast_b")],
  ["ast_c", asset("ast_c")],
  ["ast_gen", asset("ast_gen", { role: "generated_image" as MediaAsset["role"], isProductTruth: false, origin: "generated" })],
  ["ast_rec", asset("ast_rec", { kind: "video", role: "app_recording" })],
  ["ast_music", asset("ast_music", { kind: "audio", role: "music" as MediaAsset["role"], isProductTruth: false, origin: "generated" })],
]);
const edit = (ops: unknown[], targetSceneIds: string[] = []) => ({ summary: "Edit", targetSceneIds, ops: ops as never });

describe("Ask Muse on stills: which slide", () => {
  const doc = carouselDoc("ast_a", "ast_b");
  it("reads slide numbers, ordinals, ranges, the cover and the last slide as scenes", () => {
    expect(slideRefs("Make slide 3 punchier", doc)).toEqual(["sc_s3"]);
    expect(slideRefs("Use the report screen on slides 2 and 3", doc)).toEqual(["sc_s2", "sc_s3"]);
    expect(slideRefs("Tighten slides 2-4", doc)).toEqual(["sc_s2", "sc_s3", "sc_s4"]);
    // A list of three or more keeps every slide it names (not just the first two).
    expect(slideRefs("Shorter headlines on slides 1, 3 and 4", doc)).toEqual(["sc_s1", "sc_s3", "sc_s4"]);
    expect(slideRefs("Brighter slides 1, 2, and 4", doc)).toEqual(["sc_s1", "sc_s2", "sc_s4"]);
    expect(slideRefs("Calmer colours on slides 1 and 3 to 4", doc)).toEqual(["sc_s1", "sc_s3", "sc_s4"]);
    expect(slideRefs("The third slide needs a shorter headline", doc)).toEqual(["sc_s3"]);
    expect(slideRefs("A bolder cover", doc)).toEqual(["sc_s1"]);
    expect(slideRefs("Change the last slide's call to action", doc)).toEqual(["sc_s4"]);
    expect(slideRefs("Slide 9 is wrong", doc)).toEqual([]); // no such slide: nothing is scoped by guess
    expect(slideRefs("Make it calmer", doc)).toEqual([]);
    // Changing the set of slides itself isn't scoped to the slides it names (it adds, removes or moves scenes).
    expect(slideRefs("Add a slide after slide 3 about weekly reports", doc)).toEqual([]);
    expect(slideRefs("Remove slide 2", doc)).toEqual([]);
    expect(slideRefs("Swap slides 2 and 3", doc)).toEqual([]);
    expect(slideRefs("Put slide 4 and slide 2 in the other order", doc)).toEqual([]);
    // Videos keep their own scene ids (no slide numbers).
    expect(slideRefs("slide 2", { ...doc, kind: "video" })).toEqual([]);
  });
});

describe("Ask Muse on stills: what an edit may do", () => {
  const doc = carouselDoc("ast_a", "ast_b");
  it("a scoped text change on slide 3 leaves the other slides byte-identical", () => {
    const r = checkEdit(doc, edit([{ op: "update_layer", sceneId: "sc_s3", layerId: "ly_sc_s3_head", set: { text: "2. Notifications can wait" } }], ["sc_s3"]), { sceneIds: ["sc_s3"], assets });
    expect(r.problems).toEqual([]);
    expect(r.affectedSceneIds).toEqual(["sc_s3"]);
    for (const id of ["sc_s1", "sc_s2", "sc_s4"]) expect(sceneHash(r.doc!.scenes.find((s) => s.id === id)!)).toBe(sceneHash(doc.scenes.find((s) => s.id === id)!));
    // Touching another slide while only slide 3 is in scope is refused.
    expect(checkEdit(doc, edit([{ op: "update_layer", sceneId: "sc_s2", layerId: "ly_sc_s2_head", set: { text: "x" } }]), { sceneIds: ["sc_s3"], assets }).problems.join(" ")).toMatch(/outside the requested scenes/);
  });

  it("never adds sound, captions, transitions or video layers to a still", () => {
    const audio = checkEdit(doc, edit([{ op: "upsert_audio", track: { id: "au_1", kind: "music", assetId: "ast_music", sourceLabel: "original_music" } }]), { sceneIds: [], assets });
    expect(audio.problems.join(" ")).toMatch(/a still has no sound/);
    const captions = checkEdit(doc, edit([{ op: "set_captions", captions: { enabled: true, preset: "boxed", position: "bottom", source: "manual", cues: [{ id: "c1", startSec: 0, endSec: 1, text: "Hi" }] } }]), { sceneIds: [], assets });
    expect(captions.problems.join(" ")).toMatch(/a still has no captions/);
    const transition = checkEdit(doc, edit([{ op: "update_scene", sceneId: "sc_s2", set: { transitionIn: { kind: "fade", durationSec: 0.4 } } }], ["sc_s2"]), { sceneIds: ["sc_s2"], assets });
    expect(transition.problems.join(" ")).toMatch(/no transitions/);
    const video = checkEdit(doc, edit([{ op: "add_layer", sceneId: "sc_s2", layer: { id: "ly_vid", type: "video", assetId: "ast_rec", box: { x: 0, y: 0, w: 1, h: 1 } } }], ["sc_s2"]), { sceneIds: ["sc_s2"], assets });
    expect(video.problems.join(" ")).toMatch(/no video layers/);
    // The same ops on a video are fine (nothing changes for videos).
    expect(checkEdit({ ...doc, kind: "video" }, edit([{ op: "update_scene", sceneId: "sc_s2", set: { transitionIn: { kind: "fade", durationSec: 0.4 } } }], ["sc_s2"]), { sceneIds: ["sc_s2"], assets }).problems).toEqual([]);
  });

  it("keeps real screens real and a single image one slide", () => {
    const swap = checkEdit(doc, edit([{ op: "update_layer", sceneId: "sc_s2", layerId: "ly_sc_s2_device", set: { screenAssetId: "ast_c" } }], ["sc_s2"]), { sceneIds: ["sc_s2"], assets });
    expect(swap.problems).toEqual([]);
    const gen = checkEdit(doc, edit([{ op: "update_layer", sceneId: "sc_s2", layerId: "ly_sc_s2_device", set: { screenAssetId: "ast_gen" } }], ["sc_s2"]), { sceneIds: ["sc_s2"], assets });
    expect(gen.problems.join(" ")).toMatch(/must show a real screenshot or recording/);
    const picture = checkEdit(doc, edit([{ op: "add_layer", sceneId: "sc_s2", layer: { id: "ly_pic", type: "image", assetId: "ast_gen", box: { x: 0.2, y: 0.3, w: 0.6, h: 0.6 } } }], ["sc_s2"]), { sceneIds: ["sc_s2"], assets });
    expect(picture.problems.join(" ")).toMatch(/slides show the real app; generated pictures/);
    const single = carouselDoc("ast_a", "ast_b", "static");
    const more = checkEdit(single, edit([{ op: "add_scene", afterSceneId: "sc_s1", scene: { ...single.scenes[0]!, id: "sc_new", layers: [] } }]), { sceneIds: [], assets });
    expect(more.problems.join(" ")).toMatch(/single image has one slide/);
  });
});

describe("composition.edit on a carousel (fake Muse Spark)", () => {
  it("“make slide 3 punchier” edits only slide 3, with the designer's still rules, and applies it", async () => {
    const p = createTestPlatform({ META_API_KEY: "test-key" }, handlers);
    const wid = "ws_edit_stills";
    await p.credits.ensureAccount(wid, { grant: 100, reason: "test" });
    const seed = await seedApp(p, wid);
    const ws = p.db.ws(wid);
    let sent: MetaRequest | undefined;
    const meta = installFakeMeta(p, [
      jsonRoute("CompositionEdit", (req) => {
        sent = req;
        const scene = requestText(req).match(/Edit ONLY these scenes: (\S+)/)?.[1] ?? "";
        return { summary: "Fixture: a punchier headline on slide 3", targetSceneIds: [scene], ops: [{ op: "update_layer", sceneId: scene, layerId: `ly_${scene}_head`, set: { text: "2. Silence the noise" } }] };
      }),
      jsonRoute("ClaimValidation", (req) => ({ results: requestText(req).split("\n").filter((l) => l.startsWith('{"id":')).map((l) => ({ id: JSON.parse(l).id, issues: [] })) })),
    ]);
    const doc = carouselDoc(seed.screenshotIds[0]!, seed.screenshotIds[1]!);
    const { composition } = await createComposition(ws, { appId: seed.appId, title: "Three small changes", doc }, "u1");
    const job = await p.jobs.create(wid, "composition.edit", { appId: seed.appId, compositionId: composition.id, baseVersion: 1, instruction: "Make slide 3 punchier", sceneIds: [], patchId: "pch_slide3", autoApply: true }, { actor: "u1" });
    await p.inline!.drain();
    expect((await p.jobs.get(wid, job.id))?.status).toBe("succeeded");
    expect(String(sent!.instructions)).toMatch(/MuseLaunch's designer/);
    expect(String(sent!.instructions)).toMatch(/never use upsert_audio, remove_audio or set_captions/);
    const text = requestText(sent!);
    expect(text).toContain("Edit ONLY these scenes: sc_s3");
    expect(text).toContain("slide 3 = scene sc_s3 (slide-feature)");
    expect(text).toMatch(/carousel of 4 slides: no sound, captions, transitions or video/);
    const patch = await ws.collection("compositionPatches").getOrThrow("pch_slide3");
    expect(patch).toMatchObject({ status: "applied", affectedSceneIds: ["sc_s3"] });
    const v1 = await getVersion(ws, composition.id, 1);
    const v2 = await getVersion(ws, composition.id, 2);
    expect(v2.doc.scenes[2]!.layers[0]).toMatchObject({ text: "2. Silence the noise" });
    for (const i of [0, 1, 3]) expect(sceneHash(v2.doc.scenes[i]!)).toBe(sceneHash(v1.doc.scenes[i]!));
    expect(v2.doc.audio).toEqual([]);
    expect(meta.requests.filter((r) => schemaName(r) === "CompositionEdit")).toHaveLength(1);
  });
});
