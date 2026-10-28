import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";

export const SAMPLE_LISTING = "https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890";
export const API = process.env.E2E_API_URL ?? "http://localhost:8080";
export const SHOTS = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
export const CSV = fileURLToPath(new URL("../fixtures/analytics/generic-wide.csv", import.meta.url));
/** The synthetic presenter clip (labelled test fixture; see scripts/smoke/make-presenter-fixture.ts). */
export const PRESENTER_CLIP = fileURLToPath(new URL("../fixtures/render/presenter/presenter.mp4", import.meta.url));
export const RESULTS = fileURLToPath(new URL("../.data/e2e-results/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

/** Numbered screenshots: `docs/screenshots/<prefix>-NN-<name>.png`. */
export function shooter(prefix: string) {
  let n = 0;
  return async (page: Page, name: string, fullPage = false) => {
    n += 1;
    // Full-page captures start at the top, so the sticky top bar isn't stamped mid-page.
    if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}${prefix}-${String(n).padStart(2, "0")}-${name}.png`, fullPage });
  };
}

export async function expectFixtureMode(request: { get: (url: string) => Promise<{ json: () => Promise<unknown> }> }) {
  const health = (await (await request.get(`${API}/health`)).json()) as { fixtureMode?: boolean };
  expect(health.fixtureMode, "API must run in fixture mode (pnpm dev:fixture)").toBe(true);
}

export const nav = (page: Page, tab: "Discover" | "Creator" | "Insights") => page.getByRole("navigation", { name: "Primary" }).first().getByRole("link", { name: tab }).click();

/**
 * Landing (paste the sample listing) → dev sign-in → one-step onboarding. Falls back to signing in with
 * the listing in `next` when the landing page has no hero link (it is redesigned separately).
 */
export async function signUp(page: Page, shot: (page: Page, name: string, fullPage?: boolean) => Promise<void>, opts: { email: string; shots?: boolean }) {
  await test.step("landing → sign in with the sample listing", async () => {
    await page.goto("/");
    await expect(page.getByText("Fixture mode.")).toBeVisible();
    if (opts.shots !== false) await shot(page, "landing");
    const hero = page.locator("#hero-link");
    if (await hero.count()) {
      await hero.fill(SAMPLE_LISTING);
      await hero.press("Enter");
    } else {
      await page.goto(`/login?next=${encodeURIComponent(`/onboarding?app=${encodeURIComponent(SAMPLE_LISTING)}`)}`);
    }
    await page.waitForURL(/\/login/);
    await page.getByLabel("Email").fill(opts.email);
    await page.getByLabel("Name").fill("Maya Rao");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/onboarding/);
    await expect(page.getByRole("heading", { name: "Let’s grow your app" })).toBeVisible();
    await expect(page.getByLabel("Your app’s link")).toHaveValue(SAMPLE_LISTING);
    await expect(page.getByText("App Store listing detected.")).toBeVisible();
  });
}

/** One-step onboarding with the default ("Let MuseLaunch run it"): Go → the app's Home with Growth Autopilot running. */
export async function onboardWithAutopilot(page: Page, shot: (page: Page, name: string, fullPage?: boolean) => Promise<void>, opts: { shots?: boolean } = {}) {
  await test.step("onboarding: paste → Go (Autopilot is the default)", async () => {
    await expect(page.getByRole("radio", { name: /Let MuseLaunch run it/ })).toHaveAttribute("aria-checked", "true");
    if (opts.shots !== false) await shot(page, "onboarding");
    await page.getByRole("button", { name: "Go" }).click();
    await page.waitForURL(/\/creator$/);
    await expect(page.getByText(/^Now:/).first()).toBeVisible();
  });
}

/** Hands-on path: sign up, "I'll do it myself" → import → verify a claim → confirm App DNA. */
export async function signUpAndImport(page: Page, shot: (page: Page, name: string, fullPage?: boolean) => Promise<void>, opts: { email: string; shots?: boolean }) {
  await signUp(page, shot, opts);

  await test.step("onboarding: I'll do it myself → import", async () => {
    await page.getByRole("radio", { name: /I’ll do it myself/ }).click();
    if (opts.shots !== false) await shot(page, "onboarding-manual");
    await page.getByRole("button", { name: "Go" }).click();
    await expect(page.getByText("Listing imported")).toBeVisible();
    if (opts.shots !== false) await shot(page, "onboarding-imported");
    await page.getByRole("button", { name: "Review App DNA" }).click();
  });

  await test.step("App DNA: verify a claim, confirm", async () => {
    await page.waitForURL(/\/brand$/);
    await expect(page.getByRole("button", { name: "Confirm App DNA" })).toBeVisible({ timeout: 120_000 });
    if (opts.shots !== false) await shot(page, "app-dna", true);
    const verify = page.getByRole("button", { name: "Verify" }).first();
    if (await verify.isVisible()) await verify.click();
    await page.getByRole("button", { name: "Confirm App DNA" }).click();
    await expect(page.getByText("App DNA confirmed")).toBeVisible();
  });
}

/** Phone-width (390 px) screenshots of the given paths, signed in as the same dev user. */
export async function mobileShots(browser: Browser, page: Page, prefix: string, targets: { name: string; path: string; fullPage?: boolean; wait?: (p: Page) => Promise<unknown> }[]) {
  const session = await page.evaluate(() => localStorage.getItem("ml.devSession"));
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, baseURL: new URL(page.url()).origin });
  await ctx.addInitScript((s) => {
    if (s) localStorage.setItem("ml.devSession", s);
  }, session);
  const m = await ctx.newPage();
  for (const t of targets) {
    await m.goto(t.path);
    await m.waitForLoadState("networkidle").catch(() => {});
    if (t.wait) await t.wait(m);
    await m.waitForTimeout(800);
    await m.screenshot({ path: `${SHOTS}${prefix}-${t.name}.png`, fullPage: t.fullPage ?? false });
  }
  await ctx.close();
}
