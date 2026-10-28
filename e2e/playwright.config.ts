import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * End-to-end journey against FIXTURE MODE (labelled fixtures instead of live models; real API,
 * jobs, storage and HyperFrames rendering). One command from the repo root:
 *
 *   pnpm e2e
 *
 * Set RENDER_CHROME_PATH=/path/to/chrome-headless-shell if the renderer can't find a browser.
 *
 * Starts `pnpm dev:fixture` (API :8080) and the web app (:3000) unless they're already running.
 * Screenshots of each step are written to docs/screenshots/e2e-*.png.
 */
// The CI/container image ships Playwright's headless shell here; elsewhere the renderer finds its own.
const BUNDLED_SHELL = "/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const chrome = process.env.RENDER_CHROME_PATH || (existsSync(BUNDLED_SHELL) ? BUNDLED_SHELL : undefined);
// Defaults :8080 / :3000; E2E_API_URL / E2E_BASE_URL point the run at servers on other ports.
const API_URL = process.env.E2E_API_URL ?? "http://localhost:8080";
const WEB_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 40 * 60_000,
  expect: { timeout: 90_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../.data/e2e-results",
  use: {
    baseURL: WEB_URL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
  },
  webServer: [
    {
      command: "pnpm dev:fixture",
      url: `${API_URL}/health`,
      reuseExistingServer: true,
      timeout: 180_000,
      cwd: "..",
      env: { PORT: new URL(API_URL).port || "8080", PUBLIC_WEB_URL: WEB_URL, API_PUBLIC_URL: API_URL, ...(chrome ? { RENDER_CHROME_PATH: chrome } : {}) },
    },
    {
      command: (new URL(WEB_URL).port || "3000") === "3000" ? "pnpm --filter @muselaunch/web dev" : `pnpm --filter @muselaunch/web exec next dev -p ${new URL(WEB_URL).port}`,
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 180_000,
      cwd: "..",
      env: { NEXT_PUBLIC_API_URL: API_URL, NEXT_PUBLIC_AUTH_MODE: "dev" },
    },
  ],
});
