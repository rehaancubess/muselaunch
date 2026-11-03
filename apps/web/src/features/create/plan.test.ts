import { describe, expect, it } from "vitest";
import {
  aspectClass,
  aspectOf,
  campaignRequest,
  channelFor,
  channelsFor,
  defaultWhere,
  finishedContent,
  finishedStills,
  finishedTexts,
  generateLabel,
  makeLabel,
  readMake,
  screensHint,
  slideOptions,
  stageLabel,
  stepsFor,
  stillFinalCredits,
  stillsBadge,
  textCount,
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
    const none = { make: null, store: null };
    expect(q("kind=feature&prompt=Show%20how%20Focus%20Mode%20works")).toEqual({ kind: "feature", prompt: "Show how Focus Mode works", ideaId: null, runId: null, ...none });
    expect(q("idea=opp_1")).toEqual({ kind: "idea", prompt: "", ideaId: "opp_1", runId: null, ...none });
    expect(q("kind=promote&idea=opp_1")).toEqual({ kind: "promote", prompt: "", ideaId: null, runId: null, ...none });
    expect(q("kind=hack")).toEqual({ kind: null, prompt: "", ideaId: null, runId: null, ...none });
    expect(q("").kind).toBeNull();
    // Needs you → Open it: the run to show.
    expect(q("run=cpg_123").runId).toBe("cpg_123");
    expect(q("run=%3Cscript%3E").runId).toBeNull();
    // ?make= picks what to make (store sets default to the App Store).
    expect(q("make=carousel&kind=feature")).toMatchObject({ kind: "feature", make: "carousel", store: null });
    expect(q("make=store_screenshots")).toMatchObject({ make: "store_screenshots", store: "ios" });
    expect(q("make=store_screenshots&store=android")).toMatchObject({ make: "store_screenshots", store: "android" });
    expect(q("make=google-play-screenshots")).toMatchObject({ make: "store_screenshots", store: "android" });
    expect(q("make=text")).toMatchObject({ make: "text_post" });
    expect(q("make=hologram")).toMatchObject({ make: null, store: null });
    expect(q("make=post&store=android")).toMatchObject({ make: "post", store: null });
    expect(readMake(" Thumbnail ")).toEqual({ make: "thumbnail", store: null });
  });
});

describe("Create: format, length and the request", () => {
  it("maps formats to aspect ratios and channels, defaulting to where the person posts", () => {
    expect(formatById("tiktok")).toMatchObject({ channel: "tiktok", aspectRatio: "9:16" });
    // The 1:1 video keeps its old id (links) and is called what it is.
    expect(formatById("square_post")).toMatchObject({ aspectRatio: "1:1", label: "Square video" });
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

  it("asks for a post, a carousel, a thumbnail, a store set or a text post with the right deliverable", () => {
    const base = { kind: "promote" as const, prompt: "Promote Tidy Timer", format: formatById("tiktok"), lengthSec: 20 };
    // Video: unchanged (no `make` = video, as before stills).
    expect(campaignRequest({ ...base, make: "video" }).deliverables).toEqual([{ kind: "short_video", channel: "tiktok", aspectRatio: "9:16", durationSec: 20, count: 1 }]);
    // Post: a static ad where it goes, portrait 4:5 unless square was picked.
    expect(campaignRequest({ ...base, make: "post", channel: "linkedin" })).toMatchObject({ channels: ["linkedin"], deliverables: [{ kind: "static_ad", channel: "linkedin", aspectRatio: "4:5", count: 1 }] });
    expect(campaignRequest({ ...base, make: "post", channel: "instagram", shape: "1:1" }).deliverables[0]).toMatchObject({ aspectRatio: "1:1" });
    // Carousel: slides clamped to 3–10 (Instagram takes at most 10).
    expect(campaignRequest({ ...base, make: "carousel", channel: "instagram", slides: 6 }).deliverables).toEqual([{ kind: "carousel", channel: "instagram", aspectRatio: "4:5", slides: 6, count: 1 }]);
    expect(campaignRequest({ ...base, make: "carousel", slides: 14 }).deliverables[0]).toMatchObject({ slides: 10, channel: "instagram" });
    expect(campaignRequest({ ...base, make: "carousel", slides: 1, shape: "1:1" }).deliverables[0]).toMatchObject({ slides: 3, aspectRatio: "1:1" });
    // Thumbnail: YouTube, 16:9.
    expect(campaignRequest({ ...base, make: "thumbnail" })).toMatchObject({ channels: ["youtube"], deliverables: [{ kind: "thumbnail", channel: "youtube", aspectRatio: "16:9", count: 1 }] });
    // Store sets: the store's frame and slide limit (App Store 3–10 at 9:19.5; Google Play 3–8 at 9:16).
    expect(campaignRequest({ ...base, make: "store_screenshots", store: "ios", slides: 10 }).deliverables).toEqual([{ kind: "store_screenshots", channel: "app_store", aspectRatio: "9:19.5", slides: 10, store: "ios", count: 1 }]);
    expect(campaignRequest({ ...base, make: "store_screenshots", store: "android", slides: 10 }).deliverables).toEqual([{ kind: "store_screenshots", channel: "google_play", aspectRatio: "9:16", slides: 8, store: "android", count: 1 }]);
    expect(campaignRequest({ ...base, make: "store_screenshots" }).deliverables[0]).toMatchObject({ store: "ios", slides: 6 });
    // Text post: where it goes, no frame; a channel that can't take text alone falls back to X.
    expect(campaignRequest({ ...base, make: "text_post", channel: "threads" })).toMatchObject({ channels: ["threads"], deliverables: [{ kind: "text_post", channel: "threads", count: 1 }] });
    expect(campaignRequest({ ...base, make: "text_post", channel: "tiktok" }).deliverables[0]).toEqual({ kind: "text_post", channel: "x", count: 1 });
    // The idea is linked the same way for every format.
    expect(campaignRequest({ ...base, kind: "idea", make: "carousel", ideaId: "opp_3" })).toMatchObject({ opportunityIds: ["opp_3"], goal: "awareness", origin: "create" });
  });

  it("names the choice, the button and where each format can go", () => {
    expect(generateLabel("video")).toBe("Generate video");
    expect(generateLabel("carousel")).toBe("Generate carousel");
    expect(generateLabel("post")).toBe("Generate post");
    expect(generateLabel("thumbnail")).toBe("Generate thumbnail");
    expect(generateLabel("store_screenshots")).toBe("Generate screenshots");
    expect(generateLabel("text_post")).toBe("Generate post");
    expect(makeLabel("store_screenshots", "android")).toBe("Google Play screenshots");
    expect(makeLabel("store_screenshots")).toBe("App Store screenshots");
    expect(channelsFor("post")).toEqual(["instagram", "facebook", "linkedin", "x", "threads"]);
    expect(channelsFor("carousel")).toEqual(["instagram", "linkedin", "facebook", "threads"]);
    expect(channelsFor("text_post")).toEqual(["x", "threads", "linkedin", "reddit", "facebook"]);
    expect(defaultWhere("carousel", ["tiktok", "linkedin"])).toBe("linkedin");
    expect(defaultWhere("text_post", ["instagram", "x"])).toBe("x");
    expect(defaultWhere("post", [])).toBe("instagram");
    expect(slideOptions("carousel")).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(slideOptions("store_screenshots", "android")).toEqual([3, 4, 5, 6, 7, 8]);
    expect(slideOptions("post")).toEqual([]);
  });

  it("says when the app has fewer real screens than store slides", () => {
    expect(screensHint(6, 6)).toBeNull();
    expect(screensHint(3, 6)).toBe("You have 3 real screenshots, so some of the 6 slides will show the same screen. Store slides only show real screens; add more for variety.");
    expect(screensHint(1, 4)).toMatch(/^You have 1 real screenshot,/);
    expect(screensHint(0, 6)).toMatch(/no real screenshots/);
  });

  it("estimates stills by slides and text posts by the writing (the operations their jobs reserve)", () => {
    const car = estimateSteps(20, { make: "carousel", slides: 6, aiVoice: true });
    expect(car.map((s) => [s.operation, s.params, s.amount])).toEqual([
      ["campaign.generate_concepts", {}, undefined],
      ["storyboard.generate", { format: "carousel", slides: 6 }, undefined],
      ["composition.build", {}, undefined],
      // Still finals hold one credit per started 4 slides (the server's render route and runner).
      ["render.final", { format: "carousel", slides: 6 }, 2],
    ]);
    expect(car.map((s) => s.label)).toEqual(["Writing the idea (Muse Spark)", "Planning 6 slides (Muse Spark)", "Making the editable slides", "Final images (6 slides)"]);
    expect(estimateSteps(20, { make: "store_screenshots", slides: 10, store: "android" })[1]!.params).toEqual({ format: "store_screenshots", slides: 8, store: "android" });
    expect(estimateSteps(20, { make: "store_screenshots", slides: 10 }).at(-1)!.amount).toBe(3);
    expect(estimateSteps(20, { make: "post" }).map((s) => s.label)).toEqual(["Writing the idea (Muse Spark)", "Planning the image (Muse Spark)", "Making the editable image", "Final image"]);
    expect(estimateSteps(20, { make: "thumbnail" }).at(-1)!.amount).toBe(1);
    expect(estimateSteps(20, { make: "text_post", aiVoice: true }).map((s) => s.operation)).toEqual(["campaign.generate_concepts", "copy.generate"]);
    expect([1, 4, 5, 8, 10].map(stillFinalCredits)).toEqual([1, 1, 2, 2, 3]);
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

  it("names the steps for what the run makes", () => {
    expect(stepsFor("video").map((s) => s.label)).toEqual(["Writing the idea", "Planning the video", "Making it", "Checking facts and brand", "Finishing"]);
    expect(stepsFor("carousel").map((s) => s.label)).toEqual(["Writing the idea", "Planning the slides", "Making the carousel", "Checking facts and brand", "Finishing"]);
    expect(stepsFor("store_screenshots").map((s) => s.label)).toEqual(["Writing the idea", "Planning the slides", "Making the screenshots", "Checking facts and brand", "Finishing"]);
    expect(stepsFor("post").map((s) => s.label)[1]).toBe("Planning the image");
    expect(stepsFor("text_post").map((s) => s.label)).toEqual(["Writing the idea", "Writing the post", "Checking facts"]);
    expect(stageLabel("carousel", "make")).toBe("Making the carousel");
    expect(stageLabel("text_post", "plan")).toBe("Writing the post");
    // A text post has no make/finish step of its own: those count as its nearest step.
    expect(stageLabel("text_post", "finish")).toBe("Checking facts");
    const text = stepsFor("text_post");
    expect(text.map((s) => stepState({ stage: "check", status: "working" }, s.key, text))).toEqual(["done", "done", "current"]);
    expect(text.map((s) => stepState({ stage: "make", status: "failed" }, s.key, text))).toEqual(["done", "failed", "todo"]);
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

describe("Create: your content (stills and text posts)", () => {
  const img = (id: string, comp: string, createdAt: string, slide: number, extra: Record<string, unknown> = {}) =>
    ({ id, kind: "image", role: "render", status: "ready", createdAt, campaignId: "cmp_1", width: 1080, height: 1350, title: `Calm focus — slide ${slide}`, labels: [`slide:${slide}`], render: { compositionId: comp, version: 1, quality: "final" }, ...extra }) as never;
  it("gathers each final still render's slides in order, newest set per composition", () => {
    const older = ["ast_r_aaa", "ast_r_aaa_2", "ast_r_aaa_3"].map((id, i) => img(id, "c1", at(1), i + 1, { render: { compositionId: "c1", version: 1, quality: "final" } }));
    const newer = ["ast_r_bbb_3", "ast_r_bbb", "ast_r_bbb_2"].map((id) => img(id, "c1", at(5), id === "ast_r_bbb" ? 1 : Number(id.slice(-1)), { render: { compositionId: "c1", version: 2, quality: "final" } }));
    const thumb = img("ast_r_ccc", "c2", at(3), 1, { width: 1280, height: 720 });
    const preview = img("ast_r_ddd", "c3", at(9), 1, { role: "preview", render: { compositionId: "c3", version: 1, quality: "preview" } });
    const out = finishedStills([...older, ...newer, thumb, preview], new Map([["c2", "Thumbnail for launch"]]));
    expect(out.map((s) => [s.compositionId, s.assetIds, s.title, s.version])).toEqual([
      ["c1", ["ast_r_bbb", "ast_r_bbb_2", "ast_r_bbb_3"], "Calm focus", 2],
      ["c2", ["ast_r_ccc"], "Thumbnail for launch", 1],
    ]);
    // Videos are not stills.
    expect(finishedStills([{ ...(img("v1", "c9", at(1), 1) as object), kind: "video" } as never])).toEqual([]);
  });

  it("badges a tile by what it is and gives every frame its shape", () => {
    expect(stillsBadge({ assetIds: ["a", "b", "c", "d", "e", "f"], width: 1080, height: 1350 })).toBe("Carousel · 6");
    expect(stillsBadge({ assetIds: ["a", "b", "c"], width: 1290, height: 2796 })).toBe("Screenshots · 3");
    expect(stillsBadge({ assetIds: ["a"], width: 1280, height: 720 })).toBe("Thumbnail");
    expect(stillsBadge({ assetIds: ["a"], width: 1080, height: 1350 })).toBe("Post");
    expect(aspectOf(1290, 2796)).toBe("9:19.5");
    expect(aspectOf(1080, 1350)).toBe("4:5");
    expect(aspectOf(1080, 1920)).toBe("9:16");
    expect(aspectOf(undefined, 10)).toBeNull();
    expect(["9:19.5", "4:5", "1:1", "16:9", "9:16", undefined].map((ar) => aspectClass(ar))).toEqual(["aspect-[1290/2796]", "aspect-[4/5]", "aspect-square", "aspect-video", "aspect-[9/16]", "aspect-[9/16]"]);
  });

  it("lists text posts from done runs and mixes everything newest first, capped", () => {
    const run = (id: string, createdAt: string, text: unknown, status = "done") => ({ campaignId: id, status, text, ideaTitle: undefined, name: `Run ${id}`, createdAt }) as never;
    const texts = finishedTexts([run("t1", at(4), { copyPackId: "cp1", channel: "x", text: "Focus, sorted.", ok: true }), run("t2", at(6), null), run("t3", at(7), { copyPackId: "cp3", channel: "x", text: "…", ok: true }, "working")]);
    expect(texts).toEqual([{ campaignId: "t1", copyPackId: "cp1", channel: "x", text: "Focus, sorted.", ok: true, title: "Run t1", at: at(4) }]);
    const all = finishedContent(
      {
        videos: [{ compositionId: "v1", assetId: "r1", title: "Video", renderedAt: at(2) }],
        stills: [{ compositionId: "s1", assetIds: ["a"], title: "Carousel", renderedAt: at(8) }],
        texts,
      },
      2,
    );
    expect(all.map((c) => c.type)).toEqual(["stills", "text"]);
  });

  it("counts a text post the way its channel does", () => {
    expect(textCount("Hello", "threads")).toEqual({ used: 5, limit: 500, over: false });
    // X: a link counts as 23, wide characters as 2.
    expect(textCount("Try it https://tidy.example.com/r/abc 集中", "x")).toEqual({ used: 7 + 23 + 1 + 4, limit: 280, over: false });
    expect(textCount("x".repeat(281), "x").over).toBe(true);
    expect(textCount("Post", "linkedin").limit).toBe(3000);
    expect(textCount("Post", "instagram").limit).toBeNull();
    // The app's link (filled in when it's scheduled) counts as a link.
    expect(textCount("Try it: [APP_LINK]", "x").used).toBe(8 + 23);
    expect(textCount("Try it: [APP_LINK]", "threads").used).toBe(8 + 30);
  });
});
