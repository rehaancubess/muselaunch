"use client";
/**
 * Growth Autopilot route (module B owns the body). `?goal=` is passed from the Creator home card and
 * the ⌘K palette and pre-fills the start card; `?loop=<id>` opens a specific loop.
 */
import { PageHeader } from "@muselaunch/ui";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PageContainer } from "@/components/page-container";
import AutopilotRoot from "@/features/autopilot";
import { useCurrentApp } from "@/lib/workspace";

function AutopilotBody({ appId }: { appId: string }) {
  const goal = useSearchParams().get("goal") ?? undefined;
  return <AutopilotRoot appId={appId} initialGoal={goal} />;
}

export default function AutopilotPage() {
  const { appId } = useCurrentApp();
  return (
    <PageContainer width="wide">
      <PageHeader title="Growth Autopilot" description="A bounded, approval-gated marketing loop: research, hypothesis, creative, checks, posting drafts and measurement, with every decision logged and cited." />
      <Suspense>
        <AutopilotBody appId={appId} />
      </Suspense>
    </PageContainer>
  );
}
