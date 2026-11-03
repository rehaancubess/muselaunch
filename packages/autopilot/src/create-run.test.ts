import { describe, expect, it } from "vitest";
import { deriveRun, finalSlides, overspend, pickVariant, problemFromError, runNoun, runSettings, stageLabel, stepKeyOf, waitMs, type RunInput } from "./create-run";

const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

describe("Create runs: which idea a run makes", () => {
  const v = (id: string, angleType: string, status = "proposed") => ({ id, angleType, status, title: id }) as RunInput["variants"][number];
  it("keeps a picked idea, prefers a demo for “Show a feature”, else the first; never a set-aside one", () => {
    expect(pickVariant([v("a", "emotional_problem"), v("b", "practical_demo")], "promote")?.id).toBe("a");
    expect(pickVariant([v("a", "emotional_problem"), v("b", "practical_demo")], "feature")?.id).toBe("b");
    expect(pickVariant([v("a", "emotional_problem"), v("b", "practical_demo", "selected")], "promote")?.id).toBe("b");
    expect(pickVariant([v("a", "practical_demo", "rejected"), v("b", "founder_story")], "feature")?.id).toBe("b");
    expect(pickVariant([v("a", "tutorial", "rejected")], "promote")).toBeNull();
  });
});

describe("Create runs: where a run stands (stored records only)", () => {
  const campaign = { id: "cmp_1", status: "planning", goal: "feature_announcement", createdAt: at(0), deliverables: [{ kind: "feature_promo", channel: "tiktok", aspectRatio: "9:16", durationSec: 20, count: 1 }] } as RunInput["campaign"];
  const job = (id: string, type: string, status: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, type, status, payload, progress: { pct: 50, stage: "working" }, createdAt: at(1), updatedAt: at(2), ...extra }) as never;
  const variants = [
    { id: "var_a", status: "proposed", angleType: "emotional_problem", title: "Calm in exam season", compositionIds: [] },
    { id: "var_b", status: "proposed", angleType: "practical_demo", title: "One tap to deep work", compositionIds: [] },
  ] as RunInput["variants"];
  const base: RunInput = { campaign, variants: [], compositions: [], jobs: [], finals: [] };

  it("writing the idea: the concepts job's progress; a failure says so and can be tried again", () => {
    const running = deriveRun({ ...base, jobs: [job("j1", "campaign.generate_concepts", "running", { campaignId: "cmp_1" })] });
    expect(running).toMatchObject({ stage: "idea", working: true, pct: 10, next: null, failure: null });
    const failed = deriveRun({ ...base, jobs: [job("j1", "campaign.generate_concepts", "failed", { campaignId: "cmp_1" }, { error: { code: "PROVIDER_ERROR", message: "x", userMessage: "Muse Spark is busy." } })] });
    expect(failed.failure).toEqual({ stage: "idea", message: "Muse Spark is busy.", jobId: "j1", canRetry: true });
    // The job finished but the ideas aren't readable yet: on its way, not failed.
    expect(deriveRun({ ...base, jobs: [job("j1", "campaign.generate_concepts", "succeeded", { campaignId: "cmp_1" })] })).toMatchObject({ stage: "idea", failure: null, working: true });
    // Past planning with no ideas: none came.
    expect(deriveRun({ ...base, campaign: { ...campaign, status: "concepts_ready" } }).failure?.message).toBe("Muse didn’t come up with an idea this time.");
    // Another campaign's job isn't this run's.
    expect(deriveRun({ ...base, jobs: [job("j9", "campaign.generate_concepts", "failed", { campaignId: "cmp_other" })] })).toMatchObject({ stage: "idea", failure: null, working: true });
    // “Try again” ran it as a new job: the newest attempt counts.
    expect(deriveRun({ ...base, jobs: [job("j1", "campaign.generate_concepts", "failed", { campaignId: "cmp_1" }), job("j2", "campaign.generate_concepts", "running", { campaignId: "cmp_1" }, { parentJobId: "j1", createdAt: at(3) })] })).toMatchObject({ working: true, failure: null });
  });

  it("ideas ready: plan the best-fitting one in the chosen format and length (select it first)", () => {
    const view = deriveRun({ ...base, variants, jobs: [job("j1", "campaign.generate_concepts", "succeeded", { campaignId: "cmp_1" })] });
    expect(view).toMatchObject({ stage: "plan", ideaTitle: "One tap to deep work", ideaCount: 2, working: false });
    expect(view.next).toEqual({ kind: "produce", variantId: "var_b", select: true, aspectRatio: "9:16", targetDurationSec: 20 });
    expect(stepKeyOf(view.next!)).toBe("produce:var_b");
    // The app's screens are still being checked: wait for that real footage.
    expect(deriveRun({ ...base, variants, footageBusy: true })).toMatchObject({ stage: "plan", next: null, working: true, detail: "Getting your app’s screens ready first" });
    // Someone planned another idea already: that's the one being made.
    expect(deriveRun({ ...base, variants, jobs: [job("sb", "storyboard.generate", "running", { campaignId: "cmp_1", variantId: "var_a" })] })).toMatchObject({ stage: "plan", ideaTitle: "Calm in exam season", next: null });
  });

  it("planning → making it: follows the storyboard, b-roll, build and preview jobs (and their retries)", () => {
    const chosen = [{ ...variants[1]!, status: "selected" as const }];
    const sb = job("sb", "storyboard.generate", "running", { campaignId: "cmp_1", variantId: "var_b" });
    expect(deriveRun({ ...base, variants: chosen, jobs: [sb] })).toMatchObject({ stage: "plan", working: true, pct: 33, next: null });
    const done = { ...(sb as object), status: "succeeded" } as never;
    const media = job("m", "storyboard.resolve_media", "succeeded", {}, { parentJobId: "sb" });
    const build = job("b", "composition.build", "running", {}, { parentJobId: "m", progress: { pct: 40, stage: "building the video" } });
    expect(deriveRun({ ...base, variants: chosen, jobs: [build, media, done] })).toMatchObject({ stage: "make", working: true, detail: "building the video" });
    const broken = job("b", "composition.build", "failed", {}, { parentJobId: "m", error: { code: "X", message: "boom" } });
    expect(deriveRun({ ...base, variants: chosen, jobs: [broken, media, done] }).failure).toEqual({ stage: "make", message: "boom", jobId: "b", canRetry: true });
    // Its retry is running: working again, not failed.
    const retried = job("b2", "composition.build", "running", {}, { parentJobId: "b", createdAt: at(4) });
    expect(deriveRun({ ...base, variants: chosen, jobs: [retried, broken, media, done] })).toMatchObject({ stage: "make", working: true, failure: null });
  });

  it("video made: waits for the preview, then the checks and the final render; done once a final render is ready", () => {
    const chosen = [{ ...variants[1]!, status: "produced" as const, compositionIds: ["cmp_v"] }];
    const comp = { id: "cmp_v", status: "rendered", currentVersion: 2, variantId: "var_b", createdAt: at(3) } as RunInput["compositions"][number];
    const preview = job("p", "render.preview", "running", { compositionId: "cmp_v" });
    expect(deriveRun({ ...base, variants: chosen, compositions: [comp], jobs: [preview] })).toMatchObject({ stage: "make", working: true, next: null, compositionId: "cmp_v" });
    // A failed preview doesn't stop it: the final render is made from the editable video.
    expect(deriveRun({ ...base, variants: chosen, compositions: [comp], jobs: [{ ...(preview as object), status: "failed" } as never] }).next?.kind).toBe("final");
    const view = deriveRun({ ...base, variants: chosen, compositions: [comp] });
    expect(view).toMatchObject({ stage: "check", pct: 75 });
    expect(view.next).toEqual({ kind: "final", compositionId: "cmp_v", version: 2 });
    expect(stepKeyOf(view.next!)).toBe("final:cmp_v:v2");
    const rendering = job("f", "render.final", "running", { compositionId: "cmp_v" }, { progress: { pct: 50, stage: "rendering video" } });
    expect(deriveRun({ ...base, variants: chosen, compositions: [comp], jobs: [rendering] })).toMatchObject({ stage: "finish", pct: 90, detail: "rendering video" });
    const finals = [{ id: "ast_r", status: "ready", kind: "video", role: "render", render: { compositionId: "cmp_v", quality: "final", version: 2 } }];
    expect(deriveRun({ ...base, variants: chosen, compositions: [comp], finals })).toMatchObject({ stage: "done", pct: 100, finalAssetId: "ast_r", next: null });
    // The final render job finished before the video's records caught up: done, never sent again.
    const rendered = job("f", "render.final", "succeeded", { compositionId: "cmp_v" }, { output: { refs: [], data: { assetId: "ast_new" } } });
    expect(deriveRun({ ...base, variants: chosen, compositions: [comp], jobs: [rendered] })).toMatchObject({ stage: "done", next: null, finalAssetId: "ast_new" });
    // A failed final render: Try again.
    const failed = job("f", "render.final", "failed", { compositionId: "cmp_v" }, { error: { code: "X", message: "x", userMessage: "The renderer stopped." } });
    expect(deriveRun({ ...base, variants: chosen, compositions: [comp], jobs: [failed] }).failure).toEqual({ stage: "finish", message: "The renderer stopped.", jobId: "f", canRetry: true });
    // A preview render isn't a finished video.
    expect(deriveRun({ ...base, variants: chosen, compositions: [comp], finals: [{ ...finals[0]!, render: { compositionId: "cmp_v", quality: "preview", version: 2 } }] }).stage).toBe("check");
  });

  it("knows when anything of the run last moved (a day without progress waits for the person)", () => {
    expect(deriveRun(base).lastActivity).toBe(T0);
    expect(deriveRun({ ...base, jobs: [job("j1", "campaign.generate_concepts", "running", { campaignId: "cmp_1" }, { updatedAt: at(30) })] }).lastActivity).toBe(T0 + 30 * 60_000);
  });
});

describe("Create runs: when a step is refused", () => {
  it("names the decision (credits, a plan limit, the brand check, a fix, permissions) and waits out passing ones", () => {
    expect(problemFromError({ status: 402, code: "INSUFFICIENT_CREDITS", userMessage: "This needs 16 credits and you have 2.", details: { required: 16, available: 2 } })).toEqual({ wait: false, kind: "credits", message: "This needs 16 credits and you have 2.", credits: 16 });
    expect(problemFromError({ status: 429, code: "QUOTA_EXCEEDED", userMessage: "Your plan runs up to 2 tasks at once.", details: { quota: "concurrentJobs" } })).toEqual({ wait: true, reason: "Your plan runs up to 2 tasks at once." });
    expect(problemFromError({ status: 429, code: "QUOTA_EXCEEDED", userMessage: "5 final renders per day.", details: { quota: "finalRendersPerDay" } })).toMatchObject({ wait: false, kind: "limit" });
    expect(problemFromError({ status: 409, code: "APPROVAL_REQUIRED", userMessage: "x", details: { reason: "brand_review_blocked", requiresOverride: true, review: { id: "brv_1", blocking: [{ message: "Says “#1 timer” without proof" }] } } })).toEqual({
      wait: false,
      kind: "brand",
      message: "Says “#1 timer” without proof",
      canOverride: true,
      reviewId: "brv_1",
    });
    expect(problemFromError({ status: 422, code: "VALIDATION_FAILED", userMessage: "Fix the flagged issues before the final render.", details: { issues: [{ message: "Scene 2: unconfirmed claim" }] } })).toEqual({ wait: false, kind: "fix", message: "Fix the flagged issues before the final render. Scene 2: unconfirmed claim" });
    expect(problemFromError({ status: 409, code: "CONFLICT", userMessage: "The brand check is still running.", details: { reason: "brand_review_running" } })).toEqual({ wait: true, reason: "The brand check is still running." });
    expect(problemFromError({ status: 403, code: "FORBIDDEN", userMessage: "No." })).toEqual({ wait: false, kind: "permission", message: "No." });
    expect(problemFromError({ status: 503, code: "PROVIDER_UNAVAILABLE", userMessage: "Busy." })).toEqual({ wait: true, reason: "Busy.", glitch: true });
    expect(problemFromError({ status: 500, code: "INTERNAL", retryable: true })).toMatchObject({ wait: true, glitch: true });
    expect(problemFromError({ status: 409, code: "CONFLICT", userMessage: "Rejected." })).toEqual({ wait: false, kind: "error", message: "Rejected." });
  });

  it("asks before a final video that costs more than shown; backs off on waits", () => {
    expect(overspend(24, 16)).toEqual({ credits: 24, shown: 16 });
    expect(overspend(16, 16)).toBeNull();
    expect(overspend(8, 16)).toBeNull();
    expect(overspend(24, null)).toBeNull();
    expect([0, 1, 2, 3, 4, 5, 9].map(waitMs)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });
});

describe("Create runs: stills and text posts", () => {
  const job = (id: string, type: string, status: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, type, status, payload, progress: { pct: 50, stage: "working" }, createdAt: at(1), updatedAt: at(2), ...extra }) as never;
  const camp = (deliverable: Record<string, unknown>) => ({ id: "cmp_s", status: "concepts_ready", goal: "awareness", createdAt: at(0), deliverables: [{ count: 1, aspectRatio: "9:16", ...deliverable }] }) as RunInput["campaign"];
  const variants = [{ id: "var_a", status: "proposed", angleType: "practical_demo", title: "Three small changes", compositionIds: [] }] as RunInput["variants"];

  it("reads what a run makes from its one deliverable (format, frame, slides, store, channel)", () => {
    expect(runSettings(camp({ kind: "short_video", durationSec: 30 }))).toMatchObject({ output: "video", aspectRatio: "9:16", lengthSec: 30 });
    expect(runSettings(camp({ kind: "carousel", aspectRatio: "1:1", slides: 12 }))).toMatchObject({ output: "carousel", aspectRatio: "1:1", slides: 10 });
    expect(runSettings(camp({ kind: "carousel" }))).toMatchObject({ output: "carousel", aspectRatio: "4:5", slides: 6 });
    expect(runSettings(camp({ kind: "static_ad", aspectRatio: "16:9" }))).toMatchObject({ output: "post", aspectRatio: "4:5", slides: 1 });
    expect(runSettings(camp({ kind: "thumbnail" }))).toMatchObject({ output: "thumbnail", aspectRatio: "16:9", slides: 1 });
    expect(runSettings(camp({ kind: "store_screenshots", store: "android", slides: 10 }))).toMatchObject({ output: "store_screenshots", aspectRatio: "9:16", slides: 8, store: "android" });
    expect(runSettings(camp({ kind: "store_screenshots" }))).toMatchObject({ output: "store_screenshots", aspectRatio: "9:19.5", store: "ios" });
    expect(runSettings(camp({ kind: "text_post", channel: "threads" }))).toMatchObject({ output: "text_post", channel: "threads" });
    expect(runSettings(camp({ kind: "text_post", channel: "tiktok" })).channel).toBe("x");
    expect(runSettings(camp({ kind: "text_post", channel: "x" })).lengthSec).toBeUndefined();
    expect(stageLabel("carousel", "plan")).toBe("Planning the carousel");
    expect(stageLabel("store_screenshots", "plan")).toBe("Planning the screenshots");
    expect(stageLabel("text_post", "plan")).toBe("Writing the post");
    expect(runNoun("store_screenshots")).toMatchObject({ one: "screenshots", plural: true });
  });

  it("a still run plans in its format and slide count, then is done when its final slide images exist (in order)", () => {
    const c = camp({ kind: "carousel", aspectRatio: "4:5", slides: 5 });
    const plan = deriveRun({ campaign: c, variants, compositions: [], jobs: [], finals: [] });
    expect(plan.output).toBe("carousel");
    expect(plan.next).toEqual({ kind: "produce", variantId: "var_a", select: true, aspectRatio: "4:5", format: "carousel", slides: 5 });
    const store = deriveRun({ campaign: camp({ kind: "store_screenshots", store: "ios", slides: 4 }), variants, compositions: [], jobs: [], finals: [] });
    expect(store.next).toMatchObject({ format: "store_screenshots", slides: 4, store: "ios", aspectRatio: "9:19.5" });
    // Plain words when a step fails.
    const failed = deriveRun({ campaign: c, variants, compositions: [], jobs: [job("sb", "storyboard.generate", "cancelled", { campaignId: "cmp_s", variantId: "var_a" })], finals: [] });
    expect(failed.failure?.message).toBe("Planning the carousel was stopped.");

    const chosen = [{ ...variants[0]!, status: "produced" as const, compositionIds: ["cmp_c"] }];
    const comp = { id: "cmp_c", status: "rendered", currentVersion: 2, variantId: "var_a", createdAt: at(3) } as RunInput["compositions"][number];
    expect(deriveRun({ campaign: c, variants: chosen, compositions: [comp], jobs: [], finals: [] }).next).toEqual({ kind: "final", compositionId: "cmp_c", version: 2 });
    const slide = (id: string, n: number, version = 2, quality = "final") => ({ id, status: "ready", kind: "image", role: "render", labels: [`slide:${n}`], render: { compositionId: "cmp_c", quality, version } });
    // Newest first, any order: slide 1 is ast_r_k, slide n is ast_r_k_<n>; an older version's slides and preview slides don't count.
    const finals = [slide("ast_r_k_3", 3), slide("ast_r_k", 1), slide("ast_r_k_2", 2), slide("ast_r_old", 1, 1), slide("ast_r_old_2", 2, 1), slide("ast_r_p", 1, 2, "preview")];
    const done = deriveRun({ campaign: c, variants: chosen, compositions: [comp], jobs: [], finals });
    expect(done).toMatchObject({ stage: "done", pct: 100, finalAssetId: "ast_r_k", finalAssetIds: ["ast_r_k", "ast_r_k_2", "ast_r_k_3"] });
    expect(finalSlides(finals, "cmp_c").map((a) => a.id)).toEqual(["ast_r_k", "ast_r_k_2", "ast_r_k_3"]);
    // While the renderer is still saving slides, the run isn't done (its first images aren't the whole set).
    const saving = job("f", "render.final", "running", { compositionId: "cmp_c" }, { progress: { pct: 92, stage: "saving" } });
    expect(deriveRun({ campaign: c, variants: chosen, compositions: [comp], jobs: [saving], finals: finals.slice(0, 2) })).toMatchObject({ stage: "finish", working: true, detail: "saving" });
    // A video final render of the same composition is not a still's result (and the other way round).
    const video = [{ id: "ast_r_v", status: "ready", kind: "video", role: "render", render: { compositionId: "cmp_c", quality: "final", version: 2 } }];
    expect(deriveRun({ campaign: c, variants: chosen, compositions: [comp], jobs: [], finals: video }).stage).toBe("check");
    expect(deriveRun({ campaign: camp({ kind: "short_video" }), variants: chosen, compositions: [comp], jobs: [], finals }).stage).toBe("check");
    // The render finished before the records caught up: done with the job's own slide refs.
    const rendered = job("f", "render.final", "succeeded", { compositionId: "cmp_c" }, { output: { refs: [{ entity: "mediaAssets", id: "ast_r_n" }, { entity: "mediaAssets", id: "ast_r_n_2" }] } });
    expect(deriveRun({ campaign: c, variants: chosen, compositions: [comp], jobs: [rendered], finals: [] })).toMatchObject({ stage: "done", finalAssetIds: ["ast_r_n", "ast_r_n_2"] });
    // The render worker's own list of slides (also on cache hits) wins over its refs.
    const listed = job("f", "render.final", "succeeded", { compositionId: "cmp_c" }, { output: { refs: [{ entity: "mediaAssets", id: "ast_r_m" }], data: { assetId: "ast_r_m", posterAssetId: "ast_r_m", assetIds: ["ast_r_m", "ast_r_m_2", "ast_r_m_3"], slides: 3, still: true } } });
    expect(deriveRun({ campaign: c, variants: chosen, compositions: [comp], jobs: [listed], finals: [] })).toMatchObject({ stage: "done", finalAssetId: "ast_r_m", finalAssetIds: ["ast_r_m", "ast_r_m_2", "ast_r_m_3"] });
    const broken = job("f", "render.final", "failed", { compositionId: "cmp_c" }, { error: { code: "X", message: "x" } });
    expect(deriveRun({ campaign: camp({ kind: "store_screenshots", store: "ios" }), variants: chosen, compositions: [comp], jobs: [broken], finals: [] }).failure?.message).toBe("x");
    const stopped = { ...(broken as object), status: "cancelled" } as never;
    expect(deriveRun({ campaign: camp({ kind: "store_screenshots", store: "ios" }), variants: chosen, compositions: [comp], jobs: [stopped], finals: [] }).failure?.message).toBe("The final screenshots were stopped.");
  });

  it("a text post: the idea, then Muse writes the post for its channel; done once the copy pack exists (no render, no plan)", () => {
    const c = camp({ kind: "text_post", channel: "x" });
    const write = deriveRun({ campaign: c, variants, compositions: [], jobs: [job("j1", "campaign.generate_concepts", "succeeded", { campaignId: "cmp_s" })], finals: [] });
    expect(write).toMatchObject({ stage: "plan", output: "text_post", pct: 40, next: { kind: "copy", variantId: "var_a", select: true, channel: "x" } });
    expect(stepKeyOf(write.next!)).toBe("copy:var_a");
    const running = deriveRun({ campaign: c, variants, compositions: [], jobs: [job("cp", "copy.generate", "running", { campaignId: "cmp_s", variantId: "var_a", channels: ["x"] })], finals: [] });
    expect(running).toMatchObject({ stage: "plan", working: true, pct: 70, next: null });
    // Another channel's copy, or the campaign's video copy, isn't this post.
    expect(deriveRun({ campaign: c, variants, compositions: [], jobs: [job("cp", "copy.generate", "running", { campaignId: "cmp_s", channels: ["instagram"] })], finals: [] }).next?.kind).toBe("copy");
    const failed = deriveRun({ campaign: c, variants, compositions: [], jobs: [job("cp", "copy.generate", "failed", { campaignId: "cmp_s", variantId: "var_a", channels: ["x"] }, { error: { code: "PROVIDER_ERROR", message: "x", userMessage: "Muse Spark is busy." } })], finals: [] });
    expect(failed.failure).toEqual({ stage: "plan", message: "Muse Spark is busy.", jobId: "cp", canRetry: true });
    const packs = [{ id: "cpy_1", channel: "x" as const, variantId: "var_a", createdAt: at(5) }];
    expect(deriveRun({ campaign: c, variants, compositions: [], jobs: [], finals: [], copyPacks: packs })).toMatchObject({ stage: "done", pct: 100, copyPackId: "cpy_1", next: null });
    // The job finished first: done with the pack in its output.
    const finished = job("cp", "copy.generate", "succeeded", { campaignId: "cmp_s", variantId: "var_a", channels: ["x"] }, { output: { refs: [{ entity: "copyPacks", id: "cpy_2" }] } });
    expect(deriveRun({ campaign: c, variants, compositions: [], jobs: [finished], finals: [] })).toMatchObject({ stage: "done", copyPackId: "cpy_2" });
    // Never a storyboard for a text post.
    expect(deriveRun({ campaign: c, variants, compositions: [], jobs: [], finals: [] }).next?.kind).toBe("copy");
  });
});
