import type { Platform } from "@muselaunch/platform";
import { generateJson, metaClient } from "@muselaunch/providers";
import { z } from "zod";
import { saveLive } from "./_save";

/** Meta Model API: list models, one structured Spark call with web search, one tiny Wonder call. */
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
    maxOutputTokens: 800,
  });
  saveLive("meta-spark-json-websearch", spark);
  const wonder = await client.openai.responses.create({ model: p.cfg.META_MODEL_WONDER, input: "Reply with the single word: ready", max_output_tokens: 200 } as never);
  saveLive("meta-wonder-text", wonder);
  return `models=[${ids.join(", ")}] spark=${JSON.stringify(spark.data)} citations=${spark.citations.length} wonder="${(wonder as { output_text?: string }).output_text}"`;
}
