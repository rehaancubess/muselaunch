"use client";
/**
 * Owner: module F (Analytics & platform). The Insights tab body: sourced metrics with explicit gaps,
 * funnel, cost vs outcome, experiments, recommendations and data sources (RevenueCat, CSV,
 * manual entry, tracked links). Rendered by .../a/[appId]/insights/page.tsx inside <PageContainer width="wide">.
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@muselaunch/ui";
import { useState } from "react";
import { useRouteIds } from "@/lib/workspace";
import { ExperimentsView } from "./experiments";
import { OverviewView, type SourcesFocus } from "./overview";
import { RecommendationsView } from "./recommendations";
import { SourcesView } from "./sources";

export interface InsightsRootProps {
  appId: string;
}

type TabKey = "overview" | "experiments" | "next" | "sources";

export default function InsightsRoot({ appId }: InsightsRootProps) {
  const { workspaceId } = useRouteIds();
  const [tab, setTab] = useState<TabKey>("overview");
  const [focus, setFocus] = useState<SourcesFocus | undefined>();
  const [openExperiment, setOpenExperiment] = useState<string | null>(null);
  if (!workspaceId) return null;
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="space-y-8">
      <TabsList label="Insights sections">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="experiments">Experiments</TabsTrigger>
        <TabsTrigger value="next">What to try next</TabsTrigger>
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
      <TabsContent value="sources">
        <SourcesView workspaceId={workspaceId} appId={appId} focus={focus} />
      </TabsContent>
    </Tabs>
  );
}
