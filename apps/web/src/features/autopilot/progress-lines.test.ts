import { describe, expect, it } from "vitest";
import { doingLine, makeLine, showRecordingFirst } from "./progress-lines";

describe("progress screen wording (progress-lines.ts)", () => {
  it("the make step says what the videos are really built from", () => {
    expect(makeLine({ screenshots: 0, recordings: 1, ask: null })).toBe("Writing a plan for each video and building it from your recording");
    expect(makeLine({ screenshots: 4, recordings: 0, ask: null })).toBe("Writing a plan for each video and building it from your screenshots");
    expect(makeLine({ screenshots: 4, recordings: 1, ask: null })).toBe("Writing a plan for each video and building it from your recording and screenshots");
    expect(makeLine({ screenshots: 2, recordings: 2, ask: null })).toBe("Writing a plan for each video and building it from your recordings and screenshots");
    // Nothing yet, or an older API without the counts: no claim about what it's built from.
    expect(makeLine({ screenshots: 0, recordings: 0, ask: "waiting" })).toBe("Writing a plan for each video");
    expect(makeLine(undefined)).toBe("Writing a plan for each video and building it");
  });

  it("reading and learning name where the app came from (a website has no listing or screenshots)", () => {
    expect(doingLine("read", "website", undefined)).toBe("Reading the page");
    expect(doingLine("learn", "website", undefined)).toBe("Working out features, audiences and facts from your website");
    expect(doingLine("read", "app_store", undefined)).toBe("Saving the listing and its screenshots");
    expect(doingLine("learn", "google_play", undefined)).toBe("Working out features, audiences and facts from the listing");
    expect(doingLine("make", "website", { screenshots: 0, recordings: 1, ask: null })).toMatch(/from your recording$/);
  });

  it("asks for a screen recording early, keeps the card after an upload, and hands over to the decision card", () => {
    const base = { shownBefore: false, status: "running" as const, videosBuilt: 0 };
    expect(showRecordingFirst({ ...base, ask: "early" })).toBe(true);
    expect(showRecordingFirst({ ...base, ask: null })).toBe(false);
    expect(showRecordingFirst({ ...base, ask: undefined })).toBe(false);
    // After an upload the server stops asking; the card stays (now saying the recording is in).
    expect(showRecordingFirst({ ...base, ask: null, shownBefore: true })).toBe(true);
    // Waiting on the decision: the Needs-you card carries the upload instead.
    expect(showRecordingFirst({ ...base, ask: "waiting", shownBefore: true })).toBe(false);
    // Videos exist, or the run ended: nothing to ask.
    expect(showRecordingFirst({ ...base, ask: null, shownBefore: true, videosBuilt: 2 })).toBe(false);
    expect(showRecordingFirst({ ...base, ask: "early", status: "failed" })).toBe(false);
    expect(showRecordingFirst({ ...base, ask: "early", status: "awaiting_user" })).toBe(true);
  });
});
