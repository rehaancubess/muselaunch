"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import { PageContainer } from "@/components/page-container";
import { CreatePage } from "@/features/create/create-page";
import { readPrefill } from "@/features/create/plan";

/**
 * Create: "What would you like to make?" (Promote my app, Show a feature, Use a suggested idea), one
 * prompt, format and length, "Generate video" with the real credit estimate, then Your content.
 * Other pages deep-link with routes.app(wid, appId).create({ kind, prompt, ideaId }).
 */
function CreateRoute() {
  const params = useSearchParams();
  const query = params.toString();
  const prefill = useMemo(() => readPrefill((k) => params.get(k)), [params]);
  // A new deep link (e.g. from Results while already here) starts the form over with its prefill.
  return <CreatePage key={query} prefill={prefill} />;
}

export default function CreateRoutePage() {
  return (
    <PageContainer className="pt-6 md:pt-10">
      <Suspense>
        <CreateRoute />
      </Suspense>
    </PageContainer>
  );
}
