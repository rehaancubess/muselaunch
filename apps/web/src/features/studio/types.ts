/** Response shapes for module C's routes (apps/api/src/routes/compositions.ts). */
import type { Composition, CompositionDoc, CompositionPatch, CompositionVersion, Job, Layer, MediaAsset, PatchOp, Scene } from "@muselaunch/contracts";

export type { Composition, CompositionDoc, CompositionPatch, CompositionVersion, Layer, MediaAsset, PatchOp, Scene };

export interface LintIssue {
  level: "error" | "warning";
  sceneId?: string;
  layerId?: string;
  message: string;
}

export interface LastRender {
  jobId: string;
  version: number;
  quality: "preview" | "final";
  assetId?: string;
  at: string;
  asset: MediaAsset;
  url: string;
  posterUrl: string | null;
  expiresAt: string;
}

export interface CompositionResponse {
  composition: Composition;
  version: CompositionVersion;
  lint: LintIssue[];
  lastRender: LastRender | null;
  durationSec: number;
}

export interface PreviewResponse {
  html: string;
  durationSec: number;
  version: number;
  scenes: { id: string; start: number; end: number }[];
  missingAssetIds: string[];
  width: number;
  height: number;
  expiresInSec: number;
}

export interface CommitResponse {
  composition: Composition;
  version: CompositionVersion;
  patch?: CompositionPatch;
  affectedSceneIds?: string[];
}

export interface AiEditResponse {
  job: Job;
  patch: CompositionPatch;
}

export interface PatchDetailResponse {
  patch: CompositionPatch;
  preview: { applicable: boolean; affectedSceneIds: string[]; errors: string[] } | null;
  currentVersion: number;
}

export type VersionSummary = Omit<CompositionVersion, "doc"> & { current: boolean };
export interface VersionsResponse {
  items: VersionSummary[];
  nextCursor: string | null;
  currentVersion: number;
  redoStack: number[];
}

export interface RenderResponse {
  job: Job;
  estimate?: { credits: number; breakdown: { label: string; credits: number }[] };
}

export type TextLayer = Extract<Layer, { type: "text" }>;
export type DeviceLayer = Extract<Layer, { type: "device" }>;
