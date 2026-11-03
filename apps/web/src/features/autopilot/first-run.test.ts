import type { AutopilotProgressStep } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { currentStep, firstRunPhase, firstRunTabTitle, learnedSoFar, runPercent, shortAppName } from "./first-run";

type S = AutopilotProgressStep;
const KEYS = ["read", "learn", "research", "ideas", "make", "check", "finish", "ready"] as const;
const run = (states: Partial<Record<(typeof KEYS)[number], Partial<S>>>): S[] =>
  KEYS.map((key) => ({ key, state: "pending", facts: {}, ...(states[key] ?? {}) }) as S);

describe("first-run screen helpers (first-run.ts)", () => {
  it("progress counts finished steps plus the current step's measured share, never 100 early", () => {
    expect(runPercent(run({}))).toBe(0);
    expect(runPercent(run({ read: { state: "done" }, learn: { state: "done" }, research: { state: "active", live: { done: 0, total: 1, pct: 40 } as S["live"] } }))).toBe(30);
    expect(runPercent(run({ read: { state: "done" }, learn: { state: "active", live: { done: 3, total: 4 } as S["live"] } }))).toBe(Math.round((1.75 / 8) * 100));
    // A job reporting 100% while its step is still active stays below done.
    const almost = run(Object.fromEntries(KEYS.map((k) => [k, { state: "done" }])) as never);
    almost[7] = { ...almost[7]!, state: "active", live: { done: 1, total: 1, pct: 100 } as S["live"] };
    expect(runPercent(almost)).toBeLessThan(100);
    // Skipped steps don't count.
    expect(runPercent(run({ read: { state: "done" }, research: { state: "skipped" } }))).toBe(Math.round((1 / 7) * 100));
  });

  it("phase: studying until the ideas are written, then making", () => {
    expect(firstRunPhase(run({ read: { state: "active" } }))).toBe("studying");
    expect(firstRunPhase(run({ read: { state: "done" }, learn: { state: "done" }, research: { state: "done" }, ideas: { state: "active" } }))).toBe("studying");
    expect(firstRunPhase(run({ read: { state: "done" }, learn: { state: "done" }, research: { state: "done" }, ideas: { state: "done" }, make: { state: "active" } }))).toBe("making");
    expect(currentStep(run({ read: { state: "done" } }))?.key).toBe("learn");
  });

  it("short app names drop the store tagline", () => {
    expect(shortAppName("Pocket Play: your couch, your game")).toBe("Pocket Play");
    expect(shortAppName("Tidy Timer - Focus & Pomodoro")).toBe("Tidy Timer");
    expect(shortAppName("Forest — Stay focused")).toBe("Forest");
    expect(shortAppName("Notion")).toBe("Notion");
    expect(shortAppName("A really very long app name without any tagline at all")).toMatch(/…$/);
  });

  it("what Muse has learned: only real counts from finished steps", () => {
    const steps = run({
      read: { state: "done", facts: { screenshots: 6 } },
      learn: { state: "done", facts: { features: 8, audiences: 3, facts: 1 } },
      research: { state: "active", facts: { findings: 4 } },
    });
    expect(learnedSoFar(steps).map((l) => l.label)).toEqual(["6 screenshots", "8 features", "3 audiences", "1 confirmed fact"]);
    expect(learnedSoFar(run({}))).toEqual([]);
  });

  it("tab title shows the percentage and phase", () => {
    expect(firstRunTabTitle(28, "studying", "Pocket Play")).toBe("28% · Getting to know Pocket Play · MuseLaunch");
    expect(firstRunTabTitle(70, "making", "Pocket Play")).toBe("70% · Making your first videos · MuseLaunch");
  });
});
