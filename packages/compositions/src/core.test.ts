import type { PatchOp } from "@muselaunch/contracts";
import { MemoryDb } from "@muselaunch/db";
import { describe, expect, it } from "vitest";
import { describeForLLM } from "./describe";
import { canonicalJson, docHash, sceneHash, sha256Hex } from "./hash";
import { lintDoc } from "./lint";
import { applyPatch, PatchError } from "./patch";
import { commitVersion, createComposition, getVersion, redo, undo } from "./store";
import { sampleAsset, sampleDoc } from "./test-fixtures";
import { validateDoc } from "./validate";

describe("hash", () => {
  it("is SHA-256 and key-order independent", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
  });
});

describe("validateDoc", () => {
  it("rejects unknown templates, duplicate ids and bad timing", () => {
    const doc = sampleDoc();
    const bad = structuredClone(doc) as unknown as { scenes: { template: string; layers: { id: string; timing?: unknown }[] }[] };
    bad.scenes[0]!.template = "matrix-rain";
    bad.scenes[1]!.layers[0]!.id = "ly_hook_title";
    bad.scenes[2]!.layers[0]!.timing = { start: 9 };
    const r = validateDoc(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toMatch(/not an allowlisted template/);
      expect(r.errors.join("\n")).toMatch(/duplicate id/);
      expect(r.errors.join("\n")).toMatch(/starts at 9s/);
    }
  });
});

describe("applyPatch", () => {
  it("round-trips through the inverse ops", () => {
    const doc = sampleDoc();
    const ops: PatchOp[] = [
      { op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_head", set: { text: "One tap. Whole day planned.", style: { sizePx: 80, background: { color: "#FFFFFF", paddingPx: 20, radiusPx: 24 } }, name: "Headline" } },
      { op: "update_scene", sceneId: "sc_demo", set: { durationSec: 4, transitionIn: { kind: "slide-up", durationSec: 0.5 } } },
      { op: "add_layer", sceneId: "sc_demo", layer: { id: "ly_new_chip", type: "block", blockId: "callout-chip", params: { text: "Smart blocks" }, box: { x: 0.6, y: 0.5, w: 0.3, h: 0.05 } } as never },
      { op: "reorder_layer", sceneId: "sc_demo", layerId: "ly_new_chip", toIndex: 0 },
      { op: "move_scene", sceneId: "sc_cta", afterSceneId: "sc_hook" },
      { op: "update_theme", set: { accent: "#FF375F" } },
      { op: "set_captions", captions: { enabled: true, preset: "boxed", position: "bottom", source: "manual", cues: [{ id: "c1", startSec: 0, endSec: 2, text: "Hi" }] } },
    ];
    const { doc: next, inverse, affectedSceneIds } = applyPatch(doc, ops);
    expect(next.scenes.map((s) => s.id)).toEqual(["sc_hook", "sc_cta", "sc_demo"]);
    const head = next.scenes[2]!.layers.find((l) => l.id === "ly_demo_head")!;
    expect(head.type === "text" && head.style.sizePx).toBe(80);
    expect(head.type === "text" && head.style.weight).toBe(700); // nested merge kept existing keys
    expect(affectedSceneIds).toEqual(["sc_hook", "sc_cta", "sc_demo"]); // theme touched all
    const back = applyPatch(next, inverse).doc;
    expect(docHash(back)).toBe(docHash(doc));
    // inverse ops survive JSON (as stored in Firestore)
    const back2 = applyPatch(next, JSON.parse(JSON.stringify(inverse))).doc;
    expect(docHash(back2)).toBe(docHash(doc));
  });

  it("editing scene 2 leaves the other scenes' hashes identical", () => {
    const doc = sampleDoc();
    const before = doc.scenes.map(sceneHash);
    const { doc: next, affectedSceneIds } = applyPatch(doc, [
      { op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_head", set: { text: "Your day, planned in one tap" } },
      { op: "update_scene", sceneId: "sc_demo", set: { durationSec: 6 } },
    ]);
    const after = next.scenes.map(sceneHash);
    expect(affectedSceneIds).toEqual(["sc_demo"]);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("rejects ops on unknown ids, id/type changes, unknown fields and invalid results atomically", () => {
    const doc = sampleDoc();
    const snapshot = docHash(doc);
    const cases: PatchOp[][] = [
      [{ op: "update_layer", sceneId: "sc_demo", layerId: "nope", set: { text: "x" } }],
      [{ op: "remove_scene", sceneId: "sc_missing" }],
      [{ op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_head", set: { id: "other" } }],
      [{ op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_head", set: { type: "image" } }],
      [{ op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_head", set: { script: "alert(1)" } }],
      [{ op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_head", set: { style: { sizePx: 9000 } } }],
      [{ op: "add_layer", sceneId: "sc_demo", layer: { id: "ly_hook_title", type: "text", text: "dup", box: { x: 0, y: 0, w: 1, h: 1 } } as never }],
      [{ op: "add_layer", sceneId: "sc_demo", layer: { id: "ly_blk", type: "block", blockId: "iframe-embed", params: {}, box: { x: 0, y: 0, w: 1, h: 1 } } as never }],
      [{ op: "update_scene", sceneId: "sc_demo", set: { template: "custom-html" } }],
      [
        { op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_head", set: { text: "fine" } },
        { op: "remove_layer", sceneId: "sc_cta", layerId: "ly_missing" },
      ],
      [],
    ];
    for (const ops of cases) {
      expect(() => applyPatch(doc, ops), JSON.stringify(ops)).toThrow(PatchError);
    }
    expect(docHash(doc)).toBe(snapshot);
  });

  it("removes and re-adds scenes with stable ids", () => {
    const doc = sampleDoc();
    const r = applyPatch(doc, [{ op: "remove_scene", sceneId: "sc_demo" }]);
    expect(r.doc.scenes.map((s) => s.id)).toEqual(["sc_hook", "sc_cta"]);
    const back = applyPatch(r.doc, r.inverse).doc;
    expect(back.scenes.map((s) => s.id)).toEqual(["sc_hook", "sc_demo", "sc_cta"]);
    expect(sceneHash(back.scenes[1]!)).toBe(sceneHash(doc.scenes[1]!));
    expect(() => applyPatch(applyPatch(doc, [{ op: "remove_scene", sceneId: "sc_hook" }, { op: "remove_scene", sceneId: "sc_cta" }]).doc, [{ op: "remove_scene", sceneId: "sc_demo" }])).toThrow(PatchError);
  });
});

describe("lintDoc", () => {
  it("flags missing assets, non-product-truth device screens and unverified claims", () => {
    const doc = applyPatch(sampleDoc(), [{ op: "update_layer", sceneId: "sc_hook", layerId: "ly_hook_title", set: { claimIds: ["clm_1"] } }]).doc;
    expect(lintDoc(doc, { assets: {} }).some((i) => i.level === "error" && /missing asset ast_shot1/.test(i.message))).toBe(true);
    const gen = sampleAsset("ast_shot1", { origin: "generated", role: "generated_image", isProductTruth: false });
    const issues = lintDoc(doc, { assets: { ast_shot1: gen } });
    expect(issues.filter((i) => i.layerId === "ly_demo_device" && i.level === "error").length).toBeGreaterThanOrEqual(1);
    const ok = lintDoc(doc, { assets: { ast_shot1: sampleAsset("ast_shot1") } });
    expect(ok.filter((i) => i.level === "error")).toEqual([]);
    const claimIssues = lintDoc(doc, {
      assets: { ast_shot1: sampleAsset("ast_shot1") },
      claims: { clm_1: { id: "clm_1", text: "Saves 2 hours a day", state: "needs_review", permittedContexts: ["all"] } as never },
    });
    expect(claimIssues.some((i) => i.level === "error" && /needs review/.test(i.message))).toBe(true);
  });

  it("warns about overflowing text", () => {
    const doc = applyPatch(sampleDoc(), [
      { op: "update_layer", sceneId: "sc_cta", layerId: "ly_cta_text", set: { text: "A very long call to action that will never fit inside this tiny box at this size", style: { sizePx: 120 } } },
    ]).doc;
    expect(lintDoc(doc, { assets: { ast_shot1: sampleAsset("ast_shot1") } }).some((i) => /overflows/.test(i.message))).toBe(true);
  });
});

describe("describeForLLM", () => {
  it("lists every scene and layer id", () => {
    const text = describeForLLM(sampleDoc());
    for (const id of ["sc_hook", "sc_demo", "sc_cta", "ly_hook_title", "ly_demo_head", "ly_demo_device", "ly_cta_text"]) expect(text).toContain(`id=${id}`);
    expect(text).toContain("REAL product media");
  });
});

describe("store", () => {
  it("creates, commits, undoes and redoes versions; rejects stale bases", async () => {
    const ws = new MemoryDb().ws("ws_store");
    const doc = sampleDoc();
    const { composition, version } = await createComposition(ws, { appId: "app_1", title: "Launch", doc, id: "cmp_fixed" }, "u1");
    expect(version.id).toBe("cmp_fixed_v1");
    expect(composition.currentVersion).toBe(1);
    // idempotent create
    const again = await createComposition(ws, { appId: "app_1", title: "Launch", doc, id: "cmp_fixed" }, "u1");
    expect(again.composition.id).toBe("cmp_fixed");

    const p1 = applyPatch(doc, [{ op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_head", set: { text: "v2" } }]);
    const c2 = await commitVersion(ws, "cmp_fixed", { baseVersion: 1, doc: p1.doc, source: "user_edit", summary: "edit" }, "u1");
    expect(c2.version.id).toBe("cmp_fixed_v2");
    expect(c2.version.sceneHashes.sc_hook).toBe(version.sceneHashes.sc_hook);
    expect(c2.version.sceneHashes.sc_demo).not.toBe(version.sceneHashes.sc_demo);
    await expect(commitVersion(ws, "cmp_fixed", { baseVersion: 1, doc: p1.doc, source: "user_edit", summary: "stale" }, "u1")).rejects.toMatchObject({ code: "CONFLICT" });

    const u = await undo(ws, "cmp_fixed", "u1");
    expect(u.currentVersion).toBe(1);
    expect(u.redoStack).toEqual([2]);
    expect((await getVersion(ws, "cmp_fixed")).version).toBe(1);
    await expect(undo(ws, "cmp_fixed", "u1")).rejects.toMatchObject({ code: "CONFLICT" });
    const r = await redo(ws, "cmp_fixed", "u1");
    expect(r.currentVersion).toBe(2);
    await expect(redo(ws, "cmp_fixed", "u1")).rejects.toMatchObject({ code: "CONFLICT" });

    // undo then a new edit branches and clears redo
    await undo(ws, "cmp_fixed", "u1");
    const p3 = applyPatch(doc, [{ op: "update_scene", sceneId: "sc_cta", set: { durationSec: 4 } }]);
    const c3 = await commitVersion(ws, "cmp_fixed", { baseVersion: 1, doc: p3.doc, source: "ai_edit", summary: "branch", patchId: "pch_1" }, "u1");
    expect(c3.version.version).toBe(3);
    expect(c3.version.parentVersion).toBe(1);
    expect(c3.composition.redoStack).toEqual([]);
    expect(c3.composition.latestVersion).toBe(3);
    await expect(redo(ws, "cmp_fixed", "u1")).rejects.toMatchObject({ code: "CONFLICT" });
    // tenant isolation: another workspace cannot see it
    await expect(getVersion(new MemoryDb().ws("ws_other"), "cmp_fixed", 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
