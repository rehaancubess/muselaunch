import { AppError, type Platform } from "@muselaunch/platform";
import type { z } from "zod";
import { toolParameters, type LlmCall, type LlmTextResult } from "../meta/llm";
import { sparkOpenClient, type SparkOpenResult } from "./client";
import { parseJsonAnswer } from "./json";

/**
 * Text and JSON generation on Muse Spark Open, shaped like the Meta helpers (`LlmTextResult`) so the
 * router can swap engines without callers changing. No web search, no function tools, no Meta file
 * ids: those calls stay on Meta.
 */

export interface SparkOpenTextResult extends LlmTextResult {
  provider: "baseten";
  /** Length of the private reasoning (the text itself is never returned). */
  reasoningChars: number;
  finishReason?: string;
  usageEstimated: boolean;
}

export type SparkOpenCall = LlmCall & { stream?: boolean };

function rejectUnsupported(call: LlmCall): void {
  if (call.model === "wonder") throw new AppError("BAD_REQUEST", "Muse Wonder calls are never sent to Muse Spark Open");
  if (call.webSearch) throw new AppError("BAD_REQUEST", "Muse Spark Open has no web search in MuseLaunch; search-grounded calls stay on Muse Spark (cited sources)");
}

function toResult(r: SparkOpenResult): SparkOpenTextResult {
  return {
    text: r.content,
    citations: [],
    searchCalls: 0,
    searchResults: [],
    usage: r.usage,
    responseId: r.requestId,
    model: r.model,
    costUsd: r.costUsd,
    provider: "baseten",
    reasoningChars: r.reasoning.length,
    finishReason: r.finishReason,
    usageEstimated: r.usageEstimated,
  };
}

function request(call: SparkOpenCall, instructions: string, input: LlmCall["input"]) {
  return { instructions, input, maxOutputTokens: call.maxOutputTokens, reasoningEffort: call.reasoningEffort, temperature: call.temperature, stream: call.stream };
}

/** Free-text generation. The answer is `content`; reasoning is separated and kept private. */
export async function sparkOpenText(p: Platform, call: SparkOpenCall): Promise<SparkOpenTextResult> {
  rejectUnsupported(call);
  return toResult(await sparkOpenClient(p).chat(call.ctx, request(call, call.instructions, call.input)));
}

/** Prompt text that replaces JSON mode (Muse Spark Open has none). Fixture mode reads the schema name from it. */
export function jsonFormatInstructions(name: string, schema: Record<string, unknown>): string {
  return [
    `Output format: reply with ONLY one JSON value that conforms to the JSON Schema named "${name}" below. No prose before or after it, no Markdown code fences, no comments. Use the exact property names and include every required property.`,
    `<json_schema name="${name}">`,
    JSON.stringify(schema),
    "</json_schema>",
  ].join("\n");
}

/**
 * Structured generation: prompt for JSON, extract it from the final answer (never from reasoning),
 * validate with Zod, and make ONE repair attempt on mismatch, like the Meta `generateJson`. A second
 * failure throws PROVIDER_ERROR (never silently coerced). Both calls are metered.
 */
export async function sparkOpenJson<S extends z.ZodTypeAny>(p: Platform, call: SparkOpenCall & { schema: S; schemaName: string }): Promise<SparkOpenTextResult & { data: z.infer<S> }> {
  rejectUnsupported(call);
  const client = sparkOpenClient(p);
  const name = call.schemaName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const instructions = `${call.instructions}\n\n${jsonFormatInstructions(name, toolParameters(call.schema))}`;
  const first = toResult(await client.chat(call.ctx, request(call, instructions, call.input)));
  const parsed = parseJsonAnswer(first.text, call.schema, name);
  if (parsed.ok) return { ...first, data: parsed.data };
  const repairText = `${typeof call.input === "string" ? call.input : "(see the request above)"}\n\nYour previous answer was not valid JSON for the schema "${name}". Errors:\n${parsed.error}\n\nPrevious answer:\n${first.text.slice(0, 20_000)}\n\nReturn the corrected JSON only.`;
  const repairInput: LlmCall["input"] = typeof call.input === "string" ? repairText : [...call.input, { type: "input_text", text: repairText }];
  const second = toResult(await client.chat({ ...call.ctx, task: `${call.ctx.task}.repair` }, request(call, instructions, repairInput)));
  const reparsed = parseJsonAnswer(second.text, call.schema, name);
  if (!reparsed.ok) throw new AppError("PROVIDER_ERROR", `Muse Spark Open output failed schema ${call.schemaName}: ${reparsed.error}`, { retryable: true });
  return {
    ...second,
    costUsd: first.costUsd + second.costUsd,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      cachedTokens: first.usage.cachedTokens + second.usage.cachedTokens,
      reasoningTokens: first.usage.reasoningTokens + second.usage.reasoningTokens,
    },
    reasoningChars: first.reasoningChars + second.reasoningChars,
    usageEstimated: first.usageEstimated || second.usageEstimated,
    data: reparsed.data,
  };
}
