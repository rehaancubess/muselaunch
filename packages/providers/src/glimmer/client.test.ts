import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { extractJson, GlimmerClient, stripInlineReasoning } from "./client";

/** Fake OpenAI-compatible server (llama.cpp documented shapes; fixtures, not live output). */
function sse(chunks: object[]) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("GlimmerClient", () => {
  it("streams, keeps reasoning private, sends reasoning_strength + non-zero temperature, meters as self_hosted", async () => {
    const p = createTestPlatform({ GLIMMER_BASE_URL: "http://gpu-box:8080", GLIMMER_MODEL: "muse-glimmer" });
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return sse([
        { model: "muse-glimmer", choices: [{ delta: { reasoning_content: "thinking about prefs" } }] },
        { model: "muse-glimmer", choices: [{ delta: { content: '{"selected":' } }] },
        { model: "muse-glimmer", choices: [{ delta: { content: '["prf_1"]}' }, finish_reason: "stop" }] },
        { model: "muse-glimmer", choices: [], usage: { prompt_tokens: 321, completion_tokens: 45 } },
      ]);
    }) as unknown as typeof fetch;
    const g = new GlimmerClient(p, { fetch: f });
    const out = await g.chat({ workspaceId: "ws1", task: "memory.retrieve" }, { messages: [{ role: "user", content: "hi" }] });
    expect(out.content).toBe('{"selected":["prf_1"]}');
    expect(out.reasoning).toBe("thinking about prefs");
    expect(out.usage).toEqual({ inputTokens: 321, outputTokens: 45 });
    expect(requests[0]!.url).toBe("http://gpu-box:8080/v1/chat/completions");
    expect(requests[0]!.body).toMatchObject({ model: "muse-glimmer", stream: true, chat_template_kwargs: { reasoning_strength: "low" } });
    expect(requests[0]!.body.temperature).toBeGreaterThan(0);
    const usage = (await p.db.ws("ws1").collection("modelUsage").list()).items;
    expect(usage[0]).toMatchObject({ provider: "glimmer", dataMode: "self_hosted", costUsdEstimate: 0, status: "ok", inputTokens: 321 });
  });

  it("records an error usage event and maps unreachable servers to PROVIDER_UNAVAILABLE", async () => {
    const p = createTestPlatform({ GLIMMER_BASE_URL: "http://gpu-box:8080/v1" });
    const f = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new GlimmerClient(p, { fetch: f }).chat({ workspaceId: "ws1", task: "t" }, { messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const usage = (await p.db.ws("ws1").collection("modelUsage").list()).items;
    expect(usage[0]).toMatchObject({ provider: "glimmer", status: "error" });
  });

  it("treats an empty answer with finish_reason 'length' (ran out while reasoning) as an error, not a reply", async () => {
    const p = createTestPlatform({ GLIMMER_BASE_URL: "http://gpu-box:8080" });
    // Glimmer deploy docs: hitting max_tokens mid-thought returns empty content and finish_reason "length".
    const f = (async () =>
      sse([
        { model: "muse-glimmer", choices: [{ delta: { reasoning_content: "still thinking…" } }] },
        { model: "muse-glimmer", choices: [{ delta: {}, finish_reason: "length" }] },
        { model: "muse-glimmer", choices: [], usage: { prompt_tokens: 100, completion_tokens: 64 } },
      ])) as unknown as typeof fetch;
    await expect(new GlimmerClient(p, { fetch: f }).chat({ workspaceId: "ws1", task: "t" }, { messages: [{ role: "user", content: "x" }], maxTokens: 64 })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("max_tokens"),
    });
    const usage = (await p.db.ws("ws1").collection("modelUsage").list()).items;
    expect(usage[0]).toMatchObject({ provider: "glimmer", status: "error" });
  });

  it("is not configured without GLIMMER_BASE_URL", async () => {
    const p = createTestPlatform();
    const g = new GlimmerClient(p);
    expect(g.configured).toBe(false);
    await expect(g.chat({ workspaceId: "ws1", task: "t" }, { messages: [] })).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("extracts JSON and strips inline reasoning turns", () => {
    expect(extractJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('noise {"b":[1,2]} trailing')).toEqual({ b: [1, 2] });
    expect(stripInlineReasoning("assistant to=self\nprivate\nassistant to=user\nAnswer")).toBe("Answer");
  });
});
