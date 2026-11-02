import type { Autopilot } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { mediaAsk } from "./progress";

type Ap = Pick<Autopilot, "status" | "stage" | "waitingOn" | "compositionIds">;
const ap = (over: Partial<Ap> = {}): Ap => ({ status: "running", stage: "research", waitingOn: { jobIds: [] }, compositionIds: [], ...over });
const none = { screenshots: 0, recordings: 0 };
const read = { importDone: true };

describe("mediaAsk (when the progress screen asks for a screen recording)", () => {
  it("asks early when an app added from its website has no screenshots or recordings, before videos are made", () => {
    expect(mediaAsk(ap(), none, read)).toBe("early");
    expect(mediaAsk(ap({ stage: "understand" }), none, read)).toBe("early");
    expect(mediaAsk(ap({ stage: "plan_creative", status: "waiting_on_jobs" }), none, read)).toBe("early");
    // A different decision (e.g. spending) or a pause doesn't hide it.
    expect(mediaAsk(ap({ status: "awaiting_user", waitingOn: { jobIds: [], reason: "[budget@enter] Approve spending" } }), none, read)).toBe("early");
    expect(mediaAsk(ap({ status: "paused" }), none, read)).toBe("early");
  });

  it("doesn't ask while the link is still being read (a store listing's screenshots may be on their way)", () => {
    expect(mediaAsk(ap({ stage: "understand" }), none, { importDone: false })).toBeNull();
  });

  it("doesn't ask once there is real footage, videos exist, or the run has ended", () => {
    expect(mediaAsk(ap(), { screenshots: 3, recordings: 0 }, read)).toBeNull();
    expect(mediaAsk(ap(), { screenshots: 0, recordings: 1 }, read)).toBeNull();
    expect(mediaAsk(ap({ stage: "produce", compositionIds: ["cmp_1"] }), none, read)).toBeNull();
    expect(mediaAsk(ap({ stage: "verify" }), none, read)).toBeNull();
    for (const status of ["completed", "failed", "cancelled", "sleeping"] as const) expect(mediaAsk(ap({ status }), none, read)).toBeNull();
  });

  it("is 'waiting' while the run is stopped at the produce:media decision, even after footage was added (Continue is next)", () => {
    const waiting = ap({ status: "awaiting_user", stage: "produce", waitingOn: { jobIds: [], approvalId: "apr_1", reason: "[produce:media] Add a screen recording or screenshots of your app" } });
    expect(mediaAsk(waiting, none, read)).toBe("waiting");
    expect(mediaAsk(waiting, { screenshots: 0, recordings: 1 }, read)).toBe("waiting");
    // The same tag on a job wait (finding b-roll) is not a decision.
    expect(mediaAsk(ap({ status: "waiting_on_jobs", stage: "produce", compositionIds: [], waitingOn: { jobIds: ["j"], reason: "[produce:media] Finding lifestyle b-roll for 2 video(s)" } }), { screenshots: 2, recordings: 0 }, read)).toBeNull();
  });
});
