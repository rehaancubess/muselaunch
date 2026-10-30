"use client";
import { Suspense } from "react";
import { LibraryPage } from "@/components/library/library-page";

export default function LibraryRoute() {
  // LibraryPage reads `?asset=` (useSearchParams): keep it inside a Suspense boundary.
  return (
    <Suspense>
      <LibraryPage />
    </Suspense>
  );
}
