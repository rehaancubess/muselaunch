"use client";
import type { ProviderStatusResponse, TextEngine } from "@/lib/api-types";
import { useApiQuery } from "@/lib/query";

/**
 * The text model a route will use on this deployment (Muse Spark or Muse Spark Open), from
 * `GET /v1/status/providers` → `textRouting`. Used for labels shown BEFORE a job runs; results name
 * the model that actually answered (patch.model, run steps), which can differ after a fallback.
 * Routes: providers/router.ts TEXT_ROUTES.
 */
export interface EngineName {
  engine: TextEngine | null;
  /** "Muse Spark", "Muse Spark Open", or "The AI" while unknown. */
  name: string;
  /** "Muse Spark", "Muse Spark Open · open weights via Baseten", or "AI" while unknown. */
  label: string;
}

export function useTextEngine(route: string): EngineName {
  const q = useApiQuery<ProviderStatusResponse>("/v1/status/providers", { staleTime: 60_000 });
  return engineName(q.data?.textRouting?.routes[route] ?? null, q.data?.textRouting?.sparkOpen.label);
}

export function engineName(engine: TextEngine | null, openLabel = "Muse Spark Open · open weights via Baseten"): EngineName {
  if (engine === "muse-spark-open") return { engine, name: "Muse Spark Open", label: openLabel };
  if (engine === "muse-spark") return { engine, name: "Muse Spark", label: "Muse Spark" };
  return { engine: null, name: "The AI", label: "AI" };
}

/** Spark Open routes and fallback on this deployment (for one-line explanations). */
export function useSparkOpenRouting() {
  const q = useApiQuery<ProviderStatusResponse>("/v1/status/providers", { staleTime: 60_000 });
  return q.data?.textRouting?.sparkOpen ?? null;
}
