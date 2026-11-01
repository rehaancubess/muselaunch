"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PageContainer } from "@/components/page-container";
import { NeedsYouPage } from "@/features/autopilot/needs-you";

function Body() {
  // `?appId=` narrows the list to one app.
  return <NeedsYouPage appId={useSearchParams().get("appId")} />;
}

/** Every decision waiting on a person in this workspace, grouped by app. */
export default function NeedsYouRoute() {
  return (
    <PageContainer width="narrow">
      <Suspense>
        <Body />
      </Suspense>
    </PageContainer>
  );
}
