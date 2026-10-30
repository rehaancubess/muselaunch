import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { installMetaClient, MetaClient } from "./meta/client";
import { generateJson, trimStrings } from "./meta/llm";
import { dropEmptyTurns } from "./voice";

/**
 * Shapes observed in the first live run against the Meta Model API (30 Oct 2026, fixtures/live/raw/wire,
 * reduced): a commentary preamble before the JSON message, web-search results with empty snippets and
 * no url_citation annotations on JSON output, string values padded with a trailing space, and a
 * zero-length voice turn on audio with no speech.
 */
const liveSparkWebSearch = {
  id: "resp_live_1",
  object: "response",
  created_at: 1793336177,
  model: "muse-spark-1.3",
  status: "completed",
  store: true,
  output: [
    { type: "reasoning", id: "rs_1", summary: [], status: "completed" },
    {
      type: "message",
      id: "rs_2",
      role: "assistant",
      phase: "commentary",
      status: "completed",
      content: [{ type: "output_text", text: "I'll search the web for a popular iPhone productivity app and its official site.", annotations: [], logprobs: [] }],
    },
    {
      type: "web_search_call",
      id: "ws_call_1",
      status: "completed",
      action: { type: "search", query: "most popular productivity app iPhone Todoist official website" },
      results: [
        { type: "text_result", title: "Todoist | A To-Do List to Organize Your Work & Life", url: "https://www.todoist.com/", snippet: "" },
        { type: "text_result", title: "Todoist | LinkedIn", url: "https://www.linkedin.com/company/todoist", snippet: "" },
      ],
    },
    { type: "reasoning", id: "rs_3", summary: [], status: "completed" },
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: '{"app": "Todoist ", "website": "https://todoist.com "}', annotations: [], logprobs: [] }],
    },
  ],
  usage: { input_tokens: 4297, input_tokens_details: { cached_tokens: 0 }, output_tokens: 763, output_tokens_details: { reasoning_tokens: 621 }, total_tokens: 5060 },
};

describe("live Meta response quirks", () => {
  it("parses Spark JSON after a commentary preamble, trims padded strings and keeps search results as sources", async () => {
    const p = createTestPlatform({ META_API_KEY: "test-key" });
    const calls: unknown[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(liveSparkWebSearch), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    installMetaClient(p, new MetaClient(p, { fetch: f, apiKey: "test-key" }));
    const out = await generateJson(p, {
      ctx: { workspaceId: "ws1", task: "test.live" },
      instructions: "Answer briefly.",
      input: "Name one popular productivity app for iPhone and the official website. Use web search.",
      schema: z.object({ app: z.string(), website: z.string().url() }),
      schemaName: "SmokeApp",
      webSearch: true,
    });
    expect(calls).toHaveLength(1); // no repair round
    expect(out.data).toEqual({ app: "Todoist", website: "https://todoist.com" });
    expect(out.citations).toHaveLength(0);
    expect(out.searchResults.map((s) => s.url)).toEqual(["https://www.todoist.com/", "https://www.linkedin.com/company/todoist"]);
  });

  it("trimStrings trims nested strings only", () => {
    expect(trimStrings({ a: " x ", b: [" y", { c: "z " }], n: 3, t: true, u: null })).toEqual({ a: "x", b: ["y", { c: "z" }], n: 3, t: true, u: null });
  });

  it("drops zero-length voice turns (no speech) and rebuilds the transcript", () => {
    const silent = { sessionId: "s", transcript: "Yeah.", audioDurationMs: 3040, turns: [{ turnId: 0, startMs: 2540, endMs: 2540, transcript: "Yeah.", speaker: "A" }] };
    expect(dropEmptyTurns(silent)).toMatchObject({ transcript: "", turns: [] });
    const speech = { sessionId: "s", transcript: "Make the opening more engaging.", audioDurationMs: 3920, turns: [{ turnId: 0, startMs: 60, endMs: 3420, transcript: "Make the opening more engaging.", speaker: "A" }] };
    expect(dropEmptyTurns(speech)).toBe(speech);
  });
});
