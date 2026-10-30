import { ensureVideoReview } from "@muselaunch/agents";
import type { Autopilot, VideoReviewFinding } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { decideCheckpoint, startAutopilot } from "./index";
import { tagOf } from "./state";
import { autopilotHarness, type AutopilotHarness, type VideoReviewPlan } from "./testing";

/**
 * Track 4: after the final renders, Spark watches each video. Blockers → ONE scene-scoped fix round
 * (composition.edit) + one re-render; a review that can't run is never a pass. Spark's review is the
 * scripted harness stand-in (fixture); the edit, the Guardian gate and the loop are real.
 */

async function get(h: AutopilotHarness, id: string): Promise<Autopilot> {
  return h.p.db.ws(h.wid).collection("autopilots").getOrThrow(id);
}

async function start(h: AutopilotHarness, input: Partial<{ maxCredits: number; autoApproveCredits: number }> = {}) {
  const { autopilot } = await startAutopilot(h.p, h.wid, h.appId, { goal: "More App Store installs from students before exams", maxCredits: 400, maxIterations: 1, autoApproveCredits: 100, variants: 2, ...input }, "u1");
  await h.p.inline!.drain();
  return autopilot.id;
}

const hookBlocker: VideoReviewPlan = ({ version, doc }) =>
  version === 1
    ? {
        score: 4,
        findings: [
          { sceneId: doc.scenes[0]!.id, severity: "blocker", check: "hook_readability", issue: "The hook shows 14 words for 1.5 s (f1).", fixInstruction: "Cut the hook to six words or extend the scene to 3 s.", frameRef: "f1" },
          { severity: "warn", check: "pacing", issue: "Every scene uses the same slide-up motion.", fixInstruction: "Vary the motion between scenes." },
        ] as Omit<VideoReviewFinding, "id" | "source">[],
      }
    : { score: 9, findings: [] };

describe("Growth Autopilot: Spark watches the final renders (watch.ts)", () => {
  it("blockers get one scene-scoped fix round and one re-render; the posts use the fixed version; never a second round", async () => {
    const h = await autopilotHarness({ workspaceId: "ws_watch_fix", videoReviewPlan: hookBlocker });
    const id = await start(h);
    let ap = await get(h, id);
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure" });
    const ws = h.p.db.ws(h.wid);

    // Spark watched the two v1 renders only (the fixed v2 isn't re-reviewed automatically).
    expect(h.watched.sort()).toEqual(ap.compositionIds.map((c) => `${c}@v1:blockers`).sort());
    // One scene-scoped, auto-applied fix per video through the existing edit path, from the blocker only.
    const jobs = (await ws.collection("jobs").list({ limit: 300 })).items;
    const edits = jobs.filter((j) => j.type === "composition.edit");
    expect(edits).toHaveLength(2);
    for (const e of edits) {
      const comp = await ws.collection("compositions").getOrThrow(String(e.payload.compositionId));
      expect(e.payload).toMatchObject({ baseVersion: 1, autoApply: true });
      expect(e.payload.sceneIds).toHaveLength(1);
      expect(String(e.payload.instruction)).toContain("Spark watched the rendered video (version 1)");
      expect(String(e.payload.instruction)).toContain("Cut the hook to six words");
      expect(String(e.payload.instruction)).not.toContain("Vary the motion");
      expect(comp.currentVersion).toBe(2);
    }
    // Rendered twice per video (v1, then v2 after the fix); posts use v2.
    for (const c of ap.compositionIds) expect(h.rendered.filter((x) => x === c)).toHaveLength(2);
    const posts = await ws.collection("scheduledPosts").getMany(ap.scheduledPostIds);
    expect(posts).toHaveLength(2);
    for (const post of posts) expect(post.compositionVersion).toBe(2);
    // Everything is in the decision log.
    const summaries = ap.log.map((e) => e.summary);
    expect(ap.log.filter((e) => e.stage === "render" && e.kind === "verification" && /^Muse Spark watched “.+” v1 \(0 frames\): 4\/10 · 1 blocker, 1 warning/.test(e.summary))).toHaveLength(2);
    expect(ap.log.some((e) => e.kind === "decision" && e.summary.startsWith("Spark found blockers in 2 videos: one scene-scoped fix round, then one final re-render"))).toBe(true);
    expect(summaries.filter((s) => s.startsWith("Video fix (iteration 1): asked"))).toHaveLength(2);
    expect(summaries.filter((s) => s.startsWith("Spark's fix for “") && s.includes("applied as v2"))).toHaveLength(2);
    expect(summaries.filter((s) => s.startsWith("Video fix (iteration 1): final re-render of"))).toHaveLength(2);
    expect(summaries.filter((s) => s.startsWith("Re-rendered “") && s.includes("isn't reviewed again automatically"))).toHaveLength(2);
    // The review links to its fix.
    for (const c of ap.compositionIds) {
      const [review] = (await ws.collection("videoReviews").list({ where: [["compositionId", "==", c]], orderBy: { field: "createdAt", dir: "desc" }, limit: 5 })).items;
      expect(review).toMatchObject({ status: "succeeded", verdict: "blockers", requestedFrom: "autopilot", version: 1 });
      expect(review!.fixPatchIds).toHaveLength(1);
      expect(review!.findings.find((f) => f.severity === "blocker")!.resolution).toMatchObject({ state: "fix_requested", patchId: review!.fixPatchIds[0] });
      expect(review!.findings.find((f) => f.severity === "warn")!.resolution).toBeUndefined();
      const patch = await ws.collection("compositionPatches").getOrThrow(review!.fixPatchIds[0]!);
      expect(patch).toMatchObject({ status: "applied", resultVersion: 2, source: "ai" });
    }
    expect(ap.spent.credits).toBeLessThanOrEqual(ap.budget.maxCredits);

    // Never more than one round: even if Spark later reports blockers on the fixed render in the same
    // iteration, the loop doesn't edit or re-render again.
    const first = ap.compositionIds[0]!;
    const { review: v2 } = await ensureVideoReview(ws, { appId: h.appId, compositionId: first, version: 2, renderAssetId: `ast_render_${first.slice(-12)}_v2`, requestedFrom: "studio" }, "u1");
    await ws.collection("videoReviews").update(v2.id, { status: "succeeded", verdict: "blockers", score: 5, findings: [{ id: "vf_again", sceneId: (await ws.collection("compositionVersions").getOrThrow(`${first}_v2`)).doc.scenes[0]!.id, severity: "blocker", check: "legibility", issue: "Still cut off.", fixInstruction: "Shrink it.", source: "spark" }] }, { actor: "u1" });
    await ws.collection("autopilots").update(id, { status: "waiting_on_jobs", stage: "render", waitingOn: { jobIds: [], reason: "[render:watch] test re-entry" } }, { actor: "test" });
    await h.p.jobs.create(h.wid, "autopilot.step", { autopilotId: id }, { actor: "u1", appId: h.appId, idempotencyKey: "watch-reentry" });
    await h.p.inline!.drain();
    ap = await get(h, id);
    expect(ap.log.some((e) => e.summary.includes("already had its automatic fix round in this iteration (at most 1)"))).toBe(true);
    const after = (await ws.collection("jobs").list({ limit: 300 })).items;
    expect(after.filter((j) => j.type === "composition.edit")).toHaveLength(2);
    expect(h.rendered).toHaveLength(4);
  });

  it("asks before re-rendering above the auto-approve limit, then re-renders after approval", async () => {
    const h = await autopilotHarness({ workspaceId: "ws_watch_spend", videoReviewPlan: hookBlocker });
    const id = await start(h, { autoApproveCredits: 10 });
    const seen: string[] = [];
    let ap = await get(h, id);
    for (let guard = 0; ap.status === "awaiting_user" && guard < 10; guard++) {
      seen.push(tagOf(ap.waitingOn.reason) ?? "");
      await decideCheckpoint(h.p, h.wid, id, { decision: "approve" }, "u1");
      await h.p.inline!.drain();
      ap = await get(h, id);
    }
    expect(seen).toEqual(["render:approve", "render:rerender:approve"]);
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure" });
    expect(h.rendered).toHaveLength(4);
    expect(ap.log.some((e) => e.kind === "checkpoint" && e.summary.startsWith("Re-render after Spark's fix needs your OK"))).toBe(true);
  });

  it("a review that can't run (Spark unavailable) is logged honestly, never a pass, and the loop goes on to the drafts", async () => {
    const h = await autopilotHarness({ workspaceId: "ws_watch_fail", videoReviewPlan: () => "fail" });
    const id = await start(h);
    const ap = await get(h, id);
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure" });
    expect(h.watched.sort()).toEqual(ap.compositionIds.map((c) => `${c}@v1:fail`).sort());
    const notes = ap.log.filter((e) => e.stage === "render" && e.kind === "verification");
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n.summary).toMatch(/couldn't watch “.+” v1 \(Muse Spark is unavailable \(test\)\)\. Not counted as a pass/);
    expect(ap.log.some((e) => / watched “/.test(e.summary))).toBe(false);
    expect(ap.log.some((e) => e.kind === "decision" && e.summary.startsWith("Going on to the post drafts without Spark's review"))).toBe(true);
    const ws = h.p.db.ws(h.wid);
    expect((await ws.collection("jobs").list({ limit: 300 })).items.filter((j) => j.type === "composition.edit")).toHaveLength(0);
    const reviews = (await ws.collection("videoReviews").list({ limit: 10 })).items;
    expect(reviews).toHaveLength(2);
    for (const r of reviews) {
      expect(r.status).toBe("failed");
      expect(r.verdict).toBeUndefined();
    }
    expect(ap.scheduledPostIds).toHaveLength(2);
  });
});
