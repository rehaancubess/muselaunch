import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { assertSafeUrl, isBlockedAddress } from "./safe-fetch";
import { LocalStorage, assertKeyInWorkspace, workspaceKey } from "./storage";
import { createTestPlatform } from "./testing";

describe("credits", () => {
  it("reserves, settles and releases atomically and idempotently", async () => {
    const p = createTestPlatform();
    await p.credits.ensureAccount("ws1", { grant: 100, reason: "signup" });
    const r1 = await p.credits.reserve("ws1", 30, { operation: "x", idempotencyKey: "k1", actor: "u" });
    const r1b = await p.credits.reserve("ws1", 30, { operation: "x", idempotencyKey: "k1", actor: "u" });
    expect(r1b.reservationId).toBe(r1.reservationId);
    expect(await p.credits.balance("ws1")).toMatchObject({ available: 70, reserved: 30 });
    await p.credits.settle("ws1", r1.reservationId, 20, { actor: "u" });
    await p.credits.settle("ws1", r1.reservationId, 20, { actor: "u" });
    expect(await p.credits.balance("ws1")).toMatchObject({ available: 80, reserved: 0, lifetimeConsumed: 20 });
    const r2 = await p.credits.reserve("ws1", 50, { operation: "y", idempotencyKey: "k2", actor: "u" });
    await p.credits.release("ws1", r2.reservationId, { actor: "u", reason: "failed" });
    expect(await p.credits.balance("ws1")).toMatchObject({ available: 80, reserved: 0 });
  });

  it("refuses to overdraw, even under concurrent reservations", async () => {
    const p = createTestPlatform();
    await p.credits.ensureAccount("ws1", { grant: 50, reason: "signup" });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => p.credits.reserve("ws1", 20, { operation: "x", idempotencyKey: `c${i}`, actor: "u" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as AppError).code).toBe("INSUFFICIENT_CREDITS");
    expect(await p.credits.balance("ws1")).toMatchObject({ available: 10, reserved: 40 });
  });
});

describe("jobs", () => {
  it("runs a job inline, charges credits and records events", async () => {
    const p = createTestPlatform({}, {
      "media.probe": async (ctx) => {
        await ctx.progress(50, "probing");
        return { data: { ok: true }, creditsUsed: 1 };
      },
    });
    await p.credits.ensureAccount("ws1", { grant: 10, reason: "signup" });
    const job = await p.jobs.create("ws1", "media.probe", { assetId: "ast_1" }, { actor: "u1", credits: { operation: "probe", amount: 3 } });
    expect(job.status).toBe("queued");
    await p.inline!.drain();
    const done = await p.jobs.get("ws1", job.id);
    expect(done).toMatchObject({ status: "succeeded", creditsCharged: 1, attempts: 1 });
    expect(await p.credits.balance("ws1")).toMatchObject({ available: 9, reserved: 0 });
    const events = await p.jobs.listEvents("ws1", job.id);
    expect(events.map((e) => e.kind)).toContain("progress");
  });

  it("is idempotent per key", async () => {
    const p = createTestPlatform({}, { "media.probe": async () => ({}) });
    const a = await p.jobs.create("ws1", "media.probe", { assetId: "a" }, { actor: "u", idempotencyKey: "same" });
    const b = await p.jobs.create("ws1", "media.probe", { assetId: "a" }, { actor: "u", idempotencyKey: "same" });
    expect(a.id).toBe(b.id);
  });

  it("retries retryable errors then fails and refunds", async () => {
    let calls = 0;
    const p = createTestPlatform({}, {
      "media.probe": async () => {
        calls++;
        throw new AppError("PROVIDER_UNAVAILABLE", "down");
      },
    });
    (p.inline as unknown as { opts: { baseDelayMs: number } }).opts.baseDelayMs = 1;
    await p.credits.ensureAccount("ws1", { grant: 10, reason: "signup" });
    const job = await p.jobs.create("ws1", "media.probe", { assetId: "a" }, { actor: "u", credits: { operation: "probe", amount: 5 }, maxAttempts: 2 });
    await p.inline!.drain();
    const done = await p.jobs.get("ws1", job.id);
    expect(calls).toBe(2);
    expect(done?.status).toBe("failed");
    expect(done?.error?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(await p.credits.balance("ws1")).toMatchObject({ available: 10, reserved: 0 });
  });

  it("cancels running jobs via the abort signal", async () => {
    const p = createTestPlatform({}, {
      "media.probe": async (ctx) => {
        await p.jobs.requestCancel(ctx.workspaceId, ctx.job.id, "u");
        await new Promise((r) => setTimeout(r, 20));
        ctx.throwIfCancelled();
        return {};
      },
    });
    const job = await p.jobs.create("ws1", "media.probe", { assetId: "a" }, { actor: "u" });
    await p.inline!.drain();
    expect((await p.jobs.get("ws1", job.id))?.status).toBe("cancelled");
  });

  it("validates payloads against the contract", async () => {
    const p = createTestPlatform();
    await expect(p.jobs.create("ws1", "media.probe", {} as never, { actor: "u" })).rejects.toThrow();
  });
});

describe("safe fetch", () => {
  it("blocks private, loopback, metadata and mapped addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1", "0.0.0.0"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "17.253.144.10", "2607:f8b0:4005:80a::200e"]) expect(isBlockedAddress(a), a).toBe(false);
  });
  it("rejects unsafe URLs", () => {
    for (const u of ["file:///etc/passwd", "http://localhost/x", "http://127.0.0.1/", "http://user:pw@example.com", "http://example.com:8080/", "http://metadata.google.internal/"]) {
      expect(() => assertSafeUrl(u), u).toThrow(AppError);
    }
    expect(assertSafeUrl("https://apps.apple.com/us/app/id123").hostname).toBe("apps.apple.com");
  });
});

describe("storage", () => {
  it("keeps keys inside the workspace and verifies signed tokens", async () => {
    expect(() => workspaceKey("ws1", "..", "x")).toThrow();
    expect(() => assertKeyInWorkspace("ws1", "workspaces/ws2/a.png")).toThrow();
    const s = new LocalStorage("/tmp/ml-test-storage", "http://api", "a-very-secret-signing-key");
    const { url } = await s.signedDownloadUrl("workspaces/ws1/a.png");
    const token = url.split("/").pop()!;
    expect(s.verify(token, "GET").k).toBe("workspaces/ws1/a.png");
    expect(() => s.verify(token, "PUT")).toThrow();
    expect(() => s.verify(token.slice(0, -2) + "xx", "GET")).toThrow();
  });
});
