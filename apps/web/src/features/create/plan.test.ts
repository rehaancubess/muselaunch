import { describe, expect, it } from "vitest";
import {
  campaignRequest,
  clampLength,
  clock,
  defaultFormat,
  estimateSteps,
  featurePrompt,
  finishedVideos,
  formatById,
  hasRealFootage,
  ideaPrompt,
  isWait,
  lengthOptions,
  overspend,
  pickVariant,
  problemFromError,
  promotePrompt,
  readPrefill,
  runView,
  shortName,
  stepState,
  sumCredits,
  type RunInput,
} from "./plan";

const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

describe("Create: starting points and prompts", () => {
  it("suggests a Promote prompt from About your app, reading naturally", () => {
    expect(promotePrompt("Tidy Timer", { oneLiner: "A calm Pomodoro timer that blocks distractions." })).toBe("Introduce Tidy Timer: a calm Pomodoro timer that blocks distractions.");
    expect(promotePrompt("Tidy Timer", { oneLiner: "Helps students focus in short sessions. Free to start." })).toBe("Introduce Tidy Timer, which helps students focus in short sessions.");
    expect(promotePrompt("Tidy Timer", { oneLiner: "Tidy Timer turns study time into calm sessions" })).toBe("Show why Tidy Timer turns study time into calm sessions.");
    expect(promotePrompt("Tidy Timer", { oneLiner: "", tagline: "AI focus coach" })).toBe("Introduce Tidy Timer: AI focus coach.");
    expect(promotePrompt("Tidy Timer")).toBe("Introduce Tidy Timer and what makes it worth trying.");
    // A store title's subtitle stays out of the sentence.
    expect(promotePrompt("Tidy Timer: Focus & Pomodoro", { oneLiner: "A calm Pomodoro timer." })).toBe("Introduce Tidy Timer: a calm Pomodoro timer.");
    expect(shortName("Notely — Notes & Lists")).toBe("Notely");
    expect(shortName("Re:Mind")).toBe("Re:Mind");
  });

  it("turns a feature into “Show how Focus Mode blocks distractions”", () => {
    expect(featurePrompt({ name: "Focus Mode", description: "Blocks distractions while a session runs. Works offline." })).toBe("Show how Focus Mode blocks distractions while a session runs.");
    expect(featurePrompt({ name: "Custom timers", description: "Timers for any task" })).toBe("Show Custom timers in action: timers for any task.");
    expect(featurePrompt({ name: "Glass widgets", description: "Glass widgets on your home screen" })).toBe("Show Glass widgets in action: glass widgets on your home screen.");
    expect(featurePrompt({ name: "Nudges", description: "Reminders that keep you on track" })).toBe("Show Nudges in action: reminders that keep you on track.");
    expect(featurePrompt({ name: "Habit log", description: "Tracks your streaks every day" })).toBe("Show how Habit log tracks your streaks every day.");
    expect(featurePrompt({ name: "Stats" })).toBe("Show Stats in action.");
  });

  it("fills an idea's title and the angle Muse proposed", () => {
    expect(ideaPrompt({ title: "Study-with-me timer videos", proposedAngle: "Film one calm 25-minute session. Then show the streak." })).toBe("Study-with-me timer videos. Film one calm 25-minute session.");
    expect(ideaPrompt({ title: "Exam season", summary: "Exam season" })).toBe("Exam season.");
  });

  it("reads deep links (?kind=&prompt=&idea=) and ignores anything else", () => {
    const q = (s: string) => {
      const p = new URLSearchParams(s);
      return readPrefill((k) => p.get(k));
    };
    expect(q("kind=feature&prompt=Show%20how%20Focus%20Mode%20works")).toEqual({ kind: "feature", prompt: "Show how Focus Mode works", ideaId: null });
    expect(q("idea=opp_1")).toEqual({ kind: "idea", prompt: "", ideaId: "opp_1" });
    expect(q("kind=promote&idea=opp_1")).toEqual({ kind: "promote", prompt: "", ideaId: null });
    expect(q("kind=hack")).toEqual({ kind: null, prompt: "", ideaId: null });
    expect(q("").kind).toBeNull();
  });
});

describe("Create: format, length and the request", () => {
  it("maps formats to aspect ratios and channels, defaulting to where the person posts", () => {
    expect(formatById("tiktok")).toMatchObject({ channel: "tiktok", aspectRatio: "9:16" });
    expect(formatById("square_post")).toMatchObject({ aspectRatio: "1:1" });
    expect(formatById("youtube_video")).toMatchObject({ channel: "youtube", aspectRatio: "16:9" });
    expect(formatById("nope").id).toBe("instagram_reel");
    expect(defaultFormat(["linkedin", "youtube", "tiktok"]).id).toBe("youtube_short");
    expect(defaultFormat([]).id).toBe("instagram_reel");
  });

  it("offers only the lengths the plan allows", () => {
    expect(lengthOptions(60)).toEqual([15, 20, 30, 45, 60]);
    expect(lengthOptions(30)).toEqual([15, 20, 30]);
    expect(lengthOptions(10)).toEqual([15]);
    expect(clampLength(45, 30)).toBe(30);
    expect(clampLength(25, 60)).toBe(20);
    expect(clampLength(undefined, 60)).toBe(20);
    expect(clock(20)).toBe("0:20");
    expect(clock(75.4)).toBe("1:15");
  });

  it("sends one video in the chosen format and length, linking the idea only when it's used", () => {
    const req = campaignRequest({ kind: "feature", prompt: "  Show how Focus Mode works  ", format: formatById("tiktok"), lengthSec: 20 });
    expect(req).toEqual({
      request: "Show how Focus Mode works",
      goal: "feature_announcement",
      channels: ["tiktok"],
      deliverables: [{ kind: "feature_promo", channel: "tiktok", aspectRatio: "9:16", durationSec: 20, count: 1 }],
      opportunityIds: [],
      conceptCount: 3,
      origin: "create",
    });
    expect(campaignRequest({ kind: "idea", prompt: "An idea", format: formatById("square_post"), lengthSec: 15, ideaId: "opp_9" }).opportunityIds).toEqual(["opp_9"]);
    expect(campaignRequest({ kind: "promote", prompt: "Promote it", format: formatById("youtube_video"), lengthSec: 60, ideaId: "opp_9" })).toMatchObject({ goal: "awareness", opportunityIds: [], deliverables: [{ kind: "short_video", aspectRatio: "16:9", durationSec: 60 }] });
  });

  it("estimates every step the jobs reserve credits for (AI voice only when it's on)", () => {
    expect(estimateSteps(20).map((s) => s.operation)).toEqual(["campaign.generate_concepts", "storyboard.generate", "composition.build", "render.final"]);
    expect(estimateSteps(45, { aiVoice: true }).map((s) => [s.operation, s.params])).toEqual([
      ["campaign.generate_concepts", {}],
      ["storyboard.generate", { targetDurationSec: 45 }],
      ["composition.build", {}],
      ["media.voiceover", { source: "tts", chars: 675, durationSec: 45 }],
      ["render.final", { durationSec: 45 }],
    ]);
    expect(sumCredits([{ credits: 15 }, { credits: 11 }, { credits: -3 }])).toBe(26);
  });

  it("only generates from real footage of the app", () => {
    expect(hasRealFootage([])).toBe(false);
    expect(hasRealFootage([{ role: "screenshot", isProductTruth: false, status: "ready" }])).toBe(false);
    expect(hasRealFootage([{ role: "render", isProductTruth: true, status: "ready" }])).toBe(false);
    expect(hasRealFootage([{ role: "screenshot", isProductTruth: true, status: "deleted" }])).toBe(false);
    expect(hasRealFootage([{ role: "app_recording", isProductTruth: true, status: "processing" }])).toBe(true);
  });
});

describe("Create: which idea a run uses", () => {
  const v = (id: string, angleType: string, status = "proposed") => ({ id, angleType, status, title: id }) as RunInput["variants"][number];
  it("keeps a picked idea, prefers a demo for “Show a feature”, else the first; never a set-aside one", () => {
    expect(pickVariant([v("a", "emotional_problem"), v("b", "practical_demo")], "promote")?.id).toBe("a");
    expect(pickVariant([v("a", "emotional_problem"), v("b", "practical_demo")], "feature")?.id).toBe("b");
    expect(pickVariant([v("a", "emotional_problem"), v("b", "practical_demo", "selected")], "promote")?.id).toBe("b");
    expect(pickVariant([v("a", "practical_demo", "rejected"), v("b", "founder_story")], "feature")?.id).toBe("b");
    expect(pickVariant([v("a", "tutorial", "rejected")], "promote")).toBeNull();
  });
});

describe("Create: where a run stands (stored records only)", () => {
  const campaign = { id: "cmp_1", status: "planning", goal: "feature_announcement", createdAt: at(0), deliverables: [{ kind: "feature_promo", channel: "tiktok", aspectRatio: "9:16", durationSec: 20, count: 1 }] } as RunInput["campaign"];
  const job = (id: string, type: string, status: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, type, status, payload, progress: { pct: 50, stage: "working" }, createdAt: at(1), ...extra }) as never;
  const variants = [
    { id: "var_a", status: "proposed", angleType: "emotional_problem", title: "Calm in exam season", compositionIds: [] },
    { id: "var_b", status: "proposed", angleType: "practical_demo", title: "One tap to deep work", compositionIds: [] },
  ] as RunInput["variants"];
  const base: RunInput = { campaign, variants: [], compositions: [], jobs: [], finals: [], now: T0 + 60_000 };

  it("writing the idea: the concepts job's progress; a failure says so and can be tried again", () => {
    const running = runView({ ...base, jobs: [job("j1", "campaign.generate_concepts", "running", { campaignId: "cmp_1" })] });
    expect(running).toMatchObject({ step: "idea", working: true, pct: 10, next: null, failure: null });
    const failed = runView({ ...base, jobs: [job("j1", "campaign.generate_concepts", "failed", { campaignId: "cmp_1" }, { error: { code: "PROVIDER_ERROR", message: "x", userMessage: "Muse Spark is busy." } })] });
    expect(failed.failure).toEqual({ step: "idea", message: "Muse Spark is busy.", jobId: "j1", retry: true });
    // The job finished but the campaign read is a moment older (still "planning", no ideas yet): waiting, not failed.
    expect(runView({ ...base, jobs: [job("j1", "campaign.generate_concepts", "succeeded", { campaignId: "cmp_1" })] })).toMatchObject({ step: "idea", failure: null, working: true });
    // Past planning with no ideas: none came.
    expect(runView({ ...base, campaign: { ...campaign, status: "concepts_ready" } }).failure?.message).toBe("Muse didn’t come up with an idea this time.");
    // Another campaign's job isn't this run's.
    expect(runView({ ...base, jobs: [job("j9", "campaign.generate_concepts", "failed", { campaignId: "cmp_other" })] })).toMatchObject({ step: "idea", failure: null, working: true });
  });

  it("ideas ready: plan the best-fitting one in the chosen format and length (select it first)", () => {
    const view = runView({ ...base, variants, jobs: [job("j1", "campaign.generate_concepts", "succeeded", { campaignId: "cmp_1" })] });
    expect(view).toMatchObject({ step: "plan", ideaTitle: "One tap to deep work", ideaCount: 2, working: false });
    expect(view.next).toEqual({ kind: "produce", variantId: "var_b", select: true, aspectRatio: "9:16", targetDurationSec: 20 });
    // The app's screens are still being checked: wait for that real footage.
    expect(runView({ ...base, variants, footageBusy: true })).toMatchObject({ step: "plan", next: null, detail: "Getting your app’s screens ready first" });
  });

  it("planning → making it: follows the storyboard, b-roll, build and preview jobs", () => {
    const chosen = [{ ...variants[1]!, status: "selected" as const }];
    const sb = job("sb", "storyboard.generate", "running", { campaignId: "cmp_1", variantId: "var_b" });
    expect(runView({ ...base, variants: chosen, jobs: [sb] })).toMatchObject({ step: "plan", working: true, pct: 33, next: null });
    const done = { ...(sb as object), status: "succeeded" } as never;
    const media = job("m", "storyboard.resolve_media", "succeeded", {}, { parentJobId: "sb" });
    const build = job("b", "composition.build", "running", {}, { parentJobId: "m", progress: { pct: 40, stage: "building the video", message: "building the video" } });
    expect(runView({ ...base, variants: chosen, jobs: [build, media, done] })).toMatchObject({ step: "make", working: true, detail: "building the video" });
    const broken = job("b", "composition.build", "failed", {}, { parentJobId: "m", error: { code: "X", message: "boom" } });
    expect(runView({ ...base, variants: chosen, jobs: [broken, media, done] }).failure).toEqual({ step: "make", message: "boom", jobId: "b", retry: true });
  });

  it("video made: waits for the preview, then checks facts and brand and finishes it; done once a final render is ready", () => {
    const chosen = [{ ...variants[1]!, status: "produced" as const, compositionIds: ["cmp_v"] }];
    const comp = { id: "cmp_v", status: "rendered", currentVersion: 2, variantId: "var_b", createdAt: at(3) } as RunInput["compositions"][number];
    const preview = job("p", "render.preview", "running", { compositionId: "cmp_v" });
    expect(runView({ ...base, variants: chosen, compositions: [comp], jobs: [preview] })).toMatchObject({ step: "make", working: true, next: null, compositionId: "cmp_v" });
    // The video's record came before its preview job: not finished before the preview.
    expect(runView({ ...base, variants: chosen, compositions: [{ ...comp, status: "draft" }] })).toMatchObject({ step: "make", working: true, next: null });
    expect(runView({ ...base, variants: chosen, compositions: [{ ...comp, status: "draft" }], jobs: [{ ...(preview as object), status: "failed" } as never] }).next?.kind).toBe("final");
    expect(runView({ ...base, variants: chosen, compositions: [comp] }).next).toEqual({ kind: "final", compositionId: "cmp_v", version: 2 });
    const rendering = job("f", "render.final", "running", { compositionId: "cmp_v" }, { progress: { pct: 50, stage: "rendering video" } });
    expect(runView({ ...base, variants: chosen, compositions: [comp], jobs: [rendering] })).toMatchObject({ step: "finish", pct: 90, detail: "rendering video" });
    const finals = [{ id: "ast_r", status: "ready", kind: "video", render: { compositionId: "cmp_v", quality: "final", version: 2 } }];
    expect(runView({ ...base, variants: chosen, compositions: [comp], finals })).toMatchObject({ step: "done", pct: 100, finalAssetId: "ast_r", next: null });
    // The final render job finished before the video's records caught up: done, never sent again.
    const rendered = job("f", "render.final", "succeeded", { compositionId: "cmp_v" }, { output: { refs: [], data: { assetId: "ast_new" } } });
    expect(runView({ ...base, variants: chosen, compositions: [comp], jobs: [rendered] })).toMatchObject({ step: "done", next: null, finalAssetId: "ast_new" });
    // A preview render isn't a finished video.
    expect(runView({ ...base, variants: chosen, compositions: [comp], finals: [{ ...finals[0]!, render: { compositionId: "cmp_v", quality: "preview", version: 2 } }] }).step).toBe("check");
  });

  it("a run left for a day doesn't carry on (or spend) by itself", () => {
    const view = runView({ ...base, variants, jobs: [job("j1", "campaign.generate_concepts", "succeeded", { campaignId: "cmp_1" })], now: T0 + 25 * 3_600_000 });
    expect(view).toMatchObject({ step: "plan", next: null, stale: true });
  });

  it("step states for the list", () => {
    const view = { step: "make" as const, failure: null };
    expect(["idea", "plan", "make", "check", "finish"].map((s) => stepState(view, s as never))).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(stepState({ step: "make", failure: { step: "make", message: "x", retry: true } }, "make")).toBe("failed");
    expect(stepState({ step: "done", failure: null }, "finish")).toBe("done");
  });
});

describe("Create: when a step needs the person", () => {
  it("names the decision: credits, a plan limit, the brand check, a fix; waits out passing ones", () => {
    expect(problemFromError({ status: 402, code: "INSUFFICIENT_CREDITS", userMessage: "Not enough credits for this action." })).toEqual({ kind: "credits", message: "Not enough credits for this action." });
    const busy = problemFromError({ status: 429, code: "QUOTA_EXCEEDED", userMessage: "Your plan runs up to 2 tasks at once.", details: { quota: "concurrentJobs" } });
    expect(busy).toMatchObject({ kind: "limit", wait: true });
    expect(isWait(busy)).toBe(true);
    const daily = problemFromError({ status: 429, code: "QUOTA_EXCEEDED", userMessage: "5 final renders per day.", details: { quota: "finalRendersPerDay" } });
    expect(daily).toMatchObject({ kind: "limit", wait: false });
    expect(isWait(daily)).toBe(false);
    expect(problemFromError({ status: 409, code: "APPROVAL_REQUIRED", userMessage: "x", details: { reason: "brand_review_blocked", requiresOverride: true, review: { blocking: [{ message: "Says “#1 timer” without proof" }] } } })).toEqual({
      kind: "brand",
      message: "Says “#1 timer” without proof",
      canOverride: true,
    });
    expect(problemFromError({ status: 422, code: "VALIDATION_FAILED", userMessage: "Fix the flagged issues before the final render.", details: { issues: [{ message: "Scene 2: unconfirmed claim" }] } })).toEqual({ kind: "fix", message: "Fix the flagged issues before the final render. Scene 2: unconfirmed claim" });
    expect(isWait(problemFromError({ status: 409, code: "CONFLICT", userMessage: "The brand check is still running.", details: { reason: "brand_review_running" } }))).toBe(true);
    expect(isWait(problemFromError({ status: 0, code: "NETWORK" }))).toBe(true);
    expect(problemFromError({ status: 500, code: "INTERNAL" }).kind).toBe("busy");
    expect(problemFromError({ status: 403, code: "FORBIDDEN", userMessage: "No." })).toEqual({ kind: "error", message: "No." });
  });

  it("asks before a final video that costs more than shown", () => {
    expect(overspend(24, 16)).toEqual({ credits: 24, shown: 16 });
    expect(overspend(16, 16)).toBeNull();
    expect(overspend(8, 16)).toBeNull();
    expect(overspend(24, null)).toBeNull();
  });
});

describe("Create: your content", () => {
  const a = (id: string, comp: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ id, kind: "video", role: "render", status: "ready", createdAt, campaignId: "cmp_1", posterAssetId: `${id}_poster`, durationSec: 20, title: "Calm focus — v1 final", render: { compositionId: comp, version: 1, quality: "final" }, ...extra }) as never;
  it("shows the newest finished video per composition, newest first, with its title", () => {
    const out = finishedVideos([a("r1", "c1", at(1)), a("r2", "c2", at(5)), a("r3", "c1", at(9)), a("p1", "c3", at(10), { render: { compositionId: "c3", version: 1, quality: "preview" } }), a("x", "c4", at(11), { status: "processing" })], new Map([["c2", "One tap to deep work"]]));
    expect(out.map((v) => [v.compositionId, v.assetId, v.title])).toEqual([
      ["c1", "r3", "Calm focus"],
      ["c2", "r2", "One tap to deep work"],
    ]);
    expect(out[0]).toMatchObject({ posterAssetId: "r3_poster", durationSec: 20, campaignId: "cmp_1" });
  });
});
