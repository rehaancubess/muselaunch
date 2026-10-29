import { createTestPlatform } from "@muselaunch/platform";
import { modelDisplayName } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chooseTextModel } from "../router";
import { runSam } from "../sam/segment";
import { providerStatuses } from "../status";
import { transcribeFile } from "../voice";
import { installMetaClient, MetaClient } from "./client";
import { generateJson } from "./llm";

/**
 * META_STAND_IN=openai: OpenAI answers Muse Wonder / Muse Spark calls while no Meta key can be created.
 * Fixtures only (no live calls). What matters: requests go to OpenAI with OpenAI model ids, every
 * record says OpenAI, and Meta-only features refuse instead of reaching OpenAI.
 */
const standIn = () => createTestPlatform({ META_STAND_IN: "openai", OPENAI_API_KEY: "sk-test" });

function fakeFetch(body: unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const response = (text: string) => ({
  id: "resp_openai_1",
  object: "response",
  created_at: 1792000000,
  model: "gpt-6.1-terra",
  status: "completed",
  output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
});

describe("OpenAI stand-in for the Meta Model API", () => {
  it("sends Spark calls to OpenAI's Responses API with the stand-in model, drops temperature, and meters them as OpenAI", async () => {
    const p = standIn();
    const { f, calls } = fakeFetch(response(JSON.stringify({ ok: true })));
    installMetaClient(p, new MetaClient(p, { fetch: f }));
    const out = await generateJson(p, { ctx: { workspaceId: "ws1", task: "t" }, instructions: "Return JSON", input: "hi", schema: z.object({ ok: z.boolean() }), schemaName: "Ok", temperature: 0.4 });
    expect(out.data).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]!.body.model).toBe("gpt-6.1-terra");
    expect(calls[0]!.body).not.toHaveProperty("temperature");
    const usage = (await p.db.ws("ws1").collection("modelUsage").list()).items;
    expect(usage[0]).toMatchObject({ provider: "openai", model: "gpt-6.1-terra", status: "ok" });
  });

  it("names OpenAI wherever Muse Spark / Muse Wonder would be named", () => {
    const p = standIn();
    expect(chooseTextModel(p, "concepts.generate")).toMatchObject({ engine: "muse-spark", model: "gpt-6.1-terra", name: "OpenAI gpt-6.1-terra", label: "OpenAI gpt-6.1-terra · temporary stand-in for Muse Spark" });
    expect(modelDisplayName("gpt-6.1-sol")).toBe("OpenAI gpt-6.1-sol");
    expect(modelDisplayName("gpt-image-2.5-flare")).toBe("gpt-image-2.5-flare");
    const items = providerStatuses(p);
    expect(items.find((i) => i.id === "muse-wonder")).toMatchObject({ label: "Muse Wonder → OpenAI gpt-6.1-sol", state: "live", detail: expect.stringContaining("Temporary stand-in") });
    expect(items.find((i) => i.id === "sam")).toMatchObject({ state: "not_configured", detail: expect.stringContaining("Needs the Meta Model API key") });
    expect(items.find((i) => i.id === "muse-voice")).toMatchObject({ state: "not_configured" });
  });

  it("refuses Meta-only features (SAM 3.1, Muse Voice Transcribe) instead of calling OpenAI", async () => {
    const p = standIn();
    const { f, calls } = fakeFetch({});
    installMetaClient(p, new MetaClient(p, { fetch: f }));
    const ctx = { workspaceId: "ws1", task: "t" };
    await expect(runSam(p, ctx, { media: { kind: "image", imageUrl: "https://example.com/a.png" }, prompt: { kind: "text", text: "person" } } as never)).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    await expect(transcribeFile(p, ctx, { wav: { data: new Uint8Array(10) }, durationSec: 1, mode: "dictation" } as never)).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    expect(calls).toHaveLength(0);
  });

  it("is invisible with a real Meta key", () => {
    const p = createTestPlatform({ META_API_KEY: "LLM_1_k", META_STAND_IN: "openai", OPENAI_API_KEY: "sk-test" });
    expect(p.cfg.standIn).toBeUndefined();
    expect(chooseTextModel(p, "concepts.generate")).toMatchObject({ name: "Muse Spark", label: "Muse Spark" });
    expect(providerStatuses(p).find((i) => i.id === "muse-wonder")).toMatchObject({ label: "Muse Wonder", state: "live" });
  });
});
