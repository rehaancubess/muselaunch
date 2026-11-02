"use client";
import { PageHeader } from "@muselaunch/ui";
import { PageContainer } from "@/components/page-container";
import { AutopilotResearchNotice } from "@/features/discover/autopilot-notice";
import SimpleDiscover from "@/features/discover/simple";
import { useCurrentApp } from "@/lib/workspace";

/** Discover: "What Muse found", the few best ideas for this app right now. Everything else is behind See everything (./all). */
export default function DiscoverPage() {
  const { appId, app, workspaceId } = useCurrentApp();
  return (
    <PageContainer width="narrow">
      <PageHeader title="What Muse found" description={`The best ideas for ${app?.name ?? "your app"} right now. Each one shows where Muse found it.`} />
      {/* Research progress shows on the page itself; this only covers Autopilot's first step. */}
      <AutopilotResearchNotice workspaceId={workspaceId} appId={appId} stages={["understand"]} />
      <SimpleDiscover appId={appId} />
    </PageContainer>
  );
}
