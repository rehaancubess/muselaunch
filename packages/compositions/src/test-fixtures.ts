/** Shared fixtures for unit tests (not exported from the package index). */
import type { CompositionDoc, MediaAsset } from "@muselaunch/contracts";
import { validateDoc } from "./validate";

export function sampleDoc(): CompositionDoc {
  const raw = {
    schemaVersion: 1,
    title: "Focusly launch",
    kind: "video",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#0A84FF" },
    scenes: [
      {
        id: "sc_hook",
        name: "Hook",
        template: "hook-title",
        purpose: "hook",
        durationSec: 3,
        layers: [{ id: "ly_hook_title", type: "text", role: "headline", text: "Stop losing your mornings", box: { x: 0.08, y: 0.38, w: 0.84, h: 0.2 } }],
      },
      {
        id: "sc_demo",
        name: "Demo",
        template: "device-demo",
        purpose: "demo",
        durationSec: 5,
        transitionIn: { kind: "fade", durationSec: 0.4 },
        layers: [
          { id: "ly_demo_head", type: "text", role: "headline", text: "Plan your day in one tap", box: { x: 0.08, y: 0.1, w: 0.84, h: 0.12 }, style: { sizePx: 64 } },
          { id: "ly_demo_device", type: "device", screenAssetId: "ast_shot1", box: { x: 0.22, y: 0.26, w: 0.56, h: 0.58 } },
        ],
      },
      {
        id: "sc_cta",
        name: "CTA",
        template: "cta-endcard",
        purpose: "cta",
        durationSec: 3,
        layers: [{ id: "ly_cta_text", type: "text", role: "cta", text: "Download Focusly", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 } }],
      },
    ],
  };
  const v = validateDoc(raw);
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.doc;
}

export function sampleAsset(id: string, over: Partial<MediaAsset> = {}): MediaAsset {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId: "ws_test",
    createdAt: now,
    updatedAt: now,
    createdBy: "u1",
    kind: "image",
    role: "screenshot",
    origin: "upload",
    storagePath: `workspaces/ws_test/assets/${id}.png`,
    mimeType: "image/png",
    bytes: 100,
    width: 1179,
    height: 2556,
    status: "ready",
    labels: [],
    isProductTruth: true,
    ...over,
  } as MediaAsset;
}
