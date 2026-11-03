import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { API, appBase, expectFixtureMode, nav, signUpAndImport } from "./helpers";

/**
 * LAYOUT REVIEW of the stills and text-post views (Create's "Make a…" choices, a finished carousel,
 * a finished text post, the Studio with a carousel, Home's carousel post) in FIXTURE MODE.
 *
 * The app, its facts and screenshots come from the real fixture journey (sign up → import). The
 * finished results are not made by a run here (the server's still/text create runs are another
 * module's work): their reads are INTERCEPTED with labelled layout fixtures built from real HyperFrames
 * slide renders of the render module's sample storyboard (`pnpm tsx e2e/make-stills-fixture.ts <dir>`).
 * Nothing here is product output; the screenshots are for reviewing the layout only.
 *
 *   STILLS_FX=<dir with carousel-*.png, store-*.png, *-doc.json, *-preview.json> SHOTS_DIR=<out> pnpm e2e -g "stills layout"
 */
const FX = process.env.STILLS_FX ?? "";
const OUT = process.env.SHOTS_DIR ?? "docs/screenshots/stills";
const has = (f: string) => FX && existsSync(join(FX, f));
const png = (f: string) => readFileSync(join(FX, f));

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

test.describe.configure({ mode: "serial" });

test("stills layout (fixture mode, intercepted results)", async ({ page, browser, request }) => {
  test.skip(!has("carousel-1.png"), "Set STILLS_FX to the output of e2e/make-stills-fixture.ts");
  await expectFixtureMode(request);
  await signUpAndImport(page, async () => {}, { email: `stills${Date.now() % 1_000_000}@tidylabs.dev`, shots: false });
  const base = appBase(page);
  const wid = base.match(/\/w\/([^/]+)\//)![1]!;
  const appId = base.match(/\/a\/([^/]+)$/)![1]!;
  const W = `${API}/v1/workspaces/${wid}`;

  // ---- labelled layout fixtures
  // The render worker's ids: slide 1 `ast_r_<key>`, slide n `ast_r_<key>_<n>`.
  const slides = (name: string, n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? `ast_fx_${name}` : `ast_fx_${name}_${i + 1}`));
  const carouselIds = slides("carousel", 4);
  const storeIds = slides("store", 4);
  const files = new Map<string, string>([...carouselIds.map((id, i) => [id, `carousel-${i + 1}.png`] as const), ...storeIds.map((id, i) => [id, `store-${i + 1}.png`] as const)]);
  const doc = JSON.parse(readFileSync(join(FX, "carousel-doc.json"), "utf8"));
  const previewFx = JSON.parse(readFileSync(join(FX, "carousel-preview.json"), "utf8"));
  const run = (over: Record<string, unknown>) => ({
    appId,
    request: "Introduce Tidy Timer: a calm Pomodoro timer that blocks distracting apps.",
    name: "Calm focus, one tap",
    kind: "promote",
    startedBy: "u",
    createdAt: iso(3),
    stage: "done",
    status: "done",
    pct: 100,
    ideaTitle: "One tap to deep work",
    ideaCount: 3,
    decision: null,
    failure: null,
    wait: null,
    video: null,
    actions: ["retry"],
    ...over,
  });
  const carouselRun = run({ campaignId: "cpg_fx_carousel", compositionId: "cmp_fx_carousel", format: { aspectRatio: "4:5", channel: "instagram", output: "carousel", slides: 4 }, stills: { assetIds: carouselIds, version: 1, width: 1080, height: 1350, renderedAt: iso(2) } });
  const textRun = run({
    campaignId: "cpg_fx_text",
    createdAt: iso(1),
    ideaTitle: "Phones win, focus loses",
    format: { aspectRatio: "1:1", channel: "x", output: "text_post" },
    text: { copyPackId: "cpk_fx", channel: "x", ok: true, text: "Your phone wins most focus battles.\n\nTidy Timer blocks the apps that pull you away while a session runs, then shows how your focus adds up across the week.\n\nTry one 25-minute session today: [APP_LINK]" },
  });
  const makingRun = run({ campaignId: "cpg_fx_making", createdAt: iso(0), stage: "make", status: "working", pct: 58, detail: "rendering slides", ideaTitle: "Five screens, one calm day", format: { aspectRatio: "9:19.5", channel: "app_store", output: "store_screenshots", slides: 4, store: "ios" }, stills: null });
  let runs = [makingRun, textRun, carouselRun];

  const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(`${W}/apps/${appId}/create-runs**`, (r) => json(r, { items: runs }));
  await page.route(`${W}/create-runs/*`, (r) => json(r, { run: runs.find((x) => r.request().url().includes(x.campaignId as string)) }));
  await page.route(/\/assets\/ast_fx_[a-z]+(?:_\d+)?\/url/, (r) => {
    const id = r.request().url().match(/assets\/(ast_fx_[a-z]+(?:_\d+)?)\/url/)![1]!;
    return json(r, { url: `${W}/fx-file/${id}.png`, expiresAt: iso(-60) });
  });
  await page.route(/\/fx-file\/ast_fx_[a-z]+(?:_\d+)?\.png/, (r) => r.fulfill({ status: 200, contentType: "image/png", body: png(files.get(r.request().url().match(/(ast_fx_[a-z]+(?:_\d+)?)\.png/)![1]!)!) }));
  // Your content reads final renders from /assets?role=render: add the fixture slides.
  await page.route(`${W}/assets?**`, async (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get("role") !== "render") return r.continue();
    const real = (await (await r.fetch()).json()) as { items: unknown[] };
    const asset = (id: string, i: number, comp: string, w: number, h: number) => ({ id, appId, campaignId: `cpg_fx_${comp.split("_").pop()}`, kind: "image", role: "render", origin: "render", status: "ready", mimeType: "image/png", bytes: 1, width: w, height: h, title: `Fixture — slide ${i + 1}`, labels: [`slide:${i + 1}`], isProductTruth: false, storagePath: "x", createdAt: iso(2), updatedAt: iso(2), workspaceId: wid, createdBy: "u", render: { compositionId: comp, version: 1, quality: "final" } });
    return json(r, { items: [...carouselIds.map((id, i) => asset(id, i, "cmp_fx_carousel", 1080, 1350)), ...storeIds.map((id, i) => asset(id, i, "cmp_fx_store", 1290, 2796)), ...real.items], nextCursor: null });
  });
  await page.route(`${W}/compositions?**`, async (r) => {
    const real = (await (await r.fetch()).json()) as { items: unknown[] };
    return json(r, { items: [{ id: "cmp_fx_carousel", title: "One tap to deep work" }, { id: "cmp_fx_store", title: "Five screens, one calm day" }, ...real.items], nextCursor: null });
  });

  // ---- Create: the Make a… choices
  await nav(page, "Create");
  await page.waitForURL(/\/create(\?|$)/);
  await expect(page.getByRole("group", { name: "Make a" })).toBeVisible();
  runs = [];
  await page.reload();
  await page.getByRole("button", { name: "Carousel", exact: true }).click();
  await expect(page.getByRole("button", { name: /Generate carousel/ })).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/create-carousel-1280.png` });
  await page.getByRole("button", { name: "More formats" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/create-more-menu-1280.png` });
  await page.getByRole("menuitem", { name: /App Store screenshots/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/create-store-1280.png` });
  await page.getByRole("button", { name: /More formats/ }).click();
  await page.getByRole("menuitem", { name: /Text post/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/create-text-1280.png` });

  // ---- finished carousel and text post, Your content
  runs = [makingRun, textRun, carouselRun];
  await page.goto(`${base}/create?run=cpg_fx_carousel`);
  await expect(page.getByRole("heading", { name: "Your carousel is ready" })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/result-carousel-1280.png`, fullPage: true });
  await page.goto(`${base}/create?run=cpg_fx_text`);
  await expect(page.getByRole("heading", { name: "Your post is ready" })).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/result-text-1280.png`, fullPage: true });

  // ---- phone width
  const session = await page.evaluate(() => localStorage.getItem("ml.devSession"));
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, baseURL: new URL(page.url()).origin });
  await ctx.addInitScript((s) => s && localStorage.setItem("ml.devSession", s), session);
  const m = await ctx.newPage();
  for (const [pattern, handler] of [
    [`${W}/apps/${appId}/create-runs**`, (r: Route) => json(r, { items: runs })],
    [/\/assets\/ast_fx_[a-z]+(?:_\d+)?\/url/, (r: Route) => json(r, { url: `${W}/fx-file/${r.request().url().match(/assets\/(ast_fx_[a-z]+(?:_\d+)?)\/url/)![1]}.png`, expiresAt: iso(-60) })],
    [/\/fx-file\/ast_fx_[a-z]+(?:_\d+)?\.png/, (r: Route) => r.fulfill({ status: 200, contentType: "image/png", body: png(files.get(r.request().url().match(/(ast_fx_[a-z]+(?:_\d+)?)\.png/)![1]!)!) })],
  ] as const)
    await m.route(pattern as string, handler);
  await m.route(`${W}/assets?**`, async (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get("role") !== "render") return r.continue();
    return json(r, { items: carouselIds.map((id, i) => ({ id, appId, campaignId: "cpg_fx_carousel", kind: "image", role: "render", origin: "render", status: "ready", mimeType: "image/png", bytes: 1, width: 1080, height: 1350, title: "Fixture", labels: [`slide:${i + 1}`], isProductTruth: false, storagePath: "x", createdAt: iso(2), updatedAt: iso(2), workspaceId: wid, createdBy: "u", render: { compositionId: "cmp_fx_carousel", version: 1, quality: "final" } })), nextCursor: null });
  });
  const shots: [string, string, (p: Page) => Promise<unknown>][] = [
    ["create-carousel-390", `${base}/create?make=carousel&run=none`, (p) => expect(p.getByRole("button", { name: /Generate carousel/ })).toBeVisible()],
    ["create-store-390", `${base}/create?make=store_screenshots&store=android&run=none`, (p) => expect(p.getByRole("button", { name: /Generate screenshots/ })).toBeVisible()],
    ["create-text-390", `${base}/create?make=text_post&run=none`, (p) => expect(p.getByRole("button", { name: /Generate post/ })).toBeVisible()],
    ["result-carousel-390", `${base}/create?run=cpg_fx_carousel`, (p) => expect(p.getByRole("heading", { name: "Your carousel is ready" })).toBeVisible()],
    ["result-text-390", `${base}/create?run=cpg_fx_text`, (p) => expect(p.getByRole("heading", { name: "Your post is ready" })).toBeVisible()],
  ];
  for (const [name, path, ready] of shots) {
    runs = path.includes("run=none") ? [] : [makingRun, textRun, carouselRun];
    await m.goto(path);
    await ready(m);
    await m.waitForTimeout(1200);
    // Phone width: no horizontal page scroll.
    expect(await m.evaluate(() => document.documentElement.scrollWidth), `${name}: no horizontal scroll`).toBeLessThanOrEqual(390);
    // A result opened by link: the page scrolls to the run's panel by itself.
    if (name.startsWith("result-")) await expect.poll(() => m.evaluate(() => window.scrollY)).toBeGreaterThan(200);
    await m.waitForTimeout(600);
    await m.screenshot({ path: `${OUT}/${name}.png` });
    if (name.startsWith("result-carousel")) {
      await m.screenshot({ path: `${OUT}/${name}-full.png`, fullPage: true });
    }
  }

  // ---- Studio with a carousel doc (intercepted composition read; the real preview compiler's HTML)
  const comp = { id: "cmp_fx_carousel", appId, campaignId: "cpg_fx_carousel", title: "One tap to deep work", kind: "carousel", aspectRatio: "4:5", currentVersion: 1, latestVersion: 1, redoStack: [], status: "rendered", lastRender: { jobId: "job_fx", version: 1, quality: "final", assetId: carouselIds[0], at: iso(2) }, workspaceId: wid, createdAt: iso(5), updatedAt: iso(2), createdBy: "u" };
  const compBody = { composition: comp, version: { id: "cmp_fx_carousel_v1", compositionId: comp.id, version: 1, parentVersion: null, doc, source: "generated", summary: "Fixture", contentHash: "x", sceneHashes: {}, workspaceId: wid, createdAt: iso(5), updatedAt: iso(5), createdBy: "u" }, lint: [], lastRender: { ...comp.lastRender, asset: { id: carouselIds[0], width: 1080, height: 1350 }, url: "", posterUrl: null, expiresAt: iso(-60) }, durationSec: doc.scenes.reduce((n: number, s: { durationSec: number }) => n + s.durationSec, 0) };
  for (const pg of [page, m]) {
    await pg.route(`${W}/compositions/cmp_fx_carousel`, (r) => json(r, compBody));
    await pg.route(`${W}/compositions/cmp_fx_carousel/preview**`, (r) => json(r, { ...previewFx, posterSec: 0.5, version: 1, missingAssetIds: [], expiresInSec: 3600 }));
    await pg.route(/\/compositions\/cmp_fx_carousel\/(clips|video-reviews|patches|sound)/, (r) => json(r, { items: [], tracks: {}, current: null, frameUrls: {} }));
    await pg.route(`${W}/reviews**`, (r) => json(r, { items: [], glimmer: null }));
  }
  await page.goto(`${base}/creator/studio/cmp_fx_carousel?mode=simple`);
  await expect(page.getByRole("region", { name: "Slides" })).toBeVisible();
  await page.getByRole("button", { name: /Slide 2 of 4/ }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/studio-carousel-1280.png` });
  await m.goto(`${base}/creator/studio/cmp_fx_carousel?mode=simple`);
  await expect(m.getByRole("region", { name: "Slides" })).toBeVisible();
  await m.waitForTimeout(2500);
  expect(await m.evaluate(() => document.documentElement.scrollWidth), "studio: no horizontal scroll").toBeLessThanOrEqual(390);
  await m.screenshot({ path: `${OUT}/studio-carousel-390.png` });
  await m.screenshot({ path: `${OUT}/studio-carousel-390-full.png`, fullPage: true });

  // ---- Home: a carousel post and a text post waiting for the OK
  const decision = (id: string) => ({ id: `apr_${id}`, kind: "post", action: "publish", appId, title: "Publish", summary: "", createdAt: iso(1), subject: { entity: "scheduledPosts", id }, requiredCap: "publish", canDecide: true, stale: false, approve: { path: `/approvals/apr_${id}/approve`, body: {} }, reject: { path: `/approvals/apr_${id}/reject`, body: {} } });
  const post = (id: string, over: Record<string, unknown>) => ({ id, mode: "manual", status: "awaiting_approval", timezone: "UTC", scheduledAt: iso(-24 * 60), account: null, manualReason: "Not connected", compositionId: undefined, decision: decision(id), change: null, canChange: true, ...over });
  const today = {
    appId,
    needs: [],
    videos: [],
    posts: [
      post("pst_fx_carousel", { channel: "instagram", title: "One tap to deep work", caption: "Four screens from a calm day with Tidy Timer. Swipe to see how a focus block works.", copyText: "", video: { assetId: carouselIds[0], kind: "image", width: 1080, height: 1350 }, images: carouselIds.map((a) => ({ assetId: a, width: 1080, height: 1350 })), compositionId: "cmp_fx_carousel", compositionTitle: "One tap to deep work" }),
      post("pst_fx_text", { channel: "x", caption: (textRun.text as { text: string }).text, copyText: "", video: null }),
    ],
  };
  for (const pg of [page, m]) await pg.route(`${W}/apps/${appId}/today`, (r) => json(r, today));
  await page.goto(`${base}/home`);
  await expect(page.getByRole("heading", { name: "One tap to deep work" })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/home-carousel-1280.png` });
  await m.goto(`${base}/home`);
  await expect(m.getByRole("heading", { name: "One tap to deep work" })).toBeVisible();
  await m.waitForTimeout(1500);
  await m.screenshot({ path: `${OUT}/home-carousel-390.png` });
  today.posts.reverse();
  await m.goto(`${base}/home`);
  await m.waitForTimeout(1500);
  await m.screenshot({ path: `${OUT}/home-text-390.png` });
  await ctx.close();
});
