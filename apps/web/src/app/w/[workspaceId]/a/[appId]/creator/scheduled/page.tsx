"use client";
import { PageHeader } from "@muselaunch/ui";
import { CreatorFrame } from "@/components/creator/creator-tabs";
import CalendarRoot from "@/features/publishing";
import { useCurrentApp } from "@/lib/workspace";

/** Creator → Scheduled: posts, approvals and publishing (what used to be the Calendar). */
export default function CreatorScheduledPage() {
  const { appId } = useCurrentApp();
  return (
    <CreatorFrame current="scheduled">
      <PageHeader title="Scheduled posts" description="Approved videos on a calendar. Post them to accounts you’ve connected, or download a posting package and post them yourself." />
      <CalendarRoot appId={appId} />
    </CreatorFrame>
  );
}
