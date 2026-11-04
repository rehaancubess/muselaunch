"use client";
import { PageContainer } from "@/components/page-container";
import { HomePage } from "@/features/today/home";

/**
 * Home (the app opens here): what's ready to review, what's coming up, and everything else that waits
 * on you. While the first run is still making the first videos, its progress screen.
 */
export default function AppHomePage() {
  return (
    <PageContainer width="wide" className="pt-6 md:pt-10">
      <HomePage />
    </PageContainer>
  );
}
