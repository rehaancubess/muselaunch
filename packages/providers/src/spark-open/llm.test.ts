import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { installSparkOpenClient, SparkOpenClient } from "./client";
import { jsonCandidates, parseJsonAnswer } from "./json";
import { sparkOpenJson, sparkOpenText } from "./llm";

/** Chat Completions bodies in the documented non-streaming shape (fixtures, not live output). */
const answer = (content: string, reasoning = "(private reasoning)", usage = { prompt_tokens: 400, completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 90 } }) => ({
  id: `chatcmpl-fixture-${Math.random().toString(36).slice(2, 8)}`,
  object: "chat.completion",
  model: "meta-models/muse-spark-open-1026",
  choices: [{ index: 0, message: { role: "assistant", reasoning_content: reasoning, content }, finish_reason: "stop" }],
  usage,
});

function setup(bodies: object[]) {
  const p = createTestPlatform({ BASETEN_API_KEY: "k" });
  const requests: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const f = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(bodies[Math.min(requests.length - 1, bodies.length - 1)]), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  installSparkOpenClient(p, new SparkOpenClient(p, { fetch: f }));
  return { p, requests, usage: async () => (await p.db.ws("ws1").collection("modelUsage").list({ orderBy: { field: "createdAt", dir: "asc" } })).items };
}

const Hooks = z.object({ hooks: z.array(z.object({ label: z.string(), line: z.string().max(60) })).min(2) });
const call = { ctx: { workspaceId: "ws1", task: "composition.variant_briefs" }, instructions: "Write hooks.", input: "Two hooks for a focus app.", schema: Hooks, schemaName: "HookBriefs", reasoningEffort: "low" as const, stream: false };
const good = { hooks: [{ label: "Question", line: "Why is focus so hard?" }, { label: "Outcome", line: "25 calm minutes. Done." }] };

describe("sparkOpenJson (no JSON mode: prompt, extract, validate, repair once)", () => {
  it("prompts with the named JSON Schema (no response_format) and extracts JSON wrapped in prose and fences from the ANSWER", async () => {
    const s = setup([answer(`Here you go:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\nHope that helps.`)]);
    const out = await sparkOpenJson(s.p, call);
    expect(out.data).toEqual(good);
    expect(out.provider).toBe("baseten");
    expect(out.model).toBe("meta-models/muse-spark-open-1026");
    expect(out.usage.reasoningTokens).toBe(90);
    const req = s.requests[0]!;
    expect(req).not.toHaveProperty("response_format");
    expect(req.messages[0].content).toContain('<json_schema name="HookBriefs">');
    expect(req.messages[0].content).toContain('"hooks"');
  });

  it("repairs once with the validation errors, meters both calls, and sums usage", async () => {
    const s = setup([answer(JSON.stringify({ hooks: [{ label: "Only one", line: "x" }] })), answer(JSON.stringify(good))]);
    const out = await sparkOpenJson(s.p, call);
    expect(out.data).toEqual(good);
    expect(s.requests[1]!.messages[1].content).toContain("not valid JSON for the schema");
    expect(s.requests[1]!.messages[1].content).toContain("hooks");
    expect(out.usage.outputTokens).toBe(240);
    const usage = await s.usage();
    expect(usage.map((u) => [u.provider, u.task, u.status])).toEqual([
      ["baseten", "composition.variant_briefs", "ok"],
      ["baseten", "composition.variant_briefs.repair", "ok"],
    ]);
  });

  it("a second invalid answer fails visibly (PROVIDER_ERROR, retryable), never coerced", async () => {
    const s = setup([answer("not json at all"), answer('{"hooks": []}')]);
    await expect(sparkOpenJson(s.p, call)).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: true, message: expect.stringContaining("failed schema HookBriefs") });
    expect(s.requests).toHaveLength(2);
  });

  it("never takes JSON from the reasoning: JSON only in reasoning_content + empty answer is an error", async () => {
    const s = setup([answer("", JSON.stringify(good))]);
    await expect(sparkOpenJson(s.p, call)).rejects.toMatchObject({ code: "PROVIDER_ERROR", message: expect.stringContaining("empty answer") });
  });

  it("refuses web search and Wonder calls (they stay on Meta)", async () => {
    const s = setup([answer("x")]);
    await expect(sparkOpenText(s.p, { ...call, webSearch: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(sparkOpenText(s.p, { ...call, model: "wonder" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(s.requests).toHaveLength(0);
  });

  it("returns plain text answers with the reasoning kept out", async () => {
    const s = setup([answer("Focus, beautifully simple.", "secret chain of thought")]);
    const out = await sparkOpenText(s.p, { ctx: call.ctx, instructions: "One line.", input: "Tagline?" });
    expect(out.text).toBe("Focus, beautifully simple.");
    expect(JSON.stringify(out)).not.toContain("secret chain of thought");
    expect(out.reasoningChars).toBe("secret chain of thought".length);
  });
});

describe("JSON extraction from free text", () => {
  it("scans balanced objects (braces inside strings are fine) and unwraps a {SchemaName: …} wrapper", () => {
    expect(jsonCandidates('noise {"a":"}{"} tail [1,2]')).toContain('{"a":"}{"}');
    expect(parseJsonAnswer(`Sure! {"HookBriefs": ${JSON.stringify(good)}}`, Hooks, "HookBriefs")).toEqual({ ok: true, data: good });
    const bad = parseJsonAnswer('{"hooks":[{"label":"a"}]}', Hooks);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/hooks/);
    expect(parseJsonAnswer("", Hooks)).toEqual({ ok: false, error: "Empty answer" });
  });
});
