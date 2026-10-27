"use client";
/**
 * Growth Autopilot route. Module B owns the page body: when `features/autopilot` lands, replace the
 * placeholder below with `<AutopilotRoot appId={appId} initialGoal={goal} />` (keep the shell wrapper).
 * `?goal=` is passed from the Creator home card and the ⌘K palette.
 */
import { EmptyState, PageHeader } from "@muselaunch/ui";
import { Rocket } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PageContainer } from "@/components/page-container";

function AutopilotPlaceholder() {
  const goal = useSearchParams().get("goal");
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-surface">
      <EmptyState
        size="lg"
        icon={<Rocket aria-hidden />}
        title="Growth Autopilot isn’t in this build yet"
        description={goal ? `Your goal “${goal}” will start a bounded loop here once the Autopilot service is deployed.` : "Muse Wonder will research, pick an audience, test a hypothesis, produce and check the creative, and draft posts for your approval, within a credit budget you set."}
      />
    </div>
  );
}

export default function AutopilotPage() {
  return (
    <PageContainer width="wide">
      <PageHeader title="Growth Autopilot" description="A bounded, approval-gated marketing loop: research, hypothesis, creative, checks, posting drafts and measurement, with every decision logged and cited." />
      <Suspense>
        <AutopilotPlaceholder />
      </Suspense>
    </PageContainer>
  );
}
