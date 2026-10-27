import OpenAI from "openai";
import { AppError, type Platform, type UsageInput } from "@muselaunch/platform";

/** Who/what a provider call is for. Every call is attributed and metered. */
export interface CallContext {
  workspaceId: string;
  /** Short label for the cost ledger, e.g. "app_dna.extract", "research.search". */
  task: string;
  appId?: string;
  jobId?: string;
  agentRunId?: string;
  actor?: string;
  signal?: AbortSignal;
}

export interface MeteredResult<T> {
  value: T;
  usage: Omit<UsageInput, "task" | "appId" | "jobId" | "agentRunId" | "actor" | "runtimeMs" | "status"> & { runtimeMs?: number };
  /** Redacted request/response captured into the trace store. */
  trace?: { request: unknown; response?: unknown };
}

/** Map Meta/OpenAI-compatible API errors (documented envelope) to AppError. */
export function mapProviderError(err: unknown, provider = "Meta Model API"): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    const type = (err.error as { type?: string } | undefined)?.type ?? err.type;
    const code = (err.error as { code?: string } | undefined)?.code ?? err.code ?? undefined;
    const details = { provider, status, type, code };
    if (status === 429) return new AppError("RATE_LIMITED", `${provider} rate limited`, { retryable: true, details, cause: err });
    if (status >= 500 && status !== 504) return new AppError("PROVIDER_UNAVAILABLE", `${provider} unavailable (${status} ${code ?? ""})`, { retryable: true, details, cause: err });
    if (status === 504) return new AppError("TIMEOUT", `${provider} gateway timeout`, { retryable: false, details, cause: err });
    if (status === 401 || status === 402 || status === 403)
      return new AppError("PROVIDER_NOT_CONFIGURED", `${provider} rejected credentials or billing (${status} ${code ?? type ?? ""})`, { retryable: false, details, cause: err });
    if (status === 404) return new AppError("PROVIDER_NOT_CONFIGURED", `${provider}: ${err.message}`, { retryable: false, details, cause: err });
    if (code === "content_policy_violation")
      return new AppError("PROVIDER_ERROR", `${provider} declined the request (content policy)`, { retryable: false, details, cause: err, userMessage: "The AI service declined this request under its content policy. Try rephrasing." });
    return new AppError("PROVIDER_ERROR", `${provider}: ${err.message}`, { retryable: false, details, cause: err });
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) return new AppError("CANCELLED", "Request cancelled", { cause: err });
  if (err instanceof Error && err.name === "APIConnectionTimeoutError") return new AppError("TIMEOUT", `${provider} timed out`, { retryable: true, cause: err });
  if (err instanceof Error && err.name === "APIConnectionError") return new AppError("PROVIDER_UNAVAILABLE", `${provider} unreachable: ${err.message}`, { retryable: true, cause: err });
  return new AppError("PROVIDER_ERROR", err instanceof Error ? err.message : String(err), { cause: err });
}

/**
 * Shared Meta Model API client (https://api.meta.ai/v1, Bearer key).
 * - `openai`: OpenAI SDK pointed at Meta (Responses, Chat Completions, Files).
 * - `fetchJson`/`fetchForm`: raw endpoints the SDK does not cover (ASR, images, SAM specifics).
 * - `metered`: wraps any call with spend guard → call → usage event + redacted trace.
 * Module B owns text/agent calls, module D owns SAM/voice/image calls; both go through here.
 */
export class MetaClient {
  readonly openai: OpenAI;
  readonly baseUrl: string;
  readonly models: { wonder: string; spark: string; sam: string; voice: string; image: string };

  constructor(
    private readonly platform: Platform,
    opts: { fetch?: typeof fetch; apiKey?: string } = {},
  ) {
    const { cfg } = platform;
    this.baseUrl = cfg.META_BASE_URL.replace(/\/$/, "");
    this.models = { wonder: cfg.META_MODEL_WONDER, spark: cfg.META_MODEL_SPARK, sam: cfg.META_MODEL_SAM, voice: cfg.META_MODEL_VOICE, image: cfg.META_MODEL_IMAGE };
    this.openai = new OpenAI({
      apiKey: opts.apiKey ?? cfg.META_API_KEY ?? "missing-meta-api-key",
      baseURL: this.baseUrl,
      timeout: cfg.META_TIMEOUT_MS,
      maxRetries: 3,
      fetch: opts.fetch,
    });
    this.fetchImpl = opts.fetch ?? fetch;
    this.apiKey = opts.apiKey ?? cfg.META_API_KEY;
  }
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | undefined;

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  assertConfigured(): void {
    if (!this.apiKey) throw new AppError("PROVIDER_NOT_CONFIGURED", "META_API_KEY is not set", { userMessage: "Meta Model API isn't connected on this deployment yet." });
  }

  /** Raw JSON request with documented retry policy (429/500/503 + Retry-After, jittered backoff). */
  async fetchJson<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<{ data: T; headers: Headers }> {
    this.assertConfigured();
    return this.withRetry(async () => {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", ...init.headers },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: init.signal,
      });
      return this.parse<T>(res);
    }, init.signal);
  }

  /** Multipart request (file uploads, ASR file transcription, image edits). */
  async fetchForm<T>(path: string, form: FormData, init: { signal?: AbortSignal } = {}): Promise<{ data: T; headers: Headers }> {
    this.assertConfigured();
    return this.withRetry(async () => {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, body: form, signal: init.signal });
      return this.parse<T>(res);
    }, init.signal);
  }

  private async parse<T>(res: Response): Promise<{ data: T; headers: Headers }> {
    const text = await res.text();
    if (!res.ok) {
      let body: { error?: { message?: string; type?: string; code?: string } } = {};
      try {
        body = JSON.parse(text);
      } catch {
        /* plain text error */
      }
      const err = new OpenAI.APIError(res.status, body.error ?? { message: text || res.statusText }, body.error?.message ?? (text || res.statusText), res.headers);
      throw Object.assign(err, { retryAfter: res.headers.get("retry-after") });
    }
    return { data: (text ? JSON.parse(text) : {}) as T, headers: res.headers };
  }

  private async withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, attempts = 4): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number }).status ?? 0;
        const retryable = status === 429 || status === 500 || status === 503 || (err as Error).name === "TypeError";
        if (!retryable || i === attempts - 1 || signal?.aborted) break;
        const retryAfter = Number((err as { retryAfter?: string }).retryAfter ?? 0);
        const backoff = Math.max(retryAfter * 1000, 500 * 2 ** i) + Math.random() * 1000;
        await new Promise((r) => setTimeout(r, Math.min(backoff, 60_000)));
      }
    }
    throw mapProviderError(lastErr);
  }

  /**
   * Meter a provider call: spend guard → call → usage event (always, even on error) → trace.
   * `estimatedUsd` should be a conservative upper bound for the call.
   */
  async metered<T>(ctx: CallContext, meta: { model: string; operation: UsageInput["operation"]; estimatedUsd: number }, fn: () => Promise<MeteredResult<T>>): Promise<T> {
    this.assertConfigured();
    await this.platform.usage.guard(ctx.workspaceId, meta.estimatedUsd);
    const started = Date.now();
    try {
      const { value, usage, trace } = await fn();
      await this.platform.usage.record(
        ctx.workspaceId,
        {
          ...usage,
          provider: usage.provider ?? "meta",
          model: usage.model ?? meta.model,
          operation: usage.operation ?? meta.operation,
          task: ctx.task,
          appId: ctx.appId,
          jobId: ctx.jobId,
          agentRunId: ctx.agentRunId,
          actor: ctx.actor,
          runtimeMs: usage.runtimeMs ?? Date.now() - started,
          status: "ok",
          dataMode: usage.dataMode ?? "standard",
        },
        trace,
      );
      return value;
    } catch (raw) {
      const err = mapProviderError(raw);
      await this.platform.usage
        .record(ctx.workspaceId, {
          provider: "meta",
          model: meta.model,
          operation: meta.operation,
          task: ctx.task,
          appId: ctx.appId,
          jobId: ctx.jobId,
          agentRunId: ctx.agentRunId,
          actor: ctx.actor,
          runtimeMs: Date.now() - started,
          costUsdEstimate: 0,
          status: "error",
          errorCode: err.code,
          dataMode: "standard",
        })
        .catch(() => {});
      throw err;
    }
  }
}

const clients = new WeakMap<Platform, MetaClient>();
export function metaClient(platform: Platform): MetaClient {
  let c = clients.get(platform);
  if (!c) {
    c = new MetaClient(platform);
    clients.set(platform, c);
  }
  return c;
}
