import { commitVersion } from "@muselaunch/compositions/store";
import { createTestPlatform } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { installFakeMeta, jsonRoute, requestText, seedApp, seedRenderedVideo, type MetaRequest, type SeededApp } from "../testing";
import { mergeVideoFindings, requestVideoFix, requestVideoReview, videoFixPlan, videoReviewHandler } from "./index";
import { readingFindings, repetitionFindings, sceneFacts } from "./measure";
import { reviewTestDoc } from "./testing";

/**
 * Spark's video review through the real job runner: a real MP4 (FFmpeg test sources) → frames →
 * fake Meta Responses API answering with documented-shape FIXTURE JSON (never live output).
 */

const images = (req: MetaRequest) => ((req.input ?? []) as MetaRequest[]).flatMap((i) => (i.content ?? []) as MetaRequest[]).filter((c) => c.type === "input_image");

describe("Spark video review (video.review)", () => {
  const p = createTestPlatform({ META_API_KEY: "test-key" }, { "video.review": videoReviewHandler });
  const wid = "ws_vreview";
  let seed: SeededApp;
  const seen: MetaRequest[] = [];

  beforeAll(async () => {
    await p.credits.ensureAccount(wid, { grant: 500, reason: "test" });
    seed = await seedApp(p, wid);
    installFakeMeta(p, [
      jsonRoute("VideoReview", (req) => {
        seen.push(req);
        const last = `f${images(req).length}`;
        return {
          score: 5.5,
          summary: "The hook flies by and the demo scene is black; the CTA sits under the platform buttons. (fixture)",
          rubric: [
            { check: "hook_readability", verdict: "issue" },
            { check: "honesty", verdict: "ok" },
            { check: "safe zones", verdict: "issue", note: "CTA low" },
          ],
          findings: [
            { sceneId: "sc_hook", severity: "warn", check: "hook_readability", issue: "16 words in 2 s in f1/f2.", fixInstruction: "Cut the hook to six words.", frameRef: "f2" },
            { sceneId: "sc_made_up", severity: "BLOCKING", check: "Safe zones", issue: `The CTA sits in the bottom 10% (${last}).`, fixInstruction: "Move the CTA up to the middle third.", frameRef: last },
            { sceneId: "video", severity: "info", check: "pacing", issue: "Every scene is the same length.", fixInstruction: "Vary scene lengths.", frameRef: "" },
          ],
        };
      }),
    ]);
  });

  it("extracts frames from the real render, asks Spark with the scene list + measurements, and stores merged, validated findings", async () => {
    const v = await seedRenderedVideo(p, wid, { appId: seed.appId, screenshotId: seed.screenshotIds[0]! });
    const { review: queued, job, reused } = await requestVideoReview(p, wid, { compositionId: v.compositionId, actor: "u1", requestedFrom: "studio" });
    expect(reused).toBe(false);
    expect(queued).toMatchObject({ status: "queued", version: 1, renderAssetId: v.renderAssetId, renderQuality: "final", requestedFrom: "studio" });
    expect(job).toMatchObject({ type: "video.review", payload: { compositionId: v.compositionId, version: 1, renderAssetId: v.renderAssetId, reviewId: queued.id } });
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job!.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.creditsCharged).toBe(6);
    const ws = p.db.ws(wid);
    const review = await ws.collection("videoReviews").getOrThrow(queued.id);

    // Frames: first frame, the three mid-points (no scene is long enough for extras), stored as derived assets.
    expect(review.frames.map((f) => [f.ref, f.atSec, f.sceneId, f.kind])).toEqual([
      ["f1", 0, "sc_hook", "first"],
      ["f2", 1, "sc_hook", "mid"],
      ["f3", 3.5, "sc_demo", "mid"],
      ["f4", 6, "sc_cta", "mid"],
    ]);
    for (const f of review.frames) {
      const a = await ws.collection("mediaAssets").getOrThrow(f.assetId!);
      expect(a).toMatchObject({ kind: "image", role: "preview", origin: "derived", sourceLabel: "review_frame", derivedFromAssetId: v.renderAssetId, isProductTruth: false, mimeType: "image/jpeg" });
      expect((await p.storage.get(a.storagePath)).length).toBeGreaterThan(300);
    }

    // Spark saw every frame (multimodal) and the scene list, reading speeds and measurements.
    const req = seen.at(-1)!;
    expect(String(req.model)).toBe("muse-spark-1.3");
    expect(images(req)).toHaveLength(4);
    const text = requestText(req);
    expect(text).toContain("- sc_hook | Hook | template hook-title (hook) | 0.00s–2.00s (2.00s)");
    expect(text).toMatch(/16 words, 8 words\/s while readable/);
    expect(text).toContain("[broken_frame · sc_demo]");
    expect(text).toContain("Frame f3: 3.50s — scene mid-point — scene sc_demo \"Demo\"");
    expect(text).toContain("Block distracting apps during focus sessions");
    expect(String(req.instructions)).toContain("never a device frame inside another device frame");

    // Findings: Spark's (normalised) + measured ones Spark missed; known scenes and frames only.
    const by = (check: string) => review.findings.filter((f) => f.check === check);
    expect(by("hook_readability")).toHaveLength(1);
    expect(by("hook_readability")[0]).toMatchObject({ sceneId: "sc_hook", severity: "blocker", source: "spark", measurement: "8 words/s (16 words)", frameRef: "f2" });
    expect(by("broken_frame")[0]).toMatchObject({ sceneId: "sc_demo", severity: "blocker", source: "measured", frameRef: "f3" });
    expect(by("safe_zone")[0]).toMatchObject({ sceneId: "sc_cta", severity: "blocker", source: "spark", frameRef: "f4" }); // unknown scene id → its frame's scene
    expect(by("pacing")[0]).toMatchObject({ severity: "info", source: "spark" });
    expect(by("pacing")[0]!.sceneId).toBeUndefined();
    expect(review).toMatchObject({ status: "succeeded", verdict: "blockers", score: 5.5, reviewer: { model: "muse-spark-1.3", label: "Muse Spark" } });
    expect(review.rubric).toEqual(expect.arrayContaining([{ check: "safe_zone", verdict: "issue", note: "CTA low" }, { check: "honesty", verdict: "ok" }]));
    expect(review.findings.every((f) => f.id.startsWith("vf_"))).toBe(true);

    // Run log + metered usage.
    const run = await ws.collection("agentRuns").getOrThrow(review.agentRunId!);
    expect(run).toMatchObject({ kind: "video_review", status: "succeeded" });
    const steps = (await ws.collection("agentSteps").list({ where: [["runId", "==", run.id]], orderBy: { field: "index", dir: "asc" }, limit: 20 })).items;
    expect(steps.map((s) => s.kind)).toEqual(["tool_call", "decision", "model_call", "decision"]);
    expect(steps[2]!.title).toMatch(/Watch 4 frames and review them \(Muse Spark, multimodal\)/);
    const usage = (await ws.collection("modelUsage").list({ where: [["jobId", "==", job!.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 10 })).items;
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0]).toMatchObject({ provider: "meta", images: 4 });

    // Asking again reuses the review (no second job, no second charge).
    const again = await requestVideoReview(p, wid, { compositionId: v.compositionId, actor: "u1", requestedFrom: "studio" });
    expect(again).toMatchObject({ reused: true, review: { id: review.id } });

    // "Fix these scenes": a PROPOSED scene-scoped edit (not auto-applied) from the blockers and warnings.
    const fix = await requestVideoFix(p, wid, { reviewId: review.id, actor: "u1" });
    expect(fix.patch).toMatchObject({ status: "proposed", source: "ai", baseVersion: 1, affectedSceneIds: ["sc_hook", "sc_demo", "sc_cta"] });
    expect(fix.job).toMatchObject({ type: "composition.edit", payload: { autoApply: false, sceneIds: ["sc_hook", "sc_demo", "sc_cta"], patchId: fix.patch.id } });
    expect(String(fix.job.payload.instruction)).toMatch(/^Spark watched the rendered video \(version 1\)/);
    expect(String(fix.job.payload.instruction)).toContain("Move the CTA up to the middle third.");
    expect(String(fix.job.payload.instruction)).not.toContain("Vary scene lengths");
    expect(fix.review.fixPatchIds).toEqual([fix.patch.id]);
    expect(fix.review.findings.filter((f) => f.resolution?.patchId === fix.patch.id)).toHaveLength(3);

    // The video changed since the review → stale.
    const cur = await ws.collection("compositionVersions").getOrThrow(`${v.compositionId}_v1`);
    await commitVersion(ws, v.compositionId, { baseVersion: 1, doc: { ...cur.doc, title: "Edited" }, source: "user_edit", summary: "edit" }, "u1");
    await expect(requestVideoFix(p, wid, { reviewId: review.id, actor: "u1" })).rejects.toMatchObject({ code: "CONFLICT", opts: { details: { reason: "video_review_stale" } } });
  });

  it("is honest when Spark can't run: the review fails with the reason, no verdict, credits released", async () => {
    const off = createTestPlatform({}, { "video.review": videoReviewHandler });
    const w = "ws_vreview_off";
    await off.credits.ensureAccount(w, { grant: 100, reason: "test" });
    const s = await seedApp(off, w);
    const v = await seedRenderedVideo(off, w, { appId: s.appId, screenshotId: s.screenshotIds[0]! });
    const { review, job } = await requestVideoReview(off, w, { compositionId: v.compositionId, actor: "u1", requestedFrom: "studio" });
    await off.inline!.drain();
    const done = await off.jobs.get(w, job!.id);
    expect(done).toMatchObject({ status: "failed", error: { code: "PROVIDER_NOT_CONFIGURED" } });
    expect(done?.creditsCharged ?? 0).toBe(0);
    const failed = await off.db.ws(w).collection("videoReviews").getOrThrow(review.id);
    expect(failed.status).toBe("failed");
    expect(failed.verdict).toBeUndefined();
    expect(failed.error).toMatch(/Muse Spark isn't connected/);
    expect((await off.credits.balance(w)).available).toBe(100);
  });

  it("refuses a version with no render, other compositions' renders, and other workspaces", async () => {
    const ws = p.db.ws(wid);
    const v = await seedRenderedVideo(p, wid, { appId: seed.appId, screenshotId: seed.screenshotIds[0]!, hook: "Focus in one tap" });
    const cur = await ws.collection("compositionVersions").getOrThrow(`${v.compositionId}_v1`);
    await commitVersion(ws, v.compositionId, { baseVersion: 1, doc: { ...cur.doc, title: "Unrendered edit" }, source: "user_edit", summary: "edit" }, "u1");
    await expect(requestVideoReview(p, wid, { compositionId: v.compositionId, actor: "u1", requestedFrom: "studio" })).rejects.toMatchObject({ code: "CONFLICT", opts: { details: { reason: "no_render" } } });
    const other = await seedRenderedVideo(p, wid, { appId: seed.appId, screenshotId: seed.screenshotIds[1]!, hook: "Another video entirely" });
    await expect(requestVideoReview(p, wid, { compositionId: v.compositionId, version: 1, renderAssetId: other.renderAssetId, actor: "u1", requestedFrom: "studio" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(requestVideoReview(p, "ws_someone_else", { compositionId: v.compositionId, actor: "u1", requestedFrom: "studio" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a review whose job was cancelled before it ran isn't reused forever: asking again starts a fresh one", async () => {
    const v = await seedRenderedVideo(p, wid, { appId: seed.appId, screenshotId: seed.screenshotIds[0]!, hook: "Cancelled before it ran" });
    const first = await requestVideoReview(p, wid, { compositionId: v.compositionId, actor: "u1", requestedFrom: "studio" });
    await p.jobs.requestCancel(wid, first.job!.id, "u1");
    const second = await requestVideoReview(p, wid, { compositionId: v.compositionId, actor: "u1", requestedFrom: "studio" });
    expect(second.reused).toBe(false);
    expect(second.review.id).not.toBe(first.review.id);
    expect((await p.db.ws(wid).collection("videoReviews").getOrThrow(first.review.id)).status).toBe("failed");
    await p.inline!.drain();
    expect((await p.db.ws(wid).collection("videoReviews").getOrThrow(second.review.id)).status).toBe("succeeded");
  });
});

describe("video review measurements and fix plans (pure)", () => {
  const theme = { mode: "light" as const, background: "#FFFFFF", surface: "#F5F5F7", text: "#111111", textMuted: "#6E6E73", accent: "#5C46DC", headingFont: "Inter", bodyFont: "Inter", radiusPx: 28 };

  it("reads text from any template (text layers + block text params) and flags a too-fast hook and reused screenshots", () => {
    const doc = reviewTestDoc(theme, "ast_shot");
    const facts = sceneFacts(doc);
    expect(facts.map((f) => [f.id, f.words, f.wps])).toEqual([
      ["sc_hook", 16, 8],
      ["sc_demo", 3, 1],
      ["sc_cta", 5, 2.5],
    ]);
    expect(readingFindings(facts)).toEqual([expect.objectContaining({ sceneId: "sc_hook", severity: "blocker", check: "hook_readability", measurement: "8 words/s (16 words)" })]);
    const calm = sceneFacts(reviewTestDoc(theme, "ast_shot", { hook: "Focus in one tap" }));
    expect(readingFindings(calm)).toEqual([]);
    const tripled = { ...doc, scenes: [doc.scenes[1]!, { ...doc.scenes[1]!, id: "sc_demo2" }, { ...doc.scenes[1]!, id: "sc_demo3", name: "Demo again" }] };
    expect(repetitionFindings(sceneFacts(tripled))).toEqual([expect.objectContaining({ sceneId: "sc_demo3", check: "repetition", severity: "warn" })]);
    const block = { ...doc.scenes[0]!, id: "sc_block", layers: [{ id: "ly_b", type: "block" as const, blockId: "lower-third", params: { title: "Plan your week in seconds", color: "#ffffff" }, box: { x: 0, y: 0, w: 1, h: 0.2, rotation: 0, opacity: 1, z: 1 }, timing: { start: 0 }, animation: { loop: "none" as const }, locked: false, hidden: false }] };
    expect(sceneFacts({ ...doc, scenes: [block] })[0]).toMatchObject({ words: 5 });
  });

  it("builds a scene-scoped instruction from findings, and nothing when every finding is about the whole video", () => {
    const doc = reviewTestDoc(theme, "ast_shot");
    const { findings } = mergeVideoFindings("vrv_x", { findings: [{ sceneId: "sc_cta", severity: "warn", check: "cta", issue: "CTA is tiny.", fixInstruction: "Make the CTA bigger.", frameRef: "" }] }, { sceneIds: doc.scenes.map((s) => s.id), frames: [], measured: [] });
    const plan = videoFixPlan({ version: 3, findings }, doc);
    expect(plan).toMatchObject({ sceneIds: ["sc_cta"] });
    expect(plan!.instruction).toContain('- Scene "CTA" (sc_cta) [warn, call to action]: CTA is tiny. Fix: Make the CTA bigger.');
    expect(videoFixPlan({ version: 3, findings }, doc, { severities: ["blocker"] })).toBeNull();
    const whole = mergeVideoFindings("vrv_y", { findings: [{ sceneId: "video", severity: "blocker", check: "brand_fit", issue: "Off-brand palette.", fixInstruction: "Use the brand colours.", frameRef: "" }] }, { sceneIds: doc.scenes.map((s) => s.id), frames: [], measured: [] });
    expect(videoFixPlan({ version: 3, findings: whole.findings }, doc)).toBeNull();
  });
});
