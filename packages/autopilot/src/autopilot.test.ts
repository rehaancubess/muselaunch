import type { Autopilot } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { brandGate } from "@muselaunch/agents";
import { autopilotDetail, cancelAutopilot, decideCheckpoint, pauseAutopilot, resumeAutopilot, startAutopilot, wakeDueAutopilots } from "./index";
import { tagOf } from "./state";
import { autopilotDecisionRoute, autopilotHarness, type AutopilotHarness } from "./testing";

const DAY = 86_400_000;

async function get(h: AutopilotHarness, id: string): Promise<Autopilot> {
  return h.p.db.ws(h.wid).collection("autopilots").getOrThrow(id);
}

async function start(h: AutopilotHarness, input: Partial<{ maxCredits: number; autoApproveCredits: number; variants: number; maxIterations: number }> = {}) {
  const { autopilot } = await startAutopilot(h.p, h.wid, h.appId, { goal: "More App Store installs from students before exams", maxCredits: 400, maxIterations: 1, autoApproveCredits: 100, variants: 2, ...input }, "u1");
  await h.p.inline!.drain();
  return autopilot.id;
}

async function wakeAfterWindow(h: AutopilotHarness, id: string) {
  const ap = await get(h, id);
  h.clock.now = Date.parse(ap.waitingOn.until!) + 3_600_000;
  const woke = await wakeDueAutopilots(h.p);
  await h.p.inline!.drain();
  return woke;
}

describe("Growth Autopilot (autopilot.step state machine)", () => {
  it("runs the full loop: research → cited audience → hypothesis + experiment → distinct variants → videos → verification → render → approval-gated posts → honest measure → learn", async () => {
    const h = await autopilotHarness();
    const id = await start(h);
    let ap = await get(h, id);
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure" });
    expect(tagOf(ap.waitingOn.reason)).toBe("measure");

    // Research delegated and cited
    expect(ap.researchRunId).toBeTruthy();
    const rr = await h.p.db.ws(h.wid).collection("researchRuns").getOrThrow(ap.researchRunId!);
    expect(rr.status).toBe("succeeded");
    // Audience chosen by Wonder, citing a real finding
    expect(ap.audience?.findingIds).toHaveLength(1);
    const finding = await h.p.db.ws(h.wid).collection("researchFindings").getOrThrow(ap.audience!.findingIds[0]!);
    expect(finding.evidence[0]!.url).toMatch(/^https:\/\//);
    // Hypothesis → Experiment with control + challenger mapped to the produced concepts
    const exp = await h.p.db.ws(h.wid).collection("experiments").getOrThrow(ap.hypothesis!.experimentId!);
    expect(exp).toMatchObject({ primaryMetric: "installs", status: "proposed", campaignId: ap.campaignId });
    expect(exp.variants.map((v) => [v.key, v.isControl, Boolean(v.variantId)])).toEqual([
      ["v1", true, true],
      ["v2", false, true],
    ]);
    expect(exp.launchWindow.end).toBeTruthy();
    // Two strategically distinct variants produced as editable compositions from real screenshots
    const variants = await h.p.db.ws(h.wid).collection("campaignVariants").getMany(ap.variantIds);
    expect(new Set(variants.map((v) => v.angleType)).size).toBe(2);
    // ...each citing the research findings it builds on (from this loop's research run)
    const loopFindings = new Set((await h.p.db.ws(h.wid).collection("researchFindings").list({ where: [["appId", "==", h.appId]], limit: 50 })).items.map((f) => f.id));
    for (const v of variants) {
      expect(v.findingIds.length).toBeGreaterThan(0);
      for (const f of v.findingIds) expect(loopFindings.has(f)).toBe(true);
    }
    expect(ap.compositionIds).toHaveLength(2);
    // Verified (lint + claims + Brand Guardian) then rendered under the auto-approve threshold
    expect(ap.reviewIds).toHaveLength(2);
    expect(h.reviews).toHaveLength(2);
    expect(h.rendered.sort()).toEqual([...ap.compositionIds].sort());
    // Posts drafted and waiting for approval — never published
    expect(ap.scheduledPostIds).toHaveLength(2);
    const posts = await h.p.db.ws(h.wid).collection("scheduledPosts").getMany(ap.scheduledPostIds);
    for (const post of posts) {
      expect(post.status).toBe("awaiting_approval");
      expect(post.approvalId).toBeTruthy();
    }
    expect(posts.some((x) => x.status === "published")).toBe(false);
    // Budget accounting
    expect(ap.spent.credits).toBeGreaterThan(0);
    expect(ap.spent.credits).toBeLessThanOrEqual(ap.budget.maxCredits);
    expect(ap.spent.usd).toBeGreaterThan(0);

    // Wake after the launch window: measure (no data → honest) → learn → done
    const woke = await wakeAfterWindow(h, id);
    expect(woke.woken).toBe(1);
    ap = await get(h, id);
    expect(ap).toMatchObject({ status: "completed", stage: "done" });
    const summaries = ap.log.map((e) => `${e.stage}:${e.kind}:${e.summary}`);
    expect(summaries.some((s) => s.startsWith("measure:observation:No measured results are linked"))).toBe(true);
    expect(summaries.some((s) => s.includes("No lesson stored"))).toBe(true);
    expect(ap.recommendationIds).toHaveLength(1);
    const result = (await h.p.db.ws(h.wid).collection("experimentResults").list({ where: [["appId", "==", h.appId]], orderBy: { field: "createdAt", dir: "desc" } })).items[0]!;
    expect(result.confidence).toBe("insufficient_data");

    // Every Wonder decision is its own agent run, linked from the loop, with steps
    const runs = await h.p.db.ws(h.wid).collection("agentRuns").getMany(ap.agentRunIds);
    expect(runs.map((r) => r.kind)).toEqual(["growth_autopilot", "growth_autopilot", "growth_autopilot"]);
    for (const r of runs) expect(r.status).toBe("succeeded");
    const decisions = ap.log.filter((e) => e.kind === "decision" && e.agentRunId);
    expect(decisions.map((d) => d.stage)).toEqual(["select_audience", "hypothesis", "plan_creative"]);
    expect(ap.log.filter((e) => e.kind === "verification")).toHaveLength(2);
    expect(ap.log.find((e) => e.stage === "render" && e.kind === "decision")?.summary).toMatch(/auto-approved/);

    // Detail view for the UI
    const detail = await autopilotDetail(h.p, h.wid, id);
    expect(detail.runs).toHaveLength(3);
    expect(detail.jobs.map((j) => j.type)).toEqual(expect.arrayContaining(["research.run", "campaign.generate_concepts", "storyboard.generate", "brand.review", "render.final", "copy.generate", "experiment.analyze", "recommendations.generate"]));
    expect(detail.checkpoint).toBeNull();

    // Tenancy: invisible from another workspace
    await expect(h.p.db.ws("ws_other").collection("autopilots").getOrThrow(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("pauses at the budget checkpoint, continues after approval, asks before rendering, and a rejection pauses the loop", async () => {
    const h = await autopilotHarness();
    const id = await start(h, { maxCredits: 50, autoApproveCredits: 0 });
    let ap = await get(h, id);
    expect(ap).toMatchObject({ status: "awaiting_user", stage: "plan_creative" });
    expect(tagOf(ap.waitingOn.reason)).toBe("budget@enter");
    const detail = await autopilotDetail(h.p, h.wid, id);
    expect(detail.checkpoint).toMatchObject({ action: "spend", status: "pending", subject: { entity: "autopilots", id } });
    expect(ap.log.some((e) => e.kind === "budget")).toBe(true);

    // Approve: the budget is raised just enough, concepts run; further spend asks again each time.
    let guard = 0;
    while ((ap = await get(h, id)).status === "awaiting_user" && tagOf(ap.waitingOn.reason)?.startsWith("budget@") && guard++ < 10) {
      await decideCheckpoint(h.p, h.wid, id, { decision: "approve", note: "ok" }, "u1");
      await h.p.inline!.drain();
    }
    ap = await get(h, id);
    expect(ap).toMatchObject({ status: "awaiting_user", stage: "render" });
    expect(tagOf(ap.waitingOn.reason)).toBe("render:approve");
    expect(h.rendered).toHaveLength(0);

    // Reject the render: paused, nothing rendered
    await decideCheckpoint(h.p, h.wid, id, { decision: "reject", note: "not yet" }, "u1");
    await h.p.inline!.drain();
    ap = await get(h, id);
    expect(ap.status).toBe("paused");
    expect(h.rendered).toHaveLength(0);

    // Resume → asks again; approve → renders and drafts posts
    await resumeAutopilot(h.p, h.wid, id, "u1");
    await h.p.inline!.drain();
    ap = await get(h, id);
    expect(ap).toMatchObject({ status: "awaiting_user", stage: "render" });
    while ((ap = await get(h, id)).status === "awaiting_user" && guard++ < 20) {
      await decideCheckpoint(h.p, h.wid, id, { decision: "approve" }, "u1");
      await h.p.inline!.drain();
    }
    ap = await get(h, id);
    expect(h.rendered).toHaveLength(2);
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure" });
    expect(ap.spent.credits).toBeLessThanOrEqual(ap.budget.maxCredits);

    // Cancel: the loop stops for good; waking does nothing
    await cancelAutopilot(h.p, h.wid, id, "u1");
    h.clock.now += 30 * DAY;
    expect((await wakeDueAutopilots(h.p)).woken).toBe(0);
    await h.p.inline!.drain();
    expect((await get(h, id)).status).toBe("cancelled");
  });

  it("requests a scene-scoped fix when verification finds blocking issues, then re-verifies the new version", async () => {
    const h = await autopilotHarness({
      reviewPlan: (review) =>
        review.subjectVersion === 1
          ? { status: "blocked", findings: [{ id: "f1", severity: "block", category: "claim", message: "Headline implies an unverified ranking", source: "rules", evidence: { preferenceIds: [], claimIds: [] } }] }
          : { status: "passed", findings: [] },
    });
    const id = await start(h);
    const ap = await get(h, id);
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure" });
    expect(h.reviews.sort()).toEqual([...ap.compositionIds.map((c) => `${c}@v1:blocked`), ...ap.compositionIds.map((c) => `${c}@v2:passed`)].sort());
    const fixes = ap.log.filter((e) => e.summary.startsWith("Fix round 1 (iteration 1)"));
    expect(fixes).toHaveLength(2);
    const comps = await h.p.db.ws(h.wid).collection("compositions").getMany(ap.compositionIds);
    for (const c of comps) expect(c.currentVersion).toBe(2);
    const patches = (await h.p.db.ws(h.wid).collection("compositionPatches").list({ limit: 20 })).items;
    expect(patches.filter((x) => x.status === "applied")).toHaveLength(2);
    expect(ap.log.some((e) => e.kind === "verification" && e.summary.includes("Brand Guardian (rules): blocked"))).toBe(true);
    expect(ap.log.some((e) => e.kind === "verification" && e.summary.includes("v2") && e.summary.includes("passed"))).toBe(true);
  });

  it("applies the Brand Guardian's own suggested fix (new version + re-review) before asking Spark", async () => {
    const h = await autopilotHarness({
      reviewPlan: (review, doc) => {
        if (review.subjectVersion !== 1 || !doc) return { status: "passed", findings: [] };
        const scene = doc.scenes.find((s) => s.layers.some((l) => l.type === "text"))!;
        const layer = scene.layers.find((l) => l.type === "text")!;
        return {
          status: "blocked",
          findings: [
            {
              id: "f_fix",
              severity: "block",
              category: "claim",
              message: "Headline overstates a result",
              suggestion: "Use the verified wording",
              source: "rules",
              location: { sceneId: scene.id, layerId: layer.id },
              suggestedOps: [{ op: "update_layer", sceneId: scene.id, layerId: layer.id, set: { text: "Focus sessions that fit your day" } }],
              evidence: { preferenceIds: [], claimIds: [] },
            },
          ],
        };
      },
    });
    const id = await start(h);
    const ap = await get(h, id);
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure" });
    const fixes = ap.log.filter((e) => e.summary.startsWith("Fix round 1 (iteration 1): applied the Brand Guardian's suggested fix"));
    expect(fixes).toHaveLength(2);
    const ws = h.p.db.ws(h.wid);
    for (const c of await ws.collection("compositions").getMany(ap.compositionIds)) {
      expect(c.currentVersion).toBe(2);
      const reviews = await ws.collection("brandReviews").list({ where: [["subject.id", "==", c.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 10 });
      expect(reviews.items.find((r) => r.subjectVersion === 1)!.findings[0]!.resolution?.state).toBe("applied");
      expect(reviews.items.find((r) => r.subjectVersion === 2)!.status).toBe("passed");
    }
    // No Spark edit was needed, and only v2 was rendered
    expect((await ws.collection("jobs").list({ limit: 200 })).items.filter((j) => j.type === "composition.edit")).toHaveLength(0);
    expect(ap.log.filter((e) => e.summary.startsWith("Final render of") && e.summary.includes(" v2 "))).toHaveLength(2);
  });

  it("checkpoints after two unsuccessful fix rounds, never overrides the Guardian, and renders only what a person overrode; an unavailable Guardian is never a pass", async () => {
    const h = await autopilotHarness({ reviewPlan: () => ({ status: "blocked", findings: [{ id: "f1", severity: "block", category: "tone", message: "Tone drift", source: "glimmer", evidence: { preferenceIds: [], claimIds: [] } }] }) });
    const id = await start(h);
    let ap = await get(h, id);
    expect(ap).toMatchObject({ status: "awaiting_user", stage: "verify" });
    expect(tagOf(ap.waitingOn.reason)).toBe("verify:unresolved");
    expect(ap.log.filter((e) => e.summary.startsWith("Fix round")).length).toBe(4); // 2 rounds × 2 videos
    // Continuing doesn't bypass the render gate: every video is still blocked → honest failure, nothing rendered.
    await decideCheckpoint(h.p, h.wid, id, { decision: "approve" }, "u1");
    await h.p.inline!.drain();
    ap = await get(h, id);
    expect(ap).toMatchObject({ status: "failed", stage: "render" });
    expect(ap.log.filter((e) => e.summary.startsWith("Left out of the final render: the Brand Guardian blocks"))).toHaveLength(2);
    expect(h.rendered).toHaveLength(0);
    // A person overrides one video's review (with a reason) → resuming renders exactly that one.
    const [first] = await h.p.db.ws(h.wid).collection("compositions").getMany(ap.compositionIds);
    await brandGate(h.p, h.wid, { subject: { entity: "compositions", id: first!.id }, version: first!.currentVersion, override: { reason: "Tone is intentional for this audience" }, actor: "u1", canOverride: true, action: "render_final" });
    await resumeAutopilot(h.p, h.wid, id, "u1");
    await h.p.inline!.drain();
    ap = await get(h, id);
    expect(h.rendered).toEqual([first!.id]);
    expect(ap.log.some((e) => e.summary.includes("rendering because u1 overrode the Brand Guardian"))).toBe(true);
    expect(ap.stage).toBe("measure");

    const offline = await autopilotHarness({ reviewPlan: () => "fail", workspaceId: "ws_autopilot_2" });
    const id2 = await start(offline);
    const ap2 = await get(offline, id2);
    expect(ap2.stage).toBe("measure");
    expect(ap2.log.filter((e) => e.kind === "verification").every((e) => e.summary.includes("Brand Guardian unavailable"))).toBe(true);
  });

  it("pauses and resumes a single-variant loop; a Wonder decision that never validates fails the loop honestly", async () => {
    const h = await autopilotHarness({ routes: [autopilotDecisionRoute({ set_hypothesis: { statement: "For students, a problem-first hook drives installs.", primaryMetric: "installs", variantLabels: ["Problem-first hook"], rationale: "Grounded in research.", findingIds: ["$ID:fnd:0"] } })] });
    const { autopilot } = await startAutopilot(h.p, h.wid, h.appId, { goal: "Grow", maxCredits: 400, maxIterations: 1, autoApproveCredits: 100, variants: 1 }, "u1");
    await pauseAutopilot(h.p, h.wid, autopilot.id, "u1");
    await h.p.inline!.drain();
    let ap = await get(h, autopilot.id);
    expect(ap.status).toBe("paused");
    await expect(startAutopilot(h.p, h.wid, h.appId, { goal: "Second", maxCredits: 100, maxIterations: 1, autoApproveCredits: 0, variants: 1 }, "u1")).rejects.toMatchObject({ code: "CONFLICT" });
    await resumeAutopilot(h.p, h.wid, autopilot.id, "u1");
    await h.p.inline!.drain();
    ap = await get(h, autopilot.id);
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure" });
    expect(ap.compositionIds).toHaveLength(1);
    const exp = await h.p.db.ws(h.wid).collection("experiments").getOrThrow(ap.hypothesis!.experimentId!);
    expect(exp.variants).toHaveLength(1);

    // A Wonder that keeps offering 2 labels for a 1-variant loop: the decision tool rejects it every time.
    const twoLabels = { statement: "For students, a problem-first hook drives installs.", primaryMetric: "installs", variantLabels: ["Demo-first hook (control)", "Problem-first hook"], rationale: "Grounded in research.", findingIds: ["$ID:fnd:0"] };
    const bad = await autopilotHarness({ workspaceId: "ws_autopilot_bad", routes: [autopilotDecisionRoute({ set_hypothesis: twoLabels })] });
    const { autopilot: a2 } = await startAutopilot(bad.p, bad.wid, bad.appId, { goal: "Grow", maxCredits: 400, maxIterations: 1, autoApproveCredits: 100, variants: 1 }, "u1");
    await bad.p.inline!.drain();
    const failed = await get(bad, a2.id);
    expect(failed).toMatchObject({ status: "failed", stage: "hypothesis" });
    expect(failed.error?.code).toBe("PROVIDER_ERROR");
    expect(failed.log.at(-1)!.kind).toBe("error");
    const run = (await bad.p.db.ws(bad.wid).collection("agentRuns").getMany(failed.agentRunIds)).find((r) => r.goal.startsWith("Hypothesis"));
    expect(run?.status).toBe("failed");
    const steps = (await bad.p.db.ws(bad.wid).collection("agentSteps").list({ where: [["runId", "==", run!.id]], orderBy: { field: "index", dir: "asc" }, limit: 50 })).items;
    expect(steps.some((x) => x.status === "failed" && x.outputSummary?.includes("Provide exactly 1 variant labels"))).toBe(true);
  });
});
