import { describe, expect, it } from "vitest";
import { clock, homeHeadline, postTimeLine, shortWhen, whenInSentence, whenLabel } from "./home-lines";

const waiting = { status: "awaiting_approval", waiting: true, changing: false };
const yours = { status: "manual_post_needed", waiting: false, changing: false };
const changing = { status: "awaiting_approval", waiting: true, changing: true };

describe("homeHeadline", () => {
  it("counts the posts to review", () => {
    expect(homeHeadline([waiting, waiting])).toEqual({ title: "Your content is ready", sub: "2 posts to review", caughtUp: false });
    expect(homeHeadline([waiting]).sub).toBe("1 post to review");
  });

  it("names posts the person posts themselves and ones Muse is changing", () => {
    expect(homeHeadline([waiting, yours]).sub).toBe("1 post to review · 1 post ready for you to post");
    expect(homeHeadline([changing])).toMatchObject({ title: "Muse is updating your post", sub: "1 post being changed by Muse. It comes back here for your OK." });
  });

  it("doesn't call blocked drafts ready", () => {
    expect(homeHeadline([{ status: "draft", waiting: false, changing: false }])).toMatchObject({ title: "A post needs a look", caughtUp: false });
  });

  it("is all caught up with nothing waiting", () => {
    expect(homeHeadline([])).toMatchObject({ title: "You’re all caught up", caughtUp: true });
    expect(homeHeadline([], { working: true }).sub).toMatch(/Muse is working on your next posts/);
  });
});

describe("times", () => {
  const now = Date.parse("2026-01-22T15:00:00Z");
  it("says today, tomorrow or the date in the workspace's time zone", () => {
    expect(whenLabel("2026-01-22T19:00:00Z", "UTC", now)).toBe("Today at 7:00 PM");
    expect(whenLabel("2026-01-23T10:00:00Z", "UTC", now)).toBe("Tomorrow at 10:00 AM");
    expect(whenLabel("2026-01-27T10:00:00Z", "UTC", now)).toBe("Tue, Jan 27 at 10:00 AM");
    // 23:30 UTC on the 22nd is already the 23rd in Kolkata.
    expect(whenLabel("2026-01-22T23:30:00Z", "Asia/Kolkata", now)).toBe("Tomorrow at 5:00 AM");
    expect(whenLabel("2026-01-23T10:00:00Z", "Not/AZone", now)).toBe("Tomorrow at 10:00 AM");
  });

  it("fits a time into a sentence", () => {
    expect(whenInSentence("2026-01-23T10:00:00Z", "UTC", now)).toBe("tomorrow at 10:00 AM");
    expect(whenInSentence("2026-01-27T10:00:00Z", "UTC", now)).toBe("on Tue, Jan 27 at 10:00 AM");
  });

  it("keeps the stored reason for a time", () => {
    const at = "2026-01-23T10:00:00Z";
    expect(postTimeLine({ scheduledAt: at, timeBasis: "suggested" }, "UTC", now)).toBe("Suggested time: Tomorrow at 10:00 AM");
    expect(postTimeLine({ scheduledAt: at, timeBasis: "your_results" }, "UTC", now)).toBe("Suggested time: Tomorrow at 10:00 AM · based on your results");
    expect(postTimeLine({ scheduledAt: at, timeBasis: "your_youtube" }, "UTC", now)).toBe("Suggested time: Tomorrow at 10:00 AM · based on your YouTube views");
    expect(postTimeLine({ scheduledAt: at }, "UTC", now)).toBe("Tomorrow at 10:00 AM");
    expect(postTimeLine({}, "UTC", now)).toBe("No time set yet");
  });

  it("formats Coming up dates and video lengths", () => {
    expect(shortWhen("2026-01-23T10:00:00Z", "UTC")).toBe("Jan 23, 10:00 AM");
    expect(clock(20.4)).toBe("0:20");
    expect(clock(65)).toBe("1:05");
  });
});
