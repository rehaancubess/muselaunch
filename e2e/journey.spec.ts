import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { CSV, PRESENTER_CLIP, RESULTS, expectFixtureMode, mobileShots, nav, onboardWithAutopilot, shooter, signUp } from "./helpers";

/** The Home tab, with its count of what waits on the person ("Home, 2 waiting for you"). */
const homeTab = (page: Page, count: number) => page.getByRole("navigation", { name: "Primary" }).first().getByRole("link", { name: `Home, ${count} waiting for you` });

/**
 * The phase-2 demo, end to end through the real UI and API in FIXTURE MODE (labelled fixtures for
 * model calls; real jobs, storage, Brand Guardian rules, tracks/cutouts and HyperFrames renders):
 *
 *  1. Paste the sample listing → Go (one-step onboarding, no other choice) → Home, showing the run's
 *     progress screen. With no other input, Autopilot waits for the import, accepts App DNA, sets the
 *     goal from it, researches (cited audience), sets a hypothesis, produces 2 videos, runs the Brand
 *     Guardian, renders within its budget and drafts posts — then Home says "Your content is ready"
 *     (with a count on the Home tab): Schedule post / Edit / Skip. Nothing is published by the loop.
 *  2. Upload a founder clip (synthetic presenter fixture), analyse it with SAM, then in the Studio
 *     Clip tab: "Put the app behind me", "Spotlight my phone", tracking overlay on.
 *  3. Ask Muse for a professional Apple-style commercial with the app behind me, emphasising search,
 *     and three hooks → the edit applies → "Create 3" opens the hooks dialog → 3 hook copies →
 *     each rendered → campaign package exported and downloaded.
 *  4. Scheduled (posts awaiting approval) and Results → details (CSV import, the loop's experiment,
 *     next steps).
 *
 * Screenshots: docs/screenshots/e2e-NN-*.png and e2e-mobile-*.png.
 */

const shot = shooter("e2e");
const ASK = "Make this look like a professional Apple product commercial. Put the app demonstration behind me, emphasise the search feature, and create three different hooks.";
const RENDER_WAIT = 20 * 60_000;

test.describe.configure({ mode: "serial" });

/** Studio: Render → Render final → wait for the real HyperFrames render → close the dialog. */
async function renderFinal(page: Page, label: string) {
  await page.getByRole("button", { name: "Render", exact: true }).click();
  await page.getByRole("button", { name: "Render final" }).click();
  await expect(page.getByText(/Latest final render/), `final render of ${label}`).toBeVisible({ timeout: RENDER_WAIT });
  await page.getByRole("button", { name: "Close" }).last().click();
}

/** The preview must not flash the "Loading assets" overlay after an in-place edit. */
async function expectNoLoadingFlash(page: Page) {
  for (let i = 0; i < 6; i++) {
    await expect.soft(page.getByText("Loading assets"), "edits update the preview in place").toHaveCount(0);
    await page.waitForTimeout(250);
  }
}

test("phase-2 demo: paste → Autopilot → Home, object-aware Studio, hooks (fixture mode)", async ({ page, request, browser }) => {
  test.setTimeout(150 * 60_000); // 5 real final renders on a shared machine
  await expectFixtureMode(request);
  await signUp(page, shot, { email: `founder${Date.now() % 1_000_000}@tidylabs.dev` });
  await onboardWithAutopilot(page, shot);

  const base = () => page.url().replace(/(\/w\/[^/]+\/a\/[^/]+)\/.*$/, "$1");
  let loopUrl = "";
  let homeUrl = "";
  let studioUrl = "";
  let campaignUrl = "";

  await test.step("Home shows the first run's progress: Autopilot works on its own (what it learned accepted, plain steps with real results)", async () => {
    homeUrl = page.url();
    await expect(page.getByRole("link", { name: "Check what we learned" })).toBeVisible({ timeout: 300_000 });
    await expect(page.getByText("What we’re testing")).toBeVisible({ timeout: 300_000 });
    await shot(page, "progress-working", true);
  });

  await test.step("Home: the drafted posts are ready to review (count on the Home tab too); Schedule post", async () => {
    await expect(page.getByRole("heading", { name: "Your content is ready", level: 1 })).toBeVisible({ timeout: 2 * RENDER_WAIT });
    await expect(page.getByText(/2 posts to review/)).toBeVisible({ timeout: RENDER_WAIT });
    await expect(homeTab(page, 2)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("video").first()).toBeVisible();
    await expect(page.getByText(/^Published$/)).toHaveCount(0);
    // Renders went ahead inside the budget; nothing else asked.
    await expect(page.getByRole("button", { name: "Approve spend" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Coming up" })).toBeVisible();
    await expect(page.getByText(/^Made with Muse Wonder/)).toBeVisible();
    await shot(page, "home-ready", true);
    await page.getByRole("button", { name: "Schedule post" }).click();
    await expect(page.getByText("Post scheduled").first()).toBeVisible();
    await expect(homeTab(page, 1)).toBeVisible();
  });

  await test.step("Home: the post still waiting is next, one tap from Schedule post; Edit opens Tell Muse", async () => {
    await expect(page.getByText(/1 post to review/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Schedule post" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Skip" })).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    await expect(page.getByLabel("Tell Muse what to change")).toBeVisible();
    await expect(page.getByText(/Uses about \d+ credits/)).toBeVisible();
    const inDetail = page.getByRole("link", { name: /Edit in detail/ });
    await expect(inDetail).toBeVisible();
    studioUrl = new URL((await inDetail.getAttribute("href"))!, page.url()).toString();
    await shot(page, "home", true);
  });

  await test.step("Show details: the goal came from About your app; the audience choice cites real research", async () => {
    await page.getByRole("link", { name: /How Muse made these/ }).click();
    await page.waitForURL(/\/autopilot\?loop=.*details=1/);
    loopUrl = page.url();
    await expect(page.getByRole("heading", { name: "Goal: Get more installs of Tidy Timer from students" })).toBeVisible();
    const audience = page.getByRole("button", { name: /^Audience 1 decision/ });
    await expect(async () => {
      if ((await audience.getAttribute("aria-expanded")) !== "true") await audience.click();
      await expect(audience).toHaveAttribute("aria-expanded", "true", { timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByLabel("Cited research").first()).toBeVisible();
    await expect(page.getByLabel("Cited research").first().getByText(/example\.com/).first()).toBeVisible();
    await shot(page, "autopilot-loop", true);
  });

  await test.step("Create → Everything Muse found: the loop's research, every finding sourced", async () => {
    await nav(page, "Create");
    await page.waitForURL(/\/create(\?|$)/);
    await page.goto(`${base()}/discover/all`);
    await expect(page.getByRole("heading", { name: "Everything Muse found" })).toBeVisible();
    await expect(page.getByText(/example\.com/).first()).toBeVisible();
    await shot(page, "discover");
  });

  await test.step("Library: upload a founder clip (labelled synthetic fixture)", async () => {
    await page.goto(`${base()}/library`);
    await page.locator('input[type="file"]').first().setInputFiles({ name: "founder-presenter.mp4", mimeType: "video/mp4", buffer: readFileSync(PRESENTER_CLIP) });
    await expect(page.getByLabel("Type of founder-presenter.mp4")).toHaveValue("founder_clip");
    await page.getByRole("checkbox", { name: /I’m the person in this recording/ }).click();
    await page.getByRole("button", { name: /^Upload 1 file/ }).click();
    await expect(page.getByLabel("Uploaded")).toBeVisible({ timeout: 120_000 });
  });

  await test.step("Studio: analyse the clip with SAM, app behind me, spotlight my phone", async () => {
    await page.goto(studioUrl);
    // The Studio opens simple; the clip tools are in the full editor (remembered for this browser).
    await expect(page.getByLabel("Tell Muse what to change")).toBeVisible({ timeout: 60_000 });
    await shot(page, "studio");
    await page.getByRole("button", { name: "Edit in detail" }).click();
    await expect(page.getByRole("tab", { name: "Clip" })).toBeVisible();
    await page.getByRole("tab", { name: "Clip" }).click();
    await page.getByRole("button", { name: "Analyse", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Analyse clip" });
    await dialog.getByRole("button", { name: "Analyse clip" }).click();
    await expect(dialog.getByRole("button", { name: "Use in Studio" })).toBeVisible({ timeout: 300_000 });
    await shot(page, "clip-analysed");
    await dialog.getByRole("button", { name: "Use in Studio" }).click();
    await expect(page.getByRole("region", { name: "Tracked objects" })).toBeVisible();
    await page.getByRole("button", { name: /Put the app behind me/ }).click();
    await expectNoLoadingFlash(page);
    await page.getByRole("button", { name: /Spotlight my phone/ }).click();
    await expectNoLoadingFlash(page);
    // "Use in Studio" already turns the tracking overlay on; make sure it's on for the shot.
    const tracking = page.getByRole("switch", { name: "Show tracking on preview" });
    if ((await tracking.getAttribute("aria-checked")) !== "true") await tracking.click();
    await expect(tracking).toHaveAttribute("aria-checked", "true");
    await page.waitForTimeout(1500);
    await shot(page, "studio-object-aware");
  });

  await test.step("Ask Muse: Apple-style commercial + three hooks", async () => {
    await page.getByRole("tab", { name: "Ask Muse" }).click();
    await page.getByLabel("Edit instruction").fill(ASK);
    await page.getByLabel("Edit instruction").press("Enter");
    await expect(page.getByRole("button", { name: "Apply" })).toBeVisible({ timeout: 180_000 });
    await shot(page, "ask-muse-edit");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText(/Applied as version/)).toBeVisible();
    await expectNoLoadingFlash(page);
    await page.getByRole("button", { name: "Create 3" }).click();
    const hooks = page.getByRole("dialog", { name: "Try different hooks" });
    await expect(hooks).toBeVisible();
    await shot(page, "hooks-dialog");
    await hooks.getByRole("button", { name: "Create 3 hooks" }).click();
    await expect(hooks.getByText("New opening", { exact: true })).toHaveCount(3, { timeout: 300_000 });
    await shot(page, "hooks-created");
    await page.keyboard.press("Escape");
  });

  await test.step("render the three hooks", async () => {
    await page.getByRole("link", { name: /Campaign/ }).first().click();
    await page.waitForURL(/\/creator\/campaigns\//);
    campaignUrl = page.url();
    const hookCards = page.locator("article").filter({ hasText: /— Hook \d/ }).getByRole("link", { name: "Edit in Studio" });
    await expect(hookCards.first()).toBeVisible({ timeout: 60_000 });
    const hrefs = [...new Set(await hookCards.evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href)))];
    expect(hrefs).toHaveLength(3);
    for (const [i, href] of hrefs.entries()) {
      await page.goto(href);
      await expect(page.getByRole("button", { name: "Render", exact: true })).toBeVisible({ timeout: 60_000 });
      await renderFinal(page, `hook ${i + 1}`);
      if (i === 0) await shot(page, "hook-rendered");
    }
  });

  await test.step("export and download the campaign package", async () => {
    await page.goto(campaignUrl);
    const exportBtn = page.getByRole("button", { name: /^Export (package|again)$/ });
    await exportBtn.first().click();
    const link = page.getByRole("link", { name: "Download package" });
    await expect(link).toBeVisible({ timeout: 300_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    const file = `${RESULTS}campaign-package.zip`;
    await download.saveAs(file);
    const zip = readFileSync(file);
    const videos = new Set(zip.toString("latin1").match(/videos\/[\w.-]+\.mp4/g) ?? []);
    // The 3 hooks + the autopilot video left unedited (the edited one has no final render of its new version).
    expect(videos.size, "the package holds the rendered videos").toBeGreaterThanOrEqual(4);
    await shot(page, "campaign", true);
  });

  await test.step("Scheduled: the run's posts wait for approval", async () => {
    await page.goto(`${base()}/creator/scheduled`);
    await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
    await expect(page.getByText(/^Published$/)).toHaveCount(0);
    await shot(page, "calendar", true);
  });

  await test.step("Results → details: CSV import, the run's test, what to try next", async () => {
    await nav(page, "Results");
    await page.waitForURL(/\/results$/);
    await page.goto(`${base()}/insights/details`);
    await page.getByRole("tab", { name: "Data sources" }).click();
    await page.getByLabel("Choose a CSV file").setInputFiles(CSV);
    await page.getByRole("button", { name: /^Import \d+ rows/ }).click();
    await expect(page.getByText("Import complete")).toBeVisible({ timeout: 120_000 });
    await page.getByRole("tab", { name: "Overview" }).click();
    await shot(page, "insights-overview", true);
    await page.getByRole("tab", { name: "Tests" }).click();
    await expect(page.getByText("2 versions", { exact: false }).first()).toBeVisible();
    await shot(page, "insights-experiments");
    await page.getByRole("tab", { name: "What to try next" }).click();
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("button", { name: "Dismiss" }).first()).toBeVisible({ timeout: 120_000 });
    await shot(page, "insights-recommendations", true);
  });

  await test.step("phone-width screenshots", async () => {
    const origin = new URL(page.url()).origin;
    await mobileShots(browser, page, "e2e-mobile", [
      { name: "progress", path: loopUrl.replace(origin, "").replace("&details=1", ""), fullPage: true, wait: (m) => m.locator("video").first().waitFor() },
      { name: "home", path: homeUrl.replace(origin, ""), fullPage: true, wait: (m) => m.getByRole("heading", { level: 1 }).first().waitFor() },
      { name: "autopilot", path: loopUrl.replace(origin, ""), fullPage: true, wait: (m) => m.getByText("Awaiting approval", { exact: true }).first().waitFor() },
      { name: "campaign", path: campaignUrl.replace(origin, ""), fullPage: true, wait: (m) => m.getByRole("heading", { name: "Videos", exact: true }).first().waitFor() },
      { name: "studio", path: studioUrl.replace(origin, ""), wait: (m) => m.getByRole("button", { name: "Render", exact: true }).waitFor() },
    ]);
  });
});
