import { seedApp, type SeededApp } from "@muselaunch/agents/testing";
import { installAnalyticsHooks } from "@muselaunch/analytics";
import { advanceCreateRun, sweepCreateRuns } from "@muselaunch/autopilot";
import { autopilotPlatform } from "@muselaunch/autopilot/testing";
import { themeFromBrand, validateDoc } from "@muselaunch/compositions";
import { createComposition } from "@muselaunch/compositions/store";
import { CreateRunsResponse, NeedsYouResponse, ResolveCreateRunResponse, type CompositionDoc, type CreateRunState, type Job } from "@muselaunch/contracts";
import { AppError } from "@muselaunch/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "./app";

/**
 * Create runs on the SERVER (packages/autopilot/src/create-runner.ts): "Generate video" makes one
 * finished video with no browser open: job hooks and the sweep take each step as the person who
 * started it, stop with a decision when a step needs that person (credits, plan limits, the facts or
 * Brand check, a longer video, permissions, a day without progress, a failed job), and any client
 * reads the run (GET /apps/:appId/create-runs) and answers it (POST /create-runs/:id/resolve).
 * Fixture model routes only; renders and reviews are labelled stubs; nothing is ever posted.
 */

// biome-ignore lint: loose JSON in tests
type J = any;

function client(app: ReturnType<typeof buildApp>, uid: string, email = `${uid}@example.com`) {
  const auth = { authorization: `Bearer dev:${uid}:${email}` };
  const send = (method: string) => async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as J };
  };
  return { get: send("GET"), post: send("POST") };
}

const oneVideo = (over: Record<string, unknown> = {}) => ({
  request: "Show how Distraction blocking keeps a study session calm.",
  goal: "feature_announcement",
  channels: ["instagram"],
  deliverables: [{ kind: "feature_promo", channel: "instagram", aspectRatio: "9:16", durationSec: 60, count: 1 }],
  conceptCount: 3,
  origin: "create",
  ...over,
});

/** A small editable video: hook, the real app on a phone (`shotId`), end card. `demoSec` sets its length. */
function videoDoc(theme: CompositionDoc["theme"], shotId: string, hook: string, demoSec = 4): CompositionDoc {
  const v = validateDoc({
    schemaVersion: 1,
    title: hook,
    kind: "video",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    theme,
    scenes: [
      { id: "sc_hook", name: "Hook", template: "hook-title", purpose: "hook", durationSec: 3, layers: [{ id: "ly_hook", type: "text", role: "headline", text: hook, box: { x: 0.08, y: 0.38, w: 0.84, h: 0.2 }, style: { sizePx: 80 } }] },
      { id: "sc_demo", name: "Demo", template: "device-demo", purpose: "demo", durationSec: demoSec, layers: [{ id: "ly_demo_device", type: "device", screenAssetId: shotId, box: { x: 0.22, y: 0.28, w: 0.56, h: 0.56 } }] },
      { id: "sc_cta", name: "CTA", template: "cta-endcard", purpose: "cta", durationSec: 3, layers: [{ id: "ly_cta", type: "text", role: "cta", text: "Start your first focus session", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 }, style: { sizePx: 56 } }] },
    ],
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.doc;
}

const QuotaDay = z.object({ finalRendersPerDay: z.number().int().nonnegative().default(0), researchRunsPerDay: z.number().int().nonnegative().default(0), updatedAt: z.string() });

/** One workspace (alice owner, eddie editor, carol viewer) with a seeded app, on its own platform. */
function setup(opts: { quotas?: boolean } = {}) {
  const h = autopilotPlatform();
  const p = h.p;
  if (opts.quotas) installAnalyticsHooks(p);
  const app = buildApp(p);
  const users = { alice: client(app, "alice"), eddie: client(app, "eddie"), carol: client(app, "carol"), bob: client(app, "bob") };
  const env = { h, p, app, ...users, wid: "", appId: "", seeded: undefined as unknown as SeededApp };
  const W = () => `/v1/workspaces/${env.wid}`;
  const ws = () => p.db.ws(env.wid);
  const iso = () => new Date(h.clock.now).toISOString();

  beforeAll(async () => {
    env.wid = (await users.alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await users.bob.post("/v1/workspaces", { name: "Bob Studio" });
    await p.credits.grant(env.wid, 2000, { reason: "test", idempotencyKey: "create-runs-test", actor: "system" });
    env.seeded = await seedApp(p, env.wid);
    env.appId = env.seeded.appId;
    for (const [uid, role] of [
      ["eddie", "editor"],
      ["carol", "viewer"],
    ] as const)
      await ws().collection("members").create({ id: uid, userId: uid, email: `${uid}@example.com`, role, canPublish: false, canManageAccounts: false, status: "active" }, { actor: "alice" });
  });

  /**
   * A Create run stopped just before a step, built from records (no hook moves it until the test does):
   * `plan`: the ideas are written; `final`: the editable video is made (`doc`).
   */
  async function seedRun(o: { at: "plan" | "final"; lengthSec?: number; doc?: (theme: CompositionDoc["theme"], shotId: string) => CompositionDoc; state?: Partial<CreateRunState>; by?: string }) {
    const by = o.by ?? "alice";
    const campaign = await ws()
      .collection("campaigns")
      .create(
        {
          appId: env.appId,
          name: "Calm focus",
          goal: "awareness",
          request: "Introduce Tidy Timer to students.",
          channels: ["instagram"],
          deliverables: [{ kind: "short_video", channel: "instagram", aspectRatio: "9:16", durationSec: o.lengthSec ?? 20, count: 1 }],
          status: o.at === "plan" ? "concepts_ready" : "review",
          origin: "create",
          createRun: { startedBy: by, actingAs: by, status: "working", stage: o.at === "plan" ? "plan" : "check", waits: 0, jobIds: [], touchedAt: iso(), ...o.state },
        },
        { actor: by },
      );
    const variant = (title: string, angleType: "emotional_problem" | "practical_demo") =>
      ws()
        .collection("campaignVariants")
        .create(
          { appId: env.appId, campaignId: campaign.id, title, angleType, hook: title, audience: "Students", keyMessage: "Calm focus", rationale: "Students study in blocks.", hypothesis: "A calm hook works.", successMetric: { metric: "installs" }, status: "proposed", targetDurationSec: o.lengthSec ?? 20 },
          { actor: "seed" },
        );
    const first = await variant("Calm in exam season", "emotional_problem");
    await variant("One tap to deep work", "practical_demo");
    if (o.at === "plan") return { campaign, variantId: first.id, compositionId: "" };
    const theme = themeFromBrand(await ws().collection("brandProfiles").getOrThrow(env.appId));
    const doc = (o.doc ?? ((t, s) => videoDoc(t, s, "25 calm minutes. Done.")))(theme, env.seeded.screenshotIds[0]!);
    const { composition } = await createComposition(ws(), { appId: env.appId, campaignId: campaign.id, variantId: first.id, title: "Calm in exam season", doc }, by);
    await ws().collection("campaignVariants").update(first.id, { status: "produced", compositionIds: [composition.id] }, { actor: "seed" });
    return { campaign, variantId: first.id, compositionId: composition.id };
  }

  const jobsOf = async (type: Job["type"], match: (j: Job) => boolean = () => true) => (await ws().collection("jobs").list({ where: [["appId", "==", env.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((j) => j.type === type && match(j));
  const view = async (campaignId: string, who = users.alice) => {
    const r = await who.get(`${W()}/create-runs/${campaignId}`);
    expect(r.status).toBe(200);
    return r.body.run as J;
  };
  const needs = async (who = users.alice) => NeedsYouResponse.parse((await who.get(`${W()}/needs-you?appId=${env.appId}`)).body).items;
  const resolve = (campaignId: string, body: unknown, who = users.alice) => who.post(`${W()}/create-runs/${campaignId}/resolve`, body);
  const advance = (campaignId: string) => advanceCreateRun(p, env.wid, campaignId, { source: "sweep" });
  const balance = () => p.credits.balance(env.wid);
  return { env, W, ws, iso, seedRun, jobsOf, view, needs, resolve, advance, balance };
}

describe("Create runs on the server: the whole chain, no browser", () => {
  const t = setup();
  const { env } = t;

  it("“Generate video” → the finished video, every step taken by the server as the person who started it", async () => {
    const before = await t.balance();
    const created = await env.alice.post(`${t.W()}/apps/${env.appId}/campaigns`, oneVideo());
    expect(created.status).toBe(202);
    const id = created.body.campaign.id as string;
    expect(created.body.campaign.createRun).toMatchObject({ startedBy: "alice", actingAs: "alice", status: "working", stage: "idea" });
    // No browser: only the jobs run (their hooks take the next steps).
    await env.p.inline!.drain();

    const runs = CreateRunsResponse.parse((await env.alice.get(`${t.W()}/apps/${env.appId}/create-runs`)).body).items;
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({ campaignId: id, status: "done", stage: "done", pct: 100, kind: "feature", format: { aspectRatio: "9:16", lengthSec: 60, channel: "instagram" }, startedBy: "alice", decision: null, failure: null, actions: [] });
    expect(run.ideaCount).toBeGreaterThanOrEqual(3);
    expect(run.video?.assetId).toBeTruthy();
    const asset = await t.ws().collection("mediaAssets").getOrThrow(run.video!.assetId);
    expect(asset).toMatchObject({ role: "render", status: "ready", render: { compositionId: run.compositionId, quality: "final" } });

    // "Show a feature": the demo idea, selected (remembered) and planned in the chosen format and length.
    const variant = await t.ws().collection("campaignVariants").getOrThrow(run.variantId!);
    expect(variant.angleType).toBe("practical_demo");
    expect(["selected", "produced"]).toContain(variant.status);
    const [board] = await t.jobsOf("storyboard.generate", (j) => j.payload.campaignId === id);
    expect(board).toMatchObject({ createdBy: "alice", payload: { variantId: variant.id, aspectRatio: "9:16", targetDurationSec: 60 } });
    const [final] = await t.jobsOf("render.final", (j) => j.payload.compositionId === run.compositionId);
    expect(final).toMatchObject({ createdBy: "alice", status: "succeeded" });

    // The keys are the ones the browser used: an old tab sending the same steps gets the same jobs.
    const produce = await env.alice.post(`${t.W()}/campaigns/${id}/variants/${variant.id}/produce`, { aspectRatio: "9:16", targetDurationSec: 60 }, { "idempotency-key": `create-produce-${id}` });
    expect(produce.body.job.id).toBe(board!.id);
    const comp = await t.ws().collection("compositions").getOrThrow(run.compositionId!);
    const again = await env.alice.post(`${t.W()}/compositions/${comp.id}/render`, { quality: "final", version: comp.currentVersion }, { "idempotency-key": `create-final-${comp.id}-v${comp.currentVersion}` });
    expect(again.body.job.id).toBe(final!.id);

    // Real credits: what the jobs charged, nothing left on hold, never below zero.
    const after = await t.balance();
    const charged = (await t.ws().collection("jobs").list({ where: [["appId", "==", env.appId]], limit: 200 })).items.reduce((n, j) => n + (j.creditsCharged ?? 0), 0);
    expect(after.reserved).toBe(0);
    expect(after.available).toBe(before.available - charged);
    expect(after.available).toBeGreaterThanOrEqual(0);
    // Nothing was posted or even drafted.
    expect((await t.ws().collection("scheduledPosts").list({ where: [["appId", "==", env.appId]], limit: 10 })).items).toHaveLength(0);
    expect((await t.ws().collection("campaigns").getOrThrow(id)).createRun).toMatchObject({ status: "done", stage: "done" });
    // A finished run is never touched again.
    expect(await sweepCreateRuns(env.p, env.wid)).toBe(0);
  });

  it("a hook, the sweep and a browser tab racing never start a step twice", async () => {
    const { campaign } = await t.seedRun({ at: "plan" });
    // All at once, before anything ran: three advances (hooks / the sweep) and an old browser tab's
    // produce (even of another idea than the server would pick: the run makes the one that got planned).
    const variants = (await t.ws().collection("campaignVariants").list({ where: [["campaignId", "==", campaign.id]], limit: 10 })).items;
    const chosen = variants.find((v) => v.title === "One tap to deep work")!;
    const [, , , , tab] = await Promise.all([
      t.advance(campaign.id),
      t.advance(campaign.id),
      advanceCreateRun(env.p, env.wid, campaign.id, { source: "hook" }),
      sweepCreateRuns(env.p, env.wid),
      env.alice.post(`${t.W()}/campaigns/${campaign.id}/variants/${chosen.id}/produce`, { aspectRatio: "9:16", targetDurationSec: 20 }, { "idempotency-key": `create-produce-${campaign.id}` }),
    ]);
    await env.p.inline!.drain();
    const boards = await t.jobsOf("storyboard.generate", (j) => j.payload.campaignId === campaign.id);
    expect(boards).toHaveLength(1);
    expect(tab.body.job.id).toBe(boards[0]!.id);
    const run = await t.view(campaign.id);
    expect(run).toMatchObject({ status: "done", variantId: boards[0]!.payload.variantId });
    const finals = await t.jobsOf("render.final", (j) => j.payload.compositionId === run.compositionId);
    expect(finals).toHaveLength(1);
    // Looking again changes nothing.
    await Promise.all([t.advance(campaign.id), t.advance(campaign.id), sweepCreateRuns(env.p, env.wid)]);
    await env.p.inline!.drain();
    expect(await t.jobsOf("storyboard.generate", (j) => j.payload.campaignId === campaign.id)).toHaveLength(1);
    expect(await t.jobsOf("render.final", (j) => j.payload.compositionId === run.compositionId)).toHaveLength(1);
  });

  it("a missed hook: the sweep takes the step", async () => {
    const { campaign } = await t.seedRun({ at: "final" });
    expect((await t.view(campaign.id)).status).toBe("working");
    expect(await sweepCreateRuns(env.p, env.wid)).toBeGreaterThanOrEqual(1);
    await env.p.inline!.drain();
    expect((await t.view(campaign.id)).status).toBe("done");
  });
});

describe("Create runs: decisions instead of guesses", () => {
  const t = setup({ quotas: true });
  const { env } = t;
  // Each test starts with the day's final renders unused (the free plan allows 5 a day).
  const dayKey = () => `quota.day.${new Date().toISOString().slice(0, 10)}`;
  const setFinalsToday = (n: number) => t.ws().state(dayKey(), QuotaDay).set({ finalRendersPerDay: n, researchRunsPerDay: 0, updatedAt: new Date().toISOString() });
  beforeEach(() => setFinalsToday(0));

  it("not enough credits: stops at the step (nothing reserved), shows in Needs you, and Try again carries on", async () => {
    const { campaign } = await t.seedRun({ at: "plan" });
    const bal = await t.balance();
    const hold = await env.p.credits.reserve(env.wid, bal.available - 2, { operation: "test", idempotencyKey: "drain-credits", actor: "system" });
    await t.advance(campaign.id);
    const run = await t.view(campaign.id);
    expect(run).toMatchObject({ status: "needs_you", stage: "plan", decision: { kind: "credits", stepKey: `produce:${run.variantId}` }, actions: ["retry", "stop"] });
    expect(run.decision.message).toMatch(/credits/);
    expect(await t.jobsOf("storyboard.generate", (j) => j.payload.campaignId === campaign.id)).toHaveLength(0);
    expect((await t.balance()).available).toBe(2);
    const item = (await t.needs()).find((i) => i.subject.id === campaign.id)!;
    expect(item).toMatchObject({ kind: "decision", action: "create_run", title: "Not enough credits to finish your video", canDecide: true, requiredCap: "content.write", reviewPath: "/settings/credits", approve: { path: `/create-runs/${campaign.id}/resolve`, body: { action: "retry", stepKey: run.decision.stepKey } }, reject: { body: { action: "stop" } } });
    // The sweep doesn't retry a decision by itself.
    await sweepCreateRuns(env.p, env.wid);
    expect((await t.view(campaign.id)).status).toBe("needs_you");

    await env.p.credits.release(env.wid, hold.reservationId, { actor: "system", reason: "test" });
    const r = await t.resolve(campaign.id, item.approve!.body);
    expect(r.status).toBe(202);
    expect(ResolveCreateRunResponse.parse(r.body).run.status).toBe("working");
    await env.p.inline!.drain();
    expect((await t.view(campaign.id)).status).toBe("done");
    expect((await t.needs()).some((i) => i.subject.id === campaign.id)).toBe(false);
  });

  it("too many tasks at once: waits, and goes on by itself when a task finishes (no decision)", async () => {
    const { campaign } = await t.seedRun({ at: "plan" });
    // The free plan runs 2 tasks at once: two other tasks are queued.
    const busy = await Promise.all([1, 2].map((i) => env.p.jobs.create(env.wid, "copy.generate", { appId: env.appId, campaignId: campaign.id, channels: ["instagram"] }, { actor: "alice", appId: env.appId, idempotencyKey: `busy-${i}`, deferDispatch: true })));
    await t.advance(campaign.id);
    const waiting = await t.view(campaign.id);
    expect(waiting).toMatchObject({ status: "waiting", decision: null, wait: { reason: expect.stringMatching(/tasks at once/) } });
    expect((await t.ws().collection("campaigns").getOrThrow(campaign.id)).createRun).toMatchObject({ status: "waiting", waitKind: "busy", waits: 1 });
    expect((await t.needs()).some((i) => i.subject.id === campaign.id)).toBe(false);
    // The sweep respects the wait…
    await sweepCreateRuns(env.p, env.wid);
    expect(await t.jobsOf("storyboard.generate", (j) => j.payload.campaignId === campaign.id)).toHaveLength(0);
    // …and a finished task frees a slot: its hook takes the step at once.
    await env.p.jobs.complete(env.wid, busy[0]!, { creditsUsed: 0 }, "test-worker");
    expect(await t.jobsOf("storyboard.generate", (j) => j.payload.campaignId === campaign.id)).toHaveLength(1);
    await env.p.jobs.complete(env.wid, busy[1]!, { creditsUsed: 0 }, "test-worker");
    await env.p.inline!.drain();
    expect((await t.view(campaign.id)).status).toBe("done");
  });

  it("the plan's daily final renders are used up: a decision (it doesn't clear in a moment)", async () => {
    const { campaign } = await t.seedRun({ at: "final" });
    await setFinalsToday(5);
    await t.advance(campaign.id);
    const run = await t.view(campaign.id);
    expect(run).toMatchObject({ status: "needs_you", stage: "check", decision: { kind: "limit" } });
    expect(run.decision.message).toMatch(/final renders per day/);
    expect((await t.needs()).find((i) => i.subject.id === campaign.id)).toMatchObject({ title: "Your video waits for your plan’s limit", labels: { approve: "Try again", review: "See your plan" } });
    await setFinalsToday(0);
    expect((await t.resolve(campaign.id, { action: "retry" })).status).toBe(202);
    await env.p.inline!.drain();
    expect((await t.view(campaign.id)).status).toBe("done");
  });

  it("the facts check finds a problem: a fix decision that opens the video; Try again checks again", async () => {
    const { campaign, compositionId } = await t.seedRun({ at: "final", doc: (theme) => videoDoc(theme, "ast_missing_screen", "25 calm minutes. Done.") });
    await t.advance(campaign.id);
    const run = await t.view(campaign.id);
    expect(run).toMatchObject({ status: "needs_you", stage: "check", decision: { kind: "fix", compositionId, version: 1 } });
    expect(run.decision.message).toMatch(/missing/i);
    expect((await t.needs()).find((i) => i.subject.id === campaign.id)).toMatchObject({ title: "Your video needs a fix before it’s finished", reviewPath: `/a/${env.appId}/creator/studio/${compositionId}`, labels: { review: "Open it" } });
    // Still not fixed: the same decision again, and still no final render.
    expect((await t.resolve(campaign.id, { action: "retry" })).body.run.decision.kind).toBe("fix");
    expect(await t.jobsOf("render.final", (j) => j.payload.compositionId === compositionId)).toHaveLength(0);
  });

  it("the video came out longer: finishing waits for the person's OK at the real price", async () => {
    // Chose 15 s (one 15-s block shown); the video is 18 s (two blocks).
    const { campaign, compositionId } = await t.seedRun({ at: "final", lengthSec: 15, doc: (theme, shot) => videoDoc(theme, shot, "25 calm minutes. Done.", 12) });
    const held = (await t.balance()).reserved;
    await t.advance(campaign.id);
    const run = await t.view(campaign.id);
    expect(run).toMatchObject({ status: "needs_you", decision: { kind: "spend", credits: 16, shown: 8, stepKey: `final:${compositionId}:v1` }, actions: ["approve_spend", "stop"] });
    expect(await t.jobsOf("render.final", (j) => j.payload.compositionId === compositionId)).toHaveLength(0);
    expect((await t.balance()).reserved).toBe(held);
    const item = (await t.needs()).find((i) => i.subject.id === campaign.id)!;
    expect(item).toMatchObject({ title: "Your video came out longer than you chose", credits: 16, labels: { approve: "Finish it · 16 credits" }, approve: { body: { action: "approve_spend", stepKey: `final:${compositionId}:v1` } } });
    // A decision the person didn't see (another version) is refused.
    expect((await t.resolve(campaign.id, { action: "approve_spend", stepKey: `final:${compositionId}:v2` })).status).toBe(409);
    expect((await t.resolve(campaign.id, { action: "approve_spend" })).status).toBe(422);
    const ok = await t.resolve(campaign.id, item.approve!.body);
    expect(ok.status).toBe(202);
    const [final] = await t.jobsOf("render.final", (j) => j.payload.compositionId === compositionId);
    expect(final).toMatchObject({ createdBy: "alice", reservation: { credits: 16 } });
    await env.p.inline!.drain();
    expect((await t.view(campaign.id)).status).toBe("done");
  });

  it("the Brand check blocks it: one Needs-you item; finishing anyway needs a reason, kept with the review", async () => {
    const { campaign, compositionId } = await t.seedRun({ at: "final", doc: (theme, shot) => videoDoc(theme, shot, "Works offline, anywhere") });
    await t.advance(campaign.id);
    const run = await t.view(campaign.id);
    expect(run).toMatchObject({ status: "needs_you", stage: "check", decision: { kind: "brand", canOverride: true, compositionId, version: 1 }, actions: ["override", "retry", "stop"] });
    const items = (await t.needs()).filter((i) => i.subject.id === campaign.id || i.preview?.compositionId === compositionId);
    // Shown once, as the Create decision (not also as a separate Brand-check item).
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Your video needs a look before it’s finished",
      reviewPath: `/a/${env.appId}/creator/studio/${compositionId}`,
      labels: { approve: "Finish it anyway", reject: "Leave it", review: "Open it" },
      approveReason: { label: "Why it’s fine to finish it" },
      approve: { body: { action: "override", stepKey: `final:${compositionId}:v1` } },
    });
    expect((await t.resolve(campaign.id, { action: "override", stepKey: `final:${compositionId}:v1` })).status).toBe(422);
    const ok = await t.resolve(campaign.id, { ...items[0]!.approve!.body, reason: "Offline mode shipped in 2.0" });
    expect(ok.status).toBe(202);
    await env.p.inline!.drain();
    expect((await t.view(campaign.id)).status).toBe("done");
    const review = await t.ws().collection("brandReviews").getOrThrow(run.decision.reviewId);
    expect(review.overrides).toEqual([expect.objectContaining({ by: "alice", reason: "Offline mode shipped in 2.0", action: "render_final" })]);
    expect((await t.ws().collection("auditLog").list({ limit: 200 })).items.some((a) => a.action === "brand_review.override" && a.target?.id === review.id)).toBe(true);
  });

  it("the person it acts as lost editor access: an editor continues it as themselves", async () => {
    const { campaign } = await t.seedRun({ at: "plan", by: "eddie" });
    await t.ws().collection("members").update("eddie", { role: "viewer" }, { actor: "alice" });
    await t.advance(campaign.id);
    const run = await t.view(campaign.id);
    expect(run).toMatchObject({ status: "needs_you", decision: { kind: "permission" } });
    expect(await t.jobsOf("storyboard.generate", (j) => j.payload.campaignId === campaign.id)).toHaveLength(0);
    expect((await t.resolve(campaign.id, { action: "retry" }, env.eddie)).status).toBe(403);
    expect((await t.resolve(campaign.id, { action: "retry" })).status).toBe(202);
    const [board] = await t.jobsOf("storyboard.generate", (j) => j.payload.campaignId === campaign.id);
    expect(board?.createdBy).toBe("alice");
    // The step key stays the starter's, so the step still can only start once.
    expect(board?.idempotencyKey).toBe(`eddie:create-produce-${campaign.id}`);
    expect((await t.ws().collection("campaigns").getOrThrow(campaign.id)).createRun).toMatchObject({ startedBy: "eddie", actingAs: "alice" });
    await t.ws().collection("members").update("eddie", { role: "editor" }, { actor: "alice" });
    await env.p.inline!.drain();
  });

  it("a run nobody moved for a day waits for the person instead of carrying on (and spending)", async () => {
    const { campaign } = await t.seedRun({ at: "plan" });
    const now = env.h.clock.now;
    env.h.clock.now = now + 25 * 3_600_000;
    try {
      await sweepCreateRuns(env.p, env.wid);
      const run = await t.view(campaign.id);
      expect(run).toMatchObject({ status: "needs_you", decision: { kind: "resume" } });
      expect(run.decision.message).toMatch(/doesn’t carry on with an older video by itself/);
      expect(await t.jobsOf("storyboard.generate", (j) => j.payload.campaignId === campaign.id)).toHaveLength(0);
      expect((await t.needs()).find((i) => i.subject.id === campaign.id)).toMatchObject({ title: "Your video is waiting", labels: { approve: "Continue" } });
      expect((await t.resolve(campaign.id, { action: "retry" })).status).toBe(202);
      expect(await t.jobsOf("storyboard.generate", (j) => j.payload.campaignId === campaign.id)).toHaveLength(1);
      await env.p.inline!.drain();
    } finally {
      env.h.clock.now = now;
    }
  });

  it("a failed job: the error with Try again (it runs the job again)", async () => {
    const { campaign } = await t.seedRun({ at: "final" });
    // The final render is started, then fails (Muse can't finish it this time).
    const comp = (await t.ws().collection("compositions").list({ where: [["campaignId", "==", campaign.id]], limit: 1 })).items[0]!;
    const job = await env.p.jobs.create(env.wid, "render.final", { appId: env.appId, compositionId: comp.id, version: 1, format: "mp4" }, { actor: "alice", appId: env.appId, idempotencyKey: `alice:create-final-${comp.id}-v1`, credits: { operation: "render.final", params: { durationSec: 10 } }, deferDispatch: true });
    await env.p.jobs.fail(env.wid, job, new AppError("PROVIDER_ERROR", "renderer crashed", { retryable: false, userMessage: "The renderer stopped this time." }), "test-worker");
    const run = await t.view(campaign.id);
    expect(run).toMatchObject({ status: "failed", stage: "finish", failure: { stage: "finish", message: "The renderer stopped this time.", jobId: job.id, canRetry: true }, actions: ["retry", "stop"] });
    expect((await t.ws().collection("campaigns").getOrThrow(campaign.id)).createRun?.status).toBe("failed");
    expect((await t.needs()).find((i) => i.subject.id === campaign.id)).toMatchObject({ title: "Your video stopped", summary: expect.stringMatching(/The renderer stopped this time\./), approve: { body: { action: "retry" } } });
    expect((await t.resolve(campaign.id, { action: "retry" })).status).toBe(202);
    await env.p.inline!.drain();
    expect((await t.view(campaign.id)).status).toBe("done");
    const finals = await t.jobsOf("render.final", (j) => j.payload.compositionId === comp.id);
    expect(finals.map((j) => j.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("Leave it: stops the run (out of Needs you, no more steps); Continue picks it up", async () => {
    const { campaign } = await t.seedRun({ at: "final", lengthSec: 15, doc: (theme, shot) => videoDoc(theme, shot, "25 calm minutes. Done.", 12) });
    await t.advance(campaign.id);
    expect((await t.view(campaign.id)).decision.kind).toBe("spend");
    expect((await t.resolve(campaign.id, { action: "stop" })).body.run).toMatchObject({ status: "stopped", actions: ["retry"] });
    expect((await t.needs()).some((i) => i.subject.id === campaign.id)).toBe(false);
    await sweepCreateRuns(env.p, env.wid);
    await t.advance(campaign.id);
    expect((await t.view(campaign.id)).status).toBe("stopped");
    expect((await t.resolve(campaign.id, { action: "stop" })).status).toBe(409);
    // Continue: the price check asks again (the OK is never assumed).
    expect((await t.resolve(campaign.id, { action: "retry" })).body.run).toMatchObject({ status: "needs_you", decision: { kind: "spend" } });
  });
});

describe("Create runs: permissions and tenancy", () => {
  const t = setup();
  const { env } = t;

  it("members read runs; only editors answer them; other workspaces and other campaigns are not found", async () => {
    const { campaign } = await t.seedRun({ at: "final", lengthSec: 15, doc: (theme, shot) => videoDoc(theme, shot, "25 calm minutes. Done.", 12) });
    await t.advance(campaign.id);
    // A viewer sees it (no actions) and can't answer it, here or in Needs you.
    const asViewer = CreateRunsResponse.parse((await env.carol.get(`${t.W()}/apps/${env.appId}/create-runs`)).body).items.find((r) => r.campaignId === campaign.id)!;
    expect(asViewer).toMatchObject({ status: "needs_you", actions: [] });
    expect((await t.resolve(campaign.id, { action: "stop" }, env.carol)).status).toBe(403);
    expect((await t.needs(env.carol)).find((i) => i.subject.id === campaign.id)?.canDecide).toBe(false);
    // An editor can.
    expect((await t.view(campaign.id, env.eddie)).actions).toEqual(["approve_spend", "stop"]);
    // Another workspace: not a member here; its own workspace has no such run.
    expect((await env.bob.get(`${t.W()}/create-runs/${campaign.id}`)).status).toBe(404);
    expect((await env.bob.post(`${t.W()}/create-runs/${campaign.id}/resolve`, { action: "stop" })).status).toBe(404);
    const bobWs = (await env.bob.get("/v1/me")).body.workspaces[0].workspace.id;
    expect((await env.bob.get(`/v1/workspaces/${bobWs}/create-runs/${campaign.id}`)).status).toBe(404);
    expect((await env.bob.post(`/v1/workspaces/${bobWs}/create-runs/${campaign.id}/resolve`, { action: "stop" })).status).toBe(404);
    expect((await env.bob.get(`/v1/workspaces/${bobWs}/apps/${env.appId}/create-runs`)).status).toBe(404);
    // A campaign planned by hand isn't a Create run.
    const made = await env.alice.post(`${t.W()}/apps/${env.appId}/campaigns`, { request: "Three Reels for students" });
    expect((await env.alice.get(`${t.W()}/create-runs/${made.body.campaign.id}`)).status).toBe(404);
    expect((await t.resolve(made.body.campaign.id, { action: "retry" })).status).toBe(404);
    await env.p.inline!.drain();
  });
});
