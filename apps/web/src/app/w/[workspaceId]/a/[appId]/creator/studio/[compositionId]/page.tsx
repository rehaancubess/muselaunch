"use client";
import { useParams } from "next/navigation";
import { Suspense } from "react";
import StudioRoot from "@/features/studio";

/**
 * Full-bleed Studio route; the Studio (module C) owns everything inside. It opens simple by default;
 * `?mode=detail` opens the full editor (read with useSearchParams, hence the Suspense boundary).
 */
export default function StudioPage() {
  const { compositionId } = useParams<{ compositionId: string }>();
  return (
    <Suspense>
      <StudioRoot compositionId={String(compositionId)} />
    </Suspense>
  );
}
