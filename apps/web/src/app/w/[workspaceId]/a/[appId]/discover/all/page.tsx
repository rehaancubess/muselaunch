"use client";
import { PageHeader } from "@muselaunch/ui";
import { BackLink } from "@/components/back-link";
import { PageContainer } from "@/components/page-container";
import { ResearchLauncher } from "@/components/research-launcher";
import DiscoverRoot from "@/features/discover";
import { AutopilotResearchNotice } from "@/features/discover/autopilot-notice";
import { routes } from "@/lib/routes";
import { useCurrentApp } from "@/lib/workspace";

/** Discover → See everything: every finding, filters, saved ideas, accounts you follow and creators, plus research with chosen areas. */
export default function DiscoverEverythingPage() {
  const { appId, app, workspaceId } = useCurrentApp();
  return (
    <PageContainer width="wide">
      <PageHeader
        leading={<BackLink href={routes.app(workspaceId, appId).create({ kind: "idea" })}>Create</BackLink>}
        title="Everything Muse found"
        description={`Competitors, creators and trends, connected to ${app?.name ?? "your app"}. Every finding links to its source.`}
        actions={<ResearchLauncher appId={appId} />}
      />
      <AutopilotResearchNotice workspaceId={workspaceId} appId={appId} />
      <DiscoverRoot appId={appId} />
    </PageContainer>
  );
}
