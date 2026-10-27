"use client";
/**
 * Owner: module E. Marketing calendar, approvals and authorised publishing / export packages.
 * Rendered by .../a/[appId]/calendar/page.tsx inside <PageContainer width="wide">.
 */
import { CalendarDays } from "lucide-react";
import { FeaturePlaceholder } from "../_placeholder";

export interface CalendarRootProps {
  appId: string;
}

export default function CalendarRoot(_props: CalendarRootProps) {
  return (
    <FeaturePlaceholder
      icon={<CalendarDays aria-hidden />}
      title="Your marketing calendar will appear here"
      description="Approved creatives can be scheduled, exported as a posting package, or published to accounts you connect. Nothing is posted without your approval."
    />
  );
}
