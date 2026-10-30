/**
 * Autopilot by default: MuseLaunch starts a Growth Autopilot run on its own (after an app is added,
 * or with one tap), with a goal derived from the app, a budget that covers one full iteration within
 * the workspace's credits, and final renders pre-approved inside that budget. Posts, outreach and
 * spending past the budget still always wait for a person (see needs-you.ts).
 */
import { AUTO_VIDEO_DURATION, can, type Autopilot, type AutopilotAutoPlan, type AutopilotAutoStart, type Job, type WorkspaceMember } from "@muselaunch/contracts";
import { AppError, toAppError, type Platform } from "@muselaunch/platform";
import { autopilotSettings, defaultGoal, dnaJobsInFlight } from "./defaults";
import { estimateAutopilot, startAutopilot } from "./service";
import { MAX_FIX_ROUNDS } from "./stages";

/** Variants an automatic run compares by default (an A/B test). */
export const AUTO_VARIANTS = 2;
/** Renders are budgeted at the longest automatic length (concepts pick 30–60 s each). */
const BUDGET_RENDER_SEC = AUTO_VIDEO_DURATION.max;
/** StartAutopilotRequest's ceiling for pre-approved render spend. */
const MAX_AUTO_APPROVE = 200;

type Member = Pick<WorkspaceMember, "role" | "canPublish" | "canManageAccounts" | "status">;

/** What an automatic run would use and whether it fits the workspace's credits and per-run limit. */
export async function planAutoStart(p: Platform, workspaceId: string, appId: string, opts: { variants?: number; member: Member }): Promise<AutopilotAutoPlan> {
  const ws = p.db.ws(workspaceId);
  const [workspace, app, dna, balance] = await Promise.all([p.db.top("workspaces").get(workspaceId), ws.collection("apps").getOrThrow(appId), ws.collection("brandProfiles").get(appId), p.credits.balance(workspaceId)]);
  const settings = autopilotSettings(workspace);
  const { goal, fromDna } = defaultGoal(app, dna);
  const inflight = dna ? [] : await dnaJobsInFlight(ws, appId);
  const importing = inflight.some((j) => j.type === "app.import");
  const analysing = inflight.some((j) => j.type === "app.analyze");
  const analyzeCost = p.credits.estimate("app.analyze").credits;
  // App DNA still to build: an import in flight chains its own analysis (reserved when it starts);
  // with nothing in flight the loop delegates the analysis itself, inside its budget.
  const setupCredits = !dna && importing && !analysing ? analyzeCost : 0;
  const loopAnalysis = !dna && !importing && !analysing ? analyzeCost : 0;
  const fixRoom = (v: number) => v * MAX_FIX_ROUNDS * p.credits.estimate("composition.edit").credits;
  const budgetFor = (v: number) => {
    const est = estimateAutopilot(p, { variants: v, maxIterations: 1, durationSec: BUDGET_RENDER_SEC });
    return { est, maxCredits: est.perIteration + fixRoom(v) + loopAnalysis };
  };
  const cap = settings.maxCreditsPerRun;
  let variants = Math.min(3, Math.max(1, Math.trunc(opts.variants ?? AUTO_VARIANTS)));
  const notes: string[] = [];
  // The team's per-run limit picks the largest default run that fits it.
  if (!opts.variants && cap) {
    while (variants > 1 && budgetFor(variants).maxCredits > cap) variants--;
    if (variants < AUTO_VARIANTS) notes.push(`${variants} video${variants > 1 ? "s" : ""} instead of ${AUTO_VARIANTS} to stay within your ${cap}-credit limit per run.`);
  }
  const { est, maxCredits } = budgetFor(variants);
  const needed = maxCredits + setupCredits;
  const available = balance.available;
  const preApprove = settings.autoApproveRenders && can(opts.member, "billing.manage");
  const autoApproveCredits = preApprove ? Math.min(MAX_AUTO_APPROVE, maxCredits) : 0;
  if (settings.autoApproveRenders && !preApprove) notes.push("Final renders will ask first: only members who manage billing can let them run without asking.");
  if (!settings.autoApproveRenders) notes.push("Final renders will ask first (your workspace setting).");
  if (!fromDna) notes.push("The goal is refined from your App DNA once the app has been analysed.");

  let shortfall: AutopilotAutoPlan["shortfall"];
  let smaller: AutopilotAutoPlan["smaller"] = null;
  if (cap && maxCredits > cap) {
    shortfall = { kind: "per_run_limit", message: `This run needs ≈${maxCredits} credits, above your ${cap}-credit limit per run. Raise the limit in Settings, or start a smaller run.` };
  } else if (needed > available) {
    shortfall = { kind: "credits", message: `A full run needs ≈${needed} credits and your workspace has ${Math.max(0, available)}.` };
  }
  if (shortfall) {
    for (let v = variants - 1; v >= 1; v--) {
      const b = budgetFor(v);
      if (b.maxCredits + setupCredits <= available && (!cap || b.maxCredits <= cap)) {
        smaller = { variants: v, maxCredits: b.maxCredits, needed: b.maxCredits + setupCredits };
        break;
      }
    }
  }
  return {
    goal,
    goalFromDna: fromDna,
    variants,
    maxIterations: 1,
    maxCredits,
    autoApproveCredits,
    setupCredits,
    needed,
    available,
    fits: !shortfall,
    shortfall,
    smaller,
    breakdown: [...est.breakdown, { label: "Room for automatic fixes", credits: fixRoom(variants) }, ...(loopAnalysis ? [{ label: "App DNA analysis (Muse Spark)", credits: loopAnalysis }] : [])],
    notes,
  };
}

/**
 * Start an automatic run with the default plan. Content work (content.write); pre-approved renders
 * only when the starter manages billing. Throws INSUFFICIENT_CREDITS / BAD_REQUEST with `details.plan`
 * (incl. a smaller run that fits) when the default doesn't fit — it never silently spends less or more.
 */
export async function startAutoAutopilot(p: Platform, workspaceId: string, appId: string, opts: { variants?: number; member: Member; actor: string }): Promise<{ autopilot: Autopilot; job: Job; plan: AutopilotAutoPlan }> {
  if (!can(opts.member, "content.write")) throw new AppError("FORBIDDEN", "Starting Growth Autopilot requires content.write", { userMessage: "Only editors, admins and owners can start Growth Autopilot." });
  const plan = await planAutoStart(p, workspaceId, appId, opts);
  if (!plan.fits) {
    const s = plan.shortfall!;
    throw new AppError(s.kind === "credits" ? "INSUFFICIENT_CREDITS" : "BAD_REQUEST", s.message, {
      userMessage: `${s.message}${plan.smaller ? ` A smaller run (${plan.smaller.variants} video, ≈${plan.smaller.needed} credits) fits.` : s.kind === "credits" ? " Add credits to start one." : ""}`,
      details: { plan },
    });
  }
  const { autopilot, job } = await startAutopilot(
    p,
    workspaceId,
    appId,
    { goal: plan.goal, maxCredits: plan.maxCredits, maxIterations: plan.maxIterations, autoApproveCredits: plan.autoApproveCredits, variants: plan.variants },
    opts.actor,
    { auto: { goal: !plan.goalFromDna, acceptDna: true }, notes: plan.notes },
  );
  return { autopilot, job, plan };
}

/** Try to start an automatic run and report the outcome in plain language instead of throwing. */
export async function tryStartAutoAutopilot(p: Platform, workspaceId: string, appId: string, opts: { variants?: number; member: Member; actor: string }): Promise<AutopilotAutoStart> {
  try {
    const { autopilot, job, plan } = await startAutoAutopilot(p, workspaceId, appId, opts);
    return { started: true, autopilotId: autopilot.id, jobId: job.id, plan };
  } catch (raw) {
    const e = toAppError(raw);
    const plan = (e.opts.details as { plan?: AutopilotAutoPlan } | undefined)?.plan;
    const code: AutopilotAutoStart["code"] =
      e.code === "INSUFFICIENT_CREDITS" ? "insufficient_credits" : plan?.shortfall?.kind === "per_run_limit" ? "per_run_limit" : e.code === "FORBIDDEN" ? "forbidden" : e.code === "CONFLICT" ? "already_running" : "error";
    if (code === "error") p.log.warn({ err: { code: e.code, message: e.message }, workspaceId, appId }, "automatic Growth Autopilot start failed");
    return { started: false, code, plan, reason: (e.opts.userMessage ?? e.message).slice(0, 500) };
  }
}
