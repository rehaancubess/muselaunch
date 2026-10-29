import { AppError, createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { installMetaClient, MetaClient } from "./meta/client";
import { chooseTextModel, fallbackReason, routedJson, textRouting, type FallbackEvent } from "./router";
import { installSparkOpenClient, SparkOpenClient } from "./spark-open/client";

/**
 * Router: explicit routes to Muse Spark Open, and a visible, once-only fallback from Muse Spark.
 * Fake Meta (Responses API) and fake Baseten (Chat Completions) serve documented shapes (fixtures).
 */

const Out = z.object({ line: z.string() });
const metaOk = (text: string) => ({ id: "resp_fixture_1", object: "response", status: "completed", model: "muse-spark-1.3", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
const openOk = (content: string) => ({ id: "chatcmpl-fixture-r", object: "chat.completion", model: "meta-models/muse-spark-open-1026", choices: [{ index: 0, message: { role: "assistant", reasoning_content: "(private)", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } } });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function setup(opts: { meta: () => Response; open?: () => Response; cfg?: Record<string, string> }) {
  const p = createTestPlatform({ META_API_KEY: "meta-k", BASETEN_API_KEY: "bt-k", ...opts.cfg });
  const calls = { meta: 0, open: 0 };
  installMetaClient(p, new MetaClient(p, { apiKey: "meta-k", fetch: (async () => (calls.meta++, opts.meta())) as unknown as typeof fetch }));
  installSparkOpenClient(p, new SparkOpenClient(p, { fetch: (async () => (calls.open++, (opts.open ?? (() => json(openOk('{"line":"from open"}'))))())) as unknown as typeof fetch, sleep: async () => {} }));
  const events: FallbackEvent[] = [];
  const usage = async (ws = "ws1") => (await p.db.ws(ws).collection("modelUsage").list({ orderBy: { field: "createdAt", dir: "asc" } })).items;
  return { p, calls, events, usage, onFallback: (e: FallbackEvent) => void events.push(e) };
}

const call = { ctx: { workspaceId: "ws1", task: "composition.edit", jobId: "job_1" }, model: "spark" as const, instructions: "x", input: "y", schema: Out, schemaName: "Line", reasoningEffort: "low" as const };
/** Meta 429; `retry-after-ms` lets the SDK's own single retry happen quickly. */
const meta429 = () => json({ error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } }, 429, { "retry-after-ms": "1" });

describe("chooseTextModel", () => {
  it("uses Muse Spark Open only for routes listed in SPARK_OPEN_TASKS and only with BASETEN_API_KEY", () => {
    const none = createTestPlatform({ META_API_KEY: "k" });
    expect(chooseTextModel(none, "copy.generate")).toMatchObject({ engine: "muse-spark", provider: "meta", model: "muse-spark-1.3", reason: "BASETEN_API_KEY is not set" });
    const p = createTestPlatform({ BASETEN_API_KEY: "k" });
    expect(chooseTextModel(p, "copy.generate")).toMatchObject({ engine: "muse-spark-open", provider: "baseten", model: "meta-models/muse-spark-open-1026", label: "Muse Spark Open · open weights via Baseten" });
    expect(chooseTextModel(p, "composition.variant_briefs").engine).toBe("muse-spark-open");
    // Defaults keep scene edits, their repair, claims, storyboards and concepts on Muse Spark.
    for (const r of ["composition.edit.scoped", "composition.edit", "composition.edit.repair", "claims.validate", "storyboard.generate", "concepts.generate"]) expect(chooseTextModel(p, r).engine).toBe("muse-spark");
    const optIn = createTestPlatform({ BASETEN_API_KEY: "k", SPARK_OPEN_TASKS: "composition.edit.scoped" });
    expect(chooseTextModel(optIn, "composition.edit.scoped").engine).toBe("muse-spark-open");
    expect(chooseTextModel(optIn, "copy.generate").engine).toBe("muse-spark");
    const fallbackOnly = createTestPlatform({ BASETEN_API_KEY: "k", SPARK_OPEN_TASKS: "" });
    expect(textRouting(fallbackOnly)).toMatchObject({ sparkOpen: { configured: true, tasks: [], fallback: true }, routes: { "copy.generate": "muse-spark" } });
  });

  it("routed calls go to Baseten only and are metered there", async () => {
    const s = setup({ meta: () => json(metaOk('{"line":"from meta"}')) });
    const out = await routedJson(s.p, { ...call, ctx: { ...call.ctx, task: "copy.generate" } }, { route: "copy.generate", onFallback: s.onFallback });
    expect(out).toMatchObject({ provider: "baseten", model: "meta-models/muse-spark-open-1026", data: { line: "from open" } });
    expect(s.calls).toEqual({ meta: 0, open: 1 });
    expect((await s.usage()).map((u) => [u.provider, u.status])).toEqual([["baseten", "ok"]]);
  });

  it("Wonder and web-search calls are never routed, even when listed", async () => {
    const s = setup({ meta: () => json(metaOk('{"line":"from meta"}')), cfg: { SPARK_OPEN_TASKS: "copy.generate" } });
    await routedJson(s.p, { ...call, model: "wonder" }, { route: "copy.generate" });
    await routedJson(s.p, { ...call, webSearch: true }, { route: "copy.generate" });
    expect(s.calls).toEqual({ meta: 2, open: 0 });
  });
});

describe("fallback from Muse Spark to Muse Spark Open", () => {
  it("on a Meta rate limit (after the SDK's own retry) runs the same request once on Spark Open, records a visible event and meters both providers", async () => {
    const s = setup({ meta: meta429 });
    const out = await routedJson(s.p, call, { route: "composition.edit.scoped", onFallback: s.onFallback });
    expect(s.calls).toEqual({ meta: 2, open: 1 });
    expect(out).toMatchObject({ provider: "baseten", model: "meta-models/muse-spark-open-1026", data: { line: "from open" } });
    expect(out.fallback).toMatchObject({ reason: "rate_limited", status: "succeeded", title: "Muse Spark was rate-limited; used Muse Spark Open (open weights) instead", from: { provider: "meta", model: "muse-spark-1.3" }, to: { provider: "baseten", model: "meta-models/muse-spark-open-1026" }, error: { code: "RATE_LIMITED", status: 429 } });
    expect(s.events).toHaveLength(1);
    const usage = await s.usage();
    expect(usage.map((u) => [u.provider, u.model, u.status, u.errorCode ?? null, u.task])).toEqual([
      ["meta", "muse-spark-1.3", "error", "RATE_LIMITED", "composition.edit"],
      ["baseten", "meta-models/muse-spark-open-1026", "ok", null, "composition.edit"],
    ]);
    expect(usage.every((u) => u.jobId === "job_1")).toBe(true);
  });

  it("names the reason: Meta 402 → credits; 503 → unavailable; timeouts → timed out", async () => {
    const credits = setup({ meta: () => json({ error: { message: "Insufficient credits", type: "billing_error", code: "insufficient_credits" } }, 402) });
    const out = await routedJson(credits.p, call, { route: "composition.edit", onFallback: credits.onFallback });
    expect(out.fallback?.title).toBe("Meta Model API credits ran out; used Muse Spark Open (open weights) instead");
    const down = setup({ meta: () => json({ error: { message: "Service unavailable", type: "server_error" } }, 503, { "retry-after-ms": "1" }) });
    expect((await routedJson(down.p, call, { route: "composition.edit", onFallback: down.onFallback })).fallback?.reason).toBe("unavailable");
    expect(fallbackReason(new AppError("TIMEOUT", "Meta Model API timed out", { retryable: true }))).toBe("timeout");
    expect(fallbackReason(new AppError("RATE_LIMITED", "x", { details: { status: 429, code: "insufficient_quota" } }))).toBe("credits");
  });

  it("never falls back silently: without an onFallback recorder the Meta error is thrown and Spark Open isn't called", async () => {
    const s = setup({ meta: meta429 });
    await expect(routedJson(s.p, call, { route: "composition.edit" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(s.calls.open).toBe(0);
  });

  it("does not fall back when SPARK_OPEN_FALLBACK=0, for web-search calls, or for failures that aren't about Meta's capacity", async () => {
    const off = setup({ meta: meta429, cfg: { SPARK_OPEN_FALLBACK: "0" } });
    await expect(routedJson(off.p, call, { route: "composition.edit", onFallback: off.onFallback })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const search = setup({ meta: meta429 });
    await expect(routedJson(search.p, { ...call, webSearch: true }, { route: "composition.edit", onFallback: search.onFallback })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const invalid = setup({ meta: () => json(metaOk("not json")) });
    await expect(routedJson(invalid.p, call, { route: "composition.edit", onFallback: invalid.onFallback })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    const badKey = setup({ meta: () => json({ error: { message: "bad key", type: "authentication_error" } }, 401) });
    await expect(routedJson(badKey.p, call, { route: "composition.edit", onFallback: badKey.onFallback })).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    const ceiling = setup({ meta: () => json(metaOk('{"line":"x"}')), cfg: { WORKSPACE_MONTHLY_SPEND_CEILING_USD: "0.000001" } });
    await expect(routedJson(ceiling.p, call, { route: "composition.edit", onFallback: ceiling.onFallback })).rejects.toMatchObject({ code: "SPEND_CEILING" });
    for (const s of [off, search, invalid, badKey, ceiling]) {
      expect(s.calls.open).toBe(0);
      expect(s.events).toHaveLength(0);
    }
  });

  it("when the fallback fails too, keeps Meta's error (and retry semantics), names both, and records a failed step", async () => {
    const s = setup({ meta: meta429, open: () => json({ error: "Payment required: Model API credits exhausted" }, 402) });
    const err = await routedJson(s.p, call, { route: "composition.edit", onFallback: s.onFallback }).catch((e) => e);
    expect(err).toMatchObject({ code: "RATE_LIMITED", retryable: true, opts: { details: { fallback: { provider: "baseten", code: "PROVIDER_ERROR" } } } });
    expect(err.message).toContain("fallback also failed");
    expect(s.events).toMatchObject([{ status: "failed", title: "Muse Spark was rate-limited; the Muse Spark Open (open weights) fallback also failed", fallbackError: { code: "PROVIDER_ERROR" } }]);
    expect((await s.usage()).map((u) => [u.provider, u.status])).toEqual([
      ["meta", "error"],
      ["baseten", "error"],
    ]);
  });

  it("writes usage only to the calling workspace", async () => {
    const s = setup({ meta: meta429 });
    await routedJson(s.p, { ...call, ctx: { ...call.ctx, workspaceId: "ws_a" } }, { route: "composition.edit", onFallback: s.onFallback });
    expect((await s.usage("ws_a")).map((u) => u.provider)).toEqual(["meta", "baseten"]);
    expect(await s.usage("ws_b")).toEqual([]);
    expect(await s.usage("ws1")).toEqual([]);
  });
});
