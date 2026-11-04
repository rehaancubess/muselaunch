import type { TodayPost } from "../api/types";
import { canSchedule, clock, homeHeadline, postBody, postState, postTimeLine, postTitle, rowState, shortWhen, whenInSentence, whenLabel } from "./home-lines";
import { copiedLine, postLinkProblem, shareLabel, shareMode, videoFileName } from "./share";

const post = (over: Partial<TodayPost> = {}): TodayPost => ({
  id: "pst_1",
  channel: "instagram",
  mode: "manual",
  status: "awaiting_approval",
  caption: "One tap to deep work\nStart a focused session in one tap.",
  copyText: "One tap to deep work",
  timezone: "UTC",
  account: null,
  video: { assetId: "ast_v", posterAssetId: "ast_p", kind: "video", durationSec: 20 },
  decision: { id: "apr_1", kind: "post", action: "publish", title: "Post", summary: "", createdAt: "2026-01-01T00:00:00Z", requiredCap: "publish", canDecide: true, stale: false, approve: { path: "/approvals/apr_1/decide", body: {} }, reject: { path: "/approvals/apr_1/decide", body: {} } },
  change: null,
  canChange: true,
  ...over,
});

describe("Home's headline", () => {
  it("counts what really waits", () => {
    expect(homeHeadline([])).toMatchObject({ title: "You’re all caught up", caughtUp: true });
    expect(homeHeadline([{ status: "awaiting_approval", waiting: true, changing: false }, { status: "awaiting_approval", waiting: true, changing: false }]).sub).toBe("2 posts to review");
    expect(homeHeadline([{ status: "manual_post_needed", waiting: false, changing: false }]).sub).toBe("1 post ready for you to post");
    expect(homeHeadline([{ status: "draft", waiting: false, changing: true }]).title).toBe("Muse is updating your post");
    expect(homeHeadline([{ status: "draft", waiting: false, changing: false }])).toMatchObject({ title: "A post needs a look", sub: "1 post not ready to schedule yet" });
  });
});

describe("times", () => {
  const now = Date.parse("2026-01-22T15:00:00Z");
  it("says today / tomorrow / the date, in the workspace's time zone", () => {
    expect(whenLabel("2026-01-22T19:00:00Z", "UTC", now)).toBe("Today at 7:00 PM");
    expect(whenLabel("2026-01-23T10:00:00Z", "UTC", now)).toBe("Tomorrow at 10:00 AM");
    expect(whenLabel("2026-01-27T10:00:00Z", "UTC", now)).toBe("Tue, Jan 27 at 10:00 AM");
    // 01:00 UTC on the 23rd is still the 22nd in New York.
    expect(whenLabel("2026-01-23T01:00:00Z", "America/New_York", now)).toBe("Today at 8:00 PM");
    expect(whenInSentence("2026-01-23T10:00:00Z", "UTC", now)).toBe("tomorrow at 10:00 AM");
    expect(shortWhen("2026-01-23T10:00:00Z", "UTC")).toBe("Jan 23, 10:00 AM");
  });

  it("calls a suggestion a suggestion, and invents no time", () => {
    expect(postTimeLine({ scheduledAt: "2026-01-23T10:00:00Z", timeBasis: "suggested" }, "UTC", now)).toBe("Suggested time: Tomorrow at 10:00 AM");
    expect(postTimeLine({ scheduledAt: "2026-01-23T10:00:00Z", timeBasis: "your_results" }, "UTC", now)).toBe("Suggested time: Tomorrow at 10:00 AM · based on your results");
    expect(postTimeLine({}, "UTC", now)).toBe("No time set yet");
    expect(clock(20)).toBe("0:20");
    expect(clock(65.4)).toBe("1:05");
  });
});

describe("a post's words and state", () => {
  it("uses the caption's first line as the title when there's none", () => {
    expect(postTitle(post())).toBe("One tap to deep work");
    expect(postBody(post())).toBe("Start a focused session in one tap.");
    expect(postTitle(post({ title: "Focus" }))).toBe("Focus");
    expect(postBody(post({ title: "Focus" }))).toBe(post().caption);
  });

  it("can be scheduled only with a fresh decision the person may take", () => {
    expect(canSchedule(post())).toBe(true);
    expect(canSchedule(post({ decision: { ...post().decision!, stale: true } }))).toBe(false);
    expect(canSchedule(post({ decision: { ...post().decision!, canDecide: false } }))).toBe(false);
    expect(canSchedule(post({ change: { id: "c", part: "video", instruction: "x", status: "editing", jobId: "j", startedAt: "" } }))).toBe(false);
    expect(postState(post({ decision: { ...post().decision!, canDecide: false } }))?.text).toBe("Waiting for approval");
    expect(postState(post({ decision: null, status: "manual_post_needed" }))?.text).toBe("Ready for you to post");
    expect(rowState(post())).toBe("Waiting for your OK");
  });
});

describe("posting it yourself", () => {
  it("shares only approved posts with a video, and marks only the ones you post yourself", () => {
    expect(shareMode(post())).toBeNull();
    expect(shareMode(post({ status: "manual_post_needed" }))).toBe("manual");
    expect(shareMode(post({ status: "scheduled", mode: "api" }))).toBe("scheduled");
    expect(shareMode(post({ status: "manual_post_needed", video: null }))).toBeNull();
    expect(shareLabel("instagram")).toBe("Share to Instagram…");
    expect(shareLabel("tiktok")).toBe("Share to TikTok…");
    expect(shareLabel("linkedin")).toBe("Share…");
    expect(copiedLine("instagram")).toBe("Caption copied — paste it in Instagram");
  });

  it("names the file after the post", () => {
    expect(videoFileName("One tap to deep work!", "pst_01ABCDEF")).toBe("one-tap-to-deep-work-abcdef.mp4");
    expect(videoFileName("   ", "pst_01ABCDEF", "mov")).toBe("muselaunch-video-abcdef.mov");
  });

  it("checks the pasted link is a post on that site (the API checks again)", () => {
    expect(postLinkProblem("instagram", "https://www.instagram.com/reel/abc")).toBeNull();
    expect(postLinkProblem("tiktok", "https://vm.tiktok.com/xyz")).toBeNull();
    expect(postLinkProblem("instagram", "https://www.tiktok.com/@me/video/1")).toBe("That isn’t an Instagram link. Paste the link of the Instagram post.");
    expect(postLinkProblem("instagram", "instagram.com/reel/abc")).toMatch(/https/);
    expect(postLinkProblem("newsletter", "https://example.com/issue-3")).toBeNull();
  });
});
