import type { Platform } from "@muselaunch/platform";
import { extractJson, glimmerClient } from "@muselaunch/providers";
import { saveLive } from "./_save";

/**
 * Self-hosted Muse Glimmer (e.g. Ollama on your RTX 5090): `pnpm smoke:live glimmer`.
 *
 * 1. GET /v1/models: the server is up and serves GLIMMER_MODEL.
 * 2. A one-line chat: the first call includes loading the model onto the GPU, so it's slower.
 * 3. A Brand Guardian-style review of a caption with an unverified claim, returned as JSON. This is
 *    the kind of call Brand Guardian makes before every render and approval.
 *
 * Costs nothing: it runs on your own GPU. Raw exchanges go to fixtures/live/raw/wire/ (reasoning text
 * replaced by its length); the parsed summary goes to fixtures/live/glimmer.json.
 */
export async function run(p: Platform): Promise<string> {
  const g = glimmerClient(p);
  if (!g.configured) throw new Error("GLIMMER_BASE_URL is not set in .env (run setup-glimmer.cmd)");
  const ctx = { workspaceId: "ws_smoke", task: "smoke.glimmer" };

  const models = await g.models().catch((err: Error) => {
    throw new Error(`can't reach Glimmer at ${g.baseUrl} (${err.message}). Is Ollama running? Start it from the Start menu or run setup-glimmer.cmd.`);
  });
  const served = models.some((m) => m === g.model || m === `${g.model}:latest` || m.split(":")[0] === g.model);

  const t0 = Date.now();
  const hello = await g.chat(ctx, { messages: [{ role: "user", content: "Reply with exactly one word: ready" }], maxTokens: 2048, reasoningStrength: "low" });
  const helloMs = Date.now() - t0;

  const system = [
    "You are a brand guardian for a small app's marketing. Check the caption against the brand rules and the verified claims.",
    'Return ONLY JSON: {"findings":[{"severity":"info|warn|block","category":"claims|tone|cta|other","quote":"exact words from the caption","message":"what is wrong","suggestion":"a fix"}]}',
    "Flag any claim that isn't in the verified claims list as category claims with severity block.",
  ].join("\n");
  const user = [
    "Brand voice: calm, encouraging. Avoid: hustle, grind, crush it.",
    "Verified claims: 1) Blocks distracting apps during focus sessions. 2) Weekly focus reports with streaks.",
    'Caption: "The #1 focus app, trusted by 1 million students. Crush your exams: one tap blocks distracting apps during focus sessions."',
  ].join("\n");
  const review = await g.chat(ctx, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 6000, reasoningStrength: "low" });
  let findings: { severity?: string; category?: string; quote?: string }[] = [];
  let jsonOk = false;
  const parsed = extractJson(review.content) as { findings?: typeof findings } | undefined;
  if (parsed && Array.isArray(parsed.findings)) {
    findings = parsed.findings;
    jsonOk = true;
  }
  const flaggedClaim = findings.some((f) => /#1|1 million|trusted/i.test(f.quote ?? "") && f.category === "claims");
  const flaggedTone = findings.some((f) => /crush/i.test(f.quote ?? ""));

  saveLive("glimmer", {
    models,
    model: g.model,
    label: g.label,
    hello: { content: hello.content, finishReason: hello.finishReason, ms: helloMs, usage: hello.usage, reasoningChars: hello.reasoning?.length ?? 0 },
    review: { content: review.content.slice(0, 4000), finishReason: review.finishReason, ms: review.runtimeMs, usage: review.usage, reasoningChars: review.reasoning?.length ?? 0, jsonOk, findings, flaggedClaim, flaggedTone },
  });

  return [
    `models=[${models.join(", ")}]${served ? "" : ` (WARNING: ${g.model} not listed)`}`,
    `hello="${hello.content.trim().slice(0, 40)}" ${helloMs} ms (first call includes loading onto the GPU)`,
    `review: json=${jsonOk ? "ok" : "INVALID"} findings=${findings.length} unverified-claim=${flaggedClaim ? "flagged" : "MISSED"} tone=${flaggedTone ? "flagged" : "missed"} ${review.runtimeMs} ms, ${review.usage.outputTokens} output tokens, reasoning=${review.reasoning ? `${review.reasoning.length} chars` : "none seen"}`,
  ].join(" | ");
}
