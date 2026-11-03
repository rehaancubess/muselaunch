import { expect, test } from "@playwright/test";
import { CSV, appBase, expectFixtureMode, nav, shooter, signUpAndImport } from "./helpers";

/**
 * The hands-on campaign flow, end to end through the real UI and API in FIXTURE MODE:
 * onboarding → import → About your app confirmed → research (Create → Everything Muse found) → new
 * campaign (Create → Make) → ideas → produce → Studio (AI edit, undo) → final render → export → post +
 * tracked link → approve → post manually → Results → details: CSV import → test → recommendation.
 * (journey.spec.ts covers the Autopilot demo.)
 *
 * AI responses are labelled fixtures (see apps/api/src/dev-fixture.ts); everything else is real.
 */

const shot = shooter("e2e-campaign");

test.describe.configure({ mode: "serial" });

test("hands-on campaign flow (fixture mode)", async ({ page, request }) => {
  await expectFixtureMode(request);
  await signUpAndImport(page, shot, { email: `maker${Date.now() % 1_000_000}@tidylabs.dev`, shots: false });

  await test.step("Create → Everything Muse found: research the market → ideas with their sources", async () => {
    await nav(page, "Create");
    await page.waitForURL(/\/create(\?|$)/);
    await page.goto(`${appBase(page)}/discover/all`);
    await page.getByRole("button", { name: "Research market" }).click();
    await page.getByRole("dialog", { name: "Research the market" }).getByRole("button", { name: "Start research" }).click();
    await expect(page.getByText("Research finished")).toBeVisible({ timeout: 120_000 });
    await page.reload();
    await expect(page.getByRole("button", { name: "Make a video" }).first()).toBeVisible();
    await expect(page.getByText(/example\.com/).first()).toBeVisible();
    await shot(page, "discover-everything");
  });

  await test.step("Create → Make: new campaign → ideas", async () => {
    await page.goto(`${appBase(page)}/creator/make`);
    await page.locator("#creator-request").fill("Create five promotional Reels introducing Tidy Timer, using a premium Apple-style aesthetic.");
    await shot(page, "creator");
    await page.getByRole("button", { name: "Plan campaign" }).click();
    await page.waitForURL(/\/creator\/new/);
    await shot(page, "new-campaign");
    await page.getByRole("button", { name: "Write ideas" }).click();
    await page.waitForURL(/\/creator\/campaigns\//);
    await expect(page.getByRole("button", { name: "Select" }).nth(2)).toBeVisible({ timeout: 120_000 });
    await shot(page, "concepts", true);
  });

  await test.step("produce an idea → video rendered", async () => {
    await page.getByRole("button", { name: "Select" }).nth(1).click();
    await page.getByRole("button", { name: "Produce", exact: true }).click();
    await page.getByRole("button", { name: "Start production" }).click();
    await expect(page.getByRole("link", { name: "Open in Studio" })).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText("Rendered", { exact: true }).first()).toBeVisible({ timeout: 240_000 });
    await shot(page, "campaign-produced", true);
  });

  await test.step("Studio (simple view): tell it what to change, apply, undo", async () => {
    await page.getByRole("link", { name: "Open in Studio" }).click();
    await page.waitForURL(/\/studio\//);
    const change = page.getByLabel("Tell Muse what to change");
    await expect(change).toBeVisible();
    await shot(page, "studio");
    await change.fill("Make the opening more engaging");
    await change.press("Enter");
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
    // Real HyperFrames render: allow for slow, shared CI machines.
    await expect(page.getByText(/Latest final render/)).toBeVisible({ timeout: 15 * 60_000 });
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
    await expect(dialog.getByLabel("Media", { exact: true })).not.toHaveValue("");
    await dialog.getByLabel("Caption").fill("Forward. Focus. Done. Tidy Timer blocks distractions for 25 calm minutes.");
    await shot(page, "new-post");
    await dialog.getByRole("button", { name: "Create draft" }).click();
    await expect(page.getByText("Draft post created")).toBeVisible();
    await page.reload();
    await expect(page.getByText(/1 click|0 clicks/).first()).toBeVisible();
    await shot(page, "campaign-export-links", true);
  });

  await test.step("Scheduled: approve and post manually", async () => {
    await page.goto(page.url().replace(/\/creator\/campaigns\/.*$/, "/creator/scheduled"));
    // The draft has no time yet, so it's listed under "Not scheduled yet"; open it from there.
    await page.getByText("Forward. Focus. Done.", { exact: false }).first().click();
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
    await page.keyboard.press("Escape");
  });

  await test.step("Results → details: CSV import → test → recommendation", async () => {
    await nav(page, "Results");
    await page.waitForURL(/\/results$/);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await shot(page, "results", true);
    await page.goto(`${appBase(page)}/insights/details`);
    await page.getByRole("tab", { name: "Data sources" }).click();
    await page.getByLabel("Choose a CSV file").setInputFiles(CSV);
    await page.getByRole("button", { name: /^Import \d+ rows/ }).click();
    await expect(page.getByText("Import complete")).toBeVisible({ timeout: 120_000 });
    await page.getByRole("tab", { name: "Overview" }).click();
    await shot(page, "insights-overview", true);
    await page.getByRole("tab", { name: "Tests" }).click();
    await page.getByRole("button", { name: "New test" }).click();
    const exp = page.getByRole("dialog");
    await exp.getByLabel("Title").fill("Question hook vs statement hook");
    await exp.getByLabel("What we’re testing").fill("A question-led first line earns more link clicks.");
    await exp.getByLabel("Version A (the one to beat)").fill("Statement hook");
    await exp.getByLabel("Version B").fill("Question hook");
    await exp.getByRole("button", { name: "Create" }).click();
    await page.getByRole("button", { name: "Analyze with Muse Spark" }).click();
    // With no per-version data yet the honest result is "Insufficient data" (the model is skipped).
    await expect(page.getByText(/Insufficient data|Low confidence|Medium confidence|High confidence/).first()).toBeVisible({ timeout: 120_000 });
    await shot(page, "insights-experiment");
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "What to try next" }).click();
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("button", { name: "Dismiss" }).first()).toBeVisible({ timeout: 120_000 });
    await shot(page, "insights-recommendations", true);
    // Back on Results (the old Insights page redirects there): the imported numbers, with their sources.
    await page.getByRole("link", { name: "Results", exact: true }).first().click();
    await page.waitForURL(/\/results$/);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await shot(page, "results-measured", true);
  });
});
