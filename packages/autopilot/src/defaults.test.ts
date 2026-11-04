import type { Job } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { screenJobsInFlight } from "./defaults";

type Ws = Parameters<typeof screenJobsInFlight>[0];
const ws = (jobs: Partial<Job>[]) => ({ collection: () => ({ list: async () => ({ items: jobs }) }) }) as unknown as Ws;

describe("screenJobsInFlight (what video planning waits for)", () => {
  it("waits for screenshot checks and for walkthrough recordings still being cut into clips", async () => {
    const jobs: Partial<Job>[] = [
      { id: "j1", type: "media.extract_ui", status: "running" },
      { id: "j2", type: "media.analyze_recording", status: "queued" },
      { id: "j3", type: "media.analyze_recording", status: "succeeded" },
      { id: "j4", type: "media.extract_ui", status: "failed" },
      { id: "j5", type: "storyboard.generate", status: "running" },
    ];
    expect((await screenJobsInFlight(ws(jobs), "app1")).map((j) => j.id)).toEqual(["j1", "j2"]);
  });
  it("doesn't wait when nothing is in flight", async () => {
    expect(await screenJobsInFlight(ws([{ id: "j3", type: "media.analyze_recording", status: "succeeded" }]), "app1")).toEqual([]);
  });
});
