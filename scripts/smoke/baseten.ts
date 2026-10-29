import type { Platform } from "@muselaunch/platform";
import { sparkOpenClient, sparkOpenJson, type SparkOpenResult } from "@muselaunch/providers";
import { z } from "zod";
import { saveLive } from "./_save";

/**
 * Muse Spark Open on Baseten: `pnpm smoke:live baseten` (three tiny calls, well under $0.05 at the
 * published $1.25 in / $4.25 out per 1M tokens; reasoning is billed as output).
 *
 * 1. Text, NOT streamed: where reasoning arrives (docs: message.reasoning_content) vs the answer
 *    (message.content), usage incl. completion_tokens_details.reasoning_tokens, the echoed `model`,
 *    x-ratelimit-* headers, and that reasoning_effort "low" is accepted.
 * 2. JSON, streamed (the adapter's default): which delta field carries reasoning, whether
 *    stream_options.include_usage yields a usage chunk, finish_reason and [DONE]; the JSON is prompted
 *    (no JSON mode on this model), extracted from the answer and Zod-validated.
 * 3. Image in: a 32×32 PNG (red over blue) sent as a base64 data URL in an image_url part.
 *
 * Every raw exchange is written to fixtures/live/raw/wire/ by smoke-live's wire recorder (no API key;
 * reasoning text replaced by its length). Parsed summaries go to fixtures/live/baseten-*.json.
 */
const RED_OVER_BLUE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAANUlEQVR42u3OMQEAMAwDoCqJkvlXUS+djDwc/Mwm1zQCAgICAgIC9UDeXpOAgICAgIBAPfABBUiYeXAct+gAAAAASUVORK5CYII=";

function summary(r: SparkOpenResult) {
  return {
    answer: r.content.slice(0, 300),
    reasoningSource: r.reasoningSource,
    reasoningChars: r.reasoning.length,
    finishReason: r.finishReason,
    requestedModel: r.model,
    responseModel: r.responseModel,
    requestId: r.requestId,
    usage: r.usage,
    usageEstimated: r.usageEstimated,
    costUsd: r.costUsd,
    runtimeMs: r.runtimeMs,
    rateLimit: r.rateLimit,
  };
}

const short = (r: SparkOpenResult) =>
  `reasoning=${r.reasoningSource}(${r.reasoning.length} chars) finish=${r.finishReason} tokens in/cached/out/reasoning=${r.usage.inputTokens}/${r.usage.cachedTokens}/${r.usage.outputTokens}/${r.usage.reasoningTokens}${r.usageEstimated ? " (ESTIMATED: no usage in response)" : ""} model=${r.responseModel ?? "?"}`;

export async function run(p: Platform): Promise<string> {
  const client = sparkOpenClient(p);
  if (!client.configured) return "skipped (BASETEN_API_KEY not set)";
  const ctx = { workspaceId: "smoke", task: "smoke.baseten" };

  const text = await client.chat(ctx, { instructions: "Answer in one short sentence.", input: "Is 91 a prime number?", maxOutputTokens: 200, reasoningEffort: "low", stream: false });
  saveLive("baseten-text", summary(text));

  const json = await sparkOpenJson(p, {
    ctx,
    instructions: "Answer briefly and factually.",
    input: "Name one well-known productivity app for iPhone and its App Store category.",
    schema: z.object({ app: z.string().min(1), category: z.string().min(1) }),
    schemaName: "SmokeApp",
    maxOutputTokens: 300,
    reasoningEffort: "low",
  });
  saveLive("baseten-json-stream", { data: json.data, usage: json.usage, usageEstimated: json.usageEstimated, reasoningSource: json.reasoningSource, reasoningChars: json.reasoningChars, finishReason: json.finishReason, costUsd: json.costUsd });

  const image = await client.chat(ctx, {
    instructions: "Describe images precisely and briefly.",
    input: [
      { type: "input_text", text: "This image has two colours, one on top and one on the bottom. Name them, top first, in two words." },
      { type: "input_image", image_url: `data:image/png;base64,${RED_OVER_BLUE_PNG}` },
    ],
    maxOutputTokens: 100,
    reasoningEffort: "low",
  });
  saveLive("baseten-image", summary(image));

  const cost = text.costUsd + json.costUsd + image.costUsd;
  return [
    `text="${text.content.slice(0, 80)}" ${short(text)} ratelimit=${JSON.stringify(text.rateLimit)}`,
    `json=${JSON.stringify(json.data)} (streamed, reasoning=${json.reasoningSource}(${json.reasoningChars} chars) finish=${json.finishReason}${json.usageEstimated ? ", usage ESTIMATED: no usage chunk" : ""})`,
    `image="${image.content.slice(0, 60)}" ${short(image)}`,
    `cost≈$${cost.toFixed(4)}`,
  ].join(" | ");
}
