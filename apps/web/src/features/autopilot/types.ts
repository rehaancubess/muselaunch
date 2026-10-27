import type { AgentRun, Approval, Autopilot, AutopilotStage, BrandReview, Composition, Experiment, Job, ResearchFinding, ScheduledPost } from "@muselaunch/contracts";
import { routes } from "@/lib/routes";

/** GET /autopilots/:id (module B, routes/autopilot.ts). */
export interface AutopilotDetail {
  autopilot: Autopilot;
  waitingFor: string;
  runs: Pick<AgentRun, "id" | "kind" | "status" | "goal" | "model" | "usage" | "createdAt">[];
  jobs: Pick<Job, "id" | "type" | "status" | "progress" | "error" | "creditsCharged" | "reservation" | "createdAt" | "finishedAt">[];
  checkpoint: Approval | null;
  reviews: Pick<BrandReview, "id" | "subject" | "subjectVersion" | "status" | "reviewer" | "findings" | "summary" | "overrides">[];
  findings: Pick<ResearchFinding, "id" | "kind" | "statement" | "confidence" | "evidence">[];
  compositions: Pick<Composition, "id" | "title" | "currentVersion" | "variantId">[];
  posts: Pick<ScheduledPost, "id" | "status" | "channel" | "scheduledAt" | "compositionId">[];
  experiment: Pick<Experiment, "id" | "title" | "status" | "launchWindow" | "variants" | "primaryMetric"> | null;
}

export type LogEntry = Autopilot["log"][number];

/** GET /apps/:appId/autopilots — list rows carry the last log entry, not the whole log. */
export type AutopilotListItem = Omit<Autopilot, "log"> & { logCount: number; lastLog: LogEntry | null };

/** GET /apps/:appId/autopilot/estimate */
export interface AutopilotEstimate {
  perIteration: number;
  total: number;
  breakdown: { label: string; credits: number }[];
}

export type LoopStage = Exclude<AutopilotStage, "done">;

/** The loop's stages as people think about them (understand is folded into research). */
export const RAIL: { stage: LoopStage; label: string; blurb: string }[] = [
  { stage: "research", label: "Research", blurb: "Audience, trends and competitors — every finding cited." },
  { stage: "select_audience", label: "Audience", blurb: "Muse Wonder picks who to reach, citing the research." },
  { stage: "hypothesis", label: "Hypothesis", blurb: "One testable bet and an experiment to measure it." },
  { stage: "plan_creative", label: "Concepts", blurb: "Distinct creative angles, one per variant." },
  { stage: "produce", label: "Videos", blurb: "Storyboards built into editable compositions." },
  { stage: "verify", label: "Verify", blurb: "Lint, claim checks and the Brand Guardian." },
  { stage: "render", label: "Render", blurb: "Final HyperFrames renders, within your budget." },
  { stage: "schedule", label: "Posts", blurb: "Drafted with suggested times — each awaits your approval." },
  { stage: "measure", label: "Measure", blurb: "Waits for real results. Nothing is estimated." },
  { stage: "learn", label: "Learn", blurb: "Analysis, recommendations and lessons for next time." },
];

export const STAGE_LABEL: Record<AutopilotStage, string> = {
  understand: "Understand",
  ...Object.fromEntries(RAIL.map((r) => [r.stage, r.label])),
  done: "Done",
} as Record<AutopilotStage, string>;

/** Rail position of a stage (understand counts as research). */
export function railIndex(stage: AutopilotStage): number {
  if (stage === "understand") return 0;
  if (stage === "done") return RAIL.length;
  return RAIL.findIndex((r) => r.stage === stage);
}

export const ACTIVE_STATUSES: Autopilot["status"][] = ["running", "waiting_on_jobs", "awaiting_user", "sleeping", "paused"];
export const isActive = (s: Autopilot["status"]) => ACTIVE_STATUSES.includes(s);
export const isWorking = (s: Autopilot["status"]) => s === "running" || s === "waiting_on_jobs";

export const STATUS_COPY: Record<Autopilot["status"], string> = {
  running: "Working",
  waiting_on_jobs: "Working",
  awaiting_user: "Needs you",
  sleeping: "Measuring",
  paused: "Paused",
  completed: "Completed",
  failed: "Stopped",
  cancelled: "Cancelled",
};

export function statusKind(s: Autopilot["status"]): "running" | "attention" | "success" | "failed" | "cancelled" | "idle" {
  if (isWorking(s)) return "running";
  if (s === "awaiting_user") return "attention";
  if (s === "completed") return "success";
  if (s === "failed") return "failed";
  if (s === "cancelled") return "cancelled";
  return "idle";
}

/**
 * The log is one list across iterations; the learn stage's "Next iteration: …" decision closes an
 * iteration. Returns the entries of each iteration (index 0 = iteration 1).
 */
export function splitIterations(log: LogEntry[]): LogEntry[][] {
  const out: LogEntry[][] = [[]];
  for (const e of log) {
    out[out.length - 1]!.push(e);
    if (e.stage === "learn" && e.kind === "decision" && e.summary.startsWith("Next iteration")) out.push([]);
  }
  return out;
}

/** Group an iteration's entries by rail stage, in rail order. */
export function byStage(entries: LogEntry[]): Map<LoopStage, LogEntry[]> {
  const map = new Map<LoopStage, LogEntry[]>();
  for (const e of entries) {
    const stage: LoopStage = e.stage === "understand" ? "research" : e.stage === "done" ? "learn" : e.stage;
    map.set(stage, [...(map.get(stage) ?? []), e]);
  }
  return map;
}

/** One line that says what a stage concluded (a decision beats an observation beats an action). */
export function stageOutcome(entries: LogEntry[]): LogEntry | undefined {
  const pick = (k: LogEntry["kind"]) => [...entries].reverse().find((e) => e.kind === k);
  return pick("error") ?? pick("decision") ?? pick("checkpoint") ?? pick("observation") ?? pick("verification") ?? entries[entries.length - 1];
}

/** Link to the entity a log entry refers to (only entities that have a page). */
export function entityHref(workspaceId: string, appId: string, ap: Pick<Autopilot, "campaignId">, ref: { entity: string; id: string }, reviews: AutopilotDetail["reviews"]): { href: string; label: string } | null {
  const app = routes.app(workspaceId, appId);
  switch (ref.entity) {
    case "compositions":
      return { href: app.studio(ref.id), label: "Open in Studio" };
    case "campaigns":
      return { href: app.campaign(ref.id), label: "Campaign" };
    case "campaignVariants":
      return ap.campaignId ? { href: app.campaign(ap.campaignId), label: "Concepts" } : null;
    case "agentRuns":
      return { href: app.run(ref.id), label: "Agent run" };
    case "researchRuns":
      return { href: app.discover, label: "Research" };
    case "experiments":
    case "recommendations":
      return { href: app.insights, label: ref.entity === "experiments" ? "Experiment" : "Recommendations" };
    case "scheduledPosts":
      return { href: app.calendar, label: "Calendar" };
    case "brandProfiles":
      return { href: app.brand, label: "Brand" };
    case "brandReviews": {
      const r = reviews.find((x) => x.id === ref.id);
      return r?.subject.entity === "compositions" ? { href: app.studio(r.subject.id), label: "Review in Studio" } : null;
    }
    case "mediaAssets":
      return { href: app.library, label: "Library" };
    default:
      return null;
  }
}

/** Capability needed to decide a checkpoint (mirrors growth APPROVER_CAP on the server). */
export function checkpointCap(action: Approval["action"]): "billing.manage" | "content.approve" | "publish" {
  if (action === "spend") return "billing.manage";
  if (action === "publish") return "publish";
  return "content.approve";
}

export const autopilotPath = (workspaceId: string, appId: string) => `${routes.app(workspaceId, appId).root}/autopilot`;
