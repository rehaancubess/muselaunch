import type { Campaign, Job } from "../api/types";
import { campaignRequest, clampLength, defaultFormat, estimateSteps, featurePrompt, formatById, ideaPrompt, lengthOptions, promotePrompt, runLine, runView, stepState, topIdeas } from "./plan";

const now = Date.parse("2026-11-03T12:00:00Z");
const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: "cmp_1",
  appId: "app_1",
  name: "Tidy Timer",
  goal: "awareness",
  status: "planning",
  channels: ["instagram"],
  deliverables: [{ kind: "short_video", channel: "instagram", aspectRatio: "9:16", durationSec: 20, count: 1 }],
  origin: "create",
  createdAt: "2026-11-03T11:50:00Z",
  ...over,
});
const job = (over: Partial<Job> & Pick<Job, "type">): Job => ({ id: `job_${Math.random().toString(36).slice(2, 8)}`, status: "running", payload: { campaignId: "cmp_1" }, progress: { pct: 50, stage: "writing" }, createdAt: "2026-11-03T11:51:00Z", ...over });

describe("Create's request", () => {
  it("is the web's campaign request for one video, marked origin create", () => {
    expect(campaignRequest({ kind: "feature", prompt: "  Show how Focus Mode blocks distractions. ", format: formatById("tiktok"), lengthSec: 30 })).toEqual({
      request: "Show how Focus Mode blocks distractions.",
      goal: "feature_announcement",
      channels: ["tiktok"],
      deliverables: [{ kind: "feature_promo", channel: "tiktok", aspectRatio: "9:16", durationSec: 30, count: 1 }],
      opportunityIds: [],
      conceptCount: 3,
      origin: "create",
    });
    expect(campaignRequest({ kind: "idea", prompt: "An idea worth a video.", format: formatById("square_post"), lengthSec: 15, ideaId: "opp_9" }).opportunityIds).toEqual(["opp_9"]);
  });

  it("suggests prompts from what's known about the app", () => {
    expect(promotePrompt("Tidy Timer: Focus & Pomodoro", { oneLiner: "Helps you focus in short sessions. More text." })).toBe("Introduce Tidy Timer, which helps you focus in short sessions.");
    expect(promotePrompt("Tidy Timer")).toBe("Introduce Tidy Timer and what makes it worth trying.");
    expect(featurePrompt({ name: "Focus Mode", description: "Blocks distracting apps while you work." })).toBe("Show how Focus Mode blocks distracting apps while you work.");
    expect(ideaPrompt({ title: "Desk setup tours", proposedAngle: "Show the timer on a real desk." })).toBe("Desk setup tours. Show the timer on a real desk.");
  });

  it("keeps lengths within the plan and formats from where the person posts", () => {
    expect(lengthOptions(30)).toEqual([15, 20, 30]);
    expect(clampLength(45, 30)).toBe(30);
    expect(defaultFormat(["youtube", "instagram"]).id).toBe("youtube_short");
    expect(estimateSteps(20, { aiVoice: true }).map((s) => s.operation)).toEqual(["campaign.generate_concepts", "storyboard.generate", "composition.build", "media.voiceover", "render.final"]);
  });

  it("only offers ideas that name a real source", () => {
    const base = { summary: "", sources: [], retrievedAt: "2026-11-01T00:00:00Z" };
    const items = [
      { ...base, id: "1", type: "opportunity" as const, refId: "o1", title: "No source" },
      { ...base, id: "2", type: "opportunity" as const, refId: "o2", title: "Sourced", sources: [{ url: "https://example.com/a", kind: "web" }] },
      { ...base, id: "3", type: "opportunity" as const, refId: "o3", title: "Model only", sources: [{ kind: "model_inference" }] },
      { ...base, id: "4", type: "finding" as const, refId: "f4", title: "A finding", sources: [{ url: "https://example.com/b" }] },
    ];
    expect(topIdeas(items).map((i) => i.title)).toEqual(["Sourced"]);
  });
});

describe("where a run stands (stored records only)", () => {
  it("writing the idea, with the job's own progress", () => {
    const v = runView({ campaign: campaign(), variants: [], compositions: [], jobs: [job({ type: "campaign.generate_concepts" })], finals: [], now });
    expect(v).toMatchObject({ step: "idea", working: true, pct: 10, detail: "writing" });
    expect(runLine(v)).toBe("Writing the idea · writing");
    expect(stepState(v, "idea")).toBe("current");
    expect(stepState(v, "finish")).toBe("todo");
  });

  it("says a failed job failed, in its own words", () => {
    const v = runView({ campaign: campaign(), variants: [], compositions: [], jobs: [job({ type: "campaign.generate_concepts", status: "failed", error: { userMessage: "Not enough credits." } })], finals: [], now });
    expect(v.failure).toMatchObject({ step: "idea", message: "Not enough credits.", retry: true });
    expect(runLine(v)).toBe("Not enough credits.");
  });

  it("an idea picked but not planned yet waits for the server (the phone takes no step)", () => {
    const v = runView({ campaign: campaign({ status: "ready" }), variants: [{ id: "var_1", title: "Focus in 20 seconds", status: "proposed" }], compositions: [], jobs: [], finals: [], now });
    expect(v).toMatchObject({ step: "plan", working: false, ideaTitle: "Focus in 20 seconds" });
    expect(v.next).toMatchObject({ kind: "produce", variantId: "var_1", aspectRatio: "9:16", targetDurationSec: 20 });
    expect(runLine(v)).toBe("Up next: planning the video");
  });

  it("done when a final render of its video is ready", () => {
    const v = runView({
      campaign: campaign({ status: "producing" }),
      variants: [{ id: "var_1", title: "Focus", status: "selected", compositionIds: ["cmp_v1"] }],
      compositions: [{ id: "cmp_v1", status: "rendered", currentVersion: 2, variantId: "var_1", createdAt: "2026-11-03T11:55:00Z" }],
      jobs: [],
      finals: [{ id: "ast_final", status: "ready", kind: "video", render: { compositionId: "cmp_v1", quality: "final", version: 2 } }],
      now,
    });
    expect(v).toMatchObject({ step: "done", pct: 100, finalAssetId: "ast_final" });
    expect(runLine(v)).toBe("Your video is ready");
  });

  it("a run left for over a day doesn't carry on by itself", () => {
    const v = runView({ campaign: campaign({ status: "ready", createdAt: "2026-11-01T00:00:00Z" }), variants: [{ id: "var_1", title: "Focus", status: "proposed" }], compositions: [], jobs: [], finals: [], now });
    expect(v).toMatchObject({ stale: true, next: null });
  });
});
