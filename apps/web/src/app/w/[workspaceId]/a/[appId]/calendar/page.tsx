"use client";
import { PageHeader } from "@muselaunch/ui";
import { PageContainer } from "@/components/page-container";
import CalendarRoot from "@/features/publishing";
import { useCurrentApp } from "@/lib/workspace";

export default function CalendarPage() {
  const { appId } = useCurrentApp();
  return (
    <PageContainer width="wide">
      <PageHeader title="Calendar" description="Schedule approved creatives, export posting packages, and publish to accounts you’ve authorised." />
      <CalendarRoot appId={appId} />
    </PageContainer>
  );
}
