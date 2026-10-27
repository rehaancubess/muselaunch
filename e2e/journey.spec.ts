import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * The MuseLaunch journey, end to end through the real UI and API in FIXTURE MODE:
 * onboarding → import → App DNA confirm → research/Discover → new campaign → concepts → produce →
 * Studio (AI edit, undo) → final render → export → post + tracked link → Insights CSV import →
 * experiment → recommendation.
 *
 * AI responses are labelled fixtures (see apps/api/src/dev-fixture.ts); everything else is real.
 */

const SAMPLE_LISTING = "https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890";
const API = "http://localhost:8080";
const SHOTS = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
const CSV = fileURLToPath(new URL("../fixtures/analytics/generic-wide.csv", import.meta.url));
mkdirSync(SHOTS, { recursive: true });

let n = 0;
async function shot(page: Page, name: string, fullPage = false) {
  n += 1;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}e2e-${String(n).padStart(2, "0")}-${name}.png`, fullPage });
}

test.describe.configure({ mode: "serial" });

test("indie founder journey (fixture mode)", async ({ page, request }) => {
  const health = await (await request.get(`${API}/health`)).json();
  expect(health.fixtureMode, "API must run in fixture mode (pnpm dev:fixture)").toBe(true);

  const email = `founder${Date.now() % 1_000_000}@tidylabs.dev`;

  await test.step("landing → sign in with the sample listing", async () => {
    await page.goto("/");
    await expect(page.getByText("Fixture mode.")).toBeVisible();
    await shot(page, "landing");
    await page.locator("#hero-link").fill(SAMPLE_LISTING);
    await page.getByRole("button", { name: /Start with my app/ }).click();
    await page.waitForURL(/\/login/);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Name").fill("Maya Rao");
    await page.getByRole("button", { name: "Continue" }).click();
  });

  await test.step("onboarding: workspace, country, import", async () => {
    await page.waitForURL(/\/onboarding/);
    await expect(page.getByRole("heading", { name: "Set up your studio" })).toBeVisible();
    await page.getByLabel("Country").selectOption("US");
    await shot(page, "onboarding-workspace");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Add your app" })).toBeVisible();
    await expect(page.getByText("App Store listing detected.")).toBeVisible();
    await page.getByRole("button", { name: "Import app" }).click();
    await expect(page.getByText("Listing imported")).toBeVisible();
    await shot(page, "onboarding-imported");
    await page.getByRole("button", { name: "Review App DNA" }).click();
  });

  await test.step("App DNA: verify a claim, confirm", async () => {
    await page.waitForURL(/\/brand$/);
    await expect(page.getByRole("button", { name: "Confirm App DNA" })).toBeVisible({ timeout: 120_000 });
    await shot(page, "app-dna", true);
    const verify = page.getByRole("button", { name: "Verify" }).first();
    if (await verify.isVisible()) await verify.click();
    await page.getByRole("button", { name: "Confirm App DNA" }).click();
    await expect(page.getByText("App DNA confirmed")).toBeVisible();
  });

  await test.step("Discover: research the market", async () => {
    await page.getByRole("navigation", { name: "Primary" }).first().getByRole("link", { name: "Discover" }).click();
    await page.waitForURL(/\/discover$/);
    await page.getByRole("button", { name: "Research market" }).click();
    await page.getByRole("button", { name: "Start research" }).click();
    await expect(page.getByText("Research finished")).toBeVisible({ timeout: 120_000 });
    await page.reload();
    await expect(page.getByRole("button", { name: "Create campaign" }).first()).toBeVisible();
    await shot(page, "discover");
  });

  await test.step("Creator: new campaign → concepts", async () => {
    await page.getByRole("navigation", { name: "Primary" }).first().getByRole("link", { name: "Creator" }).click();
    await page.waitForURL(/\/creator$/);
    await page.locator("#creator-request").fill("Create five promotional Reels introducing Tidy Timer, using a premium Apple-style aesthetic.");
    await shot(page, "creator");
    await page.getByRole("button", { name: "Plan campaign" }).click();
    await page.waitForURL(/\/creator\/new/);
    await shot(page, "new-campaign");
    await page.getByRole("button", { name: "Generate concepts" }).click();
    await page.waitForURL(/\/creator\/campaigns\//);
    await expect(page.getByRole("button", { name: "Select" }).nth(2)).toBeVisible({ timeout: 120_000 });
    await shot(page, "concepts", true);
  });

  await test.step("produce a concept → composition rendered", async () => {
    await page.getByRole("button", { name: "Select" }).nth(1).click();
    await page.getByRole("button", { name: "Produce", exact: true }).click();
    await page.getByRole("button", { name: "Start production" }).click();
    await expect(page.getByRole("link", { name: "Open in Studio" })).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText("Rendered", { exact: true }).first()).toBeVisible({ timeout: 240_000 });
    await shot(page, "campaign-produced", true);
  });

  await test.step("Studio: AI edit, apply, undo", async () => {
    await page.getByRole("link", { name: "Open in Studio" }).click();
    await page.waitForURL(/\/studio\//);
    await expect(page.getByRole("tab", { name: "Ask Muse" })).toBeVisible();
    await shot(page, "studio");
    await page.getByRole("tab", { name: "Ask Muse" }).click();
    await page.getByLabel("Edit instruction").fill("Make the opening more engaging");
    await page.getByLabel("Edit instruction").press("Enter");
    await expect(page.getByRole("button", { name: "Apply" })).toBeVisible({ timeout: 120_000 });
    await shot(page, "studio-ai-edit");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText(/Applied as version/)).toBeVisible();
    await shot(page, "studio-applied");
    await page.getByRole("button", { name: "Undo" }).last().click();
    await page.waitForTimeout(1500);
  });

  await test.step("final render", async () => {
    await page.getByRole("button", { name: "Render", exact: true }).click();
    await page.getByRole("button", { name: "Render final" }).click();
    await expect(page.getByText("Final render ready")).toBeVisible({ timeout: 300_000 });
    await shot(page, "studio-final-render");
    await page.getByRole("button", { name: "Close" }).last().click();
  });

  await test.step("export package + post with tracked link", async () => {
    await page.getByRole("link", { name: /Campaign/ }).first().click();
    await page.waitForURL(/\/creator\/campaigns\//);
    await page.getByRole("button", { name: "Export package" }).click();
    await expect(page.getByRole("link", { name: "Download package" })).toBeVisible({ timeout: 240_000 });
    await page.getByRole("button", { name: "Post" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New post" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Channel").selectOption("instagram");
    await expect(dialog.getByLabel("Media")).not.toHaveValue("");
    await dialog.getByLabel("Caption").fill("Forward. Focus. Done. Tidy Timer blocks distractions for 25 calm minutes.");
    await shot(page, "new-post");
    await dialog.getByRole("button", { name: "Create draft" }).click();
    await expect(page.getByText("Draft post created")).toBeVisible();
    await page.reload();
    await expect(page.getByText(/1 click|0 clicks/).first()).toBeVisible();
    await shot(page, "campaign-export-links", true);
  });

  await test.step("Calendar: approve and post manually", async () => {
    await page.goto(page.url().replace(/\/creator\/campaigns\/.*$/, "/calendar"));
    await page.getByRole("button", { name: "Review post" }).first().click();
    await page.getByRole("button", { name: "Request approval" }).click();
    await expect(page.getByRole("button", { name: "Approve this version" })).toBeVisible();
    await page.getByRole("button", { name: "Approve this version" }).click();
    await shot(page, "post-approved");
    const manual = page.getByRole("button", { name: "Post manually instead" });
    if (await manual.isVisible()) await manual.click();
    // The founder posts it themselves, then pastes the live URL (test value).
    await page.getByLabel("Link to the published post").fill("https://www.instagram.com/p/E2E-TEST-POST/");
    await page.getByRole("button", { name: "Mark as posted" }).click();
    await page.waitForTimeout(1000);
    await shot(page, "post-marked-posted");
  });

  await test.step("Insights: CSV import → experiment → recommendation", async () => {
    await page.getByRole("navigation", { name: "Primary" }).first().getByRole("link", { name: "Insights" }).click();
    await page.waitForURL(/\/insights$/);
    await page.getByRole("tab", { name: "Data sources" }).click();
    await page.getByLabel("Choose a CSV file").setInputFiles(CSV);
    await page.getByRole("button", { name: /^Import \d+ rows/ }).click();
    await expect(page.getByText("Import complete")).toBeVisible({ timeout: 120_000 });
    await page.getByRole("tab", { name: "Overview" }).click();
    await shot(page, "insights-overview", true);
    await page.getByRole("tab", { name: "What to try next" }).click();
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("button", { name: "Dismiss" }).first()).toBeVisible({ timeout: 120_000 });
    await shot(page, "insights-recommendations", true);
  });
});
