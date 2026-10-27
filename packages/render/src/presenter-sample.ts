/**
 * Object-aware sample: the synthetic presenter fixture (fixtures/render/presenter) expressed as the
 * MediaAssets / Segmentations / ClipAnalysis module D produces, plus a storyboard using the three
 * object-aware templates. Fixture data only; used by tests and the smoke script.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClipAnalysis, MediaAsset, Segmentation, Storyboard, TracksFile } from "@muselaunch/contracts";

const NOW = "2026-10-27T00:00:00.000Z";
const base = (wid: string, id: string) => ({ id, workspaceId: wid, createdAt: NOW, updatedAt: NOW, createdBy: "fixture" });

export const PRESENTER_FILES = {
  ast_presenter: { file: "presenter.mp4", mime: "video/mp4", kind: "video", role: "founder_clip", width: 720, height: 1280, durationSec: 6, truth: false },
  ast_person_cut: { file: "person-cutout.webm", mime: "video/webm", kind: "video", role: "other", width: 720, height: 1280, durationSec: 6, truth: false },
  ast_phone_cut: { file: "phone-cutout.webm", mime: "video/webm", kind: "video", role: "other", width: 720, height: 1280, durationSec: 6, truth: false },
  ast_tracks_person: { file: "tracks-person.json", mime: "application/json", kind: "json", role: "other", width: undefined, height: undefined, durationSec: undefined, truth: false },
  ast_tracks_phone: { file: "tracks-phone.json", mime: "application/json", kind: "json", role: "other", width: undefined, height: undefined, durationSec: undefined, truth: false },
  ast_app_rec: { file: "app-recording.mp4", mime: "video/mp4", kind: "video", role: "app_recording", width: 590, height: 1278, durationSec: 6, truth: true },
} as const;

export function presenterAssets(wid: string, appId: string, keyFor: (id: string, file: string) => string): MediaAsset[] {
  return Object.entries(PRESENTER_FILES).map(([id, f]) => ({
    ...base(wid, id),
    appId,
    kind: f.kind,
    role: f.role,
    origin: id === "ast_presenter" || id === "ast_app_rec" ? "upload" : "derived",
    storagePath: keyFor(id, f.file),
    mimeType: f.mime,
    bytes: 0,
    width: f.width,
    height: f.height,
    durationSec: f.durationSec,
    fps: f.kind === "video" ? 30 : undefined,
    hasAudio: f.kind === "video" ? false : undefined,
    status: "ready",
    labels: ["fixture"],
    isProductTruth: f.truth,
    derivedFromAssetId: id.endsWith("_cut") || id.startsWith("ast_tracks") ? "ast_presenter" : undefined,
  })) as MediaAsset[];
}

export function presenterTracks(dir: string): Record<"person" | "phone", TracksFile> {
  return {
    person: JSON.parse(readFileSync(join(dir, "tracks-person.json"), "utf8")) as TracksFile,
    phone: JSON.parse(readFileSync(join(dir, "tracks-phone.json"), "utf8")) as TracksFile,
  };
}

function meanBbox(t: TracksFile) {
  const b = t.tracks[0]!.frames.filter((f) => f.visible && f.bbox).map((f) => f.bbox!);
  const avg = (k: "x" | "y" | "w" | "h") => Math.round((b.reduce((s, x) => s + x[k], 0) / b.length) * 10000) / 10000;
  return { x: avg("x"), y: avg("y"), w: avg("w"), h: avg("h") };
}

export function presenterSegmentations(wid: string, appId: string): Segmentation[] {
  const seg = (id: string, prompt: string, cut: string, tracks: string): Segmentation =>
    ({
      ...base(wid, id),
      appId,
      sourceAssetId: "ast_presenter",
      prompt,
      model: "sam-3.1",
      status: "succeeded",
      mediaType: "video",
      objects: [{ objectId: "0", label: prompt, score: 0.97, framesTracked: 180 }],
      cutoutAssetId: cut,
      tracksAssetId: tracks,
      objectOutputs: { "0": { cutoutAssetId: cut } },
      frameCount: 180,
      fps: 30,
      trackingQuality: 0.97,
      corrections: [],
      usageEventIds: [],
    }) as unknown as Segmentation;
  return [seg("seg_person", "person", "ast_person_cut", "ast_tracks_person"), seg("seg_phone", "phone", "ast_phone_cut", "ast_tracks_phone")];
}

export function presenterAnalysis(wid: string, appId: string, tracks: Record<"person" | "phone", TracksFile>): ClipAnalysis {
  return {
    ...base(wid, "cla_presenter"),
    appId,
    sourceAssetId: "ast_presenter",
    status: "succeeded",
    prompts: ["person", "phone"],
    transcribe: false,
    segmentationIds: { person: "seg_person", phone: "seg_phone" },
    durationSec: 6,
    objects: [
      { key: "person", label: "person", segmentationId: "seg_person", objectId: "0", trackingQuality: 0.97, presence: [{ startSec: 0, endSec: 6 }], meanBbox: meanBbox(tracks.person) },
      { key: "phone", label: "phone", segmentationId: "seg_phone", objectId: "0", trackingQuality: 0.97, presence: [{ startSec: 0, endSec: 6 }], meanBbox: meanBbox(tracks.phone) },
    ],
  } as ClipAnalysis;
}

export function presenterStoryboard(wid: string, appId = "app_focusly", id = "sbd_presenter"): Storyboard {
  return {
    ...base(wid, id),
    appId,
    campaignId: "cpg_sample",
    variantId: "var_sample",
    title: "Focusly — founder demo",
    aspectRatio: "9:16",
    targetDurationSec: 11,
    scenes: [
      { id: "p1", order: 0, purpose: "hook", durationSec: 3, onScreenText: "I built the planner I always wanted", narration: "", visual: "Founder in front of the app", template: "presenter-depth", assets: [{ kind: "founder_clip", assetId: "ast_presenter" }, { kind: "app_recording", assetId: "ast_app_rec" }], claimIds: [] },
      { id: "p2", order: 1, purpose: "demo", durationSec: 3, onScreenText: "Your whole day, in your hand | Focus blocks", narration: "", visual: "App on the phone in hand", template: "product-in-hand", assets: [{ kind: "founder_clip", assetId: "ast_presenter" }, { kind: "app_recording", assetId: "ast_app_rec" }], claimIds: [] },
      { id: "p3", order: 2, purpose: "feature", durationSec: 3, onScreenText: "Everything you need, one tap away | One-tap planning", narration: "", visual: "Spotlight on the phone", template: "object-spotlight", assets: [{ kind: "founder_clip", assetId: "ast_presenter" }], claimIds: [] },
      { id: "p4", order: 3, purpose: "cta", durationSec: 2.5, onScreenText: "Try Focusly free", narration: "", visual: "End card", template: "cta-endcard", assets: [], claimIds: [] },
    ],
    voiceover: { source: "none" },
    music: {},
  } as unknown as Storyboard;
}
