"use client";
import { PageContainer } from "@/components/page-container";
import { TodayPage } from "@/features/today/today";

/**
 * Creator → Today: the one page the Creator tab opens on (the next post, what needs you, how it's
 * going, what Muse found, your videos). Make, Videos and Scheduled stay one tap away from it.
 */
export default function CreatorTodayPage() {
  return (
    <PageContainer width="wide" className="pt-5 md:pt-8">
      <TodayPage />
    </PageContainer>
  );
}
