import { SPARK_OPEN_LABEL } from "@muselaunch/contracts";
import { AppError, toAppError, type Platform } from "@muselaunch/platform";
import type { z } from "zod";
import { generateJson, generateText, type InputPart, type LlmCall, type LlmTextResult } from "./meta/llm";
import { sparkOpenClient } from "./spark-open/client";
import { sparkOpenJson, sparkOpenText } from "./spark-open/llm";

/**
 * Text-model router: Muse Spark (Meta Model API) or Muse Spark Open (open weights on Baseten).
 *
 * 1. Routing: a call names its route. It runs on Muse Spark Open when the route is listed in
 *    `SPARK_OPEN_TASKS` and `BASETEN_API_KEY` is set; otherwise on Muse Spark.
 * 2. Fallback: when a Muse Spark call fails because Meta is limited (RATE_LIMITED, PROVIDER_UNAVAILABLE,
 *    TIMEOUT — each after the SDK's own retry — or a 402 / quota / credits error) and
 *    `SPARK_OPEN_FALLBACK` is on, the SAME request runs once on Muse Spark Open. The caller must pass
 *    `onFallback`, which records a visible agent-run step; without it there is no fallback (never
 *    silent). Usage is metered under the provider that really ran (meta error + baseten ok).
 * Never routed or fallen back: Muse Wonder calls, web-search (cited) calls, Meta file-id inputs, and
 * failures that aren't about Meta's capacity (schema/validation errors, refusals, spend ceilings,
 * cancellation, bad keys). Results carry `provider` and `model`, so no output is shown as another
 * model's.
 */

/** Routes callers name. Only routes listed in SPARK_OPEN_TASKS run on Muse Spark Open; all can fall back. */
export const TEXT_ROUTES = {
  "copy.generate": "Post copy per channel and its length repair (copy.generate jobs, Autopilot post drafts)",
  "composition.variant_briefs": "Hook / audience variant briefs when a founder asks for N hooks or versions",
  "composition.edit.scoped": "Scene-scoped video edits (hook rewrites of the opening scene, Brand Guardian fixes)",
  "composition.edit": "Video edits with no scene selected (audience versions)",
  "composition.edit.repair": "Second attempt after an edit failed validation",
  "claims.validate": "Claim checks of copy and on-screen text",
  "storyboard.generate": "Storyboards",
  "concepts.generate": "Campaign concepts",
} as const;
export type TextRoute = keyof typeof TEXT_ROUTES;

export interface TextModelChoice {
  engine: "muse-spark" | "muse-spark-open";
  provider: "meta" | "baseten";
  model: string;
  /** Short name for titles and progress ("Muse Spark", "Muse Spark Open"). */
  name: string;
  /** Full UI label ("Muse Spark Open · open weights via Baseten"). */
  label: string;
  reason: string;
}

export function sparkOpenAvailable(p: Platform): boolean {
  return sparkOpenClient(p).configured;
}

function openChoice(p: Platform, reason: string): TextModelChoice {
  return { engine: "muse-spark-open", provider: "baseten", model: sparkOpenClient(p).model, name: "Muse Spark Open", label: SPARK_OPEN_LABEL, reason };
}

export function chooseTextModel(p: Platform, route: string): TextModelChoice {
  const open = sparkOpenAvailable(p);
  if (open && p.cfg.SPARK_OPEN_TASKS.includes(route)) return openChoice(p, `${route} is listed in SPARK_OPEN_TASKS`);
  return { engine: "muse-spark", provider: "meta", model: p.cfg.META_MODEL_SPARK, name: "Muse Spark", label: "Muse Spark", reason: open ? `${route} is not listed in SPARK_OPEN_TASKS` : "BASETEN_API_KEY is not set" };
}

/** For status/UI: which engine each route uses on this deployment. */
export function textRouting(p: Platform): { sparkOpen: { configured: boolean; model: string; label: string; tasks: string[]; fallback: boolean }; routes: Record<TextRoute, TextModelChoice["engine"]> } {
  const configured = sparkOpenAvailable(p);
  const routes = Object.fromEntries((Object.keys(TEXT_ROUTES) as TextRoute[]).map((r) => [r, chooseTextModel(p, r).engine])) as Record<TextRoute, TextModelChoice["engine"]>;
  return { sparkOpen: { configured, model: sparkOpenClient(p).model, label: SPARK_OPEN_LABEL, tasks: [...p.cfg.SPARK_OPEN_TASKS], fallback: configured && p.cfg.SPARK_OPEN_FALLBACK }, routes };
}

export type FallbackReason = "rate_limited" | "unavailable" | "timeout" | "credits";

/** Why a Muse Spark failure qualifies for the Spark Open fallback, or null when it doesn't. */
export function fallbackReason(err: unknown): FallbackReason | null {
  if (!(err instanceof AppError)) return null;
  const d = (err.opts.details ?? {}) as { status?: number; code?: string | null };
  if (d.status === 402) return "credits";
  if (err.code === "RATE_LIMITED") return /quota|credit|billing/i.test(String(d.code ?? "")) ? "credits" : "rate_limited";
  if (err.code === "PROVIDER_UNAVAILABLE") return "unavailable";
  if (err.code === "TIMEOUT") return "timeout";
  return null;
}

const WHY: Record<FallbackReason, string> = {
  rate_limited: "Muse Spark was rate-limited",
  unavailable: "Muse Spark was unavailable",
  timeout: "Muse Spark timed out",
  credits: "Meta Model API credits ran out",
};

export interface FallbackEvent {
  route: string;
  task: string;
  reason: FallbackReason;
  /** e.g. "Muse Spark was rate-limited; used Muse Spark Open (open weights) instead". */
  title: string;
  status: "succeeded" | "failed";
  from: { provider: "meta"; model: string; name: string };
  to: { provider: "baseten"; model: string; name: string; label: string };
  error: { code: string; message: string; status?: number };
  fallbackError?: { code: string; message: string };
}

export interface RouteOptions {
  route: string;
  /** Records the visible agent-run step. Required for a fallback to happen. */
  onFallback?: (e: FallbackEvent) => Promise<void> | void;
}

export type Routed<T extends LlmTextResult> = T & { provider: "meta" | "baseten"; fallback?: FallbackEvent };

const usesFileIds = (input: LlmCall["input"]) => typeof input !== "string" && input.some((x: InputPart) => x.type === "input_image" && Boolean(x.file_id));

async function run<T extends LlmTextResult>(p: Platform, call: LlmCall, opts: RouteOptions, onMeta: () => Promise<T>, onOpen: () => Promise<T>): Promise<Routed<T>> {
  const eligible = call.model !== "wonder" && !call.webSearch && !usesFileIds(call.input);
  if (eligible && chooseTextModel(p, opts.route).engine === "muse-spark-open") return { ...(await onOpen()), provider: "baseten" };
  try {
    return { ...(await onMeta()), provider: "meta" };
  } catch (raw) {
    const err = toAppError(raw);
    const reason = fallbackReason(err);
    if (!reason || !eligible || !opts.onFallback || !p.cfg.SPARK_OPEN_FALLBACK || !sparkOpenAvailable(p) || call.ctx.signal?.aborted) throw err;
    const to = openChoice(p, `fallback: ${reason}`);
    const event: FallbackEvent = {
      route: opts.route,
      task: call.ctx.task,
      reason,
      title: `${WHY[reason]}; used Muse Spark Open (open weights) instead`,
      status: "succeeded",
      from: { provider: "meta", model: p.cfg.META_MODEL_SPARK, name: "Muse Spark" },
      to: { provider: "baseten", model: to.model, name: to.name, label: to.label },
      error: { code: err.code, message: err.message.slice(0, 300), ...(typeof (err.opts.details as { status?: unknown } | undefined)?.status === "number" ? { status: (err.opts.details as { status: number }).status } : {}) },
    };
    let out: T;
    try {
      out = await onOpen();
    } catch (raw2) {
      const err2 = toAppError(raw2);
      await Promise.resolve(opts.onFallback({ ...event, status: "failed", title: `${WHY[reason]}; the Muse Spark Open (open weights) fallback also failed`, fallbackError: { code: err2.code, message: err2.message.slice(0, 300) } })).catch(() => {});
      // Keep Meta's error (and its retry semantics) for the job layer; name the fallback failure too.
      throw new AppError(err.code, `${err.message}; the Muse Spark Open fallback also failed (${err2.code}: ${err2.message.slice(0, 200)})`, {
        retryable: err.retryable,
        details: { ...(err.opts.details ?? {}), fallback: { provider: "baseten", code: err2.code, message: err2.message.slice(0, 300) } },
        userMessage: err.opts.userMessage,
        cause: err,
      });
    }
    // Recorded after the answer arrives, so the step says what really happened; a failure to record it
    // fails the call rather than returning an unrecorded fallback.
    await opts.onFallback(event);
    return { ...out, provider: "baseten", fallback: event };
  }
}

/** Structured generation on the routed engine (Zod-validated, one repair attempt on either engine). */
export async function routedJson<S extends z.ZodTypeAny>(p: Platform, call: LlmCall & { schema: S; schemaName: string }, opts: RouteOptions): Promise<Routed<LlmTextResult & { data: z.infer<S> }>> {
  return run(p, call, opts, () => generateJson(p, call), () => sparkOpenJson(p, call));
}

/** Free text on the routed engine (search-grounded calls always stay on Muse Spark). */
export async function routedText(p: Platform, call: LlmCall, opts: RouteOptions): Promise<Routed<LlmTextResult>> {
  return run(p, call, opts, () => generateText(p, call), () => sparkOpenText(p, call));
}
