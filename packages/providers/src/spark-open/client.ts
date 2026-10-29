import { SPARK_OPEN_MODEL } from "@muselaunch/contracts";
import { AppError, type Platform } from "@muselaunch/platform";
import { retryAfterMs, type CallContext } from "../meta/client";
import { UNTRUSTED_GUARD, type InputPart } from "../meta/llm";
import { approxTokens, PRICES, tokenCost } from "../pricing";

/**
 * Muse Spark Open: Meta's open-weights Muse Spark model, served by Baseten Model APIs
 * (`BASETEN_BASE_URL` = https://inference.baseten.co/v1, OpenAI-compatible Chat Completions, Bearer key,
 * model `SPARK_OPEN_MODEL` = meta-models/muse-spark-open-1026; the key works with that slug only).
 *
 * How this follows Baseten's docs:
 * - Reasoning (inference/model-apis/reasoning): "The message object returns reasoning in
 *   `reasoning_content` and the final answer in `content`", and "Beam and Muse Spark Open always
 *   reason". The answer is `content` only. Reasoning (`reasoning_content`; `reasoning` or inline
 *   `<think>…</think>` are accepted defensively) is private: never returned as the answer, never shown,
 *   never written to traces (only its length).
 * - Effort: `reasoning_effort` low|medium|high|xhigh, default xhigh ("none and minimal run at low").
 *   We always send the caller's effort so a copy step doesn't reason at xhigh.
 * - Reasoning tokens are part of `completion_tokens` and billed as output; `completion_tokens_details
 *   .reasoning_tokens` is recorded too. Reasoning shares `max_tokens` with the answer, so headroom is
 *   added per effort (REASONING_HEADROOM).
 * - No structured outputs or JSON mode for Muse Spark Open (model-apis overview), so JSON is prompted
 *   and validated in ./llm.ts. `n` > 1 returns 400 and logprobs are ignored: neither is ever sent.
 * - Errors (inference/errors): 429 → back off, honouring Retry-After; 529 overloaded → retry with
 *   backoff, waiting at least Retry-After; 500/502/503 transient → retry; 504 sync timeout; 402 billing /
 *   credits → never retried; 401/403 key; 404 model. A stream can end early after a 200 without an error
 *   event, so a streamed answer counts only once a `finish_reason` arrived.
 *
 * Every call passes the spend guard and is metered (provider `baseten`, dataMode `third_party`), and a
 * failed call that was still billed (cut off, refused, empty, stream dropped) records its tokens.
 */

export type SparkOpenEffort = "low" | "medium" | "high" | "xhigh";

/** Reasoning shares `max_tokens` with the answer: added on top of the caller's answer budget. */
export const REASONING_HEADROOM: Record<SparkOpenEffort, number> = { low: 2_048, medium: 4_096, high: 8_192, xhigh: 16_384 };
/** Chat Completions reference: `max_tokens` 1–262144. */
const MAX_TOKENS_CAP = 262_144;
/** Vision docs: Muse Spark Open takes at most 8 images per request. */
export const SPARK_OPEN_MAX_IMAGES = 8;
/** Longest Retry-After we wait for inline; longer waits surface as RATE_LIMITED for the job layer. */
const MAX_INLINE_RETRY_WAIT_MS = 60_000;
/** One quick inline retry; jobs retry again, so more would multiply billed calls. */
const INLINE_ATTEMPTS = 2;

export interface SparkOpenRequest {
  /** System instructions (trusted). */
  instructions: string;
  /** User content. Untrusted material must already be wrapped with `untrusted()`. */
  input: string | InputPart[];
  /** Budget for the answer; reasoning headroom is added. Default 4000. */
  maxOutputTokens?: number;
  reasoningEffort?: SparkOpenEffort;
  temperature?: number;
  /** Stream with `stream_options.include_usage` (default true): long reasoning stays on a live connection. */
  stream?: boolean;
}

export interface SparkOpenUsage {
  inputTokens: number;
  /** `completion_tokens`, reasoning included (that's how it is billed). */
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface SparkOpenResult {
  /** The final answer (`content`), never reasoning. */
  content: string;
  /** Private reasoning. Never shown to users, never traced. */
  reasoning: string;
  reasoningSource: "reasoning_content" | "reasoning" | "think_tags" | "none";
  finishReason?: string;
  /** The slug requested and billed (SPARK_OPEN_MODEL). */
  model: string;
  /** `model` as echoed by the response (kept for audit). */
  responseModel?: string;
  requestId?: string;
  usage: SparkOpenUsage;
  /** True when the response carried no `usage` and tokens were approximated from text length. */
  usageEstimated: boolean;
  costUsd: number;
  runtimeMs: number;
  /** Documented `x-ratelimit-*` response headers, when present. */
  rateLimit: Record<string, string>;
}

interface BilledSparkOpen {
  requestId?: string;
  usage: SparkOpenUsage;
  usageEstimated: boolean;
}
const billedUsage = new WeakMap<Error, BilledSparkOpen>();

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
}
interface ChatMessageLike {
  content?: string | { type?: string; text?: string }[] | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  refusal?: string | null;
}
interface ChatChunk {
  id?: string;
  model?: string;
  choices?: { message?: ChatMessageLike; delta?: ChatMessageLike; finish_reason?: string | null }[];
  usage?: RawUsage | null;
}

interface Collected {
  id?: string;
  model?: string;
  content: string;
  reasoning: string;
  reasoningField?: "reasoning_content" | "reasoning";
  refusal?: string;
  finishReason?: string;
  usage?: RawUsage;
  streamed: boolean;
  sawDone: boolean;
  chunks: number;
  streamError?: unknown;
}

const RATE_LIMIT_HEADERS = ["x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens"];

export class SparkOpenClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly platform: Platform,
    opts: { fetch?: typeof fetch; apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    const { cfg } = platform;
    this.baseUrl = (opts.baseUrl ?? cfg.BASETEN_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? cfg.SPARK_OPEN_MODEL;
    this.timeoutMs = opts.timeoutMs ?? cfg.SPARK_OPEN_TIMEOUT_MS;
    this.apiKey = opts.apiKey ?? cfg.BASETEN_API_KEY;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  assertConfigured(): void {
    if (!this.apiKey) throw new AppError("PROVIDER_NOT_CONFIGURED", "BASETEN_API_KEY is not set", { userMessage: "Muse Spark Open (Baseten) isn't connected on this deployment." });
  }

  /** USD for these tokens at the published Muse Spark Open price (PRICES, overridable). */
  cost(usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }): number {
    return tokenCost(PRICES.tokens[this.model] ? this.model : SPARK_OPEN_MODEL, usage);
  }

  /** Attach what a failed call was still billed for, so the error path meters it instead of $0. */
  static billed<E extends Error>(err: E, b: BilledSparkOpen): E {
    billedUsage.set(err, b);
    return err;
  }

  /** One metered Chat Completions call: spend guard → call → usage event (always) → redacted trace. */
  async chat(ctx: CallContext, req: SparkOpenRequest): Promise<SparkOpenResult> {
    this.assertConfigured();
    const effort = req.reasoningEffort ?? "medium";
    const maxTokens = Math.min(MAX_TOKENS_CAP, Math.max(1, req.maxOutputTokens ?? 4000) + REASONING_HEADROOM[effort]);
    const user = toUserContent(req.input);
    const stream = req.stream ?? true;
    const request = {
      model: this.model,
      messages: [
        { role: "system", content: `${req.instructions}\n\n${UNTRUSTED_GUARD}` },
        { role: "user", content: user.content },
      ],
      max_tokens: maxTokens,
      reasoning_effort: effort,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
    const promptEstimate = approxTokens(`${req.instructions}\n${UNTRUSTED_GUARD}\n${user.text}`) + user.images * 1500 + 50;
    await this.platform.usage.guard(ctx.workspaceId, this.cost({ inputTokens: promptEstimate, outputTokens: maxTokens }));
    const started = Date.now();
    const meta = { provider: "baseten" as const, model: this.model, operation: "chat" as const, task: ctx.task, appId: ctx.appId, jobId: ctx.jobId, agentRunId: ctx.agentRunId, actor: ctx.actor, dataMode: "third_party" as const };
    try {
      const { collected: c, headers } = await this.send(request, ctx.signal);
      const rateLimit: Record<string, string> = {};
      for (const h of RATE_LIMIT_HEADERS) {
        const v = headers.get(h);
        if (v) rateLimit[h] = v;
      }
      const split = splitThink(c.content);
      const content = split.answer.trim();
      const reasoning = c.reasoning || split.reasoning;
      const reasoningSource: SparkOpenResult["reasoningSource"] = c.reasoning ? (c.reasoningField ?? "reasoning_content") : split.reasoning ? "think_tags" : "none";
      const usageEstimated = !c.usage;
      const usage = c.usage ? usageOf(c.usage) : { inputTokens: promptEstimate, outputTokens: approxTokens(c.content + c.reasoning), cachedTokens: 0, reasoningTokens: approxTokens(reasoning) };
      const requestId = c.id ?? headers.get("x-request-id") ?? headers.get("x-baseten-request-id") ?? undefined;
      const fail = (err: AppError) => SparkOpenClient.billed(err, { requestId, usage, usageEstimated });

      if (c.streamError) throw fail(streamFailure(c.streamError, ctx.signal, this.timeoutMs));
      // Docs: a stream can stop after the 200 with no error event; without a finish_reason it is incomplete.
      if (c.streamed && !c.finishReason) {
        throw fail(new AppError("PROVIDER_UNAVAILABLE", "Muse Spark Open stream ended before completion (no finish_reason)", { retryable: true, details: { provider: "Baseten", sawDone: c.sawDone, chunks: c.chunks } }));
      }
      if (c.finishReason === "length") {
        throw fail(
          new AppError("PROVIDER_ERROR", content ? `Muse Spark Open's answer was cut off at max_tokens (${maxTokens})` : `Muse Spark Open used all ${maxTokens} max_tokens while reasoning and returned no answer`, {
            retryable: false,
            details: { provider: "Baseten", finishReason: "length", maxTokens, completionTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens },
          }),
        );
      }
      if (c.finishReason === "content_filter") throw fail(new AppError("PROVIDER_ERROR", "Muse Spark Open's answer was stopped by a content filter", { retryable: false, userMessage: "The AI model declined this request. Try rephrasing it." }));
      if (!content) {
        // A refusal with no answer is final: don't pay for a JSON repair or a job retry.
        if (c.refusal) throw fail(new AppError("PROVIDER_ERROR", `Muse Spark Open refused: ${c.refusal.slice(0, 300)}`, { retryable: false, userMessage: "The AI model declined this request. Try rephrasing it." }));
        throw fail(new AppError("PROVIDER_ERROR", "Muse Spark Open returned an empty answer", { retryable: true, details: { provider: "Baseten", finishReason: c.finishReason, reasoningChars: reasoning.length } }));
      }

      const result: SparkOpenResult = {
        content,
        reasoning,
        reasoningSource,
        finishReason: c.finishReason,
        model: this.model,
        responseModel: c.model,
        requestId,
        usage,
        usageEstimated,
        costUsd: this.cost(usage),
        runtimeMs: Date.now() - started,
        rateLimit,
      };
      await this.platform.usage.record(
        ctx.workspaceId,
        {
          ...meta,
          requestId: requestId?.slice(0, 200),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          reasoningTokens: usage.reasoningTokens,
          images: user.images || undefined,
          runtimeMs: result.runtimeMs,
          costUsdEstimate: result.costUsd,
          status: "ok",
        },
        // Reasoning is private: the trace keeps its length and where it arrived, not its text.
        {
          request,
          response: { id: c.id, model: c.model, finishReason: c.finishReason, content, reasoning: reasoning ? `[${reasoning.length} chars of private reasoning]` : undefined, reasoningSource, usage: c.usage, usageEstimated, rateLimit },
        },
      );
      return result;
    } catch (raw) {
      const err = raw instanceof AppError ? raw : new AppError("PROVIDER_ERROR", `Baseten returned an unreadable response: ${(raw as Error)?.message ?? raw}`, { retryable: true, cause: raw });
      const b = raw instanceof Error ? billedUsage.get(raw) : undefined;
      await this.platform.usage
        .record(
          ctx.workspaceId,
          {
            ...meta,
            ...(b ? { requestId: b.requestId?.slice(0, 200), inputTokens: b.usage.inputTokens, outputTokens: b.usage.outputTokens, cachedTokens: b.usage.cachedTokens, reasoningTokens: b.usage.reasoningTokens } : {}),
            images: user.images || undefined,
            runtimeMs: Date.now() - started,
            costUsdEstimate: b ? this.cost(b.usage) : 0,
            status: "error",
            errorCode: err.code,
          },
          { request, error: { code: err.code, message: err.message, details: err.opts.details, usageEstimated: b?.usageEstimated } },
        )
        .catch(() => {});
      throw err;
    }
  }

  /** POST /chat/completions with one inline retry for 429/529/5xx/network errors (Retry-After honoured). */
  private async send(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ collected: Collected; headers: Headers }> {
    let last: AppError | undefined;
    for (let attempt = 0; attempt < INLINE_ATTEMPTS; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" },
          body: JSON.stringify(body),
          signal: sig,
        });
      } catch (e) {
        const err = networkError(e, signal, this.timeoutMs);
        if (err.code !== "PROVIDER_UNAVAILABLE" || attempt === INLINE_ATTEMPTS - 1) throw err;
        last = err;
        await this.sleep(backoff(attempt));
        continue;
      }
      if (!res.ok) {
        const err = await httpError(res, this.model);
        const wait = retryAfterMs(res.headers.get("retry-after"));
        if (!err.retryable || attempt === INLINE_ATTEMPTS - 1 || signal?.aborted || (wait !== undefined && wait > MAX_INLINE_RETRY_WAIT_MS)) throw err;
        last = err;
        // Docs: for 529 (and 429), wait at least Retry-After when present.
        await this.sleep(Math.max(wait ?? 0, backoff(attempt)));
        continue;
      }
      const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
      try {
        return { collected: sse ? await readSse(res) : readJson((await res.json()) as ChatChunk), headers: res.headers };
      } catch (e) {
        if ((e as Error)?.name === "SyntaxError") throw new AppError("PROVIDER_ERROR", "Baseten returned a response that isn't valid JSON", { retryable: true, cause: e });
        throw networkError(e, signal, this.timeoutMs);
      }
    }
    throw last ?? new AppError("PROVIDER_UNAVAILABLE", "Baseten request failed", { retryable: true });
  }
}

const backoff = (attempt: number) => 500 * 2 ** attempt + Math.random() * 500;

/** Map Meta-style input parts to Chat Completions parts (text + image_url; URL or data URL). */
function toUserContent(input: string | InputPart[]): { content: string | ChatPart[]; images: number; text: string } {
  if (typeof input === "string") return { content: input, images: 0, text: input };
  const parts: ChatPart[] = [];
  let images = 0;
  let text = "";
  for (const part of input) {
    if (part.type === "input_text") {
      parts.push({ type: "text", text: part.text });
      text += `${part.text}\n`;
      continue;
    }
    if (part.file_id || !part.image_url) throw new AppError("BAD_REQUEST", "Muse Spark Open takes images as URLs or data URLs, not Meta file ids");
    images++;
    parts.push({ type: "image_url", image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } });
  }
  if (images > SPARK_OPEN_MAX_IMAGES) throw new AppError("BAD_REQUEST", `Muse Spark Open accepts at most ${SPARK_OPEN_MAX_IMAGES} images per request (got ${images})`);
  return { content: parts, images, text };
}

/** Some servers leave reasoning inline as `<think>…</think>`; the answer is what follows it. */
export function splitThink(content: string): { answer: string; reasoning: string } {
  const close = content.lastIndexOf("</think>");
  if (close >= 0) return { answer: content.slice(close + "</think>".length).trim(), reasoning: content.slice(0, close).replace(/<\/?think>/g, "").trim() };
  if (/^\s*<think>/.test(content)) return { answer: "", reasoning: content.replace(/<think>/, "").trim() };
  return { answer: content, reasoning: "" };
}

function usageOf(u: RawUsage): SparkOpenUsage {
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

function textOf(content: ChatMessageLike["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
}

function readJson(body: ChatChunk): Collected {
  const c = body.choices?.[0];
  const m = c?.message ?? {};
  const reasoningField = m.reasoning_content ? "reasoning_content" : m.reasoning ? "reasoning" : undefined;
  return {
    id: body.id,
    model: body.model,
    content: textOf(m.content),
    reasoning: m.reasoning_content ?? m.reasoning ?? "",
    reasoningField,
    refusal: m.refusal ?? undefined,
    finishReason: c?.finish_reason ?? undefined,
    usage: body.usage ?? undefined,
    streamed: false,
    sawDone: false,
    chunks: 1,
  };
}

/** Collect an SSE stream. A read error keeps what arrived (billed) and is reported as `streamError`. */
async function readSse(res: Response): Promise<Collected> {
  const out: Collected = { content: "", reasoning: "", streamed: true, sawDone: false, chunks: 0 };
  const reader = res.body?.getReader();
  if (!reader) return out;
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const data = t.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      out.sawDone = true;
      return;
    }
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(data) as ChatChunk;
    } catch {
      return;
    }
    out.chunks++;
    out.id ??= chunk.id;
    out.model ??= chunk.model;
    for (const c of chunk.choices ?? []) {
      const d = c.delta ?? c.message ?? {};
      out.content += textOf(d.content);
      if (d.reasoning_content) {
        out.reasoning += d.reasoning_content;
        out.reasoningField ??= "reasoning_content";
      } else if (d.reasoning) {
        out.reasoning += d.reasoning;
        out.reasoningField ??= "reasoning";
      }
      if (d.refusal) out.refusal = (out.refusal ?? "") + d.refusal;
      if (c.finish_reason) out.finishReason = c.finish_reason;
    }
    if (chunk.usage) out.usage = chunk.usage;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) handle(buf);
  } catch (err) {
    out.streamError = err;
  }
  return out;
}

function errorMessageOf(text: string): string {
  if (!text) return "";
  try {
    const body = JSON.parse(text) as { error?: string | { message?: string }; message?: string; detail?: string };
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error.message === "string") return body.error.message;
    if (typeof body.message === "string") return body.message;
    if (typeof body.detail === "string") return body.detail;
  } catch {
    /* plain text */
  }
  return text.slice(0, 300);
}

/** Documented Baseten statuses → AppError. 402 (credits/billing) is never retried. */
async function httpError(res: Response, model: string): Promise<AppError> {
  const message = errorMessageOf(await res.text().catch(() => "")) || res.statusText || `HTTP ${res.status}`;
  const retryAfter = res.headers.get("retry-after") ?? undefined;
  const s = res.status;
  const details: Record<string, unknown> = { provider: "Baseten", status: s, message: message.slice(0, 300), ...(retryAfter ? { retryAfter } : {}) };
  if (s === 429) return new AppError("RATE_LIMITED", `Baseten rate limited Muse Spark Open (429): ${message}`, { retryable: true, details });
  if (s === 529) return new AppError("PROVIDER_UNAVAILABLE", `Baseten is overloaded (529): ${message}`, { retryable: true, details });
  if (s === 402)
    return new AppError("PROVIDER_ERROR", `Baseten returned 402 Payment Required: Model API credits are exhausted or billing needs attention (${message})`, {
      retryable: false,
      details: { ...details, reason: "credits_exhausted" },
      userMessage: "Muse Spark Open (Baseten) is out of credits on this deployment. The operator needs to add Baseten credits or a payment method.",
    });
  if (s === 401 || s === 403) return new AppError("PROVIDER_NOT_CONFIGURED", `Baseten rejected the API key (${s}): ${message}`, { retryable: false, details, userMessage: "Muse Spark Open (Baseten) rejected this deployment's API key." });
  if (s === 404) return new AppError("PROVIDER_NOT_CONFIGURED", `Baseten: ${message} (model ${model}; the hackathon key only works with ${SPARK_OPEN_MODEL})`, { retryable: false, details });
  if (s === 504) return new AppError("TIMEOUT", `Baseten request timed out (504): ${message}`, { retryable: false, details });
  if (s >= 500) return new AppError("PROVIDER_UNAVAILABLE", `Baseten unavailable (${s}): ${message}`, { retryable: true, details });
  if (s === 413) return new AppError("PROVIDER_ERROR", `Request too large for Baseten (413): ${message}`, { retryable: false, details });
  return new AppError("PROVIDER_ERROR", `Baseten rejected the request (${s}): ${message}`, { retryable: false, details });
}

function networkError(e: unknown, callerSignal: AbortSignal | undefined, timeoutMs: number): AppError {
  if (e instanceof AppError) return e;
  if (callerSignal?.aborted) return new AppError("CANCELLED", "Muse Spark Open request cancelled", { cause: e });
  const name = (e as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") return new AppError("TIMEOUT", `Muse Spark Open timed out after ${Math.round(timeoutMs / 1000)} s`, { retryable: true, cause: e });
  return new AppError("PROVIDER_UNAVAILABLE", `Baseten unreachable: ${(e as Error)?.message ?? e}`, { retryable: true, cause: e });
}

function streamFailure(e: unknown, callerSignal: AbortSignal | undefined, timeoutMs: number): AppError {
  const err = networkError(e, callerSignal, timeoutMs);
  if (err.code !== "PROVIDER_UNAVAILABLE") return err;
  return new AppError("PROVIDER_UNAVAILABLE", `Muse Spark Open stream failed after it started: ${(e as Error)?.message ?? e}`, { retryable: true, cause: e });
}

const clients = new WeakMap<Platform, SparkOpenClient>();

/** Tests and fixture mode: install a client built with a fake fetch (documented response shapes). */
export function installSparkOpenClient(platform: Platform, client: SparkOpenClient): void {
  clients.set(platform, client);
}

export function sparkOpenClient(platform: Platform): SparkOpenClient {
  let c = clients.get(platform);
  if (!c) {
    c = new SparkOpenClient(platform);
    clients.set(platform, c);
  }
  return c;
}
