import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDb } from "@muselaunch/db";
import { loadConfig, type Config } from "./config";
import { createLogger } from "./logger";
import { createPlatform, createRunner, type Platform } from "./platform";
import type { HandlerRegistry, JobRunner } from "./jobs";

/**
 * Test platform: memory DB, temp-dir storage, inline job dispatch, dev auth tokens.
 * Every module's integration tests should build on this so they exercise the real
 * job/credit/tenancy machinery rather than mocks.
 */
export function createTestPlatform(overrides: Partial<Record<keyof Config, string>> = {}, handlers: HandlerRegistry = {}): Platform & { runner: JobRunner; db: MemoryDb } {
  const dir = mkdtempSync(join(tmpdir(), "muselaunch-test-"));
  const cfg = loadConfig(
    {
      NODE_ENV: "test",
      AUTH_MODE: "dev",
      AUTH_DEV_TOKENS: "1",
      JOB_DISPATCH: "inline",
      DB_DRIVER: "memory",
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_DIR: join(dir, "storage"),
      API_PUBLIC_URL: "http://localhost:8080",
      LOG_LEVEL: "warn",
      TRACE_MODEL_IO: "1",
      SIGNUP_CREDITS: "300",
      ...overrides,
    } as NodeJS.ProcessEnv,
    { fresh: true },
  );
  const db = new MemoryDb();
  const p = createPlatform({ cfg, db, log: createLogger({ level: cfg.LOG_LEVEL }) });
  const runner = createRunner(p, handlers, "test-worker");
  return Object.assign(p, { runner, db });
}
