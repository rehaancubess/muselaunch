"use client";
/**
 * Owner: module F (Analytics & platform). Insights → Details: sourced metrics with explicit gaps,
 * filters, funnel, cost vs outcome, experiments, recommendations, YouTube (public channel analysis +
 * stats of published videos) and data sources (RevenueCat, CSV, manual entry, tracked links).
 * Rendered by .../a/[appId]/insights/details/page.tsx inside <PageContainer width="wide">; the main
 * Insights page ("How it's going", ./simple.tsx) shows only up to three numbers and the next step.
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@muselaunch/ui";
import { useState } from "react";
import { useRouteIds } from "@/lib/workspace";
import { ExperimentsView } from "./experiments";
import { OverviewView, type SourcesFocus } from "./overview";
import { RecommendationsView } from "./recommendations";
import { SourcesView } from "./sources";
import { YouTubeView } from "./youtube";

export type InsightsTab = "overview" | "experiments" | "next" | "youtube" | "sources";

export interface InsightsRootProps {
  appId: string;
  /** Opens on this tab (e.g. `?tab=sources` from "Connect your data"). */
  initialTab?: InsightsTab;
  /** Data sources: the section to bring into view. */
  initialFocus?: SourcesFocus;
  /** Tests: the test to open. */
  initialExperiment?: string | null;
}

type TabKey = InsightsTab;

export default function InsightsRoot({ appId, initialTab = "overview", initialFocus, initialExperiment = null }: InsightsRootProps) {
  const { workspaceId } = useRouteIds();
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [focus, setFocus] = useState<SourcesFocus | undefined>(initialFocus);
  const [openExperiment, setOpenExperiment] = useState<string | null>(initialExperiment);
  if (!workspaceId) return null;
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="space-y-8">
      <TabsList label="Insights sections">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="experiments">Tests</TabsTrigger>
        <TabsTrigger value="next">What to try next</TabsTrigger>
        <TabsTrigger value="youtube">YouTube</TabsTrigger>
        <TabsTrigger value="sources">Data sources</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <OverviewView
          workspaceId={workspaceId}
          appId={appId}
          onOpenSources={(f) => {
            setFocus(f);
            setTab("sources");
          }}
        />
      </TabsContent>
      <TabsContent value="experiments">
        <ExperimentsView workspaceId={workspaceId} appId={appId} openId={openExperiment} onOpen={setOpenExperiment} />
      </TabsContent>
      <TabsContent value="next">
        <RecommendationsView
          workspaceId={workspaceId}
          appId={appId}
          onOpenExperiment={(id) => {
            setOpenExperiment(id);
            setTab("experiments");
          }}
        />
      </TabsContent>
      <TabsContent value="youtube">
        <YouTubeView workspaceId={workspaceId} appId={appId} />
      </TabsContent>
      <TabsContent value="sources">
        <SourcesView workspaceId={workspaceId} appId={appId} focus={focus} />
      </TabsContent>
    </Tabs>
  );
}
