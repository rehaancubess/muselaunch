"use client";
/**
 * Owner: module F (Analytics & platform). The Insights tab body: connected sources, sourced metrics,
 * experiments and recommendations. Rendered by .../a/[appId]/insights/page.tsx inside <PageContainer width="wide">.
 */
import { BarChart3 } from "lucide-react";
import { FeaturePlaceholder } from "../_placeholder";

export interface InsightsRootProps {
  appId: string;
}

export default function InsightsRoot(_props: InsightsRootProps) {
  return (
    <FeaturePlaceholder
      icon={<BarChart3 aria-hidden />}
      title="Results will appear here once data is connected"
      description="Connect RevenueCat or import App Store, Play Console or social CSVs. Every number shows where it came from; MuseLaunch never estimates results you haven’t measured."
    />
  );
}
