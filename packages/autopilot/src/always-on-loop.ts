/**
 * "Always on" inside the Growth Autopilot loop: pace limits, the weekly credit allowance, spreading
 * posts across the week (with the time's basis always labelled), and what an always-on loop does at
 * research / measure / learn. The settings, the cron and the API live in always-on.ts.
 *
 * No imports from stages / step / service: stages.ts imports this file.
 */
import { ALWAYS_ON_PACES, AUTO_VIDEO_DURATION, DEFAULT_PLANS, type AlwaysOnPace, type App, type AppAlwaysOn, type Approval, type Capability, type Channel, type NeedsYouItem, type Plan, type PlanId, type PostTimeBasis, type ResearchFinding, type ResearchRun, type ScheduledPost, type Workspace, type YouTubeChannelAnalysis } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { zonedToUtc } from "@muselaunch/growth";
import type { Platform } from "@muselaunch/platform";
import { isTerminalJob, nowMs, shortHash, type LoopEnv, type Outcome } from "./state";

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Who opens Always on's own Needs-you items (research suggestions, the pace decision). */
export const ALWAYS_ON_ACTOR = "agent:always-on";
/** At most this many research suggestions in any 7 days ("the few best"). */
export const SUGGESTIONS_PER_WEEK = 3;
/** Automatic fix rounds budgeted per video: the same number as stages.ts MAX_FIX_ROUNDS (a test keeps them equal; importing it here would be a cycle). */
export const FIX_ROOM_ROUNDS = 2;
/** The first suggested slot is at least this far away (time to approve it). */
const LEAD_MS = 3 * 3_600_000;
const PLAN_ORDER: PlanId[] = ["free", "starter", "growth", "studio"];

export const PACE_LABEL: Record<AlwaysOnPace, string> = { 1: "Once a week", 3: "3 times a week", 5: "5 times a week", 7: "Every day" };
export const paceWords = (n: number) => (n >= 7 ? "every day" : n === 1 ? "1 post a week" : `${n} posts a week`);

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ""));
const CHANNEL_NAME: Partial<Record<Channel, string>> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", linkedin: "LinkedIn", threads: "Threads", facebook: "Facebook", reddit: "Reddit" };
const channelName = (c: Channel) => CHANNEL_NAME[c] ?? c.replace(/_/g, " ");

// ---------------------------------------------------------------------------
// Plan and pace
// ---------------------------------------------------------------------------

export function planOf(p: Platform, planId: string | undefined): Plan {
  return p.credits.plans[(planId ?? "free") as PlanId] ?? p.credits.plans.free;
}

/** The plan's highest pace (PLANS_JSON overrides without the field fall back to the default plan's). */
export function paceLimit(plan: Plan): number {
  return plan.limits.postsPerWeek ?? DEFAULT_PLANS[plan.id]?.limits.postsPerWeek ?? 1;
}

/** The highest offered pace at or below both the wish and the plan's limit (never below once a week). */
export function clampPace(pace: number, limit: number): AlwaysOnPace {
  const ok = ALWAYS_ON_PACES.filter((x) => x <= Math.min(pace, limit));
  return ok[ok.length - 1] ?? 1;
}

/** The cheapest plan that allows `pace`. */
export function minPlanFor(p: Platform, pace: number): Plan | undefined {
  return PLAN_ORDER.map((id) => p.credits.plans[id]).find((pl): pl is Plan => Boolean(pl) && paceLimit(pl!) >= pace);
}

export interface AlwaysOnView {
  on: boolean;
  /** Effective settings: the pace is clamped to the plan. */
  settings: AppAlwaysOn;
  pace: AlwaysOnPace;
  /** What the person chose (higher than `pace` after a downgrade). */
  requested: number;
  clamped: boolean;
  plan: Plan;
}

export function alwaysOnView(p: Platform, app: Pick<App, "alwaysOn">, workspace: Pick<Workspace, "planId"> | null | undefined): AlwaysOnView {
  const plan = planOf(p, workspace?.planId);
  const s: AppAlwaysOn = { enabled: false, postsPerWeek: 1, emailSummary: false, ...(app.alwaysOn ?? {}) };
  const pace = clampPace(s.postsPerWeek, paceLimit(plan));
  return { on: s.enabled, settings: { ...s, postsPerWeek: pace }, pace, requested: s.postsPerWeek, clamped: pace !== s.postsPerWeek, plan };
}

// ---------------------------------------------------------------------------
// Credits: per video, per round, per week (same price list as estimateAutopilot)
// ---------------------------------------------------------------------------

/**
 * Most videos one round makes: one at once a week, an A/B pair at 3 a week, three at the faster paces
 * (fewer shared costs per video). A round makes only what the coming week still needs (at least one).
 */
export function roundVariants(pace: number): number {
  return pace >= 5 ? 3 : pace >= 3 ? 2 : 1;
}

/** Videos the next round makes: what the coming week still needs, within the round size. */
export const nextRoundVariants = (pace: number, upcoming: number) => Math.min(roundVariants(pace), Math.max(1, pace - upcoming));

function prices(p: Platform) {
  const e = (op: string, params: Record<string, unknown> = {}) => p.credits.estimate(op, params).credits;
  // Budgeted at the longest automatic length (concepts pick 30–60 s) with room for the automatic fixes.
  const perVideo =
    e("storyboard.generate") + e("composition.build") + e("render.preview") + e("brand.review") + e("render.final", { durationSec: AUTO_VIDEO_DURATION.max }) + e("video.review") + e("copy.generate") + FIX_ROOM_ROUNDS * e("composition.edit");
  const perRound = e("campaign.generate_concepts") + e("experiment.analyze") + e("recommendations.generate");
  return { perVideo, perRound, research: e("research.run") };
}

/** Rounds a week at `pace`. */
const roundsPerWeek = (pace: number) => Math.ceil(pace / roundVariants(pace));

/** Most one video costs on average at `pace` (its share of ideas + reading results included; research is the weekly sweep). */
export function videoCredits(p: Platform, pace: number): number {
  const x = prices(p);
  return Math.ceil(x.perVideo + (roundsPerWeek(pace) * x.perRound) / Math.max(1, pace));
}

/** Most one round costs (its own research only when there's no fresh weekly research to reuse). */
export function roundCredits(p: Platform, variants: number, withResearch: boolean): number {
  const x = prices(p);
  return variants * x.perVideo + x.perRound + (withResearch ? x.research : 0);
}

export function sweepCredits(p: Platform): number {
  return prices(p).research;
}

/** Most Always on spends in any 7 days at `pace`: the pace's videos in its rounds, plus one research sweep. */
export function weeklyAllowance(p: Platform, pace: number): number {
  const x = prices(p);
  return pace * x.perVideo + roundsPerWeek(pace) * x.perRound + x.research;
}

export const monthlyFromWeekly = (weekly: number) => Math.round((weekly * 30) / 7);

/** Idempotency-key prefix of the weekly research sweep's job. */
export const sweepKeyPrefix = (appId: string) => `always-on:sweep:${appId}:`;

/**
 * Credits Always on used for this app since `sinceMs`: jobs its loops delegated while always-on
 * (and what those jobs chained), plus the weekly research sweeps. Settled jobs count what was
 * charged; open ones their reservation. Real ledger numbers, nothing estimated.
 */
export async function alwaysOnSpent(ws: WorkspaceDb, appId: string, sinceMs: number): Promise<number> {
  const loops = (await ws.collection("autopilots").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items.filter((a) => a.alwaysOn);
  const roots: { prefix: string; since: number }[] = [{ prefix: sweepKeyPrefix(appId), since: sinceMs }, ...loops.map((a) => ({ prefix: `autopilot:${a.id}:`, since: Math.max(sinceMs, Date.parse(a.alwaysOn!.since)) }))];
  const jobs = (await ws.collection("jobs").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 400 })).items.filter((j) => Date.parse(j.createdAt) >= sinceMs && j.type !== "autopilot.step");
  const ids = new Set(jobs.filter((j) => roots.some((r) => j.idempotencyKey.startsWith(r.prefix) && Date.parse(j.createdAt) >= r.since)).map((j) => j.id));
  for (let level = 0; level < 3; level++) for (const j of jobs) if (j.parentJobId && ids.has(j.parentJobId)) ids.add(j.id);
  return jobs.filter((j) => ids.has(j.id)).reduce((n, j) => n + (isTerminalJob(j) ? (j.creditsCharged ?? 0) : (j.reservation?.credits ?? 0)), 0);
}

// ---------------------------------------------------------------------------
// The queue of posts for the coming week
// ---------------------------------------------------------------------------

/** Posts that are ready to go out (approved) or waiting for the publish approval. */
const QUEUED: ScheduledPost["status"][] = ["awaiting_approval", "scheduled", "manual_post_needed"];

export interface PostQueue {
  /** Future-dated posts, approved or waiting for approval, soonest first. */
  upcoming: ScheduledPost[];
  approved: number;
  /** Every post waiting for its publish approval (also ones whose time has passed). */
  awaiting: ScheduledPost[];
}

export async function postQueue(ws: WorkspaceDb, appId: string, now: number): Promise<PostQueue> {
  const posts = (await ws.collection("scheduledPosts").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 300 })).items;
  const upcoming = posts.filter((x) => QUEUED.includes(x.status) && x.scheduledAt && Date.parse(x.scheduledAt) > now).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
  return { upcoming, approved: upcoming.filter((x) => x.status !== "awaiting_approval").length, awaiting: posts.filter((x) => x.status === "awaiting_approval") };
}

/** Unapproved posts beyond which Always on makes no more (it waits for the person instead of piling up drafts). */
export const backlogLimit = (pace: number) => Math.max(2, pace);

// ---------------------------------------------------------------------------
// When to post: spread across the week, from the app's own data when it says so
// ---------------------------------------------------------------------------

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const YT_DAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
/** Posting days by pace (0 = Sunday) when no data says otherwise: spread out, midweek first. */
const DEFAULT_DAYS: Record<number, number[]> = { 1: [3], 3: [1, 3, 5], 5: [1, 2, 3, 4, 5], 7: [0, 1, 2, 3, 4, 5, 6] };
/** General starting points (local time of the audience) — labelled as suggestions, never as research. */
const CHANNEL_HOUR: Partial<Record<Channel, { hour: number; why: string }>> = {
  instagram: { hour: 19, why: "early evening is a common starting point for Instagram Reels" },
  tiktok: { hour: 19, why: "early evening is a common starting point for TikTok" },
  youtube: { hour: 15, why: "mid-afternoon gives a YouTube video time to be picked up before evening viewing" },
  facebook: { hour: 13, why: "early afternoon is a common starting point for Facebook Pages" },
  threads: { hour: 12, why: "midday is a common starting point for Threads" },
  x: { hour: 12, why: "lunchtime is a common starting point for X" },
  linkedin: { hour: 9, why: "weekday mornings are a common starting point for LinkedIn" },
  reddit: { hour: 8, why: "early morning gives a Reddit post the day to gather discussion" },
};
/** The main time zone of a target country (the most populous one where a country has several). */
const COUNTRY_TZ: Record<string, string> = {
  US: "America/New_York", CA: "America/Toronto", MX: "America/Mexico_City", BR: "America/Sao_Paulo", AR: "America/Argentina/Buenos_Aires", CL: "America/Santiago", CO: "America/Bogota",
  GB: "Europe/London", IE: "Europe/Dublin", DE: "Europe/Berlin", FR: "Europe/Paris", ES: "Europe/Madrid", IT: "Europe/Rome", NL: "Europe/Amsterdam", BE: "Europe/Brussels", CH: "Europe/Zurich", AT: "Europe/Vienna",
  SE: "Europe/Stockholm", NO: "Europe/Oslo", DK: "Europe/Copenhagen", FI: "Europe/Helsinki", PL: "Europe/Warsaw", PT: "Europe/Lisbon", GR: "Europe/Athens", TR: "Europe/Istanbul", UA: "Europe/Kyiv",
  IN: "Asia/Kolkata", PK: "Asia/Karachi", BD: "Asia/Dhaka", AE: "Asia/Dubai", SA: "Asia/Riyadh", IL: "Asia/Jerusalem", SG: "Asia/Singapore", MY: "Asia/Kuala_Lumpur", ID: "Asia/Jakarta", PH: "Asia/Manila",
  TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", TW: "Asia/Taipei", JP: "Asia/Tokyo", KR: "Asia/Seoul", AU: "Australia/Sydney", NZ: "Pacific/Auckland",
  ZA: "Africa/Johannesburg", NG: "Africa/Lagos", KE: "Africa/Nairobi", EG: "Africa/Cairo",
};

function zoned(date: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), min: Number(parts.minute), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!) };
}
const dateKey = (date: Date, tz: string) => {
  const z = zoned(date, tz);
  return `${z.y}-${z.m}-${z.d}`;
};
const cityOf = (tz: string) => tz.split("/").pop()!.replace(/_/g, " ");
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
function hourWords(h: number): string {
  if (h === 0) return "midnight";
  if (h === 12) return "noon";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/** The audience's time zone: the app's first target country, else the workspace's. */
export function audienceTimeZone(app: Pick<App, "targetCountries">, workspaceTz: string): { tz: string; why: string } {
  const c = app.targetCountries[0]?.toUpperCase();
  const tz = c ? COUNTRY_TZ[c] : undefined;
  if (c && tz) return { tz, why: `${cityOf(tz)} time (${countryName(c)}, your app’s ${app.targetCountries.length > 1 ? "first " : ""}target country)` };
  return { tz: workspaceTz, why: workspaceTz === "UTC" ? "UTC (no target country set, so your workspace time zone)" : `${cityOf(workspaceTz)} time (your workspace time zone; no target country set)` };
}

interface Timing {
  basis: PostTimeBasis;
  tz: string;
  hour: number;
  /** Preferred weekdays, best first (may be fewer than the pace; the rest are spread out). */
  days: number[];
  reason: string;
}

/** The app's own published posts on this channel with platform-reported views (same rule as suggestTimes: ≥ 6 posts, ≥ 2 days with ≥ 2 posts each). */
async function ownResultsTiming(ws: WorkspaceDb, appId: string, channel: Channel, tz: string): Promise<Timing | null> {
  const pubs = (await ws.collection("publications").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((x) => x.channel === channel);
  if (pubs.length < 6) return null;
  const views = (await ws.collection("metricObservations").list({ where: [["appId", "==", appId], ["metric", "==", "views"]], orderBy: { field: "windowStart", dir: "desc" }, limit: 1000 })).items.filter((o) => o.publicationId && o.attribution === "platform_reported");
  const byPub = new Map<string, number>();
  for (const o of views) byPub.set(o.publicationId!, Math.max(byPub.get(o.publicationId!) ?? 0, o.value));
  const buckets = new Map<number, { sum: number; n: number; hours: number[] }>();
  for (const pub of pubs) {
    const v = byPub.get(pub.id);
    if (v === undefined) continue;
    const z = zoned(new Date(pub.publishedAt), tz);
    const b = buckets.get(z.weekday) ?? { sum: 0, n: 0, hours: [] };
    b.sum += v;
    b.n++;
    b.hours.push(z.h);
    buckets.set(z.weekday, b);
  }
  const ranked = [...buckets.entries()].filter(([, b]) => b.n >= 2).sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n);
  if (ranked.length < 2) return null;
  const [day, best] = ranked[0]!;
  const hour = [...best.hours].sort((x, y) => x - y)[Math.floor(best.hours.length / 2)]!;
  const total = [...buckets.values()].reduce((s, x) => s + x.n, 0);
  return {
    basis: "your_results",
    tz,
    hour,
    days: ranked.map(([d]) => d),
    reason: `Based on your ${channelName(channel)} results: posts on ${WEEKDAY[day]}s averaged ${Math.round(best.sum / best.n)} platform-reported views (${best.n} of ${total} posts). A pattern in a small sample, not proof that the time caused it.`,
  };
}

/** The founder's own YouTube channel (analysed in Insights): when its uploads got the most views per day. Days and hours are UTC there. */
async function youtubeTiming(ws: WorkspaceDb, appId: string, channel: Channel): Promise<Timing | null> {
  const mine = (await ws.collection("youtubeAnalyses").list({ where: [["appId", "==", appId]], limit: 20 })).items.filter((a: YouTubeChannelAnalysis) => a.relation === "mine").sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0];
  if (!mine) return null;
  const MIN = 3; // analytics MIN_GROUP: smaller groups are never used for a pattern
  const hours = mine.stats.byHour.filter((g) => g.videos >= MIN && g.medianViewsPerDay !== null);
  if (hours.length < 2) return null;
  const bestHour = [...hours].sort((a, b) => b.medianViewsPerDay! - a.medianViewsPerDay!)[0]!;
  const days = mine.stats.byWeekday.filter((g) => g.videos >= MIN && g.medianViewsPerDay !== null).sort((a, b) => b.medianViewsPerDay! - a.medianViewsPerDay!);
  const dayNums = days.length >= 2 ? days.map((g) => YT_DAY[g.key.replace("weekday:", "")]!).filter((d) => d !== undefined) : [];
  const start = Number(bestHour.key.replace("hour:", ""));
  const elsewhere = channel !== "youtube" ? ` That’s your YouTube audience; ${channelName(channel)} may differ.` : "";
  const dayText = dayNums.length ? ` Best day: ${WEEKDAY[dayNums[0]!]} (UTC, median ${days[0]!.medianViewsPerDay} views a day, ${days[0]!.videos} videos).` : "";
  return {
    basis: "your_youtube",
    tz: "UTC",
    hour: start + 1,
    days: dayNums,
    reason: `Based on your YouTube views: uploads posted ${bestHour.label} had the most views per day (median ${bestHour.medianViewsPerDay}, ${bestHour.videos} videos, YouTube Data API ${mine.fetchedAt.slice(0, 10)}).${dayText}${elsewhere} A pattern, not proof.`,
  };
}

function suggestedTiming(app: Pick<App, "targetCountries">, channel: Channel, workspaceTz: string): Timing {
  const h = CHANNEL_HOUR[channel] ?? { hour: 18, why: "early evening is a general starting point" };
  const { tz, why } = audienceTimeZone(app, workspaceTz);
  return { basis: "suggested", tz, hour: h.hour, days: [], reason: `Suggested time: ${h.why}; ${hourWords(h.hour)} ${why}. Not based on your own data yet.` };
}

/** Where the time comes from: the app's own results on this channel, else its YouTube views, else a labelled suggestion. */
export async function postingTiming(ws: WorkspaceDb, app: Pick<App, "id" | "targetCountries">, channel: Channel, workspaceTz: string): Promise<Timing> {
  return (await ownResultsTiming(ws, app.id, channel, workspaceTz)) ?? (await youtubeTiming(ws, app.id, channel)) ?? suggestedTiming(app, channel, workspaceTz);
}

export interface WeekSlot {
  at: string;
  /** In the workspace's time zone, e.g. "Thu 7:00 PM". */
  localTime: string;
  basis: PostTimeBasis;
  reason: string;
}

/**
 * The next `count` posting slots for an app at `pace`: one post a day on the pace's days (the data's
 * best days first when there are any, then spread across the week), skipping days that already
 * have a post in the queue. Each slot says where its time comes from.
 */
export async function weekSlots(ws: WorkspaceDb, app: Pick<App, "id" | "targetCountries">, opts: { pace: number; channel: Channel; count: number; workspaceTz: string; now: number }): Promise<{ slots: WeekSlot[]; timing: Timing }> {
  const timing = await postingTiming(ws, app, opts.channel, opts.workspaceTz);
  const days = [...new Set([...timing.days, ...(DEFAULT_DAYS[opts.pace] ?? DEFAULT_DAYS[1]!), ...DEFAULT_DAYS[7]!])].slice(0, Math.max(1, Math.min(7, opts.pace)));
  const queue = await postQueue(ws, app.id, opts.now);
  const taken = new Set(queue.upcoming.map((x) => dateKey(new Date(x.scheduledAt!), timing.tz)));
  const slots: WeekSlot[] = [];
  for (let i = 0; i < 35 && slots.length < opts.count; i++) {
    const day = zoned(new Date(opts.now + i * DAY_MS), timing.tz);
    if (!days.includes(day.weekday)) continue;
    const at = zonedToUtc(day.y, day.m, day.d, timing.hour, 0, timing.tz);
    if (at.getTime() < opts.now + LEAD_MS) continue;
    const key = dateKey(at, timing.tz);
    if (taken.has(key)) continue;
    taken.add(key);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: opts.workspaceTz, weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
    slots.push({ at: at.toISOString(), localTime: local, basis: timing.basis, reason: clip(timing.reason, 500) });
  }
  return { slots, timing };
}

/** "suggested time" vs "based on your YouTube views" — what the post's stored reason says. */
export function timeBasisOf(reason: string | undefined): PostTimeBasis | undefined {
  if (!reason) return undefined;
  if (reason.startsWith("Based on your YouTube views")) return "your_youtube";
  if (reason.startsWith("Based on your ")) return "your_results";
  if (reason.startsWith("Suggested time")) return "suggested";
  return undefined;
}

// ---------------------------------------------------------------------------
// Inside the loop
// ---------------------------------------------------------------------------

interface LoopAlwaysOn {
  app: App;
  view: AlwaysOnView;
  workspace: Workspace | null;
}

/** The app's Always-on settings as the loop sees them now; null (and the marker cleared) when it was turned off. */
async function current(env: LoopEnv): Promise<LoopAlwaysOn | null> {
  if (!env.ap.alwaysOn) return null;
  const [app, workspace] = await Promise.all([env.ws.collection("apps").getOrThrow(env.appId), env.p.db.top("workspaces").get(env.ctx.workspaceId)]);
  const view = alwaysOnView(env.p, app, workspace);
  if (!view.on) {
    env.set({ alwaysOn: undefined });
    env.note("decision", "Always on was turned off for this app, so this run finishes like a one-off run.");
    return null;
  }
  return { app, view, workspace };
}

/** The founder-approved focus of this round, as a line for Wonder's decisions ("" when none). */
export function alwaysOnFocusLine(env: LoopEnv): string {
  const f = env.ap.alwaysOn?.roundFocus;
  return f ? `Focus of this round (the founder approved this from this week's research): ${f}` : "";
}

/** Newest finished research for this app in the last 7 days that saved sourced findings (the weekly sweep or an earlier round's). */
/** The findings a research run saved or found again (a finding found again keeps its first run's id, so the agent run's outputs are read). */
export async function runFindings(ws: WorkspaceDb, run: Pick<ResearchRun, "id" | "agentRunId">): Promise<ResearchFinding[]> {
  const agentRun = run.agentRunId ? await ws.collection("agentRuns").get(run.agentRunId) : null;
  const ids = [...new Set((agentRun?.outputRefs ?? []).filter((r) => r.entity === "researchFindings").map((r) => r.id))];
  const own = (await ws.collection("researchFindings").list({ where: [["runId", "==", run.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 })).items;
  const more = await ws.collection("researchFindings").getMany(ids.filter((id) => !own.some((f) => f.id === id)));
  return [...own, ...more];
}

export async function freshResearch(ws: WorkspaceDb, appId: string, now: number): Promise<ResearchRun | null> {
  const runs = (await ws.collection("researchRuns").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items;
  return runs.find((r) => (r.status === "succeeded" || r.status === "partial") && r.findingCount > 0 && now - Date.parse(r.completedAt ?? r.updatedAt) < WEEK_MS) ?? null;
}

/** research (always on): reuse this week's research instead of paying for it again. Null = research as usual. */
export async function alwaysOnResearch(env: LoopEnv): Promise<Outcome | null> {
  if (!(await current(env))) return null;
  const rr = await freshResearch(env.ws, env.appId, nowMs(env.p));
  if (!rr) return null;
  env.set({ researchRunId: rr.id });
  env.note("observation", `Using this week’s research (${rr.findingCount} sourced finding${rr.findingCount === 1 ? "" : "s"}, ${(rr.completedAt ?? rr.updatedAt).slice(0, 10)}) instead of researching again.`, [{ entity: "researchRuns", id: rr.id }]);
  return { kind: "advance", to: "select_audience" };
}

/** schedule (always on): spread this round's posts over the next free posting days. */
export async function alwaysOnTimes(env: LoopEnv, channel: Channel, count: number, workspaceTz: string): Promise<{ items: { at: string; reason: string }[]; spreadLabel: string } | null> {
  const ao = await current(env);
  if (!ao) return null;
  const { slots, timing } = await weekSlots(env.ws, ao.app, { pace: ao.view.pace, channel, count, workspaceTz, now: nowMs(env.p) });
  const label = timing.basis === "your_youtube" ? "based on your YouTube views" : timing.basis === "your_results" ? "from your own results" : "suggested times, not based on your data yet";
  return { items: slots.map((s) => ({ at: s.at, reason: s.reason })), spreadLabel: `spread across the week at ${paceWords(ao.view.pace)}: ${slots.map((s) => s.localTime).join(", ")}; ${label}` };
}

/**
 * measure (always on): go on to the next round as soon as the coming week isn't covered (or the
 * founder approved a suggestion); otherwise wait until the next post goes out. Never piles up
 * unapproved drafts. Null = not always on (the one-off measure runs).
 */
export async function alwaysOnMeasure(env: LoopEnv): Promise<Outcome | null> {
  const ao = await current(env);
  if (!ao) return null;
  const now = nowMs(env.p);
  const q = await postQueue(env.ws, env.appId, now);
  const pace = ao.view.pace;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: ao.workspace?.settings.defaultTimezone ?? "UTC" });
  if (env.ap.alwaysOn?.focus) {
    env.note("decision", `You approved a suggestion from this week’s research, so the next round starts now: ${clip(env.ap.alwaysOn.focus.text, 300)}`, [{ entity: "approvals", id: env.ap.alwaysOn.focus.approvalId }]);
    return { kind: "advance", to: "learn" };
  }
  if (q.upcoming.length < pace) {
    // Short for the coming week, but many posts still wait for approval: wait for the person instead of piling up more.
    if (q.awaiting.length >= backlogLimit(pace)) {
      const until = new Date(now + DAY_MS).toISOString();
      const summary = `Waiting for you: ${q.awaiting.length} post${q.awaiting.length === 1 ? "" : "s"} need your approval before Always on makes more.`;
      if (env.fullLog[env.fullLog.length - 1]?.summary !== summary) env.note("checkpoint", summary, q.awaiting.slice(0, 10).map((x) => ({ entity: "scheduledPosts", id: x.id })));
      return { kind: "sleep", until, tag: "measure", reason: summary };
    }
    env.note("decision", `${q.upcoming.length} of ${pace} post${pace === 1 ? "" : "s"} ready for the coming week (${paceWords(pace)}): starting the next round now. Results so far are read first.`);
    return { kind: "advance", to: "learn" };
  }
  // The week is covered: wake when the next post has gone out (the cron also wakes it early when a post is rejected or a suggestion approved).
  const until = new Date(Math.max(now + 3_600_000, Date.parse(q.upcoming[0]!.scheduledAt!) + 60_000)).toISOString();
  const summary = `${q.upcoming.length} posts ready for the coming week (${paceWords(pace)}). The next round starts after the ${day(q.upcoming[0]!.scheduledAt!)} post goes out.`;
  if (env.fullLog[env.fullLog.length - 1]?.summary !== summary) env.note("action", summary, q.upcoming.slice(0, 10).map((x) => ({ entity: "scheduledPosts", id: x.id })));
  return { kind: "sleep", until, tag: "measure", reason: `Always on: ${q.upcoming.length} posts ready; next round after ${day(q.upcoming[0]!.scheduledAt!)}` };
}

/** Instructions for Wonder's next-round decision while always on (the round itself always happens). */
export const ALWAYS_ON_NEXT_INSTRUCTIONS =
  "Always on: another round WILL run to keep the founder's posting pace, so set continueLoop to true and decide only what the next round should test differently or double down on, based on measured results, the recommendations and remembered lessons. With little or no measured data, say so and keep the next test simple. Call plan_next_iteration.";

/** Tag of an always-on loop waiting at `learn` for its weekly allowance or for credits. */
export const NEXT_ROUND_TAG = "learn:always-on";

/**
 * learn (always on): start the next round within the weekly allowance and the workspace's credits.
 * Out of allowance → wait for it to free up. Out of credits → a Needs-you decision (lower the pace
 * or add credits), and nothing more is made until then. Null = not always on.
 */
export async function alwaysOnNextRound(env: LoopEnv): Promise<Outcome | null> {
  const ao = await current(env);
  if (!ao) return null;
  const p = env.p;
  const now = nowMs(p);
  const pace = ao.view.pace;
  const focus = env.ap.alwaysOn?.focus;
  const q = await postQueue(env.ws, env.appId, now);
  const variants = nextRoundVariants(pace, q.upcoming.length);
  const fresh = await freshResearch(env.ws, env.appId, now);
  const cost = roundCredits(p, variants, !fresh);
  const allowance = weeklyAllowance(p, pace);
  const used = await alwaysOnSpent(env.ws, env.appId, now - WEEK_MS);
  const once = (kind: Parameters<LoopEnv["note"]>[0], summary: string) => {
    if (env.fullLog[env.fullLog.length - 1]?.summary !== summary) env.note(kind, summary);
  };
  // An approved suggestion is the founder's OK for that one round, even past this week's allowance.
  if (!focus && used + cost > allowance) {
    once("budget", `This week’s Always on allowance is used: ${used} of ${allowance} credits in the last 7 days, and the next round needs up to ${cost}. It starts when the allowance frees up; nothing is spent past it without you.`);
    return { kind: "sleep", until: new Date(now + DAY_MS).toISOString(), tag: NEXT_ROUND_TAG, reason: "Waiting for this week’s credit allowance" };
  }
  const balance = await p.credits.balance(env.ctx.workspaceId);
  if (balance.available < cost) {
    const approval = await openPaceDecision(p, env.ctx.workspaceId, ao.app, { pace, needed: cost, available: balance.available, plan: ao.view.plan });
    once("budget", `Not enough credits for the next round: it needs up to ${cost} and the workspace has ${Math.max(0, balance.available)}. Asked you in Needs you: a lower pace or more credits. Nothing more is made until then.`);
    env.note("checkpoint", "Always on needs a decision about its pace", [{ entity: "approvals", id: approval.id }]);
    return { kind: "sleep", until: new Date(now + DAY_MS).toISOString(), tag: NEXT_ROUND_TAG, reason: "Waiting for credits (see Needs you)" };
  }
  if (focus) await env.ws.collection("approvals").update(focus.approvalId, { status: "consumed", note: "A round of videos about it started" }, { actor: env.ctx.actor }).catch(() => undefined);
  const spent = await env.spent();
  env.set({
    iteration: env.iteration + 1,
    budget: { ...env.ap.budget, variants, maxCredits: Math.max(1, spent + cost) },
    alwaysOn: { since: env.ap.alwaysOn!.since, roundFocus: focus?.text },
    audience: undefined,
    hypothesis: undefined,
    researchRunId: undefined,
    campaignId: undefined,
    variantIds: [],
    compositionIds: [],
    reviewIds: [],
    scheduledPostIds: [],
    recommendationIds: [],
  });
  env.note(
    "decision",
    `Always on: round ${env.iteration} starts (${variants} video${variants === 1 ? "" : "s"}, up to ${cost} credits${fresh ? ", reusing this week’s research" : ", with new research"}). ${q.upcoming.length} of ${pace} posts are ready for the coming week; ${used} of the ${allowance}-credit weekly allowance used.${focus ? ` Focus: ${clip(focus.text, 200)}` : ""}`,
    focus ? [{ entity: "approvals", id: focus.approvalId }] : [],
  );
  return { kind: "advance", to: "research" };
}

// ---------------------------------------------------------------------------
// Needs you: the pace decision and research suggestions
// ---------------------------------------------------------------------------

export const isPaceDecision = (a: Pick<Approval, "requestedBy" | "subject">) => a.requestedBy === ALWAYS_ON_ACTOR && a.subject.entity === "apps";
export const isSuggestion = (a: Pick<Approval, "requestedBy" | "subject">) => a.requestedBy === ALWAYS_ON_ACTOR && (a.subject.entity === "opportunities" || a.subject.entity === "researchFindings");

/** One pending pace decision per app ("Always on can't keep N posts a week"); refreshed, never duplicated. */
export async function openPaceDecision(p: Platform, workspaceId: string, app: Pick<App, "id" | "name">, input: { pace: number; needed: number; available: number; plan: Plan }): Promise<Approval> {
  const ws = p.db.ws(workspaceId);
  const lower = ALWAYS_ON_PACES.filter((x) => x < input.pace).pop();
  const month = monthlyFromWeekly(weeklyAllowance(p, input.pace));
  const summary = clip(
    `Always on needs up to ${input.needed} credits for the next videos and the workspace has ${Math.max(0, input.available)}. At ${paceWords(input.pace)} it can use up to about ${month} credits a month; your ${input.plan.name} plan includes ${input.plan.monthlyCredits}. ` +
      (lower ? `Lower the pace to ${paceWords(lower)} so your credits go further, or keep it and add credits in Settings → Credits & billing.` : `Add credits in Settings → Credits & billing, or turn Always on off.`) +
      " Nothing more is made until there are enough credits.",
    1000,
  );
  const existing = (await ws.collection("approvals").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 })).items.find((a) => isPaceDecision(a) && a.status === "pending");
  if (existing) return existing.summary === summary ? existing : ws.collection("approvals").update(existing.id, { summary, estimate: { credits: input.needed } }, { actor: ALWAYS_ON_ACTOR });
  return ws.collection("approvals").create(
    {
      appId: app.id,
      action: "agent_continue",
      subject: { entity: "apps", id: app.id },
      snapshotHash: shortHash(`always-on:pace:${app.id}:${input.pace}`),
      summary,
      requestedBy: ALWAYS_ON_ACTOR,
      status: "pending",
      expiresAt: new Date(nowMs(p) + WEEK_MS).toISOString(),
      estimate: { credits: input.needed },
    },
    { actor: ALWAYS_ON_ACTOR },
  );
}

/** The lower pace a pace decision offers (null when already once a week: then it offers turning Always on off). */
export const lowerPaceThan = (pace: number): AlwaysOnPace | null => ALWAYS_ON_PACES.filter((x) => x < pace).pop() ?? null;

/** Needs-you card for one of Always on's approvals (null: not one of them, or no longer current). */
export function alwaysOnNeedsYouItem(
  a: Approval,
  base: Pick<NeedsYouItem, "id" | "action" | "appId" | "createdAt" | "subject" | "credits" | "stale">,
  has: (c: Capability) => boolean,
  app: Pick<App, "id" | "alwaysOn"> | undefined,
): NeedsYouItem | null {
  if (!a.appId || a.requestedBy !== ALWAYS_ON_ACTOR) return null;
  if (!app?.alwaysOn?.enabled) return null;
  // Same capability as the Autopilot checkpoints these stand in for (agent_continue → content.approve).
  const cap: Capability = "content.approve";
  const root = `/apps/${a.appId}/always-on`;
  if (isPaceDecision(a)) {
    const lower = lowerPaceThan(app.alwaysOn.postsPerWeek);
    return {
      ...base,
      kind: "decision",
      title: clip(`Always on can’t keep ${paceWords(app.alwaysOn.postsPerWeek)} with the credits left`, 200),
      summary: a.summary,
      requiredCap: cap,
      canDecide: has(cap),
      approve: { path: `${root}/pace/approve`, body: {} },
      reject: { path: `${root}/pace/reject`, body: {} },
      reviewPath: "/settings/credits",
      labels: lower
        ? { approve: `Lower to ${paceWords(lower)}`, reject: "Keep the pace", approved: `Always on now aims for ${paceWords(lower)}.`, rejected: "Kept. Always on carries on once there are enough credits." }
        : { approve: "Turn Always on off", reject: "Keep it on", approved: "Always on is off. Nothing more is made on its own.", rejected: "Kept. Always on carries on once there are enough credits." },
    };
  }
  if (isSuggestion(a)) {
    const title = a.summary.split("\n")[0] ?? a.summary;
    return {
      ...base,
      kind: "suggestion",
      title: clip(title, 200),
      summary: a.summary.split("\n").slice(1).join(" ").trim() || a.summary,
      requiredCap: cap,
      canDecide: has(cap),
      approve: { path: `${root}/suggestions/${a.id}/approve`, body: {} },
      reject: { path: `${root}/suggestions/${a.id}/reject`, body: {} },
      reviewPath: `/a/${a.appId}/discover`,
      labels: { approve: "Make a video", reject: "Not now", approved: "A round of videos about it starts next. Every post still waits for your approval.", rejected: "Noted. It stays in Discover if you change your mind." },
    };
  }
  return null;
}

