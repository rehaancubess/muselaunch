/**
 * "Always on": Growth Autopilot keeps going for an app at a posting pace its plan allows.
 *
 *  - Setting (per app, `apps.alwaysOn`): on/off, posts a week (1, 3, 5 or 7, never above
 *    `Plan.limits.postsPerWeek`; a downgrade clamps it), and an optional weekly email. Changing it is
 *    content work (content.write, the same as starting Autopilot).
 *  - The loop (always-on-loop.ts): rounds continue without a cap, each within a weekly credit
 *    allowance derived from the pace; posts are spread across the week; every post still needs the
 *    publish approval, and approved posts go out via the `publish-due` cron.
 *  - The `always-on` cron (hourly; worker, local-cron and Cloud Scheduler): clamps the pace after a
 *    downgrade, starts the weekly research sweep (Muse Wonder, every finding sourced; the plan's
 *    research-runs-per-day limit and credits apply), turns its best timely findings into a few
 *    Needs-you suggestions, wakes the loop when the week's queue runs low, and sends the weekly email
 *    when the person turned it on and Gmail is connected (from that Gmail to the same address).
 *  - The weekly summary is built from stored records only: posts, queue, research, Needs you, credits.
 */
import { ALWAYS_ON_PACES, can, type AlwaysOnPostLine, type AlwaysOnStatus, type AlwaysOnWeeklySummary, type App, type AppAlwaysOn, type Approval, type Autopilot, type ResearchRun, type SourceRef, type UpdateAlwaysOnRequest, type Workspace, type WorkspaceMember } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { connectedAccountFor, freshTokens, growthDeps } from "@muselaunch/growth";
import { AppError, notifyWeeklySummary, toAppError, workspaceHasReceivers, type Platform } from "@muselaunch/platform";
import { HttpClient, providerAdapter } from "@muselaunch/providers";
import { z } from "zod";
import {
  ALWAYS_ON_ACTOR,
  alwaysOnSpent,
  alwaysOnView,
  backlogLimit,
  clampPace,
  DAY_MS,
  freshResearch,
  isPaceDecision,
  isSuggestion,
  lowerPaceThan,
  minPlanFor,
  monthlyFromWeekly,
  NEXT_ROUND_TAG,
  openPaceDecision,
  PACE_LABEL,
  paceLimit,
  paceWords,
  postQueue,
  roundCredits,
  nextRoundVariants,
  roundVariants,
  runFindings,
  SUGGESTIONS_PER_WEEK,
  sweepCredits,
  sweepKeyPrefix,
  timeBasisOf,
  videoCredits,
  WEEK_MS,
  weeklyAllowance,
} from "./always-on-loop";
import { autopilotSettings, defaultGoal, dnaJobsInFlight } from "./defaults";
import { needsYou } from "./needs-you";
import { startAutopilot } from "./service";
import { isTerminalJob, nowMs, shortHash, tagOf } from "./state";
import { enqueueStep } from "./step";

type Member = Pick<WorkspaceMember, "role" | "canPublish" | "canManageAccounts" | "status">;

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ""));
const iso = (ms: number) => new Date(ms).toISOString();
/** Loops that count as "the app's run" (one at a time per app). */
const ACTIVE: Autopilot["status"][] = ["running", "waiting_on_jobs", "awaiting_user", "sleeping", "paused"];
/** Finding kinds that can make a timely video ("people are talking about X"). */
const TIMELY_KINDS = new Set(["trend", "audience_conversation", "community", "competitor_strategy", "format", "hook"]);
const SWEEP_KINDS = ["trends", "competitors", "creators", "opportunities"] as const;

// ---------------------------------------------------------------------------
// Per-app runtime state (workspaces/{wid}/state/alwaysOn.{appId})
// ---------------------------------------------------------------------------

const State = z.object({
  enabledAt: z.string().optional(),
  sweep: z.object({ runId: z.string(), jobId: z.string(), startedAt: z.string(), processed: z.boolean().default(false), status: z.string().optional(), findings: z.number().int().optional() }).optional(),
  nextSweepAt: z.string().optional(),
  sweepNote: z.string().max(300).optional(),
  suggested: z.array(z.object({ subjectId: z.string(), approvalId: z.string(), at: z.string() })).max(100).default([]),
  email: z.object({ lastSentAt: z.string().optional(), messageId: z.string().optional(), lastError: z.string().max(300).optional(), lastAttemptAt: z.string().optional() }).default({}),
  /** The weekly summary push to linked phones (independent of the email). */
  push: z.object({ lastSentAt: z.string().optional() }).default({}),
  notes: z.array(z.object({ at: z.string(), text: z.string().max(300) })).max(10).default([]),
});
type State = z.infer<typeof State>;

const stateDoc = (ws: WorkspaceDb, appId: string) => ws.state(`alwaysOn.${appId}`, State);
export async function alwaysOnState(ws: WorkspaceDb, appId: string): Promise<State> {
  return (await stateDoc(ws, appId).get()) ?? State.parse({});
}
async function saveState(ws: WorkspaceDb, appId: string, s: State): Promise<void> {
  await stateDoc(ws, appId).set(State.parse(s));
}
function addNote(s: State, at: number, text: string): void {
  s.notes = [{ at: iso(at), text: clip(text, 300) }, ...s.notes.filter((n) => n.text !== clip(text, 300))].slice(0, 10);
}

async function loops(ws: WorkspaceDb, appId: string): Promise<Autopilot[]> {
  return (await ws.collection("autopilots").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items;
}
const logEntry = (ap: Autopilot, at: number, kind: Autopilot["log"][number]["kind"], summary: string, refs: Autopilot["log"][number]["refs"] = []): Autopilot["log"][number] => ({ at: iso(at), stage: ap.stage, kind, summary: clip(summary, 1200), refs });

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

export interface AlwaysOnStart {
  started: boolean;
  /** The run that carries on (an existing one now always on, or a new one). */
  autopilotId?: string;
  reason?: string;
}

/**
 * Change the app's Always-on setting. The pace is refused above the plan's limit (BAD_REQUEST with
 * the plan that allows it); the email needs a connected Gmail. Turning it on makes the app's current
 * run always on, or starts one within the credits; turning it off lets the current run finish like a
 * one-off run and withdraws Always on's open suggestions.
 */
export async function updateAlwaysOn(p: Platform, workspaceId: string, appId: string, input: UpdateAlwaysOnRequest, opts: { member: Member; actor: string }): Promise<{ status: AlwaysOnStatus; start: AlwaysOnStart | null }> {
  if (!can(opts.member, "content.write")) throw new AppError("FORBIDDEN", "Changing Always on requires content.write", { userMessage: "Only editors, admins and owners can change Always on." });
  const ws = p.db.ws(workspaceId);
  const [app, workspace] = await Promise.all([ws.collection("apps").getOrThrow(appId), p.db.top("workspaces").get(workspaceId)]);
  const view = alwaysOnView(p, app, workspace);
  const limit = paceLimit(view.plan);
  if (input.postsPerWeek !== undefined && input.postsPerWeek > limit) {
    const min = minPlanFor(p, input.postsPerWeek);
    throw new AppError("BAD_REQUEST", `${input.postsPerWeek} posts a week is above the ${view.plan.name} plan's limit of ${limit}`, {
      userMessage: `Your ${view.plan.name} plan allows up to ${paceWords(limit)}.${min ? ` ${PACE_LABEL[input.postsPerWeek]} needs the ${min.name} plan or higher.` : ""}`,
      details: { limit, minPlan: min?.id },
    });
  }
  if (input.emailSummary === true && !(await connectedAccountFor(ws, "gmail"))) {
    throw new AppError("CONFLICT", "Gmail isn't connected", { userMessage: "Connect Gmail in Settings → Integrations first: the summary is sent from your Gmail to that same address." });
  }
  const now = nowMs(p);
  const prev = app.alwaysOn;
  const next: AppAlwaysOn = {
    enabled: input.enabled ?? prev?.enabled ?? false,
    postsPerWeek: clampPace(input.postsPerWeek ?? prev?.postsPerWeek ?? 1, limit),
    emailSummary: input.emailSummary ?? prev?.emailSummary ?? false,
    updatedBy: opts.actor,
    updatedAt: iso(now),
  };
  const updated = await ws.collection("apps").update(appId, { alwaysOn: next }, { actor: opts.actor });
  await ws.collection("auditLog").create({ action: "always_on.updated", target: { entity: "apps", id: appId }, data: { from: prev ?? null, to: { enabled: next.enabled, postsPerWeek: next.postsPerWeek, emailSummary: next.emailSummary } } }, { actor: opts.actor });
  const st = await alwaysOnState(ws, appId);
  let start: AlwaysOnStart | null = null;
  if (next.enabled && !prev?.enabled) {
    st.enabledAt = iso(now);
    st.notes = [];
    await saveState(ws, appId, st);
    start = await ensureAlwaysOnLoop(p, workspaceId, updated, opts);
  } else if (!next.enabled && prev?.enabled) {
    await turnedOff(p, workspaceId, appId, opts.actor);
  } else if (next.enabled && prev?.postsPerWeek !== next.postsPerWeek) {
    // A new pace applies from the next round; a faster one may need a round now.
    const active = (await loops(ws, appId)).find((a) => ACTIVE.includes(a.status) && a.alwaysOn);
    if (active) await wakeIfNeeded(p, workspaceId, updated, active);
  }
  return { status: await alwaysOnStatus(p, workspaceId, appId), start };
}

/** Always on was turned off: the run finishes like a one-off run; its open suggestions and pace decision are withdrawn. */
async function turnedOff(p: Platform, workspaceId: string, appId: string, actor: string): Promise<void> {
  const ws = p.db.ws(workspaceId);
  const now = nowMs(p);
  for (const ap of (await loops(ws, appId)).filter((a) => a.alwaysOn && ACTIVE.includes(a.status))) {
    await ws.collection("autopilots").update(ap.id, { alwaysOn: undefined, log: [...ap.log, logEntry(ap, now, "checkpoint", "Always on turned off by you: this run finishes like a one-off run (no new rounds).")].slice(-400) }, { actor });
    // Waiting for its allowance or credits: let it finish now.
    if (ap.status === "sleeping" && tagOf(ap.waitingOn.reason) === NEXT_ROUND_TAG) await wakeLoop(p, workspaceId, ap.id);
  }
  const open = (await ws.collection("approvals").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((a) => a.requestedBy === ALWAYS_ON_ACTOR && (a.status === "pending" || a.status === "approved"));
  for (const a of open) await ws.collection("approvals").update(a.id, { status: "expired", note: "Always on was turned off" }, { actor });
}

/**
 * Make sure the app has an always-on run: the current one carries on (marked always on), or a new
 * one starts with the budget of one round (and app analysis if it's still missing). Short on
 * credits → the pace decision in Needs you instead; nothing starts. `focus`: an approved suggestion.
 */
export async function ensureAlwaysOnLoop(
  p: Platform,
  workspaceId: string,
  app: App,
  opts: { member: Member; actor: string; focus?: NonNullable<Autopilot["alwaysOn"]>["focus"] },
): Promise<AlwaysOnStart> {
  const ws = p.db.ws(workspaceId);
  const now = nowMs(p);
  const workspace = await p.db.top("workspaces").get(workspaceId);
  const view = alwaysOnView(p, app, workspace);
  const active = (await loops(ws, app.id)).find((a) => ACTIVE.includes(a.status));
  if (active) {
    if (active.alwaysOn && !opts.focus) return { started: false, autopilotId: active.id };
    const marker = active.alwaysOn ?? { since: iso(now) };
    const note = opts.focus
      ? `You approved a suggestion from this week’s research; the next round focuses on it: ${clip(opts.focus.text, 300)}`
      : `Always on: this run keeps going at ${paceWords(view.pace)}, within a weekly allowance of up to ${weeklyAllowance(p, view.pace)} credits. Every post still waits for your approval.`;
    const updated = await ws.collection("autopilots").update(
      active.id,
      { alwaysOn: { ...marker, ...(opts.focus ? { focus: opts.focus } : {}) }, log: [...active.log, logEntry(active, now, "decision", note, opts.focus ? [{ entity: "approvals", id: opts.focus.approvalId }] : [])].slice(-400) },
      { actor: opts.actor },
    );
    await wakeIfNeeded(p, workspaceId, app, updated);
    return { started: false, autopilotId: active.id };
  }
  const pace = view.pace;
  const variants = roundVariants(pace);
  const fresh = await freshResearch(ws, app.id, now);
  const dna = await ws.collection("brandProfiles").get(app.id);
  const analysis = dna || (await dnaJobsInFlight(ws, app.id)).length ? 0 : p.credits.estimate("app.analyze").credits;
  const maxCredits = roundCredits(p, variants, !fresh) + analysis;
  const balance = await p.credits.balance(workspaceId);
  if (balance.available < maxCredits) {
    await openPaceDecision(p, workspaceId, app, { pace, needed: maxCredits, available: balance.available, plan: view.plan });
    return { started: false, reason: `The first round needs up to ${maxCredits} credits and the workspace has ${Math.max(0, balance.available)}. See Needs you: a lower pace or more credits.` };
  }
  const settings = autopilotSettings(workspace);
  const autoApproveCredits = settings.autoApproveRenders && can(opts.member, "billing.manage") ? Math.min(200, maxCredits) : 0;
  const { goal, fromDna } = defaultGoal(app, dna);
  const { autopilot } = await startAutopilot(
    p,
    workspaceId,
    app.id,
    { goal, maxCredits, maxIterations: 1, autoApproveCredits, variants },
    opts.actor,
    {
      auto: { goal: !fromDna, acceptDna: true },
      alwaysOn: { since: iso(now), ...(opts.focus ? { roundFocus: opts.focus.text } : {}) },
      summary: `Always on: started at ${paceWords(pace)}. Goal: “${goal}”. Each round makes ${variants} videos (up to ${maxCredits} credits for this one) within a weekly allowance of up to ${weeklyAllowance(p, pace)} credits. Posts are spread across the week and every one waits for your approval.${opts.focus ? ` Focus: ${clip(opts.focus.text, 200)}` : ""}${autoApproveCredits ? "" : " Final renders ask you first."}`,
    },
  );
  if (opts.focus) await ws.collection("approvals").update(opts.focus.approvalId, { status: "consumed", note: "A round of videos about it started" }, { actor: opts.actor }).catch(() => undefined);
  return { started: true, autopilotId: autopilot.id };
}

/** Wake a sleeping loop now (its sleep ends; the next step re-checks what to do). */
async function wakeLoop(p: Platform, workspaceId: string, id: string): Promise<boolean> {
  const repo = p.db.ws(workspaceId).collection("autopilots");
  const ap = await repo.get(id);
  if (!ap || ap.status !== "sleeping") return false;
  try {
    const updated = await repo.update(id, { waitingOn: { ...ap.waitingOn, until: iso(nowMs(p)) } }, { actor: ALWAYS_ON_ACTOR, expectedUpdatedAt: ap.updatedAt });
    await enqueueStep(p, updated, `autopilot:${id}:always-on-wake:${updated.updatedAt}`);
    return true;
  } catch (raw) {
    p.log.info({ workspaceId, autopilotId: id, code: toAppError(raw).code }, "always-on wake skipped");
    return false;
  }
}

/**
 * Wake an always-on loop that is waiting when the reason for waiting is gone: the week's queue is
 * short (a post went out or was turned down), a suggestion was approved, or the allowance / credits
 * it waited for are there now.
 */
async function wakeIfNeeded(p: Platform, workspaceId: string, app: App, ap: Autopilot): Promise<boolean> {
  if (ap.status !== "sleeping" || !ap.alwaysOn) return false;
  const ws = p.db.ws(workspaceId);
  const now = nowMs(p);
  const view = alwaysOnView(p, app, await p.db.top("workspaces").get(workspaceId));
  if (!view.on) return false;
  const tag = tagOf(ap.waitingOn.reason);
  if (tag === "measure") {
    if (ap.alwaysOn.focus) return wakeLoop(p, workspaceId, ap.id);
    const q = await postQueue(ws, app.id, now);
    if (q.upcoming.length < view.pace && q.awaiting.length < backlogLimit(view.pace)) return wakeLoop(p, workspaceId, ap.id);
    return false;
  }
  if (tag === NEXT_ROUND_TAG) {
    if (ap.alwaysOn.focus) return wakeLoop(p, workspaceId, ap.id);
    const q = await postQueue(ws, app.id, now);
    const cost = roundCredits(p, nextRoundVariants(view.pace, q.upcoming.length), !(await freshResearch(ws, app.id, now)));
    const [used, balance] = await Promise.all([alwaysOnSpent(ws, app.id, now - WEEK_MS), p.credits.balance(workspaceId)]);
    if (used + cost <= weeklyAllowance(p, view.pace) && balance.available >= cost) return wakeLoop(p, workspaceId, ap.id);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Needs-you decisions
// ---------------------------------------------------------------------------

async function loadAlwaysOnApproval(ws: WorkspaceDb, appId: string, approvalId: string, kind: "suggestion" | "pace"): Promise<Approval> {
  const a = await ws.collection("approvals").getOrThrow(approvalId);
  if (a.appId !== appId || !(kind === "suggestion" ? isSuggestion(a) : isPaceDecision(a))) throw new AppError("NOT_FOUND", "Approval not found");
  if (a.status !== "pending") throw new AppError("CONFLICT", `This was already decided (${a.status})`, { userMessage: "This was already decided." });
  if (a.expiresAt && Date.parse(a.expiresAt) < Date.now()) {
    await ws.collection("approvals").update(a.id, { status: "expired" }, { actor: ALWAYS_ON_ACTOR });
    throw new AppError("CONFLICT", "This suggestion expired", { userMessage: "This expired. Always on brings new suggestions every week." });
  }
  return a;
}

/** The suggestion text a round focuses on. */
function focusText(a: Approval): string {
  return clip(a.summary.replace(/\n/g, " ").replace(/\s*Approving starts.*$/, ""), 1000);
}

/**
 * A research suggestion: approve → the next round focuses on it (now, if the loop is waiting; it is
 * the person's OK for that one round even past this week's allowance); reject → noted (the approval
 * records who and why; an opportunity is marked dismissed in Discover). Needs content.approve.
 */
export async function decideSuggestion(p: Platform, workspaceId: string, appId: string, approvalId: string, input: { decision: "approve" | "reject"; note?: string }, opts: { member: Member; actor: string }): Promise<{ approval: Approval; start: AlwaysOnStart | null }> {
  if (!can(opts.member, "content.approve")) throw new AppError("FORBIDDEN", "Deciding Always on's suggestions requires content.approve", { userMessage: "Only owners and admins can decide this." });
  const ws = p.db.ws(workspaceId);
  const a = await loadAlwaysOnApproval(ws, appId, approvalId, "suggestion");
  const app = await ws.collection("apps").getOrThrow(appId);
  const decided = { decidedBy: opts.actor, decidedAt: iso(nowMs(p)), note: input.note?.slice(0, 1000) };
  if (input.decision === "reject") {
    const approval = await ws.collection("approvals").update(a.id, { status: "rejected", ...decided }, { actor: opts.actor });
    if (a.subject.entity === "opportunities") await ws.collection("opportunities").update(a.subject.id, { status: "dismissed" }, { actor: opts.actor }).catch(() => undefined);
    return { approval, start: null };
  }
  if (!alwaysOnView(p, app, await p.db.top("workspaces").get(workspaceId)).on) throw new AppError("CONFLICT", "Always on is off for this app", { userMessage: "Always on is off for this app. Turn it on to make videos from its suggestions." });
  const approval = await ws.collection("approvals").update(a.id, { status: "approved", ...decided }, { actor: opts.actor });
  if (a.subject.entity === "opportunities") await ws.collection("opportunities").update(a.subject.id, { status: "saved" }, { actor: opts.actor }).catch(() => undefined);
  const start = await ensureAlwaysOnLoop(p, workspaceId, app, { ...opts, focus: { approvalId: a.id, subject: a.subject, text: focusText(a) } });
  return { approval, start };
}

/** The pace decision: approve → the lower pace (or Always on off when already once a week); reject → keep it (noted). */
export async function decidePace(p: Platform, workspaceId: string, appId: string, input: { decision: "approve" | "reject"; note?: string }, opts: { member: Member; actor: string }): Promise<{ approval: Approval; status: AlwaysOnStatus }> {
  if (!can(opts.member, "content.approve")) throw new AppError("FORBIDDEN", "Deciding Always on's pace requires content.approve", { userMessage: "Only owners and admins can decide this." });
  const ws = p.db.ws(workspaceId);
  const pending = (await ws.collection("approvals").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 })).items.find((x) => isPaceDecision(x) && x.status === "pending");
  if (!pending) throw new AppError("CONFLICT", "No pace decision is waiting", { userMessage: "There's no pace decision waiting for this app." });
  const a = await loadAlwaysOnApproval(ws, appId, pending.id, "pace");
  const app = await ws.collection("apps").getOrThrow(appId);
  const now = nowMs(p);
  const decided = { decidedBy: opts.actor, decidedAt: iso(now) };
  if (input.decision === "reject") {
    const approval = await ws.collection("approvals").update(a.id, { status: "rejected", ...decided, note: input.note?.slice(0, 1000) ?? "Kept the pace" }, { actor: opts.actor });
    return { approval, status: await alwaysOnStatus(p, workspaceId, appId) };
  }
  const lower = lowerPaceThan(app.alwaysOn?.postsPerWeek ?? 1);
  const approval = await ws.collection("approvals").update(a.id, { status: "consumed", ...decided, note: lower ? `Pace lowered to ${paceWords(lower)}` : "Always on turned off" }, { actor: opts.actor });
  // content.approve (owners, admins) includes content.write, which changing the setting needs.
  await updateAlwaysOn(p, workspaceId, appId, lower ? { postsPerWeek: lower } : { enabled: false }, opts);
  return { approval, status: await alwaysOnStatus(p, workspaceId, appId) };
}

// ---------------------------------------------------------------------------
// The weekly research sweep and its suggestions
// ---------------------------------------------------------------------------

/** Start this week's sweep when it's due (plan quota and credits apply: postponed, never forced). */
type SweepOutcome = { kind: "running" | "started" | "waiting" | "postponed" } | { kind: "processed"; suggestions: number };

async function sweepStep(p: Platform, workspace: Workspace, app: App, st: State, actor: string, now: number): Promise<SweepOutcome> {
  const ws = p.db.ws(workspace.id);
  if (st.sweep && !st.sweep.processed) {
    const job = await ws.collection("jobs").get(st.sweep.jobId);
    if (job && !isTerminalJob(job)) return { kind: "running" };
    const run = await ws.collection("researchRuns").get(st.sweep.runId);
    st.sweep = { ...st.sweep, processed: true, status: run?.status ?? job?.status ?? "missing", findings: run?.findingCount ?? 0 };
    let made = 0;
    if (run && (run.status === "succeeded" || run.status === "partial") && run.findingCount > 0) {
      made = await suggestFromSweep(p, workspace.id, app, st, run, now);
      st.nextSweepAt = iso(Date.parse(st.sweep.startedAt) + WEEK_MS);
      st.sweepNote = made ? undefined : "This week’s research found nothing timely enough to suggest a video about.";
    } else {
      st.nextSweepAt = iso(now + DAY_MS);
      st.sweepNote = clip(`This week’s research didn’t finish (${job?.error?.userMessage ?? run?.status ?? "no result"}). Trying again tomorrow.`, 300);
    }
    return { kind: "processed", suggestions: made };
  }
  if (st.nextSweepAt && Date.parse(st.nextSweepAt) > now) return { kind: "waiting" };
  const focus = clip(
    `Always on weekly research for ${app.name}: what is new THIS WEEK that ${app.name} could make a short video about — trends and formats, competitor moves, creator and community conversations relevant to its real features and audiences. Prefer sources from the last 14 days and say when a source is older.`,
    1000,
  );
  const run = await ws.collection("researchRuns").create({ appId: app.id, kinds: [...SWEEP_KINDS], status: "queued", inputs: { countries: app.targetCountries, languages: app.targetLanguages, channels: [], competitorIds: [], focus } }, { actor });
  try {
    const job = await p.jobs.create(workspace.id, "research.run", { appId: app.id, researchRunId: run.id, kinds: [...SWEEP_KINDS] }, { actor, appId: app.id, idempotencyKey: `${sweepKeyPrefix(app.id)}${iso(now).slice(0, 13)}`, credits: { operation: "research.run" } });
    await ws.collection("researchRuns").update(run.id, { jobId: job.id }, { actor });
    st.sweep = { runId: run.id, jobId: job.id, startedAt: iso(now), processed: false };
    st.sweepNote = undefined;
    return { kind: "started" };
  } catch (raw) {
    await ws.collection("researchRuns").delete(run.id).catch(() => undefined);
    const e = toAppError(raw);
    if (e.code === "QUOTA_EXCEEDED" || e.code === "INSUFFICIENT_CREDITS" || e.code === "SPEND_CEILING") {
      // The plan's research runs per day / the credits decide; try again later, never past them.
      const nextUtcDay = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1, 0, 10);
      st.nextSweepAt = iso(e.code === "QUOTA_EXCEEDED" ? nextUtcDay : now + 6 * 3_600_000);
      st.sweepNote = clip(`This week’s research is postponed: ${e.opts.userMessage ?? e.message}`, 300);
      return { kind: "postponed" };
    }
    throw raw;
  }
}

function hostsOf(sources: SourceRef[]): string {
  const hosts = [...new Set(sources.flatMap((s) => (s.publisher ? [s.publisher] : s.url ? [new URL(s.url).hostname.replace(/^www\./, "")] : [])))];
  return hosts.slice(0, 3).join(", ");
}

/** Turn the sweep's best timely, sourced results into at most a few Needs-you suggestions a week. */
async function suggestFromSweep(p: Platform, workspaceId: string, app: App, st: State, run: ResearchRun, now: number): Promise<number> {
  const runId = run.id;
  const ws = p.db.ws(workspaceId);
  const recent = st.suggested.filter((x) => now - Date.parse(x.at) < WEEK_MS);
  const room = SUGGESTIONS_PER_WEEK - recent.length;
  if (room <= 0) return 0;
  const seen = new Set(st.suggested.map((x) => x.subjectId));
  const opps = (await ws.collection("opportunities").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 })).items
    .filter((o) => o.runId === runId && o.status === "new" && o.evidence.length > 0 && o.score >= 50 && o.confidence >= 0.5 && !seen.has(o.id))
    .sort((a, b) => b.score * b.confidence - a.score * a.confidence);
  const cited = new Set(opps.flatMap((o) => o.findingIds));
  const findings = (await runFindings(ws, run))
    .filter((f) => f.appId === app.id && TIMELY_KINDS.has(f.kind) && f.confidence >= 0.6 && f.evidence.length > 0 && !cited.has(f.id) && !seen.has(f.id))
    .sort((a, b) => b.confidence - a.confidence);
  const candidates = [
    ...opps.map((o) => ({ subject: { entity: "opportunities", id: o.id }, topic: o.title, statement: o.whyRelevant, angle: o.proposedAngle, evidence: o.evidence })),
    ...findings.map((f) => ({ subject: { entity: "researchFindings", id: f.id }, topic: clip(f.statement, 90), statement: f.interpretation ? `${f.statement} ${f.interpretation}` : f.statement, angle: "", evidence: f.evidence })),
  ].slice(0, room);
  const credits = roundCredits(p, 1, false);
  for (const c of candidates) {
    // "This week" only when a source says it's recent; otherwise the plainer wording.
    const fresh = c.evidence.some((e) => e.publishedAt && now - Date.parse(e.publishedAt) < 14 * DAY_MS);
    const title = fresh ? `People are talking about “${clip(c.topic, 90)}” this week: make a video about it?` : `This week’s research found “${clip(c.topic, 90)}”: make a video about it?`;
    const body = `${clip(c.statement, 420)}${c.angle ? ` Idea: ${clip(c.angle, 200)}` : ""} Sources: ${hostsOf(c.evidence) || "see Discover"}. Approving starts a round of videos about it (up to ${credits} credits); every post still waits for your approval.`;
    const approval = await ws.collection("approvals").create(
      {
        appId: app.id,
        action: "agent_continue",
        subject: c.subject,
        snapshotHash: shortHash(`always-on:suggestion:${c.subject.entity}:${c.subject.id}`),
        summary: clip(`${title}\n${body}`, 1000),
        requestedBy: ALWAYS_ON_ACTOR,
        status: "pending",
        expiresAt: iso(now + WEEK_MS),
        estimate: { credits },
      },
      { actor: ALWAYS_ON_ACTOR },
    );
    st.suggested = [{ subjectId: c.subject.id, approvalId: approval.id, at: iso(now) }, ...st.suggested].slice(0, 100);
  }
  return candidates.length;
}

/** Suggestions approved through the generic approvals route: apply them like the one-tap route does. */
async function applyApprovedSuggestions(p: Platform, workspaceId: string, app: App, member: Member, actor: string): Promise<number> {
  const ws = p.db.ws(workspaceId);
  const approved = (await ws.collection("approvals").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((a) => isSuggestion(a) && a.status === "approved");
  if (!approved.length) return 0;
  const focused = new Set((await loops(ws, app.id)).flatMap((ap) => (ap.alwaysOn?.focus ? [ap.alwaysOn.focus.approvalId] : [])));
  let n = 0;
  for (const a of approved.filter((x) => !focused.has(x.id)).slice(0, 1)) {
    await ensureAlwaysOnLoop(p, workspaceId, app, { member, actor: a.decidedBy ?? actor, focus: { approvalId: a.id, subject: a.subject, text: focusText(a) } });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The weekly summary (in-app, and optionally by email)
// ---------------------------------------------------------------------------

const VIEWER: Member = { role: "viewer", canPublish: false, canManageAccounts: false, status: "active" };

function postLine(x: { id: string; channel: AlwaysOnPostLine["channel"]; title?: string; caption: string; scheduledAt?: string; status: string; suggestedTimeReason?: string }, extra: Partial<AlwaysOnPostLine> = {}): AlwaysOnPostLine {
  return {
    postId: x.id,
    channel: x.channel,
    title: clip(x.title ?? x.caption.split("\n")[0] ?? "", 300),
    at: x.scheduledAt,
    status: x.status,
    ...(x.suggestedTimeReason ? { timeBasis: timeBasisOf(x.suggestedTimeReason), timeReason: clip(x.suggestedTimeReason, 500) } : {}),
    ...extra,
  };
}

export async function weeklySummary(p: Platform, workspaceId: string, app: App, now = nowMs(p)): Promise<AlwaysOnWeeklySummary> {
  const ws = p.db.ws(workspaceId);
  const from = now - WEEK_MS;
  const [workspace, st, posts, pubs, approvals] = await Promise.all([
    p.db.top("workspaces").get(workspaceId),
    alwaysOnState(ws, app.id),
    ws.collection("scheduledPosts").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 300 }),
    ws.collection("publications").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 }),
    ws.collection("approvals").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 }),
  ]);
  const view = alwaysOnView(p, app, workspace);
  const byId = new Map(posts.items.map((x) => [x.id, x]));
  const posted = pubs.items
    .filter((x) => Date.parse(x.publishedAt) >= from && Date.parse(x.publishedAt) <= now)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .slice(0, 20)
    .map((x) => {
      const post = byId.get(x.scheduledPostId);
      return post ? postLine(post, { at: x.publishedAt, status: post.status, url: x.remoteUrl, timeBasis: undefined, timeReason: undefined }) : { postId: x.scheduledPostId, channel: x.channel, title: "", at: x.publishedAt, status: "published", url: x.remoteUrl };
    });
  const q = await postQueue(ws, app.id, now);
  const run = st.sweep ? await ws.collection("researchRuns").get(st.sweep.runId) : null;
  const top = run ? (await runFindings(ws, run)).sort((a, b) => b.confidence - a.confidence).slice(0, 3) : [];
  const needs = await needsYou(p, workspaceId, VIEWER, { appId: app.id, limit: 50 });
  return {
    from: iso(from),
    to: iso(now),
    posted,
    queued: q.upcoming.slice(0, 14).map((x) => postLine(x)),
    research: {
      runId: run?.id,
      at: run ? (run.completedAt ?? run.updatedAt) : undefined,
      status: run?.status,
      findings: run?.findingCount ?? 0,
      top: top.map((f) => ({ id: f.id, kind: f.kind, statement: clip(f.statement, 1500), sources: f.evidence.slice(0, 3) })),
    },
    suggestions: approvals.items.filter((a) => isSuggestion(a) && Date.parse(a.createdAt) >= from).slice(0, 10).map((a) => ({ approvalId: a.id, title: clip(a.summary.split("\n")[0], 300), status: a.status })),
    needsYou: needs.count,
    credits: { used: await alwaysOnSpent(ws, app.id, from), allowance: view.on ? weeklyAllowance(p, view.pace) : 0 },
  };
}

/** Plain-text email of the weekly summary (nothing in it that isn't in the summary). */
export function summaryEmail(app: Pick<App, "name">, pace: number, s: AlwaysOnWeeklySummary, opts: { webUrl: string; workspaceId: string; appId: string; timezone: string }): { subject: string; body: string } {
  const when = (at?: string) => (at ? new Date(at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: opts.timezone }) : "no time set");
  const basis = (b?: string) => (b === "your_youtube" ? "based on your YouTube views" : b === "your_results" ? "based on your results" : b === "suggested" ? "suggested time" : "");
  const day = (at: string) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: opts.timezone });
  const lines = [
    `${app.name}: your week with MuseLaunch (Always on, ${paceWords(pace)}), ${day(s.from)} to ${day(s.to)}.`,
    "",
    `Posted (${s.posted.length})`,
    ...(s.posted.length ? s.posted.map((x) => `- ${when(x.at)} · ${x.channel} · ${x.title || "(untitled)"}${x.url ? ` · ${x.url}` : ""}`) : ["- Nothing went out this week."]),
    "",
    `Ready for the coming week (${s.queued.length})`,
    ...(s.queued.length ? s.queued.map((x) => `- ${when(x.at)} · ${x.channel} · ${x.title || "(untitled)"} · ${x.status === "awaiting_approval" ? "waiting for your approval" : "approved"}${basis(x.timeBasis) ? ` · ${basis(x.timeBasis)}` : ""}`) : ["- Nothing queued yet."]),
    "",
    `Research this week (${s.research.findings} sourced finding${s.research.findings === 1 ? "" : "s"})`,
    ...(s.research.top.length ? s.research.top.map((f) => `- ${clip(f.statement, 220)}${f.sources[0]?.url ? ` (${f.sources[0].url})` : ""}`) : ["- No new research this week."]),
    "",
    `Needs you: ${s.needsYou} decision${s.needsYou === 1 ? "" : "s"} → ${opts.webUrl.replace(/\/$/, "")}/w/${opts.workspaceId}/needs-you?appId=${opts.appId}`,
    `Credits used by Always on in the last 7 days: ${s.credits.used} of up to ${s.credits.allowance}.`,
    "",
    "You get this because you turned on the weekly email for Always on in MuseLaunch Settings. It is sent from your connected Gmail to the same address. Turn it off there any time.",
  ];
  const subject = clip(`${app.name} this week: ${s.posted.length} posted, ${s.queued.length} ready${s.needsYou ? `, ${s.needsYou} need${s.needsYou === 1 ? "s" : ""} you` : ""}`, 200);
  return { subject, body: lines.join("\n") };
}

/** Send the weekly email when it's due (only if turned on and Gmail is connected; from that Gmail to itself). */
async function emailStep(p: Platform, workspace: Workspace, app: App, st: State, now: number): Promise<"sent" | "skipped" | "failed"> {
  const s = app.alwaysOn;
  if (!s?.emailSummary) return "skipped";
  const since = st.email.lastSentAt ?? st.enabledAt ?? s.updatedAt;
  if (!since || now - Date.parse(since) < WEEK_MS) return "skipped";
  if (st.email.lastError && st.email.lastAttemptAt && now - Date.parse(st.email.lastAttemptAt) < DAY_MS) return "skipped";
  const ws = p.db.ws(workspace.id);
  const fail = (msg: string) => {
    st.email = { ...st.email, lastError: clip(msg, 300), lastAttemptAt: iso(now) };
    return "failed" as const;
  };
  const account = await connectedAccountFor(ws, "gmail");
  if (!account) return fail("Gmail isn’t connected any more, so the weekly email wasn’t sent.");
  const adapter = providerAdapter("gmail");
  const deps = growthDeps(p);
  const creds = deps.settings.creds.gmail;
  if (!adapter?.sendEmail || !creds) return fail("Gmail isn’t set up on this deployment, so the weekly email wasn’t sent.");
  if (!/^[^\s@]+@[^\s@]+$/.test(account.displayName)) return fail("The connected Gmail account has no email address on record.");
  try {
    const summary = await weeklySummary(p, workspace.id, app, now);
    const mail = summaryEmail(app, alwaysOnView(p, app, workspace).pace, summary, { webUrl: p.cfg.PUBLIC_WEB_URL, workspaceId: workspace.id, appId: app.id, timezone: workspace.settings.defaultTimezone ?? "UTC" });
    const tokens = await freshTokens(p, ws, account, s.updatedBy ?? ALWAYS_ON_ACTOR);
    // To the connected address itself: the summary never goes to anyone else.
    const res = await adapter.sendEmail({ from: account.displayName, to: account.displayName, subject: mail.subject, body: mail.body }, { http: new HttpClient(deps.fetch, "Gmail"), tokens, externalAccountId: account.externalAccountId, settings: deps.settings.adapter, creds, sleep: deps.sleep });
    st.email = { lastSentAt: iso(now), messageId: res.messageId, lastAttemptAt: iso(now) };
    await ws.collection("auditLog").create({ action: "always_on.summary_emailed", target: { entity: "apps", id: app.id }, data: { to: account.displayName, messageId: res.messageId } }, { actor: ALWAYS_ON_ACTOR });
    return "sent";
  } catch (raw) {
    const e = toAppError(raw);
    return fail(`The weekly email couldn’t be sent: ${e.opts.userMessage ?? e.message}`);
  }
}

/**
 * The weekly summary on the team's linked phones and browsers (→ Results), once a week while
 * Always on is on: the summary's own counts, nothing else. Only marked sent when a phone or browser got it, so
 * the first one goes out soon after someone links a phone or turns notifications on.
 */
async function pushStep(p: Platform, workspace: Workspace, app: App, st: State, now: number): Promise<boolean> {
  const since = st.push.lastSentAt ?? st.enabledAt ?? app.alwaysOn?.updatedAt;
  if (!since || now - Date.parse(since) < WEEK_MS) return false;
  if (!(await workspaceHasReceivers(p, workspace.id))) return false;
  const s = await weeklySummary(p, workspace.id, app, now);
  const res = await notifyWeeklySummary(p, workspace.id, app.id, { posted: s.posted.length, queued: s.queued.length, needsYou: s.needsYou, findings: s.research.findings });
  if (!res?.sent) return false;
  st.push = { lastSentAt: iso(now) };
  return true;
}

// ---------------------------------------------------------------------------
// The cron
// ---------------------------------------------------------------------------

export interface AlwaysOnTick {
  workspaces: number;
  apps: number;
  clamped: number;
  loopsStarted: number;
  sweeps: number;
  suggestions: number;
  woken: number;
  emails: number;
  errors: { workspaceId: string; appId: string; code: string }[];
}

/**
 * Cron `always-on` (hourly in production, every local-cron tick in single-process mode). Idempotent:
 * sweeps are keyed per app and hour, suggestions per research result, wakes per loop version.
 */
export async function runAlwaysOn(p: Platform): Promise<AlwaysOnTick> {
  const out: AlwaysOnTick = { workspaces: 0, apps: 0, clamped: 0, loopsStarted: 0, sweeps: 0, suggestions: 0, woken: 0, emails: 0, errors: [] };
  let cursor: string | null | undefined;
  do {
    const page = await p.db.top("workspaces").list({ limit: 100, cursor });
    for (const w of page.items) {
      out.workspaces++;
      const apps = (await p.db.ws(w.id).collection("apps").list({ limit: 100 })).items.filter((a) => a.alwaysOn?.enabled && a.status !== "archived");
      for (const app of apps) {
        out.apps++;
        try {
          await tickApp(p, w, app, out);
        } catch (raw) {
          const e = toAppError(raw);
          out.errors.push({ workspaceId: w.id, appId: app.id, code: e.code });
          p.log.warn({ workspaceId: w.id, appId: app.id, err: { code: e.code, message: e.message } }, "always-on tick failed");
        }
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

async function tickApp(p: Platform, workspace: Workspace, appIn: App, out: AlwaysOnTick): Promise<void> {
  const ws = p.db.ws(workspace.id);
  const now = nowMs(p);
  let app = appIn;
  const st = await alwaysOnState(ws, app.id);
  const view = alwaysOnView(p, app, workspace);
  // 1. Plan downgraded: the pace comes down to what the plan allows (and says so).
  if (view.clamped) {
    app = await ws.collection("apps").update(app.id, { alwaysOn: { ...app.alwaysOn!, postsPerWeek: view.pace } }, { actor: ALWAYS_ON_ACTOR });
    addNote(st, now, `Your ${view.plan.name} plan allows up to ${paceWords(paceLimit(view.plan))}, so the pace went down from ${paceWords(view.requested)} to ${paceWords(view.pace)}.`);
    out.clamped++;
  }
  // 2. Work runs on behalf of whoever turned it on, while they may still make content here.
  const actor = app.alwaysOn?.updatedBy;
  const member = actor ? await ws.collection("members").get(actor) : null;
  if (!member || !can(member, "content.write")) {
    addNote(st, now, "Always on is waiting: the person who turned it on can no longer make content in this workspace. Someone with editor access can turn it off and on again.");
    await saveState(ws, app.id, st);
    return;
  }
  // 3. The run: start one when there's none (not after someone stopped or a run failed: that's theirs to restart).
  const all = await loops(ws, app.id);
  let active = all.find((a) => ACTIVE.includes(a.status));
  if (!active && (!all[0] || all[0].status === "completed")) {
    const start = await ensureAlwaysOnLoop(p, workspace.id, app, { member, actor: actor! });
    if (start.started) out.loopsStarted++;
    else if (start.reason) addNote(st, now, start.reason);
    active = start.autopilotId ? (await ws.collection("autopilots").get(start.autopilotId)) ?? undefined : undefined;
  } else if (!active && all[0]) {
    addNote(st, now, `The last Autopilot run ${all[0].status === "failed" ? "stopped with a problem" : "was stopped"}, so Always on is waiting. Resume it on the Autopilot page, or turn Always on off and on again to start fresh.`);
  } else if (active && !active.alwaysOn) {
    await ensureAlwaysOnLoop(p, workspace.id, app, { member, actor: actor! });
  }
  // 4. This week's research, and the suggestions it brings.
  const sweep = await sweepStep(p, workspace, app, st, actor!, now);
  if (sweep.kind === "started") out.sweeps++;
  if (sweep.kind === "processed") out.suggestions += sweep.suggestions;
  await applyApprovedSuggestions(p, workspace.id, app, member, actor!);
  // 5. The queue ran low (a post went out or was turned down), or what it waited for is there now.
  const loop = active ? await ws.collection("autopilots").get(active.id) : null;
  if (loop && (await wakeIfNeeded(p, workspace.id, app, loop))) out.woken++;
  // 6. The weekly email (only when turned on and Gmail is connected).
  if ((await emailStep(p, workspace, app, st, now)) === "sent") out.emails++;
  // 7. The same week on linked phones (a push that opens Results).
  await pushStep(p, workspace, app, st, now);
  await saveState(ws, app.id, st);
}

// ---------------------------------------------------------------------------
// Status (GET /apps/:appId/always-on)
// ---------------------------------------------------------------------------

export async function alwaysOnStatus(p: Platform, workspaceId: string, appId: string): Promise<AlwaysOnStatus> {
  const ws = p.db.ws(workspaceId);
  const now = nowMs(p);
  const [app, workspace] = await Promise.all([ws.collection("apps").getOrThrow(appId), p.db.top("workspaces").get(workspaceId)]);
  const view = alwaysOnView(p, app, workspace);
  const [st, balance, q, all, gmail, summary] = await Promise.all([
    alwaysOnState(ws, appId),
    p.credits.balance(workspaceId),
    postQueue(ws, appId, now),
    loops(ws, appId),
    connectedAccountFor(ws, "gmail"),
    weeklySummary(p, workspaceId, app, now),
  ]);
  const limit = paceLimit(view.plan);
  const weekly = weeklyAllowance(p, view.pace);
  const loop = all.find((a) => ACTIVE.includes(a.status)) ?? all[0];
  const notes = [...st.notes.map((n) => n.text)];
  if (view.clamped) notes.unshift(`Your ${view.plan.name} plan allows up to ${paceWords(limit)}, so Always on uses ${paceWords(view.pace)} (you chose ${paceWords(view.requested)}).`);
  if (st.sweepNote) notes.push(st.sweepNote);
  const next = q.upcoming[0];
  return {
    appId,
    settings: view.settings,
    ...(view.clamped ? { requestedPostsPerWeek: view.requested } : {}),
    plan: { id: view.plan.id, name: view.plan.name, postsPerWeek: limit, monthlyCredits: view.plan.monthlyCredits },
    options: ALWAYS_ON_PACES.map((pace) => {
      const min = minPlanFor(p, pace);
      return { postsPerWeek: pace, label: PACE_LABEL[pace], allowed: pace <= limit, ...(pace > limit && min ? { minPlan: { id: min.id, name: min.name } } : {}), weeklyCredits: weeklyAllowance(p, pace) };
    }),
    estimate: { perVideo: videoCredits(p, view.pace), sweep: sweepCredits(p), weeklyCredits: weekly, monthlyCredits: monthlyFromWeekly(weekly), fitsPlan: monthlyFromWeekly(weekly) <= view.plan.monthlyCredits },
    available: balance.available,
    week: { used: summary.credits.used, allowance: view.on ? weekly : 0 },
    loop: loop ? { id: loop.id, status: loop.status, stage: loop.stage, iteration: loop.iteration } : null,
    next: next ? postLine(next) : null,
    queue: { upcoming: q.upcoming.length, approved: q.approved, awaitingApproval: q.awaiting.length, target: view.on ? view.pace : 0 },
    sweep: {
      lastAt: st.sweep?.startedAt,
      runId: st.sweep?.runId,
      status: st.sweep ? (st.sweep.processed ? st.sweep.status : "running") : undefined,
      nextAt: view.on ? (st.nextSweepAt ?? iso(now)) : undefined,
      note: st.sweepNote,
    },
    gmail: { connected: Boolean(gmail), address: gmail?.displayName, lastSentAt: st.email.lastSentAt, lastError: st.email.lastError },
    notes: notes.slice(0, 10),
    summary,
  };
}
