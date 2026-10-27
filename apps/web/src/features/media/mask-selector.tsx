"use client";
/**
 * Owner: module D (Multimodal media). SAM 3.1 subject selection on an asset.
 * Props are the agreed contract; replace the internals.
 */
import { ScanFace } from "lucide-react";
import { FeaturePlaceholder } from "../_placeholder";

export interface MaskSelectorProps {
  assetId: string;
  onSegmentation?: (segmentationId: string) => void;
}

export default function MaskSelector({ assetId }: MaskSelectorProps) {
  return (
    <FeaturePlaceholder
      icon={<ScanFace aria-hidden />}
      title="Subject selection"
      description={<>Select a person or object in this clip to cut it out with SAM 3.1. Not available in this build yet (asset {assetId}).</>}
    />
  );
}
