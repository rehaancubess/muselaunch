"use client";
import { Notice, PageHeader, Spinner } from "@muselaunch/ui";
import Link from "next/link";
import { PageContainer } from "@/components/page-container";
import { ResearchLauncher } from "@/components/research-launcher";
import { useActiveAutopilot } from "@/components/shell/autopilot-chip";
import DiscoverRoot from "@/features/discover";
import { routes } from "@/lib/routes";
import { useCurrentApp } from "@/lib/workspace";

/**
 * Autopilot on: research for a new app runs as the first part of its Growth Autopilot run (the same
 * cited Muse Wonder research), so Discover says so instead of waiting for someone to press a button.
 */
function AutopilotResearchNotice({ workspaceId, appId }: { workspaceId: string; appId: string }) {
  const active = useActiveAutopilot(workspaceId, appId);
  if (!active || !["understand", "research"].includes(active.stage) || !["running", "waiting_on_jobs"].includes(active.status)) return null;
  return (
    <Notice tone="info" icon={<Spinner className="size-4" />} className="mb-8" title={active.stage === "understand" ? "Growth Autopilot is learning your app" : "Growth Autopilot is researching your market"}>
      New findings appear here as they’re found, each linked to its sources.{" "}
      <Link href={routes.app(workspaceId, appId).creator} className="font-medium underline underline-offset-2">
        See the run
      </Link>
    </Notice>
  );
}

export default function DiscoverPage() {
  const { appId, app, workspaceId } = useCurrentApp();
  return (
    <PageContainer width="wide">
      <PageHeader title="Discover" description={`Competitors, creators and trends, connected to ${app?.name ?? "your app"}. Every finding links to its source.`} actions={<ResearchLauncher appId={appId} />} />
      <AutopilotResearchNotice workspaceId={workspaceId} appId={appId} />
      <DiscoverRoot appId={appId} />
    </PageContainer>
  );
}
