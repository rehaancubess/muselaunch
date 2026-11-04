"use client";
import { PageContainer } from "@/components/page-container";
import Results from "@/features/results";
import { useCurrentApp } from "@/lib/workspace";

/** Results: "See what is working": measured numbers, a daily chart, the best post and one tip. */
export default function ResultsPage() {
  const { appId } = useCurrentApp();
  return (
    <PageContainer className="max-w-[960px]">
      <Results appId={appId} />
    </PageContainer>
  );
}
