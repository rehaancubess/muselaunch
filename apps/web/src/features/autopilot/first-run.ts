/**
 * Plain helpers for the first-run screen ("Getting to know <app>"), no React, so they can be
 * unit-tested. Everything is computed from the run's real steps (server-side progress): the ring's
 * percentage counts finished steps plus the measured progress of the jobs behind the current one;
 * nothing animates fake progress.
 */
import type { AutopilotProgressStep, AutopilotProgressStepKey } from "@muselaunch/contracts";

type Step = AutopilotProgressStep;

const STUDY: ReadonlySet<AutopilotProgressStepKey> = new Set(["read", "learn", "research", "ideas"]);

export const shownSteps = (steps: Step[]) => steps.filter((s) => s.state !== "skipped");

/** The step being worked on (the first one not done), if any. */
export function currentStep(steps: Step[]): Step | undefined {
  return shownSteps(steps).find((s) => s.state !== "done");
}

/** 0–100: finished steps, plus the measured share of the current step's jobs (capped so it never shows done early). */
export function runPercent(steps: Step[]): number {
  const all = shownSteps(steps);
  if (!all.length) return 0;
  let done = 0;
  for (const s of all) {
    if (s.state === "done") done += 1;
    else if (s.state === "active" && s.live) {
      const frac = typeof s.live.pct === "number" ? s.live.pct / 100 : s.live.total ? s.live.done / s.live.total : 0;
      done += Math.max(0, Math.min(0.95, frac));
    }
  }
  return Math.min(100, Math.round((done / all.length) * 100));
}

/** Studying the app (read → ideas) or making the videos (make → ready). */
export function firstRunPhase(steps: Step[]): "studying" | "making" {
  const c = currentStep(steps);
  return c && STUDY.has(c.key) ? "studying" : "making";
}

/** "Pocket Play: your couch, your game" → "Pocket Play" (store names often carry a tagline). */
export function shortAppName(name: string): string {
  const head = name.split(/\s*[:|–—]\s+|\s+-\s+/)[0]?.trim() ?? "";
  const n = head.length >= 2 ? head : name.trim();
  return n.length > 28 ? `${n.slice(0, 27).trimEnd()}…` : n;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What Muse has learned so far: real counts from finished steps only, in the order they arrive. */
export function learnedSoFar(steps: Step[]): { key: string; label: string }[] {
  const done = (k: AutopilotProgressStepKey) => steps.find((s) => s.key === k && s.state === "done")?.facts;
  const out: { key: string; label: string }[] = [];
  const read = done("read");
  if (read?.screenshots) out.push({ key: "screenshots", label: count(read.screenshots, "screenshot") });
  const learn = done("learn");
  if (learn?.features) out.push({ key: "features", label: count(learn.features, "feature") });
  if (learn?.audiences) out.push({ key: "audiences", label: count(learn.audiences, "audience") });
  if (learn?.facts) out.push({ key: "facts", label: count(learn.facts, "confirmed fact") });
  const research = done("research");
  if (research?.findings) out.push({ key: "findings", label: `${count(research.findings, "finding")} with sources` });
  const ideas = done("ideas");
  if (ideas?.ideas) out.push({ key: "ideas", label: count(ideas.ideas, "video idea") });
  return out;
}

/** The browser tab's title while the first run works, so a background tab shows how far it has got. */
export function firstRunTabTitle(pct: number, phase: "studying" | "making", appName: string): string {
  return `${pct}% · ${phase === "studying" ? `Getting to know ${appName}` : "Making your first videos"} · MuseLaunch`;
}
