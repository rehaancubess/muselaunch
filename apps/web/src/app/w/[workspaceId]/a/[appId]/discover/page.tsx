"use client";
import { PageHeader } from "@muselaunch/ui";
import { PageContainer } from "@/components/page-container";
import DiscoverRoot from "@/features/discover";
import { useCurrentApp } from "@/lib/workspace";

export default function DiscoverPage() {
  const { appId, app } = useCurrentApp();
  return (
    <PageContainer width="wide">
      <PageHeader title="Discover" description={`Competitors, creators and trends, connected to ${app?.name ?? "your app"}. Every finding links to its source.`} />
      <DiscoverRoot appId={appId} />
    </PageContainer>
  );
}
