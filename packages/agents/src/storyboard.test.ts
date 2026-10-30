import { readFileSync } from "node:fs";
import type { MediaAsset, RecordingSegment } from "@muselaunch/contracts";
import { createTestPlatform, type JobContext } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { conceptDurations, founderDuration, seededDuration } from "./concepts";
import { handlers } from "./index";
import { checkStoryboard, countWords, fitDurations, minSceneSec, polishStoryboard, sceneRange, StoryboardOutput, type StoryboardCheckContext } from "./storyboard";
import { fixtureJson, installFakeMeta, jsonRoute, requestText, resolvePlaceholders, schemaName, seedApp, type MetaRequest, type MetaRoute } from "./testing";

const now = "2026-10-30T00:00:00.000Z";
const asset = (id: string, over: Partial<MediaAsset> = {}): MediaAsset =>
  ({ id, workspaceId: "ws", createdAt: now, updatedAt: now, createdBy: "u", appId: "app", kind: "image", role: "screenshot", origin: "upload", storagePath: `workspaces/ws/${id}.png`, mimeType: "image/png", bytes: 1, status: "ready", labels: [], isProductTruth: true, width: 1179, height: 2556, ...over }) as MediaAsset;
const seg = (id: string, over: Partial<RecordingSegment> = {}): RecordingSegment =>
  ({ id, workspaceId: "ws", createdAt: now, updatedAt: now, createdBy: "u", appId: "app", assetId: "ast_rec", startSec: 0, endSec: 6, label: id, action: "tap", featureIds: [], quality: 0.8, privacy: { flagged: false, regions: [] }, ...over }) as RecordingSegment;

type S = z.infer<typeof StoryboardOutput>["scenes"][number];
const sc = (template: S["template"], over: Partial<S> = {}): S => ({ purpose: "demo", durationSec: 3.5, onScreenText: "Save it in one tap", narration: "", visual: "v", template, assets: [], claimIds: [], ...over });
const out = (scenes: S[]) => StoryboardOutput.parse({ title: "T", scenes, voiceover: { source: "none" } });

function ctx(target = 45): StoryboardCheckContext {
  const assets = [
    asset("ast_raw1"),
    asset("ast_raw2"),
    asset("ast_mkt", { screenshotKind: "marketing" }),
    asset("ast_mkt_solo", { screenshotKind: "marketing" }),
    asset("ast_crop", { sourceLabel: "sam_ui_crop", derivedFromAssetId: "ast_mkt", screenshotKind: "raw_ui" }),
    asset("ast_rec", { kind: "video", role: "app_recording", mimeType: "video/mp4" }),
  ];
  return {
    assets: new Map(assets.map((a) => [a.id, a])),
    verifiedClaimIds: new Set(["clm_ok"]),
    featureAssets: new Map([["feat_a", ["ast_raw1"]]]),
    segments: new Map([seg("rsg_1", { featureIds: ["feat_a"] }), seg("rsg_2", { startSec: 10, endSec: 14 })].map((s) => [s.id, s])),
    targetDurationSec: target,
  };
}

describe("storyboard rules for 30–60 s videos", () => {
  it("scales the scene count with length (≈ 1 per 3.5 s, 8–16 for 30 s+)", () => {
    expect(sceneRange(15)).toEqual({ min: 3, max: 6 });
    expect(sceneRange(30)).toEqual({ min: 8, max: 11 });
    expect(sceneRange(45)).toEqual({ min: 11, max: 15 });
    expect(sceneRange(60)).toEqual({ min: 14, max: 16 });
  });

  it("fits long videos to the exact target while keeping reading time, hook ≥ 1.5 s and end card ≥ 2.5 s", () => {
    const scenes = [sc("kinetic-type", { onScreenText: "Your phone wins again", durationSec: 0.8 }), ...Array.from({ length: 13 }, (_, i) => sc(i % 2 ? "focus-zoom" : "device-demo", { durationSec: 1 + (i % 3) })), sc("store-cta", { purpose: "cta", durationSec: 1, onScreenText: "Get it" })];
    const mins = scenes.map((s, i) => minSceneSec(s, i));
    const d = fitDurations(scenes.map((s) => s.durationSec), 60, mins);
    expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(60, 5);
    d.forEach((v, i) => expect(v).toBeGreaterThanOrEqual(mins[i]! - 1e-9));
    expect(d[0]).toBeGreaterThanOrEqual(1.5);
    expect(d[d.length - 1]).toBeGreaterThanOrEqual(2.5);
    // Text gets ~3 words/s after its entrance.
    expect(minSceneSec(sc("device-demo", { onScreenText: "one two three four five six" }), 3)).toBeCloseTo(2.6, 5);
    // Infeasible minimums scale down rather than overflow.
    expect(fitDurations([3, 3, 3], 6, [4, 4, 4]).reduce((a, b) => a + b, 0)).toBeCloseTo(6, 5);
  });

  it("resolves walkthrough segments, keeps marketing screenshots out of devices and uses each item once", () => {
    const c = ctx();
    const r = checkStoryboard(
      out([
        sc("kinetic-type", { purpose: "hook", onScreenText: "Lost it again?" }),
        sc("device-demo", { assets: [{ kind: "app_recording", assetId: "rsg_1" }] }), // segment id given as assetId
        sc("focus-zoom", { assets: [{ kind: "screenshot", assetId: "ast_mkt" }], focus: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } }), // → its cut-out, box dropped
        sc("phone-tilt", { assets: [{ kind: "screenshot", assetId: "ast_mkt_solo" }] }), // no cut-out → full screen
        sc("tap-demo", { assets: [{ kind: "app_recording", segmentId: "rsg_1" }] }), // already used → another item
        sc("device-demo", { assets: [{ kind: "app_recording", segmentId: "rsg_missing" }] }),
        sc("store-cta", { purpose: "cta", onScreenText: "Get it" }),
      ]),
      c,
    );
    expect(r.problems).toEqual([]);
    expect(r.scenes[1]!.assets[0]).toMatchObject({ kind: "app_recording", assetId: "ast_rec", segmentId: "rsg_1", featureId: "feat_a" });
    expect(r.scenes[2]!.assets[0]).toMatchObject({ kind: "screenshot", assetId: "ast_crop" });
    expect(r.scenes[2]!.focus).toBeUndefined();
    expect(r.scenes[3]!.template).toBe("fullscreen-showcase");
    expect(r.scenes[3]!.assets[0]).toMatchObject({ assetId: "ast_mkt_solo" });
    const keys = r.scenes.map((s) => s.assets.find((h) => h.kind === "screenshot" || h.kind === "app_recording")).filter(Boolean).map((h) => h!.segmentId ?? h!.assetId);
    expect(new Set(keys).size).toBe(keys.length); // every item at most once (enough items here)
    expect(r.fixes.join("\n")).toMatch(/dropped unknown walkthrough segment rsg_missing/);
  });

  it("flags pace, variety and arc problems for the repair round, then polishes what is left", () => {
    const c = ctx(30);
    const sb = out([
      sc("hook-title", { purpose: "hook", onScreenText: "Stop losing your hotel bookings in chats", durationSec: 1 }),
      sc("device-demo", { assets: [{ kind: "screenshot", assetId: "ast_raw1" }] }),
      sc("device-demo", { assets: [{ kind: "screenshot", assetId: "ast_raw2" }] }),
      sc("device-demo", { assets: [{ kind: "app_recording", segmentId: "rsg_2" }] }),
      sc("device-demo", { assets: [{ kind: "app_recording", segmentId: "rsg_1" }] }),
      sc("hook-title", { purpose: "other", onScreenText: "All in one place" }),
      sc("hook-title", { purpose: "problem", onScreenText: "No more digging" }),
      sc("device-demo", { purpose: "feature", assets: [{ kind: "screenshot", assetId: "ast_crop" }] }),
    ]);
    const r = checkStoryboard(sb, c);
    const soft = r.soft.join("\n");
    expect(soft).toMatch(/hook must be ≤ 5 words/);
    expect(soft).not.toMatch(/1\.5s/); // a short hook is lengthened deterministically (fitDurations minimums), no repair call
    expect(r.fixes.join("\n")).toMatch(/hook\) held for at least 1\.5s/);
    expect(soft).toMatch(/never use the same template more than twice in a row/);
    expect(soft).toMatch(/at least 5/);
    expect(soft).toMatch(/close-up/);
    expect(soft).toMatch(/last scene must be the call to action/);
    expect(soft).toMatch(/states the problem after the demo/);
    expect(r.problems).toEqual([]);

    const p = polishStoryboard(r.scenes, c, "Get Magic Pocket");
    expect(countWords(p.scenes[0]!.onScreenText)).toBeLessThanOrEqual(5);
    expect(p.scenes[0]!.narration).toMatch(/hotel bookings/);
    expect(p.scenes[p.scenes.length - 1]).toMatchObject({ template: "store-cta", onScreenText: "Get Magic Pocket" });
    const t = p.scenes.map((s) => s.template);
    for (let i = 2; i < t.length; i++) expect(t[i] === t[i - 1] && t[i] === t[i - 2]).toBe(false);
    expect(new Set(t).size).toBeGreaterThanOrEqual(5);
    expect(t).toContain("focus-zoom");
    expect(checkStoryboard({ ...sb, scenes: p.scenes }, c).soft.filter((x) => /twice in a row|at least 5|close-up|call to action|≤ 5 words/.test(x))).toEqual([]);
  });

  it("keeps the 15 s rules light when the founder picks a short video", () => {
    const r = checkStoryboard(out([sc("hook-title", { purpose: "hook", onScreenText: "One tap. Calm." }), sc("device-demo", { assets: [{ kind: "screenshot", assetId: "ast_raw1" }] }), sc("device-demo", { assets: [{ kind: "screenshot", assetId: "ast_raw2" }] }), sc("cta-endcard", { purpose: "cta", onScreenText: "Get it" })]), ctx(15));
    expect(r.soft).toEqual([]);
  });
});

describe("concept lengths", () => {
  it("are the founder's choice, else Spark's pick in 30–60 s, else seeded by the concept id; never all the same", () => {
    expect(conceptDurations([30, 45, 60], ["a", "b", "c"], 15)).toEqual([15, 15, 15]);
    expect(conceptDurations([20, 45, 90], ["a", "b", "c"])).toEqual([30, 45, 60]);
    const seeded = conceptDurations([undefined, undefined], ["var_x", "var_y"]);
    for (const d of seeded) expect(d >= 30 && d <= 60).toBe(true);
    expect(conceptDurations([undefined], ["var_x"])).toEqual([seededDuration("var_x")]);
    const same = conceptDurations([45, 45, 45], ["v1", "v2", "v3"]);
    expect(same[0]).toBeLessThanOrEqual(35);
    expect(same[1]).toBeGreaterThanOrEqual(45);
    // Never longer than the workspace plan's longest video.
    expect(conceptDurations([45, 60], ["a", "b"], undefined, 30)).toEqual([30, 30]);
    expect(conceptDurations([45], ["a"], 60, 30)).toEqual([30]);
    expect(founderDuration([{ kind: "short_video", aspectRatio: "9:16", count: 1 }])).toBeUndefined();
    expect(founderDuration([{ kind: "static_ad", aspectRatio: "1:1", count: 1, durationSec: 6 }, { kind: "short_video", aspectRatio: "9:16", count: 1, durationSec: 15 }])).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// storyboard.generate end to end (fake Meta: Spark + SAM)
// ---------------------------------------------------------------------------

/** Responses API SSE for SAM (documented stream shape), answering with the labelled SYNTHETIC image fixture. */
function samRoute(calls: MetaRequest[]): MetaRoute {
  const raw = (JSON.parse(readFileSync(new URL("../../../fixtures/media/sam-image-box.json", import.meta.url), "utf8")) as { rawOutput: string }).rawOutput;
  const lane = { item_id: "msg_fixture", output_index: 0, content_index: 0 };
  const events = [{ type: "response.created", response: { id: "resp_sam", status: "in_progress" } }, { type: "response.output_text.delta", ...lane, delta: raw }, { type: "response.output_text.done", ...lane, text: raw }, { type: "response.completed", response: { id: "resp_sam", status: "completed", usage: { images_processed: 1 } } }];
  return (req) => {
    if (!String(req.model).startsWith("sam")) return undefined;
    calls.push(req);
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

const claimRoute = jsonRoute("ClaimValidation", (req) => ({ results: requestText(req).split("\n").filter((l) => l.startsWith('{"id":')).map((l) => ({ id: JSON.parse(l).id, issues: [] })) }));

async function setup(routes: MetaRoute[]) {
  const built: string[] = [];
  const p = createTestPlatform({ META_API_KEY: "test-key" }, {
    ...handlers,
    "composition.build": async (ctx: JobContext<"composition.build">) => {
      built.push(ctx.payload.storyboardId);
      return { creditsUsed: 0 };
    },
  });
  const wid = "ws_storyboard_long";
  await p.credits.ensureAccount(wid, { grant: 1000, reason: "test" });
  const seed = await seedApp(p, wid);
  const ws = p.db.ws(wid);
  // A real walkthrough recording with two labelled segments (one shows personal info), a keyframe, and a designed store screenshot with its SAM cut-out.
  const rec = await ws.collection("mediaAssets").create({ appId: seed.appId, kind: "video", role: "app_recording", origin: "upload", storagePath: `workspaces/${wid}/apps/${seed.appId}/walkthrough.mp4`, mimeType: "video/mp4", status: "ready", title: "Walkthrough", isProductTruth: true, durationSec: 90, width: 886, height: 1920 }, { actor: "t" });
  const timerShot = await ws.collection("mediaAssets").getOrThrow(seed.screenshotIds[0]!);
  const keyframe = await ws.collection("mediaAssets").create({ appId: seed.appId, kind: "image", role: "thumbnail", origin: "derived", storagePath: timerShot.storagePath, mimeType: "image/png", status: "ready", title: "keyframe", derivedFromAssetId: rec.id, width: 90, height: 160 }, { actor: "t" });
  const segA = await ws.collection("recordingSegments").create({ appId: seed.appId, assetId: rec.id, startSec: 12, endSec: 22, label: "Starts a 25-minute focus session", action: "tap", featureIds: ["feat_timer"], quality: 0.9, keyframeAssetId: keyframe.id }, { actor: "t" });
  const segB = await ws.collection("recordingSegments").create({ appId: seed.appId, assetId: rec.id, startSec: 40, endSec: 44, label: "Opens the weekly report", action: "navigate", featureIds: ["feat_reports"], quality: 0.7, privacy: { flagged: true, notes: "email visible", regions: [{ x: 0.1, y: 0.04, w: 0.8, h: 0.05 }] } }, { actor: "t" });
  const mkt = await ws.collection("mediaAssets").create({ appId: seed.appId, kind: "image", role: "screenshot", origin: "store_import", storagePath: timerShot.storagePath, mimeType: "image/png", status: "ready", title: "Store screenshot 1", isProductTruth: true, screenshotKind: "marketing", width: 90, height: 160 }, { actor: "t" });
  const crop = await ws.collection("mediaAssets").create({ appId: seed.appId, kind: "image", role: "screenshot", origin: "derived", storagePath: timerShot.storagePath, mimeType: "image/png", status: "ready", title: "Store screenshot 1 (app screen, SAM 3.1)", isProductTruth: true, sourceLabel: "sam_ui_crop", derivedFromAssetId: mkt.id, screenshotKind: "raw_ui", width: 80, height: 150 }, { actor: "t" });
  const meta = installFakeMeta(p, [...routes, claimRoute]);
  const campaign = await ws.collection("campaigns").create({ appId: seed.appId, name: "Long video", goal: "installs", request: "Make a video", channels: ["instagram"], deliverables: [{ kind: "short_video", aspectRatio: "9:16", count: 1 }] }, { actor: "u1" });
  const variant = await ws.collection("campaignVariants").create({ appId: seed.appId, campaignId: campaign.id, title: "One tap to deep work", angleType: "practical_demo", hook: "Your phone wins. Again.", audience: "Students", keyMessage: "Focus in one tap", rationale: "r", scriptOutline: ["hook", "demo", "cta"], hypothesis: "h", successMetric: { metric: "saves" }, targetDurationSec: 45 }, { actor: "u1" });
  return { p, wid, ws, seed, meta, built, campaignId: campaign.id, variantId: variant.id, ids: { rec: rec.id, segA: segA.id, segB: segB.id, mkt: mkt.id, crop: crop.id, keyframe: keyframe.id } };
}

describe("storyboard.generate (30–60 s)", () => {
  it("uses the concept's length, shows Spark the real stills, plays segments, resolves a focus query with SAM and charges what it used", async () => {
    const samCalls: MetaRequest[] = [];
    let sparkReq: MetaRequest | undefined;
    let ids: Awaited<ReturnType<typeof setup>>["ids"] | undefined;
    const storyRoute = jsonRoute("Storyboard", (req) => {
      sparkReq = req;
      const sb = resolvePlaceholders(fixtureJson<{ scenes: Record<string, unknown>[] }>("spark-storyboard-long.json"), req);
      // Point the phone-tilt and tap-demo scenes at the walkthrough segments, and one scene at the marketing original.
      sb.scenes[3] = { ...sb.scenes[3], assets: [{ kind: "app_recording", segmentId: ids!.segA }] };
      sb.scenes[5] = { ...sb.scenes[5], assets: [{ kind: "app_recording", segmentId: ids!.segA }] };
      sb.scenes[6] = { ...sb.scenes[6], assets: [{ kind: "screenshot", assetId: ids!.mkt }] };
      return sb;
    });
    const s = await setup([storyRoute, samRoute(samCalls)]);
    ids = s.ids;
    const job = await s.p.jobs.create(s.wid, "storyboard.generate", { appId: s.seed.appId, campaignId: s.campaignId, variantId: s.variantId, aspectRatio: "9:16" }, { actor: "u1", credits: { operation: "storyboard.generate" } });
    expect(job.reservation?.credits).toBe(8 + 4 + 3); // reserved for the longest automatic video + 3 lookups
    await s.p.inline!.drain();
    const done = await s.p.jobs.get(s.wid, job.id);
    expect(done?.status).toBe("succeeded");

    // Spark saw the real stills (keyframe + screenshots) and the media list with segments and the full-screen-only original.
    const images = (sparkReq!.input[0].content as MetaRequest[]).filter((c) => c.type === "input_image");
    expect(images.length).toBeGreaterThanOrEqual(3);
    const text = requestText(sparkReq!);
    expect(text).toContain("target 45 seconds total, 11-15 scenes");
    expect(text).toMatch(new RegExp(`${ids.segA} \\| recording_segment of ${ids.rec}, 12\\.0–22\\.0 s`));
    expect(text).toMatch(new RegExp(`${ids.mkt} \\| marketing_screenshot .*FULL SCREEN ONLY.*${ids.crop} is the device version`));
    expect(text).toContain(`Image 1: asset ${ids.keyframe} (keyframe of ${ids.segA})`);

    const variant = await s.ws.collection("campaignVariants").getOrThrow(s.variantId);
    const story = await s.ws.collection("storyboards").getOrThrow(variant.storyboardId!);
    expect(story.targetDurationSec).toBe(45);
    expect(story.scenes.reduce((n, x) => n + x.durationSec, 0)).toBeCloseTo(45, 5);
    expect(story.scenes[0]!.durationSec).toBeGreaterThanOrEqual(1.5);
    expect(new Set(story.scenes.map((x) => x.template)).size).toBeGreaterThanOrEqual(5);
    // Segment hints carry the recording; the second use of segment A was swapped for an unused item.
    expect(story.scenes[3]!.assets[0]).toMatchObject({ kind: "app_recording", assetId: ids.rec, segmentId: ids.segA });
    expect(story.scenes[5]!.assets[0]!.segmentId ?? story.scenes[5]!.assets[0]!.assetId).not.toBe(ids.segA);
    // The marketing original never sits in a device: its SAM cut-out does (or another unused item when the cut-out was already shown).
    for (const x of story.scenes.filter((x) => x.template !== "fullscreen-showcase")) expect(x.assets.map((h) => h.assetId)).not.toContain(ids.mkt);
    expect((done!.output!.data as { fixes: string[] }).fixes.join("\n")).toContain(`cut-out ${ids.crop} instead of the marketing screenshot ${ids.mkt}`);
    // Spark pointing at a segment's keyframe means that segment.
    expect(story.scenes.some((x) => x.assets.some((h) => h.assetId === ids.keyframe))).toBe(false);
    // The tap-demo's "start button" was located by SAM 3.1 on the real still.
    expect(samCalls).toHaveLength(1);
    const tap = story.scenes[5]!;
    expect(tap.focusQuery).toBe("start button");
    expect(tap.focus).toBeDefined();
    for (const v of Object.values(tap.focus!)) expect(v >= 0 && v <= 1).toBe(true);
    expect(s.built).toEqual([story.id]);
    // Charged: storyboard (8) + one extra 15 s block (2) + one SAM lookup (1).
    expect(done?.creditsCharged).toBe(11);
    expect(done!.output!.data).toMatchObject({ targetDurationSec: 45, focusLookups: 1 });
    const steps = (await s.ws.collection("agentSteps").list({ where: [["runId", "==", story.generatedByRunId!]], orderBy: { field: "index", dir: "asc" } })).items;
    expect(steps.some((x) => /SAM 3\.1 located "start button"/.test(x.title))).toBe(true);
  });

  it("a SAM failure never fails the storyboard (honest step; the builder's default crop applies)", async () => {
    const storyRoute = jsonRoute("Storyboard", (req) => resolvePlaceholders(fixtureJson("spark-storyboard-long.json"), req));
    const failingSam: MetaRoute = (req) => (String(req.model).startsWith("sam") ? new Response(JSON.stringify({ error: { message: "overloaded", type: "server_error" } }), { status: 400, headers: { "content-type": "application/json" } }) : undefined);
    const s = await setup([storyRoute, failingSam]);
    const job = await s.p.jobs.create(s.wid, "storyboard.generate", { appId: s.seed.appId, campaignId: s.campaignId, variantId: s.variantId, aspectRatio: "9:16", targetDurationSec: 30 }, { actor: "u1", credits: { operation: "storyboard.generate" } });
    await s.p.inline!.drain();
    const done = await s.p.jobs.get(s.wid, job.id);
    expect(done?.status).toBe("succeeded");
    const story = await s.ws.collection("storyboards").getOrThrow((await s.ws.collection("campaignVariants").getOrThrow(s.variantId)).storyboardId!);
    expect(story.targetDurationSec).toBe(30); // the founder's explicit choice wins over the concept's 45 s
    expect(story.scenes.find((x) => x.focusQuery === "start button")?.focus).toBeUndefined();
    const steps = (await s.ws.collection("agentSteps").list({ where: [["runId", "==", story.generatedByRunId!]], orderBy: { field: "index", dir: "asc" } })).items;
    expect(steps.find((x) => /focus lookup failed/.test(x.title))?.status).toBe("failed");
    expect(schemaName(s.meta.requests.find((r) => schemaName(r) === "Storyboard")!)).toBe("Storyboard");
  });

  it("only sees its own workspace's segments (tenancy)", async () => {
    const storyRoute = jsonRoute("Storyboard", (req) => resolvePlaceholders(fixtureJson("spark-storyboard-long.json"), req));
    const s = await setup([storyRoute]);
    const other = s.p.db.ws("ws_other_tenant");
    await other.collection("recordingSegments").create({ appId: s.seed.appId, assetId: s.ids.rec, startSec: 1, endSec: 2, label: "SECRET other tenant segment" }, { actor: "t" });
    await s.p.jobs.create(s.wid, "storyboard.generate", { appId: s.seed.appId, campaignId: s.campaignId, variantId: s.variantId }, { actor: "u1", credits: { operation: "storyboard.generate" } });
    await s.p.inline!.drain();
    const req = s.meta.requests.find((r) => schemaName(r) === "Storyboard")!;
    expect(requestText(req)).not.toContain("SECRET other tenant segment");
  });
});
