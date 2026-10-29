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

describe("META_STAND_IN (OpenAI standing in for the Meta Model API)", () => {
  const base = { NODE_ENV: "test", OPENAI_API_KEY: "sk-openai" } as NodeJS.ProcessEnv;

  it("is off by default: nothing changes without META_STAND_IN=openai", () => {
    const cfg = loadConfig({ ...base }, { fresh: true });
    expect(cfg.standIn).toBeUndefined();
    expect(cfg.META_API_KEY).toBeUndefined();
    expect(cfg.META_BASE_URL).toBe("https://api.meta.ai/v1");
  });

  it("points the Meta client at OpenAI with the stand-in models when no Meta key is set", () => {
    const cfg = loadConfig({ ...base, META_STAND_IN: "openai" }, { fresh: true });
    expect(cfg.standIn).toEqual({ provider: "openai", wonder: "gpt-6.1-sol", spark: "gpt-6.1-terra" });
    expect(cfg.META_API_KEY).toBe("sk-openai");
    expect(cfg.META_BASE_URL).toBe("https://api.openai.com/v1");
    expect(cfg.META_MODEL_WONDER).toBe("gpt-6.1-sol");
    expect(cfg.META_MODEL_SPARK).toBe("gpt-6.1-terra");
    // Meta-only models keep their ids (their calls are refused while the stand-in is on).
    expect(cfg.META_MODEL_SAM).toBe("sam-3.1");
  });

  it("a real META_API_KEY always wins", () => {
    const cfg = loadConfig({ ...base, META_STAND_IN: "openai", META_API_KEY: "LLM_1_secret" }, { fresh: true });
    expect(cfg.standIn).toBeUndefined();
    expect(cfg.META_API_KEY).toBe("LLM_1_secret");
    expect(cfg.META_MODEL_WONDER).toBe("muse-wonder-1.0");
  });

  it("does nothing without an OpenAI key", () => {
    const cfg = loadConfig({ NODE_ENV: "test", META_STAND_IN: "openai" } as NodeJS.ProcessEnv, { fresh: true });
    expect(cfg.standIn).toBeUndefined();
    expect(cfg.META_API_KEY).toBeUndefined();
  });

  it("uses custom stand-in models", () => {
    const cfg = loadConfig({ ...base, META_STAND_IN: "openai", STAND_IN_MODEL_WONDER: "gpt-5.5", STAND_IN_MODEL_SPARK: "gpt-6-luna" }, { fresh: true });
    expect(cfg.standIn).toEqual({ provider: "openai", wonder: "gpt-5.5", spark: "gpt-6-luna" });
  });
});

describe("empty list settings", () => {
  it("keeps SPARK_OPEN_TASKS= as an empty list (fallback only), not the default routes", () => {
    const cfg = loadConfig({ NODE_ENV: "test", SPARK_OPEN_TASKS: "" } as NodeJS.ProcessEnv, { fresh: true });
    expect(cfg.SPARK_OPEN_TASKS).toEqual([]);
    expect(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv, { fresh: true }).SPARK_OPEN_TASKS).toEqual(["copy.generate", "composition.variant_briefs"]);
  });
});
