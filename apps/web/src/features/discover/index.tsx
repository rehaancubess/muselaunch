"use client";
/**
 * Owner: module E (Growth & distribution). The Discover tab body (tracked accounts story row,
 * personalised feed with sources, opportunities). Rendered by .../a/[appId]/discover/page.tsx
 * inside <PageContainer width="wide">. Replace the internals; keep the default export + props.
 * UI kit: StoryRingRow, SourceChip, ProvenanceBadge, EmptyState from "@muselaunch/ui".
 */
import { StoryRingRow } from "@muselaunch/ui";
import { Compass } from "lucide-react";
import { FeaturePlaceholder } from "../_placeholder";

export interface DiscoverRootProps {
  appId: string;
}

export default function DiscoverRoot(_props: DiscoverRootProps) {
  return (
    <div className="space-y-8">
      <StoryRingRow items={[]} addLabel="Track" label="Tracked accounts" />
      <FeaturePlaceholder
        icon={<Compass aria-hidden />}
        title="Your Discover feed will appear here"
        description="Competitors, creators and trends you track, plus opportunities matched to your app. Every finding links to its source. The feed isn’t available in this build yet."
      />
    </div>
  );
}
