import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { providerStatuses } from "../status";
import { REASONING_HEADROOM, SparkOpenClient, splitThink } from "./client";

/** Baseten fixtures under fixtures/baseten/: documented (or clearly marked assumed) shapes, not live output. */
const FX = fileURLToPath(new URL("../../../../fixtures/baseten/", import.meta.url));
const fx = <T = any>(name: string): T => JSON.parse(readFileSync(`${FX}${name}`, "utf8")) as T; // eslint-disable-line @typescript-eslint/no-explicit-any
const completion = () => structuredClone(fx("chat-completion.json").response);
const streamChunks = () => structuredClone(fx("chat-stream.json").chunks) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const errors = fx<Record<string, unknown>>("errors.json");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sse = (chunks: object[], opts: { done?: boolean } = {}) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (opts.done === false ? "" : "data: [DONE]\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });

interface Call {
  url: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}

function setup(responses: (Response | (() => Response | Promise<Response>))[], cfg: Record<string, string> = {}) {
  const p = createTestPlatform({ BASETEN_API_KEY: "bt-secret-test-key", ...cfg });
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return typeof r === "function" ? r() : r.clone();
  }) as unknown as typeof fetch;
  const client = new SparkOpenClient(p, { fetch: f, sleep: async (ms) => void sleeps.push(ms) });
  const usage = async (ws = "ws1") => (await p.db.ws(ws).collection("modelUsage").list()).items;
  return { p, client, calls, sleeps, usage };
}

const ctx = { workspaceId: "ws1", task: "copy.generate", appId: "app_1", jobId: "job_1" };

describe("SparkOpenClient: request and response parsing", () => {
  it("sends a documented Chat Completions request: exact -1026 slug, reasoning_effort, max_tokens with reasoning headroom, no n/logprobs/JSON mode", async () => {
    const s = setup([json(completion())]);
    await s.client.chat(ctx, { instructions: "Be brief.", input: "Is 91 prime?", maxOutputTokens: 500, reasoningEffort: "low", stream: false });
    const c = s.calls[0]!;
    expect(c.url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(c.headers.get("authorization")).toBe("Bearer bt-secret-test-key");
    expect(c.body.model).toBe("meta-models/muse-spark-open-1026");
    expect(c.body.reasoning_effort).toBe("low");
    expect(c.body.max_tokens).toBe(500 + REASONING_HEADROOM.low);
    expect(c.body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
    expect(c.body.messages[0].content).toContain("Be brief.");
    for (const k of ["n", "logprobs", "top_logprobs", "response_format"]) expect(c.body).not.toHaveProperty(k);
  });

  it("separates reasoning_content from the answer, counts reasoning + cached tokens, prices at the published rate and meters under baseten", async () => {
    const s = setup([json(completion(), 200, { "x-ratelimit-remaining-tokens": "1999000" })]);
    const r = await s.client.chat(ctx, { instructions: "x", input: "Is 91 prime?", stream: false });
    expect(r.content).toBe("No. 91 = 7 × 13, so it is not prime.");
    expect(r.content).not.toContain("The user is asking");
    expect(r.reasoning).toContain("The user is asking");
    expect(r.reasoningSource).toBe("reasoning_content");
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 300, cachedTokens: 200, reasoningTokens: 240 });
    // $1.25/M uncached input, $0.15/M cached input, $4.25/M output (reasoning is billed as output).
    expect(r.costUsd).toBeCloseTo((1000 * 1.25 + 200 * 0.15 + 300 * 4.25) / 1e6, 10);
    expect(r.rateLimit).toEqual({ "x-ratelimit-remaining-tokens": "1999000" });
    const [u] = await s.usage();
    expect(u).toMatchObject({ provider: "baseten", model: "meta-models/muse-spark-open-1026", operation: "chat", task: "copy.generate", status: "ok", dataMode: "third_party", inputTokens: 1200, outputTokens: 300, cachedTokens: 200, reasoningTokens: 240, appId: "app_1", jobId: "job_1", requestId: "chatcmpl-fixture-0001" });
    expect(u!.costUsdEstimate).toBeCloseTo(r.costUsd, 10);
  });

  it("writes a redacted trace: the answer, but neither the reasoning text nor the API key", async () => {
    const s = setup([json(completion())]);
    await s.client.chat(ctx, { instructions: "x", input: "Is 91 prime?", stream: false });
    const [u] = await s.usage();
    expect(u!.traceAssetPath).toMatch(/^workspaces\/ws1\/traces\//);
    const trace = String(await s.p.storage.get(u!.traceAssetPath!));
    expect(trace).toContain("91 = 7 × 13");
    expect(trace).toContain("chars of private reasoning");
    expect(trace).not.toContain("The user is asking");
    expect(trace).not.toContain("bt-secret-test-key");
  });

  it("streams by default (include_usage) and collects reasoning and answer deltas separately", async () => {
    const s = setup([sse(streamChunks())]);
    const r = await s.client.chat(ctx, { instructions: "x", input: "One caption" });
    expect(s.calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(r.content).toBe("Fixture: one calm tap to deep focus.");
    expect(r.reasoning).toBe("The founder wants one caption. Keep it under 125 characters.");
    expect(r.usage).toMatchObject({ inputTokens: 900, outputTokens: 150, reasoningTokens: 120 });
    expect(r.usageEstimated).toBe(false);
  });

  it("accepts `reasoning` (vLLM) deltas and inline <think> blocks, never returning reasoning as the answer", async () => {
    const chunks = streamChunks().map((c) => {
      const d = c.choices?.[0]?.delta;
      if (d?.reasoning_content) {
        d.reasoning = d.reasoning_content;
        delete d.reasoning_content;
      }
      return c;
    });
    const s = setup([sse(chunks)]);
    const r = await s.client.chat(ctx, { instructions: "x", input: "y" });
    expect(r.reasoningSource).toBe("reasoning");
    expect(r.content).toBe("Fixture: one calm tap to deep focus.");
    expect(splitThink("<think>plan it</think>\n{\"a\":1}")).toEqual({ answer: '{"a":1}', reasoning: "plan it" });
    expect(splitThink("<think>still thinking")).toEqual({ answer: "", reasoning: "still thinking" });
  });

  it("maps image parts to image_url (URL or data URL) and meters the image count; >8 images or Meta file ids are refused before any call", async () => {
    const s = setup([json(completion())]);
    await s.client.chat(ctx, { instructions: "x", input: [{ type: "input_text", text: "What colour?" }, { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }, { type: "input_image", image_url: "https://example.com/a.png", detail: "low" }], stream: false });
    expect(s.calls[0]!.body.messages[1].content).toEqual([
      { type: "text", text: "What colour?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      { type: "image_url", image_url: { url: "https://example.com/a.png", detail: "low" } },
    ]);
    expect((await s.usage())[0]).toMatchObject({ images: 2 });
    const nine = Array.from({ length: 9 }, () => ({ type: "input_image" as const, image_url: "https://example.com/a.png" }));
    await expect(s.client.chat(ctx, { instructions: "x", input: nine })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(s.client.chat(ctx, { instructions: "x", input: [{ type: "input_image", file_id: "file_meta_1" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(s.calls).toHaveLength(1);
  });
});

describe("SparkOpenClient: failures (all metered, billed tokens kept)", () => {
  it("a stream that ends without a finish_reason is incomplete: PROVIDER_UNAVAILABLE (retryable), billed with estimated tokens", async () => {
    const s = setup([sse(streamChunks().slice(0, 3), { done: false })]);
    await expect(s.client.chat(ctx, { instructions: "x", input: "y" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    const [u] = await s.usage();
    expect(u).toMatchObject({ provider: "baseten", status: "error", errorCode: "PROVIDER_UNAVAILABLE" });
    expect(u!.outputTokens).toBeGreaterThan(0);
    expect(u!.costUsdEstimate).toBeGreaterThan(0);
  });

  it("finish_reason length with no answer (all reasoning) fails without retry and meters the real usage", async () => {
    const body = completion();
    body.choices[0].message.content = "";
    body.choices[0].finish_reason = "length";
    const s = setup([json(body)]);
    await expect(s.client.chat(ctx, { instructions: "x", input: "y", stream: false })).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: false, message: expect.stringContaining("while reasoning") });
    expect((await s.usage())[0]).toMatchObject({ status: "error", outputTokens: 300, reasoningTokens: 240 });
  });

  it("a refusal is final (not retryable); an empty answer is retryable; both are billed", async () => {
    const refused = completion();
    refused.choices[0].message = { role: "assistant", content: null, refusal: "I can't help with that." };
    const empty = completion();
    empty.choices[0].message.content = "  ";
    const s = setup([json(refused), json(empty)]);
    await expect(s.client.chat(ctx, { instructions: "x", input: "y", stream: false })).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: false, message: expect.stringContaining("refused") });
    await expect(s.client.chat(ctx, { instructions: "x", input: "y", stream: false })).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: true, message: expect.stringContaining("empty answer") });
    const usage = await s.usage();
    expect(usage.map((u) => u.status)).toEqual(["error", "error"]);
    expect(usage.every((u) => u.costUsdEstimate > 0)).toBe(true);
  });

  it("429: waits at least Retry-After, retries once; a Retry-After over 60 s surfaces RATE_LIMITED to the job layer at once", async () => {
    const s = setup([json(errors["429"], 429, { "retry-after": "3" }), json(completion())]);
    const r = await s.client.chat(ctx, { instructions: "x", input: "y", stream: false });
    expect(r.content).toContain("not prime");
    expect(s.sleeps[0]).toBeGreaterThanOrEqual(3000);
    const long = setup([json(errors["429"], 429, { "retry-after": "120" }), json(completion())]);
    await expect(long.client.chat(ctx, { instructions: "x", input: "y" })).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true, opts: { details: { status: 429, retryAfter: "120" } } });
    expect(long.calls).toHaveLength(1);
    expect((await long.usage())[0]).toMatchObject({ provider: "baseten", status: "error", errorCode: "RATE_LIMITED", costUsdEstimate: 0 });
  });

  it("529 overloaded: retried with backoff; still overloaded → PROVIDER_UNAVAILABLE (retryable)", async () => {
    const ok = setup([json(errors["529"], 529), json(completion())]);
    await expect(ok.client.chat(ctx, { instructions: "x", input: "y", stream: false })).resolves.toMatchObject({ content: expect.stringContaining("not prime") });
    expect(ok.sleeps).toHaveLength(1);
    const down = setup([json(errors["529"], 529, { "retry-after": "1" })]);
    await expect(down.client.chat(ctx, { instructions: "x", input: "y" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true, opts: { details: { status: 529 } } });
    expect(down.calls).toHaveLength(2);
    expect(down.sleeps[0]).toBeGreaterThanOrEqual(1000);
  });

  it("402 (credits exhausted / billing) is never retried and says so clearly", async () => {
    const s = setup([json(errors["402"], 402)]);
    const err = await s.client.chat(ctx, { instructions: "x", input: "y" }).catch((e) => e);
    expect(err).toMatchObject({ code: "PROVIDER_ERROR", retryable: false, opts: { details: { status: 402, reason: "credits_exhausted" } } });
    expect(err.message).toMatch(/credits are exhausted/);
    expect(err.opts.userMessage).toMatch(/out of credits/);
    expect(s.calls).toHaveLength(1);
    expect((await s.usage())[0]).toMatchObject({ status: "error", errorCode: "PROVIDER_ERROR" });
  });

  it("401 key and 404 model map to PROVIDER_NOT_CONFIGURED (404 names the -1026 slug); 400 is a non-retryable PROVIDER_ERROR", async () => {
    await expect(setup([json(errors["401"], 401)]).client.chat(ctx, { instructions: "x", input: "y" })).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED", retryable: false });
    await expect(setup([json(errors["404"], 404)]).client.chat(ctx, { instructions: "x", input: "y" })).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED", message: expect.stringContaining("meta-models/muse-spark-open-1026") });
    const bad = setup([json(errors["400"], 400)]);
    await expect(bad.client.chat(ctx, { instructions: "x", input: "y" })).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: false, message: expect.stringContaining("n greater than 1") });
    expect(bad.calls).toHaveLength(1);
  });

  it("times out (TIMEOUT, retryable for the job layer) instead of hanging", async () => {
    const p = createTestPlatform({ BASETEN_API_KEY: "k" });
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    const client = new SparkOpenClient(p, { fetch: hang, timeoutMs: 30 });
    await expect(client.chat(ctx, { instructions: "x", input: "y" })).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
  });

  it("checks the spend guard before calling (no request when the workspace ceiling is reached)", async () => {
    const s = setup([json(completion())], { WORKSPACE_MONTHLY_SPEND_CEILING_USD: "0.00001" });
    await expect(s.client.chat(ctx, { instructions: "x", input: "y" })).rejects.toMatchObject({ code: "SPEND_CEILING" });
    expect(s.calls).toHaveLength(0);
  });
});

describe("Muse Spark Open configuration", () => {
  it("is Not connected without BASETEN_API_KEY and never calls out", async () => {
    const p = createTestPlatform();
    const client = new SparkOpenClient(p, { fetch: (() => Promise.reject(new Error("must not be called"))) as unknown as typeof fetch });
    expect(client.configured).toBe(false);
    await expect(client.chat(ctx, { instructions: "x", input: "y" })).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    expect(providerStatuses(p).find((s) => s.id === "muse-spark-open")).toMatchObject({ state: "not_configured", detail: expect.stringContaining("BASETEN_API_KEY") });
    const live = providerStatuses(createTestPlatform({ BASETEN_API_KEY: "k" })).find((s) => s.id === "muse-spark-open")!;
    expect(live.state).toBe("live");
    expect(live.detail).toContain("meta-models/muse-spark-open-1026");
    expect(live.detail).toContain("copy.generate");
  });
});
