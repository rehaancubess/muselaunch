"use client";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { useEffect } from "react";
import { env } from "./env";

export interface RuntimeInfo {
  ok: boolean;
  /** True only when the API runs the local fixture entrypoint (apps/api/src/dev-fixture.ts). */
  fixtureMode: boolean;
  sampleListing?: string;
  db?: string;
  storage?: string;
  jobs?: string;
}

/** Public `GET /health` (no auth). Drives the fixture-mode banner and provider labels. */
export function useRuntime() {
  return useQuery<RuntimeInfo>({
    queryKey: ["__runtime__"],
    queryFn: async () => {
      const res = await fetch(`${env.apiUrl}/health`, { cache: "no-store" });
      const j = (await res.json()) as Partial<RuntimeInfo>;
      return { ok: Boolean(j.ok), fixtureMode: j.fixtureMode === true, sampleListing: j.sampleListing, db: j.db, storage: j.storage, jobs: j.jobs };
    },
    staleTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/**
 * Persistent strip shown on every screen when the API answers AI calls from labelled fixtures.
 * Never shown against a real deployment (its /health has no `fixtureMode`).
 */
export function FixtureBanner() {
  const rt = useRuntime();
  const on = Boolean(rt.data?.fixtureMode);
  // Full-height screens (the Studio) size themselves from --ml-topbar-h; include the banner.
  useEffect(() => {
    if (!on) return;
    document.documentElement.style.setProperty("--ml-topbar-h", "84px");
    return () => {
      document.documentElement.style.removeProperty("--ml-topbar-h");
    };
  }, [on]);
  if (!on) return null;
  return (
    <div role="status" className="relative z-50 flex h-7 items-center justify-center gap-2 overflow-hidden whitespace-nowrap bg-warning-soft px-4 text-center text-caption text-warning">
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      <span>
        <strong className="font-semibold">Fixture mode.</strong> <span className="sm:hidden">AI output comes from test fixtures.</span>
        <span className="hidden sm:inline">AI responses come from labelled test fixtures, not live models.</span>
        {rt.data?.sampleListing ? (
          <span className="hidden md:inline">
            {" "}
            Sample listing: <span className="select-all font-medium">{rt.data?.sampleListing}</span>
          </span>
        ) : null}
      </span>
    </div>
  );
}
