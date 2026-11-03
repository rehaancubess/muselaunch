"use client";
import { PageHeader } from "@muselaunch/ui";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BackLink } from "@/components/back-link";
import { PageContainer } from "@/components/page-container";
import InsightsRoot, { type InsightsTab } from "@/features/insights";
import type { SourcesFocus } from "@/features/insights/overview";
import { routes } from "@/lib/routes";
import { useCurrentApp } from "@/lib/workspace";

const TABS: InsightsTab[] = ["overview", "experiments", "next", "youtube", "sources"];
const FOCUS: SourcesFocus[] = ["revenuecat", "csv", "manual", "links"];

/** `?tab=` opens a tab, `?focus=` a data source, `?open=` a test (read with useSearchParams, hence the Suspense boundary). */
function Body({ appId }: { appId: string }) {
  const params = useSearchParams();
  const tab = params.get("tab") as InsightsTab | null;
  const focus = params.get("focus") as SourcesFocus | null;
  const open = params.get("open");
  return (
    <InsightsRoot
      key={`${tab ?? ""}:${focus ?? ""}:${open ?? ""}`}
      appId={appId}
      initialTab={tab && TABS.includes(tab) ? tab : open ? "experiments" : focus ? "sources" : "overview"}
      initialFocus={focus && FOCUS.includes(focus) ? focus : undefined}
      initialExperiment={open}
    />
  );
}

/** Insights → Details: every measured number with filters, tests, what to try next, YouTube and data sources. */
export default function InsightsDetailsPage() {
  const { appId, workspaceId } = useCurrentApp();
  return (
    <PageContainer width="wide">
      <PageHeader
        leading={<BackLink href={routes.app(workspaceId, appId).results}>Results</BackLink>}
        title="Insights details"
        description="Every measured number with its source, your tests, what to try next, YouTube and your data sources."
      />
      <Suspense>
        <Body appId={appId} />
      </Suspense>
    </PageContainer>
  );
}
