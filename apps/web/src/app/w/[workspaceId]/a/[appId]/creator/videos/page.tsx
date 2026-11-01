"use client";
import { Suspense } from "react";
import { CreatorFrame } from "@/components/creator/creator-tabs";
import { LibraryPage } from "@/components/library/library-page";

/** Creator → Videos: the app's files (what used to be the Library). `?asset=<id>` opens one. */
export default function CreatorVideosPage() {
  return (
    <CreatorFrame current="videos">
      {/* LibraryPage reads `?asset=` (useSearchParams): keep it inside a Suspense boundary. */}
      <Suspense>
        <LibraryPage embedded />
      </Suspense>
    </CreatorFrame>
  );
}
