import type { JobContext } from "@muselaunch/platform";
import { createTestPlatform } from "@muselaunch/platform";
import type { MediaAsset, RecordingSegment } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { handlers } from "./index";
import { checkSlides, cutBody, cutHeadline, polishSlides, realScreens, slideCount, SlidePlanOutput, type PlanSlide, type SlideCheckContext } from "./slides";
import { installFakeMeta, jsonRoute, requestText, schemaName, seedApp, slidePlanRoute, type MetaRequest, type MetaRoute } from "./testing";

const now = "2026-11-03T00:00:00.000Z";
const asset = (id: string, over: Partial<MediaAsset> = {}): MediaAsset =>
  ({ id, workspaceId: "ws", createdAt: now, updatedAt: now, createdBy: "u", appId: "app", kind: "image", role: "screenshot", origin: "upload", storagePath: `workspaces/ws/${id}.png`, mimeType: "image/png", bytes: 1, status: "ready", labels: [], isProductTruth: true, width: 1179, height: 2556, ...over }) as MediaAsset;
const seg = (id: string, over: Partial<RecordingSegment> = {}): RecordingSegment =>
  ({ id, workspaceId: "ws", createdAt: now, updatedAt: now, createdBy: "u", appId: "app", assetId: "ast_rec", startSec: 0, endSec: 6, label: id, action: "tap", featureIds: [], quality: 0.8, privacy: { flagged: false, regions: [] }, keyframeAssetId: `kf_${id}`, ...over }) as RecordingSegment;

const sl = (template: PlanSlide["template"], over: Partial<PlanSlide> = {}): PlanSlide => ({ template, purpose: "feature", headline: "Start one calm session", body: "", visual: "v", assets: [], claimIds: [], ...over });
const plan = (slides: PlanSlide[]) => SlidePlanOutput.parse({ title: "T", slides });
const shot = (id: string) => [{ kind: "screenshot" as const, assetId: id }];

function ctx(format: SlideCheckContext["format"], slides: number, over: Partial<SlideCheckContext> = {}): SlideCheckContext {
  const assets = [
    asset("ast_a"),
    asset("ast_b"),
    asset("ast_c"),
    asset("ast_mkt", { screenshotKind: "marketing" }),
    asset("ast_crop", { sourceLabel: "sam_ui_crop", derivedFromAssetId: "ast_mkt", screenshotKind: "raw_ui" }),
    asset("ast_mkt_solo", { screenshotKind: "marketing" }),
    asset("ast_rec", { kind: "video", role: "app_recording", mimeType: "video/mp4" }),
    asset("ast_gen", { role: "generated_image", isProductTruth: false, origin: "generated" }),
    asset("ast_founder", { kind: "video", role: "founder_clip", isProductTruth: false }),
  ];
  return {
    format,
    slides,
    assets: new Map(assets.map((a) => [a.id, a])),
    verifiedClaimIds: new Set(["clm_ok"]),
    verifiedClaimText: "Block distracting apps during focus sessions",
    featureAssets: new Map([["feat_reports", ["ast_c"]]]),
    segments: new Map([seg("rsg_1", { featureIds: ["feat_timer"] })].map((s) => [s.id, s])),
    ...over,
  };
}

describe("slide plans: deterministic checks", () => {
  it("offers real screens only, best first (screenshots and cut-outs, then segments); never a designed store image or generated media", () => {
    const keys = realScreens(ctx("carousel", 6)).map((m) => m.key);
    expect(keys).toEqual(["ast_a", "ast_b", "ast_c", "ast_crop", "seg:rsg_1"]);
    expect(keys).not.toContain("ast_mkt");
    expect(keys).not.toContain("ast_gen");
    // A store set never has more screenshots than real screens (but at least the store minimum).
    expect(slideCount("store_screenshots", 10, "ios", 5)).toBe(5);
    expect(slideCount("store_screenshots", 10, "ios", 1)).toBe(3);
    expect(slideCount("store_screenshots", 9, "android", 12)).toBe(8);
    expect(slideCount("carousel", undefined, undefined, 2)).toBe(6);
    expect(slideCount("thumbnail", 4, undefined, 2)).toBe(1);
  });

  it("carousel: cover first, CTA last, real screens on feature slides, proof only with a verified claim, words within limits, no repeats", () => {
    const c = ctx("carousel", 5);
    const r = checkSlides(
      plan([
        sl("slide-feature", { purpose: "hook", headline: "Your phone keeps winning every single study night, again and again", assets: shot("ast_a") }),
        sl("slide-feature", { headline: "Start one calm session", assets: [{ kind: "screenshot", assetId: "ast_mkt" }] }), // → its cut-out
        sl("slide-feature", { headline: "Start one calm session", assets: shot("ast_gen") }), // generated: dropped, then a real screen attached
        sl("slide-proof", { purpose: "proof", headline: "Loved by 10,000 students", claimIds: ["clm_invented"] }),
        sl("slide-feature", { headline: "Get it", body: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen" }),
      ]),
      c,
    );
    expect(r.problems).toEqual([]);
    const soft = r.soft.join("\n");
    expect(soft).toMatch(/Slide 1 must be the cover/);
    expect(soft).toMatch(/last slide must be the call to action/);
    expect(soft).toMatch(/Slide 1 headline has 11 words .*at most 8/);
    expect(soft).toMatch(/Slide 4 is a proof slide without a verified claim id/);
    expect(soft).toMatch(/Slide 5 body has 19 words; at most 18/);
    expect(soft).toMatch(/Slide 3 repeats slide 2's headline/);
    expect(r.slides[1]!.assets[0]).toMatchObject({ kind: "screenshot", assetId: "ast_crop" });
    expect(r.slides[2]!.assets[0]!.assetId).not.toBe("ast_gen");
    expect(r.slides[3]!.claimIds).toEqual([]);
    expect(r.fixes.join("\n")).toMatch(/removed unverified claim ids/);
    expect(r.fixes.join("\n")).toMatch(/cut-out ast_crop instead of the designed store image ast_mkt/);

    // Polish: cover → features → CTA, a different real screen on each feature slide, words cut.
    const p = polishSlides(r.slides, c, "Start your first focus session");
    const t = p.slides.map((s) => s.template);
    expect(t[0]).toBe("slide-cover");
    expect(t[t.length - 1]).toBe("slide-cta");
    expect(t).not.toContain("slide-proof"); // unbacked proof became a feature slide (the count allows no drop)
    expect(p.slides.length).toBe(5);
    for (const s of p.slides) expect(s.headline.split(/\s+/).length).toBeLessThanOrEqual(8);
    for (const s of p.slides) expect(s.body.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(18);
    const featureScreens = p.slides.filter((s) => s.template === "slide-feature").map((s) => s.assets[0]?.segmentId ?? s.assets[0]?.assetId);
    expect(new Set(featureScreens).size).toBe(featureScreens.length);
    expect(checkSlides({ title: "T", slides: p.slides }, c).soft.filter((x) => /cover|call to action|words|same screen/.test(x))).toEqual([]);
  });

  it("store screenshots: every slide a store-screenshot with a different real screen; no prices or rankings without a verified claim", () => {
    const c = ctx("store_screenshots", 4, { store: "ios" });
    const r = checkSlides(
      plan([
        sl("store-screenshot", { headline: "The #1 focus app for students", assets: shot("ast_a") }),
        sl("store-screenshot", { headline: "Pro for $4.99 a month", assets: shot("ast_a") }),
        sl("slide-feature", { headline: "See your weekly streak", assets: shot("ast_c") }),
        sl("store-screenshot", { headline: "Silence distracting apps", body: "They wait quietly until your focus session is completely finished today", assets: [{ kind: "app_recording", segmentId: "rsg_1" }] }),
      ]),
      c,
    );
    const soft = r.soft.join("\n");
    expect(soft).toMatch(/Slide 1 headline has 6 words|Slide 1: "#1"/);
    expect(soft).toMatch(/"#1" is a superlative/);
    expect(soft).toMatch(/Slide 2 mentions a price \("\$4\.99"\)/);
    expect(soft).toMatch(/Slide 2 shows the same screen as slide 1/);
    expect(soft).toMatch(/Slide 3 uses slide-feature; a store screenshots uses store-screenshot/);
    expect(soft).toMatch(/Slide 4 body has 11 words; at most 10/);
    const p = polishSlides(r.slides, c, "Get it");
    expect(p.slides.map((s) => s.template)).toEqual(["store-screenshot", "store-screenshot", "store-screenshot", "store-screenshot"]);
    const keys = p.slides.map((s) => s.assets[0]?.segmentId ?? s.assets[0]?.assetId);
    expect(new Set(keys).size).toBe(4);
    expect(p.slides[3]!.assets[0]).toMatchObject({ kind: "app_recording", assetId: "ast_rec", segmentId: "rsg_1" });
  });

  it("thumbnail and post: one slide in the right template; a thumbnail has ≤ 5 words and no body; extra slides are dropped, never made up", () => {
    const c = ctx("thumbnail", 1);
    const r = checkSlides(plan([sl("slide-cover", { headline: "Why your focus keeps slipping away", body: "A short line" }), sl("slide-cta")]), c);
    expect(r.soft.join("\n")).toMatch(/2 slides planned; this thumbnail needs exactly 1/);
    expect(r.soft.join("\n")).toMatch(/headline has 6 words.*at most 5/);
    const p = polishSlides(r.slides, c, "Get it");
    expect(p.slides).toHaveLength(1);
    expect(p.slides[0]).toMatchObject({ template: "thumbnail-bold", body: "" });
    expect(p.slides[0]!.headline.split(/\s+/).length).toBeLessThanOrEqual(5);
    expect(p.slides[0]!.assets[0]?.assetId).toBe("ast_a"); // a real screen
    // A post's cover keeps the founder's cut-out when given; feature/store slides never show it.
    const post = polishSlides(checkSlides(plan([sl("slide-cover", { purpose: "hook", assets: [{ kind: "founder_clip", assetId: "ast_founder" }] })]), ctx("post", 1)).slides, ctx("post", 1), "Get it");
    expect(post.slides[0]!.assets).toEqual([{ kind: "founder_clip", assetId: "ast_founder" }]);
    const store = checkSlides(plan([sl("store-screenshot", { assets: [{ kind: "founder_clip", assetId: "ast_founder" }] }), sl("store-screenshot"), sl("store-screenshot", { headline: "Third" })]), ctx("store_screenshots", 3));
    expect(store.slides[0]!.assets.some((h) => h.kind === "founder_clip")).toBe(false);
    // Fewer slides than asked: said plainly, not padded.
    const few = polishSlides(checkSlides(plan([sl("slide-cover"), sl("slide-cta", { headline: "" })]), ctx("carousel", 4)).slides, ctx("carousel", 4), "Start your first focus session");
    expect(few.slides).toHaveLength(2);
    expect(few.fixes.join("\n")).toMatch(/planned 2 of the 4 slides asked for; nothing was made up/);
    expect(few.slides[1]).toMatchObject({ template: "slide-cta", headline: "Start your first focus session" });
  });

  it("with no real screens: feature and store slides are a problem for the repair round (nothing generated in their place)", () => {
    const empty = ctx("carousel", 3, { assets: new Map([["ast_gen", asset("ast_gen", { role: "generated_image", isProductTruth: false, origin: "generated" })]]), segments: new Map(), featureAssets: new Map() });
    const r = checkSlides(plan([sl("slide-cover"), sl("slide-feature", { headline: "One" }), sl("slide-cta", { headline: "Get it" })]), empty);
    expect(r.problems.join("\n")).toMatch(/Slide 2 \(slide-feature\) must show a real screen of the app/);
  });

  it("cuts headlines at a clause and bodies at a sentence", () => {
    expect(cutHeadline("Focus in one tap: no setup, no fuss at all", 5)).toBe("Focus in one tap");
    expect(cutHeadline("one two three four five six seven", 5)).toBe("one two three four five");
    expect(cutBody("Pick a length. Tap start. Distracting apps wait until the session ends.", 5)).toBe("Pick a length. Tap start.");
    expect(cutBody("one two three four five six", 4)).toBe("one two three four…");
    expect(cutBody("anything", 0)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// storyboard.generate with a still format (fake Meta: Spark + the claim validator)
// ---------------------------------------------------------------------------

const claimRoute = jsonRoute("ClaimValidation", (req) => ({ results: requestText(req).split("\n").filter((l) => l.startsWith('{"id":')).map((l) => ({ id: JSON.parse(l).id, issues: [] })) }));

async function setup(routes: MetaRoute[]) {
  const built: string[] = [];
  const p = createTestPlatform({ META_API_KEY: "test-key" }, {
    ...handlers,
    "composition.build": async (ctx: JobContext<"composition.build">) => {
      built.push(ctx.payload.storyboardId);
      return { creditsUsed: 0 };
    },
    "storyboard.resolve_media": async (ctx: JobContext<"storyboard.resolve_media">) => {
      const build = await ctx.enqueue("composition.build", ctx.payload, { idempotencyKey: `composition.build:${ctx.payload.storyboardId}` });
      return { data: { buildJobId: build.id } };
    },
  });
  const wid = "ws_slides";
  await p.credits.ensureAccount(wid, { grant: 1000, reason: "test" });
  const seed = await seedApp(p, wid);
  const ws = p.db.ws(wid);
  // A third real screen, and a designed store image with its SAM cut-out (Spark is only offered the cut-out).
  const shotA = await ws.collection("mediaAssets").getOrThrow(seed.screenshotIds[0]!);
  const third = await ws.collection("mediaAssets").create({ appId: seed.appId, kind: "image", role: "screenshot", origin: "upload", storagePath: shotA.storagePath, mimeType: "image/png", status: "ready", title: "Session running", isProductTruth: true, width: 90, height: 160 }, { actor: "t" });
  const mkt = await ws.collection("mediaAssets").create({ appId: seed.appId, kind: "image", role: "screenshot", origin: "store_import", storagePath: shotA.storagePath, mimeType: "image/png", status: "ready", title: "Store screenshot 1", isProductTruth: true, screenshotKind: "marketing", width: 90, height: 160 }, { actor: "t" });
  const crop = await ws.collection("mediaAssets").create({ appId: seed.appId, kind: "image", role: "screenshot", origin: "derived", storagePath: shotA.storagePath, mimeType: "image/png", status: "ready", title: "Store screenshot 1 (app screen, SAM 3.1)", isProductTruth: true, sourceLabel: "sam_ui_crop", derivedFromAssetId: mkt.id, screenshotKind: "raw_ui", width: 80, height: 150 }, { actor: "t" });
  const meta = installFakeMeta(p, [...routes, claimRoute]);
  const campaign = await ws.collection("campaigns").create({ appId: seed.appId, name: "Carousel", goal: "awareness", request: "A carousel for students", channels: ["instagram"], deliverables: [{ kind: "carousel", channel: "instagram", aspectRatio: "4:5", slides: 5, count: 1 }] }, { actor: "u1" });
  const variant = await ws.collection("campaignVariants").create({ appId: seed.appId, campaignId: campaign.id, title: "Three small changes", angleType: "practical_demo", hook: "Your phone wins. Again?", audience: "Students", keyMessage: "Focus in one tap", rationale: "r", scriptOutline: ["hook", "demo", "cta"], hypothesis: "h", successMetric: { metric: "saves" }, claimIds: [seed.claimIds.verified[0]!] }, { actor: "u1" });
  return { p, wid, ws, seed, meta, built, campaignId: campaign.id, variantId: variant.id, ids: { third: third.id, mkt: mkt.id, crop: crop.id } };
}

const sparkReqs = (meta: { requests: MetaRequest[] }) => meta.requests.filter((r) => schemaName(r) === "SlidePlan");

describe("storyboard.generate for stills (Muse Spark slide plans)", () => {
  it("carousel: one scene per slide from the real screens, verified proof, priced on the slides; the video path is untouched", async () => {
    const s = await setup([slidePlanRoute()]);
    const job = await s.p.jobs.create(s.wid, "storyboard.generate", { appId: s.seed.appId, campaignId: s.campaignId, variantId: s.variantId, aspectRatio: "9:16", format: "carousel", slides: 5 }, { actor: "u1", credits: { operation: "storyboard.generate", params: { format: "carousel", slides: 5 } } });
    expect(job.reservation?.credits).toBe(3 + 3); // slide plan 3 + per started 2 slides (5 → 3)
    await s.p.inline!.drain();
    const done = await s.p.jobs.get(s.wid, job.id);
    expect(done?.status, JSON.stringify(done?.error)).toBe("succeeded");
    expect(done?.creditsCharged).toBe(6);

    // Spark was asked as a social designer for exactly 5 slides, saw the real screens and only the cut-out of the store image.
    const req = sparkReqs(s.meta)[0]!;
    expect(String(req.instructions)).toMatch(/senior social designer/);
    expect(String(req.instructions)).toMatch(/Slide 1 is slide-cover/);
    const text = requestText(req);
    expect(text).toContain("Plan exactly 5 slides (format carousel, frame 4:5)");
    expect(text).toContain(`${s.ids.crop} | app-screen cut-out`);
    expect(text).not.toMatch(new RegExp(`^- ${s.ids.mkt} `, "m"));
    expect(text).toMatch(/Claims chosen for this concept: clm_/);
    expect((req.input[0].content as MetaRequest[]).filter((c) => c.type === "input_image").length).toBeGreaterThanOrEqual(3);

    const variant = await s.ws.collection("campaignVariants").getOrThrow(s.variantId);
    const story = await s.ws.collection("storyboards").getOrThrow(variant.storyboardId!);
    expect(story).toMatchObject({ format: "carousel", aspectRatio: "4:5", voiceover: { source: "none" }, music: {} });
    expect(story.store).toBeUndefined();
    expect(story.scenes).toHaveLength(5);
    expect(story.scenes.map((x) => x.template)).toEqual(["slide-cover", "slide-feature", "slide-feature", "slide-proof", "slide-cta"]);
    for (const x of story.scenes) expect(x).toMatchObject({ durationSec: 1, narration: "" });
    expect(story.scenes[1]!.body).toBeTruthy();
    expect(story.scenes[3]!.claimIds).toEqual([s.seed.claimIds.verified[0]]);
    const screens = story.scenes.filter((x) => x.template === "slide-feature").map((x) => x.assets[0]?.assetId);
    expect(new Set(screens).size).toBe(screens.length);
    for (const x of story.scenes) for (const h of x.assets) expect(h.assetId).not.toBe(s.ids.mkt);
    expect(s.built).toEqual([story.id]);
    // The Meta model work is visible on the run.
    const steps = (await s.ws.collection("agentSteps").list({ where: [["runId", "==", story.generatedByRunId!]], orderBy: { field: "index", dir: "asc" } })).items;
    expect(steps.some((x) => x.kind === "model_call" && /Plan carousel \(Muse Spark\)/.test(x.title))).toBe(true);
    expect(steps.some((x) => /Claim check passed/.test(x.title))).toBe(true);
    // Slide text went through the claim validator.
    expect(requestText(s.meta.requests.find((r) => schemaName(r) === "ClaimValidation")!)).toMatch(/"id":"slide_1"/);
    // No video storyboard call.
    expect(s.meta.requests.some((r) => schemaName(r) === "Storyboard")).toBe(false);
  });

  it("store screenshots: one repair round fixes a bad plan; the iOS frame; ASO rules in the prompt", async () => {
    let n = 0;
    const route = slidePlanRoute((plan) => {
      n++;
      // First answer: the same screen twice and a price in a headline.
      if (n === 1) plan.slides[1] = { ...plan.slides[1]!, headline: "Pro for $4.99 a month", assets: plan.slides[0]!.assets };
      return plan;
    });
    const s = await setup([route]);
    await s.ws.collection("campaigns").update(s.campaignId, { deliverables: [{ kind: "store_screenshots", aspectRatio: "9:19.5", store: "ios", slides: 4, count: 1 }] }, { actor: "u1" });
    const job = await s.p.jobs.create(s.wid, "storyboard.generate", { appId: s.seed.appId, campaignId: s.campaignId, variantId: s.variantId, format: "store_screenshots", slides: 4, store: "ios" }, { actor: "u1", credits: { operation: "storyboard.generate", params: { format: "store_screenshots", slides: 4 } } });
    await s.p.inline!.drain();
    expect((await s.p.jobs.get(s.wid, job.id))?.status).toBe("succeeded");
    expect(n).toBe(2);
    const reqs = sparkReqs(s.meta);
    expect(String(reqs[0]!.instructions)).toMatch(/App Store optimisation|ASO/);
    expect(requestText(reqs[0]!)).toContain("frame App Store 6.9-inch iPhone screenshot, 1290×2796");
    expect(requestText(reqs[1]!)).toMatch(/Slide 2 mentions a price/);
    expect(requestText(reqs[1]!)).toMatch(/Slide 2 shows the same screen as slide 1/);
    const story = await s.ws.collection("storyboards").getOrThrow((await s.ws.collection("campaignVariants").getOrThrow(s.variantId)).storyboardId!);
    expect(story).toMatchObject({ format: "store_screenshots", store: "ios", aspectRatio: "9:19.5" });
    expect(story.scenes.every((x) => x.template === "store-screenshot")).toBe(true);
    expect(new Set(story.scenes.map((x) => x.assets[0]?.segmentId ?? x.assets[0]?.assetId)).size).toBe(4);
  });

  it("thumbnail: a 16:9 single slide; a store set without real screens fails plainly (nothing generated instead)", async () => {
    const s = await setup([slidePlanRoute()]);
    const job = await s.p.jobs.create(s.wid, "storyboard.generate", { appId: s.seed.appId, campaignId: s.campaignId, variantId: s.variantId, aspectRatio: "9:16", format: "thumbnail" }, { actor: "u1" });
    await s.p.inline!.drain();
    expect((await s.p.jobs.get(s.wid, job.id))?.status).toBe("succeeded");
    const story = await s.ws.collection("storyboards").getOrThrow((await s.ws.collection("campaignVariants").getOrThrow(s.variantId)).storyboardId!);
    expect(story).toMatchObject({ format: "thumbnail", aspectRatio: "16:9" });
    expect(story.scenes).toHaveLength(1);
    expect(story.scenes[0]).toMatchObject({ template: "thumbnail-bold" });
    expect(story.scenes[0]!.onScreenText.split(/\s+/).length).toBeLessThanOrEqual(5);

    const bare = await setup([slidePlanRoute()]);
    const shots = (await bare.ws.collection("mediaAssets").list({ where: [["appId", "==", bare.seed.appId]], limit: 50 })).items.filter((a) => a.role === "screenshot");
    for (const a of shots) await bare.ws.collection("mediaAssets").update(a.id, { status: "deleted" }, { actor: "t" });
    const failed = await bare.p.jobs.create(bare.wid, "storyboard.generate", { appId: bare.seed.appId, campaignId: bare.campaignId, variantId: bare.variantId, format: "store_screenshots", store: "android" }, { actor: "u1", maxAttempts: 1 });
    await bare.p.inline!.drain();
    const f = await bare.p.jobs.get(bare.wid, failed.id);
    expect(f?.status).toBe("failed");
    expect(f?.error?.userMessage).toMatch(/Store screenshots show your real app/);
    expect(sparkReqs(bare.meta)).toHaveLength(0);
  });

  it("only sees its own workspace's media (tenancy)", async () => {
    const s = await setup([slidePlanRoute()]);
    const other = s.p.db.ws("ws_other_tenant");
    await other.collection("mediaAssets").create({ appId: s.seed.appId, kind: "image", role: "screenshot", origin: "upload", storagePath: "workspaces/ws_other_tenant/x.png", mimeType: "image/png", status: "ready", title: "SECRET other tenant screen", isProductTruth: true }, { actor: "t" });
    await s.p.jobs.create(s.wid, "storyboard.generate", { appId: s.seed.appId, campaignId: s.campaignId, variantId: s.variantId, format: "carousel" }, { actor: "u1" });
    await s.p.inline!.drain();
    expect(requestText(sparkReqs(s.meta)[0]!)).not.toContain("SECRET other tenant screen");
  });
});
