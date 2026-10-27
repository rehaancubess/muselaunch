import type { CompositionDoc, MediaAsset } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { checkEdit } from "./edit";

/**
 * LLM output is untrusted: ids it returns must be validated against the run's own app media
 * before they can enter a composition (guarantee 7). Covers the phase-2 screen-insert effect.
 */

const doc = {
  schemaVersion: 1,
  title: "Reel",
  kind: "video",
  aspectRatio: "9:16",
  width: 1080,
  height: 1920,
  fps: 30,
  theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#0A84FF" },
  safeZone: { top: 0.08, bottom: 0.14, left: 0.05, right: 0.05 },
  captions: { enabled: false, preset: "bold-center", position: "bottom", source: "script", cues: [] },
  audio: [],
  scenes: [{ id: "sc_a", name: "A", template: "hook-title", purpose: "hook", durationSec: 3, background: { kind: "solid", color: "#FFFFFF" }, layers: [] }],
} as unknown as CompositionDoc;

const asset = (id: string, over: Partial<MediaAsset>): MediaAsset => ({ id, kind: "image", role: "screenshot", isProductTruth: true, status: "ready", ...over }) as MediaAsset;

const assets = new Map<string, MediaAsset>([
  ["ast_real", asset("ast_real", {})],
  ["ast_generated", asset("ast_generated", { role: "generated_image" as MediaAsset["role"], isProductTruth: false, origin: "generated" } as Partial<MediaAsset>)],
]);

const screenInsert = (assetId: string) => ({
  summary: "Put the app on the phone",
  targetSceneIds: ["sc_a"],
  ops: [{ op: "add_layer" as const, sceneId: "sc_a", layer: { id: "ly_insert", type: "effect", effect: "screen-insert", target: { segmentationId: "seg_1", objectId: "1" }, assetId, box: { x: 0, y: 0, w: 1, h: 1 } } }],
});

describe("AI edit validation of model-chosen ids", () => {
  it("screen-insert effects may only use this app's real screenshots/recordings", () => {
    expect(checkEdit(doc, screenInsert("ast_real"), { sceneIds: ["sc_a"], assets }).problems).toEqual([]);
    expect(checkEdit(doc, screenInsert("ast_generated"), { sceneIds: ["sc_a"], assets }).problems.join(" ")).toMatch(/real screenshot or recording/);
    // An id from another workspace/app is simply unknown to this run.
    expect(checkEdit(doc, screenInsert("ast_from_other_workspace"), { sceneIds: ["sc_a"], assets }).problems.join(" ")).toMatch(/unknown asset/);
  });

  it("scene-scoped edits can't touch other scenes", () => {
    const out = { summary: "x", targetSceneIds: [], ops: [{ op: "remove_scene" as const, sceneId: "sc_a" }] };
    expect(checkEdit(doc, out, { sceneIds: ["sc_a"], assets }).problems.join(" ")).toMatch(/not allowed/);
  });
});
