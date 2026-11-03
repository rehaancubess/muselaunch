import { expect, test } from "@playwright/test";
import { appBase, expectFixtureMode, nav, shooter, signUpAndImport } from "./helpers";

/**
 * Create → Make a carousel, end to end in FIXTURE MODE (labelled fixture slide plans and copy; real
 * API, jobs, storage and HyperFrames rendering): sign up → import → Create → Carousel (Instagram,
 * 4 slides) → Generate carousel → the server's run plans the slides, builds them, checks them and
 * renders one image per slide → the slide gallery, Your content, and the Studio with the slide strip.
 * And a text post: Create → More → Text post (X) → Generate post → the post as it will read.
 */
const shot = shooter("e2e-stills");

test.describe.configure({ mode: "serial" });

test("Create a carousel and a text post (fixture mode)", async ({ page, request }) => {
  await expectFixtureMode(request);
  await signUpAndImport(page, shot, { email: `carousel${Date.now() % 1_000_000}@tidylabs.dev`, shots: false });

  await test.step("Create → Make a carousel → Generate carousel", async () => {
    await nav(page, "Create");
    await page.waitForURL(/\/create(\?|$)/);
    await page.getByRole("button", { name: "Carousel", exact: true }).click();
    await page.getByLabel("Slides").selectOption("4");
    const generate = page.getByRole("button", { name: /^Generate carousel/ });
    await expect(generate).toContainText(/\d+ credits/);
    await shot(page, "create-carousel");
    await generate.click();
    await expect(page.getByRole("heading", { name: "Making your carousel" })).toBeVisible();
    await expect(page.getByText("Planning the slides")).toBeVisible();
  });

  await test.step("the run finishes: the real slides, Download all, Edit, Schedule post", async () => {
    await expect(page.getByRole("heading", { name: "Your carousel is ready" })).toBeVisible({ timeout: 600_000 });
    const slides = page.getByRole("list", { name: /: 4 slides$/ });
    await expect(slides.getByRole("listitem")).toHaveCount(4);
    await expect(slides.getByRole("img").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Download all" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Schedule post" }).first()).toBeVisible();
    await shot(page, "carousel-ready", true);
  });

  await test.step("Studio: slides, not scenes", async () => {
    await page.getByRole("link", { name: "Edit" }).click();
    await page.waitForURL(/\/studio\//);
    await expect(page.getByRole("region", { name: "Slides" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: /^Slide 2 of 4/ }).click();
    await expect(page.getByText("Change slide 2 only").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Play" })).toHaveCount(0);
    await page.waitForTimeout(1500);
    await shot(page, "studio-carousel");
  });

  await test.step("Create → More → Text post → Generate post", async () => {
    await page.goto(`${appBase(page)}/create?make=text_post&run=none`);
    await page.getByLabel("Where it goes").selectOption("x");
    await page.getByRole("button", { name: /^Generate post/ }).click();
    await expect(page.getByRole("heading", { name: "Your post is ready" })).toBeVisible({ timeout: 300_000 });
    await expect(page.getByText(/\/ 280/).first()).toBeVisible();
    await shot(page, "text-post-ready", true);
  });
});
