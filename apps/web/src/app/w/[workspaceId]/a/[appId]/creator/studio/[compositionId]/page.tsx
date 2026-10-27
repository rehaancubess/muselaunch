"use client";
import { useParams } from "next/navigation";
import StudioRoot from "@/features/studio";

/** Full-bleed editor route; the Studio (module C) owns everything inside. */
export default function StudioPage() {
  const { compositionId } = useParams<{ compositionId: string }>();
  return <StudioRoot compositionId={String(compositionId)} />;
}
