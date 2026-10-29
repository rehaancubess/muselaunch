import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("config", () => {
  it("treats empty .env values (KEY=) as not set, so defaults apply and SDKs never get an empty credential", () => {
    const cfg = loadConfig({ NODE_ENV: "test", META_API_KEY: "", BASETEN_API_KEY: "  ", SIGNUP_CREDITS: "", OPENAI_API_KEY: "" } as NodeJS.ProcessEnv, { fresh: true });
    expect(cfg.META_API_KEY).toBeUndefined();
    expect(cfg.BASETEN_API_KEY).toBeUndefined();
    expect(cfg.OPENAI_API_KEY).toBeUndefined();
    expect(cfg.SIGNUP_CREDITS).toBe(300);
  });

  it("keeps real values", () => {
    const cfg = loadConfig({ NODE_ENV: "test", META_API_KEY: "k-123", SIGNUP_CREDITS: "50" } as NodeJS.ProcessEnv, { fresh: true });
    expect(cfg.META_API_KEY).toBe("k-123");
    expect(cfg.SIGNUP_CREDITS).toBe(50);
  });
});
