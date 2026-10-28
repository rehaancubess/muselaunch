import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { MetaClient, retryAfterMs } from "./client";

describe("Retry-After (docs: pricing-rate-limits, error-handling: wait at least that long)", () => {
  it("parses delta-seconds and HTTP-dates; ignores garbage", () => {
    const now = Date.parse("2026-10-28T00:00:00Z");
    expect(retryAfterMs("60", now)).toBe(60_000);
    expect(retryAfterMs("1.5", now)).toBe(1500);
    expect(retryAfterMs("Wed, 28 Oct 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs("Wed, 27 Oct 2026 00:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs("soon", now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
  });

  it("does not retry sooner than a long Retry-After: one request, RATE_LIMITED (retryable) with the header in details", async () => {
    const p = createTestPlatform({ META_API_KEY: "test-key" });
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "Too many requests", type: "rate_limit_error", param: null, code: "rate_limit_exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "120" },
      });
    }) as unknown as typeof fetch;
    const client = new MetaClient(p, { fetch: f, apiKey: "test-key" });
    await expect(client.fetchJson("/models")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      opts: expect.objectContaining({ retryable: true, details: expect.objectContaining({ status: 429, code: "rate_limit_exceeded", retryAfter: "120" }) }),
    });
    expect(calls).toBe(1);
  });
});
