import { AppError, type Platform } from "@muselaunch/platform";
import type { CallContext } from "../meta/client";

/**
 * Muse Glimmer (self-hosted, OpenAI-compatible Chat Completions) — llama.cpp, SGLang, vLLM or
 * Ollama serving `GLIMMER_MODEL` at `GLIMMER_BASE_URL`.
 *
 * Per the Glimmer docs: sampling temperature 1.0 / top_p 0.95 (never 0); reasoning cannot be turned
 * off and counts against max_tokens, so we stream with generous headroom; effort is set with
 * `chat_template_kwargs: { reasoning_strength }` (llama.cpp/SGLang; servers that don't know it
 * ignore it). Reasoning arrives in `reasoning_content` (llama.cpp/SGLang) or `reasoning` (vLLM)
 * and is never shown to users. Every call is metered (provider `glimmer`, dataMode `self_hosted`,
 * cost 0, runtimeMs = GPU time proxy).
 */
export interface GlimmerMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GlimmerChatInput {
  messages: GlimmerMessage[];
  maxTokens?: number;
  reasoningStrength?: "low" | "medium" | "high" | "xhigh";
  temperature?: number;
  /** Stream (recommended for reasoning workloads). Default true. */
  stream?: boolean;
  timeoutMs?: number;
}

export interface GlimmerChatResult {
  content: string;
  reasoning?: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  runtimeMs: number;
  finishReason?: string;
}

interface ChatChoice {
  message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
  delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
  finish_reason?: string | null;
}
interface ChatChunk {
  model?: string;
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export class GlimmerClient {
  readonly baseUrl: string | undefined;
  readonly model: string;
  readonly label: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | undefined;

  constructor(
    private readonly platform: Platform,
    opts: { fetch?: typeof fetch; baseUrl?: string; apiKey?: string; model?: string } = {},
  ) {
    const base = opts.baseUrl ?? platform.cfg.GLIMMER_BASE_URL;
    this.baseUrl = base ? base.replace(/\/+$/, "") : undefined;
    this.model = opts.model ?? platform.cfg.GLIMMER_MODEL;
    this.label = platform.cfg.GLIMMER_LABEL;
    this.apiKey = opts.apiKey ?? platform.cfg.GLIMMER_API_KEY;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  private url(path: string): string {
    if (!this.baseUrl) throw new AppError("PROVIDER_NOT_CONFIGURED", "GLIMMER_BASE_URL is not set", { userMessage: "Muse Glimmer isn't connected on this deployment." });
    const root = /\/v1$/.test(this.baseUrl) ? this.baseUrl : `${this.baseUrl}/v1`;
    return `${root}${path}`;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  /** GET /v1/models (llama.cpp serves it without the API key). */
  async models(signal?: AbortSignal): Promise<string[]> {
    const res = await this.fetchImpl(this.url("/models"), { headers: this.headers(), signal: signal ?? AbortSignal.timeout(10_000) });
    if (!res.ok) throw new AppError("PROVIDER_UNAVAILABLE", `Glimmer /models returned ${res.status}`, { retryable: true });
    const body = (await res.json()) as { data?: { id: string }[]; models?: { name?: string; model?: string }[] };
    return [...(body.data ?? []).map((m) => m.id), ...(body.models ?? []).map((m) => m.name ?? m.model ?? "")].filter(Boolean);
  }

  async chat(ctx: CallContext, input: GlimmerChatInput): Promise<GlimmerChatResult> {
    const started = Date.now();
    const stream = input.stream ?? true;
    const temperature = Math.max(0.1, input.temperature ?? 1.0);
    const request = {
      model: this.model,
      messages: input.messages,
      max_tokens: input.maxTokens ?? 4096,
      temperature,
      top_p: 0.95,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      chat_template_kwargs: { reasoning_strength: input.reasoningStrength ?? "low" },
    };
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 120_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    try {
      const res = await this.fetchImpl(this.url("/chat/completions"), { method: "POST", headers: this.headers(), body: JSON.stringify(request), signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const code = res.status === 401 || res.status === 403 ? "PROVIDER_NOT_CONFIGURED" : res.status >= 500 || res.status === 429 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR";
        throw new AppError(code, `Glimmer returned ${res.status}: ${text.slice(0, 300)}`, { retryable: code === "PROVIDER_UNAVAILABLE" });
      }
      const ct = res.headers.get("content-type") ?? "";
      const out = ct.includes("text/event-stream") ? await readStream(res) : readJson((await res.json()) as ChatChunk);
      const content = stripInlineReasoning(out.content);
      const result: GlimmerChatResult = {
        content,
        reasoning: out.reasoning || undefined,
        model: out.model ?? this.model,
        usage: { inputTokens: out.promptTokens ?? 0, outputTokens: out.completionTokens ?? 0 },
        runtimeMs: Date.now() - started,
        finishReason: out.finishReason,
      };
      await this.platform.usage.record(
        ctx.workspaceId,
        {
          provider: "glimmer",
          model: this.model,
          operation: "chat",
          task: ctx.task,
          appId: ctx.appId,
          jobId: ctx.jobId,
          agentRunId: ctx.agentRunId,
          actor: ctx.actor,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          runtimeMs: result.runtimeMs,
          costUsdEstimate: 0,
          status: "ok",
          dataMode: "self_hosted",
        },
        // Reasoning is private; the trace keeps only the visible answer.
        { request, response: { model: result.model, content, usage: result.usage, finishReason: result.finishReason } },
      );
      return result;
    } catch (raw) {
      const err =
        raw instanceof AppError
          ? raw
          : (raw as Error)?.name === "TimeoutError"
            ? new AppError("TIMEOUT", "Glimmer timed out", { retryable: true })
            : (raw as Error)?.name === "AbortError"
              ? new AppError("CANCELLED", "Glimmer request cancelled")
              : new AppError("PROVIDER_UNAVAILABLE", `Glimmer unreachable: ${(raw as Error)?.message ?? raw}`, { retryable: true, cause: raw });
      await this.platform.usage
        .record(ctx.workspaceId, {
          provider: "glimmer",
          model: this.model,
          operation: "chat",
          task: ctx.task,
          appId: ctx.appId,
          jobId: ctx.jobId,
          agentRunId: ctx.agentRunId,
          actor: ctx.actor,
          runtimeMs: Date.now() - started,
          costUsdEstimate: 0,
          status: "error",
          errorCode: err.code,
          dataMode: "self_hosted",
        })
        .catch(() => {});
      throw err;
    }
  }
}

interface Collected {
  content: string;
  reasoning: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
}

function readJson(body: ChatChunk): Collected {
  const c = body.choices?.[0];
  return {
    content: c?.message?.content ?? "",
    reasoning: c?.message?.reasoning_content ?? c?.message?.reasoning ?? "",
    model: body.model,
    promptTokens: body.usage?.prompt_tokens,
    completionTokens: body.usage?.completion_tokens,
    finishReason: c?.finish_reason ?? undefined,
  };
}

async function readStream(res: Response): Promise<Collected> {
  const out: Collected = { content: "", reasoning: "" };
  const reader = res.body?.getReader();
  if (!reader) return out;
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const data = t.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(data) as ChatChunk;
    } catch {
      return;
    }
    out.model ??= chunk.model;
    for (const c of chunk.choices ?? []) {
      out.content += c.delta?.content ?? "";
      out.reasoning += c.delta?.reasoning_content ?? c.delta?.reasoning ?? "";
      if (c.finish_reason) out.finishReason = c.finish_reason;
    }
    if (chunk.usage) {
      out.promptTokens = chunk.usage.prompt_tokens ?? out.promptTokens;
      out.completionTokens = chunk.usage.completion_tokens ?? out.completionTokens;
    }
  };
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
  return out;
}

/**
 * With `--reasoning-format none` llama.cpp leaves the private `to=self` turn inline; keep only the
 * final `to=user` answer when such markers are present.
 */
export function stripInlineReasoning(content: string): string {
  const m = content.lastIndexOf("to=user");
  if (m >= 0 && content.includes("to=self")) {
    const after = content.slice(m + "to=user".length);
    return after.replace(/^[^\n]*\n?/, "").trim() || after.trim();
  }
  return content.trim();
}

/** Extract the first JSON object/array from model text (Glimmer has no enforced JSON mode). */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const start = t.search(/[[{]/);
  if (start < 0) return undefined;
  const open = t[start]!;
  const close = open === "{" ? "}" : "]";
  const end = t.lastIndexOf(close);
  if (end <= start) return undefined;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const clients = new WeakMap<Platform, GlimmerClient>();

/** Tests: install a client with a fake fetch serving documented-shape fixtures. */
export function installGlimmerClient(platform: Platform, client: GlimmerClient): void {
  clients.set(platform, client);
}

export function glimmerClient(platform: Platform): GlimmerClient {
  let c = clients.get(platform);
  if (!c) {
    c = new GlimmerClient(platform);
    clients.set(platform, c);
  }
  return c;
}
