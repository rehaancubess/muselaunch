import { modelDisplayName } from "@muselaunch/contracts";
import type { Platform } from "@muselaunch/platform";
import { chooseTextModel, routedJson, type FallbackEvent, type LlmCall, type TextModelChoice, type TextRoute } from "@muselaunch/providers";
import type { z } from "zod";
import type { RunRecorder } from "./runs";

/**
 * Module B's entry to the text-model router (providers/router.ts): Spark-role structured calls run on
 * Muse Spark or Muse Spark Open per route, and a Meta capacity failure falls back to Spark Open once,
 * recorded as a visible step on the run. Titles name the model that actually answered.
 */

/** "Muse Spark" or "Muse Spark Open", from the model id that answered (never assumed). */
export const engineName = (model: string): string => modelDisplayName(model, { short: true });

/** The engine a route will use on this deployment (for run records and progress text before the call). */
export const plannedEngine = (p: Platform, route: TextRoute): TextModelChoice => chooseTextModel(p, route);

/** Fallback recorder for helpers that take an `onFallback` callback. */
export const fallbackTo = (rec: RunRecorder | null | undefined) => (rec ? (e: FallbackEvent) => rec.fallbackStep(e).then(() => undefined) : undefined);

export function sparkJson<S extends z.ZodTypeAny>(p: Platform, rec: RunRecorder | null, route: TextRoute, call: LlmCall & { schema: S; schemaName: string }) {
  return routedJson(p, { ...call, model: "spark" }, { route, onFallback: fallbackTo(rec) });
}
