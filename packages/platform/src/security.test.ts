import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { CloudTasksDispatcher } from "./jobs";
import { createLogger } from "./logger";
import { assertKeyInWorkspace, GcsStorage, workspaceKey } from "./storage";
import { assertSafeUrl, isBlockedAddress } from "./safe-fetch";
import { redactForTrace } from "./usage";

describe("SSRF address policy", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.100.100.200",
    "192.168.1.1",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    // IPv4-compatible, 6to4, Teredo and site-local forms that embed or route to internal IPv4 space.
    "::7f00:1",
    "::127.0.0.1",
    "::a9fe:a9fe",
    "2002:a9fe:a9fe::",
    "2002:7f00:1::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "fec0::1",
    "fd00::1",
    "fe80::1",
  ])("blocks %s", (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "142.250.72.14", "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:82a::200e"])("allows public %s", (addr) => {
    expect(isBlockedAddress(addr)).toBe(false);
  });

  it.each([
    "http://[::7f00:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[2002:a9fe:a9fe::]/latest/meta-data",
    "http://[fec0::1]/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://localhost./",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://example.com:8080/",
    "http://user:pass@example.com/",
    "file:///etc/passwd",
    "gopher://example.com/",
  ])("assertSafeUrl refuses %s", (url) => {
    expect(() => assertSafeUrl(url)).toThrow();
  });
});

describe("model trace redaction", () => {
  it("redacts credentials under any common key spelling but keeps usage counters", () => {
    const out = redactForTrace({
      headers: { Authorization: "Bearer sk-live", "x-api-key": "k1", Cookie: "sid=1" },
      apiKey: "k2",
      api_key: "k3",
      accessToken: "ya29.A",
      access_token: "ya29.B",
      refreshToken: "1//R",
      refresh_token: "1//S",
      id_token: "eyJ.id",
      clientSecret: "cs",
      client_secret: "cs2",
      secretKey: "sk_rc",
      password: "p",
      nested: [{ token: "t" }],
      usage: { input_tokens: 900, output_tokens: 200, inputTokens: 1, max_output_tokens: 6000 },
    }) as Record<string, any>;
    const text = JSON.stringify(out);
    for (const s of ["sk-live", "k1", "sid=1", "k2", "k3", "ya29.A", "ya29.B", "1//R", "1//S", "eyJ.id", '"cs"', "cs2", "sk_rc", '"p"', '"t"']) expect(text).not.toContain(s);
    expect(out.usage).toEqual({ input_tokens: 900, output_tokens: 200, inputTokens: 1, max_output_tokens: 6000 });
  });
});

describe("storage key scoping", () => {
  it("workspaceKey rejects traversal and assertKeyInWorkspace rejects foreign or ambiguous keys", () => {
    for (const seg of ["..", ".", "a/b", "a\\b", "", "x".repeat(201)]) expect(() => workspaceKey("ws_a", "uploads", seg)).toThrow();
    expect(() => workspaceKey("../ws_b", "x")).toThrow();
    expect(() => assertKeyInWorkspace("ws_a", workspaceKey("ws_a", "uploads", "f.png"))).not.toThrow();
    for (const key of ["workspaces/ws_b/uploads/f.png", "workspaces/ws_ab/uploads/f.png", "workspaces/ws_a/../ws_b/f.png", "workspaces/ws_a//f.png", "system/x.png", "workspaces/ws_a"]) {
      expect(() => assertKeyInWorkspace("ws_a", key)).toThrow();
    }
  });
});

describe("job dispatch isolation", () => {
  it("Cloud Tasks task names include the workspace, so equal job ids in two tenants never dedupe each other", async () => {
    const cfg = loadConfig({ NODE_ENV: "test", JOB_DISPATCH: "cloudtasks", FIREBASE_PROJECT_ID: "proj" } as NodeJS.ProcessEnv, { fresh: true });
    const d = new CloudTasksDispatcher(cfg, createLogger({ level: "silent" }));
    const names: string[] = [];
    (d as unknown as { client: unknown }).client = {
      queuePath: (p: string, l: string, q: string) => `projects/${p}/locations/${l}/queues/${q}`,
      createTask: async ({ task }: { task: { name: string } }) => (names.push(task.name), [task]),
    };
    await d.dispatch({ workspaceId: "ws_a", jobId: "job_same", type: "copy.generate", attempt: 0 });
    await d.dispatch({ workspaceId: "ws_b", jobId: "job_same", type: "copy.generate", attempt: 0 });
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toMatch(/\/tasks\/ws_a-job_same-a0$/);
  });
});

describe("signed upload URLs are single-use (GCS)", () => {
  it("signs a create-only precondition and returns it as a header the client must send", async () => {
    const gcs = new GcsStorage("bucket", "proj");
    let signed: { extensionHeaders?: Record<string, string> } = {};
    (gcs as unknown as { bucket: unknown }).bucket = { file: () => ({ getSignedUrl: async (o: typeof signed) => ((signed = o), ["https://storage.googleapis.com/bucket/x?sig"]) }) };
    const up = await gcs.signedUploadUrl(workspaceKey("ws_a", "uploads", "ast_1", "f.png"), { contentType: "image/png", maxBytes: 10 });
    expect(signed.extensionHeaders).toMatchObject({ "x-goog-if-generation-match": "0", "x-goog-content-length-range": "0,10" });
    expect(up.headers).toMatchObject({ "x-goog-if-generation-match": "0" });
  });
});
