import { AppError, type Platform, type UsageInput } from "@muselaunch/platform";
import type { ModelUsageEvent } from "@muselaunch/contracts";
import type { CallContext } from "../meta/client";

/**
 * Metering for non-Meta providers (OpenAI images/TTS, stock APIs): spend guard → call → usage event
 * (always, even on error) with a redacted trace. Mirrors `MetaClient.metered` but records the
 * provider/dataMode of the third party and returns the usage event so callers can link it.
 */
export async function meterExternal<T>(
  p: Platform,
  ctx: CallContext,
  meta: { provider: UsageInput["provider"]; model: string; operation: UsageInput["operation"]; estimatedUsd: number },
  fn: () => Promise<{ value: T; usage?: Partial<Pick<UsageInput, "images" | "frames" | "audioSeconds" | "inputTokens" | "outputTokens" | "requestId">> & { costUsdEstimate: number }; trace?: { request: unknown; response?: unknown } }>,
): Promise<{ value: T; usageEvent: ModelUsageEvent }> {
  if (meta.estimatedUsd > 0) await p.usage.guard(ctx.workspaceId, meta.estimatedUsd);
  const started = Date.now();
  const base = {
    provider: meta.provider,
    model: meta.model,
    operation: meta.operation,
    task: ctx.task,
    appId: ctx.appId,
    jobId: ctx.jobId,
    agentRunId: ctx.agentRunId,
    actor: ctx.actor,
    dataMode: "third_party" as const,
  };
  try {
    const { value, usage, trace } = await fn();
    const usageEvent = await p.usage.record(ctx.workspaceId, { ...base, ...usage, costUsdEstimate: usage?.costUsdEstimate ?? 0, runtimeMs: Date.now() - started, status: "ok" }, trace);
    return { value, usageEvent };
  } catch (raw) {
    const err = raw instanceof AppError ? raw : (raw as Error)?.name === "AbortError" ? new AppError("CANCELLED", "Request cancelled", { cause: raw }) : new AppError("PROVIDER_ERROR", (raw as Error)?.message ?? String(raw), { cause: raw });
    await p.usage.record(ctx.workspaceId, { ...base, costUsdEstimate: 0, runtimeMs: Date.now() - started, status: "error", errorCode: err.code }).catch(() => {});
    throw err;
  }
}

/** Map an HTTP error from an OpenAI-compatible endpoint to AppError (documented error envelope). */
export async function httpError(res: Response, provider: string): Promise<AppError> {
  let message = res.statusText;
  let code: string | undefined;
  let type: string | undefined;
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string; type?: string } };
    message = body.error?.message ?? message;
    code = body.error?.code;
    type = body.error?.type;
  } catch {
    /* non-JSON error body */
  }
  const details = { provider, status: res.status, code, type };
  if (res.status === 429) return new AppError("RATE_LIMITED", `${provider} rate limited`, { retryable: true, details });
  if (res.status === 401 || res.status === 403) return new AppError("PROVIDER_NOT_CONFIGURED", `${provider} rejected credentials (${res.status})`, { retryable: false, details });
  if (code === "content_policy_violation" || code === "moderation_blocked")
    return new AppError("PROVIDER_ERROR", `${provider} declined the request (content policy)`, { retryable: false, details, userMessage: "The image service declined this request under its content policy. Try rephrasing." });
  if (res.status >= 500) return new AppError("PROVIDER_UNAVAILABLE", `${provider} unavailable (${res.status})`, { retryable: res.status !== 500 || provider !== "Muse Image", details });
  return new AppError("PROVIDER_ERROR", `${provider}: ${message}`, { retryable: false, details });
}
