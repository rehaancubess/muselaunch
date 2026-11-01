"use client";
/**
 * Autopilot route (module B owns the body: features/autopilot). Onboarding lands here after Go
 * (`?loop=<id>`: the run's calm progress screen). `?goal=` (from the Creator and the ⌘K palette)
 * pre-fills a new run; `?loop=<id>` opens a specific run; `?details=1` opens its details.
 */
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
      <div className="pb-14 pt-2 md:pt-6">
        <Suspense>
          <AutopilotBody appId={appId} />
        </Suspense>
      </div>
    </PageContainer>
  );
}
