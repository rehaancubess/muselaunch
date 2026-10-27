import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/api/src/**/*.test.ts", "apps/worker/src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: { forks: { maxForks: 2 } },
  },
});
