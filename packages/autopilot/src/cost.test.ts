import type { Autopilot, ModelUsageEvent } from "@muselaunch/contracts";
import { MemoryDb } from "@muselaunch/db";
import { describe, expect, it } from "vitest";
import { runCost, summarizeCost } from "./cost";

const now = new Date().toISOString();

function seed() {
  const ws = new MemoryDb().ws("ws1");
  const job = (id: string, type: string, extra: Record<string, unknown> = {}) =>
    ws.collection("jobs").createIfAbsent({ id, type, appId: "app1", status: "succeeded", idempotencyKey: id, payload: {}, queuedAt: now, ...extra } as never, { actor: "t" });
  let n = 0;
  const usage = (u: Partial<ModelUsageEvent> & Pick<ModelUsageEvent, "provider" | "model" | "costUsdEstimate">) =>
    ws.collection("modelUsage").createIfAbsent({ id: `use_${++n}`, operation: "responses", task: "t", runtimeMs: 10, status: "ok", dataMode: "standard", appId: "app1", ...u } as never, { actor: "t" });
  return { ws, job, usage };
}

const log = (jobIds: string[]): Autopilot["log"] => jobIds.map((id) => ({ at: now, stage: "research", kind: "action", summary: "Delegated", refs: [{ entity: "jobs", id }] }));

describe("summarizeCost (pure)", () => {
  it("adds every call once, counts failed calls and groups by model, most expensive first", () => {
    const c = summarizeCost(
      [
        { id: "u1", provider: "meta", model: "muse-spark-1.3", operation: "responses", costUsdEstimate: 0.5, status: "ok" },
        { id: "u2", provider: "meta", model: "muse-wonder-1.0", operation: "responses", costUsdEstimate: 0.04, status: "ok" },
        { id: "u2", provider: "meta", model: "muse-wonder-1.0", operation: "responses", costUsdEstimate: 0.04, status: "ok" },
        { id: "u3", provider: "meta", model: "muse-spark-1.3", operation: "responses", costUsdEstimate: 0.12345, status: "error" },
        { id: "u4", provider: "web", model: "fetch", operation: "http", costUsdEstimate: 0, status: "ok" },
      ],
      { jobs: 2, complete: true },
    );
    expect(c).toMatchObject({ usd: 0.6635, calls: 4, failed: 1, jobs: 2, complete: true });
    expect(c.byModel).toEqual([
      { name: "Muse Spark", usd: 0.6235, calls: 2 },
      { name: "Muse Wonder", usd: 0.04, calls: 1 },
      { name: "Web pages", usd: 0, calls: 1 },
    ]);
  });
});

describe("runCost (a run's model cost from usage records)", () => {
  it("counts the loop's own Wonder decisions AND every job it started with their follow-ups, nothing else", async () => {
    const { ws, job, usage } = seed();
    await job("job_research", "research.run");
    await job("job_story", "storyboard.generate");
    await job("job_build", "composition.build", { parentJobId: "job_story" });
    await job("job_preview", "render.preview", { parentJobId: "job_build" });
    await job("job_step", "autopilot.step", { parentJobId: "job_story" });
    await job("job_other", "app.analyze");

    await usage({ provider: "meta", model: "muse-wonder-1.0", costUsdEstimate: 0.03, jobId: "job_step_1", agentRunId: "run_audience" });
    await usage({ provider: "meta", model: "muse-wonder-1.0", costUsdEstimate: 0.059, jobId: "job_step_2", agentRunId: "run_pick" });
    await usage({ provider: "meta", model: "muse-wonder-1.0", costUsdEstimate: 0.4, jobId: "job_research", agentRunId: "run_research" });
    await usage({ provider: "meta", model: "muse-spark-1.3", costUsdEstimate: 0.2, jobId: "job_story", agentRunId: "run_story" });
    await usage({ provider: "glimmer", model: "muse-glimmer", costUsdEstimate: 0, jobId: "job_story" });
    await usage({ provider: "meta", model: "sam-3.1", operation: "segmentation", costUsdEstimate: 0.05, jobId: "job_preview" });
    // Not this run: another job of the app, an autopilot.step chained under a job, an unrelated run.
    await usage({ provider: "meta", model: "muse-spark-1.3", costUsdEstimate: 9, jobId: "job_other" });
    await usage({ provider: "meta", model: "muse-spark-1.3", costUsdEstimate: 7, jobId: "job_step" });
    await usage({ provider: "meta", model: "muse-wonder-1.0", costUsdEstimate: 5, agentRunId: "run_elsewhere" });

    const cost = await runCost(ws, { appId: "app1", log: log(["job_research", "job_story"]), agentRunIds: ["run_audience", "run_pick"] });
    // The old figure (Autopilot.spent.usd) was only the Wonder decisions: 0.089.
    expect(cost.usd).toBe(0.739);
    expect(cost).toMatchObject({ calls: 6, failed: 0, jobs: 4, complete: true });
    expect(cost.byModel.map((m) => m.name)).toEqual(["Muse Wonder", "Muse Spark", "SAM 3.1", "Muse Glimmer"]);
    expect(cost.byModel[0]).toEqual({ name: "Muse Wonder", usd: 0.489, calls: 3 });
  });

  it("a run that started nothing yet costs only its decisions", async () => {
    const { ws, usage } = seed();
    await usage({ provider: "meta", model: "muse-wonder-1.0", costUsdEstimate: 0.02, agentRunId: "run_a" });
    expect(await runCost(ws, { appId: "app1", log: [], agentRunIds: ["run_a"] })).toMatchObject({ usd: 0.02, calls: 1, jobs: 0, complete: true });
    expect(await runCost(ws, { appId: "app1", log: [], agentRunIds: [] })).toMatchObject({ usd: 0, calls: 0, complete: true, byModel: [] });
  });

  it("looks up more than 30 jobs (Firestore `in` limit) in chunks", async () => {
    const { ws, job, usage } = seed();
    const ids = Array.from({ length: 65 }, (_, i) => `job_${String(i).padStart(2, "0")}`);
    for (const id of ids) {
      await job(id, "brand.review");
      await usage({ provider: "meta", model: "muse-spark-1.3", costUsdEstimate: 0.01, jobId: id });
    }
    const cost = await runCost(ws, { appId: "app1", log: log(ids), agentRunIds: [] });
    expect(cost).toMatchObject({ usd: 0.65, calls: 65, jobs: 65, complete: true });
  });
});
