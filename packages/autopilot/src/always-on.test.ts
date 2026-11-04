import { DEFAULT_PLANS, type Autopilot, type PlanId, type WorkspaceMember, type YouTubeChannelAnalysis } from "@muselaunch/contracts";
import { installAnalyticsHooks } from "@muselaunch/analytics";
import { configureGrowth } from "@muselaunch/growth";
import { loadPlans } from "@muselaunch/platform";
import { GMAIL_SEND_URL } from "@muselaunch/providers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { alwaysOnState, alwaysOnStatus, decidePace, decideSuggestion, runAlwaysOn, updateAlwaysOn, weeklySummary } from "./always-on";
import { ALWAYS_ON_ACTOR, alwaysOnSpent, clampPace, FIX_ROOM_ROUNDS, postQueue, runFindings, SUGGESTIONS_PER_WEEK, sweepKeyPrefix, timeBasisOf, weekSlots, weeklyAllowance } from "./always-on-loop";
import { MAX_FIX_ROUNDS, needsYou, wakeDueAutopilots } from "./index";
import { hashId, tagOf } from "./state";
import { autopilotHarness, type AutopilotHarness } from "./testing";

type Member = Pick<WorkspaceMember, "role" | "canPublish" | "canManageAccounts" | "status">;
const OWNER: Member = { role: "owner", canPublish: true, canManageAccounts: true, status: "active" };
const EDITOR: Member = { role: "editor", canPublish: false, canManageAccounts: false, status: "active" };
const DAY = 86_400_000;

/** A seeded app (App DNA confirmed, real screenshots, target country US) in a workspace on `plan`, with an owner (u1) and an editor (u2). */
async function setup(opts: { plan?: PlanId } = {}) {
  const h = await autopilotHarness({ workspaceId: `ws_ao_${Math.random().toString(36).slice(2, 8)}` });
  await h.p.db.top("workspaces").update(h.wid, { planId: opts.plan ?? "studio" });
  const ws = h.p.db.ws(h.wid);
  await ws.collection("members").create({ id: "u1", userId: "u1", role: "owner", canPublish: true, canManageAccounts: true, status: "active" }, { actor: "u1" });
  await ws.collection("members").create({ id: "u2", userId: "u2", role: "editor", status: "active" }, { actor: "u1" });
  return { ...h, ws };
}
type H = Awaited<ReturnType<typeof setup>>;

const loopsOf = async (h: AutopilotHarness) => (await h.p.db.ws(h.wid).collection("autopilots").list({ where: [["appId", "==", h.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items as Autopilot[];
const theLoop = async (h: AutopilotHarness) => (await loopsOf(h))[0]!;
const postsOf = async (h: AutopilotHarness) => (await h.p.db.ws(h.wid).collection("scheduledPosts").list({ where: [["appId", "==", h.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 })).items;
const nyParts = (iso: string) => {
  const f = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", hour: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { weekday: f.weekday!, hour: Number(f.hour), date: `${f.year}-${f.month}-${f.day}` };
};

describe("Always on: pace by plan", () => {
  it("plans allow 1 / 3 / 5 / 7 posts a week; a PLANS_JSON override without the field keeps the default", () => {
    expect(Object.fromEntries(Object.values(DEFAULT_PLANS).map((pl) => [pl.id, pl.limits.postsPerWeek]))).toEqual({ free: 1, starter: 3, growth: 5, studio: 7 });
    const plans = loadPlans({ PLANS_JSON: JSON.stringify({ starter: { id: "starter", name: "Starter+", monthlyCredits: 2000, limits: { apps: 4 } } }) });
    expect(plans.starter.limits).toMatchObject({ apps: 4, postsPerWeek: 3, researchRunsPerDay: 10 });
    expect(plans.starter.monthlyCredits).toBe(2000);
    expect([clampPace(7, 3), clampPace(5, 3), clampPace(3, 1), clampPace(7, 7), clampPace(5, 6)]).toEqual([3, 3, 1, 7, 5]);
    // Budgets keep room for exactly the loop's automatic fix rounds.
    expect(FIX_ROOM_ROUNDS).toBe(MAX_FIX_ROUNDS);
  });

  it("refuses a pace above the plan (naming the plan that allows it), shows the options, and clamps after a downgrade", async () => {
    const h = await setup({ plan: "starter" });
    await expect(updateAlwaysOn(h.p, h.wid, h.appId, { enabled: true, postsPerWeek: 5 }, { member: OWNER, actor: "u1" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      opts: { userMessage: "Your Starter plan allows up to 3 posts a week. 5 times a week needs the Growth plan or higher." },
    });
    // Same capability as starting Autopilot: viewers can't change it.
    await expect(updateAlwaysOn(h.p, h.wid, h.appId, { enabled: true }, { member: { ...EDITOR, role: "viewer" }, actor: "u3" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { status } = await updateAlwaysOn(h.p, h.wid, h.appId, { enabled: true, postsPerWeek: 3 }, { member: EDITOR, actor: "u2" });
    expect(status.settings).toMatchObject({ enabled: true, postsPerWeek: 3, emailSummary: false });
    expect(status.options.map((o) => [o.postsPerWeek, o.allowed, o.minPlan?.name])).toEqual([
      [1, true, undefined],
      [3, true, undefined],
      [5, false, "Growth"],
      [7, false, "Studio"],
    ]);
    // Weekly credits: the videos at the pace plus one research sweep; compared with the plan's monthly credits.
    expect(status.estimate.weeklyCredits).toBe(weeklyAllowance(h.p, 3));
    // 3 videos at the longest length with fix room (69 each), 2 rounds of ideas + reading results (33 each), 1 research sweep (40).
    expect(status.estimate).toMatchObject({ weeklyCredits: 3 * 69 + 2 * 33 + 40, sweep: 40, perVideo: 91 });
    expect(status.estimate.monthlyCredits).toBe(Math.round((status.estimate.weeklyCredits * 30) / 7));
    expect(status.estimate.fitsPlan).toBe(status.estimate.monthlyCredits <= 1500);
    expect(status.plan).toMatchObject({ id: "starter", postsPerWeek: 3, monthlyCredits: 1500 });

    // Downgrade to Free: the pace is clamped at once (read), and the cron stores it with a plain note.
    await h.p.db.top("workspaces").update(h.wid, { planId: "free" });
    const clamped = await alwaysOnStatus(h.p, h.wid, h.appId);
    expect(clamped.settings.postsPerWeek).toBe(1);
    expect(clamped.requestedPostsPerWeek).toBe(3);
    expect(clamped.notes[0]).toMatch(/Free beta plan allows up to 1 post a week, so Always on uses 1 post a week \(you chose 3 posts a week\)/);
    const tick = await runAlwaysOn(h.p);
    expect(tick.clamped).toBe(1);
    expect((await h.ws.collection("apps").getOrThrow(h.appId)).alwaysOn?.postsPerWeek).toBe(1);
    expect((await alwaysOnState(h.ws, h.appId)).notes.map((n) => n.text)).toContain("Your Free beta plan allows up to 1 post a week, so the pace went down from 3 posts a week to 1 post a week.");
  });
});

describe("Always on: when to post", () => {
  it("spreads posts over the pace's days at a labelled suggested time in the audience's time zone, skipping days already taken", async () => {
    const h = await setup();
    const app = await h.ws.collection("apps").getOrThrow(h.appId);
    const now = Date.parse("2026-11-02T12:00:00Z"); // a Monday
    const { slots, timing } = await weekSlots(h.ws, app, { pace: 3, channel: "instagram", count: 4, workspaceTz: "UTC", now });
    expect(timing.basis).toBe("suggested");
    expect(slots.map((s) => [nyParts(s.at).weekday, nyParts(s.at).hour])).toEqual([
      ["Mon", 19],
      ["Wed", 19],
      ["Fri", 19],
      ["Mon", 19],
    ]);
    for (const s of slots) {
      expect(s.basis).toBe("suggested");
      expect(s.reason).toMatch(/^Suggested time: early evening is a common starting point for Instagram Reels; 7 PM New York time \(United States, your app’s target country\)\. Not based on your own data yet\.$/);
    }
    expect(new Set(slots.map((s) => nyParts(s.at).date)).size).toBe(4);
    // Every day: seven different days in a row.
    const daily = await weekSlots(h.ws, app, { pace: 7, channel: "tiktok", count: 7, workspaceTz: "UTC", now });
    expect(new Set(daily.slots.map((s) => nyParts(s.at).date)).size).toBe(7);
    expect(Date.parse(daily.slots[6]!.at) - Date.parse(daily.slots[0]!.at)).toBe(6 * DAY);
  });

  it("uses the founder's own YouTube views when they say when the audience watches (labelled), never smaller groups", async () => {
    const h = await setup();
    const app = await h.ws.collection("apps").getOrThrow(h.appId);
    const g = (key: string, label: string, videos: number, medianViewsPerDay: number) => ({ key, label, videos, medianViews: medianViewsPerDay * 10, medianViewsPerDay, medianEngagementRate: null, videoIds: [] });
    const analysis = (byHour: ReturnType<typeof g>[], byWeekday: ReturnType<typeof g>[]) =>
      ({
        appId: h.appId,
        input: "@tidytimer",
        relation: "mine",
        connectedChannel: true,
        channel: { id: "UC123", title: "Tidy Timer", url: "https://www.youtube.com/@tidytimer", subscriberCount: 1200, viewCount: 50000, videoCount: 30 },
        fetchedAt: "2026-10-30T10:00:00.000Z",
        videos: [],
        stats: {
          videosAnalyzed: 12,
          excluded: [],
          window: null,
          totals: { views: 0, likes: 0, comments: 0, videosWithHiddenLikes: 0, videosWithCommentsOff: 0 },
          medians: { views: null, likes: null, comments: null, engagementRate: null, viewsPerDay: null },
          meanViews: null,
          topByViews: [],
          topByViewsPerDay: [],
          byLength: [],
          byWeekday,
          byHour,
          titlePatterns: [],
          cadence: { uploadsPerWeek: null, medianDaysBetween: null },
          notes: [],
        },
        keyFindings: [],
        interpretation: { status: "unavailable" },
        sources: [],
        quota: { units: 3, calls: [] },
      }) as unknown as Omit<YouTubeChannelAnalysis, "id" | "workspaceId" | "createdAt" | "updatedAt" | "createdBy">;
    // Groups of 2 videos are too small to say anything: still a suggestion.
    const small = await h.ws.collection("youtubeAnalyses").create(analysis([g("hour:16", "16:00–19:59 UTC", 2, 90), g("hour:08", "08:00–11:59 UTC", 2, 10)], []), { actor: "u1" });
    expect((await weekSlots(h.ws, app, { pace: 3, channel: "youtube", count: 1, workspaceTz: "UTC", now: Date.parse("2026-11-02T12:00:00Z") })).timing.basis).toBe("suggested");
    await h.ws.collection("youtubeAnalyses").delete(small.id);
    await h.ws.collection("youtubeAnalyses").create(
      analysis([g("hour:16", "16:00–19:59 UTC", 5, 90), g("hour:08", "08:00–11:59 UTC", 4, 10)], [g("weekday:thu", "Thursday", 4, 120), g("weekday:mon", "Monday", 3, 40)]),
      { actor: "u1" },
    );
    const { slots, timing } = await weekSlots(h.ws, app, { pace: 1, channel: "instagram", count: 2, workspaceTz: "UTC", now: Date.parse("2026-11-02T12:00:00Z") });
    expect(timing.basis).toBe("your_youtube");
    expect(slots.map((s) => s.at)).toEqual(["2026-11-05T17:00:00.000Z", "2026-11-12T17:00:00.000Z"]); // Thursdays, 17:00 UTC (middle of the best block)
    expect(slots[0]!.reason).toMatch(/^Based on your YouTube views: uploads posted 16:00–19:59 UTC had the most views per day \(median 90, 5 videos/);
    expect(slots[0]!.reason).toMatch(/That’s your YouTube audience; Instagram may differ\. A pattern, not proof\.$/);
    // Every stored reason maps to its label, including the one-off run's (growth suggestTimes) wording.
    expect(timeBasisOf(slots[0]!.reason)).toBe("your_youtube");
    expect(timeBasisOf("Suggested time: early evening …")).toBe("suggested");
    expect(timeBasisOf("Midweek late-morning and evening slots are common starting points for Reels. General starting point — not based on research or your data yet.")).toBe("suggested");
    expect(timeBasisOf("Your instagram posts published on Wednesdays averaged 812 platform-reported views (3 of 7 posts).")).toBe("your_results");
    expect(timeBasisOf("Picked by hand")).toBeUndefined();
  });
});

/** Enable Always on and let the first rounds run. */
async function enableAndRun(h: H, pace: 1 | 3 | 5 | 7) {
  const out = await updateAlwaysOn(h.p, h.wid, h.appId, { enabled: true, postsPerWeek: pace }, { member: OWNER, actor: "u1" });
  await h.p.inline!.drain();
  return out;
}

describe("Always on: the loop keeps going", () => {
  it("rounds go on past the round cap until the coming week is covered, reuse this week's research, wait for approvals, and carry on when the queue runs low", async () => {
    const h = await setup();
    const { start } = await enableAndRun(h, 3);
    expect(start).toMatchObject({ started: true });
    let ap = await theLoop(h);
    // Round 1 made 2 posts (< 3): round 2 started at once, past maxIterations 1, made only the 1 still needed, and the week was covered.
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure", iteration: 2, budget: { maxIterations: 1, variants: 1 } });
    expect(ap.alwaysOn?.since).toBeTruthy();
    expect(tagOf(ap.waitingOn.reason)).toBe("measure");
    expect(ap.log.some((e) => e.summary.startsWith("2 of 3 posts ready for the coming week (3 posts a week): starting the next round now"))).toBe(true);
    expect(ap.log.some((e) => /^Always on: round 2 starts \(1 video, up to \d+ credits, reusing this week’s research\)/.test(e.summary))).toBe(true);
    expect(ap.log.some((e) => e.summary.startsWith("Using this week’s research (1 sourced finding"))).toBe(true);
    // One research run for both rounds (the second reused it).
    const jobs = (await h.ws.collection("jobs").list({ where: [["appId", "==", h.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 300 })).items;
    expect(jobs.filter((j) => j.type === "research.run")).toHaveLength(1);
    expect(jobs.filter((j) => j.type === "render.final" && j.status === "succeeded")).toHaveLength(3);
    // Three posts, each waiting for its own publish approval, on three different days at 7 PM New York (labelled suggestions).
    const posts = await postsOf(h);
    expect(posts).toHaveLength(3);
    for (const x of posts) {
      expect(x.status).toBe("awaiting_approval");
      expect(x.approvalId).toBeTruthy();
      expect(nyParts(x.scheduledAt!).hour).toBe(19);
      expect(x.suggestedTimeReason).toMatch(/^Suggested time: .* New York time/);
    }
    expect(new Set(posts.map((x) => nyParts(x.scheduledAt!).date)).size).toBe(3);
    expect(posts.some((x) => x.status === "published" || x.status === "scheduled")).toBe(false);
    // Spend so far stays within the weekly allowance at this pace.
    expect(await alwaysOnSpent(h.ws, h.appId, h.clock.now - 7 * DAY)).toBeLessThanOrEqual(weeklyAllowance(h.p, 3));

    // Two post times pass without approval: the week isn't covered, but 3 posts still wait → it waits for the person.
    const sorted = [...posts].sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
    h.clock.now = Date.parse(sorted[1]!.scheduledAt!) + 3_600_000;
    await wakeDueAutopilots(h.p);
    await h.p.inline!.drain();
    ap = await theLoop(h);
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure", iteration: 2 });
    expect(ap.waitingOn.reason).toMatch(/Waiting for you: 3 posts need your approval before Always on makes more/);
    // The person decides: the last one approved, the two late ones turned down. Now the queue is short and nothing waits: the cron wakes the loop → round 3.
    for (const [i, x] of sorted.entries()) await h.ws.collection("scheduledPosts").update(x.id, { status: i < 2 ? "draft" : "scheduled" }, { actor: "u1" });
    let tick = await runAlwaysOn(h.p);
    expect(tick.woken).toBe(1);
    await h.p.inline!.drain();
    ap = await theLoop(h);
    // This week's allowance already paid for 3 videos, so the replacements wait for it (nothing spent past it).
    expect(ap).toMatchObject({ status: "sleeping", stage: "learn", iteration: 2 });
    expect(tagOf(ap.waitingOn.reason)).toBe("learn:always-on");
    expect(ap.log.some((e) => e.kind === "budget" && e.summary.startsWith("This week’s Always on allowance is used"))).toBe(true);
    // A week after round 1 the allowance has room again: the cron wakes it and round 3 makes the 2 still needed.
    h.clock.now = Date.parse(ap.alwaysOn!.since) + 7 * DAY + 3_600_000;
    tick = await runAlwaysOn(h.p);
    expect(tick.woken).toBe(1);
    await h.p.inline!.drain();
    ap = await theLoop(h);
    // Round 3 made 2, and (the late approved post having gone by) one more round tops the week up again.
    expect(ap.iteration).toBeGreaterThanOrEqual(3);
    expect(ap.log.some((e) => /^Always on: round 3 starts \(2 videos/.test(e.summary))).toBe(true);
    const q = await postQueue(h.ws, h.appId, h.clock.now);
    expect(q.upcoming.length).toBeGreaterThanOrEqual(3);

    // Turning it off: the run finishes like a one-off run (no new rounds); open suggestions are withdrawn.
    await updateAlwaysOn(h.p, h.wid, h.appId, { enabled: false }, { member: OWNER, actor: "u1" });
    ap = await theLoop(h);
    expect(ap.alwaysOn).toBeUndefined();
    expect(ap.log.at(-1)!.summary).toMatch(/Always on turned off by you/);
  });

  it("an app's running one-off loop becomes the always-on loop instead of a second run", async () => {
    const h = await setup();
    const { startAutopilot } = await import("./service");
    const { autopilot } = await startAutopilot(h.p, h.wid, h.appId, { goal: "More installs", maxCredits: 400, maxIterations: 1, autoApproveCredits: 100, variants: 2 }, "u1");
    const { start } = await updateAlwaysOn(h.p, h.wid, h.appId, { enabled: true, postsPerWeek: 1 }, { member: OWNER, actor: "u1" });
    expect(start).toEqual({ started: false, autopilotId: autopilot.id });
    await h.p.inline!.drain();
    expect(await loopsOf(h)).toHaveLength(1);
    const ap = await theLoop(h);
    expect(ap.alwaysOn).toBeTruthy();
    expect(ap.log.some((e) => e.summary.startsWith("Always on: this run keeps going at 1 post a week"))).toBe(true);
    // At 1 a week, one round of 2 posts covers it: the loop waits for the next post instead of measuring for a fixed window.
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure", iteration: 1 });
    expect(ap.waitingOn.reason).toMatch(/^\[measure\] Always on: 2 posts ready; next round after /);
  });
});

describe("Always on: the weekly allowance and credits", () => {
  it("waits when this week's allowance is used, and goes on once it frees up", async () => {
    const h = await setup();
    // Earlier this week Always on's research already held credits (open reservations count).
    for (let i = 0; i < 5; i++) {
      const rr = await h.ws.collection("researchRuns").create({ appId: h.appId, kinds: ["trends"], status: "queued", inputs: { countries: [], languages: [], channels: [], competitorIds: [] } }, { actor: "u1" });
      await h.p.jobs.create(h.wid, "research.run", { appId: h.appId, researchRunId: rr.id, kinds: ["trends"] }, { actor: "u1", appId: h.appId, idempotencyKey: `${sweepKeyPrefix(h.appId)}held-${i}`, credits: { operation: "research.run" }, deferDispatch: true });
    }
    expect(await alwaysOnSpent(h.ws, h.appId, h.clock.now - 7 * DAY)).toBe(200);
    await enableAndRun(h, 3);
    let ap = await theLoop(h);
    // Round 1 ran (turning it on is the person's OK); round 2 would pass the 298-credit allowance → it waits.
    expect(ap).toMatchObject({ status: "sleeping", stage: "learn", iteration: 1 });
    expect(tagOf(ap.waitingOn.reason)).toBe("learn:always-on");
    const note = ap.log.find((e) => e.kind === "budget" && e.summary.startsWith("This week’s Always on allowance is used"));
    expect(note?.summary).toMatch(new RegExp(`: (\\d+) of ${weeklyAllowance(h.p, 3)} credits in the last 7 days, and the next round needs up to \\d+\\. It starts when the allowance frees up; nothing is spent past it without you\\.$`));
    const used = Number(note!.summary.match(/used: (\d+) of/)![1]);
    expect(used).toBeGreaterThan(200);
    // The cron doesn't wake it while the allowance is used…
    expect((await runAlwaysOn(h.p)).woken).toBe(0);
    // …a week later the old spend has left the window (the held jobs are released), and it carries on.
    for (const j of (await h.ws.collection("jobs").list({ where: [["appId", "==", h.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 300 })).items.filter((x) => x.status === "queued" && x.type === "research.run")) {
      await h.p.jobs.requestCancel(h.wid, j.id, "u1");
    }
    h.clock.now += 8 * DAY;
    await wakeDueAutopilots(h.p);
    await h.p.inline!.drain();
    ap = await theLoop(h);
    expect(ap.iteration).toBeGreaterThanOrEqual(2);
  });

  it("short of credits: no overspending, a Needs-you decision offering a lower pace or more credits", async () => {
    const h = await setup();
    // Spend the workspace down to 100 credits.
    const b = await h.p.credits.balance(h.wid);
    const r = await h.p.credits.reserve(h.wid, b.available - 100, { operation: "test.hold", idempotencyKey: `hold-${h.wid}`, actor: "test" });
    expect(r).toBeTruthy();
    const { start } = await updateAlwaysOn(h.p, h.wid, h.appId, { enabled: true, postsPerWeek: 3 }, { member: OWNER, actor: "u1" });
    expect(start).toMatchObject({ started: false });
    expect(start!.reason).toMatch(/^The first round needs up to \d+ credits and the workspace has 100\./);
    expect(await loopsOf(h)).toHaveLength(0);
    const owner = await needsYou(h.p, h.wid, OWNER, { appId: h.appId });
    const item = owner.items.find((i) => i.subject.entity === "apps")!;
    expect(item).toMatchObject({
      kind: "decision",
      title: "Always on can’t keep 3 posts a week with the credits left",
      requiredCap: "content.approve",
      canDecide: true,
      approve: { path: `/apps/${h.appId}/always-on/pace/approve`, body: {} },
      reject: { path: `/apps/${h.appId}/always-on/pace/reject`, body: {} },
      reviewPath: "/settings/credits",
      labels: { approve: "Lower to 1 post a week", reject: "Keep the pace" },
    });
    expect(item.summary).toMatch(/the workspace has 100\. At 3 posts a week it can use up to about \d+ credits a month; your Studio plan includes 15000\. Lower the pace to 1 post a week so your credits go further, or keep it and add credits/);
    // Editors see it but can't decide.
    expect((await needsYou(h.p, h.wid, EDITOR, { appId: h.appId })).items.find((i) => i.id === item.id)?.canDecide).toBe(false);
    await expect(decidePace(h.p, h.wid, h.appId, { decision: "approve" }, { member: EDITOR, actor: "u2" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The cron doesn't open a second one.
    await runAlwaysOn(h.p);
    expect((await h.ws.collection("approvals").list({ where: [["appId", "==", h.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 })).items.filter((a) => a.subject.entity === "apps" && a.status === "pending")).toHaveLength(1);
    // Lower the pace: decided, recorded, and the setting follows.
    const out = await decidePace(h.p, h.wid, h.appId, { decision: "approve" }, { member: OWNER, actor: "u1" });
    expect(out.approval).toMatchObject({ status: "consumed", decidedBy: "u1", note: "Pace lowered to 1 post a week" });
    expect(out.status.settings.postsPerWeek).toBe(1);
    await expect(decidePace(h.p, h.wid, h.appId, { decision: "approve" }, { member: OWNER, actor: "u1" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await loopsOf(h)).toHaveLength(0); // still nothing made without the credits
  });
});

describe("Always on: research on its own", () => {
  it("a weekly sweep (Muse Wonder, sourced) brings a few suggestions to Needs you; approving one starts a round about it, rejecting notes it", async () => {
    const h = await setup();
    await enableAndRun(h, 1);
    const before = await theLoop(h);
    expect(before).toMatchObject({ status: "sleeping", stage: "measure", iteration: 1 });

    // The cron starts this week's sweep (research.run with its own key; credits + plan quota apply).
    let tick = await runAlwaysOn(h.p);
    expect(tick).toMatchObject({ apps: 1, sweeps: 1, loopsStarted: 0 });
    let st = await alwaysOnState(h.ws, h.appId);
    const sweepJob = await h.ws.collection("jobs").getOrThrow(st.sweep!.jobId);
    expect(sweepJob).toMatchObject({ type: "research.run", createdBy: "u1" });
    expect(sweepJob.idempotencyKey.startsWith(sweepKeyPrefix(h.appId))).toBe(true);
    const run = await h.ws.collection("researchRuns").getOrThrow(st.sweep!.runId);
    expect(run.inputs.focus).toMatch(/^Always on weekly research for Tidy Timer: what is new THIS WEEK/);
    expect(run.kinds).toEqual(["trends", "competitors", "creators", "opportunities"]);
    await h.p.inline!.drain();
    // Not twice in the same week.
    expect((await runAlwaysOn(h.p)).sweeps).toBe(0);

    st = await alwaysOnState(h.ws, h.appId);
    expect(st.sweep).toMatchObject({ processed: true, status: "succeeded" });
    expect(st.sweep!.findings).toBeGreaterThan(0);
    // Findings found again keep their first run's id: the sweep's own list comes from its agent run.
    const findings = await runFindings(h.ws, await h.ws.collection("researchRuns").getOrThrow(run.id));
    expect(findings.length).toBe(st.sweep!.findings);
    for (const f of findings) for (const e of f.evidence) expect(e.url).toMatch(/^https:\/\//);
    const owner = await needsYou(h.p, h.wid, OWNER, { appId: h.appId });
    const suggestions = owner.items.filter((i) => i.kind === "suggestion");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(SUGGESTIONS_PER_WEEK);
    const first = suggestions[0]!;
    expect(first.title).toBe("This week’s research found “Study-with-me Reel using the real timer screen”: make a video about it?");
    expect(first).toMatchObject({
      requiredCap: "content.approve",
      canDecide: true,
      approve: { path: `/apps/${h.appId}/always-on/suggestions/${first.id}/approve`, body: {} },
      reject: { path: `/apps/${h.appId}/always-on/suggestions/${first.id}/reject`, body: {} },
      reviewPath: `/a/${h.appId}/discover`,
      labels: { approve: "Make a video", reject: "Not now" },
      subject: { entity: "opportunities" },
    });
    expect(first.summary).toMatch(/Sources: [a-z0-9.-]+\.[a-z]+.* Approving starts a round of videos about it \(up to \d+ credits\); every post still waits for your approval\.$/);
    expect(first.credits).toBeGreaterThan(0);
    // Editors can't decide (agent_continue → content.approve).
    expect((await needsYou(h.p, h.wid, EDITOR, { appId: h.appId })).items.find((i) => i.id === first.id)?.canDecide).toBe(false);
    await expect(decideSuggestion(h.p, h.wid, h.appId, first.id, { decision: "approve" }, { member: EDITOR, actor: "u2" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Approve → the sleeping loop wakes and round 2 focuses on it (reusing the sweep's research).
    const { start } = await decideSuggestion(h.p, h.wid, h.appId, first.id, { decision: "approve" }, { member: OWNER, actor: "u1" });
    expect(start).toMatchObject({ started: false, autopilotId: before.id });
    expect(await h.ws.collection("opportunities").getOrThrow(first.subject.id)).toMatchObject({ status: "saved" });
    await h.p.inline!.drain();
    const ap = await theLoop(h);
    expect(ap.iteration).toBe(2);
    expect(ap.alwaysOn?.roundFocus).toMatch(/^This week’s research found “Study-with-me Reel using the real timer screen”: make a video about it\?/);
    expect(ap.alwaysOn?.focus).toBeUndefined();
    expect(ap.researchRunId).toBe(run.id);
    expect(await h.ws.collection("approvals").getOrThrow(first.id)).toMatchObject({ status: "consumed", decidedBy: "u1" });
    expect((await h.ws.collection("agentRuns").getOrThrow(hashId("run", ap.id, 2, "hypothesis"))).status).toBe("succeeded");
    // The focus travels into the round's decisions and its campaign brief.
    const campaign = await h.ws.collection("campaigns").getOrThrow(ap.campaignId!);
    expect(campaign.request).toContain("Focus of this round (the founder approved this from this week's research): This week’s research found “Study-with-me Reel using the real timer screen”");

    // Reject the rest: noted on the approval, the opportunity is dismissed in Discover.
    for (const s of suggestions.slice(1)) {
      const out = await decideSuggestion(h.p, h.wid, h.appId, s.id, { decision: "reject", note: "Not our style" }, { member: OWNER, actor: "u1" });
      expect(out.approval).toMatchObject({ status: "rejected", note: "Not our style" });
    }
    await expect(decideSuggestion(h.p, h.wid, h.appId, first.id, { decision: "approve" }, { member: OWNER, actor: "u1" })).rejects.toMatchObject({ code: "CONFLICT" });
    // A second processing never repeats suggestions; a week later a new sweep starts.
    tick = await runAlwaysOn(h.p);
    expect(tick).toMatchObject({ sweeps: 0, suggestions: 0 });
    h.clock.now += 7 * DAY + 3_600_000;
    expect((await runAlwaysOn(h.p)).sweeps).toBe(1);
  });

  it("respects the plan's research runs per day: the sweep is postponed with a plain note, never forced", async () => {
    const h = await setup({ plan: "free" });
    installAnalyticsHooks(h.p); // plan quotas (the API and worker install these)
    await updateAlwaysOn(h.p, h.wid, h.appId, { enabled: true, postsPerWeek: 1 }, { member: OWNER, actor: "u1" });
    // Today's research runs are used up (Free: 3 a day).
    await h.ws.state(`quota.day.${new Date().toISOString().slice(0, 10)}`, z.any()).set({ finalRendersPerDay: 0, researchRunsPerDay: 3, updatedAt: new Date().toISOString() });
    const tick = await runAlwaysOn(h.p);
    expect(tick.sweeps).toBe(0);
    const status = await alwaysOnStatus(h.p, h.wid, h.appId);
    expect(status.sweep.note).toMatch(/^This week’s research is postponed: Your Free beta plan includes 3 research runs per day/);
    expect(Date.parse(status.sweep.nextAt!)).toBeGreaterThan(h.clock.now);
    const runs = (await h.ws.collection("researchRuns").list({ where: [["appId", "==", h.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items;
    expect(runs.every((r) => !r.inputs.focus?.startsWith("Always on weekly research"))).toBe(true);
  });
});

describe("Always on: the weekly summary", () => {
  it("in-app from stored records; by email only when turned on with Gmail connected, from that Gmail to the same address", async () => {
    const h = await setup();
    await enableAndRun(h, 1);
    await runAlwaysOn(h.p);
    await h.p.inline!.drain();
    await runAlwaysOn(h.p);
    const app = await h.ws.collection("apps").getOrThrow(h.appId);
    const s = await weeklySummary(h.p, h.wid, app, h.clock.now);
    expect(s.posted).toEqual([]);
    expect(s.queued).toHaveLength(1);
    for (const q of s.queued) expect(q).toMatchObject({ status: "awaiting_approval", timeBasis: "suggested" });
    expect(s.research.findings).toBeGreaterThan(0);
    expect(s.research.top[0]!.sources[0]!.url).toMatch(/^https:\/\//);
    expect(s.suggestions.length).toBeGreaterThan(0);
    expect(s.needsYou).toBe((await needsYou(h.p, h.wid, OWNER, { appId: h.appId })).count);
    expect(s.credits.used).toBe(await alwaysOnSpent(h.ws, h.appId, h.clock.now - 7 * DAY));
    expect(s.credits.allowance).toBe(weeklyAllowance(h.p, 1));
    const status = await alwaysOnStatus(h.p, h.wid, h.appId);
    expect(status.next).toMatchObject({ postId: s.queued[0]!.postId, timeBasis: "suggested" });
    expect(status.queue).toMatchObject({ upcoming: 1, awaitingApproval: 1, approved: 0, target: 1 });

    // Email: refused without Gmail.
    await expect(updateAlwaysOn(h.p, h.wid, h.appId, { emailSummary: true }, { member: OWNER, actor: "u1" })).rejects.toMatchObject({ code: "CONFLICT" });
    const sent: { url: string; raw: string }[] = [];
    configureGrowth(h.p, {
      settings: { creds: { gmail: { clientId: "test-client", clientSecret: "test-secret" } } },
      fetch: async (url, init) => {
        sent.push({ url: String(url), raw: Buffer.from(JSON.parse(String(init?.body)).raw, "base64url").toString("utf8") });
        return new Response(JSON.stringify({ id: "msg_1", threadId: "thr_1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const acc = await h.ws.collection("connectedAccounts").create(
      { provider: "gmail", purposes: ["outreach"], externalAccountId: "g-1", displayName: "maya@example.com", status: "connected", capabilities: ["send_message"], secretId: "tok_gmail_test", connectedBy: "u1" },
      { actor: "u1" },
    );
    await h.p.secrets.put(h.wid, acc.secretId!, "oauth_gmail", { accessToken: "ya29.TEST", refreshToken: "1//TEST", expiresAt: Date.now() + 3_600_000, scope: [] });
    await updateAlwaysOn(h.p, h.wid, h.appId, { emailSummary: true }, { member: OWNER, actor: "u1" });
    // Not before a week has passed.
    expect((await runAlwaysOn(h.p)).emails).toBe(0);
    h.clock.now += 7 * DAY + 3_600_000;
    expect((await runAlwaysOn(h.p)).emails).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(GMAIL_SEND_URL);
    expect(sent[0]!.raw).toContain("To: maya@example.com");
    expect(sent[0]!.raw).toContain("From: maya@example.com");
    expect(sent[0]!.raw).toMatch(/Subject: Tidy Timer this week: \d+ posted, \d+ ready/);
    const body = Buffer.from(sent[0]!.raw.split("\r\n\r\n")[1]!, "base64").toString("utf8");
    expect(body).toMatch(/^Tidy Timer: your week with MuseLaunch \(Always on, 1 post a week\)/);
    expect(body).toContain("It is sent from your connected Gmail to the same address.");
    expect((await alwaysOnState(h.ws, h.appId)).email).toMatchObject({ messageId: "msg_1" });
    // Once a week only.
    expect((await runAlwaysOn(h.p)).emails).toBe(0);
    const audit = (await h.ws.collection("auditLog").list({ limit: 50 })).items.find((a) => a.action === "always_on.summary_emailed");
    expect(audit?.data).toMatchObject({ to: "maya@example.com", messageId: "msg_1" });
    expect(ALWAYS_ON_ACTOR).toBe("agent:always-on");
  });
});
