import type { Platform } from "@muselaunch/platform";
import { generateJson, metaClient, respond, type FunctionTool } from "@muselaunch/providers";
import { z } from "zod";
import { saveLive } from "./_save";

/**
 * Meta Model API (≈ $0.05 worst case): list models, one structured Spark call with web search, one
 * tiny raw Wonder call, and one Wonder function-call round trip (function_call → function_call_output
 * with previous_response_id), which is how the agent loop and autopilot talk to Wonder.
 * Raw request/response bodies are captured by smoke-live's wire recorder (fixtures/live/raw/wire/).
 * Token budgets leave room for reasoning: it counts against max_output_tokens (docs: reasoning).
 */
export async function run(p: Platform): Promise<string> {
  const client = metaClient(p);
  const models = await client.fetchJson<{ data: { id: string }[] }>("/models");
  saveLive("meta-models", models.data);
  const ids = models.data.data.map((m) => m.id);
  const ctx = { workspaceId: "smoke", task: "smoke.meta" };
  const spark = await generateJson(p, {
    ctx,
    instructions: "Answer briefly.",
    input: "Name one popular productivity app for iPhone and the official website. Use web search.",
    schema: z.object({ app: z.string(), website: z.string() }),
    schemaName: "SmokeApp",
    webSearch: true,
    maxOutputTokens: 4000,
    reasoningEffort: "low",
  });
  saveLive("meta-spark-json-websearch", spark);
  const wonder = await client.openai.responses.create({ model: p.cfg.META_MODEL_WONDER, input: "Reply with the single word: ready", max_output_tokens: 1000 } as never);
  saveLive("meta-wonder-text", wonder);

  // Function-call round trip on Wonder (the agent loop's protocol).
  const tool: FunctionTool = {
    name: "record_answer",
    description: "Record the final numeric answer.",
    parameters: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
  };
  const instructions = "Compute the answer, call record_answer exactly once with it, then reply with the single word: done.";
  const turn1 = await respond(p, { ctx, model: "wonder", instructions, input: "What is 2 + 3?", tools: [tool], maxOutputTokens: 2000, reasoningEffort: "low" });
  saveLive("meta-wonder-tool-turn1", turn1);
  const call = turn1.functionCalls[0];
  if (!call || !turn1.responseId) throw new Error(`Wonder did not call record_answer (text="${turn1.text.slice(0, 200)}")`);
  const turn2 = await respond(p, {
    ctx,
    model: "wonder",
    instructions,
    input: [{ type: "function_call_output", call_id: call.callId, output: JSON.stringify({ ok: true, recorded: true }) }],
    tools: [tool],
    previousResponseId: turn1.responseId,
    maxOutputTokens: 2000,
    reasoningEffort: "low",
  });
  saveLive("meta-wonder-tool-turn2", turn2);

  return [
    `models=[${ids.join(", ")}]`,
    `spark=${JSON.stringify(spark.data)} citations=${spark.citations.length} searchCalls=${spark.searchCalls} results=${spark.searchResults.length}`,
    `wonder="${(wonder as { output_text?: string }).output_text}"`,
    `tool=${call.name}(${call.arguments}) → "${turn2.text.slice(0, 40)}" calls2=${turn2.functionCalls.length}`,
  ].join(" ");
}
