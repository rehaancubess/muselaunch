"use client";
import { PageHeader } from "@muselaunch/ui";
import { PageContainer } from "@/components/page-container";
import SimpleInsights from "@/features/insights/simple";
import { useCurrentApp } from "@/lib/workspace";

/** Insights: "How it's going", up to three measured numbers and the next step. Everything else is behind Details (./details). */
export default function InsightsPage() {
  const { appId } = useCurrentApp();
  return (
    <PageContainer width="narrow">
      <PageHeader title="How it’s going" description="What happened after your videos went out. Only real numbers from the accounts and files you connect, never estimates." />
      <SimpleInsights appId={appId} />
    </PageContainer>
  );
}
