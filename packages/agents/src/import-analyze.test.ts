import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { handlers } from "./index";
import { fixture, fixtureJson, installFakeMeta, installFakeWeb, jsonRoute, png, resolvePlaceholders } from "./testing";

const IOS_URL = "https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890";

async function setup(opts: { meta?: boolean; missingShot?: number } = {}) {
  const p = createTestPlatform(opts.meta === false ? {} : { META_API_KEY: "test-key" }, handlers);
  const wid = "ws_import_a";
  await p.credits.ensureAccount(wid, { grant: 500, reason: "test" });
  const shots: Record<string, Buffer> = {
    "1": await png([250, 250, 250], [90, 160], [30, 30, 30]),
    "2": await png([22, 24, 36], [90, 160], [240, 240, 240]),
    "3": await png([245, 246, 255], [90, 160], [255, 120, 40]),
  };
  const icon = await png([92, 70, 220], [64, 64], [255, 190, 0]);
  const web = installFakeWeb(p, [
    { match: "https://itunes.apple.com/lookup?id=1234567890&country=us", contentType: "text/javascript; charset=utf-8", body: fixture("itunes-lookup.json") },
    { match: /mzstatic\.com\/image\/thumb\/fixture\/icon/, contentType: "image/png", body: icon },
    ...Object.entries(shots)
      .filter(([n]) => Number(n) !== opts.missingShot)
      .map(([n, buf]) => ({ match: new RegExp(`fixture/shot${n}\\.png`), contentType: "image/png", body: buf })),
    { match: "https://play.google.com/store/apps/details?id=com.tidylabs.timer", contentType: "text/html; charset=utf-8", body: fixture("google-play.html") },
    { match: /play-lh\.googleusercontent\.com\/fixture-icon/, contentType: "image/webp", body: icon },
    { match: /play-lh\.googleusercontent\.com\/fixture-shot/, contentType: "image/png", body: shots["1"]! },
    { match: "https://tidytimer.example.com/apple-touch-icon.png", contentType: "image/png", body: icon },
    { match: "https://tidytimer.example.com", contentType: "text/html", body: fixture("website.html") },
  ]);
  const meta = opts.meta === false ? { requests: [] } : installFakeMeta(p, [jsonRoute("AppDna", (req) => resolvePlaceholders(fixtureJson("spark-app-dna.json"), req))]);
  const ws = p.db.ws(wid);
  return { p, wid, ws, web, meta };
}

async function startImport(s: Awaited<ReturnType<typeof setup>>, sources: { kind: "app_store" | "google_play" | "website"; url: string }[]) {
  const app = await s.ws.collection("apps").create({ name: "New app", status: "importing", storeUrls: { ios: sources.find((x) => x.kind === "app_store")?.url } }, { actor: "u1" });
  const imp = await s.ws.collection("appImports").create({ appId: app.id, sources, status: "queued" }, { actor: "u1" });
  const job = await s.p.jobs.create(s.wid, "app.import", { appId: app.id, importId: imp.id }, { actor: "u1", credits: { operation: "app.import" } });
  await s.p.inline!.drain();
  return { appId: app.id, importId: imp.id, jobId: job.id };
}

describe("app.import → app.analyze → App DNA", () => {
  it("imports an App Store listing into product-truth assets + evidence and builds evidence-linked DNA with Muse Spark", async () => {
    const s = await setup();
    const { appId, importId, jobId } = await startImport(s, [{ kind: "app_store", url: IOS_URL }]);
    const job = await s.p.jobs.get(s.wid, jobId);
    expect(job?.status).toBe("succeeded");

    const app = await s.ws.collection("apps").getOrThrow(appId);
    expect(app).toMatchObject({ name: "Tidy Timer: Focus & Pomodoro", platforms: ["ios"], category: "Productivity", status: "draft", dnaStatus: "needs_review", brandProfileId: appId });

    const imp = await s.ws.collection("appImports").getOrThrow(importId);
    expect(imp.status).toBe("succeeded");
    expect(imp.listings[0]).toMatchObject({ source: "app_store", name: "Tidy Timer: Focus & Pomodoro", price: "Free", ratingObserved: 4.7, ratingCountObserved: 1834 });
    expect(imp.listings[0]!.hasInAppPurchases).toBeUndefined(); // not exposed by Lookup: never guessed

    const assets = (await s.ws.collection("mediaAssets").list({ where: [["appId", "==", appId]], limit: 50 })).items;
    expect(assets).toHaveLength(4);
    for (const a of assets) {
      expect(a).toMatchObject({ isProductTruth: true, origin: "store_import", status: "ready", license: { type: "public_listing" } });
      expect(a.license?.sourceUrl).toMatch(/^https:\/\/is1-ssl\.mzstatic\.com\//);
      expect(a.storagePath.startsWith(`workspaces/${s.wid}/apps/${appId}/import/`)).toBe(true);
    }
    expect(app.iconAssetId).toBe(assets.find((a) => a.role === "icon")?.id);

    const evidence = (await s.ws.collection("appEvidence").list({ where: [["appId", "==", appId]], limit: 100 })).items;
    const block = evidence.find((e) => e.fact === "Block distracting apps during focus sessions");
    expect(block).toMatchObject({ kind: "feature", reviewState: "verified", source: { kind: "store_listing", url: "https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890?uo=4" } });
    expect(evidence.some((e) => e.kind === "metric" && e.fact.includes("4.7 from 1,834 ratings"))).toBe(true);
    expect(evidence.filter((e) => e.kind === "visual" && e.assetId)).toHaveLength(3);
    const obs = evidence.filter((e) => e.source.kind === "screenshot");
    expect(obs).toHaveLength(2); // the observation on an unknown image was dropped
    expect(obs.every((e) => e.reviewState === "needs_review")).toBe(true);

    // Spark was sent the real screenshots + icon (data URLs, local storage) and untrusted listing text.
    const req = s.meta.requests.find((r) => r.text?.format?.name === "AppDna")!;
    expect(req.model).toBe("muse-spark-1.3");
    const images = req.input[0].content.filter((c: { type: string }) => c.type === "input_image");
    expect(images).toHaveLength(4);
    expect(images[0].image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(req.input[0].content[0].text).toContain("<untrusted_content");

    const dna = await s.ws.collection("brandProfiles").getOrThrow(appId);
    expect(dna).toMatchObject({ version: 1, status: "draft", monetization: { model: "freemium" } });
    expect(dna.features.map((f) => f.name)).toEqual(["Pomodoro timer", "Distraction blocking", "Weekly focus reports"]); // "Teleportation" dropped
    const timer = dna.features[0]!;
    const shot1 = assets.find((a) => a.title?.includes("screenshot 1"))!;
    expect(timer.assetIds).toContain(shot1.id);
    expect(timer.evidenceIds.length).toBeGreaterThanOrEqual(2);
    expect(dna.monetization.evidenceIds).toHaveLength(2);
    // Palette from the real icon (violet) + screenshots, deterministic.
    const primary = dna.visual.palette.find((c) => c.role === "primary")!;
    expect(primary.hex).toMatch(/^#[0-9A-F]{6}$/);
    expect(parseInt(primary.hex.slice(5, 7), 16)).toBeGreaterThan(150); // blue-violet channel dominates
    expect(dna.visual.palette.some((c) => c.role === "background")).toBe(true);
    expect(dna.visual.logoAssetIds).toEqual([app.iconAssetId]);

    const claims = (await s.ws.collection("claims").list({ where: [["appId", "==", appId]], limit: 50 })).items;
    const byText = (t: string) => claims.find((c) => c.text === t)!;
    expect(byText("Block distracting apps during focus sessions")).toMatchObject({ state: "verified", speculative: false });
    expect(byText("The #1 focus app for students")).toMatchObject({ state: "needs_review", speculative: true });
    expect(byText("Helps you get more done every week")).toMatchObject({ state: "needs_review", speculative: true });

    const segments = (await s.ws.collection("audienceSegments").list({ where: [["appId", "==", appId]], limit: 20 })).items;
    expect(segments.map((x) => x.origin)).toEqual(["dna", "dna"]);

    const runs = (await s.ws.collection("agentRuns").list({ where: [["appId", "==", appId]], limit: 10 })).items;
    expect(runs[0]).toMatchObject({ kind: "app_analysis", status: "succeeded", model: "muse-spark-1.3" });
    const usage = (await s.ws.collection("modelUsage").list({ where: [["agentRunId", "==", runs[0]!.id]], limit: 10 })).items;
    expect(usage[0]).toMatchObject({ provider: "meta", task: "app_dna.extract", status: "ok", images: 4 });

    // Tenancy: nothing leaked into another workspace.
    expect((await s.p.db.ws("ws_other").collection("appEvidence").list({ limit: 5 })).items).toHaveLength(0);
  });

  it("refresh keeps user-edited fields and existing human-reviewed claims", async () => {
    const s = await setup();
    const { appId } = await startImport(s, [{ kind: "app_store", url: IOS_URL }]);
    await s.ws.collection("brandProfiles").update(appId, { oneLiner: "My own words", userEditedPaths: ["oneLiner", "tone.voice"], tone: { voice: ["playful"], vocabularyUse: [], vocabularyAvoid: [] } }, { actor: "u1" });
    const claim = (await s.ws.collection("claims").list({ where: [["appId", "==", appId]], limit: 50 })).items.find((c) => c.text.startsWith("The #1"))!;
    await s.ws.collection("claims").update(claim.id, { state: "rejected" }, { actor: "u1" });
    await s.p.jobs.create(s.wid, "app.analyze", { appId, refresh: true }, { actor: "u1", credits: { operation: "app.analyze" } });
    await s.p.inline!.drain();
    const dna = await s.ws.collection("brandProfiles").getOrThrow(appId);
    expect(dna.version).toBe(2);
    expect(dna.oneLiner).toBe("My own words");
    expect(dna.tone.voice).toEqual(["playful"]);
    expect(dna.tone.vocabularyAvoid).toEqual(["hustle"]); // not edited → refreshed
    expect((await s.ws.collection("claims").getOrThrow(claim.id)).state).toBe("rejected");
  });

  it("partial import: a failed screenshot download becomes a warning, never a placeholder", async () => {
    const s = await setup({ missingShot: 2 });
    const { appId, importId } = await startImport(s, [{ kind: "app_store", url: IOS_URL }]);
    const imp = await s.ws.collection("appImports").getOrThrow(importId);
    expect(imp.status).toBe("partial");
    expect(imp.warnings.join(" ")).toMatch(/screenshot 2/);
    const shots = (await s.ws.collection("mediaAssets").list({ where: [["appId", "==", appId]], limit: 50 })).items.filter((a) => a.role === "screenshot");
    expect(shots).toHaveLength(2);
  });

  it("imports Google Play and a website (discovering the App Store link on the site)", async () => {
    const s = await setup();
    const { appId, importId } = await startImport(s, [
      { kind: "google_play", url: "https://play.google.com/store/apps/details?id=com.tidylabs.timer" },
      { kind: "website", url: "https://tidytimer.example.com/" },
    ]);
    const imp = await s.ws.collection("appImports").getOrThrow(importId);
    const play = imp.listings.find((l) => l.source === "google_play")!;
    expect(play).toMatchObject({ name: "Tidy Timer: Focus & Pomodoro", developer: "Tidy Labs Ltd", category: "Productivity", price: "Free", hasInAppPurchases: true, ratingObserved: 4.6, ratingCountObserved: 912 });
    expect(play.screenshotUrls[0]).toBe("https://play-lh.googleusercontent.com/fixture-shot-a=h1600");
    const site = imp.listings.find((l) => l.source === "website")!;
    expect(site.name).toBe("Tidy Timer — calm focus sessions");
    expect(site.description).not.toContain("window.tracking");
    expect(imp.listings.some((l) => l.source === "app_store")).toBe(true); // discovered on the website
    const app = await s.ws.collection("apps").getOrThrow(appId);
    expect(app.platforms.sort()).toEqual(["android", "ios"]);
    expect(app.storeUrls.ios).toBe(IOS_URL);
    // The injected sentence on the website never becomes a verified claim.
    const claims = (await s.ws.collection("claims").list({ where: [["appId", "==", appId]], limit: 50 })).items;
    expect(claims.some((c) => /10 million/.test(c.text))).toBe(false);
  });

  it("fails visibly (no fake DNA) when the Meta API is not configured", async () => {
    const s = await setup({ meta: false });
    const { appId, importId } = await startImport(s, [{ kind: "app_store", url: IOS_URL }]);
    const jobs = (await s.ws.collection("jobs").list({ where: [["appId", "==", appId]], limit: 10 })).items;
    const analyze = jobs.find((j) => j.type === "app.analyze")!;
    expect(analyze.status).toBe("failed");
    expect(analyze.error?.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(await s.ws.collection("brandProfiles").get(appId)).toBeNull();
    expect((await s.ws.collection("apps").getOrThrow(appId)).dnaStatus).toBe("failed");
    expect((await s.ws.collection("appImports").getOrThrow(importId)).status).toBe("partial");
    // credits for the failed analysis were released
    const bal = await s.p.credits.balance(s.wid);
    expect(bal.reserved).toBe(0);
  });

  it("fails the import with a clear message when no source can be read", async () => {
    const s = await setup();
    const { importId, jobId } = await startImport(s, [{ kind: "app_store", url: "https://apps.apple.com/us/app/nothing/id999999999" }]);
    expect((await s.p.jobs.get(s.wid, jobId))?.status).toBe("failed");
    const imp = await s.ws.collection("appImports").getOrThrow(importId);
    expect(imp.status).toBe("failed");
  });
});

describe("App Store screenshot size", () => {
  it("asks mzstatic for a 2400 px rendition (same aspect ratio); other URLs are unchanged", async () => {
    const { upscaleAppStoreImage } = await import("./import/parsers");
    expect(upscaleAppStoreImage("https://is1-ssl.mzstatic.com/image/thumb/Purple/v4/ab/shot.png/392x696bb.png")).toBe("https://is1-ssl.mzstatic.com/image/thumb/Purple/v4/ab/shot.png/1352x2400bb.png");
    expect(upscaleAppStoreImage("https://is1-ssl.mzstatic.com/image/thumb/x/shot.jpg/696x392bb.jpg")).toBe("https://is1-ssl.mzstatic.com/image/thumb/x/shot.jpg/2400x1352bb.jpg");
    expect(upscaleAppStoreImage("https://is1-ssl.mzstatic.com/image/thumb/x/shot.png/2400x5000bb.png")).toBe("https://is1-ssl.mzstatic.com/image/thumb/x/shot.png/2400x5000bb.png");
    expect(upscaleAppStoreImage("https://example.com/shot/392x696bb.png")).toBe("https://example.com/shot/392x696bb.png");
  });
});
