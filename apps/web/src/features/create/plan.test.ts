import { describe, expect, it } from "vitest";
import {
  campaignRequest,
  channelFor,
  clampLength,
  clock,
  defaultFormat,
  estimateSteps,
  featurePrompt,
  finishedVideos,
  formatById,
  hasRealFootage,
  ideaPrompt,
  isMoving,
  lengthOptions,
  needsPerson,
  promotePrompt,
  readPrefill,
  shortName,
  stepState,
  sumCredits,
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

  it("reads deep links (?kind=&prompt=&idea=&run=) and ignores anything else", () => {
    const q = (s: string) => {
      const p = new URLSearchParams(s);
      return readPrefill((k) => p.get(k));
    };
    expect(q("kind=feature&prompt=Show%20how%20Focus%20Mode%20works")).toEqual({ kind: "feature", prompt: "Show how Focus Mode works", ideaId: null, runId: null });
    expect(q("idea=opp_1")).toEqual({ kind: "idea", prompt: "", ideaId: "opp_1", runId: null });
    expect(q("kind=promote&idea=opp_1")).toEqual({ kind: "promote", prompt: "", ideaId: null, runId: null });
    expect(q("kind=hack")).toEqual({ kind: null, prompt: "", ideaId: null, runId: null });
    expect(q("").kind).toBeNull();
    // Needs you → Open it: the run to show.
    expect(q("run=cpg_123").runId).toBe("cpg_123");
    expect(q("run=%3Cscript%3E").runId).toBeNull();
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

describe("Create: showing a run (the server's read model)", () => {
  it("step states for the list", () => {
    expect(["idea", "plan", "make", "check", "finish"].map((x) => stepState({ stage: "make", status: "working" }, x as never))).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(stepState({ stage: "make", status: "failed" }, "make")).toBe("failed");
    expect(stepState({ stage: "check", status: "needs_you" }, "check")).toBe("current");
    expect(stepState({ stage: "done", status: "done" }, "finish")).toBe("done");
  });

  it("says whether it waits for the person or is still moving by itself", () => {
    expect((["needs_you", "failed", "stopped"] as const).every((status) => needsPerson({ status }))).toBe(true);
    expect((["working", "waiting", "done"] as const).some((status) => needsPerson({ status }))).toBe(false);
    expect(isMoving({ status: "waiting" })).toBe(true);
    expect(isMoving({ status: "needs_you" })).toBe(false);
    expect(channelFor({ format: { aspectRatio: "9:16", channel: "tiktok" } })).toBe("tiktok");
    expect(channelFor(null)).toBeUndefined();
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
