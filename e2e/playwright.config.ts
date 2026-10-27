import { defineConfig } from "@playwright/test";

/**
 * End-to-end journey against FIXTURE MODE (labelled fixtures instead of live models; real API,
 * jobs, storage and HyperFrames rendering). One command from the repo root:
 *
 *   RENDER_CHROME_PATH=/path/to/chrome-headless-shell pnpm e2e
 *
 * Starts `pnpm dev:fixture` (API :8080) and the web app (:3000) unless they're already running.
 * Screenshots of each step are written to docs/screenshots/e2e-*.png.
 */
const chrome = process.env.RENDER_CHROME_PATH ?? "/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 20 * 60_000,
  expect: { timeout: 90_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../.data/e2e-results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
  },
  webServer: [
    {
      command: "pnpm dev:fixture",
      url: "http://localhost:8080/health",
      reuseExistingServer: true,
      timeout: 180_000,
      cwd: "..",
      env: { RENDER_CHROME_PATH: chrome },
    },
    {
      command: "pnpm --filter @muselaunch/web dev",
      url: "http://localhost:3000",
      reuseExistingServer: true,
      timeout: 180_000,
      cwd: "..",
      env: { NEXT_PUBLIC_API_URL: "http://localhost:8080", NEXT_PUBLIC_AUTH_MODE: "dev" },
    },
  ],
});
