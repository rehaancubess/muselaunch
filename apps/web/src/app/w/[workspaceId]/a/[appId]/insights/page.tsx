"use client";
import { PageHeader } from "@muselaunch/ui";
import { PageContainer } from "@/components/page-container";
import InsightsRoot from "@/features/insights";
import { useCurrentApp } from "@/lib/workspace";

export default function InsightsPage() {
  const { appId } = useCurrentApp();
  return (
    <PageContainer width="wide">
      <PageHeader title="Insights" description="Measured results from the sources you connect, what your experiments show, and what to try next." />
      <InsightsRoot appId={appId} />
    </PageContainer>
  );
}
